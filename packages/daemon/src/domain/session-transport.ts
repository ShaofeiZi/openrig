import { randomUUID } from "node:crypto";
import { OutboxHandler } from "./outbox-handler.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity } from "./types.js";
import { wrapPaneEnvelope, appendDeliveredSegment, type EnvelopeScope } from "../lib/pane-envelope.js";
import { getSelfHostId } from "./hosts/fanout-contract.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import type { SlowOperationInstrumentation } from "./slow-op-recorder.js";
import { hashSentText, type CaptureObserverSink, type CaptureSlot, type ObservationInput, type ObservedBinding } from "./capture-observer.js";

// OPR.0.4.1.10——发送就绪性的新鲜度。runtime hook store 为活动展示保留 5 分钟新鲜度，但判断
//“现在发送是否安全”需要更紧的窗口：陈旧的 idle 读数不能授权向之后可能已变成 prompt 的目标发送。
// 超出窗口后，send-readiness 忽略 hook 并回退到实时 capture-pane 探针，之后可由创始人调节。
// 15 秒取值来自研究而非先验：同类智能体工具中的 terminal 状态有效期按秒计，agtx 以约 2 秒 TTL
// 缓存 pane 状态；源自 SWE-agent/OpenDevin 的启发式（daintree #3938）给出 Claude 1–3 秒、Codex
// 3–5 秒的工具调用间隙和 6 秒 idle debounce。15 秒足以覆盖一次工具间隙，使轮次中的读数仍可信，
// 同时拒绝用数十秒前的读数授权发送（EXA：agtx#14、daintree#3938）。
const SEND_READINESS_FRESHNESS_MS = 15_000;

// 工作中检测模式（低成本启发式）。
const MID_WORK_PATTERNS = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // spinner chars
  /Working/,
  /^[✶✢✳✻✽·]\s+\S.*(?:…|\.{3})\s+\([^)]*\bthinking\)$/m,
  /esc to interrupt/,
  /^[❯›]\s*\d+\.\s/m,   // trust/consent prompt choices (e.g. '› 1. Yes, continue')
];

// 空闲 prompt 模式：prompt 字符后没有已输入文本的空行。类似 '❯ Working on a task.' 的行在
// prompt 字符后仍有文本，不属于空闲；prompt 正携带输入，只是看起来可能像工作中。
const IDLE_PROMPT_PATTERNS = [
  /^[❯›]\s*$/,  // 仅 prompt 字符、可选空白和行尾。
];

const PROMPT_DRAFT_PATTERNS = [
  /^[❯›]\s+\S/,
];

// 仅当 harness 位于空闲 prompt 时才出现的状态栏模式。它们比单独的 prompt 字符更可靠，
// 因为活动工具执行期间绝不会渲染这些模式。
const IDLE_STATUS_BAR_PATTERNS = [
  /gpt-\d[\d.]* .+ · Context \[/,  // Codex model/context footer
  /⏵⏵ accept edits/,              // Claude Code edit-accept bar
];

const IDLE_TERMINAL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "nu", "tmux"]);

// OPR.0.4.1.10——权限/确认问题特征。编号 selector 模式（`❯/› N.`）已能捕获高亮的
// AskUserQuestion / trust-prompt 选项；这些模式进一步捕获权限问题行本身，使 selector 已滚出屏幕、
// 底部看似空闲的权限 block 仍会分类为需要输入，而非 idle。具体措辞把误报率压到接近零；智能体
// 很少把 "Do you want to proceed?" 当普通输出打印。
const PERMISSION_PROMPT_PATTERNS = [
  /\bDo you want to (?:proceed|continue|trust|allow|make|apply|create|run|delete|overwrite|edit)\b/i,
  /\bDo you trust the\b/i,
  // Codex v0.139.0 命令批准渲染（qa-codex-approval-render-research-20260627）：上方已捕获
  // selector（`› N.`）；当 selector 滚出屏幕时，这些问题行可使回退仍可靠。
  /\bWould you like to run the following command\b/i,
  /\bAllow Codex to run\b/i,
];

// OPR.0.4.1.10——为交互 prompt 特征（编号 selector / 权限问题）扫描的尾部非空行数。该窗口比
// 通用活动窗口（8）更宽，因为较高的持久 footer 会把真实 prompt 的 selector 推到末尾几行上方。
// Claude Code 在实际 "❯ " prompt 下方渲染状态栏、权限模式提示、分隔线、输入框边框和思考预算；
// 在狭窄平铺 pane 中，这个 footer 会把 prompt 推出 8 行窗口，产生误判 idle 的风险。12 与 ntm
// 项目遇到该问题后采用的窗口一致。本守卫宁可偏向“检测到 prompt”：误拒绝可覆盖，而误判 idle
// 会让消息落到 prompt 上（EXA：ntm e28763e；AgentDeck）。
const PROMPT_SCAN_LINES = 12;

export interface PaneActivityClassification {
  state: "agent_active" | "agent_idle" | "attention" | "unknown";
  reason: string;
  evidence: string | null;
}

function trimPaneLines(paneContent: string): string[] {
  return paneContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function truncateEvidence(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function findPatternEvidence(lines: string[], patterns: RegExp[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (patterns.some((pattern) => pattern.test(line))) return truncateEvidence(line);
  }
  return null;
}

function findPromptDraftBeforeFooter(paneContent: string): string | null {
  const rawLines = paneContent.split("\n").map((line) => line.trimEnd());
  let lastLineIndex = rawLines.length - 1;
  while (lastLineIndex >= 0 && rawLines[lastLineIndex]!.trim().length === 0) {
    lastLineIndex--;
  }
  if (lastLineIndex <= 0) return null;

  const footerLine = rawLines[lastLineIndex]!.trim();
  const footerIsIdle = IDLE_STATUS_BAR_PATTERNS.some((pattern) => pattern.test(footerLine));
  if (!footerIsIdle) return null;

  const priorLine = rawLines[lastLineIndex - 1]!;
  if (priorLine.trim().length === 0) return null;

  const priorTrimmed = priorLine.trim();
  const looksLikeDraft = PROMPT_DRAFT_PATTERNS.some((pattern) => pattern.test(priorTrimmed));
  const looksLikeSelection = /^[❯›]\s*\d+\.\s/.test(priorTrimmed);
  if (!looksLikeDraft || looksLikeSelection) return null;

  return truncateEvidence(priorTrimmed);
}

export function classifyPaneActivity(paneContent: string): PaneActivityClassification {
  const lastNonBlank = trimPaneLines(paneContent);
  if (lastNonBlank.length === 0) {
    return { state: "unknown", reason: "empty_capture", evidence: null };
  }

  const recentLines = lastNonBlank.slice(-8);
  const recentWindow = recentLines.join("\n");
  // prompt 特征使用更宽窗口，避免高 footer 把真实 prompt 推出视野（见 PROMPT_SCAN_LINES）；
  // 下方通用活动检查仍使用较紧的 8 行窗口。
  const promptScanLines = lastNonBlank.slice(-PROMPT_SCAN_LINES);
  const trailingNonBlank = lastNonBlank.slice(-3);
  const lastLine = lastNonBlank.at(-1) ?? "";
  const idlePromptLine = trailingNonBlank.find((line) =>
    IDLE_PROMPT_PATTERNS.some((pattern) => pattern.test(line))
  );
  const idleStatusBarLine = IDLE_STATUS_BAR_PATTERNS.some((pattern) => pattern.test(lastLine))
    ? lastLine
    : null;
  const selectionPromptEvidence = findPatternEvidence(promptScanLines, [/^[❯›]\s*\d+\.\s/m]);
  if (selectionPromptEvidence) {
    return {
      state: "attention",
      reason: "selection_prompt",
      evidence: selectionPromptEvidence,
    };
  }

  // OPR.0.4.1.10（FR-1c）：即使 selector 不在视野内，权限/确认问题仍属于 attention。
  // 在 idle 短路前检查，防止位于看似空闲 footer 上方的权限 block 被读成 idle，导致默认发送落入其中。
  const permissionPromptEvidence = findPatternEvidence(promptScanLines, PERMISSION_PROMPT_PATTERNS);
  if (permissionPromptEvidence) {
    return {
      state: "attention",
      reason: "permission_prompt",
      evidence: permissionPromptEvidence,
    };
  }

  const promptDraftEvidence = findPromptDraftBeforeFooter(paneContent);
  if (promptDraftEvidence) {
    return {
      state: "attention",
      reason: "prompt_draft",
      evidence: promptDraftEvidence,
    };
  }

  if (idleStatusBarLine) {
    return {
      state: "agent_idle",
      reason: "idle_status_bar",
      evidence: truncateEvidence(idleStatusBarLine),
    };
  }
  if (idlePromptLine && !MID_WORK_PATTERNS.some((pattern) => pattern.test(recentWindow))) {
    return {
      state: "agent_idle",
      reason: "idle_prompt",
      evidence: truncateEvidence(idlePromptLine),
    };
  }

  const midWorkEvidence = findPatternEvidence(recentLines, MID_WORK_PATTERNS);
  if (midWorkEvidence) {
    return {
      state: "agent_active",
      reason: "mid_work_pattern",
      evidence: midWorkEvidence,
    };
  }

  if (idlePromptLine) {
    return {
      state: "agent_idle",
      reason: "idle_prompt",
      evidence: truncateEvidence(idlePromptLine),
    };
  }

  return {
    state: "unknown",
    reason: "no_activity_signal",
    evidence: truncateEvidence(lastLine),
  };
}

export async function probeSessionActivity(input: {
  sessionName: string | null;
  runtime: string | null;
  attachmentType: "tmux" | "external_cli" | null | undefined;
  tmuxAdapter: TmuxAdapter;
  now?: Date;
  /** S01/S02 P2：对本探针已有 capture 的可选只读 observer。 */
  captureObserver?: CaptureObserverSink;
  binding?: Omit<ObservedBinding, "sessionName">;
}): Promise<AgentActivity> {
  // Capture 路由和观测标签必须共享入口上下文；hasSession 待处理期间，调用方可能复用/修改输入。
  const { sessionName, runtime, attachmentType, tmuxAdapter, now, captureObserver, binding } = input;
  const sampledAt = (now ?? new Date()).toISOString();
  // P2：attempt 身份在入口处、第一个 await 前冻结。下方提前返回不 capture，也不被观测。
  const observed = captureObserver ? {
    attemptId: randomUUID(),
    binding: Object.freeze({
      sessionName: sessionName ?? "",
      nodeId: binding?.nodeId ?? null,
      occupant: binding?.occupant ?? null,
      pane: binding?.pane ?? null,
    }),
    runtime,
    sink: captureObserver,
  } : undefined;

  if (!sessionName) {
    return {
      state: "unknown",
      reason: "no_session",
      evidenceSource: "session_registry",
      sampledAt,
      evidence: null,
    };
  }
  if (attachmentType === "external_cli") {
    return {
      state: "unknown",
      reason: "unsupported_attachment",
      evidenceSource: "external_cli",
      sampledAt,
      evidence: sessionName,
    };
  }
  if (runtime === "terminal") {
    try {
      const paneCommand = await tmuxAdapter.getPaneCommand(sessionName);
      if (paneCommand && !IDLE_TERMINAL_COMMANDS.has(paneCommand)) {
        return {
          state: "running",
          reason: "foreground_command",
          evidenceSource: "pane_heuristic",
          sampledAt,
          evidence: paneCommand,
          fallback: true,
        };
      }
    } catch {
      return {
        state: "unknown",
        reason: "capture_failed",
        evidenceSource: "pane_heuristic",
        sampledAt,
        evidence: null,
        fallback: true,
      };
    }

    return {
      state: "unknown",
      reason: "unsupported_runtime",
      evidenceSource: "pane_heuristic",
      sampledAt,
      evidence: null,
      fallback: true,
    };
  }

  try {
    const exists = await tmuxAdapter.hasSession(sessionName);
    if (!exists) {
      return {
        state: "unknown",
        reason: "session_missing",
        evidenceSource: "tmux_session",
        sampledAt,
        evidence: sessionName,
      };
    }
  } catch {
    return {
      state: "unknown",
      reason: "tmux_unavailable",
      evidenceSource: "tmux_session",
      sampledAt,
      evidence: null,
    };
  }

  const observeProbe = (slot: CaptureSlot, activity: AgentActivity): AgentActivity => {
    if (observed) {
      safeRecord(observed.sink, {
        seam: "probe_activity",
        attemptId: observed.attemptId,
        binding: observed.binding,
        runtime: observed.runtime,
        sentHash: null,
        pre: slot,
        post: { state: "not_requested" },
        regexResult: { state: activity.state, reason: activity.reason },
        completedAt: new Date().toISOString(),
      });
    }
    return activity;
  };
  const captureSeq = observed ? nextCaptureSeq++ : 0;
  try {
    const paneContent = await tmuxAdapter.capturePaneContent(sessionName, 20);
    const capturedAt = new Date().toISOString();
    const classification = classifyPaneActivity(paneContent ?? "");
    return observeProbe(captureSlot(paneContent, capturedAt, captureSeq), {
      state: mapPaneState(classification.state),
      reason: classification.reason,
      evidence: classification.evidence,
      evidenceSource: "pane_heuristic",
      sampledAt,
      fallback: true,
    });
  } catch {
    return observeProbe({ state: "unavailable", cause: "capture_error", capturedAt: new Date().toISOString(), captureSeq }, {
      state: "unknown",
      reason: "capture_failed",
      evidenceSource: "pane_heuristic",
      sampledAt,
      evidence: null,
      fallback: true,
    });
  }
}

// 这是观测到的 capture attempt 在本进程中的调用顺序，不是完成顺序，也不是持久/全局序列。
// attemptId 仍作为跨进程关联键。
let nextCaptureSeq = 1;

/** capturedAt 是 capture 返回/抛错的时刻，不是外层 send 完成的时刻。 */
function captureSlot(content: string | null | undefined, capturedAt: string, captureSeq: number): CaptureSlot {
  return typeof content === "string"
    ? { state: "captured", content, capturedAt, captureSeq }
    : { state: "unavailable", cause: "empty_or_failed", capturedAt, captureSeq };
}

/** 只复制调用方实际产生的判定字段；缺失值继续缺失。 */
function pickDefined(result: object, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (result as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 观测绝不能改变传输结果；任何 sink 失败都在此吞掉。 */
function safeRecord(sink: CaptureObserverSink, input: ObservationInput): void {
  try { sink.record(input); } catch { /* observer failure never reaches the caller */ }
}

export function mapPaneState(state: PaneActivityClassification["state"]): AgentActivity["state"] {
  if (state === "agent_active") return "running";
  if (state === "attention") return "needs_input";
  if (state === "agent_idle") return "idle";
  return "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    count++;
    start = index + needle.length;
  }
  return count;
}

/** 把已解析 fan-out 目标及其收件人列表映射为 EnvelopeScope（裁决 03c35295）。传输层知道目标形状
 * 与已解析席位，因此在后台服务侧构建真实规模：DM / multi（完整列表）/ 工作组或 pod 范围广播
 *（含席位数）/ topology。 */
export function scopeForTarget(target: TargetSpec, recipients: string[]): EnvelopeScope {
  if ("session" in target) return { kind: "dm" };
  if ("sessions" in target) return { kind: "multi", recipients };
  if ("rig" in target && !("pod" in target)) return { kind: "rig-broadcast", rig: target.rig, seats: recipients.length };
  if ("pod" in target) return { kind: "rig-broadcast", rig: target.rig ? `${target.rig}/${target.pod}` : target.pod, seats: recipients.length };
  return { kind: "topology" }; // { global: true }
}

export type TargetSpec =
  | { session: string }
  // OPR.0.4.3.30——显式多收件人列表（`zrig send --to a,b`）。通过 resolveByList 解析；
  // 每个名称都经过单名称 resolver，因此会针对准确席位诚实报告歧义/未找到。
  | { sessions: string[] }
  | { rig: string }
  | { pod: string; rig?: string }
  | { global: true };

export type ResolveResult =
  | { ok: true; sessions: Array<{ sessionName: string; rigName: string; nodeLogicalId: string }> }
  | { ok: false; code: "not_found" | "ambiguous"; error: string };

export interface SendOpts {
  /** 稳定的调用方请求 ID，传输结果不确定后用于回读。 */
  deliveryId?: string;
  auditPointer?: string;
  /** 内部队列接缝：已经提交的原始成员，绝不由客户端提供。 */
  committedOutboxIds?: string[];
  verify?: boolean;
  force?: boolean;
  waitForIdleMs?: number;
  // OPR.0.4.1.10——交互 prompt/权限守卫。`dangerouslyInteract` 是 prompt/权限守卫的唯一覆盖项；
  // force 不能绕过。它要求 `reason`，并在发送前写入可审计的 `transport.prompt_override` 记录；
  // `actorSession` 是该审计中记录的调用方身份。`--raw` 只是 CLI 侧 envelope 问题，后台服务守卫
  // 对 raw 与 wrapped 文本行为一致。
  dangerouslyInteract?: boolean;
  reason?: string;
  actorSession?: string | null;
  // GHOST-STAGE (h)：envelope 的组合时间戳（ISO），传给 send()，使写入时刻的投递延迟计算能测量
  // 消息等待时长。缺失时不生成 delivered segment。
  stampISO?: string;
  // Mechanics-gate 修复（desk 裁决 d9b3989a）：不输入文本，只按 Enter；用于重试已粘贴但目标 TUI
  // 未接收的文本。按构造安全：要求 `expectedStagedText`，且按 Enter 前 pane 必须实际包含它；
  // 在其他任何内容（例如权限 prompt）上裸按 Enter 都会以 staged_mismatch 拒绝。此模式下调用方
  // 的 `text` 参数必须为空。
  submitOnly?: boolean;
  expectedStagedText?: string;
  /** Round-2（r2 HIGH-1）：当前 walk piece 自身的行数，即 placeholder 身份。大段粘贴会渲染为
   * "[Pasted text #N +X lines]"；X 必须匹配此计数，该 placeholder 才能作为本 piece 的证据。 */
  expectedStagedLineCount?: number;
}

// OPR.0.4.3.30——fan-out 路径（`broadcast()`）的选项，是 SendOpts 的超集。设置
// `envelopeSender` 后，fan-out 会把每个收件人的文本分别包装进自身 From/To pane envelope，
// 与单发 CLI 通过 wrapPaneEnvelope 的包装逐字节一致，因此 multi/pod/rig 的 `zrig send` 会给每个
// 席位自己的 `To:` header。`zrig broadcast`（原始文本发给全部，保持不变）以及 CLI --raw /
// --dangerously-interact 路径中不设置该值。
export interface BroadcastOpts extends SendOpts {
  envelopeSender?: string;
  // stampISO（裁决 03c35295：发送时只计算一次的传输 ISO 时间戳，可为确定性测试注入）现位于基础
  // SendOpts；(h) send() 读取它计算投递延迟。
}

export interface SendResult {
  ok: boolean;
  sessionName: string;
  verified?: boolean;
  /**
   * OPR.99.0.6.3——诚实的投递结果词汇（增量添加；`verified` 对既有 parser 保持精确语义）。
   * 三种可区分状态，与恢复的诚实结果风格一致：
   * - `delivered`：文本与 Enter 均落地，且发送后 capture 再次确认 snippet；强阳性，原为
   *   `Verified: yes`。
   * - `rendered-unconfirmed`：文本与 Enter 均成功，消息已落地，但发送后 capture 与 TUI 重绘竞态，
   *   无法再次确认 snippet。它是“已落地但无法确认”，不是失败；必要时用 `zrig capture` 确认。
   *   此前被折叠进 `Verified: no`。
   * - `failed`：传输本身失败，粘贴或 Enter 未落地。为词汇对称，在 send_failed / submit_failed
   *   返回上设置；其 `ok:false` 与 HTTP 映射不变。
   */
  outcome?: "delivered" | "rendered-unconfirmed" | "failed" | "retained";
  outboxIds?: string[];
  warning?: string;
  error?: string;
  reason?: string;
  /** submit-only（裸 Enter）模式成功时设置；没有输入文本。 */
  submitOnly?: boolean;
  activity?: AgentActivity;
  waitedMs?: number;
  attempts?: number;
  sent?: boolean;
}

export interface CaptureResult {
  ok: boolean;
  sessionName: string;
  content?: string;
  lines?: number;
  error?: string;
  reason?: string;
}

export interface BroadcastResult {
  total: number;
  sent: number;
  retained?: number;
  failed: number;
  results: SendResult[];
}

interface SessionTransportDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  agentActivityStore?: AgentActivityStore;
  // OPR.0.4.1.10——仅 --dangerously-interact 审计路径需要。缺失时危险覆盖会失败关闭并拒绝，
  // 而不是未经审计就发送；非危险发送不需要。
  eventBus?: EventBus;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  waitForIdlePollMs?: number;
  // OPR.0.4.1.10——send-readiness 新鲜度覆盖值，默认 SEND_READINESS_FRESHNESS_MS；测试接缝。
  sendReadinessFreshnessMs?: number;
  slowOpRecorder?: SlowOperationInstrumentation;
  activityEndpointFile?: () => { baseUrl: string; token: string } | null;
  /** S01/S02 P2：可选的只读 capture observer；默认缺失，不激活。 */
  captureObserver?: CaptureObserverSink;
}

interface SessionRow { node_id: string; session_name: string; }
interface NodeRow { rig_id: string; logical_id: string; }
interface SessionMetaRow { runtime: string | null; attachment_type: string | null; node_id: string | null; binding_session: string | null; pane: string | null; occupant: string | null; }
interface ResolvedTarget { sessionName: string; rigName: string; nodeLogicalId: string; }

export class SessionTransport {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;
  private agentActivityStore?: AgentActivityStore;
  private eventBus?: EventBus;
  private now: () => Date;
  private sleep: (ms: number) => Promise<void>;
  private waitForIdlePollMs: number;
  private sendReadinessFreshnessMs: number;
  private slowOpRecorder?: SlowOperationInstrumentation;
  private activityEndpointFile: () => { baseUrl: string; token: string } | null;
  private captureObserver?: CaptureObserverSink;

  constructor(deps: SessionTransportDeps) {
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.agentActivityStore = deps.agentActivityStore;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? delay;
    this.waitForIdlePollMs = deps.waitForIdlePollMs ?? 500;
    this.sendReadinessFreshnessMs = deps.sendReadinessFreshnessMs ?? SEND_READINESS_FRESHNESS_MS;
    this.slowOpRecorder = deps.slowOpRecorder;
    this.activityEndpointFile = deps.activityEndpointFile ?? (() => null);
    this.captureObserver = deps.captureObserver;
  }

  /**
   * Slice-05 D5/D6——当实时传输操作（send/capture）观测到席位 tmux 会话确实消失
   *（`probeSession` 返回 `absent`，这是明确 tmux 证据而非传输失败；OPR.0.5.4.2 mini-req 5），
   * 持久记录与 reconciler 相同的 `session_missing` 身份判定，使 `zrig ps` 无需等待下次
   * reconciler 轮询就不再把死亡席位报告为 running。这是共享判定桥的传输侧 writer；
   * reconciler 是轮询侧 writer。传输缺失绝不能进入本方法，否则针对存活席位的一次抖动会虚构
   * 持久缺失判定。
   *
   * 只写适用判定：join 收窄到最新 running session_name 等于被探测会话的节点，从而满足
   * `verdict.sessionName === latest session_name` 这一 node-inventory 适用门禁；并且仅当已登记
   * binding pane 时写入。null pane 属于 reconciler 的 `tmux_unavailable` 情况，不会降低等级；
   * 没有 pane 时绝不虚构 `session_missing`。永不修改 `sessions.status`。
   */
  private recordSessionMissingVerdict(sessionName: string): void {
    const seat = this.db
      .prepare(`
        SELECT n.id AS node_id, s.session_name AS session_name, b.tmux_pane AS tmux_pane
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.status = 'running'
          AND s.session_name = ?
        LIMIT 1
      `)
      .get(sessionName) as { node_id: string; session_name: string; tmux_pane: string | null } | undefined;
    if (!seat || seat.tmux_pane === null) return;
    new SeatIdentityStore(this.db).upsert({
      nodeId: seat.node_id,
      verdict: "pane_missing",
      evidenceSource: "tmux_session",
      reason: "session_missing",
      evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: seat.session_name,
      observedAt: this.now().toISOString(),
    });
  }

  private getSessionMeta(sessionName: string): {
    runtime: string | null; attachmentType: string | null; nodeId: string | null; pane: string | null; occupant: string | null;
  } {
    // 复用现有一条语句；P2 读取其已 join 的 binding 列和 delivery guard 使用的同一
    // current-occupant 子查询，不增加查询。
    const row = this.db.prepare(`
      SELECT
        n.runtime AS runtime,
        b.attachment_type AS attachment_type,
        n.id AS node_id,
        b.tmux_session AS binding_session,
        b.tmux_pane AS pane,
        (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id = n.id ORDER BY generation_ordinal DESC LIMIT 1) AS occupant
      FROM sessions s
      JOIN nodes n ON s.node_id = n.id
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(sessionName) as SessionMetaRow | undefined;

    return {
      runtime: row?.runtime ?? null,
      attachmentType: row?.attachment_type ?? null,
      nodeId: row?.node_id ?? null,
      // 该行可能是如今已绑定到其他位置的节点历史会话；只有 session 正是此名称的 binding
      // 才能标记 pane/occupant，否则为 unknown。
      pane: row?.binding_session === sessionName ? row?.pane ?? null : null,
      occupant: row?.binding_session === sessionName ? row?.occupant ?? null : null,
    };
  }

  async resolveSessions(target: TargetSpec): Promise<ResolveResult> {
    if ("session" in target) {
      return this.resolveBySessionName(target.session);
    }
    if ("sessions" in target) {
      return this.resolveByList(target.sessions);
    }
    if ("pod" in target) {
      return this.resolveByPod(target.pod, target.rig);
    }
    if ("global" in target) {
      return this.resolveGlobal();
    }
    return this.resolveByRig(target.rig);
  }

  private resolveGlobal(): ResolveResult {
    const allRigs = this.rigRepo.listRigs();
    if (allRigs.length === 0) {
      return { ok: false, code: "not_found", error: "未找到工作组。请用 zrig ps 检查状态" };
    }
    const sessions: ResolvedTarget[] = [];
    const seenRigIds = new Set<string>();
    for (const rig of allRigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);
      sessions.push(...this.collectTransportTargetsForRig(rig.id, rig.name));
    }
    if (sessions.length === 0) {
      return { ok: false, code: "not_found", error: "未找到运行中的会话。请用 zrig ps 检查状态" };
    }
    return { ok: true, sessions };
  }

  private resolveBySessionName(sessionName: string): ResolveResult {
    const sessionRows = this.db
      .prepare("SELECT node_id, session_name FROM sessions WHERE session_name = ? ORDER BY id DESC")
      .all(sessionName) as SessionRow[];

    if (sessionRows.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `未找到会话 '${sessionName}'。请用 zrig ps --nodes 检查会话名`,
      };
    }

    // 检查歧义：不同工作组中出现相同会话名。
    const rigNames = new Map<string, { nodeLogicalId: string }>();
    for (const row of sessionRows) {
      const nodeRow = this.db
        .prepare("SELECT rig_id, logical_id FROM nodes WHERE id = ?")
        .get(row.node_id) as NodeRow | undefined;
      if (nodeRow) {
        const rig = this.rigRepo.getRig(nodeRow.rig_id);
        if (rig) {
          rigNames.set(rig.rig.name, { nodeLogicalId: nodeRow.logical_id });
        }
      }
    }

    if (rigNames.size === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `未找到会话 '${sessionName}'。请用 zrig ps --nodes 检查会话名`,
      };
    }

    if (rigNames.size > 1) {
      const names = Array.from(rigNames.keys()).join(", ");
      return {
        ok: false,
        code: "ambiguous",
        error: `会话 '${sessionName}' 有歧义——在这些工作组中均存在：${names}。请显式指定工作组。`,
      };
    }

    const [rigName, meta] = Array.from(rigNames.entries())[0]!;
    return {
      ok: true,
      sessions: [{ sessionName, rigName, nodeLogicalId: meta.nodeLogicalId }],
    };
  }

  // OPR.0.4.3.30——为多收件人 `zrig send` 解析显式具名席位列表。每个名称都经过单名称 resolver，
  // 使未找到/有歧义席位能针对准确名称诚实报告，并与单发语义一致；整个命令会被拒绝，而不是静默
  // 丢掉拼错的席位。重复名称会去重，因此 `--to a,a` 只投递一次。逐收件人 guard 独立性属于
  // send() 时的问题，不属于解析；某个 guard 拒绝会成为 fan-out 结果中的一条 ok:false，绝不中止全局。
  private resolveByList(sessionNames: string[]): ResolveResult {
    const sessions: ResolvedTarget[] = [];
    const seen = new Set<string>();
    for (const name of sessionNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      const resolved = this.resolveBySessionName(name);
      if (!resolved.ok) return resolved;
      sessions.push(...resolved.sessions);
    }
    if (sessions.length === 0) {
      return { ok: false, code: "not_found", error: "未提供目标会话。" };
    }
    return { ok: true, sessions };
  }

  private resolveByRig(rigName: string): ResolveResult {
    const rigs = this.rigRepo.findRigsByName(rigName);
    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `未找到名为 '${rigName}' 的工作组。请用 zrig ps 检查可用工作组`,
      };
    }

    const sessions: ResolvedTarget[] = [];
    for (const rig of rigs) {
      sessions.push(...this.collectTransportTargetsForRig(rig.id, rig.name));
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `工作组 '${rigName}' 中没有运行中的会话。请用 zrig ps 检查工作组状态`,
      };
    }

    return { ok: true, sessions };
  }

  private resolveByPod(podName: string, rigName?: string): ResolveResult {
    // 获取要搜索的工作组。
    const rigs = rigName
      ? this.rigRepo.findRigsByName(rigName)
      : this.rigRepo.listRigs();

    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: rigName
          ? `未找到名为 '${rigName}' 的工作组。请用 zrig ps 检查可用工作组`
          : `未找到工作组。请用 zrig ps 检查状态`,
      };
    }

    // 收集所有匹配工作组中的运行会话，并按工作组 ID 去重。
    const sessions: ResolvedTarget[] = [];
    const seenRigIds = new Set<string>();
    for (const rig of rigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);

      for (const target of this.collectTransportTargetsForRig(rig.id, rig.name)) {
        const podPart = target.nodeLogicalId.split(".")[0];
        if (podPart === podName) {
          sessions.push(target);
        }
      }
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `pod '${podName}'${rigName ? `（工作组 '${rigName}'）` : ""} 中没有运行中的会话。请用 zrig ps --nodes 检查可用 pod`,
      };
    }

    return { ok: true, sessions };
  }

  private collectTransportTargetsForRig(rigId: string, rigName: string): ResolvedTarget[] {
    const rigSessions = this.sessionRegistry.getSessionsForRig(rigId);
    const latestByNode = new Map<string, typeof rigSessions[0]>();
    for (const session of rigSessions) {
      const existing = latestByNode.get(session.nodeId);
      if (!existing || session.id > existing.id) {
        latestByNode.set(session.nodeId, session);
      }
    }

    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return [];

    const targets: ResolvedTarget[] = [];
    for (const node of rig.nodes) {
      const binding = this.sessionRegistry.getBindingForNode(node.id);
      const latestSession = latestByNode.get(node.id);

      if (binding?.attachmentType === "external_cli" && binding.externalSessionName) {
        targets.push({
          sessionName: binding.externalSessionName,
          rigName,
          nodeLogicalId: node.logicalId,
        });
        continue;
      }

      if (latestSession?.status === "running" && binding?.tmuxSession) {
        targets.push({
          sessionName: binding.tmuxSession,
          rigName,
          nodeLogicalId: node.logicalId,
        });
      }
    }

    return targets;
  }

  deliveryTarget(sessionName: string) { return this.tmuxAdapter.deliveryGuard?.maybeTarget(sessionName) ?? null; }

  get deliveryGuard() { return this.tmuxAdapter.deliveryGuard; }

  retentionTarget(sessionName: string) {
    const guard = this.tmuxAdapter.deliveryGuard;
    const target = guard?.maybeTarget(sessionName);
    if (!guard || !target) return null;
    const pref = guard.preference(target.nodeId);
    return pref.desired || pref.effective ? target : null;
  }

  async send(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    const guard = this.tmuxAdapter.deliveryGuard;
    if (!guard) return this.sendUnguarded(sessionName, text, opts);
    const outbox = new OutboxHandler(this.db);
    const ids = opts?.committedOutboxIds ?? [opts?.deliveryId ?? `guard-send-${randomUUID()}`];
    const retainedResult = (): SendResult => ({ ok: true, sessionName, outcome: "retained", sent: false, verified: false,
      outboxIds: ids, reason: "typing_guard_enabled", warning: `已保留，未投递。请用 zrig seat held-messages ${sessionName} 检查；禁用守卫不会重放已保留消息。` });
    try {
      if (opts?.committedOutboxIds) {
        const target = guard.target(sessionName);
        for (const id of opts.committedOutboxIds) {
          const entry = outbox.getById(id);
          if (!entry || entry.destinationSession !== sessionName) throw new Error("已提交 wake 的目标/ID 不匹配");
          if (entry.guardBinding && JSON.stringify(entry.guardBinding) !== JSON.stringify(target)) {
            return { ok: false, sessionName, sent: false, reason: "guard_target_changed", error: "已提交 wake 的收件人身份发生变化；未写入任何输入。" };
          }
        }
      }
      // 禁用后仍支持幂等回读：旧的 retained ID 永远不会变成新发送。
      // P2：本次回读不是新的 retention，位于 retained_no_write 接缝之外。
      if (!opts?.committedOutboxIds && opts?.deliveryId) {
        const prior = outbox.getById(opts.deliveryId);
        if (prior?.guardBinding) {
          if (prior.body !== text || prior.destinationSession !== sessionName || prior.senderSession !== (opts.actorSession ?? "unknown")) {
            return { ok: false, sessionName, sent: false, reason: "delivery_identity_conflict", error: "Delivery ID 指向了不同内容/身份。" };
          }
          if (prior.deliveryState === "retained" || prior.deliveryState === "retired") return retainedResult();
        }
      }
      return await guard.operation(sessionName, () => this.sendUnguarded(sessionName, text, opts), async target => {
        if (opts?.submitOnly) return { ok: false, sessionName, sent: false, reason: "typing_guard_enabled", error: "输入守卫阻止 submit-only；未发送 Enter。" };
        this.db.transaction(() => {
          for (const id of ids) {
            const prior = opts?.committedOutboxIds ? outbox.getById(id) : null;
            if (opts?.committedOutboxIds && (!prior || prior.destinationSession !== sessionName)) throw new Error("已提交 wake 的目标/ID 不匹配");
            outbox.retain(prior ? { ...prior, outboxId: id, tags: prior.tags ?? undefined, auditPointer: prior.auditPointer ?? undefined } : {
              outboxId: id, senderSession: opts?.actorSession ?? "unknown", destinationSession: sessionName, body: text, auditPointer: opts?.auditPointer,
            }, target, !!opts?.committedOutboxIds);
          }
        })();
        // P2：只有上方 retention 提交后才观测；submit-only 拒绝或 retention 失败不会到达此处。
        // 这绝不是投递证据。
        if (this.captureObserver) {
          safeRecord(this.captureObserver, {
            seam: "retained_no_write",
            attemptId: randomUUID(),
            binding: { sessionName, nodeId: target.nodeId, occupant: target.occupant, pane: target.pane },
            runtime: null,
            sentHash: hashSentText(text),
            pre: { state: "not_requested" },
            post: { state: "not_requested" },
            regexResult: { outcome: "retained", reason: "typing_guard_enabled" },
            completedAt: this.now().toISOString(),
          });
        }
        return retainedResult();
      });
    } catch (error) {
      return { ok: false, sessionName, sent: false, reason: (error as { code?: string }).code ?? "guard_unavailable", error: (error as Error).message };
    }
  }

  private async sendUnguarded(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    let preVerifyContent: string | null = null;
    const sessionMeta = this.getSessionMeta(sessionName);
    const runtime = sessionMeta.runtime;
    // S01/S02 P2 观测上下文，在 attempt 入口处、第一个 await 前冻结。
    const observed = this.captureObserver ? {
      attemptId: randomUUID(),
      binding: Object.freeze({ sessionName, nodeId: sessionMeta.nodeId, occupant: sessionMeta.occupant, pane: sessionMeta.pane }),
      pre: (opts?.verify ? { state: "not_reached" } : { state: "not_requested" }) as CaptureSlot,
      post: (opts?.verify ? { state: "not_reached" } : { state: "not_requested" }) as CaptureSlot,
      sentHash: null as string | null,
    } : null;
    const observe = (result: SendResult): SendResult => {
      if (observed && this.captureObserver) {
        safeRecord(this.captureObserver, {
          seam: "send_verify",
          attemptId: observed.attemptId,
          binding: observed.binding,
          runtime,
          sentHash: observed.sentHash,
          pre: observed.pre,
          post: observed.post,
          regexResult: pickDefined(result, ["ok", "outcome", "verified", "reason"]),
          completedAt: this.now().toISOString(),
        });
      }
      return result;
    };
    const waitForIdleMs = opts?.waitForIdleMs;
    const waitMode = waitForIdleMs !== undefined;
    let waitEvidence: Pick<SendResult, "activity" | "waitedMs" | "attempts"> = {};

    if (sessionMeta.attachmentType === "external_cli") {
      return {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `会话 '${sessionName}' 作为 external CLI 节点挂载；该目标无法使用入站 tmux 传输。`,
      };
    }

    if (waitForIdleMs !== undefined) {
      if (opts?.force) {
        return {
          ok: false,
          sessionName,
          reason: "invalid_wait_for_idle",
          error: "--wait-for-idle 不能与 force 组合；未发送任何文本。",
          sent: false,
        };
      }
      if (!Number.isFinite(waitForIdleMs) || waitForIdleMs <= 0) {
        return {
          ok: false,
          sessionName,
          reason: "invalid_wait_for_idle",
          error: "waitForIdleMs 必须是正数；未发送任何文本。",
          sent: false,
        };
      }
    }

    // 1. 通过分类探针解析会话（OPR.0.5.4.2）：传输抖动绝不能读成死亡席位；
    // 只有明确 tmux 证据才能断言缺失。
    try {
      const probe = await this.tmuxAdapter.probeSession(sessionName);
      if (probe.state === "absent") {
        this.recordSessionMissingVerdict(sessionName);
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `未找到会话 '${sessionName}'：tmux 报告不存在该名称的会话。未发送任何文本。请用 zrig ps --nodes 检查可用会话`,
        };
      }
      if (probe.state === "transport_unavailable") {
        return {
          ok: false,
          sessionName,
          reason: "tmux_unavailable",
          error: `无法连接 tmux server（${probe.cause}）。未能确定会话 '${sessionName}' 是否存在；未发送任何文本。`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: `tmux 会话探针意外失败（${err instanceof Error ? err.message : String(err)}）。未能确定会话 '${sessionName}' 是否存在；未发送任何文本。`,
      };
    }

    // SUBMIT-ONLY（mechanics-gate 修复，desk 裁决 d9b3989a）：对 staged 文本只重试一次 Enter。
    // 不输入任何内容；先验证 pane 确实持有预期 staged 文本，因此裸 Enter 绝不会落在其他内容上
    //（权限 prompt 或他人输入）。
    if (opts?.submitOnly) {
      if (text.length > 0) {
        return { ok: false, sessionName, reason: "invalid_submit_only", error: "submitOnly 不发送文本，因此 text 参数必须为空。" };
      }
      const expected = opts.expectedStagedText ?? "";
      if (expected.trim().length === 0) {
        return { ok: false, sessionName, reason: "invalid_submit_only", error: "submitOnly 需要 expectedStagedText；只有精确 staged 内容上才会按 Enter。" };
      }
      const norm = (s: string) => s.replace(/\s+/g, "");
      const pane = await this.runStage(
        "session_transport.submit_only_precheck",
        () => this.tmuxAdapter.capturePaneContent(sessionName, 50),
      );
      // Round-2（r2 HIGH-1）：证据必须是当前活动输入，并能识别本 piece。陈旧 scrollback 可能含旧
      // placeholder，而之后的交互 prompt 已拥有输入；此时按 Enter 会批准 prompt。因此：
      //   1. 只有 pane 最后一个 input-marker 行有效；它是当前输入，上方全部属于历史。
      //   2. 编号选项行（`❯ 1. …`）属于 prompt selection，绝非 staged input，必须拒绝。
      //   3. 粘贴文本 placeholder 按身份限定："[Pasted text #N +X lines]" 只有在 X 匹配预期
      //      piece 自身行数时才算证据；尾随换行允许 ±1。多个 placeholder 表示多个 piece 合并 staged，
      //      一次 Enter 不安全，必须拒绝。
      //   4. 否则该行必须包含内容自身开头的 24 个归一化字符；短粘贴会内联渲染，可能被截断。
      const paneLines = (pane ?? "").split("\n");
      let currentInputAt = -1;
      for (let i = paneLines.length - 1; i >= 0; i--) {
        if (paneLines[i]!.trimStart().startsWith("❯")) { currentInputAt = i; break; }
      }
      let stagedEvidence = false;
      if (currentInputAt >= 0) {
        const inputLine = paneLines[currentInputAt]!.trimStart();
        // 区域从最后一个 ❯ 行延伸到输入框闭合分隔线（box-drawing 行）或 pane 末尾；换行输入在
        // marker 下继续，上方全部是历史，分隔线下全部是 hint-bar chrome。
        let regionEnd = paneLines.length;
        for (let i = currentInputAt + 1; i < paneLines.length; i++) {
          const t = paneLines[i]!.trim();
          if (t.length >= 10 && /^[─═-]+$/.test(t)) { regionEnd = i; break; }
        }
        const region = paneLines.slice(currentInputAt, regionEnd).join("\n");
        if (!/^❯\s*\d+\./.test(inputLine)) {
          // Round-3（r2 R2 HIGH-1，样本固定）：Claude 会把一个 staged piece 渲染为多个 placeholder，
          // 其中显示的计数是 segment 大小（总和 ≤ 来源行数），后面跟 piece 自身逐行换行的字面尾部；
          // placeholder token 自身也会换行。因此先折叠换行，再检查：
          //   身份——字面残余（区域减去 token 和 hint chrome）必须是 piece 的连续子串；可见文字必须来自
          //          该 piece。外部残余（另一个 piece 或陈旧内容）应拒绝。
          //   合理性——segment 计数总和不得超过 piece 自身行数（允许少量余量）；没有残余锚点时，
          //            必须至少达到其 60%，避免无关的裸 placeholder 冒充本 piece。
          const placeholderRe = /\[Pasted text #\d+ \+(\d+) lines\]/g;
          const regionFlat = region.replace(/\s+/g, " ");
          const counts = [...regionFlat.matchAll(placeholderRe)].map((m) => Number(m[1]));
          if (counts.length === 0) {
            const head = norm(expected).slice(0, 24);
            stagedEvidence = head.length > 0 && norm(region).includes(head);
          } else {
            // Round-4（r2 R3 HIGH-1）：身份来自渲染自身结构，已有样本证明。placeholder 是 piece 的
            // 头部 chunk，字面残余是 piece 的归一化后缀（保留 capture 中为 524 字符）。大小相似或共享
            // 短语不构成身份：无残余、归一化后不足 48 字符，或不是 piece 自身后缀时，都失败关闭；
            // TUI 未暴露足够内容来识别 staged 状态，绝不猜测裸 Enter。
            const chrome = /paste again to expand|ctrl\+g to edit( in Vim)?/gi;
            const residual = norm(regionFlat.replace(placeholderRe, "").replace(chrome, "")).replace(/^❯/, "");
            const pieceNorm = norm(expected);
            const sum = counts.reduce((a, b) => a + b, 0);
            // Round-5（r2 R4 HIGH-1）：后缀锚点与不透明前缀关联。placeholder 总和标识可见后缀前
            // 隐藏的来源边界（样本中总和 130，表示残余恰从 piece 142 个来源换行中的第 130 个后开始）。
            // 从 piece 字节计算该边界，即归一化文本未被残余覆盖的前导来源行数，并要求总和精确相等
            //（round-6，r2 R5：两个分别 staged 的保留 piece 都精确满足 130=130、82=82；渲染证据
            // 不支持容差）。后缀匹配但总和不匹配表示前缀被截断或错误，必须拒绝。
            let boundary = -1;
            if (residual.length >= 48 && pieceNorm.endsWith(residual)) {
              const srcLines = expected.split("\n");
              let acc = 0;
              boundary = 0;
              for (let i = srcLines.length - 1; i >= 0; i--) {
                acc += norm(srcLines[i]!).length;
                if (acc >= residual.length) { boundary = i; break; }
              }
            }
            stagedEvidence = boundary >= 0 && sum === boundary;
          }
        }
      }
      if (!stagedEvidence) {
        return {
          ok: false,
          sessionName,
          reason: "staged_mismatch",
          error: `submitOnly 已拒绝：会话 '${sessionName}' 的 pane 未显示预期 staged 文本；此处按 Enter 可能驱动完全不同的内容。未提交任何内容。`,
        };
      }
      const submitResult = await this.runStage(
        "session_transport.submit",
        () => this.tmuxAdapter.sendKeys(sessionName, ["C-m"]),
        (result) => result.ok ? "ok" : "failed",
      );
      if (!submitResult.ok) {
        return { ok: false, sessionName, reason: "submit_failed", outcome: "failed", error: `submitOnly：Enter 未落到 '${sessionName}'：${submitResult.message}` };
      }
      return { ok: true, sessionName, outcome: "rendered-unconfirmed", submitOnly: true };
    }

    if (waitForIdleMs !== undefined) {
      const waitResult = await this.waitForIdle({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
        timeoutMs: waitForIdleMs,
        binding: observed?.binding,
      });
      waitEvidence = {
        activity: waitResult.activity,
        waitedMs: waitResult.waitedMs,
        attempts: waitResult.attempts,
      };
      if (!waitResult.ok) {
        return {
          ok: false,
          sessionName,
          reason: waitResult.reason,
          error: waitResult.error,
          sent: false,
          ...waitEvidence,
        };
      }
    }

    // 2. OPR.0.4.1.10——默认路径上的健壮 prompt/权限 + 工作中守卫。运行此前只能经
    // --wait-for-idle 访问的同一 detector：send-readiness 窗口内优先使用新鲜 runtime hook，
    // 再以加强后的 capture-pane 回退。它关闭 zrig send 的 prompt 注入误操作：默认情况下，消息绝不
    // 选择/提交/批准另一个智能体的 prompt。OPR.0.4.3.28 修正及后续：只有明确 picker/批准证据
    //（needs_input）才失败关闭（拒绝，或使用已审计的 --dangerously-interact 覆盖）。其他状态均携带
    // 非阻断提示继续发送：UNKNOWN（遥测缺失/陈旧/失败）与 RUNNING（工作中/繁忙）都发送并提示；
    // 繁忙/不确定无权阻断通信。--force 现为本路径 no-op（为向后兼容保留），且永不绕过明确 picker
    // 守卫（FR-4，误操作隔离）。提示通过成功结果的 `warning` 携带，以呈现诚实遥测。
    let sendAdvisory: string | undefined;
    if (waitForIdleMs === undefined) {
      const readiness = await this.classifySendReadiness({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
        binding: observed?.binding,
      });

      // 单状态分派（B1 code-review 修复）：展平逻辑，使 `unknown` 无论是否传入
      // --dangerously-interact 都始终附带提示；主动覆盖分支不再绕过 unknown 处理。
      if (readiness.state === "needs_input") {
        // 明确 picker/批准误操作。--dangerously-interact 是主动且已审计的覆盖：必须提供 reason，
        // 并在发送前持久化可审计记录；无法审计时失败关闭，未经审计的覆盖绝不发送。否则拒绝并提供
        // 继续路径。这是 --dangerously-interact 唯一可绕过的状态。
        if (opts?.dangerouslyInteract) {
          if (!opts.reason || opts.reason.trim().length === 0) {
            return {
              ok: false,
              sessionName,
              reason: "dangerously_interact_requires_reason",
              error: "--dangerously-interact 需要 --reason 说明为何驱动 prompt；未发送任何文本。",
            };
          }
          const audit = this.recordPromptOverride({
            sessionName,
            readiness,
            actorSession: opts.actorSession ?? null,
            overrideReason: opts.reason,
          });
          if (!audit.ok) {
            return {
              ok: false,
              sessionName,
              reason: "prompt_override_audit_unavailable",
              activity: readiness,
              error: `已拒绝：--dangerously-interact 需要可审计的覆盖记录，但无法持久化（${audit.reason}）。未发送任何文本。`,
            };
          }
          // 审计成功，继续发送。
        } else {
          return {
            ok: false,
            sessionName,
            reason: "target_needs_input",
            activity: readiness,
            error: `已拒绝：'${sessionName}' 正处于交互 prompt（${readiness.reason}）。消息不得选择或批准它。若要主动驱动 prompt，请运行：zrig send ${sessionName} "<text>" --dangerously-interact --reason "<why>"。未发送任何文本。`,
          };
        }
      } else if (readiness.state === "unknown") {
        // OPR.0.4.3.28 修正——反转 unknown 时失败关闭的默认行为。遥测缺失/陈旧/失败不属于明确
        // picker 证据，因此继续发送。诊断 producer 链并作为非阻断提示携带，即成功结果上的 `warning`；
        // 无论是否传入 --dangerously-interact 都如此（B1 code-review 修复）。这样既呈现诚实遥测，
        // 又不阻断通信。Hook 是提示性遥测，无权决定智能体能否交流。
        const linkDiagnosis = await this.diagnoseProducerLink(sessionName);
        sendAdvisory = `producer-link：${linkDiagnosis}——无法确定活动状态（${readiness.reason}）；仍已发送（遥测仅作提示）。`;
        // 继续执行下方发送。
      } else if (readiness.state === "running") {
        // OPR.0.4.3.28 后续修正（advisor 审计发现，PM 裁定为创始人原则残留）：busy 不是阻断。
        // 将旧 mid_work 硬拒绝降级为非阻断提示，附在成功结果上并继续，与 unknown 反转一致。
        // --force 在此为 no-op，仅为向后兼容保留。needs_input（明确 picker）仍是唯一硬拒绝；
        // unknown/stale/missing 已在上方携带提示继续。
        sendAdvisory = `目标 pane 看起来正在任务中；仍已发送（繁忙只是提示，不是阻断）。`;
        // 继续执行下方发送。
      }
      // idle（或现在采用提示后继续的 running/unknown）→ 继续发送。
    }

    if (opts?.verify) {
      const captureSeq = observed ? nextCaptureSeq++ : 0;
      try {
        preVerifyContent = await this.runStage(
          "session_transport.pre_capture",
          () => this.tmuxAdapter.capturePaneContent(sessionName, 30),
        );
        if (observed) observed.pre = captureSlot(preVerifyContent, this.now().toISOString(), captureSeq);
      } catch {
        preVerifyContent = null;
        if (observed) observed.pre = { state: "unavailable", cause: "capture_error", capturedAt: this.now().toISOString(), captureSeq };
      }
    }

    // GHOST-STAGE (h)：delivered-at 延迟。在写入时刻（任何 idle 等待之后）记录消息自组合
    //（opts.stampISO）起等待了多久。appendDeliveredSegment 只标记真正延迟的投递（≥ 10 秒），
    // 用于 delayed-lifecycle-message 取证；对低于阈值的间隔或无 envelope 发送为 no-op。
    // sent ISO + 渲染出的 delta = 绝对投递时间。
    if (opts?.stampISO) {
      text = appendDeliveredSegment(text, this.now().getTime() - Date.parse(opts.stampISO));
    }

    // 3. 发送文本（粘贴）。
    if (observed) observed.sentHash = hashSentText(text);
    const textResult = await this.runStage(
      "session_transport.send_text",
      () => this.tmuxAdapter.sendText(sessionName, text),
      (result) => result.ok ? "ok" : "failed",
    );
    if (!textResult.ok) {
      return observe({
        ok: false,
        sessionName,
        reason: "send_failed",
        outcome: "failed",
        error: `向 '${sessionName}' 发送文本失败：${textResult.message}`,
        ...(waitMode ? { sent: false, ...waitEvidence } : {}),
      });
    }

    // 4. 等待 200ms（spike 已验证的延迟）。
    await this.sleep(200);

    // 5. 提交（C-m）。
    const submitResult = await this.runStage(
      "session_transport.submit",
      () => this.tmuxAdapter.sendKeys(sessionName, ["C-m"]),
      (result) => result.ok ? "ok" : "failed",
    );
    if (!submitResult.ok) {
      return observe({
        ok: false,
        sessionName,
        reason: "submit_failed",
        outcome: "failed",
        error: `文本已显示在 '${sessionName}' 中，但未提交（Enter 失败）。该智能体可能需要人工处理。`,
        ...(waitMode ? { sent: true, ...waitEvidence } : {}),
      });
    }

    // 6. 按需验证。此时文本与 Enter 均成功，消息已经落地；capture 只用于再次确认渲染。
    // 未能再次确认（TUI 重绘竞态或 capture 抛错）因此是诚实的中间结果
    // `rendered-unconfirmed`，绝不是失败（OPR.99.0.6.3）。
    if (opts?.verify) {
      await this.sleep(500);
      const captureSeq = observed ? nextCaptureSeq++ : 0;
      try {
        const content = await this.runStage(
          "session_transport.post_capture",
          () => this.tmuxAdapter.capturePaneContent(sessionName, 30),
        );
        if (observed) observed.post = captureSlot(content, this.now().toISOString(), captureSeq);
        const snippet = text.substring(0, Math.min(text.length, 40));
        const preCount = countOccurrences(preVerifyContent ?? "", snippet);
        const postCount = countOccurrences(content ?? "", snippet);
        const verified = postCount > preCount;
        return observe({ ok: true, sessionName, verified, outcome: verified ? "delivered" : "rendered-unconfirmed", ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) });
      } catch {
        if (observed && observed.post.state === "not_reached") {
          observed.post = { state: "unavailable", cause: "capture_error", capturedAt: this.now().toISOString(), captureSeq };
        }
        return observe({ ok: true, sessionName, verified: false, outcome: "rendered-unconfirmed", ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) });
      }
    }

    return observe({ ok: true, sessionName, ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) });
  }

  private runStage<T>(
    site: string,
    fn: () => Promise<T>,
    classify?: (value: T) => "ok" | "failed",
  ): Promise<T> {
    return this.slowOpRecorder?.runStage
      ? this.slowOpRecorder.runStage(site, fn, classify)
      : fn();
  }

  private async waitForIdle(input: {
    sessionName: string;
    runtime: string | null;
    attachmentType: string | null;
    timeoutMs: number;
    binding?: ObservedBinding;
  }): Promise<
    | { ok: true; activity: AgentActivity; waitedMs: number; attempts: number }
    | { ok: false; reason: string; error: string; activity: AgentActivity; waitedMs: number; attempts: number }
  > {
    const startedAt = Date.now();
    let attempts = 0;

    while (true) {
      attempts++;
      const activity = await this.classifySendReadiness(input);
      const waitedMs = Date.now() - startedAt;

      if (activity.state === "idle") {
        return { ok: true, activity, waitedMs, attempts };
      }

      if (activity.state === "needs_input") {
        return {
          ok: false,
          reason: "target_needs_input",
          error: `目标需要处理（${activity.reason}）。未发送任何文本。`,
          activity,
          waitedMs,
          attempts,
        };
      }

      if (activity.state === "unknown") {
        return {
          ok: false,
          reason: "target_activity_unknown",
          error: `无法确定目标活动状态（${activity.reason}）。未发送任何文本。`,
          activity,
          waitedMs,
          attempts,
        };
      }

      if (waitedMs >= input.timeoutMs) {
        return {
          ok: false,
          reason: "wait_for_idle_timeout",
          error: `目标持续繁忙 ${waitedMs}ms。未发送任何文本。`,
          activity,
          waitedMs,
          attempts,
        };
      }

      const remainingMs = input.timeoutMs - waitedMs;
      await this.sleep(Math.min(this.waitForIdlePollMs, Math.max(1, remainingMs)));
    }
  }

  private async classifySendReadiness(input: {
    sessionName: string;
    runtime: string | null;
    attachmentType: string | null;
    binding?: ObservedBinding;
  }): Promise<AgentActivity> {
    const now = this.now();
    const hookActivity = this.agentActivityStore?.getLatestForNode({
      sessionName: input.sessionName,
      now,
    });
    // 仅在严格 send-readiness 窗口内把新鲜 runtime hook 视为权威信号。超出该窗口后，即使仍在更宽松
    // 的展示新鲜度内，hook 也太旧，无法证明“现在发送安全”；应回退到实时 capture-pane 探针，
    // 这也是 Codex 的唯一守卫。
    if (
      hookActivity &&
      hookActivity.evidenceSource === "runtime_hook" &&
      hookActivity.stale !== true
    ) {
      // 新鲜 hook（15 秒发送窗口内）对任意状态都具有权威性。
      if (this.hookFreshForSend(hookActivity, now)) {
        return hookActivity;
      }
      // OPR.0.4.3.28 Part A——陈旧但最新的 `idle` hook（超过 15 秒发送窗口，但仍在 5 分钟 store
      // 窗口内，因此 stale!==true）可以发送。getLatestForNode 按 seq 只返回最新事件，所以最新 hook
      // 仍为 `idle` 证明没有更新活动；若席位开始工作，最新 hook 应为 UserPromptSubmit/PermissionRequest。
      // 陈旧的非 idle hook（running/needs_input 超过 15 秒）仍回退到下方 pane 探针。不扩大 15 秒窗口；
      // 只适用于 stale!==true，使真正废弃超过 5 分钟的席位仍降级到探针。
      if (hookActivity.state === "idle") {
        // Guard code-review 2026-07-02（阻断项 1）：信任陈旧 idle hook 前执行狭窄实时否决，
        // 绝不在可见 picker/权限 prompt 上粘贴并按 Enter。只有 pane 明确判为 needs_input 才否决；
        // unknown pane（正是此信任机制要处理的 Codex 不稳定场景）或干净 idle pane 不否决，
        // 可以信任陈旧 hook。
        const paneVeto = await probeSessionActivity({
          sessionName: input.sessionName,
          runtime: input.runtime,
          attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
          tmuxAdapter: this.tmuxAdapter,
          now,
          captureObserver: this.captureObserver,
          binding: input.binding,
        });
        if (paneVeto.state === "needs_input") {
          return paneVeto;
        }
        return hookActivity;
      }
    }

    return probeSessionActivity({
      sessionName: input.sessionName,
      runtime: input.runtime,
      attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
      tmuxAdapter: this.tmuxAdapter,
      now,
      captureObserver: this.captureObserver,
      binding: input.binding,
    });
  }

  // OPR.0.4.1.10——runtime hook 仅在严格发送窗口内对 send-readiness 有权威性。
  // 没有可用 hook 时间戳就不具备发送新鲜度，应回退到实时 capture。
  private hookFreshForSend(activity: AgentActivity, now: Date): boolean {
    const eventMs = activity.eventAt ? Date.parse(activity.eventAt) : NaN;
    if (!Number.isFinite(eventMs)) return false;
    return now.getTime() - eventMs <= this.sendReadinessFreshnessMs;
  }

  // OPR.0.4.3.28 Part C——producer 链路诊断。发送因 `unknown`（无可用活动信号）失败关闭时，
  // 点明 hook→activity producer 链中哪一环损坏以及下一步，而不是只给出不透明的
  // `no_activity_signal`。绝不显示 token 值；环境检查只判断是否存在，store 也不携带 token。
  private async diagnoseProducerLink(sessionName: string): Promise<string> {
    // 链路 1——席位环境：relay 能否访问后台服务？
    let hasUrl: boolean | null = null;
    let hasToken: boolean | null = null;
    let inspectedEnv = false;
    if (typeof this.tmuxAdapter?.hasSessionEnv === "function") {
      inspectedEnv = true;
      const anyPresent = async (names: string[]): Promise<boolean | null> => {
        let unknown = false;
        for (const name of names) {
          try {
            const present = await this.tmuxAdapter.hasSessionEnv(sessionName, name);
            if (present === true) return true;
            if (present === null) unknown = true;
          } catch {
            unknown = true;
          }
        }
        return unknown ? null : false;
      };
      hasUrl = await anyPresent(["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT", "RIGGED_PORT"]);
      hasToken = await anyPresent(["OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_ACTIVITY_HOOK_TOKEN"]);
    }
    let fileEndpoint: { baseUrl: string; token: string } | null = null;
    try {
      fileEndpoint = this.activityEndpointFile();
    } catch { /* 回退不可读时继续保持 unavailable。 */ }
    if (!fileEndpoint && (hasUrl === false || hasToken === false)) {
      const label = (value: boolean | null) => value === true ? "present" : value === false ? "MISSING" : "UNKNOWN";
      return `seat-env 链路中断——有效 relay URL ${label(hasUrl)}、activity token ${label(hasToken)}，且无有效 activity-endpoint.json 回退；activity relay 无法访问后台服务。确认有效端点不可用后重新启动席位`;
    }
    if (!fileEndpoint && inspectedEnv && (hasUrl === null || hasToken === null)) {
      return `seat-env 链路未知——tmux session-environment 查询失败，也无法确认有效 activity-endpoint.json 回退；尚未证明 URL/token 缺失`;
    }

    // 链路 2——后台服务摄入 + store：是否确有 hook 落地，以及陈旧程度如何？
    const store = this.agentActivityStore;
    if (!store) {
      return `daemon-ingest 链路中断——本后台服务未配置 activity store（摄入返回 503）`;
    }
    const latest = store.getLatestForNode({ sessionName, now: this.now() });
    if (!latest || latest.evidenceSource !== "runtime_hook") {
      return `daemon-ingest 链路中断——从未收到该席位的 activity hook；摄入可能拒绝了 POST（token 不匹配 → 401，或未配置摄入 → 503），也可能 Codex hook trust 尚未清除。请确认席位由 zrig 启动且 hook trust 已清除`;
    }
    // W2a-1——GENERATION 判定为 stale:true，但 hook 很新（age 约 0）；若折叠成“超过 store 窗口/
    // 席位安静”，会把逐路径缺少 carry / dead-tenure 错标为 DARK 席位，破坏 inert-visible 区分。
    // 在时钟陈旧回退前显式区分 generation 原因。generation_unverifiable 是逐 hook 无 generation
    // 信号（可靠但不黑暗）；其他值描述真实 generation 条件，而不是安静席位。
    if (latest.stale === true && typeof latest.reason === "string" && latest.reason.startsWith("generation_")) {
      const ageS = latest.eventAt ? Math.round((this.now().getTime() - Date.parse(latest.eventAt)) / 1000) : null;
      const age = ageS !== null ? `${ageS} 秒前` : "最近";
      switch (latest.reason) {
        case "generation_unverifiable":
          // 本 hook 携带的 generation 为 null。受管 launch 与 fresh-handover producer 会携带它；
          // 旧版/排除的 launch 路径，或触发时没有 tenure 的 occupant 可能不携带。该信号可靠但不黑暗，
          // 也不表示席位安静。
          return `producer 链路正常——存在最近 hook（${age}），但未携带 occupant generation；发射方 launch 路径未提供 generation（旧版/排除路径），或发射 occupant 在触发时没有 tenure。Generation 无法验证，不表示席位安静`;
        case "generation_unresolvable":
          return `producer 链路正常——存在最近 hook（${age}），但无法解析实时 occupant generation（无 tenure 行）；generation 无法解析，不表示席位安静`;
        case "generation_mismatch":
          return `producer 链路正常——存在最近 hook（${age}），但它属于先前 occupant generation（已结束 tenure），不属于当前存活 occupant；席位并非安静`;
        case "generation_resolver_error":
          return `producer 链路正常——存在最近 hook（${age}），但 occupant-generation resolver 出错；generation 判定已降级，不表示席位安静`;
      }
    }
    if (latest.stale === true) {
      const ageS = latest.eventAt ? Math.round((this.now().getTime() - Date.parse(latest.eventAt)) / 1000) : null;
      return `producer 链路正常但已陈旧——最后一个 activity hook 到达于 ${ageS !== null ? `${ageS} 秒前` : "很久以前"}（超出 store 窗口）；席位已安静或其 hook 停止触发`;
    }
    return `存在最近 activity hook，但实时 pane 探针无法确认 idle（席位环境、DB 与已存 payload 之间可能身份不匹配）`;
  }

  // OPR.0.4.1.10——持久化 --dangerously-interact prompt 覆盖的审计记录。审计必须全有或全无：
  // 若无 eventBus、无法解析目标工作组/节点，或事件无法持久化，则返回 !ok，使调用方失败关闭且不发送。
  // Payload 保持调用方 overrideReason 与分类器 detectedReason/evidenceSource 相互独立，不复用字段。
  private recordPromptOverride(input: {
    sessionName: string;
    readiness: AgentActivity;
    actorSession: string | null;
    overrideReason: string | null;
  }): { ok: true } | { ok: false; reason: string } {
    if (!this.eventBus) return { ok: false, reason: "audit_unconfigured" };
    const resolved = this.agentActivityStore?.resolveSession({ sessionName: input.sessionName });
    if (!resolved) return { ok: false, reason: "session_unresolved" };
    try {
      this.eventBus.emit({
        type: "transport.prompt_override",
        rigId: resolved.rigId,
        nodeId: resolved.nodeId,
        sessionName: resolved.sessionName,
        actorSession: input.actorSession,
        detectedState: input.readiness.state,
        detectedReason: input.readiness.reason,
        evidenceSource: input.readiness.evidenceSource,
        overrideReason: input.overrideReason,
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: "audit_persist_failed" };
    }
  }

  async capture(sessionName: string, opts?: { lines?: number }): Promise<CaptureResult> {
    const sessionMeta = this.getSessionMeta(sessionName);
    if (sessionMeta.attachmentType === "external_cli") {
      return {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `会话 '${sessionName}' 作为 external CLI 节点挂载；该目标无法使用入站 tmux capture。`,
      };
    }

    // 分类探针（OPR.0.5.4.2）遵循与发送门禁相同的规则：传输抖动是传输层答案，
    // 绝不是席位死亡答案。
    try {
      const probe = await this.tmuxAdapter.probeSession(sessionName);
      if (probe.state === "absent") {
        this.recordSessionMissingVerdict(sessionName);
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `未找到会话 '${sessionName}'：tmux 报告不存在该名称的会话。未 capture 任何内容。请用 zrig ps --nodes 检查可用会话`,
        };
      }
      if (probe.state === "transport_unavailable") {
        return {
          ok: false,
          sessionName,
          reason: "tmux_unavailable",
          error: `无法连接 tmux server（${probe.cause}）。未能确定会话 '${sessionName}' 是否存在；未 capture 任何内容。`,
        };
      }
    } catch (err) {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: `tmux 会话探针意外失败（${err instanceof Error ? err.message : String(err)}）。未能确定会话 '${sessionName}' 是否存在；未 capture 任何内容。`,
      };
    }

    const lines = opts?.lines ?? 20;
    const content = await this.tmuxAdapter.capturePaneContent(sessionName, lines);
    if (content === null) {
      return {
        ok: false,
        sessionName,
        reason: "capture_failed",
        error: `无法 capture '${sessionName}' 的 pane 内容。`,
      };
    }

    return { ok: true, sessionName, content, lines };
  }

  async broadcast(target: TargetSpec, text: string, opts?: BroadcastOpts): Promise<BroadcastResult> {
    const resolved = await this.resolveSessions(target);
    if (!resolved.ok) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        results: [{
          ok: false,
          sessionName: "",
          reason: resolved.code,
          error: resolved.error,
        }],
      };
    }

    // Send/broadcast header（裁决 03c35295）：工作范围（收件人规模事实）与时间戳在发送时对每次
    // fan-out 只计算一次；每个收件人的 header 都携带相同 envelope 事实。
    const recipientNames = resolved.sessions.map((s) => s.sessionName);
    const scope = scopeForTarget(target, recipientNames);
    const stampISO = opts?.stampISO ?? new Date().toISOString();
    // GHOST-STAGE (g)：在与 stampISO 相同的接缝上，对每次 fan-out 只解析一次发送方 occupant
    // generation，因为所有收件人共享同一发送方。本地发送方得到其 atom-B generation-uuid；
    // 跨主机 --from relay（发送方不是本地会话）解析为 null，即 UNKNOWN，渲染时省略 gen 后缀，
    // 绝不把本主机 generation 伪造到外部发送方。
    const genUuid = opts?.envelopeSender
      ? (this.sessionRegistry.currentOccupantGenerationForSession(opts.envelopeSender) ?? undefined)
      : undefined;

    const results: SendResult[] = [];
    for (const session of resolved.sessions) {
      // OPR.0.4.3.30——`zrig send` fan-out 的逐收件人 From/To envelope 在后台服务侧渲染；CLI
      // 不知道每个已解析席位，无法逐收件人包装。裁决 03c35295：To 行现在投影规模
      //（multi = 完整列表；rig/pod/topology = 广播规模）和 Sent 时间戳，使收件人仅看 header
      // 就能区分 DM 与 broadcast（防风暴）。原始路径（--raw / --dangerously-interact，
      // 无 envelopeSender）仍不加包装直接投递。
      const perRecipientText = opts?.envelopeSender
        ? wrapPaneEnvelope(opts.envelopeSender, session.sessionName, text, { scope, stampISO, genUuid })
        : text;
      // (h) 贯穿传递已解析 stampISO，使 send() 的投递延迟从 envelope 携带的同一组合时间戳起算；
      // opts 可能未携带该值，本地 stampISO 才是事实。
      const result = await this.send(session.sessionName, perRecipientText, { ...opts, stampISO,
        deliveryId: opts?.deliveryId ? `${opts.deliveryId}:${session.sessionName}` : undefined });
      results.push(result);
    }

    return {
      total: results.length,
      sent: results.filter((r) => r.ok && r.outcome !== "retained").length,
      retained: results.filter(r => r.outcome === "retained").length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}
