// S10 — 子系统的 Slack 投递路径（取代已退役 connector-server 的 slackDeliverFn；
// proof-1 语义保持不变）：将 OutboundDecision 渲染为安全载荷（由 message.ts 完成
// slice-11 第 7 项脱敏并生成 Block Kit），然后发送。2xx → ok（进程内确认会排空
// 持久化缓冲区）；任何失败 → 有界的失败类别（线路会保留并重放——失败可见，绝不静默丢弃）。
//
// 相比已退役路径的变更均由契约驱动：
//   - postWebhook → postChatMessage：R2 线程结构需要 thread_ts，而 webhook 无法携带它。
//     webhook 随 relay 一同退役。
//   - decisionId 的幂等重投从 connector 移到这里：已投递的 decisionId 会在不重复发送的
//     情况下重新确认（delivered-store 沿用 SeenStore 模式，以 decisionId 为键——不同于
//     以 qitemId 标记的出站已见状态）。
//   - delivered-ok 还会将 qitemId 标记为已见（slice-11：仅在成功后标记），
//     并释放驱动器的进行中守卫。

import fs from "node:fs";
import path from "node:path";
import { postChatMessage, getUploadURLExternal, uploadBytesExternal, completeUploadExternal, fetchRecentMessageTexts, type FetchImpl } from "./slack-api.js";
import { buildOutboundMessage, attributionFromSession, reconcileToken, type SlackMediaRef } from "./message.js";
import type { SeenStore } from "./state-store.js";
import type { OutboundDecision } from "../protocol.js";
import type { SubsystemDeliverFn, SubsystemDeliveryOutcome } from "../gateway-subsystem.js";
import type { OutboundPostPayload } from "./outbound-driver.js";

export interface SubsystemSlackDeliveryOpts {
  botToken: string;
  channel: string;
  sourceLabel: string; // host/box/rig——来自配置，绝不硬编码（第 7 项）
  bodyExcerpt?: number;
  fetchImpl?: FetchImpl;
  /** 以 decisionId 为键的 delivered-store（幂等重投：重放时重新确认，绝不重复发送）。 */
  delivered: SeenStore;
  /** H — 以 decisionId 为键的 ATTEMPTED-store，在发送 HTTP 请求之前标记。重试已尝试过的
   *  decision 时，先前结果存在歧义（超时请求可能已送达），因此再次发送前必须按标记协调，
   *  绝不盲目重发。它不同于 `delivered`（已证实为 2xx）。 */
  attempted: SeenStore;
  /** 以 episode 为键的出站已见状态（仅在发送成功后标记）。 */
  outboundSeen: SeenStore;
  /** episode 被持久标记为已见后，释放出站驱动器的进行中守卫。 */
  release?: (notificationKey: string) => void;
  /** E（线程路由）：解析此载荷的线程锚点；undefined 表示新建根消息。
   *  由 thread-seat 映射接线；预路由组合中不存在。 */
  resolveThreadTs?: (payload: OutboundPostPayload) => string | undefined;
  /** E：记录新根消息的 ts，使后续对话在该线程中继续。 */
  onPostedRoot?: (payload: OutboundPostPayload, ts: string) => void;
  /** 每次发送成功后的回执钩子，无论是根消息还是线程消息。 */
  onPosted?: (payload: OutboundPostPayload, messageTs: string, threadTs?: string) => void;
  /** OPR.0.5.6.14 — 传输失败回执钩子：发送失败时写入该行的 transport-failed
   *  台账转换（类别 + API 错误），使投递失败与成功一样能从该行清晰识别。 */
  onTransportFailed?: (payload: OutboundPostPayload, failureClass: string, detail: string) => void;
  /** F（临时响度规则）：对于 ESCALATION 载荷，返回要提及的 Slack USER ID；其他情况
   *  返回 undefined（安静地发在线程中）。组合层负责接入注册表查询和升级判定，
   *  投递层只按指令渲染。 */
  resolveMentionUserId?: (payload: OutboundPostPayload) => string | undefined;
  /** G — 读取 evidenceRef 指向的本地图片（创始人截图这一类：seat 文件没有公开 URL，
   *  因此通过 EXTERNAL-UPLOAD 流程进入线程）。可注入以支持封闭测试；默认读取文件系统，
   *  且仅接受图片扩展名。返回 null 表示它不是可上传的本地图片。 */
  readLocalImage?: (refPath: string) => { bytes: Uint8Array; filename: string } | null;
  log?: (msg: string) => void;
}

const LOCAL_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TRANSPORT_FAILURE_RECEIPT_PREFIX = "::transport-failure-receipt::";
const TRANSPORT_FAILURE_RECEIPT_REPAIRED = "::repaired";

function transportFailureReceiptKey(decisionId: string, failureClass: string, detail: string): string {
  const encoded = Buffer.from(JSON.stringify([failureClass, detail]), "utf8").toString("base64url");
  return `${decisionId}${TRANSPORT_FAILURE_RECEIPT_PREFIX}${encoded}`;
}

function pendingTransportFailureReceipt(
  attempted: Set<string>,
  decisionId: string,
): { key: string; failureClass: string; detail: string } | { key: string; error: string } | null {
  const prefix = `${decisionId}${TRANSPORT_FAILURE_RECEIPT_PREFIX}`;
  const key = [...attempted.keys()].find((candidate) =>
    candidate.startsWith(prefix)
      && !candidate.endsWith(TRANSPORT_FAILURE_RECEIPT_REPAIRED)
      && !attempted.has(`${candidate}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`));
  if (!key) return null;
  try {
    const parsed = JSON.parse(Buffer.from(key.slice(prefix.length), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
      return { key, error: "待处理的传输失败回执格式无效" };
    }
    return { key, failureClass: parsed[0], detail: parsed[1] };
  } catch (e) {
    return { key, error: `无法读取待处理的传输失败回执：${(e as Error).message}` };
  }
}

/** 默认的本地图片读取器：必须是绝对路径、图片扩展名且可读，否则返回 null。 */
export function defaultReadLocalImage(refPath: string): { bytes: Uint8Array; filename: string } | null {
  try {
    if (!path.isAbsolute(refPath)) return null;
    if (!LOCAL_IMAGE_EXT.has(path.extname(refPath).toLowerCase())) return null;
    const bytes = fs.readFileSync(refPath);
    return { bytes: new Uint8Array(bytes), filename: path.basename(refPath) };
  } catch {
    return null;
  }
}

/** 构建子系统 DeliverFn。其契约与已退役 connector 的 handleDecision 对应。 */
function deliverSinglePart(opts: SubsystemSlackDeliveryOpts, markEpisode = true): SubsystemDeliverFn {
  const log = opts.log ?? (() => {});
  return async (decision: OutboundDecision): Promise<SubsystemDeliveryOutcome> => {
    // 幂等重投：已投递的 decisionId 会在不重复发送的情况下重新确认。
    if (opts.delivered.load().has(decision.decisionId)) {
      log(`投递：decision ${decision.decisionId} 已送达——重新确认，不重复发送`);
      return { ok: true };
    }
    const q = (decision.payload ?? {}) as OutboundPostPayload & { media?: SlackMediaRef[] };
    // M1 A5b（从已退役的 sweep 沿用）：告警的 evidenceRef 就是供人工判断的工件——
    // https 图片 URL 会作为 Block Kit 图片发送。buildImageBlocks 仍是唯一的安全门禁
    //（丢弃非 https 或包含密钥的内容），因此判定逻辑只存在于一个位置。
    const mediaRefs: SlackMediaRef[] | undefined = Array.isArray(q.media)
      ? q.media
      : q.evidenceRef
        ? [{ imageUrl: String(q.evidenceRef), altText: q.summary ?? "附件" }]
        : undefined;
    const payload = buildOutboundMessage(
      {
        qitemId: q.qitemId ?? decision.decisionId,
        summary: q.summary,
        body: q.body,
        destinationSession: q.destinationSession ?? decision.entityBindingRef,
      },
      {
        sourceLabel: opts.sourceLabel,
        bodyExcerpt: opts.bodyExcerpt,
        mediaRefs,
        // A1.2 — 每条消息都携带归属信息；身份仍使用应用自身身份（postChatMessage
        // 在结构上无法携带 username/icon 覆盖值——禁止自定义的护栏）。
        attribution: attributionFromSession(q.sourceSession),
        mentionUserId: opts.resolveMentionUserId?.(q),
        // fix-r3 — 协调身份保留在截断预算之外（下方扫描使用同一函数匹配：
        // 同一身份、相同字节、两端一致）。
        reconcileMarker: reconcileToken(decision.decisionId),
      },
    );
    const threadTs = opts.resolveThreadTs?.(q);

    // 若 HTTP 失败后行回执写入也失败，则由现有的、可跨重启保留的 attempted store
    // 保存该结果。在协调流程进入后续发送之前，先修复这一权威状态转换。
    const attempted = opts.attempted.load();
    const pendingFailure = pendingTransportFailureReceipt(attempted, decision.decisionId);
    if (pendingFailure) {
      if ("error" in pendingFailure) {
        log(`${decision.decisionId} 的${pendingFailure.error}——已保留，不重新发送`);
        return { ok: false, class: "receipt-failed", detail: pendingFailure.error };
      }
      try {
        if (!opts.onTransportFailed) throw new Error("传输失败回执钩子不可用");
        opts.onTransportFailed(q, pendingFailure.failureClass, pendingFailure.detail);
        opts.attempted.mark(
          `${pendingFailure.key}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`,
          "transport-failure-receipt-repaired",
        );
      } catch (e) {
        log(`为 ${q.qitemId ?? decision.decisionId} 修复传输失败回执失败：${(e as Error).message}——已保留，不重新发送`);
        return { ok: false, class: "receipt-failed", detail: (e as Error).message };
      }
    }

    // H — 任何重发之前都先按标记协调：若此前已尝试过该 decision，则先前结果存在歧义
    //（超时请求可能已发送成功）。在消息可能存在的位置（线程，或频道历史）搜索消息的
    // 结构化身份；找到 → 已投递，记录并确认，绝不重复发送。搜索失败 = 仍有歧义 =
    // 保留到下次重放（频道不可读时绝不盲目重发——重复的人类通知是红线，延迟则不是）。
    // fix-r3（R2 恰好一次）：身份为 reconcileToken(decisionId)——这是限定在 decision
    // 范围内的有界令牌，渲染器将其保留在截断预算之外，因此在普通长度下必然出现在
    // 被扫描的顶层文本中；引用 qitem id 的普通文字无法复现它（其中以分隔形式嵌入了
    // daemon 生成的 decisionId）。生产者与扫描器调用同一函数：身份一致、字节一致、两端一致。
    const marker = reconcileToken(decision.decisionId);
    if (attempted.has(decision.decisionId)) {
      const scan = await fetchRecentMessageTexts(opts.botToken, opts.channel, threadTs, opts.fetchImpl);
      if (!scan.ok) {
        log(`对 ${decision.decisionId} 的协调扫描失败（${scan.error}）——已保留，不盲目重发`);
        return { ok: false, class: "reconcile-unreadable", detail: scan.error };
      }
      const matched = scan.messages.find((m) => m.text.includes(marker));
      if (matched) {
        log(`协调：在 ts=${matched.ts || "（缺失）"} 找到标记 "${marker}"——先前结果不明的消息已送达；确认但不重复发送`);
        // S14 修复（R2 HOLD）：匹配消息的真实 Slack ts 就是线程锚点。严格复刻正常
        // 发送顺序——先打开根消息（ThreadSeatMap + 重建标记），再写同一行回执，最后才
        // 持久化 delivered/seen/release——这样对真实根消息的回复会路由到该行所有者，
        // 而非通用处理。此前使用合成 ts 正是缺陷所在。
        if (matched.ts) {
          // OPR.0.5.6.14 — 与正常发送回执采用相同的保留并修复契约：
          // 回执写入抛错时将 decision 保留到下次重放（标记仍可找到，不会重复发送）。
          try {
            if (threadTs === undefined) opts.onPostedRoot?.(q, matched.ts);
            opts.onPosted?.(q, matched.ts, threadTs);
          } catch (e) {
            log(`协调 ${q.qitemId ?? decision.decisionId} 时写入回执失败：${(e as Error).message}——已保留到下次重放`);
            return { ok: false, class: "receipt-failed", detail: (e as Error).message };
          }
        } else {
          // 明确降级：匹配到的消息若无 ts，便无法作为线程锚点；仍然确认（绝不重发），
          // 但要清楚说明路由仍使用通用处理。
          log(`协调：匹配消息没有 ts——回执降级为合成值；${q.qitemId ?? decision.decisionId} 无法使用线程路由`);
          opts.onPosted?.(q, "reconciled", threadTs);
        }
        opts.delivered.mark(decision.decisionId, "reconciled-delivered");
        if (markEpisode && q.qitemId) {
          const key = q.notificationKey ?? q.qitemId;
          opts.outboundSeen.mark(key, "posted");
          opts.release?.(key);
        }
        return { ok: true };
      }
      log(`协调：未发现标记 "${marker}"——可以安全发送`);
    }

    // 在发送前持久标记为 ATTEMPTED：从此刻起，收到 2xx 前的任何结果都存在歧义。
    opts.attempted.mark(decision.decisionId, "attempted");
    const res = await postChatMessage(
      opts.botToken,
      { channel: opts.channel, text: payload.text, blocks: payload.blocks, thread_ts: threadTs },
      opts.fetchImpl,
    );
    if (!res.ok) {
      const failureClass = res.status === 0 ? "transport" : `http-${res.status}`;
      // 写入行记录前先持久化回执输入。即使写行时抛错，重启后仍可修复；
      // 在权威状态转换落地前，它会阻止后续任何重发。
      if (opts.onTransportFailed) {
        const receiptKey = transportFailureReceiptKey(decision.decisionId, failureClass, res.error ?? "");
        let receiptRetained = false;
        let retentionError: string | undefined;
        try {
          opts.attempted.mark(receiptKey, "transport-failure-receipt-pending");
          receiptRetained = true;
        } catch (e) {
          retentionError = (e as Error).message;
          log(`备份 ${q.qitemId ?? decision.decisionId} 的传输失败回执失败：${retentionError}——仍将尝试写入权威行记录`);
        }
        try {
          opts.onTransportFailed(q, failureClass, res.error ?? "");
        } catch (e) {
          const disposition = receiptRetained
            ? "已保留，将在重发前修复"
            : `未保留；备份先行失败：${retentionError}`;
          log(`写入 ${q.qitemId ?? decision.decisionId} 的传输失败回执失败：${(e as Error).message}——${disposition}`);
          return { ok: false, class: "receipt-failed", detail: (e as Error).message };
        }
        if (receiptRetained) {
          try {
            opts.attempted.mark(
              `${receiptKey}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`,
              "transport-failure-receipt-repaired",
            );
          } catch (e) {
            log(`写入 ${q.qitemId ?? decision.decisionId} 的传输失败回执修复标记失败：${(e as Error).message}——权威回执已落地；待处理标记已保留，以便幂等修复`);
            return { ok: false, class: "receipt-failed", detail: (e as Error).message };
          }
        }
      }
      return { ok: false, class: failureClass, detail: res.error };
    }
    // OPR.0.5.6.14 — 通过保留并修复消除 8f291c37 模式：成功发送后若回执写入抛错，
    // 会得到明确的已保留结果（异常绝不外逸）；重放会按标记协调——消息确实已在频道中——
    // 并重试幂等回执，而不重复发送。
    try {
      if (threadTs === undefined) opts.onPostedRoot?.(q, res.ts);
      opts.onPosted?.(q, res.ts, threadTs);
    } catch (e) {
      log(`${q.qitemId ?? decision.decisionId} 发送成功后写入回执失败：${(e as Error).message}——已保留；重放将按标记协调并重试幂等回执`);
      return { ok: false, class: "receipt-failed", detail: (e as Error).message };
    }
    // 只有权威行回执写入成功后才算完成投递。回执失败会保留 decision；
    // 重放时按标记协调，并重试幂等回执。
    opts.delivered.mark(decision.decisionId, "delivered");
    if (markEpisode && q.qitemId) {
      const key = q.notificationKey ?? q.qitemId;
      opts.outboundSeen.mark(key, "posted");
      opts.release?.(key);
    }

    // G — 本地图片 evidenceRef（创始人截图）通过 EXTERNAL-UPLOAD 流程进入会话线程
    //（files.upload 已停止使用）。上传失败必须可见，但不会让 decision 失败：文本已经送达；
    // 若在这里失败，会重放整条消息并产生重复的人类通知（H 的红线）。https 引用已在上方
    // 作为 Block Kit 图片块发送；非图片或不存在的引用会直接跳过。
    const local = q.evidenceRef && !/^https:\/\//.test(String(q.evidenceRef))
      ? (opts.readLocalImage ?? defaultReadLocalImage)(String(q.evidenceRef))
      : null;
    if (local) {
      const intoThread = threadTs ?? res.ts;
      const up = await getUploadURLExternal(opts.botToken, local.filename, local.bytes.length, opts.fetchImpl);
      if (up.ok && up.uploadUrl && up.fileId) {
        const put = await uploadBytesExternal(up.uploadUrl, local.bytes, opts.fetchImpl);
        if (put.ok) {
          const done = await completeUploadExternal(
            opts.botToken,
            { files: [{ id: up.fileId, title: q.summary ?? local.filename }], channelId: opts.channel, threadTs: intoThread },
            opts.fetchImpl,
          );
          if (done.ok) log(`已为 ${q.qitemId ?? decision.decisionId} 将 ${local.filename} 上传到线程 ${intoThread ?? "（根消息）"}`);
          else log(`为 ${q.qitemId ?? decision.decisionId} 完成附件上传失败：${done.error}（文本已送达；附件缺失）`);
        } else {
          log(`为 ${q.qitemId ?? decision.decisionId} 上传附件字节失败：${put.error}（文本已送达；附件缺失）`);
        }
      } else {
        log(`为 ${q.qitemId ?? decision.decisionId} 获取附件上传 URL 失败：${up.error}（文本已送达；附件缺失）`);
      }
    }

    log(`已投递 ${decision.decisionId}${q.qitemId ? `（qitem ${q.qitemId}）` : ""}`);
    return { ok: true };
  };
}

/** 一条精心编写的主消息，以及可选的一条连贯补充回复。现有的 attempted/delivered
 * store 和标记协调器分别负责每个稳定分段。发送前预检所有分段；只有所有必需分段
 * 均完成后才写入 episode 回执。重启后会重试缺失分段及最终回执。 */
export function subsystemSlackDeliver(opts: SubsystemSlackDeliveryOpts): SubsystemDeliverFn {
  return async (decision) => {
    if (opts.delivered.load().has(decision.decisionId)) return { ok: true };
    const q = (decision.payload ?? {}) as OutboundPostPayload & { media?: SlackMediaRef[] };
    const parts = q.humanDetail
      ? [
          { ...q, humanDetail: undefined, body: `${q.body ?? ""}\n\n补充详情将在本线程中继续。` },
          { ...q, humanDetail: undefined, summary: `补充详情：${q.summary ?? ""}`, body: q.humanDetail, media: [], evidenceRef: null },
        ]
      : [q];
    const partId = (index: number) => parts.length === 1 ? decision.decisionId : `${decision.decisionId}:part:${index + 1}`;
    try {
      for (const [index, part] of parts.entries()) {
        buildOutboundMessage(part, {
          sourceLabel: opts.sourceLabel,
          attribution: attributionFromSession(part.sourceSession),
          mentionUserId: index === 0 ? opts.resolveMentionUserId?.(q) : undefined,
          reconcileMarker: reconcileToken(partId(index)),
          mediaRefs: Array.isArray(part.media) ? part.media : part.evidenceRef ? [{ imageUrl: part.evidenceRef, altText: part.summary ?? "附件" }] : undefined,
        });
      }
    } catch (error) {
      const detail = (error as Error).message;
      try { opts.onTransportFailed?.(q, "human-message-unrenderable", detail); }
      catch (receiptError) { return { ok: false, class: "receipt-failed", detail: (receiptError as Error).message }; }
      return { ok: false, class: "human-message-unrenderable", detail };
    }
    if (parts.length === 1) return deliverSinglePart(opts)(decision);

    const rootPrefix = `${decision.decisionId}::primary-receipt::`;
    const retained = [...opts.attempted.load()].find((key) => key.startsWith(rootPrefix));
    let primary: { messageTs: string; threadTs?: string } | undefined = retained
      ? JSON.parse(Buffer.from(retained.slice(rootPrefix.length), "base64url").toString("utf8"))
      : undefined;
    for (const [index, part] of parts.entries()) {
      if (index > 0 && (!primary || primary.messageTs === "reconciled")) {
        return { ok: false, class: "receipt-failed", detail: "补充投递需要主 Slack 消息的真实时间戳；请保留以便协调。" };
      }
      const outcome = await deliverSinglePart({
        ...opts,
        resolveMentionUserId: index === 0 ? opts.resolveMentionUserId : undefined,
        resolveThreadTs: index === 0 ? opts.resolveThreadTs : () => primary!.threadTs ?? primary!.messageTs,
        onPostedRoot: index === 0 ? opts.onPostedRoot : undefined,
        onPosted: (_part, messageTs, threadTs) => {
          if (index !== 0) return;
          if (messageTs === "reconciled") throw new Error("主消息协调结果没有 Slack 时间戳；多段投递仍未完成。");
          primary = { messageTs, threadTs };
          opts.attempted.mark(rootPrefix + Buffer.from(JSON.stringify(primary)).toString("base64url"), "primary-receipt");
        },
      }, false)({ ...decision, decisionId: partId(index), payload: part });
      if (!outcome.ok) return outcome;
    }
    try {
      if (!primary) throw new Error("主消息回执不可用；请保留多段投递。");
      opts.onPosted?.(q, primary.messageTs, primary.threadTs);
      opts.delivered.mark(decision.decisionId, "all-parts-delivered");
      if (q.qitemId) {
        const key = q.notificationKey ?? q.qitemId;
        opts.outboundSeen.mark(key, "posted");
        opts.release?.(key);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, class: "receipt-failed", detail: (error as Error).message };
    }
  };
}
