// OPR.0.3.4.3 — zrig reconcile-session：把一个正在运行、手动恢复过的规范会话
// 重新接回其持久化节点，过程中不启动/重启/结束进程、不重放开机流程、不触发
// 恢复菜单、不做压缩，也绝不向窗格写入任何输入。
// 用于修复"我手动恢复了席位，让后台服务重新看到它"的场景。

import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ReconcileResponse {
  ok: boolean;
  result?: {
    rigId: string;
    rigName: string;
    nodeId: string;
    logicalId: string;
    sessionName: string;
    sessionId: string;
    projectionDrift: string[];
    continuity: string;
  };
  code?: string;
  message?: string;
  error?: string;
}

export function reconcileSessionCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("reconcile-session")
    .description("把正在运行、手动恢复过的会话接回其持久化节点（不启动、不写入输入）");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<session>", "要接回的运行中会话的规范名（例如 dev-impl@my-rig）")
    .option("--rig <rigId>", "消歧义：目标工作组 ID（需与 --node 同时使用）")
    .option("--node <logicalId>", "消歧义：目标节点逻辑 ID（需与 --rig 同时使用）")
    .option("--no-launch", "绝不启动/重启（这是本命令唯一模式，仅为显式声明而接受）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  zrig reconcile-session dev-impl@my-rig --no-launch
  zrig reconcile-session dev-impl@my-rig --rig <rig-id> --node dev.impl --no-launch
  zrig reconcile-session dev-impl@my-rig --json

在规范 tmux 会话内手动恢复席位（claude --resume / codex resume）后使用：
此时后台服务仍显示该席位已下线。reconcile 把运行中的进程绑定到它自己的持久化
节点（节点 id 不变——不重新建立键值），并更新投影，使 rig ps / topology /
send / capture / 队列路由恢复可用。它绝不启动、重启、结束进程、重放开机
流程、按恢复菜单、做压缩或向窗格输入任何字符。凡无法证实的部分都会报告为
投影漂移；绝不声称会话上下文连续。`)
    .action(async (session: string, opts: { rig?: string; node?: string; launch?: boolean; json?: boolean }) => {
      if ((opts.rig && !opts.node) || (!opts.rig && opts.node)) {
        console.error("--rig 与 --node 必须同时提供。");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const body: Record<string, unknown> = {};
      if (opts.rig) body["rigId"] = opts.rig;
      if (opts.node) body["logicalId"] = opts.node;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<ReconcileResponse>(
        `/api/sessions/${encodeURIComponent(session)}/reconcile`,
        body,
        { headers: terminalAuthHeaders() },
      );
      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        if (res.status >= 400 || !data.ok) process.exitCode = 1;
        return;
      }

      if (res.status >= 400 || !data.ok) {
        console.error(data.message ?? data.error ?? `接回失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      const r = data.result!;
      console.log(`已把 ${r.sessionName} 接回工作组 ${r.rigName}`);
      console.log(`  节点：${r.logicalId}（节点 id 不变——未重启、未写入输入）`);
      if (r.projectionDrift.length > 0) {
        console.log("  投影漂移（未能证实的元数据）：");
        for (const d of r.projectionDrift) console.log(`    - ${d}`);
      } else {
        console.log("  投影漂移：未发现");
      }
      console.log(`  会话连续性：${r.continuity}（reconcile 只重新连接投影，不校验对话内容）`);
    });

  return cmd;
}
