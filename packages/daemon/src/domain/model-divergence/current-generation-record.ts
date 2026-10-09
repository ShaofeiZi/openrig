// 通过已登记 pane 及其已验证进程身份解析当前占用者的提供方记录。只有物理 pane 与
// 占用者关联成立后，才查阅 transcript 元数据。注册表令牌是连续性元数据，不是实时
// 身份；transcript 新旧也绝不用于打破身份平局，因为刻意保留的前任可能持续写入。

import { dirname, join } from "node:path";

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
  /** OPR.0.5.3.10 —— 进程启动时间（`ps lstart`），即 pid+启动时间身份组合的一半。
   * pid 被复用时它会变化，因此消费者无需再启动进程即可使按 pid 缓存的答案失效。
   * 此字段可选：没有它的注入式旧记录回退到解析器的 TTL 边界。 */
  startedAt?: string;
}

export interface CurrentGenerationDeps {
  getPanePid: (sessionTarget: string) => Promise<number | null>;
  listProcesses: () => Promise<ProcessRow[]>;
  /** Codex：实时 codex pid 对应的 thread id（日志关联；F1 后异步）。
   * `identity` = 进程清单记录的 startedAt（pid+启动时间复用防护）。 */
  readThreadIdByPid: (pid: number, identity?: string) => Promise<string | undefined> | string | undefined;
}

export type CurrentRecordResolution =
  | { ok: true; id: string }
  | { ok: false; reason: string };

export interface ClaudeOccupantRecordInput {
  sessionName: string;
  generation: string | null;
  occupantBootAt: string | null;
  binding: { tmuxSession: string | null; tmuxPane: string | null } | null;
  identity: {
    verdict: string;
    sessionName: string | null;
    observedAt: string;
    evidence: { registeredPane: string | null; observedPid: number | null };
  } | null;
  sidecar: {
    session_id?: string;
    session_name?: string;
    transcript_path?: string;
    sampled_at?: string;
    occupant_generation?: string;
  } | null;
}

export type ClaudeRecordSelection =
  | { ok: true; id: string; path: string; source: "generation-sidecar" | "verified-pane-argument" }
  | { ok: false; reason: string };

/** 广度优先查找 `parentPid` 的后代中命令匹配 `matches` 的进程。（刻意保持本地：
 * 现有两个遍历器分别是 codex 适配器与刷新器的模块私有实现；待局面稳定后再抽取共享。） */
function findDescendants(processes: ProcessRow[], parentPid: number, matches: (command: string) => boolean): number[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const p of processes) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const out: number[] = [];
  const queue = [parentPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (matches(child.command)) out.push(child.pid);
      queue.push(child.pid);
    }
  }
  return out;
}

function commandBasenameIs(name: string): (command: string) => boolean {
  return (command) => command.trim().split(/\s+/).filter(Boolean).some((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    return unquoted.split("/").pop() === name;
  });
}

/** pane 进程的 Claude session-id 启动参数。只有调用方验证规范绑定和当前 pane 身份后，
 * 它才具有权威性；提供方内部会话滚动后，当代 sidecar 可以取代该值。 */
export async function paneClaudeSessionIdArgument(
  sessionTarget: string,
  deps: Pick<CurrentGenerationDeps, "getPanePid" | "listProcesses">,
): Promise<CurrentRecordResolution> {
  const panePid = await deps.getPanePid(sessionTarget);
  if (!panePid) return { ok: false, reason: `${sessionTarget} 没有存活的窗格 PID` };
  const processes = await deps.listProcesses();
  const claudePids = findDescendants(processes, panePid, commandBasenameIs("claude"));
  if (claudePids.length === 0) return { ok: false, reason: `${sessionTarget} 的存活窗格下没有 Claude 进程` };
  const ids = new Set<string>();
  for (const pid of claudePids) {
    const command = processes.find((p) => p.pid === pid)?.command ?? "";
    const match = command.match(/--session-id[= ]([0-9a-f-]{36})/) ?? command.match(/--resume[= ]([0-9a-f-]{36})/);
    if (match?.[1]) ids.add(match[1]);
  }
  if (ids.size === 1) return { ok: true, id: [...ids][0]! };
  if (ids.size > 1) return { ok: false, reason: `${sessionTarget} 的存活窗格下存在多个 Claude 会话 ID：${[...ids].join(", ")}` };
  return { ok: false, reason: `${sessionTarget} 下的存活 Claude 进程没有 --session-id/--resume 参数` };
}

/**
 * 仅当规范席位的当前占用者已关联到登记 pane，且 pane PID 仍符合持久身份判定时，
 * 才解析 Claude 记录。pane 的启动参数是旧版身份锚点。提供方内部会话滚动后，带代际
 * 标记的 sidecar 可以取代它；无标记 sidecar 可以定位文件，但不能覆盖身份。
 */
export async function resolveIdentityVerifiedClaudeRecord(
  input: ClaudeOccupantRecordInput,
  deps: Pick<CurrentGenerationDeps, "getPanePid" | "listProcesses">,
  isReadableRecord: (path: string) => boolean,
): Promise<ClaudeRecordSelection> {
  if (!input.generation) {
    return { ok: false, reason: `${input.sessionName} 的当前占用者代次未知` };
  }
  if (!input.occupantBootAt || !Number.isFinite(Date.parse(input.occupantBootAt))) {
    return { ok: false, reason: `${input.sessionName} 的当前占用者启动时间未知` };
  }
  const binding = input.binding;
  if (!binding?.tmuxPane || binding.tmuxSession !== input.sessionName) {
    return { ok: false, reason: `${input.sessionName} 没有规范 tmux 窗格绑定` };
  }
  const identity = input.identity;
  if (!identity || identity.verdict !== "verified") {
    return { ok: false, reason: `${input.sessionName} 没有已验证窗格身份${identity ? `（判定 ${identity.verdict}）` : ""}` };
  }
  if (identity.sessionName !== input.sessionName) {
    return { ok: false, reason: `已验证身份指向 ${identity.sessionName ?? "无会话"}，而非 ${input.sessionName}` };
  }
  if (identity.evidence.registeredPane !== binding.tmuxPane) {
    return { ok: false, reason: `已验证身份登记的窗格与绑定 ${binding.tmuxPane} 不匹配` };
  }
  const observedAt = Date.parse(identity.observedAt);
  if (!Number.isFinite(observedAt) || observedAt < Date.parse(input.occupantBootAt)) {
    return { ok: false, reason: `已验证窗格身份早于占用者代次 ${input.generation}` };
  }
  if (identity.evidence.observedPid === null) {
    return { ok: false, reason: `${input.sessionName} 的已验证窗格身份未携带观测 PID` };
  }
  const panePid = await deps.getPanePid(binding.tmuxPane);
  if (!panePid) return { ok: false, reason: `已登记窗格 ${binding.tmuxPane} 没有存活 PID` };
  if (panePid !== identity.evidence.observedPid) {
    return {
      ok: false,
      reason: `身份验证后，已登记窗格 PID 发生变化（${identity.evidence.observedPid} → ${panePid}）`,
    };
  }

  const processes = await deps.listProcesses();
  const claudePids = findDescendants(processes, panePid, commandBasenameIs("claude"));
  if (claudePids.length === 0) {
    return { ok: false, reason: `已验证窗格 ${binding.tmuxPane} 下没有 Claude 进程` };
  }
  const paneIds = new Set<string>();
  for (const pid of claudePids) {
    const command = processes.find((process) => process.pid === pid)?.command ?? "";
    const match = command.match(/--session-id[= ]([0-9a-f-]{36})/) ?? command.match(/--resume[= ]([0-9a-f-]{36})/);
    if (match?.[1]) paneIds.add(match[1]);
  }
  if (paneIds.size === 0) {
    return { ok: false, reason: `已验证窗格 ${binding.tmuxPane} 下的 Claude 进程没有会话 ID` };
  }
  if (paneIds.size > 1) {
    return { ok: false, reason: `已验证窗格 ${binding.tmuxPane} 下存在多个 Claude 会话 ID：${[...paneIds].join(", ")}` };
  }
  const paneId = [...paneIds][0]!;
  const sidecar = input.sidecar;
  const sidecarPath = cleanString(sidecar?.transcript_path);
  const sidecarId = cleanString(sidecar?.session_id);
  const sidecarGeneration = cleanString(sidecar?.occupant_generation);

  // 当代 sidecar 是受支持的提供方滚动信号。其代际标记来自托管占用者的启动环境，
  // 因此即使保留的前任在启动时用 --name 指向规范席位，它仍携带旧代际。
  if (sidecarGeneration === input.generation && sidecarId && sidecarPath) {
    const sampledAt = Date.parse(cleanString(sidecar?.sampled_at) ?? "");
    if (
      sidecar?.session_name === input.sessionName
      && Number.isFinite(sampledAt)
      && sampledAt >= Date.parse(input.occupantBootAt)
      && isReadableRecord(sidecarPath)
    ) {
      return { ok: true, id: sidecarId, path: sidecarPath, source: "generation-sidecar" };
    }
  }

  // 旧版 sidecar 没有占用者代际标记。它可定位项目 transcript 目录，但具体文件由
  // 已验证 pane 自身的启动 ID 选择；注册表令牌和 mtime 均不参与此决策。
  if (sidecarPath) {
    const panePath = sidecarId === paneId ? sidecarPath : join(dirname(sidecarPath), `${paneId}.jsonl`);
    if (isReadableRecord(panePath)) {
      return { ok: true, id: paneId, path: panePath, source: "verified-pane-argument" };
    }
  }
  return {
    ok: false,
    reason: `已验证占用者 ${input.generation} 解析到原生会话 ${paneId}，但其会话记录不可读`,
  };
}

function cleanString(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 通过实时 codex 占用者自身 pid 的日志关联获取 thread id，完全绕过已存储的恢复
 * 令牌（该类故障样本中失效的正是存储令牌）。 */
export async function resolveLiveCodexThreadId(
  sessionTarget: string,
  deps: CurrentGenerationDeps,
): Promise<CurrentRecordResolution> {
  const panePid = await deps.getPanePid(sessionTarget);
  if (!panePid) return { ok: false, reason: `${sessionTarget} 没有存活的窗格 PID` };
  const processes = await deps.listProcesses();
  const codexPids = findDescendants(processes, panePid, commandBasenameIs("codex"));
  if (codexPids.length === 0) return { ok: false, reason: `${sessionTarget} 的存活窗格下没有 Codex 进程` };
  const ids = new Set<string>();
  for (const pid of codexPids) {
    const threadId = await deps.readThreadIdByPid(pid, processes.find((p) => p.pid === pid)?.startedAt);
    if (threadId) ids.add(threadId);
  }
  if (ids.size === 1) return { ok: true, id: [...ids][0]! };
  if (ids.size > 1) return { ok: false, reason: `${sessionTarget} 的存活窗格下存在多个 Codex 线程` };
  return { ok: false, reason: `${sessionTarget} 下的存活 Codex 进程日志未解析出线程 ID` };
}
