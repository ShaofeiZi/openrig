import { observeCodexPaneProcess, listNativeProcesses, type NativeProcessLister, type CodexProcessObservation } from "./native-process-lineage.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SeatIdentityVerdict } from "./types.js";
import { SeatIdentityStore, SelfHostIdentityStore } from "./seat-identity-store.js";
import { RESERVED_HOST_IDS, validateHostRegistry } from "./hosts/hosts-registry-reader.js";

/** 默认身份协调周期：5 秒。进程身份很少变化（seat 的 pane/进程在整个生命周期内保持稳定），
 *  而该检查比 1Hz 活动轮询成本更高（需为每个 seat 读取 pane PID 和命令），
 *  因此较慢的周期能更好地平衡成本与新鲜度。 */
export const DEFAULT_IDENTITY_POLL_INTERVAL_MS = 5000;

/** 表现为裸 shell 的前台命令（seat 已退回提示符，或孤立/QA 占位 shell 占据 pane）。
 *  与 SessionFingerprinter 的 SHELL_NAMES 词汇一致。`pane_current_command` 可能带有
 *  登录 shell 的 `-` 前缀。 */
const SHELL_COMMANDS = new Set([
  "bash", "zsh", "fish", "sh", "dash", "tcsh", "csh",
  "-bash", "-zsh", "-fish", "-sh", "-dash", "-tcsh", "-csh",
]);

/**
 * 旧版短命令分类器。Codex 调用方还需要共享的原生进程证明；仅凭此标签无法确认 Codex 身份。
 *
 * 为保持 slice-15“实时 seat 不得误判为绿色”的不变量，此处刻意宽松：真正运行中的
 * claude/codex TUI 通常把宿主进程（`node`）而非字面运行时名称报告为
 * `pane_current_command`，因此仅在存在明确矛盾时判定 `mismatch`——即另一个已知 agent
 * 运行时，或本应运行 agent 却出现裸 shell（进程已终止 / 孤立 shell 占据 pane）。
 * 含糊命令（`node`、`python`、空值）绝不降级。
 *
 * 与 SessionFingerprinter 的第 1 层进程命令词汇一致；每轮轮询不会执行完整的四层扫描
 *（cmux 查询 + pane 内容捕获）——在集群规模下成本高得多，而且其内容层不会改变这里的
 * 降级决策（协调只需区分“进程与 seat 矛盾”和“无矛盾”）。
 */
export function classifyPaneRuntimeMatch(
  command: string | null,
  expectedRuntime: string | null,
): "match" | "mismatch" {
  if (!command) return "match"; // 没有信号——绝不将现存 pane 误判为 mismatch
  const cmd = command.trim().toLowerCase();
  const expectsAgent = expectedRuntime === "claude-code" || expectedRuntime === "codex";

  // 明确的同运行时信号。
  if (expectedRuntime === "claude-code" && cmd.includes("claude")) return "match";
  if (expectedRuntime === "codex" && cmd.includes("codex")) return "match";

  // 跨运行时矛盾（另一个 agent 占据 pane）。
  if (expectedRuntime === "claude-code" && cmd.includes("codex")) return "mismatch";
  if (expectedRuntime === "codex" && cmd.includes("claude")) return "mismatch";

  // 本应运行 agent 却出现裸 shell——agent 进程已消失，或孤立/占位 shell 占据 pane。
  if (expectsAgent && SHELL_COMMANDS.has(cmd)) return "mismatch";

  // 含糊情况 / 符合预期的 shell（terminal 节点）——无矛盾。
  return "match";
}

interface RunningSeatRow {
  node_id: string;
  runtime: string | null;
  session_name: string;
  tmux_pane: string | null;
  resume_token?: string | null;
}

export interface SeatIdentityReconcilerDeps {
  db: Database.Database;
  tmux: Pick<TmuxAdapter, "listSessions" | "getPanePid" | "getPaneCommand">;
  now?: () => Date;
  listProcesses?: NativeProcessLister;
}

/**
 * OPR.0.4.3.19 — 活跃身份裁决（第三个轴）的周期性协调器。与 SeatActivityService.start()
 * 对应：轮询每个运行中的 tmux 绑定托管 seat，将当前 pane PID/命令与已注册 seat 协调，
 * 并将裁决持久化到 `seat_identity_verdicts`。投影随后可同步读取低成本的持久化裁决。
 *
 * 非推断原则：此协调器只读取 tmux pane 进程身份并与已注册绑定比较。它绝不读取
 * queue/classifier/hook 心跳，也不触碰 `terminalActive` / `hasAssignedWork`。
 */
export class SeatIdentityReconciler {
  private readonly db: Database.Database;
  private readonly tmux: SeatIdentityReconcilerDeps["tmux"];
  private readonly now: () => Date;
  private readonly store: SeatIdentityStore;
  private readonly listProcesses: NativeProcessLister;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SeatIdentityReconcilerDeps) {
    this.db = deps.db;
    this.tmux = deps.tmux;
    this.now = deps.now ?? (() => new Date());
    this.store = new SeatIdentityStore(deps.db);
    this.listProcesses = deps.listProcesses ?? listNativeProcesses;
  }

  private runningSeats(): RunningSeatRow[] {
    return this.db.prepare(`
      SELECT n.id as node_id, n.runtime as runtime,
             s.session_name as session_name, b.tmux_pane as tmux_pane, s.resume_token as resume_token
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.status = 'running'
        AND s.session_name IS NOT NULL
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
    `).all() as RunningSeatRow[];
  }

  /** 对每个运行中的 tmux 绑定 seat 协调一次，并持久化裁决。 */
  async reconcileAll(): Promise<void> {
    const seats = this.runningSeats();
    // 清理已停止运行节点的裁决（控制表大小）。
    this.store.pruneExcept(seats.map((s) => s.node_id));
    if (seats.length === 0) return;

    const observedAt = this.now().toISOString();

    // 每轮轮询只探测一次 tmux 可用性。若 tmux 完全不可达（抛错），或数据库中存在运行中
    // seat 时却报告零个实时会话，则视为 tmux 瞬时异常，并为旧版运行时记录
    // `tmux_unavailable`。缺少原生证据时，Codex 仍保持非绿色状态。
    let liveSessions: Set<string> | null = null;
    try {
      const sessions = await this.tmux.listSessions();
      liveSessions = new Set(sessions.map((s) => s.name));
    } catch {
      liveSessions = null;
    }
    if (liveSessions === null || liveSessions.size === 0) {
      for (const seat of seats) {
        this.store.upsert(this.tmuxUnavailableVerdict(seat, observedAt));
      }
      return;
    }

    // 每轮扫描获取两份新的进程快照，而不是每个 seat 调用两次 ps。每个阶段都观察所有
    // 已绑定 pane；第二阶段在第一阶段结束后开始。
    const codexSeats = seats.filter((seat) => seat.runtime === "codex" && seat.tmux_pane && liveSessions.has(seat.session_name));
    const sample = async () => {
      let snapshot: ReturnType<NativeProcessLister> | undefined;
      return Promise.all(codexSeats.map((seat) => observeCodexPaneProcess({
        target: seat.tmux_pane!, tmux: this.tmux, expectedToken: seat.resume_token,
        listProcesses: () => snapshot ??= this.listProcesses(),
      })));
    };
    const first = await sample();
    const second = await sample();
    const codexProofs = new Map(codexSeats.map((seat, index) => [seat.node_id,
      first[index] && first[index]?.fingerprint === second[index]?.fingerprint ? second[index]! : null]));
    for (const seat of seats) {
      try {
        this.store.upsert(await this.computeVerdict(seat, liveSessions, observedAt, codexProofs.get(seat.node_id) ?? null));
      } catch {
        // 单个 seat 的 tmux 故障不得让循环崩溃；将其记录为不可用观察
        //（Codex 保持非绿色状态）。
        this.store.upsert(this.tmuxUnavailableVerdict(seat, observedAt));
      }
    }
  }

  private tmuxUnavailableVerdict(seat: RunningSeatRow, observedAt: string): SeatIdentityVerdict {
    return {
      nodeId: seat.node_id,
      verdict: seat.runtime === "codex" ? "mismatch" : "tmux_unavailable",
      evidenceSource: null,
      reason: "tmux_unavailable",
      evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: seat.session_name,
      observedAt,
    };
  }

  private async computeVerdict(
    seat: RunningSeatRow,
    liveSessions: Set<string>,
    observedAt: string,
    native: CodexProcessObservation | null,
  ): Promise<SeatIdentityVerdict> {
    const base = {
      nodeId: seat.node_id,
      sessionName: seat.session_name,
      observedAt,
    };

    // binding pane 为 null 有两种不同原因。目标会话不存在时，这是需要降级的会话缺失事实；
    // 目标会话仍存活时，仅表示绑定缺失：明确命名，并让 Codex 保持非绿色状态。
    if (!seat.tmux_pane) {
      if (!liveSessions.has(seat.session_name)) {
        return {
          ...base,
          verdict: "pane_missing",
          evidenceSource: "tmux_session",
          reason: "session_missing",
          evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
        };
      }
      return {
        ...base,
        verdict: seat.runtime === "codex" ? "mismatch" : "binding_absent",
        evidenceSource: "tmux_session",
        reason: "binding_pane_missing",
        evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    const pid = await this.tmux.getPanePid(seat.tmux_pane);
    if (pid === null) {
      // 已注册 pane 无法再解析。区分“整个 tmux 会话已消失”和“实时会话中的 pane 已消失”。
      const sessionAlive = liveSessions.has(seat.session_name);
      return {
        ...base,
        verdict: "pane_missing",
        evidenceSource: sessionAlive ? "pane_process" : "tmux_session",
        reason: sessionAlive ? "pane_pid_gone" : "session_missing",
        evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    const command = await this.tmux.getPaneCommand(seat.tmux_pane);
    if (seat.runtime === "codex") {
      return {
        ...base, verdict: native?.panePid === pid ? "verified" : "mismatch",
        evidenceSource: "pane_process", reason: native?.panePid === pid ? null : "process_identity_ambiguous",
        evidence: { registeredPane: seat.tmux_pane, observedPid: native?.process.pid ?? pid,
          observedCommand: native?.process.command ?? command, matchedLayer: native?.panePid === pid ? 1 : null },
      };
    }
    const match = classifyPaneRuntimeMatch(command, seat.runtime);
    if (match === "mismatch") {
      return {
        ...base,
        verdict: "mismatch",
        evidenceSource: "pane_process",
        reason: "process_identity_mismatch",
        evidence: { registeredPane: seat.tmux_pane, observedPid: pid, observedCommand: command, matchedLayer: 1 },
      };
    }

    return {
      ...base,
      verdict: "verified",
      evidenceSource: "pane_process",
      reason: null,
      evidence: { registeredPane: seat.tmux_pane, observedPid: pid, observedCommand: command, matchedLayer: 1 },
    };
  }

  /** 启动调度器。幂等——调用两次等同于空操作。 */
  start(intervalMs: number = DEFAULT_IDENTITY_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileAll();
    }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** 停止调度器。在启动前调用或多次调用均安全。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ── 51-09 增量 1：持久 daemon 自宿主身份 ────────────────────────────────────
// 根据架构裁定 cb19867f，与 seat 身份基础设施放在一起（扩展现有机制，不另造平行的身份生命周期）。
// 在启动时协调一次。

/**
 * 保留的 / 非身份主机令牌，绝不能成为自宿主 id：注册表保留集合
 *（{kernel, host, local}，见 hosts-registry-reader），以及仅用于显示的默认值
 * "localhost"（host.name 的默认值——按 DP4 仅供显示，绝非身份）。比较时不区分大小写。
 */
export const RESERVED_SELF_HOST_SEEDS = new Set<string>([...RESERVED_HOST_IDS, "localhost"]);

function isReservedSeed(candidate: string): boolean {
  return RESERVED_SELF_HOST_SEEDS.has(candidate.trim().toLowerCase());
}

/**
 * 断言自宿主 id 永不为空，也绝不是保留/显示令牌。违反时抛错（显式、闭合失败）——
 * 这是“绝不为 'local'”的不变量守卫。
 */
export function assertNeverReservedHostId(hostId: string): void {
  const norm = hostId.trim().toLowerCase();
  if (!norm) {
    throw new Error("[self-host-identity] 不变量：self-host id 不得为空");
  }
  if (RESERVED_SELF_HOST_SEEDS.has(norm)) {
    throw new Error(
      `[self-host-identity] 不变量：self-host id 绝不能是保留/显示令牌（收到 '${hostId}'；保留值：${[...RESERVED_SELF_HOST_SEEDS].sort().join(", ")}）`,
    );
  }
}

/**
 * 实时 self-host id 的来源，在读取时派生——`named`、`generated` 或如实的 `indeterminate`。
 *
 * 为何派生而非读取：`self_host_identity` 存储 `host_id`、`minted_at`、`reconciled_at`，
 * 完全不含来源信息，因此没有可供查询的记录。正确记录来源需要数据库迁移，应归入数据填充工作，
 * 而不是在这里完成。
 *
 * `indeterminate` 承担关键语义，并非敷衍。它正是协调器已发出警告的冲突状态：操作者在 id
 * 生成之后设置 `host.name`，协调器保留原 id（持久身份绝不静默重键），此后配置名称与实时 id
 * 不一致。若称其为 `generated`，就是对一台确实已命名机器作出虚假声明；把未知表现为已知，
 * 正是此切片要修复的缺陷。
 */
export type SelfHostIdSource = "named" | "generated" | "indeterminate";

const GENERATED_SELF_HOST_ID = /^host-[0-9a-f]{8}$/;

export function deriveSelfHostIdSource(
  hostId: string | null | undefined,
  hostNameCandidate: string | null | undefined,
): SelfHostIdSource | null {
  if (typeof hostId !== "string" || hostId.trim() === "") return null;
  // 可接受性必须与生成分支完全一致，而不能只检查“是否已设置”。`host.name` 默认为
  // "localhost"，这是协调器拒绝作为种子的保留显示令牌——因此在新生成的主机上，候选值
  // 虽然存在但不可用。若只检查是否存在，会把最普通的未命名机器报告为 `indeterminate`。
  const candidate = normalizeCandidate(hostNameCandidate);
  const admissibleSeed =
    candidate !== null && !isReservedSeed(candidate) && isRegistryValidSelfId(candidate)
      ? candidate
      : null;

  // 从操作者名称生成，且仍与之相符。
  if (admissibleSeed !== null && admissibleSeed === hostId) return "named";
  // 没有人为此机器设置可用名称，且 id 符合生成格式：保留的生成 id 回退值。
  if (admissibleSeed === null && GENERATED_SELF_HOST_ID.test(hostId)) return "generated";
  // 可接受名称却不一致（协调器保留并警告的冲突），或 id 格式不符合任一来源。无法证明，
  // 因而如实说明。
  return "indeterminate";
}

/** 冲突安全的生成式 self-host id，在不存在明确操作者种子时使用。 */
function generateSelfHostId(): string {
  return `host-${randomUUID().slice(0, 8)}`;
}

// ── 51-09 增量 2b：self-id ↔ registry-id 对齐（架构裁定 dfa65bfc）─────────────
// 解释 (ii)：不存在注册表 self 行（与封闭的 HostEntry 联合类型不一致）；对齐属性要求生成的
// self-host id 必须是有效且非保留的注册表 id，使远程主机能采用它作为注册表键
//（transport-carries-host）。我们通过单条目探针复用规范的注册表 id 校验器
//（validateHostRegistry——CLI/daemon 锁步孪生体，其一致性固定在 hosts-registry-parity.test.ts），
// 而不是复制一份可能分歧的规则（正则 + 保留集合）。探针使用固定的有效 transport/target，
// 使得只有 id 会失败——当且仅当 id 无效时 ok===false。

function isRegistryValidSelfId(id: string): boolean {
  return validateHostRegistry(
    { hosts: [{ id, transport: "ssh", target: "self-host-alignment-probe" }] },
    "<self-host-identity>",
  ).ok;
}

/**
 * 51-09 增量 2b——闭合失败式注册表对齐断言。若持久 self-host id 不是有效的注册表 id，
 * 远程主机就无法将其解析为键（transport-carries-host 中断），因此这属于致命启动配置错误。
 * 根据裁定，把增量 1 的显式冲突策略升级为针对注册表对齐场景的启动时闭合失败断言。
 */
export function assertSelfHostIdRegistryAligned(hostId: string): void {
  const probe = validateHostRegistry(
    { hosts: [{ id: hostId, transport: "ssh", target: "self-host-alignment-probe" }] },
    "<self-host-identity>",
  );
  if (!probe.ok) {
    throw new Error(
      `[self-host-identity] 注册表对齐：self-host id '${hostId}' 不是有效的注册表 id——远程主机无法将其解析为键。${probe.error} 请修正操作者的 host.name，或删除 self-host 记录以重新生成键。`,
    );
  }
}

function normalizeCandidate(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface SelfHostReconcileResult {
  hostId: string;
  minted: boolean;
  /**
   * 当已存在存储 id，且操作者候选值（host.name）与之不同时填充（非 null）——身份绝不
   * 静默重键；保留存储 id，并明确呈现冲突。这是增量 2 为 self-id ↔ registry-id 对齐
   * 复用的通用显式冲突机制。
   */
  conflict: { storedId: string; candidate: string } | null;
}

/**
 * 51-09 增量 1——在启动时生成或协调 daemon 的持久 self-host id。首次启动时生成
 * （若存在明确的操作者 host.name，则以其为种子，否则生成冲突安全的 id）；后续每次启动
 * 都进行协调（推进 reconciled_at，保留 id——重启仍使用同一 id）。host.name 只是显示用途的
 * 候选种子（架构裁定 cb19867f / DP4）；保留值或默认候选值会被拒绝，改用生成 id。
 * 已存在存储 id 且操作者候选值与之不同时，保留原 id（绝不静默重键），并明确呈现两者冲突。
 */
export function reconcileSelfHostIdentity(
  store: SelfHostIdentityStore,
  opts: { nowIso: string; hostNameCandidate?: string | null; log?: (message: string) => void },
): SelfHostReconcileResult {
  const log = opts.log ?? ((message: string) => console.error(message));
  const candidate = normalizeCandidate(opts.hostNameCandidate);
  const existing = store.get();

  if (existing) {
    store.touchReconciledAt(opts.nowIso);
    assertNeverReservedHostId(existing.hostId);
    // 51-09 增量 2b：若存储的 self-id 不是有效注册表 id，则闭合失败
    //（2b 前生成或数据库被篡改的 id，远程主机无法将其作为键采用）。
    assertSelfHostIdRegistryAligned(existing.hostId);
    let conflict: SelfHostReconcileResult["conflict"] = null;
    if (candidate && !isReservedSeed(candidate) && candidate !== existing.hostId) {
      conflict = { storedId: existing.hostId, candidate };
      log(
        `[self-host-identity] 冲突：操作者 host.name '${candidate}' 与已生成的 self-host id '${existing.hostId}' 不同。保留 '${existing.hostId}'——持久主机身份绝不静默重键。请主动重键（删除 self-host 记录），或协调显示名称。`,
      );
    }
    return { hostId: existing.hostId, minted: false, conflict };
  }

  // 51-09 增量 2b：仅当 host.name 种子是有效注册表 id 时才采用它
  //（通过增量 1 的不区分大小写守卫确认非保留，且符合注册表 id 格式），
  // 因此格式无效的操作者 host.name 会回退为生成的有效 id，而不会生成不可用、
  // 导致启动失败的 self-id。
  const seed =
    candidate && !isReservedSeed(candidate) && isRegistryValidSelfId(candidate)
      ? candidate
      : generateSelfHostId();
  assertNeverReservedHostId(seed);
  const record = store.mint(seed, opts.nowIso);
  // 双重保障：生成的 id（采用的有效值或自动生成值）与注册表对齐。
  assertSelfHostIdRegistryAligned(record.hostId);
  return { hostId: record.hostId, minted: true, conflict: null };
}
