// OPR.0.3.4.1 —— rig start：一键恢复编排器。
// 编排既有原语：daemon-start -> 观察内核自动引导 -> 列出候选
// （可恢复快照）-> 选择器/标志 -> 逐工作组恢复（slice-02 /api/up）+ 对账
// （slice-03）。不重新实现任何东西。

import { Command } from "commander";
import { DaemonClient, DaemonConnectionError } from "../client.js";
import {
  getDaemonStatus,
  getDaemonUrl,
  startDaemon,
  waitForKernelReady,
  type LifecycleDeps,
} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;
const KERNEL_WAIT_MS = 60_000;

interface RigSummary {
  id: string;
  name: string;
  nodeCount?: number;
  lifecycleState?: string;
}

interface PlanPreviewNode {
  logicalId: string;
  intendedAction: string;
  reason?: string;
  // OPR.0.4.3.20 FR-6 —— 线上逐席位 token 真相（rig start 的选择器
  // 只聚合 intendedAction；`rig up --plan` 逐席位渲染这些）。
  tokenState?: "present" | "missing" | "stale" | "unverified";
  provenance?: string | null;
  lastVerified?: string | null;
  freshRequired?: boolean;
  runtimePrompt?: string;
}

interface PlanPreviewResponse {
  status: string;
  mode: string;
  rigId: string;
  rigName: string;
  snapshot: { id: string; kind: string; createdAt: string } | null;
  wouldCaptureCurrentState: boolean;
  nodes: PlanPreviewNode[];
  mutated: boolean;
}

export interface StartCandidate {
  rigId: string;
  rigName: string;
  lifecycleState: string;
  nodeCount: number;
  lastActivity: string | null;
  preview: PlanPreviewResponse | null;
}

/** 默认交互式 [y/N] 提示（与 up.ts 同形，供 TTY 路径复用）。 */
async function defaultPromptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** TTY 用的极简空格多选选择器（NET-NEW，轻量）。 */
async function multiSelectPicker(items: Array<{ label: string; value: string; checked: boolean }>): Promise<string[]> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.close();

  const { createInterface } = readline;
  return new Promise<string[]>((resolve) => {
    const state = items.map((item) => ({ ...item }));
    let cursor = 0;

    const render = () => {
      process.stdout.write("\x1b[?25l");
      for (let i = 0; i < state.length; i++) {
        const prefix = i === cursor ? ">" : " ";
        const check = state[i]!.checked ? "[x]" : "[ ]";
        process.stdout.write(`\r${prefix} ${check} ${state[i]!.label}\n`);
      }
      process.stdout.write(`\r  （空格=切换，回车=确认，a=全选，n=全不选）\n`);
      process.stdout.write(`\x1b[${state.length + 1}A`);
    };

    render();

    if (!process.stdin.isTTY) {
      resolve(state.filter((s) => s.checked).map((s) => s.value));
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write(`\x1b[${state.length + 1}B\r`);
      process.stdout.write("\x1b[?25h");
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === " ") {
        state[cursor]!.checked = !state[cursor]!.checked;
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(state.filter((s) => s.checked).map((s) => s.value));
      } else if (key === "\x1b[A" || key === "k") {
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = Math.min(state.length - 1, cursor + 1);
        render();
      } else if (key === "a") {
        state.forEach((s) => { s.checked = true; });
        render();
      } else if (key === "n") {
        state.forEach((s) => { s.checked = false; });
        render();
      } else if (key === "\x03") {
        cleanup();
        process.exitCode = 130;
        resolve([]);
      }
    };
    process.stdin.on("data", onData);
  });
}

export interface StartDeps extends StatusDeps {
  promptYesNo?: (question: string) => Promise<boolean>;
  /** 测试接缝（与 upCommand 对应）：注入预检 exec，使自动启动测试
   *  绝不运行真实系统命令。 */
  preflightExec?: (cmd: string) => Promise<string>;
}

export function startCommand(depsOverride?: StartDeps): Command {
  const cmd = new Command("start")
    .description("启动后台服务、校验内核，并恢复上次运行中的工作组")
    .addHelpText("after", `
示例：
  zrig start                         交互式：后台服务 + 内核 + 选择并恢复
  zrig start --last                  无头：恢复所有上次运行的内容
  zrig start --all                   无头：恢复所有带可恢复快照的工作组
  zrig start --rigs prod-rig dev-rig 无头：仅恢复指定的工作组
`);
  const getDepsF = (): StartDeps =>
    depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--last", "无头：恢复所有上次运行的工作组（零提示）")
    .option("--all", "无头：恢复所有带可恢复快照的工作组（零提示）")
    .option("--rigs <names...>", "无头：仅恢复指定的工作组（零提示）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { last?: boolean; all?: boolean; rigs?: string[]; json?: boolean }) => {
      const deps = getDepsF();

      // ---- 阶段 1：确保后台服务在运行 ----
      let status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        if (!opts.json) console.log("正在启动后台服务...");
        try {
          const { ConfigStore } = await import("../config-store.js");
          const configStore = new ConfigStore();
          const resolvedConfig = configStore.resolve();
          const hostResolution = configStore.resolveWithSource("daemon.host");
          const { SystemPreflight } = await import("../system-preflight.js");
          const { execSync } = await import("node:child_process");
          const { OPENRIG_DIR, resolveBindIntent } = await import("../daemon-lifecycle.js");
          // S20（r2 修复）：共享的专用意图接缝——环境变量来源的
          // daemon.host（ENV_MAP ← OPENRIG_HOST，注入的路由通道）在自动启动中
          // 绝不产生绑定意图；无标志自动启动只遵从文件来源的 daemon.host 或
          // OPENRIG_BIND_HOST。
          const hostForDaemon = resolveBindIntent({
            flagHost: undefined,
            envBindHost: process.env["OPENRIG_BIND_HOST"],
            configSource: hostResolution.source,
            configHost: resolvedConfig.daemon.host,
          }).host;
          const preflight = new SystemPreflight({
            exec: depsOverride?.preflightExec ?? (async (cmd: string) =>
              execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })),
            configStore,
            getDaemonStatus: () => getDaemonStatus(deps.lifecycleDeps),
            openrigHome: OPENRIG_DIR,
          });
          const preflightResult = await preflight.run();
          if (!preflightResult.ready) {
            for (const check of preflightResult.checks.filter((c) => !c.ok)) {
              console.error(`  ${check.name}：${check.error}`);
              if (check.fix) console.error(`    修复：${check.fix}`);
            }
            process.exitCode = 1;
            return;
          }
          await startDaemon({
            port: resolvedConfig.daemon.port,
            host: hostForDaemon,
            db: resolvedConfig.db.path,
            transcriptsEnabled: resolvedConfig.transcripts.enabled,
            transcriptsPath: resolvedConfig.transcripts.path,
            transcriptsLines: resolvedConfig.transcripts.lines,
            transcriptsPollIntervalSeconds: resolvedConfig.transcripts.pollIntervalSeconds,
            workspaceRoot: resolvedConfig.workspace.root,
            contextRoot: resolvedConfig.context.root,
            skillsRoot: resolvedConfig.skills.root,
            topologyRoot: resolvedConfig.topology.root,
          }, deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch (err) {
          console.error(`后台服务启动失败：${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 2;
          return;
        }
      }

      if (status.state !== "running" || status.healthy === false) {
        console.error("后台服务不健康。用以下命令检查：zrig daemon status");
        process.exitCode = 1;
        return;
      }

      const baseUrl = getDaemonUrl(status);
      const client = deps.clientFactory(baseUrl);

      // ---- 阶段 2：内核不变量——校验/等待内核就绪 ----
      if (!opts.json) console.log("正在等待内核...");
      const kernelResult = await waitForKernelReady(baseUrl, KERNEL_WAIT_MS);
      if (!kernelResult.ok) {
        if (kernelResult.kernelState === "skipped") {
          if (!opts.json) console.log("内核自动引导已跳过（--no-kernel 或测试模式）。");
        } else {
          console.error(`内核启动失败：state=${kernelResult.kernelState ?? "未知"}，detail=${kernelResult.detail ?? "无"}`);
          console.error("没有可用内核无法继续恢复工作组。");
          console.error("修复：解决内核问题后重新运行：zrig start");
          process.exitCode = 1;
          return;
        }
      } else if (!opts.json) {
        console.log("内核就绪。");
      }

      // 在宣布 URL 前确认 UI 真的在服务。
      let uiUrl: string | null = null;
      try {
        const healthRes = await fetch(`${baseUrl}/healthz`);
        if (healthRes.ok) {
          uiUrl = baseUrl;
        }
      } catch { /* UI 尚未服务——优雅降级 */ }
      if (uiUrl && !opts.json) {
        console.log(`UI：${uiUrl}`);
      }

      // ---- 阶段 3：列出上次运行的候选 ----
      let allSummaries: RigSummary[];
      try {
        const res = await client.get<RigSummary[]>("/api/rigs/summary");
        allSummaries = res.data ?? [];
      } catch {
        console.error("列出工作组失败。后台服务可能尚未就绪。");
        process.exitCode = 1;
        return;
      }

      // 守卫 BLOCKING f359e3a3：用基于 id 的 Explorer 路由做候选预览
      // （POST /api/rigs/:id/up 带 plan:true），而非基于名称的
      // POST /api/up——后者在同名工作组上 409 并悄悄丢弃它们。
      const candidates: StartCandidate[] = [];
      // 守卫 BLOCKING bfed4ce3：记录预览错误，避免它们被折叠成干净的空候选结果。
      const previewErrors: Array<{ rigId: string; rigName: string; code: string; message: string }> = [];
      for (const rig of allSummaries) {
        if (rig.name === "kernel") continue;
        if (rig.lifecycleState === "running") continue;

        try {
          const planRes = await client.post<Record<string, unknown>>(
            `/api/rigs/${encodeURIComponent(rig.id)}/up`,
            { plan: true },
          );
          if (planRes.status === 200 && planRes.data["status"] === "plan") {
            const preview = planRes.data as unknown as PlanPreviewResponse;

            let lastActivity: string | null = null;
            try {
              const rigDetail = await client.get<{ sessions?: Array<{ lastSeenAt?: string | null }> }>(`/api/rigs/${rig.id}`);
              const sessions = rigDetail.data?.sessions ?? [];
              const dates = sessions.map((s) => s.lastSeenAt).filter((d): d is string => !!d).sort();
              lastActivity = dates.length > 0 ? dates[dates.length - 1]! : null;
            } catch { /* degrade: lastActivity stays null */ }

            candidates.push({
              rigId: rig.id,
              rigName: rig.name,
              lifecycleState: rig.lifecycleState ?? "unknown",
              nodeCount: rig.nodeCount ?? 0,
              lastActivity,
              preview,
            });
          } else if (planRes.status === 404) {
            // 无快照或未找到——该工作组不是候选（预期排除）。
          } else {
            const code = String(planRes.data["code"] ?? `http_${planRes.status}`);
            const errorText = String(planRes.data["error"] ?? "预览失败");
            previewErrors.push({ rigId: rig.id, rigName: rig.name, code, message: errorText });
            if (!opts.json) console.error(`  ${rig.name}：候选预览失败——${errorText}（${code}）`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          previewErrors.push({ rigId: rig.id, rigName: rig.name, code: "transport_error", message: msg });
          if (!opts.json) console.error(`  ${rig.name}：候选预览不可用（传输错误）`);
        }
      }

      if (candidates.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({
            status: previewErrors.length > 0 ? "started_with_errors" : "started",
            candidates: [],
            restoredRigs: [],
            previewErrors: previewErrors.length > 0 ? previewErrors : undefined,
          }));
        } else {
          if (previewErrors.length > 0) {
            console.error(`${previewErrors.length} 个工作组预览失败（见上方错误）。可能缺少部分候选。`);
          } else {
            console.log("后台服务与内核已就绪。没有需要恢复的工作组。");
          }
        }
        if (previewErrors.length > 0) process.exitCode = 1;
        return;
      }

      // ---- 阶段 4：选择（基于 id，rev1 BLOCKING b4c6ada4）----
      let selectedCandidates: StartCandidate[];
      if (opts.all || opts.last) {
        selectedCandidates = [...candidates];
      } else if (opts.rigs) {
        selectedCandidates = candidates.filter((c) => opts.rigs!.includes(c.rigName));
        const missing = opts.rigs.filter((n) => !candidates.some((c) => c.rigName === n));
        if (missing.length > 0) {
          console.error(`候选集中未找到工作组：${missing.join(", ")}`);
          console.error(`可用候选：${candidates.map((c) => c.rigName).join(", ")}`);
          process.exitCode = 1;
          return;
        }
      } else {
        // TTY 交互式：提供快速默认 + 选择器
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
        if (!interactive) {
          console.error("无可用 TTY。请用 --last、--all 或 --rigs <names> 进入无头模式。");
          if (opts.json) {
            console.log(JSON.stringify({ status: "started", candidates: candidates.map((c) => ({ rigName: c.rigName, lifecycleState: c.lifecycleState })), restoredRigs: [] }));
          }
          process.exitCode = 1;
          return;
        }

        console.log(`\n${candidates.length} 个工作组上次在运行：\n`);
        for (const c of candidates) {
          const readiness = summarizeReadiness(c);
          const activity = c.lastActivity ? `最近活跃 ${c.lastActivity}` : "";
          console.log(`  ${c.rigName}  （${c.nodeCount} 席位，${c.lifecycleState}${activity ? "，" + activity : ""}）  ${readiness}`);
        }
        console.log("");

        const ask = depsOverride?.promptYesNo ?? defaultPromptYesNo;
        const restoreAll = await ask(`恢复全部 ${candidates.length} 个工作组？[Y/选择] `);

        if (restoreAll) {
          selectedCandidates = [...candidates];
        } else {
          const pickedIds = await multiSelectPicker(
            candidates.map((c) => ({
              label: `${c.rigName}  (${c.nodeCount} seats, ${c.lifecycleState})  ${summarizeReadiness(c)}`,
              value: c.rigId,
              checked: true,
            })),
          );
          selectedCandidates = candidates.filter((c) => pickedIds.includes(c.rigId));
        }
      }

      if (selectedCandidates.length === 0) {
        if (!opts.json) console.log("未选择要恢复的工作组。");
        return;
      }

      // ---- 阶段 5：经基于 id 的路由逐个恢复所选工作组（组合 slice-02 路径）----
      if (!opts.json) console.log(`\n正在恢复 ${selectedCandidates.length} 个工作组...\n`);

      const results: Array<{ rigName: string; status: string; nodes: Array<{ logicalId: string; status: string; error?: string }> }> = [];

      for (const candidate of selectedCandidates) {
        const rigName = candidate.rigName;
        const rigId = candidate.rigId;

        // 检查工作组是否已在运行（幂等重跑：对账，不重启）。
        try {
          const freshSummary = await client.get<RigSummary[]>("/api/rigs/summary");
          const current = (freshSummary.data ?? []).find((r) => r.id === rigId);
          if (current?.lifecycleState === "running") {
            if (!opts.json) console.log(`  ${rigName}：已在运行（跳过）`);
            results.push({ rigName, status: "already_running", nodes: [] });
            continue;
          }
        } catch { /* 继续尝试恢复 */ }

        try {
          // Rev1 BLOCKING b4c6ada4：恢复也用基于 id 的路由（不用基于名称的
          // /api/up——后者在同名工作组上 409）。
          const res = await client.post<Record<string, unknown>>(
            `/api/rigs/${encodeURIComponent(rigId)}/up`,
            { plan: false },
            { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
          );

          // 守卫 BLOCKING 25661f72：在把响应当作成功前先检查 HTTP 状态。
          // 后台服务会返回非 2xx JSON 负载（rig_not_stopped、
          // pre_restore_validation_failed、ambiguous_name）而不抛错。
          if (res.status >= 400) {
            const code = res.data["code"] as string | undefined;
            const errorText = String(res.data["error"] ?? "恢复失败");
            if (code === "pre_restore_validation_failed") {
              console.error(`  ${rigName}：恢复被阻止（恢复前校验失败）`);
              const blockers = (res.data["blockers"] as Array<{ message: string; remediation: string }>) ?? [];
              for (const b of blockers) {
                console.error(`    ${b.message}`);
                console.error(`      修复：${b.remediation}`);
              }
            } else {
              console.error(`  ${rigName}：${errorText}（${code ?? `HTTP ${res.status}`}）`);
            }
            results.push({ rigName, status: code ?? "error", nodes: [] });
            continue;
          }

          const resStatus = res.data["status"] as string;
          const nodes = (res.data["nodes"] as Array<{ logicalId: string; status: string; error?: string }>) ?? [];
          const rigResult = res.data["rigResult"] as string | undefined;

          if (!opts.json) {
            console.log(`  ${rigName}：${rigResult ?? resStatus}`);
            for (const n of nodes) {
              if (n.status === "awaiting-decision" && n.error) {
                console.log(`    ${n.logicalId}：awaiting-decision——${n.error}`);
              } else {
                console.log(`    ${n.logicalId}：${n.status}`);
              }
            }
          }

          // 处理 awaiting-decision 询问（组合 slice-02 TTY 流程）。
          const awaiting = nodes.filter((n) => n.status === "awaiting-decision");
          if (awaiting.length > 0) {
            const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) || Boolean(depsOverride?.promptYesNo);
            if (interactive) {
              const ask = depsOverride?.promptYesNo ?? defaultPromptYesNo;
              const accepted: string[] = [];
              for (const n of awaiting) {
                const reason = n.error ?? "原会话不可恢复";
                const yes = await ask(`    无法恢复 ${n.logicalId}（原因：${reason}）。重新 prime？[y/N] `);
                if (yes) accepted.push(n.logicalId);
              }
              if (accepted.length > 0) {
                try {
                  const freshRes = await client.post<Record<string, unknown>>(
                    `/api/rigs/${encodeURIComponent(rigId)}/up`,
                    { plan: false, freshLogicalIds: accepted },
                    { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
                  );
                  if (freshRes.status >= 400) {
                    const freshError = String(freshRes.data["error"] ?? "重新 prime 失败");
                    console.error(`    ${rigName} 重新 prime：${freshError}（HTTP ${freshRes.status}）`);
                  } else {
                    const freshNodes = (freshRes.data["nodes"] as Array<{ logicalId: string; status: string }>) ?? [];
                    for (const fn of freshNodes.filter((fn) => accepted.includes(fn.logicalId))) {
                      if (!opts.json) console.log(`    ${fn.logicalId}：${fn.status}`);
                    }
                  }
                } catch (err) {
                  if (err instanceof DaemonConnectionError) {
                    console.error(`    ${rigName} 重新 prime 超时；后台服务可能仍在处理。用 zrig ps 确认`);
                  } else {
                    throw err;
                  }
                }
              } else if (!opts.json) {
                console.log(`    ${rigName} 未启动任何新会话。`);
              }
            } else {
              // 无头：诚实报告，不自动替换。
              for (const n of awaiting) {
                if (!opts.json) console.error(`    ${n.logicalId}：awaiting-decision——重新 prime 请运行：zrig up --existing ${rigName} --fresh ${n.logicalId}`);
              }
            }
          }

          results.push({ rigName, status: rigResult ?? resStatus, nodes });
        } catch (err) {
          if (err instanceof DaemonConnectionError) {
            console.error(`  ${rigName}：超时；后台服务可能仍在处理。用 zrig ps 确认`);
            results.push({ rigName, status: "timeout", nodes: [] });
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  ${rigName}：${msg}`);
            results.push({ rigName, status: "error", nodes: [] });
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({
          status: previewErrors.length > 0 ? "started_with_errors" : "started",
          uiUrl,
          candidates: candidates.map((c) => ({ rigName: c.rigName, lifecycleState: c.lifecycleState })),
          restoredRigs: results,
          previewErrors: previewErrors.length > 0 ? previewErrors : undefined,
        }));
      }

      // 退出码：若任一工作组结果不干净则为 1。包含 HTTP 错误码
      // 与不干净的 rigResult 值（partially_restored、failed、not_attempted）。
      const NON_CLEAN_STATUSES = new Set(["timeout", "error", "skipped", "partially_restored", "failed", "not_attempted", "rig_not_stopped", "ambiguous_name", "pre_restore_validation_failed"]);
      const hasFailure = previewErrors.length > 0 || results.some((r) =>
        NON_CLEAN_STATUSES.has(r.status) ||
        r.nodes.some((n) => n.status === "failed" || n.status === "awaiting-decision"),
      );
      if (hasFailure) process.exitCode = 1;
    });

  return cmd;
}

function summarizeReadiness(c: StartCandidate): string {
  if (!c.preview) return "";
  const actions = c.preview.nodes.map((n) => n.intendedAction);
  if (actions.every((a) => a === "resume-original")) return "[可恢复原会话]";
  if (actions.some((a) => a === "awaiting-decision")) return "[重新 prime 前会询问]";
  if (actions.every((a) => a === "fresh-primed")) return "[全新启动]";
  return "[混合]";
}
