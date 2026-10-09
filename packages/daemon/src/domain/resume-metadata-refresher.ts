import os from "node:os";
import nodePath from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import {
  CodexThreadIdResolver,
  defaultResolveHomeDirByPid,
  readCodexThreadIdFromCandidateHomes,
  type ResolveHomeDirByPid,
} from "./codex-thread-id.js";
import {
  assessNativeResumeProbe,
  buildNativeResumeCommand,
  isProbeShellReady,
} from "./native-resume-probe.js";
import { runAsyncSite } from "./sync-site-wrap.js";

const execFileAsync = promisify(execFile);

export interface ResumeRefreshSession {
  sessionId: string;
  sessionName: string;
  runtime: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  cwd?: string | null;
}

interface ResumeMetadataRefresherDeps {
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  listProcesses?: () => Array<{ pid: number; ppid: number; command: string }> | Promise<Array<{ pid: number; ppid: number; command: string }>>;
  readCodexThreadIdByPid?: (pid: number, identity?: string) => Promise<string | undefined> | string | undefined;
  probeClaudeResume?: (sessionName: string, resumeToken: string, cwd?: string | null) => Promise<"resumable" | "not_resumable" | "inconclusive">;
  resolveHomeDirByPid?: ResolveHomeDirByPid;
  sleep?: (ms: number) => Promise<void>;
  homeDir?: string;
  // OPR.0.4.3.20 FR-4 —— Claude 状态行 sidecar 读取器；快照刷新时用于从实时状态
  // 填充 Claude 会话为空的恢复令牌。该依赖可选且采用结构化类型；旧接线/测试省略
  // 时，Claude 空值填充静默不操作，Codex 行为保持不变。
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string } } | { ok: false; reason: string };
  };
}

export class ResumeMetadataRefresher {
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;
  private listProcesses: () => Array<{ pid: number; ppid: number; command: string }> | Promise<Array<{ pid: number; ppid: number; command: string }>>;
  private readCodexThreadIdByPid: (pid: number, identity?: string) => Promise<string | undefined> | string | undefined;
  private probeClaudeResume: (sessionName: string, resumeToken: string, cwd?: string | null) => Promise<"resumable" | "not_resumable" | "inconclusive">;
  private resolveHomeDirByPid: ResolveHomeDirByPid;
  private sleep: (ms: number) => Promise<void>;
  private homeDir: string;
  private contextUsageStore: ResumeMetadataRefresherDeps["contextUsageStore"] | null;

  constructor(deps: ResumeMetadataRefresherDeps) {
    this.sessionRegistry = deps.sessionRegistry;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.listProcesses = deps.listProcesses ?? defaultListProcesses;
    this.resolveHomeDirByPid = deps.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
    // OPR.0.5.3.10（补充）：默认 thread-id 读取优先查默认 home，并使用有界的
    // PID-home 缓存；常见路径无需执行 `ps eww`（一次真实慢跨度样本中有 298 个
    // resolve_home span，平均 8.24 秒）。测试和接管路径注入的
    // readCodexThreadIdByPid 保持不变。
    const threadIdResolver = new CodexThreadIdResolver({
      defaultHome: deps.homeDir ?? os.homedir(),
      resolveHomeDirByPid: this.resolveHomeDirByPid,
    });
    // S10 后续：resolve() 必须提供 identity；无 identity 的读取会显式经过命名的无门禁
    // 逃生口，绝不静默回退（r1 遗留条目 3）。
    this.readCodexThreadIdByPid = deps.readCodexThreadIdByPid
      ?? ((pid, identity) => identity === undefined ? threadIdResolver.resolveUngatedLegacy(pid) : threadIdResolver.resolve(pid, identity));
    this.probeClaudeResume = deps.probeClaudeResume ?? ((sessionName, resumeToken, cwd) => this.defaultProbeClaudeResume(sessionName, resumeToken, cwd));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.homeDir = deps.homeDir ?? os.homedir();
    this.contextUsageStore = deps.contextUsageStore ?? null;
  }

  /**
   * 刷新实时逐席位恢复台账。
   *
   * OPR.0.4.3.20 FR-4（rev1 修复）—— `opts.fillNullOnly` 是周期快照路径（约每
   * 5 分钟一次的调度器及手动路由）使用的快照刷新模式。它只做两件轻量工作，均为
   * 文件读取（类似 FR-3 捕获：Claude sidecar `readSidecar` 与基于 pid 日志的 Codex
   * `captureCodexThreadId`），不执行任何重操作：
   *   1. 只填空值——从实时状态填充 null 令牌，绝不清除已有令牌（rev1-r2）。当前
   *      无法恢复但仍存在的 Claude 令牌会保留在常规快照台账中，供 FR-6 显示为
   *      `stale/unverified — re-verify`，而不是在 FR-6 读取前被清空。不变量是：快照
   *      刷新绝不清除已有令牌。
   *   2. 不做重量级可恢复性探测——绝不运行 `probeClaudeResume`（它会为每个现有
   *      Claude 席位启动真实 `claude --resume` tmux 会话）。每次周期 tick 都对实时
   *      席位永久启动 N 个探测进程会造成不可接受的重复影响（rev1-r1）。可恢复性
   *      验证是 FR-6 的按需任务，不属于周期快照操作。
   *
   * 默认模式（`fillNullOnly` 为假）保留非快照/拆除 auto-pre-down 路径原有的校验、探测和清除
   * 行为。它是关机时的一次性检查，此处不作改变；FR-6 §2.1b 负责统一所有调用方的清除语义。
   */
  async refresh(
    sessions: ResumeRefreshSession[],
    opts?: {
      fillNullOnly?: boolean;
      /** OPR.0.5.3.10 微型需求 2——周期范围的进程列表器；整个 tick、所有工作组和席位只做一次
       * 清点。缺省时使用实例列表器。 */
      listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
    },
  ): Promise<void> {
    const fillNullOnly = opts?.fillNullOnly === true;
    // 快照时发现只尝试一次（mini-req 2）：8 次尝试、每次休眠 250ms 的循环用于处理
    // 接管边界与 codex 启动竞态；若用于周期 tick，会永久成倍增加每席位的 `ps` 进程。
    const captureOpts = { attempts: fillNullOnly ? 1 : undefined, listProcesses: opts?.listProcesses };
    for (const session of sessions) {
      if (session.runtime === "codex") {
        if (session.resumeToken) {
          // OPR.0.4.3.20 FR-6.1：在周期性填空路径上，对值相等的令牌轻量重新标记新鲜度，
          // 避免仍存在且有效的令牌在超过 FR-6 阈值后被错误老化为 `stale — re-verify`。通过 FR-3
          // 使用的同一纯读取辅助函数重新派生（getPanePid → 按 pid 定键的日志；不探测、不启动进程、
          // 不执行 `claude --resume`、不启动席位），且只在完全匹配时刷新新鲜度。
          if (fillNullOnly) {
            const derived = await this.captureCodexThreadId(session.sessionName, captureOpts);
            if (derived && derived === session.resumeToken) {
              // 已存在且匹配即为真实正向证据；通过 FR-6 标记刷新新鲜度，绝不调用
              // updateResumeToken，因而不会覆盖令牌或来源信息。
              this.sessionRegistry.markResumeProbeResult(session.sessionId, "resumable");
            }
            // 不同或缺失（已滚动或无法派生）时不操作：不刷新时间，也不覆盖；留给
            // FR-6 如实标记 stale/re-verify，并由 FR-7 在恢复时回滚。
          }
          continue;
        }

        const threadId = await this.captureCodexThreadId(session.sessionName, captureOpts);
        if (threadId) {
          this.sessionRegistry.updateResumeToken(session.sessionId, "codex_id", threadId, "scrape");
        }
        continue;
      }

      if (session.runtime === "claude-code") {
        if (!session.resumeToken) {
          // OPR.0.4.3.20 FR-4 —— 从 Claude 状态行 sidecar 填充空值。尽力而为；
          // 缺失、解析错误或空值均保持 null，绝不抛出。`scrape` 来源（rank 0）只填充
          // 空槽，绝不覆盖信任度更高的 adoption/hook/operator 令牌（FR-3 排名守卫）。
          const sidecar = this.contextUsageStore?.readSidecar(session.sessionName);
          if (sidecar?.ok) {
            const token = sidecar.data.session_id;
            if (typeof token === "string" && token.trim().length > 0) {
              this.sessionRegistry.updateResumeToken(session.sessionId, "claude_id", token.trim(), "scrape");
            }
          }
          continue;
        }
        // 已存在令牌。
        // OPR.0.4.3.20 FR-4（rev1 修复）：快照刷新（仅填空）模式下，在探测前返回。周期快照路径
        // 绝不启动重量级 `claude --resume` 探测（rev1-r1），也绝不清除已有令牌（rev1-r2）。
        // 已存在但不可续接的令牌留在台账中，供 FR-6 呈现为 `stale/unverified — re-verify`。
        // 只有旧版/拆除默认路径会探测并清除，即关机时的一次性检查。
        if (fillNullOnly) {
          // OPR.0.4.3.20 FR-6.1 —— 周期路径在值相等时重新标记新鲜度。不做探测，
          // 绝不启动 `claude --resume`。通过只读状态行 sidecar 重新派生，且仅在与
          // 存储令牌完全匹配时刷新。不同、缺失、解析错误或不可读时均不操作，不刷新
          // 时间也不覆盖令牌，留给 FR-6 与 FR-7 如实处理。
          const sidecar = this.contextUsageStore?.readSidecar(session.sessionName);
          if (sidecar?.ok) {
            const derived = sidecar.data.session_id;
            if (typeof derived === "string" && derived.trim().length > 0 && derived.trim() === session.resumeToken) {
              this.sessionRegistry.markResumeProbeResult(session.sessionId, "resumable");
            }
          }
          continue;
        }
        const probe = await this.probeClaudeResume(session.sessionName, session.resumeToken, session.cwd ?? null);
        // OPR.0.4.3.20 FR-6 §2.1b：记录探测结果但不清除令牌。`not_resumable`/`inconclusive`
        // 将已有令牌标为 stale，计划显示 `stale — re-verify`；`resumable` 则标记新鲜度。令牌保留
        // 原位，已轮换但仍存在的令牌不再被静默置空；真正不可续接的令牌由 FR-7 在恢复时回滚。
        this.sessionRegistry.markResumeProbeResult(session.sessionId, probe);
      }
    }
  }

  /** 尽力从实时 pane 状态派生 Codex thread id（getPanePid → codex 后代 pid →
   * 按 pid 索引的日志 SQLite）。异步执行，超时或缺失时返回 undefined。公开此方法
   * 供接管边界捕获（OPR.0.4.3.20 FR-3）复用，不改变拆除路径的抓取行为。 */
  async captureCodexThreadId(
    sessionTarget: string,
    opts?: {
      /** OPR.0.5.3.10 mini-req 2 —— 快照刷新传入 1；重试循环只用于接管边界与
       * 正在启动的 codex 竞态，绝不用于周期 tick。 */
      attempts?: number;
      /** 周期级进程清单覆盖值（每个 tick 只执行一次 `ps`，覆盖所有席位）。 */
      listProcesses?: () => Promise<Array<{ pid: number; ppid: number; command: string }>>;
    },
  ): Promise<string | undefined> {
    if (!this.tmuxAdapter.getPanePid) return undefined;
    const attempts = Math.max(1, opts?.attempts ?? 8);
    const listProcesses = opts?.listProcesses ?? this.listProcesses;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const shellPid = await this.tmuxAdapter.getPanePid(sessionTarget);
      if (shellPid) {
        const rows = await listProcesses();
        const codexPids = findCodexDescendantPids(rows, shellPid);
        for (const codexPid of codexPids) {
          // 从同一份进程清单取得 pid+启动时间身份（r1 复用守卫）。
          const identity = (rows.find((r) => r.pid === codexPid) as { startedAt?: string } | undefined)?.startedAt;
          const threadId = await this.readCodexThreadIdByPid(codexPid, identity);
          if (threadId) return threadId;
        }
      }
      if (attempt < attempts - 1) await this.sleep(250);
    }

    return undefined;
  }

  private async defaultProbeClaudeResume(
    sessionName: string,
    resumeToken: string,
    cwd?: string | null,
  ): Promise<"resumable" | "not_resumable" | "inconclusive"> {
    const command = buildNativeResumeCommand("claude-code", resumeToken, sessionName);
    if (!command) {
      return "not_resumable";
    }

    const probeSession = `rigged-refresh-${sanitizeTmuxName(sessionName)}-${Date.now().toString(36)}`;
    const create = this.tmuxAdapter.deliveryGuard
      ? await this.tmuxAdapter.createProbeSession(probeSession, resolveProbeCwd(cwd, this.homeDir))
      : await this.tmuxAdapter.createSession(probeSession, resolveProbeCwd(cwd, this.homeDir));
    if (!create.ok) {
      return "inconclusive";
    }

    try {
      const shellReady = await this.waitForProbeShellReady(probeSession);
      if (!shellReady) {
        return "inconclusive";
      }

      const send = await this.tmuxAdapter.sendText(probeSession, command);
      if (!send.ok) {
        return "inconclusive";
      }
      const enter = await this.tmuxAdapter.sendKeys(probeSession, ["Enter"]);
      if (!enter.ok) {
        return "inconclusive";
      }

      const attempts = 24;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const paneCommand = await this.tmuxAdapter.getPaneCommand(probeSession);
        const paneContent = (await this.tmuxAdapter.capturePaneContent(probeSession, 80)) ?? "";
        const result = assessNativeResumeProbe({
          runtime: "claude-code",
          paneCommand,
          paneContent,
        });

        if (result.status === "resumed") {
          return "resumable";
        }
        if (result.status === "failed") {
          return "not_resumable";
        }

        if (attempt < attempts - 1) {
          await this.sleep(250);
        }
      }

      return "inconclusive";
    } finally {
      await this.tmuxAdapter.killSession(probeSession);
    }
  }

  private async waitForProbeShellReady(sessionName: string): Promise<boolean> {
    const attempts = 16;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmuxAdapter.getPaneCommand(sessionName);
      const paneContent = (await this.tmuxAdapter.capturePaneContent(sessionName, 20)) ?? "";
      if (isProbeShellReady({ paneCommand, paneContent })) {
        return true;
      }
      if (attempt < attempts - 1) {
        await this.sleep(250);
      }
    }

    return false;
  }
}

// 导出供单元测试（B12-T）使用：这是真实异步采样路径。反空验证测试直接驱动该默认
// 实现（其他测试套件均注入同步 stub），并断言 B12 前同步实现所违反的非阻塞属性。
export async function defaultListProcesses(): Promise<Array<{ pid: number; ppid: number; command: string }>> {
  try {
    return await defaultListProcessesStrict();
  } catch {
    return [];
  }
}

/** OPR.0.5.3.10 r2-B2 —— 严格的生产进程列表器：`ps` 启动失败时拒绝，而不是
 * 降级为空数组。这是进程清单的默认实现；若经过上方宽松变体，枚举失败会在整个
 * 新鲜度窗口内变成缓存的空成功（r2 判别样本：实际有 520 条时缓存为 0 条）。
 * 宽松变体仍为希望尽力而为的直接逐次调用方保留原契约。 */
export async function defaultListProcessesStrict(): Promise<Array<{ pid: number; ppid: number; command: string; startedAt: string }>> {
  const output = await runAsyncSite("resume_metadata.list_processes", async () => {
    // lstart 是进程启动时间，也是 pid+启动时间身份的一半（r1 的 pid 复用修复）：
    // pid 被复用时 lstart 会变化，持有上个周期身份的消费者无需额外启动进程即可失效。
    const { stdout } = await execFileAsync("ps", ["-Ao", "pid,ppid,lstart,command"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  });
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // lstart 是固定的 5-token 块，例如 "Sun Aug 23 18:52:01 2026"。
      const match = line.match(/^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        startedAt: match[3] ?? "",
        command: match[4] ?? "",
      };
    })
    .filter((row): row is { pid: number; ppid: number; command: string; startedAt: string } => row !== null);
}

function findCodexDescendantPids(
  processes: Array<{ pid: number; ppid: number; command: string }>,
  parentPid: number
): number[] {
  const childrenByParent = new Map<number, Array<{ pid: number; command: string }>>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid) ?? [];
    siblings.push({ pid: proc.pid, command: proc.command });
    childrenByParent.set(proc.ppid, siblings);
  }

  const matches: number[] = [];
  const visit = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      visit(child.pid);
      if (commandLooksLikeCodex(child.command)) {
        matches.push(child.pid);
      }
    }
  };

  visit(parentPid);
  return matches;
}

function readCodexThreadIdFromLogs(
  pid: number,
  resolvedHome: string | undefined,
  homeDir: string
): string | undefined {
  return readCodexThreadIdFromCandidateHomes(pid, [resolvedHome, homeDir, os.homedir()]);
}

function commandLooksLikeCodex(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    const base = nodePath.basename(unquoted);
    return base === "codex";
  });
}

function sanitizeTmuxName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveProbeCwd(cwd: string | null | undefined, homeDir: string): string {
  if (!cwd || cwd === ".") {
    return process.cwd();
  }
  return cwd;
}
