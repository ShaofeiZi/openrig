import { Command } from "commander";
import { readFileSync } from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface AddMemberResponse {
  ok: boolean;
  result?: {
    podId: string;
    podNamespace: string;
    node: { logicalId: string; nodeId: string; status: string; error?: string; sessionName?: string };
    edges?: Array<{ from: string; to: string; kind: string }>;
    warnings?: string[];
  };
  code?: string;
  message?: string;
  errors?: string[];
  error?: string;
}

export function addMemberCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("add").description("向运行中工作组的已有 Pod 添加一个成员");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rig-id>", "目标工作组 ID")
    .argument("<pod-namespace>", "要添加成员的已有 Pod 的命名空间")
    .argument("<member-fragment-path>", "成员片段 YAML/JSON 文件路径（规范为 snake_case 字段）")
    .option("--json", "供智能体使用的 JSON 输出")
    .option("--rig-root <path>", "智能体解析的根目录")
    .action(async (rigId: string, podNamespace: string, fragmentPath: string, opts: { json?: boolean; rigRoot?: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      let fileContent: string;
      try {
        fileContent = readFileSync(fragmentPath, "utf-8");
      } catch {
        console.error(`无法读取文件：${fragmentPath}`);
        process.exitCode = 1;
        return;
      }

      let member: Record<string, unknown>;
      let edges: unknown;
      try {
        // 动态 import，避免在模块加载时打包 yaml（与 expand 一致）。
        const { parse } = await import("yaml");
        const parsed = (parse(fileContent) ?? {}) as Record<string, unknown>;
        if (parsed["member"] && typeof parsed["member"] === "object" && !Array.isArray(parsed["member"])) {
          // 包装形式：{ member: {...}, edges?: [...] }。
          member = parsed["member"] as Record<string, unknown>;
          edges = parsed["edges"];
        } else {
          // 裸成员形式。把任何顶层 `edges:` 提为 Pod 本地边，
          // 以免被静默丢弃（schema 会忽略未知的成员字段）。其余即为成员。
          const { edges: bareEdges, ...rest } = parsed;
          member = rest;
          edges = bareEdges;
        }
      } catch {
        console.error("成员片段文件中的 YAML/JSON 无效");
        process.exitCode = 1;
        return;
      }

      // edges 字段存在但非数组是一个诚实的错误，绝不静默省略
      // （治理规则 FM2：禁止静默丢弃）。
      if (edges !== undefined && edges !== null && !Array.isArray(edges)) {
        console.error("成员片段无效：'edges' 必须是 { from, to, kind } 的数组。");
        process.exitCode = 1;
        return;
      }
      const body: Record<string, unknown> = { member };
      if (Array.isArray(edges)) body["edges"] = edges;
      if (opts.rigRoot) body["rigRoot"] = opts.rigRoot;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<AddMemberResponse>(
        `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(podNamespace)}/members`,
        body,
      );
      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        // HTTP 失败或新节点未完全启动时返回非零。
        if (res.status >= 400 || (data.ok && data.result !== undefined && data.result.node.status !== "launched")) {
          process.exitCode = 1;
        }
        return;
      }

      if (res.status >= 400 || !data.ok) {
        // 诚实的三段式错误：后台服务消息已说明失败点 / 原因 / 该做什么
        // （pod_not_found 会列出 Pod；member_conflict 会建议新 id）；
        // 校验/预检会给出具体字段错误。
        const msg = data.message
          ?? (data.errors && data.errors.length > 0 ? data.errors.join("；") : data.error)
          ?? `添加成员失败（HTTP ${res.status}）`;
        console.error(msg);
        process.exitCode = 1;
        return;
      }

      const node = data.result!.node;
      const icon = node.status === "launched" ? "OK" : "FAIL";
      const session = node.sessionName ? `（${node.sessionName}）` : "";
      const error = node.error ? ` - ${node.error}` : "";
      console.log(`已向工作组 ${rigId} 添加成员`);
      console.log(`  Pod：${data.result!.podNamespace}`);
      console.log(`  成员：[${icon}] ${node.logicalId}${session}${error}`);

      const persistedEdges = data.result!.edges ?? [];
      if (persistedEdges.length > 0) {
        console.log("  边：");
        for (const e of persistedEdges) console.log(`    ${e.from} ${e.kind} ${e.to}`);
      }

      if (data.result!.warnings && data.result!.warnings.length > 0) {
        console.log("");
        for (const w of data.result!.warnings) console.log(`  警告：${w}`);
      }

      if (node.status !== "launched") {
        process.exitCode = 1;
      }
    });

  return cmd;
}
