import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ArchiveResult {
  ok: boolean;
  rigId: string;
  archived?: boolean;
}

interface ThreePartErrorBody {
  error:
    | { fact: string; consequence: string; action: string }
    | string;
}

/**
 * `zrig archive <rigId>` - OPR.0.3.3.19。软归档、可逆：把工作组从默认资源浏览器
 * 与 `zrig ps` 中隐藏，同时保留工作组记录、拓扑与快照。这**不是** `zrig down --delete`
 * （后者是破坏性的）。用 `zrig unarchive <rigId>` 撤销。运行中或降级的工作组需要 `--force`。
 */
export function archiveCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("archive").description(
    "归档工作组（软归档、可逆：从默认视图隐藏，保留全部数据）。不是删除；用 'zrig unarchive' 撤销。",
  );
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rigId>", "要归档的工作组标识")
    .option("--force", "即使工作组正在运行或已降级也归档")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (rigId: string, opts: { force?: boolean; json?: boolean }) => {
      const deps = getDepsF();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<ArchiveResult | ThreePartErrorBody>(
        `/api/rigs/${encodeURIComponent(rigId)}/archive`,
        { force: opts.force ?? false },
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 2 : 1;
        return;
      }

      if (res.status === 404) {
        console.error(`未找到工作组：${rigId}。用以下命令查看 ID：zrig ps`);
        process.exitCode = 1;
        return;
      }
      // AC-6：未带 --force 且工作组运行中/降级时，返回三段式如实错误。
      if (res.status === 409) {
        const err = (res.data as ThreePartErrorBody).error;
        if (err && typeof err === "object") {
          process.stderr.write(`错误：${err.fact}\n${err.consequence}\n${err.action}\n`);
        } else {
          process.stderr.write(`错误：${String(err)}\n`);
        }
        process.exitCode = 2;
        return;
      }
      if (res.status >= 400) {
        console.error(`归档失败（HTTP ${res.status}）。`);
        process.exitCode = 2;
        return;
      }

      const r = res.data as ArchiveResult;
      if (r.archived) {
        console.log(`工作组 ${rigId} 已归档（可逆）。它已从默认视图隐藏。`);
        console.log(`  查看它：  zrig ps --include-archived`);
        console.log(`  恢复它：  zrig unarchive ${rigId}`);
      } else {
        console.log(`工作组 ${rigId} 此前已归档。`);
      }
    });

  return cmd;
}
