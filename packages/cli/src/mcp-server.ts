import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonClient, DaemonResponse } from "./client.js";
import { CLI_VERSION } from "./version.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;
const WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS = 5_000;

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

/**
 * 把 DaemonResponse 映射为 MCP 工具结果。
 * 三级错误：HTTP 状态、响应体内错误、以及结构性失败字段。
 * @param res - 来自 DaemonClient 的 DaemonResponse
 * @param structuralCheck - 可选的、针对该工具特定结构失败的额外检查
 * @returns MCP 工具结果
 */
function mapResult(
  res: DaemonResponse<unknown>,
  structuralCheck?: (data: Record<string, unknown>) => boolean,
): TextResult {
  const text = JSON.stringify(res.data);

  // 第 1 级：HTTP 错误
  if (res.status >= 400) {
    return { content: [{ type: "text", text }], isError: true };
  }

  const data = res.data as Record<string, unknown>;

  // 第 2 级：响应体内的 error / errors 字段
  if (data.error || (Array.isArray(data.errors) && data.errors.length > 0)) {
    return { content: [{ type: "text", text }], isError: true };
  }

  // 第 3 级：该工具特定的结构性失败
  if (structuralCheck && structuralCheck(data)) {
    return { content: [{ type: "text", text }], isError: true };
  }

  return { content: [{ type: "text", text }] };
}

/**
 * 创建一个包装后台服务 HTTP API 的 MCP server。
 * @param client - 已连接到后台服务的 DaemonClient
 * @returns McpServer 实例（尚未连接到传输层）
 */
export function createMcpServer(client: DaemonClient): McpServer {
  const server = new McpServer({
    name: "openrig",
    version: CLI_VERSION,
  });

  // 1. rig_up —— 引导/bundle 安装
  server.tool(
    "rig_up",
    "从规格或 bundle 引导启动一个工作组",
    {
      sourceRef: z.string().describe(".yaml 工作组规格或 .rigbundle 的路径"),
      plan: z.boolean().optional().describe("计划模式——只预览不执行"),
      autoApprove: z.boolean().optional().describe("自动批准受信任的操作"),
      targetRoot: z.string().optional().describe("包安装的目标根目录"),
    },
    async ({ sourceRef, plan, autoApprove, targetRoot }) => {
      try {
        const res = await client.post(
          "/api/up",
          { sourceRef, plan: plan ?? false, autoApprove: autoApprove ?? false, targetRoot },
          plan ? undefined : { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
        );
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 2. rig_down —— 工作组拆除
  server.tool(
    "rig_down",
    "拆除一个工作组",
    {
      rigId: z.string().describe("要拆除的工作组标识"),
      delete: z.boolean().optional().describe("停止后删除工作组记录"),
      force: z.boolean().optional().describe("立即结束会话"),
      snapshot: z.boolean().optional().describe("拆除前先打快照"),
    },
    async (params) => {
      try {
        const res = await client.post("/api/down", {
          rigId: params.rigId,
          delete: params.delete ?? false,
          force: params.force ?? false,
          snapshot: params.snapshot ?? false,
        });
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 3. rig_ps —— 列出运行中的工作组
  server.tool(
    "rig_ps",
    "列出工作组及其状态",
    {},
    async () => {
      try {
        const res = await client.get("/api/ps");
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 4. rig_status —— 后台服务健康状态
  server.tool(
    "rig_status",
    "检查后台服务健康状态",
    {},
    async () => {
      try {
        const res = await client.get("/healthz");
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 5. rig_snapshot_create —— 创建快照
  server.tool(
    "rig_snapshot_create",
    "为工作组创建一个快照",
    {
      rigId: z.string().describe("工作组标识"),
    },
    async ({ rigId }) => {
      try {
        const res = await client.post(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`, {});
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 6. rig_snapshot_list —— 列出快照
  server.tool(
    "rig_snapshot_list",
    "列出工作组的快照",
    {
      rigId: z.string().describe("工作组标识"),
    },
    async ({ rigId }) => {
      try {
        const res = await client.get(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 7. rig_restore —— 从快照恢复
  server.tool(
    "rig_restore",
    "从快照恢复一个工作组",
    {
      rigId: z.string().describe("工作组标识"),
      snapshotId: z.string().describe("快照标识"),
    },
    async ({ rigId, snapshotId }) => {
      try {
        const res = await client.post(`/api/rigs/${encodeURIComponent(rigId)}/restore/${encodeURIComponent(snapshotId)}`, {});
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 8. rig_discover —— 扫描会话
  server.tool(
    "rig_discover",
    "扫描可纳管的 tmux 会话",
    {},
    async () => {
      try {
        const res = await client.post("/api/discovery/scan", {});
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 9. rig_bind —— 把发现的会话绑定到工作组节点（已有，或在 pod 中新建）
  server.tool(
    "rig_bind",
    "把发现的会话绑定到已有节点，或在某个 pod 中新建节点",
    {
      discoveryId: z.string().describe("发现的会话标识"),
      rigId: z.string().describe("目标工作组标识"),
      logicalId: z.string().optional().describe("已有节点的逻辑 ID（模式：绑定到已有节点）"),
      podNamespace: z.string().optional().describe("在其中新建节点的 pod 命名空间（模式：在 pod 中创建）"),
      memberName: z.string().optional().describe("新节点的成员名（与 podNamespace 同时提供时必填）"),
    },
    async ({ discoveryId, rigId, logicalId, podNamespace, memberName }) => {
      try {
        const body: Record<string, unknown> = { rigId };
        if (logicalId) body["logicalId"] = logicalId;
        if (podNamespace) body["podNamespace"] = podNamespace;
        if (memberName) body["memberName"] = memberName;
        const res = await client.post(`/api/discovery/${encodeURIComponent(discoveryId)}/bind`, body);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 10. rig_bundle_inspect —— 检查一个 bundle
  server.tool(
    "rig_bundle_inspect",
    "检查一个 .rigbundle 文件",
    {
      bundlePath: z.string().describe(".rigbundle 文件的路径"),
    },
    async ({ bundlePath }) => {
      try {
        const res = await client.post("/api/bundles/inspect", { bundlePath });
        return mapResult(res, (data) => {
          // 结构性失败：digest 无效或完整性校验未过
          if (data.digestValid === false) return true;
          const integrity = data.integrityResult as { passed?: boolean } | undefined;
          if (integrity && integrity.passed === false) return true;
          return false;
        });
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 11. rig_agent_validate —— 校验 AgentSpec
  server.tool(
    "rig_agent_validate",
    "从 YAML 文本校验一个 AgentSpec（agent.yaml）",
    {
      yaml: z.string().describe("智能体规格的 YAML 文本"),
    },
    async ({ yaml }) => {
      try {
        const res = await client.postText("/api/agents/validate", yaml);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 12. rig_rig_validate —— 校验 RigSpec
  server.tool(
    "rig_rig_validate",
    "从 YAML 文本校验一个 RigSpec（rig.yaml）",
    {
      yaml: z.string().describe("工作组规格的 YAML 文本"),
    },
    async ({ yaml }) => {
      try {
        const res = await client.postText("/api/rigs/import/validate", yaml);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 13. rig_rig_nodes —— 工作组的节点清单
  server.tool(
    "rig_rig_nodes",
    "获取工作组的节点清单——会话名、状态、挂载命令、恢复命令",
    {
      rigId: z.string().describe("工作组标识"),
    },
    async ({ rigId }) => {
      try {
        const res = await client.get(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 14. rig_send —— 向智能体会话发消息
  server.tool(
    "rig_send",
    "用可靠的两步发送，向智能体终端发一条消息",
    {
      session: z.string().describe("目标会话名（例如 dev-impl@my-rig）"),
      text: z.string().describe("要发送的消息文本"),
      verify: z.boolean().optional().describe("通过检查窗格内容来验证投递"),
      force: z.boolean().optional().describe("即使目标看起来正在任务中也发送"),
      waitForIdleSeconds: z.number().positive().optional().describe("等到出现明确的空闲证据后再发送"),
    },
    async ({ session, text, verify, force, waitForIdleSeconds }) => {
      try {
        if (force && waitForIdleSeconds !== undefined) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "waitForIdleSeconds 不能与 force 同时使用" }) }],
            isError: true,
          };
        }
        const waitForIdleMs = waitForIdleSeconds === undefined ? undefined : Math.ceil(waitForIdleSeconds * 1000);
        const res = await client.post("/api/transport/send", {
          session,
          text,
          verify,
          force,
          waitForIdleMs,
        }, waitForIdleRequestOptions(waitForIdleMs));
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 15. rig_capture —— 抓取智能体会话的终端输出
  server.tool(
    "rig_capture",
    "抓取智能体会话的终端输出",
    {
      session: z.string().optional().describe("会话名（配合 rig/pod 做多目标时省略）"),
      rig: z.string().optional().describe("抓取一个工作组里的所有会话"),
      pod: z.string().optional().describe("抓取一个 pod 里的所有会话"),
      lines: z.number().optional().describe("要抓取的行数（默认：20）"),
    },
    async ({ session, rig, pod, lines }) => {
      try {
        const body: Record<string, unknown> = {};
        if (session) body.session = session;
        if (rig) body.rig = rig;
        if (pod) body.pod = pod;
        if (lines) body.lines = lines;
        const res = await client.post("/api/transport/capture", body);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 16. rig_chatroom_send —— 向工作组聊天室发消息
  server.tool(
    "rig_chatroom_send",
    "向工作组的聊天室发一条消息",
    {
      rigName: z.string().describe("要发消息的工作组名"),
      body: z.string().describe("消息正文"),
      sender: z.string().optional().describe("（已废弃，忽略）发送者由席位环境推导（X-OpenRig-Session，由 MCP server 的 DaemonClient 盖章）；聊天路由从传输头推导"),
    },
    async ({ rigName, body }) => {
      try {
        // 把工作组名解析为 ID
        const summaryRes = await client.get<Array<{ id: string; name: string }>>("/api/rigs/summary");
        const matches = (summaryRes.data ?? []).filter((r) => r.name === rigName);

        if (matches.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `未找到工作组 '${rigName}'` }) }], isError: true as const };
        }
        if (matches.length > 1) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `工作组 '${rigName}' 有歧义——有 ${matches.length} 个工作组共用该名` }) }], isError: true as const };
        }

        const rigId = matches[0]!.id;
        // P21：不带 body sender——后台服务从传输头推导（X-OpenRig-Session，
        // 由 MCP server 的 DaemonClient 从其席位环境盖章）。若硬编码 'mcp' 与头不一致，会被
        // 头覆盖（transport:v1），而非持久化（P18：409 不一致已废弃）。
        const res = await client.post(`/api/rigs/${encodeURIComponent(rigId)}/chat/send`, {
          body,
        });
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 17. rig_chatroom_watch —— 获取工作组最近的聊天室历史
  server.tool(
    "rig_chatroom_watch",
    "获取工作组最近的聊天室消息（MCP 返回历史，非流式）",
    {
      rigName: z.string().describe("工作组名"),
    },
    async ({ rigName }) => {
      try {
        // 把工作组名解析为 ID
        const summaryRes = await client.get<Array<{ id: string; name: string }>>("/api/rigs/summary");
        const matches = (summaryRes.data ?? []).filter((r) => r.name === rigName);

        if (matches.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `未找到工作组 '${rigName}'` }) }], isError: true as const };
        }
        if (matches.length > 1) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `工作组 '${rigName}' 有歧义——有 ${matches.length} 个工作组共用该名` }) }], isError: true as const };
        }

        const rigId = matches[0]!.id;
        const res = await client.get(`/api/rigs/${encodeURIComponent(rigId)}/chat/history?limit=20`);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 18. rig_add —— 向已有 pod 添加单个成员（add_member 收敛操作）。
  // 与 `rig add` 的智能体对等：人机工程都放在收敛接口上，因此未来任何重塑动词都继承这一表面。
  server.tool(
    "rig_add",
    "向运行中工作组的已有 pod 添加单个成员（add_member 收敛操作）。无身份迁移：新建一个席位，既有内容不重新加密。",
    {
      rigId: z.string().describe("目标工作组标识"),
      podNamespace: z.string().describe("要加入成员的既有 pod 的命名空间"),
      member: z.record(z.string(), z.unknown()).describe("成员片段，含 spec snake_case 字段：id、runtime、agent_ref、profile、cwd（以及可选的 model、codex_config_profile、restore_policy、label）"),
      edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })).optional().describe("可选的 pod 内边（from/to 是 pod 内的成员 id；相对新成员 + 既有 pod 同伴解析）"),
      rigRoot: z.string().optional().describe("智能体解析的根目录"),
    },
    async ({ rigId, podNamespace, member, edges, rigRoot }) => {
      try {
        const body: Record<string, unknown> = { member };
        if (edges) body["edges"] = edges;
        if (rigRoot) body["rigRoot"] = rigRoot;
        const res = await client.post(
          `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(podNamespace)}/members`,
          body,
        );
        // 结构性失败：add 已持久化（201）但新节点未完全启动（failed / attention_required）——
        // 作为错误暴露出来，让智能体知道该席位未就绪，对应 CLI 的非零退出。
        return mapResult(res, (data) => {
          const result = data["result"] as { node?: { status?: string } } | undefined;
          return result?.node?.status !== undefined && result.node.status !== "launched";
        });
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  return server;
}

function waitForIdleRequestOptions(waitForIdleMs: number | undefined): { timeoutMs: number } | undefined {
  if (waitForIdleMs === undefined) return undefined;
  return { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS };
}
