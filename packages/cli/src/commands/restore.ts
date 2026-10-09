import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_TIMEOUT_MS = 45_000;

export function restoreCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("restore")
    .description("从快照恢复工作组")
    .addHelpText("after", "\n直接恢复：zrig restore <snapshotId> --rig <rigId>");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("apply <snapshotId>", { isDefault: true, hidden: true })
    .description("从快照恢复工作组")
    .requiredOption("--rig <rigId>", "要恢复到的工作组 ID")
    .action(async (snapshotId: string, opts: { rig: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const rigId = opts.rig;

      // L3：注册 SIGINT/SIGTERM 处理器并如实提示——中断 CLI 客户端并不会
      // 停止后台服务侧的恢复工作。作为后台服务协议的取消能力是独立切片；
      // 先把提示发出来，让操作人员不感到意外。
      const onSignal = () => {
        console.error("已收到客户端中断；后台服务侧的恢复可能仍在继续。用 'zrig ps --nodes' 或 'zrig restore-check' 跟踪进度。");
        process.exit(1);
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);

      const res = await client.post<{
        ok?: boolean;
        attemptId?: number;
        status?: string;
        rigId?: string;
        // 恢复开始前的错误路径保持原有载荷结构。
        rigResult?: string;
        blockers?: RestoreBlocker[];
        nodes?: Array<{
          nodeId: string;
          logicalId: string;
          status: string;
          error?: string;
          canonicalSessionName?: string | null;
          tmuxAttachCommand?: string | null;
          resumeCommand?: string | null;
          recoveryGuidance?: {
            summary: string;
            commands: string[];
            notes: string[];
          } | null;
          cwd?: string | null;
        }>;
        attachCommand?: string;
      }>(
        `/api/rigs/${encodeURIComponent(rigId)}/restore/${encodeURIComponent(snapshotId)}`,
        undefined,
        { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
      );

      if (res.status === 404) {
        console.error(`未找到快照 "${snapshotId}" 或工作组 "${rigId}"。列出快照：zrig snapshot list --rig ${rigId}`);
        process.exitCode = 1;
      } else if (res.status === 409) {
        if ((res.data as { code?: string }).code === "pre_restore_validation_failed") {
          printRestoreNotAttempted(res.data);
          process.exitCode = 1;
          return;
        }
        if ((res.data as { code?: string }).code === "snapshot_unusable") {
          console.error(`已拒绝恢复：${(res.data as { error?: string }).error ?? "所选快照不可用于恢复"}。请另选快照。`);
        } else {
          console.error(`恢复冲突：${(res.data as { error?: string }).error ?? "工作组可能仍在运行"}。请先停止工作组：zrig down ${rigId}`);
        }
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`恢复失败：${(res.data as { error?: string }).error ?? "未知错误"}（HTTP ${res.status}）。请查看后台服务日志或换一个快照。`);
        process.exitCode = 1;
      } else if (res.data.attemptId !== undefined) {
        // L3 成功路径：restore.started 后路由立即返回 202。
        console.log(`恢复尝试 id：${res.data.attemptId}`);
        console.log(`状态：${res.data.status ?? "started"}`);
        console.log("后台服务正在后台逐节点恢复；用 'zrig ps --nodes' 或 'zrig restore-check' 跟踪进度。");
      } else {
        // 防御性处理：服务器返回 ok=true 但未带 attemptId。
        // 若存在旧版摘要则回退使用（滚动升级期间兼容 L3 之前的后台服务）。
        console.log("恢复完成：");
        if (res.data.rigResult) {
          console.log(`工作组结果：${res.data.rigResult}`);
        }
        const nodes = res.data.nodes ?? [];
        for (const node of nodes) {
          const label = node.status === "failed" && node.error ? `${node.status} — ${node.error}` : node.status;
          console.log(`  ${node.logicalId}: ${label}`);
        }
        printRecoveryGuidance(nodes);
        const attachCommand = (res.data as Record<string, unknown>)["attachCommand"] as string | undefined;
        if (attachCommand) {
          console.log(`Attach: ${attachCommand}`);
        }
        if (res.data.rigResult === "partially_restored" || res.data.rigResult === "failed" || res.data.rigResult === "not_attempted" || nodes.some((node) => node.status === "failed")) {
          process.exitCode = 1;
        }
      }
    });

  cmd
    .command("status <attemptId>")
    .description("展示某次恢复尝试当前推导的回执")
    .requiredOption("--rig <rigId>", "包含该恢复尝试的工作组 ID")
    .option("--json", "以 JSON 输出")
    .action(async (attemptId: string, opts: { rig: string; json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.get<{
        ok?: boolean;
        error?: string;
        attemptId?: number;
        snapshotSelection?: { snapshotId: string; mode: string; kind: string; ageMs: number; rationale: string } | null;
        originalResult?: { rigResult: string };
        currentIntendedSetVerdict?: string;
        intendedRoster?: unknown[];
        excludedNodes?: unknown[];
        unresolvedIntendedSeats?: Array<{ logicalId: string; status: string }>;
      }>(`/api/rigs/${encodeURIComponent(opts.rig)}/restore/status/${encodeURIComponent(attemptId)}`);
      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `恢复尝试状态查询失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      console.log(`恢复尝试 ${res.data.attemptId ?? attemptId}`);
      if (res.data.snapshotSelection) {
        console.log(`快照：${res.data.snapshotSelection.snapshotId}（${res.data.snapshotSelection.kind}，${res.data.snapshotSelection.mode}）`);
        console.log(`选择依据：${res.data.snapshotSelection.rationale}`);
      }
      console.log(`原始判定：${res.data.originalResult?.rigResult ?? "未知"}`);
      console.log(`当前预期集合判定：${res.data.currentIntendedSetVerdict ?? "未知"}`);
      console.log(`预期：${res.data.intendedRoster?.length ?? 0}；已排除历史：${res.data.excludedNodes?.length ?? 0}；未解决：${res.data.unresolvedIntendedSeats?.length ?? 0}`);
      for (const node of res.data.unresolvedIntendedSeats ?? []) console.log(`  ${node.logicalId}: ${node.status}`);
    });

  return cmd;
}

interface RestoreBlocker {
  code: string;
  severity?: string;
  logicalId?: string;
  nodeId?: string;
  target?: string;
  path?: string;
  message: string;
  remediation: string;
}

function printRestoreNotAttempted(data: { rigResult?: string; blockers?: RestoreBlocker[]; error?: string }): void {
  console.error(`恢复被阻止：${data.error ?? "恢复前校验失败"}`);
  if (data.rigResult) {
    console.error(`工作组结果：${data.rigResult}`);
  }
  printBlockers(data.blockers ?? []);
}

function printBlockers(blockers: RestoreBlocker[]): void {
  for (const blocker of blockers) {
    const scope = blocker.logicalId ?? blocker.nodeId ?? blocker.target ?? blocker.code;
    console.error(`  ${scope}: ${blocker.message}`);
    if (blocker.path) console.error(`    路径：${blocker.path}`);
    console.error(`    修复措施：${blocker.remediation}`);
  }
}

function printRecoveryGuidance(
  nodes: Array<{
    logicalId: string;
    status: string;
    canonicalSessionName?: string | null;
    tmuxAttachCommand?: string | null;
    recoveryGuidance?: { summary: string; commands: string[]; notes: string[] } | null;
    cwd?: string | null;
  }>,
): void {
  const actionable = nodes.filter((node) =>
    (node.status === "fresh" || node.status === "failed") && node.recoveryGuidance
  );

  if (actionable.length === 0) return;

  console.log("\n恢复指引：");
  for (const node of actionable) {
    console.log(`  ${node.logicalId}: ${node.recoveryGuidance!.summary}`);
    if (node.tmuxAttachCommand) {
      console.log(`    挂载：${node.tmuxAttachCommand}`);
    }
    if (node.canonicalSessionName) {
      console.log(`    会话：${node.canonicalSessionName}`);
    }
    if (node.cwd) {
      console.log(`    工作目录：${node.cwd}`);
    }
    for (const command of node.recoveryGuidance!.commands) {
      console.log(`    $ ${command}`);
    }
    for (const note of node.recoveryGuidance!.notes) {
      console.log(`    备注：${note}`);
    }
  }
}
