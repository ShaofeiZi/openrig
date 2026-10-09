import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ExpandResult {
  ok: boolean;
  status?: "ok" | "partial" | "failed";
  podId?: string;
  podNamespace?: string;
  nodes?: Array<{ logicalId: string; nodeId: string; status: string; error?: string; sessionName?: string }>;
  warnings?: string[];
  retryTargets?: string[];
  code?: string;
  error?: string;
}

export function expandCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("expand").description("向运行中的工作组添加一个 Pod");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rig-id>", "目标工作组 ID")
    .argument("<pod-fragment-path>", "Pod 片段 YAML 文件路径")
    .option("--json", "供智能体使用的 JSON 输出")
    .option("--rig-root <path>", "智能体解析的根目录")
    .action(async (rigId: string, fragmentPath: string, opts: { json?: boolean; rigRoot?: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      // 读取并解析 YAML 片段
      let fileContent: string;
      try {
        fileContent = readFileSync(fragmentPath, "utf-8");
      } catch (err) {
        console.error(`无法读取文件：${fragmentPath}`);
        process.exitCode = 1;
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        // 动态 import，避免在模块加载时打包 yaml
        const { parse } = await import("yaml");
        parsed = parse(fileContent) as Record<string, unknown>;
      } catch {
        console.error("Pod 片段文件中的 YAML 无效");
        process.exitCode = 1;
        return;
      }

      // 从片段中提取 pod 及可选的 crossPodEdges
      const pod = parsed["pod"] ?? parsed;
      const crossPodEdges = parsed["crossPodEdges"] as unknown[] | undefined;

      const body: Record<string, unknown> = { pod };
      if (crossPodEdges) body["crossPodEdges"] = crossPodEdges;
      if (opts.rigRoot) body["rigRoot"] = opts.rigRoot;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<ExpandResult>(`/api/rigs/${encodeURIComponent(rigId)}/expand`, body);

      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        if (res.status >= 400 || (data.ok && data.status !== "ok")) process.exitCode = 1;
        return;
      }

      if (res.status >= 400 || !data.ok) {
        console.error(data.error ?? `扩容失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      // 人类可读输出
      console.log(`已扩容工作组 ${rigId}`);
      console.log(`  Pod：${data.podNamespace}`);
      console.log(`  状态：${data.status}`);
      console.log("");

      if (data.nodes && data.nodes.length > 0) {
        console.log("  节点：");
        for (const node of data.nodes) {
          const icon = node.status === "launched" ? "OK" : "FAIL";
          const session = node.sessionName ? `（${node.sessionName}）` : "";
          const error = node.error ? ` — ${node.error}` : "";
          console.log(`    [${icon}] ${node.logicalId}${session}${error}`);
        }
      }

      if (data.warnings && data.warnings.length > 0) {
        console.log("");
        for (const w of data.warnings) console.log(`  警告：${w}`);
      }

      // 对失败节点给出诚实的重试指引。/launch 路由会把每个带 pod 的节点
      // （expand 创建的节点都属于此类）走一遍托管子集启动 + 完整启动编排，
      // 因此在根因修复后，逐节点重新启动就是恢复路径。
      if (data.retryTargets && data.retryTargets.length > 0) {
        console.log("");
        console.log("  失败的节点可逐个重新启动。恢复步骤：");
        console.log(`    1. 确认其他席位健康：zrig ps --nodes --rig ${rigId}`);
        console.log(`    2. 修复每个失败背后的规范/配置问题。`);
        console.log(`    3. 逐个重新启动失败节点：`);
        for (const target of data.retryTargets) {
          console.log(`         zrig launch ${rigId} ${target}`);
        }
        console.log(`  失败目标：${data.retryTargets.join(", ")}`);
      }

      if (data.status !== "ok") {
        process.exitCode = 1;
      }
    });

  return cmd;
}
