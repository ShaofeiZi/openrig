import nodePath from "node:path";
import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface ImportDeps extends StatusDeps {
  readFile: (path: string) => string;
}

const LONG_RUNNING_IMPORT_TIMEOUT_MS = 120_000;

export function importCommand(depsOverride?: ImportDeps): Command {
  const cmd = new Command("import").description("从 YAML 导入工作组规格");
  const getDeps = (): ImportDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .argument("<path>", "YAML 工作组规格文件路径")
    .option("--instantiate", "导入后实例化工作组")
    .option("--materialize-only", "创建工作组拓扑但不启动会话")
    .option("--workspace-only", "只把工作区声明应用到已有工作组")
    .option("--preflight", "运行预检")
    .option("--target-rig <rigId>", "要拓扑落地或应用工作区的目标已有工作组")
    .option("--rig-root <root>", "pod 感知解析的根目录")
    .option("--cwd <path>", "覆盖所有成员启动/拓扑落地的工作目录")
    .action(async (filePath: string, opts: { instantiate?: boolean; materializeOnly?: boolean; workspaceOnly?: boolean; preflight?: boolean; targetRig?: string; rigRoot?: string; cwd?: string }) => {
      const deps = getDeps();

      // 先读本地文件（在检查后台服务之前——文件缺失时快速失败）
      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`无法读取文件：${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // 检测 pod 感知规格，用于 X-Rig-Root 请求头
      let podAware = false;
      try { const { parse } = await import("yaml"); const parsed = parse(yaml); podAware = !!parsed && Array.isArray(parsed.pods); } catch { /* 无法解析——交给后台服务校验 */ }
      const rigRoot = podAware
        ? (opts.rigRoot ? nodePath.resolve(opts.rigRoot) : nodePath.dirname(nodePath.resolve(filePath)))
        : undefined;
      const cwdOverride = opts.cwd ? nodePath.resolve(opts.cwd) : undefined;
      const extraHeaders = {
        ...(rigRoot ? { "X-Rig-Root": rigRoot } : {}),
        ...(cwdOverride ? { "X-Cwd-Override": cwdOverride } : {}),
      };

      if (opts.instantiate && opts.materializeOnly) {
        console.error("--instantiate 与 --materialize-only 只能二选一。");
        process.exitCode = 1;
        return;
      }
      if (opts.workspaceOnly && (opts.instantiate || opts.materializeOnly || opts.preflight)) {
        console.error("--workspace-only 不能与 --instantiate、--materialize-only 或 --preflight 同时使用。");
        process.exitCode = 1;
        return;
      }

      if (opts.workspaceOnly) {
        if (!opts.targetRig) {
          console.error("--workspace-only 需要 --target-rig <rigId>。");
          process.exitCode = 1;
          return;
        }
        const res = await client.postText<
          { rigId: string; changed: boolean; workspace: unknown }
          | { ok: false; code: string; errors?: string[]; message?: string; error?: string }
        >("/api/rigs/import/workspace", yaml, "text/yaml", { "X-Target-Rig-Id": opts.targetRig });
        if (res.status >= 400) {
          const data = res.data as { errors?: string[]; message?: string; error?: string };
          const detail = data.errors?.join("\n  ") ?? data.message ?? data.error ?? `status ${res.status}`;
          console.error(`工作区应用失败：\n  ${detail}\n修复：更新 RigSpec 工作区或目标工作组后重试。`);
          process.exitCode = 1;
          return;
        }
        const data = res.data as { rigId: string; changed: boolean };
        console.log(data.changed
          ? `工作区已应用到工作组 ${data.rigId}`
          : `工作区与工作组 ${data.rigId} 已一致`);
        return;
      }

      if (opts.preflight) {
        const res = await client.postText<{ ready?: boolean; warnings?: string[]; errors?: string[] }>("/api/rigs/import/preflight", yaml, "text/yaml", extraHeaders);
        if (res.status >= 400) {
          console.error(`预检失败（HTTP ${res.status}）。请检查规格语法与 rig-root 路径。`);
          process.exitCode = 1;
          return;
        }
        const data = res.data;
        if (data.errors && data.errors.length > 0) {
          console.error(`预检错误：\n${data.errors.map((e) => `  ${e}`).join("\n")}`);
        }
        if (data.warnings && data.warnings.length > 0) {
          console.log(`预检警告：\n${data.warnings.map((w) => `  ${w}`).join("\n")}`);
        }
        if (data.ready) {
          console.log("预检通过");
        } else {
          console.error("预检未通过。修复：解决上述错误后重试。");
          process.exitCode = 1;
        }
        return;
      }

      if (opts.materializeOnly) {
        if (!podAware) {
          console.error("materialize-only 需要带 pods 的 pod 感知 RigSpec。");
          process.exitCode = 1;
          return;
        }
        const headers = {
          ...extraHeaders,
          ...(opts.targetRig ? { "X-Target-Rig-Id": opts.targetRig } : {}),
        };
        const res = await client.postText<{ rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> } | { ok: false; code: string; errors?: string[]; message?: string; error?: string }>("/api/rigs/import/materialize", yaml, "text/yaml", headers);
        if (res.status === 409 || res.status === 400 || res.status === 404) {
          const data = res.data as { ok?: false; code?: string; errors?: string[]; message?: string; error?: string };
          if (data.code === "rig_name_running") {
            console.error(data.error ?? data.message ?? "已有同名工作组在运行。");
            process.exitCode = 1;
            return;
          }
          const detail = data.errors?.join("\n  ") ?? data.message ?? data.error ?? `status ${res.status}`;
          console.error(`拓扑落地失败：\n  ${detail}\n修复：更新规格或目标工作组后重试。`);
          process.exitCode = 1;
          return;
        }
        if (res.status >= 400) {
          console.error(`拓扑落地失败（HTTP ${res.status}）。请检查规格与后台服务日志。`);
          process.exitCode = 1;
          return;
        }
        const data = res.data as { rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> };
        console.log(`工作组已拓扑落地：${data.specName}（${data.rigId}）`);
        for (const n of data.nodes) {
          console.log(`  ${n.logicalId}: ${n.status}`);
        }
        return;
      }

      if (opts.instantiate) {
        const res = await client.postText<{ rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> } | { ok: false; code: string; errors?: string[]; message?: string; error?: string }>(
          "/api/rigs/import",
          yaml,
          "text/yaml",
          extraHeaders,
          { timeoutMs: LONG_RUNNING_IMPORT_TIMEOUT_MS },
        );
        if (res.status === 409 || res.status === 400) {
          const data = res.data as { ok: false; code: string; errors?: string[]; message?: string; error?: string };
          if (data.code === "rig_name_running") {
            console.error(data.error ?? data.message ?? "已有同名工作组在运行。");
            process.exitCode = 1;
            return;
          }
          const detail = data.errors?.join("\n  ") ?? data.message ?? `status ${res.status}`;
          console.error(`导入失败：\n  ${detail}\n修复：检查工作组规格后重试。先用 zrig spec validate <path> 校验。`);
          process.exitCode = 1;
        } else if (res.status >= 400) {
          console.error(`导入失败（HTTP ${res.status}）。请检查规格与后台服务日志。`);
          process.exitCode = 1;
        } else {
          const data = res.data as { rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }>; attachCommand?: string };
          console.log(`工作组已创建：${data.specName}（${data.rigId}）`);
          for (const n of data.nodes) {
            console.log(`  ${n.logicalId}: ${n.status}`);
          }
          if (data.attachCommand) {
            console.log(`挂载命令：${data.attachCommand}`);
          }
        }
        return;
      }

      // 默认：仅校验
      const res = await client.postText<{ valid?: boolean; errors?: string[] }>("/api/rigs/import/validate", yaml);
      if (res.status >= 400) {
        console.error(`校验失败：规格无效（HTTP ${res.status}）。请检查 YAML 语法后重试。`);
        process.exitCode = 1;
        return;
      }
      const data = res.data;
      if (data.valid) {
        console.log("有效");
      } else {
        console.error(`工作组规格无效：\n${(data.errors ?? []).map((e) => `  ${e}`).join("\n")}\n修复：更新规格后用 zrig spec validate <path> 重新校验。`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
