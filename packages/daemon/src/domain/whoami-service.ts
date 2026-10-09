import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TranscriptStore } from "./transcript-store.js";
import { resolveWorkspaceContext, type WhoamiWorkspaceBlock } from "./workspace/workspace-resolver.js";

export interface WhoamiResult {
  resolvedBy: "node_id" | "session_name";
  identity: {
    rigId: string;
    rigName: string;
    nodeId: string;
    logicalId: string;
    attachmentType: "tmux" | "external_cli";
    podId: string | null;
    podNamespace: string | null;
    podLabel: string | null;
    memberId: string;
    memberLabel: string | null;
    sessionName: string | null;
    runtime: string;
    cwd: string | null;
    agentRef: string | null;
    profile: string | null;
    resolvedSpecName: string | null;
    resolvedSpecVersion: string | null;
  };
  peers: Array<{
    logicalId: string;
    sessionName: string | null;
    runtime: string;
    podId: string | null;
    podNamespace: string | null;
    memberId: string;
  }>;
  /**
   * OPR.99.0.6.1——peers[] roster 契约以内嵌方式说明，避免新智能体误读字段。`peers[]` 是同一
   * 工作组中排除自身后的 ROSTER，不按 edge/status 过滤；`edges{}` 是有向图；
   * `zrig ps --nodes` 是包含自身与实时状态的 node inventory。这里只增补说明，
   * `peers[]` 的名称和结构不变。
   */
  peersNote: string;
  edges: {
    outgoing: Array<{ kind: string; to: { logicalId: string; sessionName: string | null } }>;
    incoming: Array<{ kind: string; from: { logicalId: string; sessionName: string | null } }>;
  };
  transcript: {
    enabled: boolean;
    path: string | null;
    tailCommand: string | null;
    grepCommand: string | null;
  };
  commands: {
    sendExamples: string[];
    captureExamples: string[];
  };
  contextUsage?: import("./types.js").ContextUsage;
  /** PL-012 Token / Context Usage Surface v0——在跨运行时 contextUsage primitive 旁呈现
   *  运行时专属上下文详情。Codex：来自逐 PID logs DB 的 threadId。Claude Code：resumeToken
   *  加 context-usage sample 中的当前用量。Terminal：null。 */
  runtimeContext?: RuntimeContext | null;
  /** PL-007 Workspace Primitive v0——工作组 RigSpec 声明 workspace 时提供类型化 workspace block。
   *  工作组未声明 workspace 时为 null；智能体回退到只使用 cwd 定位。 */
  workspace?: WhoamiWorkspaceBlock | null;
  /** W3 显式当前席位诊断；普通 whoami 读取时省略。 */
  permissionDrift?: import("./permission-drift.js").PermissionDriftDiagnostic | null;
}

export type RuntimeContext =
  | {
      runtime: "codex";
      threadId: string | null;
      conversationId: string | null;
      estimatedTokens: number | null;
      lastSampledAt: string | null;
    }
  | {
      runtime: "claude-code";
      resumeToken: string | null;
      estimatedTokens: number | null;
      lastSampledAt: string | null;
    };

export class WhoamiAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhoamiAmbiguousError";
  }
}

interface NodeRow {
  id: string;
  rig_id: string;
  logical_id: string;
  role: string | null;
  runtime: string | null;
  cwd: string | null;
  pod_id: string | null;
  agent_ref: string | null;
  profile: string | null;
  label: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
}

interface SessionRow {
  id: string;
  node_id: string;
  session_name: string;
  status: string;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  kind: string;
}

interface PodRow {
  id: string;
  label: string | null;
  namespace: string | null;
}

interface BindingRow {
  attachment_type: string | null;
  tmux_session: string | null;
  external_session_name: string | null;
}

interface WhoamiDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  transcriptStore: TranscriptStore;
  contextUsageStore?: import("./context-usage-store.js").ContextUsageStore;
}

export class WhoamiService {
  private db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private transcriptStore: TranscriptStore;
  private contextUsageStore: import("./context-usage-store.js").ContextUsageStore | null;

  constructor(deps: WhoamiDeps) {
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.transcriptStore = deps.transcriptStore;
    this.contextUsageStore = deps.contextUsageStore ?? null;
  }

  resolve(query: { nodeId?: string; sessionName?: string; targetRepoOverride?: string; compact?: boolean }): WhoamiResult | null {
    let nodeRow: NodeRow | undefined;
    let resolvedBy: "node_id" | "session_name";
    let currentSessionName: string | null;

    if (query.nodeId) {
      nodeRow = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(query.nodeId) as NodeRow | undefined;
      if (!nodeRow) return null;
      resolvedBy = "node_id";
      currentSessionName = this.getCurrentSessionName(nodeRow.id, nodeRow.rig_id);
    } else if (query.sessionName) {
      // 查找匹配该名称的会话，并检查是否跨工作组存在歧义。
      const sessionRows = this.db
        .prepare("SELECT * FROM sessions WHERE session_name = ? ORDER BY id DESC")
        .all(query.sessionName) as SessionRow[];

      if (sessionRows.length === 0) return null;

      // 检查不同工作组。
      const rigIds = new Set<string>();
      for (const sess of sessionRows) {
        const node = this.db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(sess.node_id) as { rig_id: string } | undefined;
        if (node) rigIds.add(node.rig_id);
      }

      if (rigIds.size > 1) {
        throw new WhoamiAmbiguousError(
          `会话 '${query.sessionName}' 存在歧义：在 ${rigIds.size} 个工作组中找到。请改用 --node-id。`
        );
      }

      const sess = sessionRows[0]!;
      nodeRow = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(sess.node_id) as NodeRow | undefined;
      if (!nodeRow) return null;
      resolvedBy = "session_name";
      currentSessionName = this.getCurrentSessionName(nodeRow.id, nodeRow.rig_id);
    } else {
      return null;
    }

    // 获取工作组。
    const rig = this.rigRepo.getRig(nodeRow.rig_id);
    if (!rig) return null;

    // 派生 member identity。
    const parts = nodeRow.logical_id.split(".");
    const memberId = parts.length > 1 ? parts.slice(1).join(".") : nodeRow.logical_id;

    // 获取 pod 信息。
    let podLabel: string | null = null;
    let podNamespace: string | null = null;
    if (nodeRow.pod_id) {
      const pod = this.db.prepare("SELECT * FROM pods WHERE id = ?").get(nodeRow.pod_id) as PodRow | undefined;
      podLabel = pod?.label ?? null;
      podNamespace = pod?.namespace ?? null;
    }

    // 通过 nodeId 解析时，获取当前会话名。
    if (resolvedBy === "node_id") {
      currentSessionName = this.getCurrentSessionName(nodeRow.id, nodeRow.rig_id);
    }

    // 构建 identity。
    const binding = this.db
      .prepare("SELECT attachment_type, tmux_session, external_session_name FROM bindings WHERE node_id = ?")
      .get(nodeRow.id) as BindingRow | undefined;

    const identity: WhoamiResult["identity"] = {
      rigId: nodeRow.rig_id,
      rigName: rig.rig.name,
      nodeId: nodeRow.id,
      logicalId: nodeRow.logical_id,
      attachmentType: (binding?.attachment_type as WhoamiResult["identity"]["attachmentType"]) ?? "tmux",
      podId: nodeRow.pod_id,
      podNamespace,
      podLabel,
      memberId,
      memberLabel: nodeRow.label,
      sessionName: currentSessionName,
      runtime: nodeRow.runtime ?? "unknown",
      cwd: nodeRow.cwd,
      agentRef: nodeRow.agent_ref,
      profile: nodeRow.profile,
      resolvedSpecName: nodeRow.resolved_spec_name,
      resolvedSpecVersion: nodeRow.resolved_spec_version,
    };

    // 构建 peer：工作组内其他节点及其当前会话。
    const peers: WhoamiResult["peers"] = [];
    for (const peerNode of rig.nodes) {
      if (peerNode.id === nodeRow.id) continue;
      const peerParts = peerNode.logicalId.split(".");
      const peerMemberId = peerParts.length > 1 ? peerParts.slice(1).join(".") : peerNode.logicalId;
      const peerSessionName = this.getCurrentSessionName(peerNode.id, nodeRow.rig_id);
      let peerPodNamespace: string | null = null;
      if (peerNode.podId) {
        const peerPod = this.db.prepare("SELECT namespace FROM pods WHERE id = ?").get(peerNode.podId) as { namespace: string | null } | undefined;
        peerPodNamespace = peerPod?.namespace ?? null;
      }

      peers.push({
        logicalId: peerNode.logicalId,
        sessionName: peerSessionName,
        runtime: peerNode.runtime ?? "unknown",
        podId: peerNode.podId ?? null,
        podNamespace: peerPodNamespace,
        memberId: peerMemberId,
      });
    }

    // 构建 edge：相对于当前节点分类为 outgoing/incoming。
    const outgoing: WhoamiResult["edges"]["outgoing"] = [];
    const incoming: WhoamiResult["edges"]["incoming"] = [];

    const edgeRows = this.db
      .prepare("SELECT source_id, target_id, kind FROM edges WHERE rig_id = ?")
      .all(nodeRow.rig_id) as EdgeRow[];

    // 构建 node ID → logicalId + sessionName 映射。
    const nodeMap = new Map<string, { logicalId: string; sessionName: string | null }>();
    for (const n of rig.nodes) {
      nodeMap.set(n.id, {
        logicalId: n.logicalId,
        sessionName: this.getCurrentSessionName(n.id, nodeRow.rig_id),
      });
    }

    for (const edge of edgeRows) {
      if (edge.source_id === nodeRow.id) {
        const target = nodeMap.get(edge.target_id);
        if (target) {
          outgoing.push({ kind: edge.kind, to: { logicalId: target.logicalId, sessionName: target.sessionName } });
        }
      } else if (edge.target_id === nodeRow.id) {
        const source = nodeMap.get(edge.source_id);
        if (source) {
          incoming.push({ kind: edge.kind, from: { logicalId: source.logicalId, sessionName: source.sessionName } });
        }
      }
    }

    // 构建 transcript 信息。
    const transcriptEnabled = this.transcriptStore.enabled && currentSessionName !== null;
    const transcriptPath = currentSessionName && transcriptEnabled
      ? this.transcriptStore.getTranscriptPath(rig.rig.name, currentSessionName)
      : null;

    const transcript: WhoamiResult["transcript"] = {
      enabled: transcriptEnabled,
      path: transcriptPath,
      tailCommand: transcriptEnabled ? `zrig transcript ${currentSessionName} --tail 100` : null,
      grepCommand: transcriptEnabled ? `zrig transcript ${currentSessionName} --grep <pattern>` : null,
    };

    // 根据 peer 构建命令示例。
    const reachablePeers = peers.filter((p) => p.sessionName !== null);
    const sendExamples = reachablePeers.slice(0, 3).map((p) => `zrig send ${p.sessionName} '消息' --verify`);
    const captureExamples = reachablePeers.slice(0, 3).map((p) => `zrig capture ${p.sessionName}`);

    // 上下文用量。OPR.0.4.0.27：compact whoami 完全跳过 contextUsageStore 查询
    //（每次启动节省 token，同时省去后台服务计算）；--full 保留该查询。
    const contextUsage = (!query.compact && this.contextUsageStore && currentSessionName)
      ? this.contextUsageStore.getForNode(nodeRow.id, currentSessionName)
      : undefined;

    // PL-012：运行时专属 context block。Codex/Claude Code 会呈现额外的调试友好详情；
    // terminal 席位没有 conversation context，返回 null。OPR.0.4.0.27：compact 时跳过。
    const runtimeContext = query.compact
      ? undefined
      : this.computeRuntimeContext(nodeRow.id, identity.runtime, contextUsage);

    // PL-007：workspace block 从 RigSpec.workspace 解析。activeRepo 优先解析工作组默认值；
    // envOverride 允许逐会话 OPENRIG_TARGET_REPO 覆盖，但仍需通过 repo 名称校验。
    const workspaceSpec = this.rigRepo.getRigWorkspace(nodeRow.rig_id);
    const workspace = resolveWorkspaceContext({
      spec: workspaceSpec,
      cwd: nodeRow.cwd,
      envOverride: query.targetRepoOverride ?? process.env["OPENRIG_TARGET_REPO"] ?? null,
    });

    return {
      resolvedBy,
      identity,
      peers,
      peersNote: "peers = 当前工作组中排除自身后的 roster（不按 edge 过滤）；edges = 有向关系；使用 `zrig ps --nodes` 查看包含自身与实时状态的 node inventory",
      edges: { outgoing, incoming },
      transcript,
      commands: { sendExamples, captureExamples },
      contextUsage,
      runtimeContext,
      workspace,
    };
  }

  /** PL-012：生成运行时专属 context block。v0 只呈现后台服务已经捕获的内容，不新增 PID/log 查询；
   *  后者需要跨后台服务 tmux adapter 的 helper 接线。数据不可用时字段如实返回 null，而不虚构。
   *  Terminal 席位的整个 block 为 null。 */
  private computeRuntimeContext(
    nodeId: string,
    runtime: string,
    contextUsage: import("./types.js").ContextUsage | undefined,
  ): RuntimeContext | null {
    if (runtime === "terminal") return null;

    const totalIn = contextUsage?.totalInputTokens ?? 0;
    const totalOut = contextUsage?.totalOutputTokens ?? 0;
    const estimatedTokens = (contextUsage?.availability === "known")
      ? (totalIn + totalOut) || null
      : null;
    const lastSampledAt = contextUsage?.sampledAt ?? null;

    if (runtime === "codex") {
      // Codex thread-id 解析需要 PID（codex-thread-id.ts 以 PID 为 key）。v0 如实返回 null，
      // 操作员需进入 terminal 提取 thread-id。具名 v0+1 触发条件：dogfood 报告需要无需进入
      // terminal 的 UI 侧 thread-id。
      return {
        runtime: "codex",
        threadId: null,
        conversationId: null,
        estimatedTokens,
        lastSampledAt,
      };
    }
    if (runtime === "claude-code") {
      // resumeToken 位于 sessions.resume_token（migration 006）。读取此节点最新的会话。
      let resumeToken: string | null = null;
      try {
        const row = this.db
          .prepare("SELECT resume_token FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
          .get(nodeId) as { resume_token: string | null } | undefined;
        resumeToken = row?.resume_token ?? null;
      } catch {
        // migration 缺失（测试 harness）时如实呈现 null。
        resumeToken = null;
      }
      return {
        runtime: "claude-code",
        resumeToken,
        estimatedTokens,
        lastSampledAt,
      };
    }
    // 未知运行时：在后台服务了解其 context exposure shape 前返回 null。PL-005 诚实降级。
    return null;
  }

  private getCurrentSessionName(nodeId: string, rigId: string): string | null {
    // 优先使用 binding 当前的 transport/session 锚点。
    const binding = this.db
      .prepare("SELECT tmux_session, external_session_name FROM bindings WHERE node_id = ?")
      .get(nodeId) as { tmux_session: string | null; external_session_name: string | null } | undefined;
    if (binding?.tmux_session) return binding.tmux_session;
    if (binding?.external_session_name) return binding.external_session_name;

    // 按 ULID 回退到最新会话。
    const sess = this.db
      .prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
      .get(nodeId) as { session_name: string } | undefined;

    return sess?.session_name ?? null;
  }
}
