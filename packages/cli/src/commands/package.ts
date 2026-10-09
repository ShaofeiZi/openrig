import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function packageCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("package").description("管理智能体包（旧版）");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // zrig package validate <path>
  cmd
    .command("validate <path>")
    .description("校验一个包清单")
    .action(async (sourcePath: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{
        valid: boolean;
        error?: string;
        errors?: string[];
        manifest?: { name: string; version: string; summary: string; runtimes: string[]; exportCounts: Record<string, number> };
      }>("/api/packages/validate", { sourceRef: sourcePath });

      if (res.status >= 400 || !res.data.valid) {
        if (res.data.errors) {
          console.error("校验错误：");
          for (const e of res.data.errors) {
            console.error(`  - ${e}`);
          }
        } else {
          console.error(res.data.error ?? "校验失败");
        }
        process.exitCode = 1;
        return;
      }

      const m = res.data.manifest!;
      console.log(`有效：${m.name} v${m.version}`);
      console.log(`  ${m.summary}`);
      console.log(`  运行时：${m.runtimes.join(", ")}`);
      const ec = m.exportCounts;
      console.log(`  导出：skills: ${ec.skills}, guidance: ${ec.guidance}, agents: ${ec.agents}, hooks: ${ec.hooks}, mcp: ${ec.mcp}`);
    });

  // zrig package plan <path>
  cmd
    .command("plan <path>")
    .description("预览安装计划（演练）")
    .option("--target <dir>", "目标仓库根目录", ".")
    .option("--runtime <runtime>", "运行时（claude-code 或 codex）", "claude-code")
    .option("--role <name>", "要安装的角色")
    .action(async (sourcePath: string, opts: { target: string; runtime: string; role?: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{
        packageName: string;
        packageVersion: string;
        entries: Array<{
          exportType: string;
          exportName: string;
          classification: string;
          targetPath: string;
          deferred: boolean;
          deferReason?: string;
          conflict?: { existingPath: string; reason: string };
        }>;
        actionable: number;
        deferred: number;
        conflicts: number;
        noOps: number;
        error?: string;
        errors?: string[];
      }>("/api/packages/plan", {
        sourceRef: sourcePath,
        targetRoot: opts.target,
        runtime: opts.runtime,
        roleName: opts.role,
      });

      if (res.status >= 400) {
        if (res.data.errors) {
          console.error("校验错误：");
          for (const e of res.data.errors) {
            console.error(`  - ${e}`);
          }
        } else {
          console.error(res.data.error ?? "计划失败");
        }
        process.exitCode = 1;
        return;
      }

      console.log(`计划：${res.data.packageName} v${res.data.packageVersion}`);
      console.log(`  可执行：${res.data.actionable}  延后：${res.data.deferred}  冲突：${res.data.conflicts}  无操作：${res.data.noOps}`);

      if (res.data.entries.length > 0) {
        console.log("");
        for (const e of res.data.entries) {
          const suffix = e.conflict ? ` — ${e.conflict.reason}` : e.deferReason ? ` — ${e.deferReason}` : "";
          console.log(`  ${e.exportType.padEnd(12)} ${e.exportName.padEnd(20)} ${e.classification.padEnd(18)} ${e.targetPath || "（延后）"}${suffix}`);
        }
      }
    });

  // zrig package install <path>
  cmd
    .command("install <path>")
    .description("安装一个包")
    .option("--target <dir>", "目标仓库根目录", ".")
    .option("--runtime <runtime>", "运行时（claude-code 或 codex）", "claude-code")
    .option("--role <name>", "要安装的角色")
    .option("--allow-merge", "允许把受管块合并进已有文件")
    .action(async (sourcePath: string, opts: { target: string; runtime: string; role?: string; allowMerge?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{
        installId?: string;
        packageId?: string;
        packageName?: string;
        applied?: Array<{ exportType: string; action: string; targetPath: string; classification: string; status: string }>;
        deferred?: Array<{ exportType: string; exportName: string; deferReason?: string }>;
        conflicts?: Array<{ existingPath: string; reason: string }>;
        verification?: { passed: boolean };
        policyRejected?: Array<{ entry: { exportType: string; exportName: string }; reason: string }>;
        error?: string;
        errors?: string[];
        code?: string;
        rejected?: Array<{ entry: { exportType: string; exportName: string }; reason: string }>;
      }>("/api/packages/install", {
        sourceRef: sourcePath,
        targetRoot: opts.target,
        runtime: opts.runtime,
        roleName: opts.role,
        allowMerge: opts.allowMerge ?? false,
      });

      // 500 → exitCode 2
      if (res.status >= 500) {
        console.error(res.data.error ?? "安装失败");
        process.exitCode = 2;
        return;
      }

      // 400/409/422 → exitCode 1
      if (res.status >= 400) {
        if (res.data.errors) {
          console.error("校验错误：");
          for (const e of res.data.errors) {
            console.error(`  - ${e}`);
          }
        } else if (res.data.code === "conflict_blocked" && res.data.conflicts) {
          console.error("未解决的冲突：");
          for (const c of res.data.conflicts) {
            console.error(`  - ${c.existingPath}：${c.reason}`);
          }
        } else if (res.data.code === "policy_rejected" && res.data.rejected) {
          console.error("策略拒绝——没有条目获批：");
          for (const r of res.data.rejected) {
            console.error(`  - ${r.entry.exportType} ${r.entry.exportName}：${r.reason}`);
          }
        } else {
          console.error(res.data.error ?? "安装失败");
        }
        process.exitCode = 1;
        return;
      }

      // 成功
      console.log(`已安装：${res.data.packageName}（${res.data.installId}）`);

      if (res.data.applied && res.data.applied.length > 0) {
        console.log("已应用：");
        for (const a of res.data.applied) {
          console.log(`  ${a.exportType.padEnd(12)} ${a.action.padEnd(14)} ${a.targetPath}`);
        }
      }

      if (res.data.deferred && res.data.deferred.length > 0) {
        console.log("已延后：");
        for (const d of res.data.deferred) {
          console.log(`  ${d.exportType.padEnd(12)} ${d.exportName.padEnd(20)} ${d.deferReason ?? ""}`);
        }
      }

      if (res.data.policyRejected && res.data.policyRejected.length > 0) {
        console.log("策略拒绝：");
        for (const r of res.data.policyRejected) {
          console.log(`  ${r.entry.exportType.padEnd(12)} ${r.entry.exportName.padEnd(20)} ${r.reason}`);
        }
      }
    });

  // zrig package rollback <installId>
  cmd
    .command("rollback <installId>")
    .description("回滚一次安装")
    .action(async (installId: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{
        installId: string;
        restored: string[];
        deleted: string[];
        error?: string;
      }>(`/api/packages/${encodeURIComponent(installId)}/rollback`);

      if (res.status >= 500) {
        console.error(res.data.error ?? "回滚失败");
        process.exitCode = 2;
        return;
      }

      if (res.status >= 400) {
        console.error(res.data.error ?? "回滚失败");
        process.exitCode = 1;
        return;
      }

      console.log(`已回滚 ${res.data.installId}：恢复 ${res.data.restored.length} 个，删除 ${res.data.deleted.length} 个`);
      if (res.data.restored.length > 0) {
        for (const f of res.data.restored) { console.log(`  已恢复：${f}`); }
      }
      if (res.data.deleted.length > 0) {
        for (const f of res.data.deleted) { console.log(`  已删除：${f}`); }
      }
    });

  // zrig package list
  cmd
    .command("list")
    .description("列出已安装的包")
    .action(async () => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.get<Array<{
        id: string;
        name: string;
        version: string;
        sourceKind: string;
        sourceRef: string;
        summary: string | null;
        createdAt: string;
      }>>("/api/packages");

      if (res.status >= 400) {
        console.error("列出包失败");
        process.exitCode = 1;
        return;
      }

      const pkgs = res.data;
      if (pkgs.length === 0) {
        console.log("未安装任何包");
        return;
      }

      console.log("名称                  版本        来源                  创建时间");
      for (const p of pkgs) {
        console.log(`${p.name.padEnd(21)} ${p.version.padEnd(11)} ${p.sourceRef.padEnd(22)} ${p.createdAt}`);
      }
    });

  return cmd;
}
