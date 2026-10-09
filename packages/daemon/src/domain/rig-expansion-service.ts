import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { EventBus } from "./event-bus.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { PodRigInstantiator } from "./rigspec-instantiator.js";
import type { SessionRegistry } from "./session-registry.js";
import type { ExpansionRequest, ExpansionResult, ExpansionNodeOutcome } from "./types.js";
import { RigSpecSchema as PodRigSpecSchema } from "./rigspec-schema.js";

interface RigExpansionServiceDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  podInstantiator: PodRigInstantiator;
  sessionRegistry: SessionRegistry;
}

/**
 * 组合 PodRigInstantiator.materialize() 的拓扑持久化能力与 NodeLauncher 的新节点启动能力，
 * 编排实时工作组扩展。
 */
export class RigExpansionService {
  private deps: RigExpansionServiceDeps;

  constructor(deps: RigExpansionServiceDeps) {
    this.deps = deps;
  }

  async expand(request: ExpansionRequest): Promise<ExpansionResult> {
    // 1. 校验工作组存在。
    const rig = this.deps.rigRepo.getRig(request.rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: `未找到工作组 "${request.rigId}"` };
    }

    // 2. 以结构化对象构造单 Pod 规格（OPR.0.3.3.24：不进行合成规格 YAML 往返）。
    // 它会直接经过 materialize 的结构化前端（校验 + 预检 + 持久化核心）和启动核心。
    const pod = request.pod;
    const specObject = this.buildExpansionSpecObject(rig.rig.name, pod, request.crossPodEdges);

    // 3. 物化拓扑（抑制 rig.imported 事件）。
    const materializeResult = await this.deps.podInstantiator.materializeStructured(
      specObject,
      request.rigRoot ?? ".",
      { targetRigId: request.rigId, suppressSummaryEvent: true },
    );

    if (!materializeResult.ok) {
      const code = materializeResult.code;
      const message = "message" in materializeResult
        ? materializeResult.message
        : "errors" in materializeResult
          ? materializeResult.errors.join("; ")
          : "materialization failed";
      return { ok: false, code, error: message };
    }

    // 4. 查找新创建的 Pod 与节点。
    const updatedRig = this.deps.rigRepo.getRig(request.rigId)!;
    const newNodes = materializeResult.result.nodes;
    const newPod = updatedRig.nodes
      .filter((n) => newNodes.some((nn) => nn.logicalId === n.logicalId))
      .map((n) => n.podId)
      .find((id) => id !== null);

    const podId = newPod ?? "";
    const podNamespace = pod.id;

    // 5. 使用结构化规格经启动核心启动并完全拉起新节点；不进行 YAML 往返，normalize 为纯函数。
    const launchOutcome = await this.deps.podInstantiator.launchValidatedSpec(
      PodRigSpecSchema.normalize(specObject as Record<string, unknown>),
      request.rigRoot ?? ".",
      request.rigId,
    );
    if (!launchOutcome.ok) {
      const message = "message" in launchOutcome
        ? launchOutcome.message
        : "errors" in launchOutcome
          ? launchOutcome.errors.join("; ")
          : "launch failed";
      return { ok: false, code: launchOutcome.code, error: message };
    }

    const nodeOutcomes: ExpansionNodeOutcome[] = launchOutcome.result.nodes.map((node) => ({
      logicalId: node.logicalId,
      nodeId: node.nodeId,
      status: node.status,
      error: node.error,
      sessionName: node.sessionName,
    }));
    const warnings = [
      ...(materializeResult.result.warnings ?? []),
      ...(launchOutcome.result.warnings ?? []),
    ];
    const retryTargets = nodeOutcomes
      .filter((node) => node.status === "failed")
      .map((node) => node.logicalId);

    // 6. 判定整体状态。
    const launched = nodeOutcomes.filter((n) => n.status === "launched").length;
    const failed = nodeOutcomes.filter((n) => n.status === "failed").length;
    const status: "ok" | "partial" | "failed" = failed === 0 ? "ok" : launched > 0 ? "partial" : "failed";

    // 7. 发出 rig.expanded 事件。
    this.deps.eventBus.emit({
      type: "rig.expanded",
      rigId: request.rigId,
      podId,
      podNamespace,
      nodes: nodeOutcomes,
      status,
    });

    return {
      ok: true,
      status,
      podId,
      podNamespace,
      nodes: nodeOutcomes,
      warnings,
      retryTargets,
    };
  }

  private buildExpansionSpecObject(
    rigName: string,
    pod: ExpansionRequest["pod"],
    crossPodEdges?: ExpansionRequest["crossPodEdges"],
  ): Record<string, unknown> {
    const syntheticSpec: Record<string, unknown> = {
      version: "0.2",
      name: rigName,
      pods: [
        {
          id: pod.id,
          label: pod.label,
          ...(pod.summary ? { summary: pod.summary } : {}),
          members: pod.members.map((member) => ({
            id: member.id,
            runtime: member.runtime,
            ...(member.agentRef ? { agent_ref: member.agentRef } : {}),
            ...(member.profile ? { profile: member.profile } : {}),
            ...(member.codexConfigProfile ? { codex_config_profile: member.codexConfigProfile } : {}),
            // OPR.0.4.8.3 接缝 B：permission_policy 与 role 一样经过 fragment→spec 映射。
            // R2（4ac243c3）：保留存在性——已存在但无效的值（null 等）会流向规范校验器；
            // 只有真正缺失的键才省略。
            ...("permissionPolicy" in member && member.permissionPolicy !== undefined
              ? { permission_policy: member.permissionPolicy }
              : {}),
            ...(member.cwd ? { cwd: member.cwd } : {}),
            ...(member.model ? { model: member.model } : {}),
            // OPR.0.4.6.FAC1：role 经过 fragment→spec 映射；已提供的 role 绝不能在此静默丢弃。
            ...(member.role ? { role: member.role } : {}),
            ...(member.restorePolicy ? { restore_policy: member.restorePolicy } : {}),
            ...(member.label ? { label: member.label } : {}),
            // OPR.0.5.6.3 修复修订：忠实携带 session_source。路由已把有效形状规范化为
            // 类型化 spec（字段名同为 snake_case）；已存在但无效的值则以原始形式继续流转，
            // 由唯一规范 RigSpec 校验器从结构上拒绝。在此逐字段重映射正是原始丢失点
            //（ref.version，wave-1 R2），也会在保留原始输入时崩溃；忠实携带无需维护可能遗漏的
            // 字段列表。是否输出由键是否存在决定，绝不能按 truthiness；null/false/原始值
            // 在规范校验前都不得消失。
            ...("sessionSource" in member ? { session_source: member.sessionSource } : {}),
            ...(member.starterRef ? {
              starter_ref: { name: member.starterRef.name },
            } : {}),
          })),
          edges: pod.edges.map((edge) => ({
            kind: edge.kind,
            from: edge.from,
            to: edge.to,
          })),
        },
      ],
      edges: (crossPodEdges ?? []).map((edge) => ({
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
      })),
    };

    return syntheticSpec;
  }
}
