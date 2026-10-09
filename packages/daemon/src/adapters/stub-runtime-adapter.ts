// OPR.0.5.1.1——stub runtime adapter（A5/ContextMonitor 收口）。
//
// 将 claude-stub seed 提升为一等 `runtime: stub`。采用 Pi 形态：node 脚本 runner 承载于席位
// 常规 tmux pane（stub-runner.ts），通过 tmux 启动；其就绪状态从 runner 生成的 sidecar 读取，
// 绝不使用 pane 启发式规则。stub 运行与 runtime 无关的真实生命周期（真实投影 + 向 cwd 投递
// 启动文件），不捏造输出（A5 绑定：stub 触发真实接缝，绝不伪造）。
//
// 第 4 步范围（A5 首个生产 RED 顺序第 4 项）：四个 RuntimeAdapter 动词 + runner + 注册，
// 使 STEP2/STEP3/FACT2/FACT3 转绿（以及 FACT4 restore + FACT5a-d readiness）。A5
// ContextMonitor GAP-1/GAP-2 改动（通过 ContextUsageStore 提供 ctx%）及四个 seed 行为属于后续
// RED 优先增量（A5 第 5–8 项），有意不在此处实现。

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { yoloEnabled, type ResolvedLaunchPosture } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import {
  stubSeatSidecarPath, buildStubRunnerCommand, parseStubRunnerState,
  type StubRunnerState,
} from "./stub-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface StubAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

export interface StubRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  /** 真实文件系统操作。在最小/隔离测试构造中缺失；此时 adapter 回退到内存启动记录判断
   * readiness，且不执行真实文件系统写入（因此 `cwd: "."` 绑定绝不会污染后台服务自身工作
   * 目录）。生产环境始终注入它。 */
  fsOps?: StubAdapterFsOps;
  /** Runtime 标签，默认为 "stub"；作为依赖接收，以便测试为其命名。 */
  runtime?: string;
  /** daemon dist 中已编译 stub-runner 入口的绝对路径。存在时 launchHarness 启动真实 runner
   *（必须执行存在性快速失败）；缺失时 launchHarness 采用隔离的内存路径。 */
  runnerEntryPath?: string;
  sleep?: (ms: number) => Promise<void>;
  /** 启动尝试 id 铸造（测试注入；默认为 randomUUID）。 */
  newLaunchId?: () => string;
}

/** 内存启动记录：隔离路径（无 fsOps、无 runner）的 readiness 回退，以 tmux session 为键。 */
interface StubLaunchRecord {
  ready: boolean;
  launchId: string;
  exited?: { code: number | null };
}

export class StubRuntimeAdapter implements RuntimeAdapter {
  readonly runtime: string;
  private tmux: TmuxAdapter;
  private fsOps?: StubAdapterFsOps;
  private runnerEntryPath?: string;
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;
  private readonly launchRecords = new Map<string, StubLaunchRecord>();

  constructor(deps: StubRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fsOps = deps.fsOps;
    this.runtime = deps.runtime ?? "stub";
    this.runnerEntryPath = deps.runnerEntryPath;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    // 全新 stub 席位在投影运行前不跟踪任何内容；MVP 没有可枚举的持久内容
    //（镜像 terminal/无 skill 的 pi）。如实返回空列表。
    return [];
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) projected.push(entry.effectiveId);
        else skipped.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        if (!this.fsOps) throw new Error("未配置 fsOps——无法读取启动文件内容");
        const content = this.fsOps.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            if (!this.mergeGuidance(targetPath, file.path, content)) continue; // 跳过 rig-role。
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".openrig", "stub", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fsOps.mkdirp(targetDir);
            this.fsOps.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "未绑定 tmux session——无法启动 stub harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken 与 forkSource 互斥——请选择一个" };
    }
    if (opts.forkSource) {
      // stub runtime 没有原生 fork 原语（seed 行为不包含 session fork）；按契约明确拒绝，
      // 而不是猜测。
      return { ok: false, error: "stub runtime 没有原生 fork 原语；请移除 stub member 的 session_source" };
    }

    const sessionName = binding.tmuxSession;
    const launchId = this.newLaunchId();

    if (this.runnerEntryPath) {
      // 生产路径：启动真实的 pane 承载 runner。必须执行 runner 存在性快速失败（A5 HIGH-6）：
      // 发布包缺失 runner 是立即发生的硬失败，绝不能静默挂起。
      if (!this.fsOps || !this.fsOps.exists(this.runnerEntryPath)) {
        return { ok: false, error: `${this.runnerEntryPath} 中未找到 stub-runner 入口——后台服务包不完整` };
      }
      const posture: ResolvedLaunchPosture = yoloEnabled(process.env, binding.launchPosture) ? "full_bypass" : "floor";
      const cmd = buildStubRunnerCommand({
        runnerEntryPath: this.runnerEntryPath,
        sessionName,
        cwd: binding.cwd,
        launchId,
        posture,
        resumeToken: opts.resumeToken,
      });
      const textResult = await this.tmux.sendText(sessionName, cmd);
      if (!textResult.ok) return { ok: false, error: `发送 stub 启动命令失败：${textResult.message}` };
      const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
      if (!enterResult.ok) return { ok: false, error: `发送 Enter 失败：${enterResult.message}` };

      const ready = await this.waitForRunnerReady(binding, launchId);
      if (!ready.ok) return ready.failure;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: opts.resumeToken ? "stub_session" : undefined };
    }

    // 隔离路径（未配置 runner）：把启动记为 readiness 来源并返回。不写真实文件系统，因此
    // `cwd: "."` 绑定绝不会污染后台服务自身工作目录。
    this.launchRecords.set(sessionName, { ready: true, launchId });
    return { ok: true, resumeToken: opts.resumeToken, resumeType: opts.resumeToken ? "stub_session" : undefined };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    const sessionName = binding.tmuxSession;
    if (!sessionName) return { ready: false, reason: "未绑定 tmux session" };

    // Readiness 证据：注入 fsOps 时使用 runner 生成的 sidecar（生产 + FACT5），否则使用内存
    // 启动记录（隔离 FACT3/FACT4）。
    const state: StubRunnerState | StubLaunchRecord | null = this.fsOps
      ? this.readReadinessSidecar(binding.cwd)
      : this.launchRecords.get(sessionName) ?? null;

    if (!state) return { ready: false, reason: "stub 席位尚未报告 readiness", code: "awaiting_runtime" };
    if (state.exited) {
      return { ready: false, reason: `stub-runner 已退出（退出码 ${state.exited.code ?? "未知"}）`, code: "runner_exited" };
    }
    if (!state.ready) return { ready: false, reason: "stub-runner 尚未报告 ready", code: "awaiting_runtime" };

    // Liveness 交叉检查——只在 tmux surface 支持时执行（生产环境注入完整 tmux；隔离构造传入
    // 最小/空 tmux，因此上述内存记录为权威，绝不访问 tmux）。仅凭 ready sidecar/记录不能证明
    // 当前活性：runner 终止后 pane 会停在 shell，陈旧 sidecar 可能继续存在。
    if (this.fsOps) {
      if (typeof this.tmux?.hasSession === "function") {
        if (!(await this.tmux.hasSession(sessionName))) {
          return { ready: false, reason: "tmux session 无响应" };
        }
      }
      if (typeof this.tmux?.getPaneCommand === "function") {
        const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
        if (SHELL_COMMANDS.has(paneCommand)) {
          return { ready: false, reason: "stub readiness 已陈旧；pane 已返回 shell", code: "runner_exited" };
        }
      }
    }

    return { ready: true };
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────────

  private readReadinessSidecar(cwd: string): StubRunnerState | null {
    if (!this.fsOps) return null;
    const sidecarPath = stubSeatSidecarPath(cwd);
    if (!this.fsOps.exists(sidecarPath)) return null;
    try {
      return parseStubRunnerState(this.fsOps.readFile(sidecarPath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    binding: NodeBinding,
    launchId: string,
  ): Promise<{ ok: true } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    const attempts = 60; // 约 15 秒：runner 启动 + 首次 sidecar 写入。
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readReadinessSidecar(binding.cwd);
      // 启动尝试范围（Pi 先例）：只认可当前尝试的 sidecar，因此旧 runner 实例的持久产物不会
      // 让本次启动误绿或误失败。
      if (state && state.launchId === launchId) {
        if (state.exited) {
          return {
            ok: false,
            failure: { ok: false, error: `stub launch 失败：runner 已退出（退出码 ${state.exited.code ?? "未知"}）`, recovery: "attention_required" },
          };
        }
        if (state.ready) return { ok: true };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: { ok: false, error: "stub launch：等待 runner 报告 ready 超时", recovery: "attention_required" },
    };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (!this.fsOps) return false;
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      return this.mergeGuidance(targetPath, entry.effectiveId, this.fsOps.readFile(entry.absolutePath));
    }
    if (entry.category === "skill") {
      const targetDir = nodePath.join(binding.cwd, ".openrig", "stub", "skills", entry.effectiveId);
      this.fsOps.mkdirp(targetDir);
      const isDir = this.fsOps.listFiles ? this.fsOps.listFiles(entry.absolutePath).length > 0 : false;
      if (isDir && this.fsOps.listFiles) {
        for (const file of this.fsOps.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fsOps.mkdirp(nodePath.dirname(dest));
          this.fsOps.writeFile(dest, this.fsOps.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fsOps.writeFile(nodePath.join(targetDir, nodePath.basename(entry.absolutePath)), this.fsOps.readFile(entry.absolutePath));
      }
      return true;
    }
    // MVP 中插件/子智能体/runtime 资源没有 stub 投影目标。
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    if (!this.fsOps) return false;
    // 逐席位 rig-role 内容合并到共享 cwd 文件时会在 pod 同伴间冲突，因此改由 send_text 投递
    //（镜像其他 adapter）。
    if (blockId === "rig-role") return false;
    mergeManagedBlock(this.fsOps, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}
