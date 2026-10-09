import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import nodePath from "node:path";
import { ConfigStore } from "../config-store.js";
import {
  reconcileSkillLoadout,
  resolveSkillLoadout,
  type SkillRuntime,
} from "@openrig/daemon/skill-loadout";

interface AuditFinding {
  class: string;
  file: string;
  reason: string;
  remediation: string;
}

interface AuditEntry {
  id: string;
  path: string;
  sourceKind: string;
  shadowed: boolean;
  stage: string | null;
  verified: { status: string; date?: string; source?: string };
  contentHash: string;
  state: string;
  owner: string | null;
  sourceRef: string | null;
  findings: AuditFinding[];
}

interface AuditResponse {
  ok: boolean;
  entries: AuditEntry[];
  totalFindings: number;
  mirrorDriftError?: string;
  error?: string;
}

export function skillCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("skill").description("技能管理与审计");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("loadout")
    .description("检查或为某个 Claude/Codex 工作目录调和组合出的受管技能负载")
    .requiredOption("--runtime <runtime>", "目标运行时：claude-code 或 codex")
    .option("--cwd <path>", "目标工作目录（默认：当前目录）")
    .option("--project-root <path>", "其 project.yaml 提供 install.skills 的项目根（默认：cwd）")
    .option("--topology <ids>", "逗号分隔的拓扑/剖面技能标识")
    .option("--apply", "应用调和后的负载；默认仅只读检查")
    .option("--json", "JSON 输出")
    .action((opts: {
      runtime: string;
      cwd?: string;
      projectRoot?: string;
      topology?: string;
      apply?: boolean;
      json?: boolean;
    }) => {
      if (opts.runtime !== "claude-code" && opts.runtime !== "codex") {
        console.error("invalid_runtime：--runtime 必须为 claude-code 或 codex");
        process.exitCode = 1;
        return;
      }
      const runtime = opts.runtime as SkillRuntime;
      const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
      const projectRoot = nodePath.resolve(opts.projectRoot ?? cwd);
      const topologySkills = (opts.topology ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const catalogRoot = String(new ConfigStore().resolveWithSource("skills.root").value);
      const resolved = resolveSkillLoadout({ catalogRoot, topologySkills, projectRoot });
      if (!resolved.ok) {
        if (opts.json) console.log(JSON.stringify(resolved, null, 2));
        else for (const error of resolved.errors) console.error(`${error.code}: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      const projection = reconcileSkillLoadout({ loadout: resolved.loadout, runtime, cwd, apply: opts.apply === true });
      if (opts.json) {
        console.log(JSON.stringify({ ...resolved, projection }, null, 2));
      } else {
        console.log(`catalog ${resolved.loadout.catalogRoot} @ ${resolved.loadout.catalogRevision ?? "unused"}`);
        for (const receipt of projection.receipts) {
          console.log(`${receipt.status.padEnd(11)} ${receipt.id} <- ${receipt.selectedBy.join("+")} -> ${receipt.target}`);
          console.log(`  ${receipt.revision} ${receipt.digest} ${receipt.detail}`);
        }
        for (const id of projection.removed) console.log(`已移除     ${id}（已取消选中、有归属、未改动）`);
        if (projection.freshLaunchRequired) {
          console.log("需重启     先启动一个新的席位进程，再期望环境技能集发生变化");
        }
        if (resolved.loadout.entries.length === 0 && projection.removed.length === 0) console.log("空         未选中任何受管技能");
        if (!opts.apply) console.log("只读       加 --apply 重新运行以执行调和");
        for (const error of projection.errors) console.error(`${error.code}: ${error.message}`);
      }
      if (!projection.ok) process.exitCode = 1;
    });

  cmd
    .command("audit")
    .description("只读的技能来源与新鲜度审计")
    .option("--json", "JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.get<AuditResponse>("/api/skills/audit");
      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `审计失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      const { entries, totalFindings, mirrorDriftError } = res.data;
      const hasFail = totalFindings > 0 || !!mirrorDriftError;

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (hasFail) process.exitCode = 1;
        return;
      }

      const active = entries.filter((e) => !e.shadowed);
      const shadowed = entries.filter((e) => e.shadowed);
      const withFindings = active.filter((e) => e.findings.length > 0);

      console.log(`技能审计：${active.length} 个活跃，${shadowed.length} 个被遮蔽，${totalFindings} 项发现\n`);

      if (withFindings.length > 0) {
        console.log("发现项：");
        for (const entry of withFindings) {
          for (const f of entry.findings) {
            console.log(`  [${f.class}] ${entry.id}`);
            console.log(`    文件：${f.file}`);
            console.log(`    原因：${f.reason}`);
            console.log(`    修复：${f.remediation}`);
          }
        }
        console.log("");
      }

      if (mirrorDriftError) {
        console.log(`镜像漂移检查不可用：${mirrorDriftError}`);
        console.log("");
      }

      if (shadowed.length > 0) {
        console.log("被遮蔽：");
        for (const s of shadowed) {
          console.log(`  ${s.id} 位于 ${s.path}（${s.sourceKind}）—— 被优先级更高的胜出项遮蔽`);
        }
        console.log("");
      }

      if (hasFail) {
        const parts: string[] = [];
        if (totalFindings > 0) parts.push(`活跃技能上有 ${totalFindings} 项发现`);
        if (mirrorDriftError) parts.push("镜像漂移检查不可用");
        console.log(`失败：${parts.join("；")}`);
        process.exitCode = 1;
      } else {
        console.log("通过：所有活跃技能均有来源且新鲜度已验证");
      }
    });

  return cmd;
}
