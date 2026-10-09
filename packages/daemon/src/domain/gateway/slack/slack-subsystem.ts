// S10 —— Slack 网关装配：把进程内 wire（已发布 dispatcher + 持久缓冲）、
// chat.postMessage 交付路径、出站队列轮询驱动以及 Socket Mode 入站服务组合为一个
// GatewayWire，并由子系统在后台服务启动时激活。
//
// 配置如实原则：连接器未配置或已禁用时产生惰性 wire；交付会以具名 class 拒绝，不声明
// 任何操作，也不启动驱动。此情况绝不抛出异常（启动继续；`zrig slack status` 会指出
// 缺失项），也绝不静默伪装成可用的交付路径。
//
// 切换期间保持持久状态连续：沿用同一组 slice-11 状态文件
//（slack-outbound-seen.jsonl、slack-inbound-seen.jsonl、slack-inbound-deadletter.jsonl），
// 因而 relay 的历史就是子系统的历史；启用子系统不会重放 relay 已交付的内容，启用时的
// 积压处理规则由结构保证可跨切换保留。

import { channelStateDigest } from "../channel-operations.js";
import path from "node:path";
import fs from "node:fs";
import { buildInProcessWire, type GatewayWire, type SubsystemDeliverFn } from "../gateway-subsystem.js";
import { downloadPrivateFile } from "./slack-api.js";
import { loadConfig } from "./config.js";
import { resolveSecret } from "./secrets.js";
import { SeenStore, DeadLetterStore, InboundReceiptStore } from "./state-store.js";
import { makeQueuePorts } from "./queue-access.js";
import { SlackOutboundDriver, OUTBOUND_OP, type OutboundPostPayload } from "./outbound-driver.js";
import { subsystemSlackDeliver } from "./slack-delivery.js";
import { InboundRouter, type SlackEvent, type InboundFilePort, type InboundFileResult, type StoredInboundFile, type FailedInboundFile } from "./inbound.js";
import { makeInboundSenderResolver, type RegistrySurface } from "./inbound-admission.js";
import { ThreadSeatMap, formatPostedStamp } from "./thread-seat-map.js";
import { makeThreadRouteResolver } from "./thread-routing.js";
import { startSocketInbound, type SocketInboundHandle, type WsLike } from "./socket-inbound.js";
import { loadHumanRegistry, resolveSlackHandle } from "../human-registry.js";
import type { QueueRepository } from "../../queue-repository.js";
import { parseSessionName } from "../../session-name.js";
import type { FetchImpl } from "./slack-api.js";
import { ownerNotificationLevelAtLeast } from "../../queue-transition-log.js";
// OPR.0.5.6.1 —— 交付规则引擎：每条消息只作一次决策，取代两次阈值读取（S14 默认
// 决策桩）。旧阈值路径仅在目标不是已注册人类时作为明确的降级方案保留；没有 prefs
// 就没有引擎输入。
import {
  decideDelivery,
  resolveAvailability,
  isEscalationClass,
  formatDeliveryTermination,
  DELIVERY_TERMINATION_PREFIX,
  type DeliveryDecision,
} from "../delivery-rules-engine.js";
import { armDeliveryDeferral } from "../../policies/delivery-deferral.js";
import { WatchdogJobsRepository } from "../../watchdog-jobs-repository.js";

const SECRET_BOT = "SLACK_BOT_TOKEN";
const SECRET_APP = "SLACK_APP_TOKEN";

export interface SlackWireOpts {
  home: string;
  queueRepo: QueueRepository;
  log?: (msg: string) => void;
  /** 可注入接缝（用于测试）：fetch、websocket factory、扫描间隔和注册表界面。 */
  fetchImpl?: FetchImpl;
  wsFactory?: (url: string) => WsLike;
  outboundIntervalMs?: number;
  inboundRetryIntervalMs?: number;
  inboundMaxConnects?: number;
  registry?: RegistrySurface;
  resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string }) => Promise<"resolved" | "already-resolved" | "not-applicable">;
}

interface HumanReplyActionPort {
  act(input: { verb: "resolve"; qitemId: string; actorSession: string; decision: string }): Promise<unknown>;
}

/** 使用任务控制中心现有的人类暂停解析器组合入站回复。如果重放发生在持久化 resolve 之后、
 * 入站 seen 标记之前，类型化转换会吸收这次重放，从而只恢复等待中的所有者一次。 */
export function makeHumanReplyResolver(
  queueRepo: QueueRepository,
  contract: HumanReplyActionPort | undefined,
): NonNullable<SlackWireOpts["resolveHumanReply"]> {
  return async (input) => {
    if (queueRepo.getById(input.qitemId)?.humanIntent === "update") return "not-applicable";
    if (!contract) return "not-applicable";
    try {
      await contract.act({ verb: "resolve", ...input });
      return "resolved";
    } catch (error) {
      if ((error as { code?: string }).code !== "qitem_not_leg1_parked") throw error;
      const alreadyResolved = queueRepo.transitionLog.listForQitem(input.qitemId)
        .some((transition) => transition.ownerNotificationKind === "human-decision-resolved");
      if (alreadyResolved) return "already-resolved";

      // 直接人类请求与旧 park 形态相反：人类拥有 pending 行，发起智能体接收关联的入站行。
      // 在这里关闭请求会记录持久处置结果；入站创建本身已是唤醒来源的一次通知，因此这里
      // 再发送一次 nudge 会造成重复关注。
      const direct = queueRepo.getById(input.qitemId);
      if (
        direct?.state !== "pending" ||
        direct.destinationSession !== input.actorSession ||
        parseSessionName(direct.destinationSession).kind !== "external"
      ) {
        return "not-applicable";
      }
      queueRepo.update({
        qitemId: input.qitemId,
        actorSession: input.actorSession,
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: "direct human reply received",
        ownerNotificationKind: "human-decision-resolved",
      });
      return "resolved";
    }
  };
}

/**
 * OPR.0.5.6.2 —— 入站文件端口：Slack `url_private` → 认证下载 → 工作区本地媒体文件
 * → 回复行中的本地路径。Slack 不拥有这里的内容（设计 §2）：存储文件是人类对我们工作
 * 记录所作贡献的自有副本；任何 Slack URL 或令牌都不会通过此函数进入行。失败按文件
 * 具名记录；失败传输返回 `{ name, error }`，绝不会抛出可能导致消息丢失的异常。
 *
 * 安全路径约束：文件名净化为长度受限、仅含 [A-Za-z0-9._-] 的 basename，并添加事件
 * ts + 索引前缀（在事件内唯一）；任何写入前都验证解析后的路径仍位于 `mediaDir` 内。
 */
/** R1 F1 —— 锚定的 Slack 主机判定：必须使用 https，且 URL 解析后的 hostname 恰好为
 *  `slack.com` 或以 `.slack.com` 结尾，绝不使用子字符串匹配。 */
function isSlackHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "slack.com" || u.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

export function makeInboundFilePort(opts: {
  token: string;
  mediaDir: string;
  fetchImpl?: FetchImpl;
  mkdirp?: (dir: string) => void;
  writeFile?: (p: string, bytes: Uint8Array) => void;
  log?: (msg: string) => void;
  maxBytes?: number;
}): InboundFilePort {
  const log = opts.log ?? (() => {});
  const mkdirp = opts.mkdirp ?? ((dir: string) => { fs.mkdirSync(dir, { recursive: true }); });
  const writeFile = opts.writeFile ?? ((p: string, bytes: Uint8Array) => { fs.writeFileSync(p, bytes); });
  return {
    async transfer(files: unknown[], eventTs: string): Promise<InboundFileResult> {
      const stored: StoredInboundFile[] = [];
      const failed: FailedInboundFile[] = [];
      mkdirp(opts.mediaDir);
      for (let i = 0; i < files.length; i++) {
        const meta = (files[i] ?? {}) as { id?: string; name?: string; mimetype?: string; url_private?: string };
        const name = String(meta.name ?? meta.id ?? `file-${i + 1}`);
        const url = meta.url_private;
        // R1 F1：锚定主机检查。URL 解析后的 hostname 必须恰好为 `slack.com` 或是以点
        // 分隔的子域；子字符串或正则匹配会放过 evilslack.com 等仿冒域，并把 Bearer
        // 令牌发送给它们。
        if (!url || !isSlackHost(url)) {
          failed.push({ name, error: "缺少 url_private 或其并非 Slack URL" });
          continue;
        }
        const dl = await downloadPrivateFile(url, opts.token, opts.fetchImpl ?? fetch, 30_000, opts.maxBytes);
        if (!dl.ok) {
          log(`入站文件传输失败 name=${name} ts=${eventTs}：${dl.error}`);
          failed.push({ name, error: dl.error });
          continue;
        }
        const safeBase = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || `file-${i + 1}`;
        const localPath = path.join(opts.mediaDir, `${eventTs.replace(/[^0-9.]/g, "")}-${i + 1}-${safeBase}`);
        if (!path.resolve(localPath).startsWith(path.resolve(opts.mediaDir) + path.sep)) {
          failed.push({ name, error: "已拒绝不安全路径" });
          continue;
        }
        try {
          writeFile(localPath, dl.bytes);
        } catch (e) {
          failed.push({ name, error: `本地写入失败：${(e as Error).message}` });
          continue;
        }
        stored.push({ name, localPath, mimetype: meta.mimetype, bytes: dl.bytes.byteLength });
      }
      return { stored, failed };
    },
  };
}

function stateDir(home: string): string {
  return path.join(home, "state");
}

/** 使用配置和密钥构建生产 Slack 网关 wire。配置缺失时绝不抛出异常；这种情况应如实
 *  生成惰性 wire，而不是导致启动失败。 */
export function buildSlackGatewayWire(opts: SlackWireOpts): GatewayWire {
  const log = opts.log ?? (() => {});
  const cfg = loadConfig(opts.home);
  const envFile = cfg.secretsEnvFile ?? undefined;
  const bot = resolveSecret(SECRET_BOT, { envFile });
  const app = resolveSecret(SECRET_APP, { envFile });

  const outboundReady = cfg.enabled && bot !== null && cfg.channel !== null;
  const inboundReady = cfg.enabled && app !== null;

  if (!outboundReady && !inboundReady) {
    const missing = !cfg.enabled ? "连接器已禁用（请运行 zrig slack enable）" : !bot ? "无法解析 SLACK_BOT_TOKEN" : "未配置频道";
    log(`Slack 交付未配置（${missing}）——wire 处于惰性状态，将如实拒绝分派`);
    const inert = buildInProcessWire({
      home: opts.home,
      ops: [],
      deliver: async () => ({ ok: false, class: "slack-not-configured", detail: missing }),
      log,
    });
    return { ...inert, status: () => ({ platform: "slack", configurationDigest: channelStateDigest(cfg), outboundReady: false, inboundReady: false, inbound: { state: "not-configured" } }) };
  }

  const registrySurface: RegistrySurface = opts.registry ?? { loadHumanRegistry, resolveSlackHandle };
  const ports = makeQueuePorts(opts.queueRepo, {
    loadHumanRegistry: () => registrySurface.loadHumanRegistry(opts.home),
  });
  // OPR.0.5.6.1 —— 唯一一次引擎查询（AM-F5：网关在分派前查询引擎）。null 表示目标
  // 不是已注册人类；调用方保留引擎引入前的阈值行为，作为明确的降级方案。
  const decideForPayload = (p: OutboundPostPayload): DeliveryDecision | null => {
    const local = (p.destinationSession ?? "").split("@")[0] ?? "";
    if (!local) return null;
    const reg = registrySurface.loadHumanRegistry(opts.home);
    if (!reg.ok) return null;
    const human = reg.entities.find((e) => e.entityId === local);
    if (!human) return null;
    return decideDelivery({
      level: p.ownerNotificationLevel ?? null,
      escalation: p.humanIntent !== "update" && isEscalationClass(p.tags),
      human: {
        entityId: human.entityId,
        deliveryClass: human.prefs.deliveryClass,
        availability: resolveAvailability(human.prefs),
      },
      dials: {
        minimumLevelThatPosts: cfg.minimumLevelThatPosts,
        minimumLevelThatInterrupts: cfg.minimumLevelThatInterrupts,
      },
    });
  };
  const outboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-outbound-seen.jsonl"));
  const delivered = new SeenStore(path.join(stateDir(opts.home), "slack-delivered-decisions.jsonl"));
  const attempted = new SeenStore(path.join(stateDir(opts.home), "slack-attempted-decisions.jsonl"));

  // S10 线程路由：映射与后台服务共享数据库，队列行携带重建印章。
  const threadMap = new ThreadSeatMap(opts.queueRepo.db);

  // 延迟绑定，使 deliver 能释放在 wire 之后构建的驱动处理中保护。
  let releaseRef: (qitemId: string) => void = () => {};

  const deliver = outboundReady
    ? subsystemSlackDeliver({
        botToken: bot!,
        channel: cfg.channel!,
        sourceLabel: cfg.sourceLabel,
        fetchImpl: opts.fetchImpl,
        delivered,
        attempted,
        outboundSeen,
        release: (q) => releaseRef(q),
        // 线程复用以持久对话为 scope，而不只是以人类 + 席位为 scope。Slack 回复只能标识
        // 根线程；让两个 qitem 共享同一个根会使入站回复产生歧义，并可能恢复错误的人类门禁。
        // 同一 qitem 的重新交付或新通知阶段仍复用它的准确根线程。
        resolveThreadTs: (p) =>
          threadMap.resolveOpenForConversation(
            p.destinationSession ?? "",
            p.sourceSession ?? "",
            p.qitemId,
          )?.threadTs,
        // S14：发布与打断是在同一词汇体系上的两个独立阈值。
        resolveMentionUserId: (p) => {
          if (p.humanIntent === "update") return undefined;
          // OPR.0.5.6.1：对于已注册人类，引擎决定的响亮程度就是 mention 规则；双阈值
          // 只在 null 降级路径中保留。
          if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return undefined; // notify 类聚合绝不 mention
          const fire = (p as { deliveryDeferralFire?: boolean }).deliveryDeferralFire === true;
          const decision = fire ? null : decideForPayload(p);
          const eligible = fire
            ? true // 延迟打断在触发时 mention，这正是延迟机制的承诺
            : decision
              ? decision.mention
              : Boolean(p.ownerNotificationLevel && ownerNotificationLevelAtLeast(p.ownerNotificationLevel, cfg.minimumLevelThatInterrupts));
          if (!eligible) return undefined;
          const local = (p.destinationSession ?? "").split("@")[0] ?? "";
          if (!local) return undefined;
          const reg = registrySurface.loadHumanRegistry(opts.home);
          if (!reg.ok) return undefined;
          for (const e of reg.entities) {
            if (e.entityId !== local) continue;
            for (const b of e.connectorBindings) {
              if (b.kind === "slack" && b.handle) return b.handle;
            }
          }
          return undefined;
        },
        onPostedRoot: (p, ts) => {
          const human = p.destinationSession ?? "";
          const seat = p.sourceSession ?? "";
          threadMap.open({ threadTs: ts, channel: cfg.channel!, human, seat, conversationId: p.qitemId });
          // 重建印章：队列行是映射重新推导时使用的持久来源。
          try {
            opts.queueRepo.update({
              qitemId: p.qitemId,
              actorSession: "daemon@kernel",
              transitionNote: formatPostedStamp({ threadTs: ts, messageTs: ts, channel: cfg.channel!, human, seat, conversationId: p.qitemId }),
            });
          } catch (e) {
            // 印章失败只会降低可重建性，不影响路由；应醒目报告，但绝不导致交付失败。
            log(`线程印章写入失败 ${p.qitemId}：${(e as Error).message}`);
          }
        },
        // OPR.0.5.6.14 —— 发布失败会写入 transport-failed 台账转换，使未交付界面能直接
        // 指明网关错误，而不是根据 nudge 遥测猜测。
        onTransportFailed: (p, failureClass, detail) => {
          if (!p.qitemId) return;
          const key = p.notificationKey ?? p.qitemId;
          const alreadyRecorded = opts.queueRepo.transitionLog.listForQitem(p.qitemId).some((transition) =>
            transition.transitionNote?.startsWith("slack-owner-notification-transport-failed ")
              && transition.transitionNote.split(/\s+/).includes(`notification_key=${key}`));
          if (alreadyRecorded) return;
          opts.queueRepo.update({
            qitemId: p.qitemId,
            actorSession: "daemon@kernel",
            transitionNote: [
              "slack-owner-notification-transport-failed",
              `notification_key=${key}`,
              `class=${failureClass}`,
              `error=${detail}`,
            ].join(" "),
          });
        },
        onPosted: (p, messageTs, threadTs) => {
          // v3 摘要分支：以传输事实为先。每个成员回执都在真实发布之后于此处盖章，
          // 并带摘要 token 和阶段键。
          const digest = (p as unknown as { deliveryDigestPost?: boolean; digestId?: string; memberReceipts?: Array<{ qitemId: string; notificationKey: string; level: string; kind: string }> });
          if (digest.deliveryDigestPost && Array.isArray(digest.memberReceipts)) {
            for (const m of digest.memberReceipts) {
              if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(m.qitemId, m.notificationKey)) continue;
              opts.queueRepo.update({
                qitemId: m.qitemId,
                actorSession: "daemon@kernel",
                transitionNote: [
                  "slack-owner-notification-posted",
                  `notification_key=${m.notificationKey}`,
                  `level=${m.level}`,
                  `kind=${m.kind}`,
                  `message_ts=${messageTs}`,
                  `thread_ts=${threadTs ?? messageTs}`,
                  `digest=${digest.digestId ?? "unknown"}`,
                ].join(" "),
              });
            }
            return;
          }
          const key = p.notificationKey ?? p.qitemId;
          if (opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, key)) return;
          // 一次原子队列转换记录完整交付，并且只关闭信息型交付义务；这绝不是人类决策。
          opts.queueRepo.update({
            qitemId: p.qitemId,
            actorSession: "daemon@kernel",
            ...(p.humanIntent === "update" ? { state: "done" as const, closureReason: "no-follow-on" } : {}),
            transitionNote: [
              "slack-owner-notification-posted",
              `notification_key=${key}`,
              `level=${p.ownerNotificationLevel ?? "RECORD"}`,
              `kind=${p.ownerNotificationKind ?? "unclassified"}`,
              `message_ts=${messageTs}`,
              `thread_ts=${threadTs ?? messageTs}`,
            ].join(" "),
          });
        },
        log,
      })
    : async () => ({ ok: false as const, class: "slack-outbound-not-configured", detail: "缺少机器人令牌或频道" });

  // OPR.0.5.6.1 —— 在传输前封装决策：log 类和 digest 类不会尝试发布（AM-F5 条件）；
  // away 状态的升级延迟会激活 watchdog 基础设施，当前不发布（AM-F1）；away/off 状态
  // 的升级在每个阶段只记录一次单人终止（A1.1、F-7）。interrupt/notify 原样落入
  // S14 交付路径。
  const recordTerminationOnce = (p: OutboundPostPayload, decision: DeliveryDecision): void => {
    if (!decision.termination || !p.qitemId) return;
    const key = p.notificationKey ?? p.qitemId;
    const already = opts.queueRepo.transitionLog.listForQitem(p.qitemId).some((t) =>
      t.transitionNote?.startsWith(DELIVERY_TERMINATION_PREFIX)
        && t.transitionNote.split(/\s+/).includes(`notification_key=${key}`));
    if (already) return;
    opts.queueRepo.update({
      qitemId: p.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: formatDeliveryTermination(decision.termination, key),
    });
  };
  const engineDeliver: SubsystemDeliverFn = async (decision) => {
    const p = ((decision as { payload?: unknown }).payload ?? {}) as OutboundPostPayload & { deliveryDeferralFire?: boolean };
    // T+30 延迟触发执行已作出的决策，绝不重新查询；否则会再次延迟，形成 AM-F3 禁止的
    // “立即 + 延迟”形态。R2 B-3 保护：已带发布回执的阶段（重放决策或任何第二次生成）
    // 不再发布，由回执保证仅一次。摘要发布是已决策的聚合，绝不重新查询；成员决策已在
    // 封装时记录，回执在 onPosted 中落地。
    if ((p as { deliveryDigestPost?: boolean }).deliveryDigestPost) return deliver(decision);
    if (p.deliveryDeferralFire) {
      const fireKey = p.notificationKey ?? p.qitemId;
      if (p.qitemId && opts.queueRepo.transitionLog.hasOwnerNotificationReceipt(p.qitemId, fireKey)) {
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      return deliver(decision);
    }
    const ruled = p.qitemId ? decideForPayload(p) : null;
    if (ruled) {
      recordTerminationOnce(p, ruled);
      const episodeKey = p.notificationKey ?? p.qitemId;
      if (ruled.outcome === "log") {
        outboundSeen.mark(episodeKey, "log-class-contained");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.outcome === "digest") {
        // R1 B-4：消息时决策记录在行上，上述查询已应用实时阈值；flush 消费该记录，
        // 绝不会依据之后的注册表状态重新决策。
        const already = opts.queueRepo.listTransitions(p.qitemId).some((t) =>
          t.transitionNote?.startsWith("delivery-decision: digest")
            && t.transitionNote.includes(`notification_key=${episodeKey}`));
        if (!already) {
          opts.queueRepo.update({
            qitemId: p.qitemId,
            actorSession: "daemon@kernel",
            transitionNote: `delivery-decision: digest window=${ruled.digestWindow ?? "4h"} notification_key=${episodeKey}`,
          });
        }
        outboundSeen.mark(episodeKey, `digest-deferred-${ruled.digestWindow ?? "4h"}`);
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
      if (ruled.deferMinutes !== undefined) {
        try {
          armDeliveryDeferral({
            jobsRepo: new WatchdogJobsRepository(opts.queueRepo.db),
            queueRepo: opts.queueRepo,
            qitemId: p.qitemId,
            entityId: (p.destinationSession ?? "").split("@")[0] ?? "unknown",
            minutes: ruled.deferMinutes,
            notificationKey: episodeKey,
          });
        } catch (e) {
          log(`为 ${p.qitemId} 激活延迟失败：${(e as Error).message}——回退到立即执行 notify 类交付（醒目失败优于静默丢失）`);
          return deliver(decision);
        }
        outboundSeen.mark(episodeKey, "interrupt-deferred");
        releaseRef(p.qitemId);
        return { ok: true as const };
      }
    }
    return deliver(decision);
  };

  const wire = buildInProcessWire({
    home: opts.home,
    ops: outboundReady ? [OUTBOUND_OP] : [],
    deliver: outboundReady ? engineDeliver : deliver,
    log,
  });

  // 服务在此构造，但只通过 startServices()（绑定后，由 index.ts 调用）启动。组合后台服务
  // 时绝不能连接 Slack 或启动轮询器；这是测试中 createDaemon 的密闭性规则，也与监督树
  // 中所有监视器保持一致。
  const stops: Array<() => void> = [];
  const starts: Array<() => void> = [];
  let inboundHandle: SocketInboundHandle | undefined;

  if (outboundReady) {
    const driver = new SlackOutboundDriver({
      home: opts.home,
      queue: ports,
      seen: outboundSeen,
      filter: { minimumLevel: cfg.minimumLevelThatPosts },
      dispatch: (op, ref, payload) => wire.dispatcher.dispatch(op, ref, payload),
      intervalMs: opts.outboundIntervalMs,
      log,
    });
    releaseRef = (q) => driver.release(q);
    starts.push(() => {
      driver.start();
      log("Slack 出站驱动已启动（子系统路径）");
    });
    stops.push(() => driver.stop());
  }

  if (inboundReady) {
    const inboundSeen = new SeenStore(path.join(stateDir(opts.home), "slack-inbound-seen.jsonl"));
    const dead = new DeadLetterStore<SlackEvent>(path.join(stateDir(opts.home), "slack-inbound-deadletter.jsonl"));
    const receipts = new InboundReceiptStore(path.join(stateDir(opts.home), "slack-inbound-receipts.jsonl"));
    const registry: RegistrySurface = registrySurface;
    const router = new InboundRouter({
      queue: ports,
      seen: inboundSeen,
      deadLetter: dead,
      destination: cfg.inboundDestination,
      resolveSender: makeInboundSenderResolver(registry, opts.home),
      // S10 —— 确定性线程路由：已映射线程准确路由到对应席位；未映射线程或人类发起的
      // 消息作为 unrouted-signal 行路由到配置的编排器槽位。
      resolveRoute: makeThreadRouteResolver({ map: threadMap, unroutedDestination: cfg.inboundDestination, log }),
      resolveHumanReply: opts.resolveHumanReply,
      // OPR.0.5.6.2 —— 入站文件传输只在机器人令牌存在时装配（下载需要 `files:read`）；
      // 缺失时，由路由器自身的具名失败分支如实呈现失败。媒体与网关其他持久状态位于
      // 同一位置，并遵循相同的 home 约定。
      ...(bot ? {
        files: makeInboundFilePort({
          token: bot,
          mediaDir: path.join(stateDir(opts.home), "slack-inbound-media"),
          fetchImpl: opts.fetchImpl,
          log,
        }),
      } : {}),
      log,
    });
    starts.push(() => {
      inboundHandle = startSocketInbound(app!, router, {
        fetchImpl: opts.fetchImpl,
        wsFactory: opts.wsFactory,
        retryIntervalMs: opts.inboundRetryIntervalMs,
        inboundMaxConnects: opts.inboundMaxConnects,
        receipts,
        log,
      });
      log("Slack Socket Mode 入站服务已启动（子系统路径）");
    });
    stops.push(() => inboundHandle?.stop());
  }

  const baseStop = wire.stop;
  const baseStartServices = wire.startServices;
  let servicesLive = false;
  return {
    dispatcher: wire.dispatcher,
    startServices: () => {
      if (servicesLive) return; // 幂等：绑定后重复启动不得造成重复轮询
      servicesLive = true;
      baseStartServices?.(); // 通过交付重放未确认决策，重启不丢失
      for (const s of starts) s();
    },
    stop: () => {
      for (const s of stops) { try { s(); } catch { /* 尽力而为 */ } }
      baseStop();
    },
    status: () => ({
      platform: "slack", configurationDigest: channelStateDigest(cfg),
      outboundReady,
      inboundReady,
      inbound: inboundHandle?.status() ?? { state: inboundReady ? "not-started" : "not-configured", generation: 0, reconnects: 0 },
    }),
  };
}
