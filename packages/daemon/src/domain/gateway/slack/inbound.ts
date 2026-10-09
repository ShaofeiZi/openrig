// Slice-11 slack-connector —— 入站编排（Socket Mode → 队列）。
//
// 锁定条目：4（人类消息 → operator-agent@kernel 上的持久 qitem，可由配置覆盖）；
// 8（绝不丢失：快速确认传输，在返回前把每个落地失败的事件写入死信，只有持久 qitem
// 存在后才标记 seen，并按事件 ts 对处理中消息去重）；另含循环安全（绝不摄取机器人或
// 自身消息）以及 T1076（v1 中干净地忽略文件/图片事件）。
//
// WebSocket/ack 传输位于后台服务的 socket-inbound 服务中（S10：后台服务内子系统，
// CLI runner 已退役）；本模块是纯逻辑且可完整测试的核心：shouldIngest（过滤）、route
//（落地 + 去重 + 死信）、retryDeadLetters 以及 handleEnvelope（快速确认 + 分派）。
// S10 迁移后，队列接缝是进程内 PORT（queue-access.ts 适配 QueueRepository）；
// rig CLI 的 shell-out 桥接随 relay runner 一同退役，但周围的持久性语义保持不变。
import type { SeenStore, DeadLetterStore, DeadLetterEntry } from "./state-store.js";
import type { InboundQueuePort } from "./queue-access.js";
import { createHash } from "node:crypto";
import { ADMITTED_EVENT_TYPES } from "./capabilities.js";

export interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  /** S10 线程路由：线程回复中存在，值为父级根消息的 ts；顶层频道消息中不存在。
   *  判别规则为：thread_ts==ts 表示父消息，thread_ts!=ts 表示回复，缺失表示普通消息。 */
  thread_ts?: string;
  channel?: string;
  files?: unknown[];
}

/**
 * 循环安全与不可摄取消息忽略规则。摄取真实的人类消息，包括文本以及带文件的投递
 * （OPR.0.5.6.2，取代 T1076 v1 的忽略行为）：带 files[] 的 `file_share` subtype
 * 正是人类上传的消息形态；纯文件投递可以没有说明文字，因此存在文件时允许文本为空。
 * 循环安全保持不变：机器人消息及其他所有 subtype（编辑、加入等）仍被拒绝；返回 false
 * 仍表示干净跳过，绝不会崩溃或只摄取一部分。
 */
/** P28 —— 将拒绝分支表达为数据。旧忽略路径只记录 type/subtype/files，而消息因 bot_id、
 *  缺少 user 或文本为空被拒绝时，这些字段恰恰可能都已通过检查，导致无法解释静默丢弃；
 *  未授予 `channels:read` 时，甚至无法通过读取获知来源会话名称。这是摄取决策的唯一
 *  定义；`shouldIngest` 只是它的薄封装，从而保证分支逻辑只有一个来源，日志也不会与
 *  所描述的行为发生偏差。（OPR.0.5.6.2 中已从联合类型移除 "files"：带文件事件现在
 *  属于工作，而不是噪声。） */
export type IngestReason = "type" | "bot_id" | "subtype" | "no-user" | "empty-text";

export function ingestDecision(ev: SlackEvent): { ingest: true } | { ingest: false; reason: IngestReason } {
  const hasFiles = Array.isArray(ev.files) && ev.files.length > 0;
  if (!ev.type || !ADMITTED_EVENT_TYPES.includes(ev.type)) return { ingest: false, reason: "type" };
  if (ev.bot_id) return { ingest: false, reason: "bot_id" }; // 绝不摄取自身或任何机器人消息
  // OPR.0.5.6.2：带文件的 `file_share` 是人类上传形态，允许摄取；其他 subtype
  //（编辑、加入等）与此前一样继续拒绝。
  if (ev.subtype && !(ev.subtype === "file_share" && hasFiles)) return { ingest: false, reason: "subtype" };
  if (!ev.user) return { ingest: false, reason: "no-user" };
  // 纯文件投递没有说明文字：仅当消息带文件时才允许文本为空。
  if ((!ev.text || !ev.text.trim()) && !hasFiles) return { ingest: false, reason: "empty-text" };
  return { ingest: true };
}

/** OPR.0.5.6.2 —— 入站文件传输 PORT：通过注入保持核心逻辑纯净且可测试；子系统负责
 *  装配真实的下载与存储实现（参见 makeInboundFilePort）。成功和失败结果都按文件命名。 */
export interface StoredInboundFile { name: string; localPath: string; mimetype?: string; bytes: number }
export interface FailedInboundFile { name: string; error: string }
export interface InboundFileResult { stored: StoredInboundFile[]; failed: FailedInboundFile[] }
export interface InboundFilePort { transfer(files: unknown[], eventTs: string): Promise<InboundFileResult> }

export function shouldIngest(ev: SlackEvent): boolean {
  return ingestDecision(ev).ingest;
}

/** A6 v3：发送者准入判定。只有发送者能解析为已注册人类时，入站 Slack 消息才能成为
 *  具有人类来源的 qitem；写入的 `source` 是该人类的规范引用，绝不是原始平台 ID。
 *  未注册发送者或注册表加载失败都会被明确拒绝并给出醒目指引，绝不伪造席位。 */
export type InboundSenderResolution =
  | { admitted: true; source: string }
  | { admitted: false; teaching: string };

export interface InboundDeps {
  queue: InboundQueuePort;
  seen: SeenStore;
  deadLetter: DeadLetterStore<SlackEvent>;
  destination: string; // 一等配置项，默认为 operator-agent@kernel
  /** A6 v3 注册门禁。把 ev.user 解析为已注册人类（否则拒绝）。采用注入方式以保持
   *  核心逻辑纯净且可测试；子系统通过后台服务的人类注册表解析器进行装配。 */
  resolveSender: (slackUserId: string) => InboundSenderResolution;
  /** S10 线程路由（确定性、零推断）：为准入事件解析目标与标签。缺失时，所有事件都
   *  落到静态 `destination`，这既是路由功能加入前的形态，也是测试固定的回退行为。 */
  resolveRoute?: (ev: SlackEvent) => { destination: string; tags?: string[]; correlationQitemId?: string };
  /** 通过现有任务控制中心的 resolve 原语继续处理准确的人类门禁。 */
  resolveHumanReply?: (input: { qitemId: string; actorSession: string; decision: string }) => Promise<"resolved" | "already-resolved" | "not-applicable">;
  /** OPR.0.5.6.2 —— 入站文件传输。带文件事件缺少该端口时，每个文件都会作为具名失败
   *  写入行中（"传输不可用"），绝不会静默丢弃消息或文件。 */
  files?: InboundFilePort;
  sourceLabel?: string;
  log?: (msg: string) => void;
}

export class InboundRouter {
  private readonly inflight = new Set<string>(); // 防止相同 ts 被重复分派（条目 8）
  constructor(private readonly deps: InboundDeps) {}

  private summaryOf(ev: SlackEvent, transfer?: InboundFileResult | null, correlationQitemId?: string): { summary: string; body: string } {
    const text = String(ev.text ?? "").slice(0, 1800);
    const meta = `slack channel=${ev.channel} user=${ev.user} ts=${ev.ts}`;
    // OPR.0.5.6.2 —— 附件以本地路径写入行正文（Slack 不拥有这里的内容；媒体文件是
    // 我们自己的副本）。失败按文件具名记录，传输失败也不会丢失消息。
    const sections: string[] = [text];
    if (transfer && (transfer.stored.length > 0 || transfer.failed.length > 0)) {
      const lines: string[] = [];
      if (transfer.stored.length > 0) {
        lines.push("附件（工作区本地副本）：");
        for (const f of transfer.stored) {
          lines.push(`- ${f.localPath} (${f.name}${f.mimetype ? `, ${f.mimetype}` : ""}, ${f.bytes} bytes)`);
        }
      }
      for (const f of transfer.failed) {
        lines.push(`文件传输失败：${f.name} —— ${f.error}`);
      }
      sections.push(lines.join("\n"));
    }
    const firstFileName = transfer?.stored[0]?.name ?? transfer?.failed[0]?.name;
    const headline = text.trim() ? text : firstFileName ? `[文件] ${firstFileName}` : text;
    return {
      summary: `创始人通过 Slack：${headline.slice(0, 90)}`,
      body: `${sections.filter((s) => s.length > 0).join("\n\n")}\n\n---\n来源：${meta}${correlationQitemId ? `\n回复：${correlationQitemId}` : ""}\n由 zrig slack-inbound 路由。默认目标由配置决定；如有需要，请通过队列重新路由。`,
    };
  }

  private inboundQitemId(ev: SlackEvent): string {
    const key = `${ev.channel ?? "-"}:${ev.ts ?? "-"}`;
    return `qitem-slack-inbound-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
  }

  /**
   * 核心落地尝试，不产生死信副作用。按 ts（处理中 + 持久 seen）去重。`reason` 用于
   * 区分去重跳过与真实创建失败，使调用方只把真实失败写入死信。成功后才标记 seen
   * （此时持久 qitem 已存在，因此安全）。
   */
  private async attemptLand(ev: SlackEvent): Promise<{
    landed: boolean;
    qitemId?: string;
    reason?: "dup" | "create_failed" | "resolve_failed" | "unregistered";
    correlationQitemId?: string;
    replyResolution?: "resolved" | "already-resolved" | "not-applicable";
  }> {
    const ts = ev.ts ?? "";
    if (!ts || this.inflight.has(ts) || this.deps.seen.load().has(ts)) return { landed: false, reason: "dup" };
    // A6 v3 注册门禁：仅允许已注册者。未注册发送者会在此被拒绝，绝不会以伪造的
    // human-<slackid>@kernel 席位落地。这是策略拒绝而非暂时性失败，因此不会写入死信；
    // 在该人员完成注册前，重试也无济于事。
    const who = this.deps.resolveSender(ev.user ?? "");
    if (!who.admitted) {
      this.deps.log?.(`入站消息已拒绝——发送者 ${ev.user} 未注册（ts=${ts}）：${who.teaching}`);
      return { landed: false, reason: "unregistered" };
    }
    this.inflight.add(ts);
    try {
      // OPR.0.5.6.2 —— 在组装行之前传输人类发送的文件，使行中包含本地路径或具名
      // 失败。缺少端口本身也会记为每个文件的具名失败，绝不静默丢弃。
      const fileMetas = Array.isArray(ev.files) ? ev.files : [];
      let transfer: InboundFileResult | null = null;
      if (fileMetas.length > 0) {
        const namedAll = (error: string): InboundFileResult => ({
          stored: [],
          failed: fileMetas.map((f, i) => {
            const m = (f ?? {}) as { name?: string; id?: string };
            return { name: String(m.name ?? m.id ?? `file-${i + 1}`), error };
          }),
        });
        if (!this.deps.files) {
          transfer = namedAll("文件传输不可用（未装配文件端口）");
        } else {
          // R1 F2：端口抛出异常（例如磁盘已满导致 mkdirp 失败或任何崩溃）时，绝不能
          // 丢失已确认的消息。行仍会落地，每个文件都记为具名失败。失败如实呈现由此接缝
          // 保证，不能依赖端口自行履约。
          try {
            transfer = await this.deps.files.transfer(fileMetas, ts);
          } catch (e) {
            this.deps.log?.(`入站文件端口崩溃，ts=${ts}：${(e as Error).message}`);
            transfer = namedAll(`文件传输崩溃：${(e as Error).message || "未知错误"}`);
          }
        }
      }
      // S10 —— 已装配时采用确定性路由（线程映射），否则使用静态目标。
      const route = this.deps.resolveRoute?.(ev) ?? { destination: this.deps.destination };
      const { summary, body } = this.summaryOf(ev, transfer, route.correlationQitemId);
      let qitemId: string;
      try {
        qitemId = await this.deps.queue.createQitem({
          qitemId: this.inboundQitemId(ev),
          source: who.source, // 已注册人类的规范引用（human 类），绝不是原始平台 ID
          destination: route.destination,
          priority: "routine",
          tags: route.tags ?? ["founder-slack", "inbound"],
          summary,
          body,
        });
      } catch (e) {
        this.deps.log?.(`qitem 创建失败，ts=${ts}：${(e as Error).message}`);
        return { landed: false, reason: "create_failed" };
      }
      let replyResolution: "resolved" | "already-resolved" | "not-applicable" | undefined;
      if (route.correlationQitemId && this.deps.resolveHumanReply) {
        try {
          replyResolution = await this.deps.resolveHumanReply({
            qitemId: route.correlationQitemId,
            actorSession: who.source,
            decision: String(ev.text ?? "").trim() || "[文件回复]",
          });
        } catch (e) {
          this.deps.log?.(`人类回复继续处理失败，qitem=${route.correlationQitemId} ts=${ts}：${(e as Error).message}`);
          return { landed: false, qitemId, reason: "resolve_failed", correlationQitemId: route.correlationQitemId };
        }
      }
      this.deps.seen.mark(ts, "landed"); // 持久 qitem 已存在，可以安全标记
      this.deps.log?.(`qitem ${qitemId} → ${route.destination}（ts=${ts}）`);
      return { landed: true, qitemId, correlationQitemId: route.correlationQitemId, replyResolution };
    } finally {
      this.inflight.delete(ts);
    }
  }

  /**
   * 实时路径：尝试落地；真实创建失败时，在返回之前把事件写入死信并累计尝试次数，
   * 且不标记 seen（条目 8）。
   */
  async route(ev: SlackEvent, attempts = 0): Promise<{
    landed: boolean;
    qitemId?: string;
    disposition: "accepted" | "ignored" | "refused" | "dead-lettered";
    reason?: string;
    correlationQitemId?: string;
    replyResolution?: "resolved" | "already-resolved" | "not-applicable";
  }> {
    const r = await this.attemptLand(ev);
    if (!r.landed && (r.reason === "create_failed" || r.reason === "resolve_failed")) {
      this.deps.deadLetter.append(ev, attempts + 1);
      this.deps.log?.(`已写入死信，ts=${ev.ts}（第 ${attempts + 1} 次尝试）`);
    }
    const disposition = r.landed ? "accepted" : r.reason === "unregistered" ? "refused" : r.reason === "dup" ? "ignored" : "dead-lettered";
    return { landed: r.landed, qitemId: r.qitemId, disposition, reason: r.reason, correlationQitemId: r.correlationQitemId, replyResolution: r.replyResolution };
  }

  /**
   * 可安全中断的重试（条目 8）：以非破坏方式读取持久集合，逐项尝试，然后以仍失败的
   * 条目原子替换文件。在完成原子替换前原文件保持不变，因此任意时刻崩溃都不会丢失
   * 数据；此后已落地的事件由 seen 集合跳过。这里不经过 route()，否则会重复追加，
   * 而是直接使用 attemptLand。
   */
  async retryDeadLetters(): Promise<{ retried: number; landed: number }> {
    const entries = this.deps.deadLetter.readAll();
    if (entries.length === 0) return { retried: 0, landed: 0 };
    this.deps.log?.(`正在重试 ${entries.length} 条死信`);
    const stillFailing: DeadLetterEntry<SlackEvent>[] = [];
    let landed = 0;
    const seen = this.deps.seen.load();
    for (const e of entries) {
      if (e.ev.ts && seen.has(e.ev.ts)) continue; // 已落地即视为恢复，从集合移除
      const r = await this.attemptLand(e.ev);
      if (r.landed) landed++;
      else if (r.reason === "create_failed" || r.reason === "resolve_failed") stillFailing.push({ ev: e.ev, at: e.at, attempts: e.attempts + 1 });
      // reason === "dup"（处理中）时移除，因为已有并发路径负责它。
    }
    this.deps.deadLetter.replaceAll(stillFailing); // 原子替换；执行到这里前原文件保持完整
    return { retried: entries.length, landed };
  }
}

export interface SocketEnvelope {
  envelope_id?: string;
  type?: string;
  reason?: string;
  payload?: { event?: SlackEvent };
}

/**
 * 处理一个 Socket Mode 信封。始终先快速确认（条目 8：Socket Mode 会惩罚慢确认，
 * 传输层重投不是安全网），然后再过滤和路由。即使后续路由失败也已完成确认；防止消息
 * 丢失依靠死信，而不是传输层重投。
 */
export async function handleEnvelope(
  env: SocketEnvelope,
  ack: () => void,
  router: InboundRouter,
  log?: (m: string) => void,
  onReceived?: () => void,
): Promise<{ status: "accepted" | "ignored" | "refused" | "dead-lettered"; reason?: string }> {
  if (env.envelope_id) ack(); // 无条件优先快速确认
  onReceived?.(); // 诊断接收记录位于确认之后、所有处理器过滤之前
  if (env.type === "disconnect") return { status: "ignored", reason: "disconnect" };
  if (env.type !== "events_api") return { status: "ignored", reason: "envelope-type" };
  const ev = env.payload?.event ?? {};
  const decision = ingestDecision(ev);
  if (!decision.ingest) {
    // P28：记录实际命中的分支和来源会话。隐私边界只允许频道 ID 与分支标签，
    // 绝不记录正文、令牌、用户 ID，也不记录文本内容或长度。
    if (ev.type) {
      log?.(
        `已忽略不可摄取事件 type=${ev.type} subtype=${ev.subtype ?? "-"} files=${ev.files?.length ?? 0}` +
          ` channel=${ev.channel ?? "-"} reason=${decision.reason}`,
      );
    }
    return { status: "ignored", reason: decision.reason };
  }
  const routed = await router.route(ev);
  return { status: routed.disposition, reason: routed.reason };
}
