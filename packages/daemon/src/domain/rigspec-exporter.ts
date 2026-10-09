import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { PodRepository } from "./pod-repository.js";
import type {
  LegacyRigSpec, LegacyRigSpecNode, LegacyRigSpecEdge,
  RigSpec, RigSpecPod, RigSpecPodMember, RigSpecPodEdge, RigSpecCrossPodEdge,
} from "./types.js";
import { RigNotFoundError } from "./errors.js";

interface RigSpecExporterDeps {
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  podRepo?: PodRepository;
}

export class RigSpecExporter {
  readonly db: import("better-sqlite3").Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private podRepo: PodRepository | null;

  constructor(deps: RigSpecExporterDeps) {
    if (deps.rigRepo.db !== deps.sessionRegistry.db) {
      throw new Error("RigSpecExporter：rigRepo 与 sessionRegistry 必须共享同一个数据库句柄");
    }
    if (deps.podRepo && deps.rigRepo.db !== deps.podRepo.db) {
      throw new Error("RigSpecExporter：podRepo 必须共享同一个数据库句柄");
    }
    this.db = deps.rigRepo.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.podRepo = deps.podRepo ?? null;
  }

  exportRig(rigId: string): LegacyRigSpec | RigSpec {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      throw new RigNotFoundError(rigId);
    }

    // 检测是否支持 pod：任一 node 的 podId 非 null，或显式存在 pod。
    const isPodAware = rig.nodes.some((n) => n.podId != null) || (this.podRepo?.getPodsForRig(rigId).length ?? 0) > 0;

    if (isPodAware && this.podRepo) {
      return this.exportPodAware(rigId, rig);
    }

    return this.exportLegacy(rigId, rig);
  }

  private exportLegacy(rigId: string, rig: import("./types.js").RigWithRelations): LegacyRigSpec {
    // 获取所有会话，用于查找 restorePolicy。
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // 构建映射：nodeId（数据库主键）-> logical_id。
    const idToLogical = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));

    const nodes: LegacyRigSpecNode[] = rig.nodes.map((node) => {
      // 查找此节点最新会话的 restorePolicy。
      const nodeSessions = sessions
        .filter((s) => s.nodeId === node.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const latestSession = nodeSessions.length > 0
        ? nodeSessions[nodeSessions.length - 1]!
        : null;

      const restorePolicy = latestSession?.restorePolicy
        ?? node.restorePolicy
        ?? undefined;

      if (!node.runtime) {
        throw new Error(`无法导出节点 '${node.logicalId}'：缺少必填 runtime`);
      }

      const specNode: LegacyRigSpecNode = {
        id: node.logicalId,
        runtime: node.runtime,
      };

      if (node.role) specNode.role = node.role;
      if (node.model) specNode.model = node.model;
      if (node.cwd) specNode.cwd = node.cwd;
      if (node.surfaceHint) specNode.surfaceHint = node.surfaceHint;
      if (node.workspace) specNode.workspace = node.workspace;
      if (restorePolicy) specNode.restorePolicy = restorePolicy;
      if (node.packageRefs && node.packageRefs.length > 0) specNode.packageRefs = node.packageRefs;

      return specNode;
    });

    const edges: LegacyRigSpecEdge[] = rig.edges.map((edge) => {
      const from = idToLogical.get(edge.sourceId);
      if (!from) {
        throw new Error(`无法导出 edge：source node ID '${edge.sourceId}' 未映射`);
      }
      const to = idToLogical.get(edge.targetId);
      if (!to) {
        throw new Error(`无法导出 edge：target node ID '${edge.targetId}' 未映射`);
      }
      return { from, to, kind: edge.kind };
    });

    return {
      schemaVersion: 1,
      name: rig.rig.name,
      version: "0.1.0",
      nodes,
      edges,
    };
  }

  private exportPodAware(rigId: string, rig: import("./types.js").RigWithRelations): RigSpec {
    const pods = this.podRepo!.getPodsForRig(rigId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // 构建查询映射。logicalId 采用 `podSpecId.memberLocalId`，需提取两部分。
    const idToLogical = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));
    const idToMemberLocal = new Map(rig.nodes.map((n) => [n.id, n.logicalId.includes(".") ? n.logicalId.split(".").slice(1).join(".") : n.logicalId]));
    const idToNode = new Map(rig.nodes.map((n) => [n.id, n]));
    const nodeIdToPodId = new Map(rig.nodes.map((n) => [n.id, n.podId]));

    // 按 podId 对节点分组。
    const nodesByPod = new Map<string, typeof rig.nodes>();
    for (const node of rig.nodes) {
      if (node.podId) {
        const list = nodesByPod.get(node.podId) ?? [];
        list.push(node);
        nodesByPod.set(node.podId, list);
      }
    }

    // 辅助函数：获取节点的 restorePolicy。
    const getRestorePolicy = (nodeId: string): string | undefined => {
      const nodeSessions = sessions
        .filter((s) => s.nodeId === nodeId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const latest = nodeSessions.length > 0 ? nodeSessions[nodeSessions.length - 1]! : null;
      return latest?.restorePolicy ?? idToNode.get(nodeId)?.restorePolicy ?? undefined;
    };

    // 构建 pod spec。
    const podSpecs: RigSpecPod[] = pods.map((pod) => {
      const podNodes = nodesByPod.get(pod.id) ?? [];
      const memberNodeIds = new Set(podNodes.map((n) => n.id));

      const members: RigSpecPodMember[] = podNodes.map((node) => {
        if (!node.runtime) {
          throw new Error(`无法导出节点 '${node.logicalId}'：缺少必填 runtime`);
        }
        const member: RigSpecPodMember = {
          id: idToMemberLocal.get(node.id) ?? node.logicalId,
          agentRef: node.agentRef ?? "",
          profile: node.profile ?? "default",
          runtime: node.runtime,
          cwd: node.cwd ?? ".",
        };
        if (node.label) member.label = node.label;
        if (node.codexConfigProfile) member.codexConfigProfile = node.codexConfigProfile;
        if (node.model) member.model = node.model;
        // OPR.0.4.6.FAC1：已声明的席位 role 随 pod member 导出；export→import 往返会保留 role。
        if (node.role) member.role = node.role;
        // OPR.0.4.8.3 Seam B：席位的原始 permission_policy ref 可往返；
        // 导出真值是 ref，绝不是已解析 provenance。
        if (node.permissionPolicy) member.permissionPolicy = node.permissionPolicy;
        if (node.sessionSource) member.sessionSource = node.sessionSource;
        const rp = getRestorePolicy(node.id);
        if (rp) member.restorePolicy = rp;
        return member;
      });

      // Pod-local edge：两个 endpoint 都位于当前 pod。
      const podEdges: RigSpecPodEdge[] = rig.edges
        .filter((e) => memberNodeIds.has(e.sourceId) && memberNodeIds.has(e.targetId))
        .map((e) => ({
          kind: e.kind,
          from: idToMemberLocal.get(e.sourceId)!,
          to: idToMemberLocal.get(e.targetId)!,
        }));

      // pod spec ID 使用 pod namespace；与 logicalId 前缀一致，例如 `dev.impl` 中的 `dev`。
      const podSpecId = pod.namespace;
      const podSpec: RigSpecPod = {
        id: podSpecId,
        label: pod.label,
        members,
        edges: podEdges,
      };
      if (pod.summary) podSpec.summary = pod.summary;
      if (pod.continuityPolicyJson) {
        try {
          podSpec.continuityPolicy = JSON.parse(pod.continuityPolicyJson);
        } catch { /* JSON 无效时跳过。 */ }
      }
      return podSpec;
    });

    // Cross-pod edge：endpoint 位于不同 pod。logicalId 已是 `podSpecId.memberLocalId`，
    // 可直接作为 qualified ref。
    const crossPodEdges: RigSpecCrossPodEdge[] = rig.edges
      .filter((e) => {
        const srcPod = nodeIdToPodId.get(e.sourceId);
        const tgtPod = nodeIdToPodId.get(e.targetId);
        return srcPod && tgtPod && srcPod !== tgtPod;
      })
      .map((e) => ({
        kind: e.kind,
        from: idToLogical.get(e.sourceId)!,
        to: idToLogical.get(e.targetId)!,
      }));

    // OPR.0.4.8.3 Seam B：工作组级 permission_policy 是 RIG-ROW 字段，无法从重新生成的 spec 派生；
    // 因此显式读取 repository，且只在已设置时输出。
    const rigPermissionPolicy = this.rigRepo.getRigPermissionPolicy(rigId);
    const workspace = this.rigRepo.getRigWorkspace(rigId);
    // #25：已选择的 Claude managed-block 文件同样是 rig-row 字段。
    const claudeManagedBlockFile = this.rigRepo.getRigClaudeManagedBlockFile(rigId);

    return {
      version: "0.2",
      name: rig.rig.name,
      ...(rigPermissionPolicy ? { permissionPolicy: rigPermissionPolicy } : {}),
      ...(claudeManagedBlockFile ? { managedBlocks: { "claude-code": claudeManagedBlockFile } } : {}),
      ...(workspace ? { workspace } : {}),
      pods: podSpecs,
      edges: crossPodEdges,
    };
  }
}
