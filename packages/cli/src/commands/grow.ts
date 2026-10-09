import { resolve as resolvePath } from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveDefaultAgentRef } from "./topology-default-agent.js";

interface RigNode {
  rigName: string;
  podNamespace: string | null;
}

interface GrowNode {
  logicalId: string;
  status: "launched" | "failed" | "attention_required";
  sessionName?: string;
  error?: string;
}

interface AddMemberResult {
  ok: boolean;
  result?: {
    podNamespace: string;
    node: GrowNode;
  };
  errors?: string[];
  message?: string;
  error?: string;
}

interface ExpandResult {
  ok: boolean;
  status?: "ok" | "partial" | "failed";
  podNamespace?: string;
  nodes?: GrowNode[];
  warnings?: string[];
  retryTargets?: string[];
  errors?: string[];
  message?: string;
  error?: string;
}

export function growCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("grow").description("向运行中的工作组添加一个或多个席位");
  const getDeps = () => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<rig-id>", "目标工作组 ID")
    .argument("<members...>", "新席位的名称")
    .option("--pod <pod>", "目标 Pod；当工作组只有一个 Pod 时可省略推断")
    .option("--new-pod <pod>", "为这些席位新建一个 Pod")
    .option("--runtime <runtime>", "智能体运行时", "claude-code")
    .option("--cwd <path>", "席位的工作目录", process.cwd())
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (
      rigId: string,
      members: string[],
      opts: { pod?: string; newPod?: string; runtime: string; cwd: string; json?: boolean },
    ) => {
      if (opts.pod && opts.newPod) {
        console.error("请选择 --pod 或 --new-pod，二者不可同时使用。");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));

      const rigRes = await client.get<RigNode[]>(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
      if (rigRes.status >= 400) {
        console.error(`未找到工作组 ${rigId}。`);
        process.exitCode = 1;
        return;
      }
      const rigName = rigRes.data[0]?.rigName;
      const pods = [...new Set(
        rigRes.data
          .map((node) => node.podNamespace)
          .filter((namespace): namespace is string => typeof namespace === "string"),
      )];
      if (opts.newPod && pods.includes(opts.newPod)) {
        console.error(`Pod ${opts.newPod} 已存在。请用 --pod ${opts.newPod} 在其中扩容。`);
        process.exitCode = 1;
        return;
      }
      const pod = opts.newPod
        ?? (opts.pod
          ? pods.find((candidate) => candidate === opts.pod)
          : pods.length === 1
            ? pods[0]
            : undefined);
      if (!pod) {
        const available = pods.join(", ") || "无";
        console.error(opts.pod
          ? `未找到 Pod ${opts.pod}。可用 Pod：${available}。`
          : `请用 --pod 指定一个 Pod。可用 Pod：${available}。`);
        process.exitCode = 1;
        return;
      }

      let agentRef: string;
      try {
        agentRef = await resolveDefaultAgentRef(client);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const cwd = resolvePath(opts.cwd);
      const memberSpecs = members.map((member) => ({
        id: member,
        agent_ref: agentRef,
        runtime: opts.runtime,
        profile: "default",
        cwd,
      }));
      let nodes: GrowNode[] = [];
      let ok = false;
      let detail: string | undefined;
      let warnings: string[] = [];
      let retryTargets: string[] = [];

      if (opts.newPod) {
        const res = await client.post<ExpandResult>(
          `/api/rigs/${encodeURIComponent(rigId)}/expand`,
          {
            pod: { id: pod, label: pod, members: memberSpecs, edges: [] },
            rigRoot: cwd,
          },
          { timeoutMs: 120_000 },
        );
        nodes = res.data.nodes ?? [];
        warnings = res.data.warnings ?? [];
        retryTargets = res.data.retryTargets ?? [];
        ok = res.status < 400
          && res.data.ok
          && res.data.status === "ok"
          && nodes.length === members.length
          && nodes.every((node) => node.status === "launched");
        detail = res.data.errors?.join("; ")
          ?? res.data.message
          ?? res.data.error
          ?? nodes.find((node) => node.error)?.error;
        const returned = new Set(nodes.map((node) => node.logicalId));
        for (const member of memberSpecs) {
          const logicalId = `${pod}.${member.id}`;
          if (!returned.has(logicalId)) {
            nodes.push({ logicalId, status: "failed", error: detail ?? "未返回节点结果。" });
          }
        }
      } else {
        const failures: string[] = [];
        for (const member of memberSpecs) {
          const res = await client.post<AddMemberResult>(
            `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(pod)}/members`,
            { member, rigRoot: cwd },
            { timeoutMs: 120_000 },
          );
          const responseDetail = res.data.errors?.join("；")
            ?? res.data.message
            ?? res.data.error
            ?? res.data.result?.node.error
            ?? `扩容失败（HTTP ${res.status}）`;
          const node = res.data.result?.node ?? {
            logicalId: `${pod}.${member.id}`,
            status: "failed" as const,
            error: responseDetail,
          };
          nodes.push(node);
          if (res.status >= 400 || !res.data.ok || node.status !== "launched") {
            failures.push(`${member.id}: ${responseDetail}`);
          }
        }
        ok = failures.length === 0;
        detail = failures.join("; ") || undefined;
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok,
          rigId,
          rigName,
          pod,
          seats: nodes.map((node) => node.logicalId),
          source: agentRef,
          ...(nodes.length === 1 ? { seat: nodes[0]?.logicalId, node: nodes[0] } : {}),
          nodes,
          ...(detail ? { detail } : {}),
          warnings,
          retryTargets,
        }, null, 2));
      } else if (ok) {
        console.log(`已扩容工作组 ${rigName ?? rigId}`);
        if (nodes.length === 1) {
          const node = nodes[0]!;
          console.log(`  席位：${node.logicalId}${node.sessionName ? `（${node.sessionName}）` : ""}`);
        } else {
          console.log("  席位：");
          for (const node of nodes) {
            console.log(`    ${node.logicalId}${node.sessionName ? `（${node.sessionName}）` : ""}`);
          }
        }
      } else {
        console.error(`工作组 ${rigName ?? rigId} 未完全扩容成功`);
        for (const node of nodes) {
          const icon = node.status === "launched" ? "OK" : node.status === "attention_required" ? "待关注" : "FAIL";
          const session = node.sessionName ? `（${node.sessionName}）` : "";
          const error = node.error ? ` - ${node.error}` : "";
          console.error(`  [${icon}] ${node.logicalId}：${node.status}${session}${error}`);
        }
        if (detail && !nodes.some((node) => node.error && detail.includes(node.error))) {
          console.error(`  ${detail}`);
        }
        for (const warning of warnings) console.error(`  警告：${warning}`);
        if (retryTargets.length > 0) {
          console.error("  失败的节点可逐个重新启动。恢复步骤：");
          for (const target of retryTargets) console.error(`    zrig launch ${rigId} ${target}`);
        }
      }

      if (!ok) process.exitCode = 1;
    });

  return cmd;
}
