import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface UnarchiveResult {
  ok: boolean;
  rigId: string;
  unarchived?: boolean;
}

/**
 * `zrig unarchive <rigId>` - OPR.0.3.3.19。`rig archive` 的逆操作：清除
 * `archived_at` 标记，使工作组回到默认浏览器与 `rig ps` 视图。
 * 始终是非破坏性的（归档期间该行与快照均被保留）；没有 `--force`，也不阻止
 * 运行中的工作组——反归档只是让工作组重新可见。
 */
export function unarchiveCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("unarchive").description(
    "反归档一个工作组（'rig archive' 的逆操作）：使其回到默认视图。始终安全。",
  );
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rigId>", "要反归档的工作组标识")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (rigId: string, opts: { json?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<UnarchiveResult | { error: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/unarchive`,
        {},
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status === 404) {
        console.error(`未找到工作组：${rigId}。列出已归档工作组：zrig ps --include-archived`);
        process.exitCode = 1;
        return;
      }
      if (res.status >= 400) {
        console.error(`反归档失败（HTTP ${res.status}）。`);
        process.exitCode = 2;
        return;
      }

      const r = res.data as UnarchiveResult;
      if (r.unarchived) {
        console.log(`工作组 ${rigId} 已反归档，回到默认视图。`);
      } else {
        console.log(`工作组 ${rigId} 此前未归档。`);
      }
    });

  return cmd;
}
