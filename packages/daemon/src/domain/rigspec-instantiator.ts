import nodePath from "node:path";
import type Database from "better-sqlite3";
import {
  resolvePermissionPolicyAttachment,
  resolvePermissionPolicyRefValue,
  type ResolvedPolicyAttachment,
} from "./permission-policy/policy-ref.js";
import type { RigRepository } from "./rig-repository.js";
import { checkRunningNameGuard, makeRunningSessionCounter } from "./running-name-guard.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { PreflightSpecContext, RigSpecPreflight } from "./rigspec-preflight.js";
import { deriveCanonicalSessionName, validateSessionComponents } from "./session-name.js";
import { LegacyRigSpecSchema as RigSpecSchema } from "./rigspec-schema.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { LegacyRigSpecCodec as RigSpecCodec } from "./rigspec-codec.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import type { LegacyRigSpec as RigSpec, LegacyRigSpecEdge as RigSpecEdge, InstantiateOutcome, InstantiateResult } from "./types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { resolveLaunchCwd } from "./cwd-resolution.js";

// 只有这些 edge kind 会约束 launch 顺序
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

interface RigInstantiatorDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  preflight: RigSpecPreflight;
  tmuxAdapter?: import("../adapters/tmux.js").TmuxAdapter;
}

export class RigInstantiator {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private nodeLauncher: NodeLauncher;
  private preflight: RigSpecPreflight;
  private tmuxAdapter?: import("../adapters/tmux.js").TmuxAdapter;

  constructor(deps: RigInstantiatorDeps) {
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("RigInstantiator：rigRepo 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("RigInstantiator：sessionRegistry 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("RigInstantiator：eventBus 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.nodeLauncher.db) {
      throw new Error("RigInstantiator：nodeLauncher 必须共享同一个数据库句柄");
    }
    if (deps.db !== deps.preflight.db) {
      throw new Error("RigInstantiator：preflight 必须共享同一个数据库句柄");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.nodeLauncher = deps.nodeLauncher;
    this.preflight = deps.preflight;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async instantiate(spec: RigSpec): Promise<InstantiateOutcome> {
    // 1. 校验
    const raw = RigSpecCodec.parse(RigSpecCodec.serialize(spec));
    const validation = RigSpecSchema.validate(raw);
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    // 1b. S5b running-name guard（OPR.0.5.4.11）——所有 instantiator create 路径共享的唯一
    // guard，位于任何 preflight/create/launch 开销之前。RUNNING 的同名工作组会收到带指引的拒绝
    //（此路径上 all-stopped case 仍由下游 preflight 直接的 name-exists check 负责）。
    const nameGuard = checkRunningNameGuard({
      findRigsByName: (n) => this.rigRepo.findRigsByName(n),
      countRunningSessions: makeRunningSessionCounter(this.db),
    }, spec.name);
    if (!nameGuard.ok) return nameGuard;

    // 2. Preflight
    const preflightResult = await this.preflight.check(spec);
    if (!preflightResult.ready) {
      return { ok: false, code: "preflight_failed", errors: preflightResult.errors, warnings: preflightResult.warnings };
    }

    // 3. 在 materialization 前计算 launch 顺序（尽早检测 cycle）
    let launchOrder: string[];
    try {
      launchOrder = this.computeLaunchOrder(spec);
    } catch (err) {
      return {
        ok: false,
        code: "instantiate_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 4. 原子 DB materialization：工作组 + node + edge
    let rigId: string;
    const nodeIdMap: Record<string, string> = {}; // logicalId -> DB id
    try {
      const txn = this.db.transaction(() => {
        const rig = this.rigRepo.createRig(spec.name);
        rigId = rig.id;

        for (const specNode of spec.nodes) {
          const node = this.rigRepo.addNode(rig.id, specNode.id, {
            role: specNode.role,
            runtime: specNode.runtime,
            model: specNode.model,
            cwd: specNode.cwd,
            surfaceHint: specNode.surfaceHint,
            workspace: specNode.workspace,
            restorePolicy: specNode.restorePolicy,
            packageRefs: specNode.packageRefs,
          });
          nodeIdMap[specNode.id] = node.id;
        }

        for (const specEdge of spec.edges) {
          this.rigRepo.addEdge(
            rig.id,
            nodeIdMap[specEdge.from]!,
            nodeIdMap[specEdge.to]!,
            specEdge.kind
          );
        }
      });
      txn();
    } catch (err) {
      return {
        ok: false,
        code: "instantiate_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 5. 按拓扑顺序 launch node
    const nodeResults: { logicalId: string; status: "launched" | "failed"; error?: string }[] = [];
    const launchedSessionNames: string[] = [];
    const instantiateWarnings: string[] = [];

    for (const logicalId of launchOrder) {
      const result = await this.nodeLauncher.launchNode(rigId!, logicalId);
      if (result.ok) {
        nodeResults.push({ logicalId, status: "launched" });
        launchedSessionNames.push(result.sessionName);
        if (result.warnings?.length) {
          instantiateWarnings.push(...result.warnings);
        }
      } else {
        nodeResults.push({ logicalId, status: "failed", error: result.message });
      }
    }

    // 检查全部 launch 失败——终止 orphan session 并清理工作组
    const allFailed = nodeResults.every((n) => n.status === "failed");
    if (allFailed && nodeResults.length > 0) {
      const cleanup = async () => {
        if (this.tmuxAdapter) {
          for (const sessionName of launchedSessionNames) {
            const stopped = await this.tmuxAdapter.killSession(sessionName);
            if (!stopped.ok) return; // 终止被拒绝或未经验证时保留 custody。
          }
        }
        this.rigRepo.deleteRig(rigId!);
      };
      const guard = this.tmuxAdapter?.deliveryGuard;
      if (guard) await guard.lifecycle(Object.values(nodeIdMap), cleanup);
      else await cleanup();
      return {
        ok: false,
        code: "instantiate_error",
        message: "所有 node launch 均失败",
      };
    }

    // 6. 将 restorePolicy 传播到 session metadata（best-effort）
    try {
      for (const specNode of spec.nodes) {
        const restorePolicy = specNode.restorePolicy ?? "resume_if_possible";
        const sessions = this.sessionRegistry.getSessionsForRig(rigId!);
        const nodeDbId = nodeIdMap[specNode.id];
        const session = sessions.find((s) => s.nodeId === nodeDbId);
        if (session) {
          this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
            .run(restorePolicy, session.id);
        }
      }
    } catch {
      // best-effort：即使 restorePolicy propagation 失败，import 仍成功
    }

    // 6. 发出 rig.imported（best-effort）
    try {
      this.eventBus.emit({
        type: "topology.roster_recorded",
        rigId: rigId!,
        intendedNodeIds: Object.values(nodeIdMap),
        source: "materialized_topology",
      });
      this.eventBus.emit({
        type: "rig.imported",
        rigId: rigId!,
        specName: spec.name,
        specVersion: spec.version,
      });
    } catch {
      // best-effort：即使 event persistence 失败，import 仍成功
    }

    return {
      ok: true,
      result: {
        rigId: rigId!,
        specName: spec.name,
        specVersion: spec.version,
        nodes: nodeResults,
        warnings: instantiateWarnings.length > 0 ? instantiateWarnings : undefined,
      },
    };
  }

  private computeLaunchOrder(spec: RigSpec): string[] {
    const nodes = spec.nodes;
    const edges = spec.edges;

    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    for (const node of nodes) {
      inDegree[node.id] = 0;
      adjacency[node.id] = [];
    }

    for (const edge of edges) {
      if (!LAUNCH_DEPENDENCY_KINDS.has(edge.kind)) continue;

      let from: string;
      let to: string;

      if (edge.kind === "delegates_to") {
        from = edge.from;
        to = edge.to;
      } else {
        // spawned_by：target（parent）先于 source（child）
        from = edge.to;
        to = edge.from;
      }

      if (adjacency[from]) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
    }

    // 拓扑排序，以字母顺序打破平局
    const queue = Object.keys(inDegree)
      .filter((id) => inDegree[id] === 0)
      .sort();

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      const neighbors = (adjacency[current] ?? []).slice().sort();
      for (const neighbor of neighbors) {
        inDegree[neighbor] = (inDegree[neighbor] ?? 1) - 1;
        if ((inDegree[neighbor] ?? 0) === 0) {
          // 按顺序插入
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (queue[i]!.localeCompare(neighbor) > 0) {
              queue.splice(i, 0, neighbor);
              inserted = true;
              break;
            }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    // cycle 检测：若未到达全部 node，则存在 cycle
    if (order.length !== nodes.length) {
      const missing = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
      throw new Error(`检测到 node 之间存在 dependency cycle：${missing.join(", ")}`);
    }

    return order;
  }
}

// -- 感知 Pod 的实例化器（AgentSpec 重启）--

import { RigSpecCodec as PodRigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema as PodRigSpecSchema, VALID_EDGE_KINDS } from "./rigspec-schema.js";
import { rigPreflight, preflightValidatedSpec } from "./rigspec-preflight.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveNodeConfig } from "./profile-resolver.js";
import { resolveStartup } from "./startup-resolver.js";
import { planProjection, claudeConflictTargetPath, projectionConflictWarnings, filterProtectedProjections, type ProjectionPlan } from "./projection-planner.js";
import { ProjectionManifestStore } from "./projection-manifest-store.js";
import { StartupOrchestrator } from "./startup-orchestrator.js";
import { PodRepository } from "./pod-repository.js";
import type { RigSpec as PodRigSpec, RigSpecPod, RigSpecPodMember, StartupAction, StartupFile } from "./types.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "./runtime-adapter.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { installTopologyDefaults } from "./topology-defaults-installer.js";
import type {
  CompactionStrategy,
  ContinuityPolicyMaterializer,
} from "./continuity-policy-materializer.js";
import type { ReconcileSkillLoadoutResult, SkillLoadout, SkillRuntime } from "./skill-catalog.js";
import type { SystemWorldResolution } from "./system-world.js";

function defaultCultureStartupFile(): ResolvedStartupFile {
  const assetsRoot = nodePath.resolve(import.meta.dirname, "../../assets");
  return {
    path: "CULTURE-default.md",
    absolutePath: nodePath.join(assetsRoot, "guidance/CULTURE-default.md"),
    ownerRoot: assetsRoot,
    deliveryHint: "guidance_merge",
    required: true,
    appliesOn: ["fresh_start", "restore"],
  };
}

interface PodInstantiatorDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  podRepo: PodRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  startupOrchestrator: StartupOrchestrator;
  fsOps: AgentResolverFsOps;
  /** §6 协调：main 中受管 Claude 活动 hook 的交付资源路径，转发给预检
   *（默认使用后台服务随附资源；测试注入夹具）。恢复 main 中已验证的接线；它曾在重新堆叠的
   * 4.8 实例化器解决警告位置冲突时丢失。 */
  claudeActivityAssets?: { relayPath?: string; manifestPath?: string };
  adapters: Record<string, RuntimeAdapter>;
  tmuxAdapter?: TmuxAdapter;
  /** PL-016 第 4 项：可选的智能体镜像资料库，使 AgentSpec session_source: mode: agent_image
   * 条目可解析到镜像续接令牌。缺失时，agent_image 会话来源会在实例化时呈现结构化错误。 */
  agentImageLibrary?: import("./agent-images/agent-image-library-service.js").AgentImageLibraryService;
  exec?: (cmd: string) => Promise<string>;
  /** OPR.0.5.3.6——解析 typed topology.root，使 spec 已交付的 `topology/` chain-file default 在
   *  materialization 时安装（缺失时复制，best-effort）。缺失 → 不安装 default（测试、legacy
   *  composition）。 */
  topologyRootResolver?: () => string;
  /** S15——新 seat 是否接收 compact 默认 mental-model pack。在 materialization 时解析，使 config
   *  变更影响未来 launch。 */
  onboardingEnabledResolver?: () => boolean;
  /** S04——权威受管技能目录的实时配置解析器。 */
  skillsRootResolver?: () => string;
  /** S05——已选择 System World。解析失败时拒绝 preflight/launch，而非回退到其他 system selector。 */
  systemWorldResolver?: () => SystemWorldResolution;
  /** S04——harness 启动前的精确字节目录投影。对旧测试/嵌入方可选；生产环境接入共享协调器。 */
  skillReconciler?: (input: {
    loadout: SkillLoadout;
    runtime: SkillRuntime;
    cwd: string;
    apply: true;
    topologyOwner?: string;
  }) => ReconcileSkillLoadoutResult;
  /** S20 P4——startup 成功后，在现有 watchdog engine 中注册 job，从而 materialize 已选择的
   *  Claude 连续性策略。 */
  continuityPolicyMaterializer?: Pick<ContinuityPolicyMaterializer, "arm">;
}

export interface MaterializeResult {
  rigId: string;
  specName: string;
  specVersion: string;
  nodes: Array<{ logicalId: string; status: "materialized" }>;
  warnings?: string[];
}

export type MaterializeOutcome =
  | { ok: true; result: MaterializeResult }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "preflight_failed"; errors: string[]; warnings: string[] }
  | { ok: false; code: "target_rig_not_found"; message: string }
  | { ok: false; code: "materialize_conflict"; message: string }
  | { ok: false; code: "materialize_error"; message: string }
  // S5b（OPR.0.5.4.11）——running-name guard 只在 CREATE 分支拒绝（expand/add_member 传入
  // targetRigId，因此此处从不 guard）。
  | { ok: false; code: "rig_name_running"; message: string; runningRig: { id: string; name: string; runningSessionCount: number } };

export interface LaunchMaterializedNodeResult {
  logicalId: string;
  nodeId: string;
  status: "launched" | "failed" | "attention_required";
  error?: string;
  sessionName?: string;
}

export type LaunchMaterializedOutcome =
  | { ok: true; result: { nodes: LaunchMaterializedNodeResult[]; warnings?: string[] } }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "target_rig_not_found"; message: string };

/** 与新增 member 一并声明的 pod-local edge（from/to 是 pod 内的 member id；
 *  将对照新 member 与现有同 pod member 解析）。 */
export interface AddMemberEdge {
  from: string;
  to: string;
  kind: string;
}

export interface AddMemberResult {
  podId: string;
  podNamespace: string;
  node: {
    logicalId: string;
    nodeId: string;
    status: "launched" | "failed" | "attention_required";
    error?: string;
    sessionName?: string;
  };
  /** 随新增操作持久化的 pod-local edge（未声明时为空）。endpoint 是 qualified logical id。
   *  edge 暂不携带 runtime behavior（OPR.0.3.3.24 边界），只记录已声明的 topology intent。 */
  edges: Array<{ from: string; to: string; kind: string }>;
  warnings?: string[];
}

/**
 * `add_member` converge op 的结果（OPR.0.3.3.24）。重叠部分沿用 MaterializeOutcome 的
 * error vocabulary（validation_failed / preflight_failed），并增加 add-member 专属的
 * 如实错误码（rig_not_found / pod_not_found / member_conflict / edge_unresolved）。
 * 每个失败都携带可供用户操作的 message 或 error list（converge interface 向 CLI + MCP
 * 呈现的三段式 honest-error contract）。
 */
export type AddMemberOutcome =
  | { ok: true; result: AddMemberResult }
  | { ok: false; code: "rig_not_found"; message: string }
  | { ok: false; code: "pod_not_found"; message: string }
  | { ok: false; code: "member_conflict"; message: string }
  | { ok: false; code: "edge_unresolved"; message: string }
  | { ok: false; code: "materialize_error"; message: string }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "preflight_failed"; errors: string[]; warnings: string[] };

/**
 * 支持 pod 的工作组实例化器。创建 pod、node、edge，并使用已解析的 agent spec
 * 为每个 node 运行 startup orchestration。
 */
export class PodRigInstantiator {
  readonly db: Database.Database;
  private deps: PodInstantiatorDeps;

  constructor(deps: PodInstantiatorDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("PodRigInstantiator：rigRepo 必须共享同一个数据库句柄");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("PodRigInstantiator：sessionRegistry 必须共享同一个数据库句柄");
    if (deps.db !== deps.eventBus.db) throw new Error("PodRigInstantiator：eventBus 必须共享同一个数据库句柄");
    if (deps.db !== deps.nodeLauncher.db) throw new Error("PodRigInstantiator：nodeLauncher 必须共享同一个数据库句柄");
    this.db = deps.db;
    this.deps = deps;
  }

  /** preflight、materialization 与 launch 共用一个已配置 catalog root。 */
  resolveSkillsRoot(): string | undefined {
    return this.deps.skillsRootResolver?.();
  }

  private systemWorldResolutionContext(): { systemSkills?: string[]; systemWorldError?: string } {
    const resolution = this.deps.systemWorldResolver?.();
    if (!resolution) return {};
    if (!resolution.ok) return { systemWorldError: resolution.error.message };
    return { systemSkills: resolution.manifest?.skills ?? [] };
  }

  private inheritedPermissionPolicy(targetRigId: string | undefined): PreflightSpecContext["inheritedPermissionPolicy"] {
    if (!targetRigId) return undefined;
    const provenance = this.deps.rigRepo.getRigPolicyProvenance(targetRigId);
    if (!provenance?.rigRef) return undefined;
    return {
      ref: provenance.rigRef,
      origin: provenance.origin,
      launchPosture: provenance.launchPosture,
      ...(provenance.resolvedTarget ? { resolvedTarget: provenance.resolvedTarget } : {}),
      ...(provenance.declaringDir ? { declaringDir: provenance.declaringDir } : {}),
    };
  }

  async materialize(
    rigSpecYaml: string,
    rigRoot: string,
    opts?: { targetRigId?: string; suppressSummaryEvent?: boolean; cwdOverride?: string },
  ): Promise<MaterializeOutcome> {
    let raw: unknown;
    try {
      raw = PodRigSpecCodec.parse(rigSpecYaml);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    const targetRig = opts?.targetRigId ? this.deps.rigRepo.getRig(opts.targetRigId) : null;
    if (opts?.targetRigId && !targetRig) {
      return { ok: false, code: "target_rig_not_found", message: `未找到工作组 "${opts.targetRigId}"` };
    }

    const validation = PodRigSpecSchema.validate(raw, {
      externalQualifiedIds: targetRig?.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    const rigSpec = PodRigSpecSchema.normalize(raw as Record<string, unknown>);
    const preflight = await rigPreflight({
      rigSpecYaml,
      rigRoot,
      cwdOverride: opts?.cwdOverride,
      fsOps: this.deps.fsOps,
      skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(),
      rigNameOverride: targetRig?.rig.name,
      externalQualifiedIds: targetRig?.nodes.map((node) => node.logicalId),
      inheritedPermissionPolicy: this.inheritedPermissionPolicy(opts?.targetRigId),
      exec: this.deps.exec,
      claudeActivityAssets: this.deps.claudeActivityAssets, // §6: restore main's activity-hook asset threading
    });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    // OPR.0.3.3.24：解析/校验/预检是可分离的前端；持久化核心
    //（createPod、create-node、edge、event 位于同一事务）接收已解析且已校验的规格，
    // 使 `expand` 与 `add_member` converge 操作无须伪造合成工作组规格即可组合它。
    return this.materializeValidatedSpec(rigSpec, rigRoot, preflight.warnings, opts);
  }

  /**
   * 使用结构化前端实例化（OPR.0.3.3.24）：materialize() 的不经 YAML 同级路径。对已构建的原始
   * 规格对象运行同一前端（通过采用此适配器 fsOps 的预检核心执行校验和预检），随后运行持久化核心，
   * 使 `expand`（及 add_member 操作）去掉合成规格的 YAML 往返。它与 materialize(yaml) 完全等价：
   * 使用相同 validate(externalQualifiedIds)、相同预检和相同 MaterializeOutcome 错误码
   *（validation_failed / preflight_failed / target_rig_not_found / materialize_conflict）。fsOps
   * 仍封装于此（扩容服务无此能力）；该包装器只复用机制，不改变行为或分层。
   */
  async materializeStructured(
    raw: unknown,
    rigRoot: string,
    opts?: { targetRigId?: string; suppressSummaryEvent?: boolean; cwdOverride?: string },
  ): Promise<MaterializeOutcome> {
    const targetRig = opts?.targetRigId ? this.deps.rigRepo.getRig(opts.targetRigId) : null;
    if (opts?.targetRigId && !targetRig) {
      return { ok: false, code: "target_rig_not_found", message: `未找到工作组 "${opts.targetRigId}"` };
    }

    const validation = PodRigSpecSchema.validate(raw, {
      externalQualifiedIds: targetRig?.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    const rigSpec = PodRigSpecSchema.normalize(raw as Record<string, unknown>);
    const preflight = await preflightValidatedSpec(rigSpec, {
      rigRoot,
      cwdOverride: opts?.cwdOverride,
      fsOps: this.deps.fsOps,
      skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(),
      rigNameOverride: targetRig?.rig.name,
      inheritedPermissionPolicy: this.inheritedPermissionPolicy(opts?.targetRigId),
      exec: this.deps.exec,
      claudeActivityAssets: this.deps.claudeActivityAssets, // §6: restore main's activity-hook asset threading
    });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    return this.materializeValidatedSpec(rigSpec, rigRoot, preflight.warnings, opts);
  }

  /**
   * 实例化核心（OPR.0.3.3.24）：materialize 的持久化主体，接收已解析、校验和预检的
   * PodRigSpec。在同一事务中创建 Pod、成员节点（通过 create-node 原语）、边和事件。
   * 解析/校验/预检是调用方可分离的前端（materialize() 处理 YAML；expand/add_member 构建并校验
   * 结构化规格）。此切分让 `expand` 去掉合成规格权宜手段，让 `add_member` 复用准确创建路径，
   * 只创建并启动，不迁移身份。
   */
  async materializeValidatedSpec(
    rigSpec: PodRigSpec,
    rigRoot: string,
    preflightWarnings: string[],
    opts?: {
      targetRigId?: string;
      suppressSummaryEvent?: boolean;
      cwdOverride?: string;
      /** S9：普通 member growth 以此已持久化 pod 为目标。 */
      existingPodNamespace?: string;
    },
  ): Promise<MaterializeOutcome> {
    const persistedEvents: Array<ReturnType<EventBus["persistWithinTransaction"]>> = [];
    const nodeResults: Array<{ logicalId: string; status: "materialized" }> = [];

    // S5b running-name guard（OPR.0.5.4.11）——只用于 CREATE 分支：expansion（targetRigId）
    // 向现有工作组添加内容，绝不生成 name，因此此处不得触发 guard。
    if (!opts?.targetRigId) {
      const nameGuard = checkRunningNameGuard({
        findRigsByName: (n) => this.deps.rigRepo.findRigsByName(n),
        countRunningSessions: makeRunningSessionCounter(this.db),
      }, rigSpec.name);
      if (!nameGuard.ok) return nameGuard;
    }

    try {
      let materializedRigId = opts?.targetRigId ?? "";
      const tx = this.db.transaction(() => {
        if (!materializedRigId) {
          const rig = this.deps.rigRepo.createRig(rigSpec.name);
          materializedRigId = rig.id;
          persistedEvents.push(this.deps.eventBus.persistWithinTransaction({ type: "rig.created", rigId: materializedRigId }));
        }

        // PL-007：声明时持久化工作组的类型化工作区块。
        if (rigSpec.workspace) {
          this.deps.rigRepo.setRigWorkspace(materializedRigId, rigSpec.workspace);
        }
        // #25：Claude managed-block destination 是 rig-row state（两个 persist site）。
        if (rigSpec.managedBlocks?.["claude-code"]) {
          this.deps.rigRepo.setRigClaudeManagedBlockFile(materializedRigId, rigSpec.managedBlocks["claude-code"]);
        }

        // OPR.0.4.8.3 Seam B：持久化 rig-level permission_policy ref（raw，与 role 相同）——这是
        // 两个 rig-persist site 之一（materializeValidatedSpec + instantiate）；缺失任一处都会在该路径
        // 丢失工作组 ref（映射修正，独立验证）。Guard-F1：已解析的工作组附件也持久化
        //（declaringDir = 此 rigRoot，即原始声明 RigSpec 的目录），为自然席位、不同根目录下的
        // add-member 与 successor continuity 提供完整 restart 能力。严格执行（关键）。
        if (rigSpec.permissionPolicy) {
          this.deps.rigRepo.setRigPermissionPolicy(materializedRigId, rigSpec.permissionPolicy);
          const rigAttachment = resolvePermissionPolicyAttachment(rigSpec.permissionPolicy, rigRoot, {
            readFile: (p) => this.deps.fsOps.readFile(p),
          });
          this.deps.rigRepo.setRigPolicyProvenance(materializedRigId, {
            origin: rigAttachment.origin,
            resolvedTarget: rigAttachment.resolvedTarget ?? null,
            declaringDir: rigAttachment.origin === "custom" ? rigRoot : null,
            launchPosture: rigAttachment.launchPosture,
          });
        }

        const currentRig = this.deps.rigRepo.getRig(materializedRigId)!;
        const logicalIdToNodeId = new Map(currentRig.nodes.map((node) => [node.logicalId, node.id]));
        const existingPodIds = new Set(
          currentRig.nodes
            .map((node) => node.logicalId.includes(".") ? node.logicalId.split(".")[0]! : null)
            .filter((value): value is string => value !== null),
        );

        for (const pod of rigSpec.pods) {
          if (existingPodIds.has(pod.id) && opts?.existingPodNamespace !== pod.id) {
            throw { code: "materialize_conflict", message: `Pod id '${pod.id}' 已存在于工作组 '${currentRig.rig.name}' 中` };
          }
          for (const member of pod.members) {
            const qualifiedId = `${pod.id}.${member.id}`;
            if (logicalIdToNodeId.has(qualifiedId)) {
              throw { code: "materialize_conflict", message: `Logical ID '${qualifiedId}' 已存在于工作组 '${currentRig.rig.name}' 中` };
            }
          }
        }

        const podIdMap: Record<string, string> = {};
        for (const pod of rigSpec.pods) {
          const existingPod = opts?.existingPodNamespace === pod.id
            ? this.deps.podRepo.getPodByNamespace(materializedRigId, pod.id)
            : null;
          if (opts?.existingPodNamespace === pod.id && !existingPod) {
            throw { code: "materialize_conflict", message: `在工作组 '${currentRig.rig.name}' 中未找到现有 pod '${pod.id}'` };
          }
          const podRecord = existingPod ?? this.deps.podRepo.createPod(
            materializedRigId,
            pod.id,
            pod.label,
            {
              summary: pod.summary,
              continuityPolicyJson: pod.continuityPolicy ? JSON.stringify(pod.continuityPolicy) : undefined,
            },
          );
          podIdMap[pod.id] = podRecord.id;
          if (!existingPod) {
            persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
              type: "pod.created",
              rigId: materializedRigId,
              podId: podRecord.id,
              namespace: podRecord.namespace,
              label: pod.label,
            }));
          }

          for (const member of pod.members) {
            const qualifiedId = `${pod.id}.${member.id}`;
            const { node, event } = this.createMemberNode({
              rigId: materializedRigId,
              qualifiedId,
              member,
              podId: podRecord.id,
              rigRoot,
              cwdOverride: opts?.cwdOverride,
            });
            logicalIdToNodeId.set(qualifiedId, node.id);
            // Seam B R2：restart-stable provenance 在 MATERIALIZE 时持久化（materialized 但从未
            // launched 的 seat 仍必须恢复其 posture）。R2 HIGH-1：向现有工作组 expansion 时通过无
            // 通过不含工作组级 ref 的合成片段实例化；无 ref 成员必须继承持久化的
            // target-rig attachment（原始 declaring dir），绝不能丢失。
            const materializeAttachment = this.resolveMemberPolicyAttachment(member.permissionPolicy, rigSpec.permissionPolicy, rigRoot);
            if (materializeAttachment) {
              this.persistNodePolicyProvenanceStrict(node.id, materializeAttachment);
            } else if (opts?.targetRigId) {
              const rigProv = this.deps.rigRepo.getRigPolicyProvenance(materializedRigId);
              if (rigProv) {
                this.deps.rigRepo.setNodePolicyProvenance(node.id, {
                  origin: rigProv.origin,
                  resolvedTarget: rigProv.resolvedTarget,
                  declaringDir: rigProv.declaringDir,
                  launchPosture: rigProv.launchPosture,
                });
              }
            }
            nodeResults.push({ logicalId: qualifiedId, status: "materialized" });
            persistedEvents.push(event);
          }
        }

        for (const pod of rigSpec.pods) {
          for (const edge of pod.edges) {
            const fromId = logicalIdToNodeId.get(`${pod.id}.${edge.from}`);
            const toId = logicalIdToNodeId.get(`${pod.id}.${edge.to}`);
            if (!fromId || !toId) {
              throw { code: "materialize_conflict", message: `Pod-local edge 引用了缺失 node：${pod.id}.${edge.from} -> ${pod.id}.${edge.to}` };
            }
            this.deps.rigRepo.addEdge(materializedRigId, fromId, toId, edge.kind);
          }
        }

        for (const edge of rigSpec.edges) {
          const fromId = logicalIdToNodeId.get(edge.from);
          const toId = logicalIdToNodeId.get(edge.to);
          if (!fromId || !toId) {
            throw { code: "materialize_conflict", message: `Cross-pod edge 引用了缺失 node：${edge.from} -> ${edge.to}` };
          }
          this.deps.rigRepo.addEdge(materializedRigId, fromId, toId, edge.kind);
        }

        persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
          type: "topology.roster_recorded",
          rigId: materializedRigId,
          intendedNodeIds: [...logicalIdToNodeId.values()],
          source: "materialized_topology",
        }));

        if (!opts?.suppressSummaryEvent) {
          persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
            type: "rig.imported",
            rigId: materializedRigId,
            specName: rigSpec.name,
            specVersion: rigSpec.version,
          }));
        }
      });

      tx();
      for (const event of persistedEvents) {
        this.deps.eventBus.notifySubscribers(event);
      }

      // OPR.0.5.3.6——在 topology.root 下安装 spec 已交付的 topology chain-file default
      //（缺失时复制：earned context 绝不覆盖）。在 persistence transaction 后 best-effort 执行：
      // 工作组绝不会因 default copy 失败而 materialize 失败，但 failure 会作为具名 warning 呈现，
      // 绝不吞掉。
      if (this.deps.topologyRootResolver && !opts?.existingPodNamespace) {
        const defaults = installTopologyDefaults({
          specDir: rigRoot,
          rigName: rigSpec.name,
          podIds: rigSpec.pods.map((pod) => pod.id),
          topologyRoot: this.deps.topologyRootResolver(),
        });
        for (const f of defaults.failed) {
          preflightWarnings.push(`topology-defaults：无法安装 ${f.path}：${f.error}`);
        }
      }

      return {
        ok: true,
        result: {
          rigId: materializedRigId,
          specName: rigSpec.name,
          specVersion: rigSpec.version,
          nodes: nodeResults,
          warnings: preflightWarnings,
        },
      };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && "message" in err) {
        const typed = err as { code: string; message: string };
        if (typed.code === "materialize_conflict") {
          return { ok: false, code: "materialize_conflict", message: typed.message };
        }
      }
      return { ok: false, code: "materialize_error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async launchMaterialized(
    rigSpecYaml: string,
    rigRoot: string,
    targetRigId: string,
  ): Promise<LaunchMaterializedOutcome> {
    let raw: unknown;
    try {
      raw = PodRigSpecCodec.parse(rigSpecYaml);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    const targetRig = this.deps.rigRepo.getRig(targetRigId);
    if (!targetRig) {
      return { ok: false, code: "target_rig_not_found", message: `未找到工作组 "${targetRigId}"` };
    }

    const validation = PodRigSpecSchema.validate(raw, {
      externalQualifiedIds: targetRig.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    const rigSpec = PodRigSpecSchema.normalize(raw as Record<string, unknown>);
    return this.launchValidatedSpec(rigSpec, rigRoot, targetRigId);
  }

  /**
   * 启动核心（OPR.0.3.3.24）：给定已解析校验且节点已实例化的规格，计算启动顺序，并通过
   * launch-binding 原语让每个节点上线。它从 launchMaterialized 提取，使 `expand`（以及
   * add_member 操作）无须 YAML 往返即可启动结构化规格；launchMaterialized(yaml) 是其上的
   * 解析/校验/规范化前端。行为一致，循环主体原样迁移。
   */
  async launchValidatedSpec(
    rigSpec: PodRigSpec,
    rigRoot: string,
    targetRigId: string,
    cwdOverride?: string,
  ): Promise<LaunchMaterializedOutcome> {
    const launchOrder = this.computePodLaunchOrder(rigSpec);
    const podWarnings: string[] = [];
    const nodeResults: LaunchMaterializedNodeResult[] = [];

    for (const logicalId of launchOrder) {
      const memberContext = this.findMemberContext(rigSpec, logicalId);
      if (!memberContext) {
        nodeResults.push({
          logicalId,
          nodeId: "",
          status: "failed",
          error: `无法解析 member "${logicalId}" 的定义`,
        });
        continue;
      }

      const node = this.deps.rigRepo.getRig(targetRigId)?.nodes.find((entry) => entry.logicalId === logicalId);
      if (!node) {
        nodeResults.push({
          logicalId,
          nodeId: "",
          status: "failed",
          error: `materialization 后未找到 node "${logicalId}"`,
        });
        continue;
      }

      const launched = await this.launchBinding({
        rigId: targetRigId,
        rigSpec,
        rigRoot,
        pod: memberContext.pod,
        member: memberContext.member,
        qualifiedId: logicalId,
        nodeId: node.id,
        cwdOverride,
      });

      if (launched.warnings?.length) {
        podWarnings.push(...launched.warnings);
      }

      nodeResults.push({
        logicalId,
        nodeId: node.id,
        status: launched.status,
        error: launched.error,
        sessionName: launched.sessionName,
      });
    }

    return {
      ok: true,
      result: {
        nodes: nodeResults,
        warnings: podWarnings.length > 0 ? podWarnings : undefined,
      },
    };
  }

  /**
   * add_member converge 操作（OPR.0.3.3.24）：向存活工作组中的现有 Pod 添加单个成员。S9
   * 使其成为普通增长前端，复用 Pod 扩容所用的同一 materializeValidatedSpec +
   * launchValidatedSpec 效果入口；此方法负责校验与结果塑形，而非另建创建/启动事务。
   *
   * 不做身份迁移：新节点启动时生成全新的节点 ID、逻辑 ID 和 `@rigged_*`；不重新索引任何
   * 现有席位的逻辑 ID、continuity_state、队列路由或会话。这条源码可见的边界使 add_member
   * 可先交付，而 move/fork 等待 0.4.0 身份栈。
   *
   * 它通过 `podRepo.getPodByNamespace` 解析现有 pod DB id，再显式指示 shared materializer 复用
   * 该 pod。pod-exists guard 只对该具名 target 放行；保留 per-member duplicate-logical-id guard
   *（AC-3）。
   */
  async addMemberToPod(
    rigId: string,
    podNamespace: string,
    memberFragment: Record<string, unknown>,
    rigRoot: string,
    opts?: { cwdOverride?: string; edges?: Array<{ from: string; to: string; kind: string }> },
  ): Promise<AddMemberOutcome> {
    // 1. 解析工作组。
    const rig = this.deps.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", message: `未找到工作组 "${rigId}"。` };
    }

    // 2. 通过 getPodByNamespace 解析现有 pod 的 DB id（修正后的 pod-id source——不是预计算的
    // namespace->podId map）。如实返回 not-found 与可用 namespace，使 caller 可修正 handle。
    const pod = this.deps.podRepo.getPodByNamespace(rigId, podNamespace);
    if (!pod) {
      const available = this.deps.podRepo.getPodsForRig(rigId).map((p) => p.namespace);
      const hint = available.length > 0 ? available.join(", ") : "(none)";
      return {
        ok: false,
        code: "pod_not_found",
        message: `在工作组 "${rig.rig.name}" 中未找到 pod "${podNamespace}"。现有 pod：${hint}。请检查 namespace，或使用 \`zrig expand\` 添加新 pod。`,
      };
    }

    // 3. 围绕现有 Pod 构建最小的单 Pod 单成员原始规格，使新成员执行实例化前端所用的同一套
    // 校验和预检，无须完整工作组规格或 YAML 往返。成员片段以原始形式嵌入（规格 snake_case
    // 形态，与 expand 结构化路径输出一致）；校验/规范化构成类型守卫。
    const rawSpec: Record<string, unknown> = {
      version: "0.2",
      name: rig.rig.name,
      pods: [{ id: podNamespace, label: pod.label, members: [memberFragment], edges: [] }],
      edges: [],
    };

    // 4. 校验并规范化。externalQualifiedIds 是现有工作组的节点集合（与实例化前端一致），
    // 用于跨 Pod 边解析。
    const validation = PodRigSpecSchema.validate(rawSpec, {
      externalQualifiedIds: rig.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }
    const rigSpec = PodRigSpecSchema.normalize(rawSpec);
    const member = rigSpec.pods[0]!.members[0]!;
    const qualifiedId = `${podNamespace}.${member.id}`;

    // 5. 保留 per-member duplicate-logical-id guard（AC-3）。pod-exists guard 已放行（有意向 live
    // pod 添加），但生成冲突 logical id 会造成真实 seat collision——如实拒绝。
    //（validate 的 externalQualifiedIds 只解析 edge target；不拒绝与现有 node 冲突的 member，
    // 因此此 guard 是关键。）
    if (rig.nodes.some((node) => node.logicalId === qualifiedId)) {
      return {
        ok: false,
        code: "member_conflict",
        message: `Member "${qualifiedId}" 已存在于工作组 "${rig.rig.name}" 中。请选择其他 member id，或先移除现有 seat。`,
      };
    }

    // 6. 在 normalized spec 上 preflight 新 member（通过 core 使用此 adapter fsOps，执行与
    // materialize front 相同的检查）。rigNameOverride 抑制 rig-name-collision check（我们正在向
    // 现有工作组追加，与 expand structured 路径完全相同）。
    const preflight = await preflightValidatedSpec(rigSpec, {
      rigRoot,
      cwdOverride: opts?.cwdOverride,
      fsOps: this.deps.fsOps,
      skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(),
      rigNameOverride: rig.rig.name,
      inheritedPermissionPolicy: this.inheritedPermissionPolicy(rigId),
      exec: this.deps.exec,
    });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    // 7. 创建节点前校验并解析所有已声明 Pod 内部边，使错误边快速失败且不留下孤儿席位。
    // 两类明确失败：(a) 声明有效性（非数组、空字段、kind 不在规范 VALID_EDGE_KINDS 中；
    // 镜像 rigspec 的 Pod 内部边契约，而非第二条更宽松路径）→ validation_failed；
    // (b) 对照新成员和现有 Pod 同伴解析实时端点 → edge_unresolved。边尚不携带运行时行为
    //（边运行时隔离）；持久化已声明图，避免其静默丢失
    //（FM2）。
    const rawEdges = opts?.edges;
    if (rawEdges !== undefined && rawEdges !== null && !Array.isArray(rawEdges)) {
      return { ok: false, code: "validation_failed", errors: ["edges：必须是由 { from, to, kind } 组成的数组"] };
    }
    const declaredEdges = Array.isArray(rawEdges) ? rawEdges : [];
    const edgeErrors: string[] = [];
    declaredEdges.forEach((edge, i) => {
      if (typeof edge?.from !== "string" || typeof edge?.to !== "string" || typeof edge?.kind !== "string"
        || edge.from.trim() === "" || edge.to.trim() === "" || edge.kind.trim() === "") {
        edgeErrors.push(`edges[${i}]：from、to 和 kind 必须是非空字符串`);
        return;
      }
      if (!VALID_EDGE_KINDS.has(edge.kind)) {
        edgeErrors.push(`edges[${i}].kind：必须是 ${[...VALID_EDGE_KINDS].join(", ")} 之一（收到 "${edge.kind}"）`);
      }
    });
    if (edgeErrors.length > 0) {
      return { ok: false, code: "validation_failed", errors: edgeErrors };
    }
    const knownLogicalIds = new Set<string>([...rig.nodes.map((node) => node.logicalId), qualifiedId]);
    const resolvedEdges: Array<{ from: string; to: string; kind: string }> = [];
    for (const edge of declaredEdges) {
      const from = `${podNamespace}.${edge.from}`;
      const to = `${podNamespace}.${edge.to}`;
      if (!knownLogicalIds.has(from) || !knownLogicalIds.has(to)) {
        const missing = !knownLogicalIds.has(from) ? from : to;
        return { ok: false, code: "edge_unresolved", message: `Pod-local edge 引用了 "${missing}"，它既不是新 member "${qualifiedId}"，也不是工作组 "${rig.rig.name}" 中的现有 seat。请使用 pod "${podNamespace}" 内的 member id。` };
      }
      resolvedEdges.push({ from, to, kind: edge.kind });
    }

    // 8. 将已验证 member 与 edge 交给唯一 creation effect。pod-local edge 可能指向现有 pod-mate，
    // 因此上方先对照 live topology 检查，再在 schema validation 后 attach。
    rigSpec.pods[0]!.edges = declaredEdges;
    const materialized = await this.materializeValidatedSpec(rigSpec, rigRoot, preflight.warnings, {
      targetRigId: rigId,
      suppressSummaryEvent: true,
      cwdOverride: opts?.cwdOverride,
      existingPodNamespace: podNamespace,
    });
    if (!materialized.ok) {
      const message = "message" in materialized
        ? materialized.message
        : "errors" in materialized
          ? materialized.errors.join("; ")
          : "member materialization 失败";
      if (materialized.code === "materialize_conflict") {
        return { ok: false, code: "member_conflict", message };
      }
      return { ok: false, code: "materialize_error", message };
    }

    // 9. 扩容与普通增长的启动投影、交付、就绪状态和 `@rigged_*` 均由共享启动效果负责。
    const launchOutcome = await this.launchValidatedSpec(rigSpec, rigRoot, rigId, opts?.cwdOverride);
    if (!launchOutcome.ok) {
      const message = "message" in launchOutcome
        ? launchOutcome.message
        : "errors" in launchOutcome
          ? launchOutcome.errors.join("; ")
          : "member launch 失败";
      return { ok: false, code: "materialize_error", message };
    }
    const launched = launchOutcome.result.nodes.find((node) => node.logicalId === qualifiedId);
    if (!launched) {
      return { ok: false, code: "materialize_error", message: `member "${qualifiedId}" 没有返回 launch outcome。` };
    }

    return {
      ok: true,
      result: {
        podId: pod.id,
        podNamespace,
        node: {
          logicalId: qualifiedId,
          nodeId: launched.nodeId,
          status: launched.status,
          error: launched.error,
          sessionName: launched.sessionName,
        },
        edges: resolvedEdges,
        warnings: [...(materialized.result.warnings ?? []), ...(launchOutcome.result.warnings ?? [])],
      },
    };
  }

  /** 恢复 startup context 持久化前 projection 失败的 legacy gap。这是显式 first-start retry，
   *  绝不是 resume/fresh fallback。operator 在退出并清理 failed shell 后提供原始 member source。
   *  所有 effect 均由现有 validation、projection 与 startup delivery 负责；此处不伪造 node、
   *  history、token 或 startup-context row。 */
  async retryFirstStart(rigId: string, nodeId: string, memberFragment: Record<string, unknown>, rigRoot: string): Promise<
    { ok: false; code: string; message: string } |
    { ok: true; rigId: string; nodeId: string; logicalId: string; status: "launched"; sessionName?: string; warnings?: string[] }
  > {
    const guard = this.deps.tmuxAdapter?.deliveryGuard;
    if (guard && !guard.ownsLifecycle(nodeId)) {
      return guard.lifecycle([nodeId], () => this.retryFirstStart(rigId, nodeId, memberFragment, rigRoot));
    }
    const refuse = (message: string) => ({ ok: false as const, code: "first_start_retry_refused", message });
    const rig = this.deps.rigRepo.getRig(rigId);
    const node = rig?.nodes.find(n => n.id === nodeId);
    const podRow = node && this.deps.podRepo.getPodsForRig(rigId).find(p => p.id === node.podId);
    if (!rig || !node || !podRow || node.runtime === "terminal") return refuse("重试需要 pod 中已有的 agent member。");
    if (!nodePath.isAbsolute(rigRoot)) return refuse("Supply the original absolute --rig-root for agent resolution.");

    const eligible = (): string | undefined => {
      const current = this.deps.rigRepo.getRig(rigId)?.nodes.find(n => n.id === nodeId);
      if (!current || JSON.stringify(current) !== JSON.stringify(node)) return "恢复检查期间 seat 已发生变化；请先检查再重试。";
      if (this.deps.sessionRegistry.getBindingForNode(nodeId)) return "Seat 仍有绑定。请退出失败的 shell，再使用 zrig seat clean；重试绝不会停止进程。";
      if (this.db.prepare("SELECT 1 FROM node_startup_context WHERE node_id = ?").get(nodeId)) return "Startup context 已存在；请使用常规 seat lifecycle 命令。";
      const sessions = this.deps.sessionRegistry.getSessionsForRig(rigId).filter(s => s.nodeId === nodeId);
      if (sessions.length === 0 || sessions.some(s => s.status !== "exited" || s.startupStatus !== "failed" || s.origin !== "launched" || s.resumeToken)) {
        return "此前每个 session 都必须是已退出、首次启动失败且没有 native resume token 的状态。";
      }
      if (this.db.prepare("SELECT 1 FROM occupant_tenures WHERE node_id = ? AND native_session_id_at_boot IS NOT NULL").get(nodeId)
        || this.db.prepare("SELECT 1 FROM applied_launch_observations a JOIN occupant_tenures t USING (generation_uuid) WHERE t.node_id = ?").get(nodeId)) {
        return "已记录 native identity 或已应用的 launch；首次启动重试不能替换它。";
      }
      const events = this.db.prepare("SELECT type, payload FROM events WHERE node_id = ? AND type IN ('node.startup_ready', 'node.startup_failed') ORDER BY seq").all(nodeId) as Array<{ type: string; payload: string }>;
      if (events.some(e => e.type === "node.startup_ready")) return "此 seat 此前已达到 startup ready。";
      // 旧 producer 没有结构化 phase 字段。只接纳其精确 projection-failure prefix；这些失败发生在
      // startNode 的 launchHarness 之前。
      try {
        const failures = events.map(e => JSON.parse(e.payload) as { sessionId?: string; error?: string });
        if (sessions.some(s => {
          const last = failures.filter(f => f.sessionId === s.id).at(-1);
          return !last || typeof last.error !== "string" || !/^Projection (failed for |error: )/.test(last.error);
        })) return "保留的 event 无法证明每个 session 都在 native launch 前因 projection 失败。";
      } catch { return "保留的启动失败证据不可读。"; }
    };
    const initialRefusal = eligible();
    if (initialRefusal) return refuse(initialRefusal);

    const retainedFields = new Set(["id", "label", "agent_ref", "profile", "runtime", "model", "cwd", "role", "codex_config_profile", "permission_policy", "restore_policy"]);
    if (Object.keys(memberFragment).some(key => !retainedFields.has(key))) return refuse("Retry accepts only retained member fields; topology and startup overrides require a separate change.");
    const rawSpec = { version: "0.2", name: rig.rig.name, pods: [{ id: podRow.namespace, label: podRow.label, members: [memberFragment], edges: [] }], edges: [] };
    const validation = PodRigSpecSchema.validate(rawSpec);
    if (!validation.valid) return refuse(validation.errors.join("; "));
    const rigSpec = PodRigSpecSchema.normalize(rawSpec);
    const pod = rigSpec.pods[0]!;
    const member = pod.members[0]!;
    // 旧 node 未保留这些 override。拒绝猜测，也不在 recovery request 中引入新
    // startup/session-source 行为。
    if (member.startup || member.starterRef || member.sessionSource || member.compactionStrategy || member.mechanic || node.sessionSource) {
      return refuse("首次启动重试不接受未保留的 member startup、continuity 或 session-source override。");
    }
    const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
    if (`${pod.id}.${member.id}` !== node.logicalId || !same(member.agentRef, node.agentRef) || !same(member.profile, node.profile)
      || !same(member.runtime, node.runtime) || !same(member.role, node.role) || !same(member.label, node.label) || !same(member.codexConfigProfile, node.codexConfigProfile)
      || !same(member.permissionPolicy, node.permissionPolicy)) return refuse("Member source disagrees with the retained seat identity or policy.");
    const resolved = resolveAgentRef(member.agentRef, rigRoot, this.deps.fsOps);
    if (!resolved.ok) return refuse(resolved.code === "validation_failed" ? resolved.errors.join("; ") : resolved.error);
    if (!node.resolvedSpecHash || resolved.resolved.hash !== node.resolvedSpecHash) return refuse("Agent source hash 与失败的首次启动不同。");
    const config = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
      profileName: member.profile, specRoot: rigRoot, member, pod, rig: rigSpec, skillsRoot: this.resolveSkillsRoot(), ...this.systemWorldResolutionContext() });
    if (!config.ok) return refuse(config.errors.join("; "));
    if (!same(config.config.model, node.model) || !same(config.config.cwd, node.cwd) || !same(config.config.restorePolicy, node.restorePolicy)) {
      return refuse("解析得到的 model、cwd 或 restore policy 与失败的首次启动不同。");
    }
    const preflight = await preflightValidatedSpec(rigSpec, { rigRoot, fsOps: this.deps.fsOps, skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(), rigNameOverride: rig.rig.name, inheritedPermissionPolicy: this.inheritedPermissionPolicy(rigId), exec: this.deps.exec });
    if (!preflight.ready) return refuse(preflight.errors.join("; "));
    const names = new Set([deriveCanonicalSessionName(pod.id, member.id, rig.rig.name),
      ...this.deps.sessionRegistry.getSessionsForRig(rigId).filter(s => s.nodeId === nodeId).map(s => s.sessionName)]);
    try {
      for (const name of names) {
        if ((await this.deps.tmuxAdapter?.probeSession(name))?.state !== "absent") return refuse(`Session "${name}" 仍在运行或无法确定其存活状态；未尝试重试。`);
      }
    } catch { return refuse("无法确定 session 存活状态；未尝试重试。"); }
    const finalRefusal = eligible();
    if (finalRefusal) return refuse(finalRefusal);
    const result = await this.launchExistingAgentMember({ rigId, nodeId, qualifiedId: node.logicalId, rigSpec, rigRoot, pod, member,
      resolveResult: resolved, configResult: config });
    if (result.status !== "launched") return { ok: false, code: result.status, message: result.error ?? "首次启动 retry 未达到 ready。" };
    return { ok: true, rigId, nodeId, logicalId: node.logicalId, status: "launched", sessionName: result.sessionName, warnings: result.warnings };
  }

  async instantiate(rigSpecYaml: string, rigRoot: string, opts?: { cwdOverride?: string; force?: boolean; prelaunchHook?: (rigId: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }> }): Promise<InstantiateOutcome> {
    // 1. 解析并校验
    let rigSpec: PodRigSpec;
    try {
      const raw = PodRigSpecCodec.parse(rigSpecYaml);
      const validation = PodRigSpecSchema.validate(raw);
      if (!validation.valid) {
        return { ok: false, code: "validation_failed", errors: validation.errors };
      }
      rigSpec = PodRigSpecSchema.normalize(raw as Record<string, unknown>);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    // 1b. S5b running-name guard（OPR.0.5.4.11）——rig-up 路径（08-26 duplicate specimen
    // 路径）。在 preflight/create/launch 前触发：RUNNING 的同名工作组以 teaching error 拒绝，
    // 不产生开销；all-stopped generation 放行（name reuse 不变）。
    const nameGuard = checkRunningNameGuard({
      findRigsByName: (n) => this.deps.rigRepo.findRigsByName(n),
      countRunningSessions: makeRunningSessionCounter(this.db),
    }, rigSpec.name);
    if (!nameGuard.ok) return nameGuard;

    // 2. Preflight
    const preflight = await rigPreflight({ rigSpecYaml, rigRoot, cwdOverride: opts?.cwdOverride, fsOps: this.deps.fsOps, skillsRoot: this.resolveSkillsRoot(), ...this.systemWorldResolutionContext(), exec: this.deps.exec, claudeActivityAssets: this.deps.claudeActivityAssets });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    // 3. 从 edge 计算 launch 顺序（拒绝 cycle）
    //
    // OPR.0.3.2.22 Bug 2：必须在 createRig 前运行。修复前，spec 中的 cycle 会留下 orphan
    // stopped 状态工作组记录，因为循环检查运行前 createRig 已提交。对操作人员的后果是，
    // 下一次 `zrig up <builtin>` retry 就会落入“library-spec 与 restore-target 歧义”的 UX 陷阱。
    let launchOrder: string[];
    try {
      launchOrder = this.computePodLaunchOrder(rigSpec);
    } catch (err) {
      return { ok: false, code: "cycle_error", message: (err as Error).message };
    }

    // 4. cycle check 通过后创建工作组
    let rigId: string;
    try {
      const rig = this.deps.rigRepo.createRig(rigSpec.name);
      rigId = rig.id;
      // PL-007：声明时在工作组记录上持久化类型化工作区块。Whoami / node-inventory
      // 通过 getRigWorkspace() 读取它。
      if (rigSpec.workspace) {
        this.deps.rigRepo.setRigWorkspace(rigId, rigSpec.workspace);
      }
      // #25：第二个 rig-persist site（见 materializeValidatedSpec）。
      if (rigSpec.managedBlocks?.["claude-code"]) {
        this.deps.rigRepo.setRigClaudeManagedBlockFile(rigId, rigSpec.managedBlocks["claude-code"]);
      }
      // OPR.0.4.8.3 Seam B：第二个 rig-persist site（bootstrap instantiate 路径）——
      // 两处都必须写入，否则其中一条 instantiate 路径会静默丢失 rig ref。
      // Guard-F1：已解析的工作组附件也在此持久化（declaringDir = rigRoot）。
      if (rigSpec.permissionPolicy) {
        this.deps.rigRepo.setRigPermissionPolicy(rigId, rigSpec.permissionPolicy);
        const rigAttachment = resolvePermissionPolicyAttachment(rigSpec.permissionPolicy, rigRoot, {
          readFile: (p) => this.deps.fsOps.readFile(p),
        });
        this.deps.rigRepo.setRigPolicyProvenance(rigId, {
          origin: rigAttachment.origin,
          resolvedTarget: rigAttachment.resolvedTarget ?? null,
          declaringDir: rigAttachment.origin === "custom" ? rigRoot : null,
          launchPosture: rigAttachment.launchPosture,
        });
      }
    } catch (err) {
      return { ok: false, code: "instantiate_error", message: (err as Error).message };
    }

    // 5. 创建 pod、node 与 edge，再按拓扑顺序启动
    const nodeResults: { logicalId: string; status: "launched" | "failed" | "attention_required"; error?: string; evidence?: string; sessionName?: string }[] = [];
    const nodeIdMap: Record<string, string> = {}; // "pod.member" -> node DB id
    const launchedSessionNames: string[] = []; // 记录 session，以便全部失败时清理 orphan
    const podInstantiateWarnings = preflight.warnings;

    // OPR.0.5.3.6（r2-B1）——instantiate() 才是真正的 rig-up 入口（/api/up →
    // bootstrap → 此处）；与上方 rig-persist site 一样，两条实例化路径都必须安装，
    // 否则其中一条路径会静默丢失 default（materializeValidatedSpec 包含相同的 guard block）。
    // 在 node launch 前运行，让 seat 首次启动即可读取其 default。best-effort 且双重防护：
    // installer 本身从不抛错；即使注入的 fsOps 损坏，此 wrapper 也只生成具名 warning，
    // 不会使工作组失败。
    if (this.deps.topologyRootResolver) {
      try {
        const defaults = installTopologyDefaults({
          specDir: rigRoot,
          rigName: rigSpec.name,
          podIds: rigSpec.pods.map((pod) => pod.id),
          topologyRoot: this.deps.topologyRootResolver(),
        });
        for (const f of defaults.failed) {
          podInstantiateWarnings.push(`topology-defaults：无法安装 ${f.path}：${f.error}`);
        }
      } catch (err) {
        podInstantiateWarnings.push(`topology-defaults：安装程序失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // 保存各 member 的 context，供延后启动使用
    const memberContext = new Map<string, { pod: typeof rigSpec.pods[0]; member: typeof rigSpec.pods[0]["members"][0]; podId: string; nodeId: string; resolveResult: any; configResult: any }>();

    // 阶段 1：创建全部 pod 并收集 member entry
    const podIdMap: Record<string, string> = {}; // pod.id -> DB pod id
    const memberEntries: Array<{ pod: typeof rigSpec.pods[0]; member: typeof rigSpec.pods[0]["members"][0]; podId: string; qualifiedId: string }> = [];

    for (const pod of rigSpec.pods) {
      let podId: string;
      try {
        const podRecord = this.deps.podRepo.createPod(rigId, pod.id, pod.label, {
          summary: pod.summary,
          continuityPolicyJson: pod.continuityPolicy ? JSON.stringify(pod.continuityPolicy) : undefined,
        });
        podId = podRecord.id;
        podIdMap[pod.id] = podId;
      } catch (err) {
          nodeResults.push(...pod.members.map((m) => ({ logicalId: `${pod.id}.${m.id}`, status: "failed" as const, error: `Pod 创建失败：${(err as Error).message}` })));
        continue;
      }
      for (const member of pod.members) {
        memberEntries.push({ pod, member, podId, qualifiedId: `${pod.id}.${member.id}` });
      }
    }

    // 按拓扑启动顺序排列 member
    const orderMap = new Map(launchOrder.map((id, i) => [id, i]));
    memberEntries.sort((a, b) => (orderMap.get(a.qualifiedId) ?? 999) - (orderMap.get(b.qualifiedId) ?? 999));

    // 启动前 hook：service gate 在 topology setup 后、任何 node launch 前运行。
    //
    // OPR.0.3.2.22 Bug 2：若 hook 失败，则回滚 rig record，使 spec name 可供干净重试。
    // pod 通过 ON DELETE CASCADE 依赖 rig，因此删除 rig 即可。
    if (opts?.prelaunchHook) {
      const hookResult = await opts.prelaunchHook(rigId);
      if (!hookResult.ok) {
        this.deps.rigRepo.deleteRig(rigId);
        return { ok: false, code: "service_boot_failed", message: hookResult.message };
      }
    }

    // 阶段 2：按启动顺序处理 member
    for (const { pod, member, podId, qualifiedId } of memberEntries) {

        // Terminal 快速路径：跳过 agent 与 profile 解析
        if (member.agentRef === "builtin:terminal") {
          const termResult = await this.processTerminalMember(
            rigId, rigSpec, rigRoot, pod, member, podId, qualifiedId, nodeIdMap, launchedSessionNames, podInstantiateWarnings, opts?.cwdOverride,
          );
          nodeResults.push(termResult);
          continue;
        }

        // 解析 agent ref
        const resolveResult = resolveAgentRef(member.agentRef, rigRoot, this.deps.fsOps);
        if (!resolveResult.ok) {
          const msg = resolveResult.code === "validation_failed"
            ? (resolveResult as { errors: string[] }).errors.join("; ")
            : (resolveResult as { error: string }).error;
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: msg });
          continue;
        }

        // 解析 node config（profile + precedence）
        const configResult = resolveNodeConfig({
          baseSpec: resolveResult.resolved,
          importedSpecs: resolveResult.imports,
          collisions: resolveResult.collisions,
          profileName: member.profile,
          specRoot: rigRoot,
          cwdOverride: opts?.cwdOverride,
          member,
          pod,
          rig: rigSpec,
          skillsRoot: this.resolveSkillsRoot(),
          ...this.systemWorldResolutionContext(),
        });
        if (!configResult.ok) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: configResult.errors.join("; ") });
          continue;
        }

        // 创建 node
        const createUnit = this.db.transaction(() => {
          const node = this.deps.rigRepo.addNode(rigId, qualifiedId, {
            // OPR.0.4.6.FAC1（VM 发现）：支持 pod 的 bootstrap instantiate-from-YAML
            // 路径（`zrig up <spec>`）通过此处内联的 addNode 创建 agent node，而非
            // createMemberNode。因此这里需要独立接入 role，否则所有经 up 创建的工作组都会持久化
            // role=NULL，role→seat 解析永远无法匹配。这是第四个 node-creation site
            //（materialize/expand/add_member 共用 createMemberNode，此处不共用）；C1 sibling-layer
            // sweep 未发现它，因为其测试覆盖的是 createMemberNode 路径，而非 bootstrap。
            role: member.role,
            runtime: member.runtime,
            model: member.model,
            codexConfigProfile: member.codexConfigProfile,
            // OPR.0.4.8.3 Seam B：bootstrap 内联 addNode 是第四个 node-creation site
            //（见上方 role 接线注释）——必须像 createMemberNode 一样持久化 member ref，
            // 否则 `zrig up <spec>` 创建的 seat 会丢失 policy ref。
            permissionPolicy: member.permissionPolicy,
            sessionSource: member.sessionSource,
            cwd: configResult.config.cwd,
            restorePolicy: configResult.config.restorePolicy,
            podId,
            agentRef: member.agentRef,
            profile: member.profile,
            label: member.label,
            resolvedSpecName: configResult.config.resolvedSpecName,
            resolvedSpecVersion: configResult.config.resolvedSpecVersion,
            resolvedSpecHash: configResult.config.resolvedSpecHash,
          });
          // Guard multi-seat 修正（16e853a7）：node creation 与必需 provenance 是同一个原子单元
          //（SQLite savepoint）。setter 故障也会回滚 INSERT——在部分成功语义下，sibling 可以继续，
          // 但失败 member 绝不能以半创建 node 的形式存留，使 restore posture 扩大到 rig attachment。
          //（此前该行会以 provenance=null 存留，resolveRestorePosture 会落到 rig full_bypass。）
          const bootstrapAttachment = this.resolveMemberPolicyAttachment(member.permissionPolicy, rigSpec.permissionPolicy, rigRoot);
          if (bootstrapAttachment) this.persistNodePolicyProvenanceStrict(node.id, bootstrapAttachment);
          return node.id;
        });
        let nodeId: string;
        try {
          nodeId = createUnit();
          // 仅在原子单元成功后写入 nodeIdMap（Guard contract 第 2 项）。
          nodeIdMap[qualifiedId] = nodeId;
        } catch (err) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: (err as Error).message });
          continue;
        }

        const launched = await this.launchExistingAgentMember({
          rigId,
          rigSpec,
          rigRoot,
          cwdOverride: opts?.cwdOverride,
          force: opts?.force,
          pod,
          member,
          qualifiedId,
          nodeId,
          resolveResult,
          configResult,
        });
        if (launched.sessionName) {
          launchedSessionNames.push(launched.sessionName);
        }
        if (launched.warnings?.length) {
          podInstantiateWarnings.push(...launched.warnings);
        }
        nodeResults.push({
          logicalId: qualifiedId,
          status: launched.status,
          error: launched.error,
          evidence: launched.evidence,
          sessionName: launched.sessionName,
        });
      }

    // 创建 pod-local edge（所有 member 创建后）
    for (const pod of rigSpec.pods) {
      for (const edge of pod.edges) {
        const fromId = nodeIdMap[`${pod.id}.${edge.from}`];
        const toId = nodeIdMap[`${pod.id}.${edge.to}`];
        if (fromId && toId) {
          try {
            this.deps.rigRepo.addEdge(rigId, fromId, toId, edge.kind);
          } catch { /* best-effort */ }
        }
      }
    }

    // 创建 cross-pod edge
    for (const edge of rigSpec.edges) {
      const fromId = nodeIdMap[edge.from];
      const toId = nodeIdMap[edge.to];
      if (fromId && toId) {
        try {
          this.deps.rigRepo.addEdge(rigId, fromId, toId, edge.kind);
        } catch { /* best-effort */ }
      }
    }

    // OPR.0.3.2.CT（conveyor-trust-minimal-fix）：
    // 区分可恢复的 attention_required（例如工作区信任守卫）与终止性失败。
    // 只要存在 attention_required node，工作组就可由用户恢复——不得拆除。仅当每个 node
    // 都终止性失败（status === "failed"）时才执行拆除，保留既有 failure-cleanup 行为。
    //
    // 对全为 attention_required（无成功启动、无终止性失败）的情况，呈现带有各 node 可操作详情的
    // attention_required 结果。route 返回三段式 error，引导用户执行 approve→resume。session
    // 保持 startup_status='attention_required'，使 `zrig ps` 仍能列出它们，且不终止 tmux pane。
    const hasAttention = nodeResults.some((n) => n.status === "attention_required");
    const hasLaunched = nodeResults.some((n) => n.status === "launched");
    const allTerminal = nodeResults.length > 0 && nodeResults.every((n) => n.status === "failed");

    if (allTerminal) {
      const cleanup = async () => {
        if (this.deps.tmuxAdapter) {
          for (const sessionName of launchedSessionNames) {
            const stopped = await this.deps.tmuxAdapter.killSession(sessionName);
            if (!stopped.ok) return; // 不要遗忘仍受保护或状态不确定的 session。
          }
        }
        this.deps.rigRepo.deleteRig(rigId);
      };
      const guard = this.deps.tmuxAdapter?.deliveryGuard;
      if (guard) await guard.lifecycle(Object.values(nodeIdMap), cleanup);
      else await cleanup();
      const details = nodeResults.map((n) => `${n.logicalId}：${n.error ?? "未知错误"}`).join("；");
      return { ok: false, code: "instantiate_error", message: `所有 node launch/startup 均失败——${details}` };
    }

    if (hasAttention && !hasLaunched) {
      // 全 attention_required 路径——保留 rig + session，不拆除。选择恢复方式前，检查 session
      // 与 reason，以区分 native decision 和失败/退出的 runtime。
      const attentionNodes = nodeResults
        .filter((n) => n.status === "attention_required")
        .map((n) => ({
          logicalId: n.logicalId,
          sessionName: n.sessionName ?? "",
          evidence: n.evidence,
          reason: n.error ?? "node 正在等待关注",
        }));
      // 发出 rig.imported，使 caller 知道工作组存在；node 是 attention_required 而非
      // "launched"，因此 `zrig ps` 会显示正确的 lifecycle state。
      try {
        this.deps.eventBus.emit({
          type: "topology.roster_recorded",
          rigId,
          intendedNodeIds: Object.values(nodeIdMap),
          source: "materialized_topology",
        });
        this.deps.eventBus.emit({ type: "rig.imported", rigId, specName: rigSpec.name, specVersion: rigSpec.version });
      } catch { /* best-effort */ }
      return {
        ok: false,
        code: "attention_required",
        message: `${attentionNodes.length} 个 node 需要处理后才能交互。选择恢复方式前，请检查受影响的 session 与原因。`,
        rigId,
        attentionNodes,
      };
    }

    // 发出 rig.imported
    try {
      this.deps.eventBus.emit({
        type: "topology.roster_recorded",
        rigId,
        intendedNodeIds: Object.values(nodeIdMap),
        source: "materialized_topology",
      });
      this.deps.eventBus.emit({ type: "rig.imported", rigId, specName: rigSpec.name, specVersion: rigSpec.version });
    } catch { /* best-effort */ }

    // 将 sessionName + evidence 传入 InstantiateResult.nodes，使 BootstrapOrchestrator
    // 能在 launched+attention_required 混合路径构建 AttentionNode[]
    //（守卫裁定 qitem-20260518082933 BLOCKER 1）。
    const resultNodes = nodeResults.map((n) => ({
      logicalId: n.logicalId,
      status: n.status,
      error: n.error,
      sessionName: n.sessionName,
      evidence: n.evidence,
    }));

    return {
      ok: true,
      result: { rigId, specName: rigSpec.name, specVersion: rigSpec.version, nodes: resultNodes, warnings: podInstantiateWarnings.length > 0 ? podInstantiateWarnings : undefined },
    };
  }

  private computePodLaunchOrder(rigSpec: PodRigSpec): string[] {
    const LAUNCH_DEP_KINDS = new Set(["delegates_to", "spawned_by"]);
    const allIds: string[] = [];
    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    // 收集所有 qualified member id
    for (const pod of rigSpec.pods) {
      for (const member of pod.members) {
        const qid = `${pod.id}.${member.id}`;
        allIds.push(qid);
        inDegree[qid] = 0;
        adjacency[qid] = [];
      }
    }

    // 从 pod-local edge（补全限定名）与 cross-pod edge（已有限定名）构建邻接关系
    for (const pod of rigSpec.pods) {
      for (const edge of pod.edges) {
        if (!LAUNCH_DEP_KINDS.has(edge.kind)) continue;
        const from = `${pod.id}.${edge.kind === "delegates_to" ? edge.from : edge.to}`;
        const to = `${pod.id}.${edge.kind === "delegates_to" ? edge.to : edge.from}`;
        if (adjacency[from]) { adjacency[from]!.push(to); inDegree[to] = (inDegree[to] ?? 0) + 1; }
      }
    }
    for (const edge of rigSpec.edges) {
      if (!LAUNCH_DEP_KINDS.has(edge.kind)) continue;
      const from = edge.kind === "delegates_to" ? edge.from : edge.to;
      const to = edge.kind === "delegates_to" ? edge.to : edge.from;
      if (adjacency[from] && adjacency[to]) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
    }

    // 拓扑排序，以字母顺序打破平局
    const queue = allIds.filter((id) => inDegree[id] === 0).sort();
    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const neighbor of (adjacency[current] ?? []).sort()) {
        inDegree[neighbor]! -= 1;
        if (inDegree[neighbor] === 0) {
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (queue[i]!.localeCompare(neighbor) > 0) { queue.splice(i, 0, neighbor); inserted = true; break; }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    // cycle 检测：若仍有 node 未访问，则 graph 中存在 cycle
    if (order.length < allIds.length) {
      const cycled = allIds.filter((id) => !order.includes(id));
      throw new Error(`检测到 node 之间存在 dependency cycle：${cycled.join(", ")}`);
    }

    return order;
  }

  private async processTerminalMember(
    rigId: string,
    rigSpec: PodRigSpec,
    rigRoot: string,
    pod: PodRigSpec["pods"][0],
    member: RigSpecPodMember,
    podId: string,
    qualifiedId: string,
    nodeIdMap: Record<string, string>,
    launchedSessionNames: string[],
    warnings: string[],
    cwdOverride?: string,
  ): Promise<{ logicalId: string; status: "launched" | "failed"; error?: string }> {
    const effectiveCwd = resolveLaunchCwd(member.cwd, rigRoot, cwdOverride);
    // 使用 sentinel 值创建 node
    let nodeId: string;
    try {
      const node = this.deps.rigRepo.addNode(rigId, qualifiedId, {
        runtime: member.runtime,
        model: member.model,
        cwd: effectiveCwd,
        restorePolicy: "checkpoint_only",
        podId,
        agentRef: member.agentRef,
        profile: member.profile,
        label: member.label,
      });
      nodeId = node.id;
      nodeIdMap[qualifiedId] = nodeId;
    } catch (err) {
      return { logicalId: qualifiedId, status: "failed", error: (err as Error).message };
    }

    const launched = await this.launchExistingTerminalMember({
      rigId,
      rigSpec,
      rigRoot,
      cwdOverride,
      pod,
      member,
      qualifiedId,
      nodeId,
    });
    if (launched.sessionName) {
      launchedSessionNames.push(launched.sessionName);
    }
    if (launched.warnings?.length) {
      warnings.push(...launched.warnings);
    }
    return {
      logicalId: qualifiedId,
      status: launched.status,
      error: launched.error,
    };
  }

  private findMemberContext(
    rigSpec: PodRigSpec,
    qualifiedId: string,
  ): { pod: RigSpecPod; member: RigSpecPodMember } | null {
    const [podId, memberId] = qualifiedId.split(".", 2);
    if (!podId || !memberId) return null;
    const pod = rigSpec.pods.find((entry) => entry.id === podId);
    const member = pod?.members.find((entry) => entry.id === memberId);
    return pod && member ? { pod, member } : null;
  }

  /**
   * create-node primitive（OPR.0.3.3.24）：为一个 member 生成新的 node row
   *（新的 stable id + 新的 qualified logical id，`pod_id` = 给定 pod）及匹配的
   * `node.added` event。从 materialize loop 中提取，使 `add_member` converge op 与
   * 去除 YAML 的 `expand` 无须伪造合成工作组规格即可创建成员节点。
   * 不做 identity migration：addNode 生成全新 identity，不重设任何现有项的 key。
   * caller 将返回的 `event` 放入其 transaction 的 persisted-events list。
   */
  createMemberNode(input: {
    rigId: string;
    qualifiedId: string;
    member: RigSpecPodMember;
    podId: string;
    rigRoot: string;
    cwdOverride?: string;
  }) {
    const effectiveCwd = resolveLaunchCwd(input.member.cwd, input.rigRoot, input.cwdOverride);
    const node = this.deps.rigRepo.addNode(input.rigId, input.qualifiedId, {
      role: input.member.role,
      runtime: input.member.runtime,
      model: input.member.model,
      codexConfigProfile: input.member.codexConfigProfile,
      // OPR.0.4.8.3 Seam B：member 自己的 raw ref 像 role 一样持久化到 node；rig-level
      // 存在 rig row 上；precedence 在解析时应用，而非存储时。
      permissionPolicy: input.member.permissionPolicy,
      sessionSource: input.member.sessionSource,
      cwd: effectiveCwd,
      restorePolicy: input.member.restorePolicy,
      podId: input.podId,
      agentRef: input.member.agentRef,
      profile: input.member.profile,
      label: input.member.label,
    });
    const event = this.deps.eventBus.persistWithinTransaction({
      type: "node.added",
      rigId: input.rigId,
      nodeId: node.id,
      logicalId: input.qualifiedId,
    });
    return { node, event };
  }

  /**
   * launch-binding primitive（OPR.0.3.3.24）：给定已创建的 node 与其 member context，
   * 使其完全上线——harness launch + startup projection + delivery + readiness +
   * `@rigged_*` metadata。分派 terminal 与 agent 启动路径。提取为可独立调用的 primitive，
   * 让 launchMaterialized loop、`expand` 与 `add_member` converge op 均无需伪造
   * 合成工作组规格即可启动节点。行为与此前内联分派完全相同。
   */
  async launchBinding(input: {
    rigId: string;
    rigSpec: PodRigSpec;
    rigRoot: string;
    pod: RigSpecPod;
    member: RigSpecPodMember;
    qualifiedId: string;
    nodeId: string;
    cwdOverride?: string;
  }): Promise<{ status: "launched" | "failed" | "attention_required"; error?: string; evidence?: string; sessionName?: string; warnings?: string[] }> {
    return input.member.agentRef === "builtin:terminal"
      ? this.launchExistingTerminalMember(input)
      : this.launchExistingAgentMember(input);
  }

  /**
   * OPR.0.4.8.3 Seam B——seat 启动时 permission policy 唯一的 precedence + resolution
   * 位置：member ref > rig ref > absent（undefined = env-driven floor）。custom ref 相对
   * rig root（materialized rig 中声明 RigSpec 的目录）解析。两级都未附加 ref 时返回 undefined。
   */
  private resolveMemberPolicyAttachment(
    memberRef: string | undefined,
    rigRef: string | undefined | null,
    rigRoot: string,
  ): ResolvedPolicyAttachment | undefined {
    const ref = resolvePermissionPolicyRefValue(memberRef, rigRef);
    if (!ref) return undefined;
    return resolvePermissionPolicyAttachment(ref, rigRoot, {
      readFile: (p) => this.deps.fsOps.readFile(p),
    });
  }

  /** Seam B Guard-F2：严格的 materialize/add-member persist——此处 provenance 是关键的
   *  restart state；真实写入失败必须使外围 transaction 失败，绝不能提交缺少它的 node。
   *  （repository setter 在 057 前的 legacy fixture DB 上仍为 no-op，保留此窄兼容性。） */
  private persistNodePolicyProvenanceStrict(nodeId: string, attachment: ResolvedPolicyAttachment): void {
    this.deps.rigRepo.setNodePolicyProvenance(nodeId, {
      origin: attachment.origin,
      resolvedTarget: attachment.resolvedTarget ?? null,
      declaringDir: attachment.declaringDir ?? null,
      launchPosture: attachment.launchPosture,
    });
  }

  /** Seam B：启动时 refresh 保持 best-effort（对已 materialized node 做幂等重写；
   *  瞬时失败不得阻止启动）。 */
  private persistNodePolicyProvenance(nodeId: string, attachment: ResolvedPolicyAttachment): void {
    try {
      this.persistNodePolicyProvenanceStrict(nodeId, attachment);
    } catch { /* best-effort on launch refresh only */ }
  }

  private async launchExistingAgentMember(input: {
    rigId: string;
    rigSpec: PodRigSpec;
    rigRoot: string;
    pod: RigSpecPod;
    member: RigSpecPodMember;
    qualifiedId: string;
    nodeId: string;
    cwdOverride?: string;
    /** P20 atom-4——用户覆盖：覆盖用户编辑过的（operator_conflict）projection target，
     *  而非保护它们。未设置 = 保护（安全默认值）。 */
    force?: boolean;
    resolveResult?: ReturnType<typeof resolveAgentRef> extends infer T ? T : never;
    configResult?: ReturnType<typeof resolveNodeConfig> extends infer T ? T : never;
  }): Promise<{ status: "launched" | "failed" | "attention_required"; error?: string; evidence?: string; sessionName?: string; warnings?: string[] }> {
    const guard = this.deps.tmuxAdapter?.deliveryGuard;
    if (guard && !guard.ownsLifecycle(input.nodeId)) {
      return guard.lifecycle([input.nodeId], () => this.launchExistingAgentMember(input));
    }
    const resolveResult = input.resolveResult ?? resolveAgentRef(input.member.agentRef, input.rigRoot, this.deps.fsOps);
    if (!resolveResult.ok) {
      const msg = resolveResult.code === "validation_failed"
        ? (resolveResult as { errors: string[] }).errors.join("; ")
        : (resolveResult as { error: string }).error;
      return { status: "failed", error: msg };
    }

    const configResult = input.configResult ?? resolveNodeConfig({
      baseSpec: resolveResult.resolved,
      importedSpecs: resolveResult.imports,
      collisions: resolveResult.collisions,
      profileName: input.member.profile,
      specRoot: input.rigRoot,
      cwdOverride: input.cwdOverride,
      member: input.member,
      pod: input.pod,
      rig: input.rigSpec,
      skillsRoot: this.resolveSkillsRoot(),
      ...this.systemWorldResolutionContext(),
    });
    if (!configResult.ok) {
      return { status: "failed", error: configResult.errors.join("; ") };
    }

    this.updateNodeResolvedConfig(input.nodeId, configResult.config);

    // OPR.0.4.8.3 Seam B：为本次启动解析一次 seat 的 permission-policy attachment
    //（member > rig precedence；declaring dir = rig root，即声明 RigSpec 及其相对 policy file
    // 所在位置），并持久化 restart-stable provenance。R2 HIGH-1：live binding 必须与已持久化
    // 来源一致：结构化 add-member/expansion 使用合成的最小规格（无工作组级 ref）
    // 启动，因此内存 spec 未解析出内容时，以已持久化的 node provenance（在 creation tx 中写入），
    // 再以已持久化的 rig attachment 作为 binding 真相。
    const policyAttachment = this.resolveMemberPolicyAttachment(input.member.permissionPolicy, input.rigSpec.permissionPolicy, input.rigRoot);
    if (policyAttachment) this.persistNodePolicyProvenance(input.nodeId, policyAttachment);
    // R2 terminal（954d97a0）：真正缺失时显式绑定锁定的 MINIMUM FLOOR
    //（README v4：“未附加时默认采用最低权限基线”；FINAL2）——环境中的
    // OPENRIG_YOLO 绝不能扩大未附加策略的 seat 权限。缺失状态保持真实（不伪造
    // attachment/provenance），仅 lifecycle binding 是显式的。
    const launchPosture = policyAttachment?.launchPosture
      ?? this.deps.rigRepo.getNodePolicyProvenance(input.nodeId)?.launchPosture
      ?? this.deps.rigRepo.getRigPolicyProvenance(input.rigId)?.launchPosture
      ?? "floor";

    const sessionNameErrors = validateSessionComponents(input.pod.id, input.member.id, input.rigSpec.name);
    if (sessionNameErrors.length > 0) {
      return { status: "failed", error: sessionNameErrors.join("; ") };
    }

    const canonicalSessionName = deriveCanonicalSessionName(input.pod.id, input.member.id, input.rigSpec.name);
    if (
      configResult.config.skillLoadout
      && this.deps.skillReconciler
      && (configResult.config.runtime === "claude-code" || configResult.config.runtime === "codex")
    ) {
      const projection = this.deps.skillReconciler({
        loadout: configResult.config.skillLoadout,
        runtime: configResult.config.runtime,
        cwd: configResult.config.cwd,
        apply: true,
        topologyOwner: canonicalSessionName,
      });
      if (!projection.ok) {
        return {
          status: "failed",
          error: projection.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
          sessionName: canonicalSessionName,
        };
      }
    }
    // 从已解析 profile 转发各 seat 的 silenceWindowSeconds。目前不生效：live
    // SeatActivityService poller 使用全局 3 秒默认值。保留供未来 per-seat-poller 决策。
    const launchResult = await this.deps.nodeLauncher.launchNode(input.rigId, input.qualifiedId, {
      sessionName: canonicalSessionName,
      silenceWindowSeconds: configResult.config.activity?.silenceWindowSeconds,
    });
    if (!launchResult.ok) {
      return { status: "failed", error: launchResult.message };
    }

    try {
      this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
        .run(configResult.config.restorePolicy, launchResult.session.id);
    } catch { /* best-effort */ }

    const adapter = this.deps.adapters[input.member.runtime];
    if (!adapter) {
      return { status: "failed", error: `没有适用于 runtime "${input.member.runtime}" 的 adapter`, sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }

    // P20——查询 projection manifest，以区分 divergent target 是用户修改（保护）还是
    // stale-projection（可安全覆盖）。在 this.db 上执行真实的 store-backed lookup
    //（绝非 mock/null——即下方 P17 注释记录的未注入 service、失效器失效问题）。
    const projectionManifest = new ProjectionManifestStore(this.db);
    const planResult = planProjection({
      config: configResult.config,
      collisions: resolveResult.collisions,
      fsOps: this.deps.fsOps,
      // P17（finding A2）：conflict detector 的 resolver；4.8 restack 丢失 warnings-site
      // threading 后一直未注入。缺少它时，每个 entry 都会归类为 safe_projection，divergent
      // 目标会被静默覆盖。#25：Claude 席位的引导冲突目标是工作组已选择的
      // file（rig row，与 startNode 写入时绑定的 source 相同）。
      resolveTargetPath: (category, effectiveId, cwd, sourcePath) => claudeConflictTargetPath(
        category, effectiveId, cwd, sourcePath,
        input.member.runtime === "claude-code" ? this.deps.rigRepo.getRigClaudeManagedBlockFile(input.rigId) ?? undefined : undefined,
      ),
      lastHashLookup: (targetPath) => projectionManifest.lastHash(targetPath),
    });
    if (!planResult.ok) {
      return { status: "failed", error: planResult.errors.join("; "), sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }
    // P17：divergent target 不再静默处理——每个 conflict 都通过 instantiate warning
    // 呈现 file、reason 与 consequence。
    (launchResult.warnings ??= []).push(...projectionConflictWarnings(planResult.plan));

    const resolvedFiles = this.buildResolvedStartupFiles(
      resolveResult.resolved.spec,
      resolveResult.resolved.sourcePath,
      resolveResult.resolved.spec.profiles[input.member.profile],
      input.rigSpec,
      input.rigRoot,
      input.pod,
      input.member,
    );
    const managedDedupedFiles = this.dedupeProjectedManagedStartupFiles(planResult.plan, resolvedFiles);
    // P20 atom-4 PROTECT：暂不交付用户编辑过的 skill target（operator_conflict），使 adapter
    // 不会覆盖用户的编辑；除非用户强制执行（input.force）。每条 conflict warning 已说明此行为。
    const dedupedResolvedFiles = filterProtectedProjections(
      managedDedupedFiles,
      planResult.plan,
      { force: input.force },
    ).delivered;

    const binding: NodeBinding = {
      id: launchResult.binding.id,
      nodeId: input.nodeId,
      tmuxSession: launchResult.binding.tmuxSession,
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: configResult.config.cwd,
      model: configResult.config.model,
      codexConfigProfile: input.member.codexConfigProfile,
      // OPR.0.4.8.3 Seam B：已解析的 launch posture（member > rig > persisted > FLOOR）
      // 按 seat 显式绑定；adapter 将其传入 yolo-mode helper。
      launchPosture,
    };

    // session_source 分派：fork（原生运行时分叉）、rebuild（注入产物的全新启动）或
    // agent_image（PL-016 第 4 项：使用镜像续接令牌经 fork 分派）。成员上的三者互斥。
    let forkSourceOpt: { forkSource: { kind: "native_id" | "artifact_path" | "name" | "last"; value?: string } } | undefined;
    let rebuildArtifactsOpt: { rebuildArtifacts: import("./runtime-adapter.js").ResolvedStartupFile[] } | undefined;
    // 暂存已消费的 image id + library handle，使启动后 block 仅在 startupResult.ok===true 时
    // 增加 fork_count（lastUsedAt 已在 dispatch 分支中乐观更新）。
    let consumedAgentImageId: string | undefined;
    let consumedAgentImageLibrary: import("./agent-images/agent-image-library-service.js").AgentImageLibraryService | undefined;
    if (input.member.sessionSource?.mode === "fork") {
      const ref = input.member.sessionSource.ref;
      forkSourceOpt = {
        forkSource: {
          kind: ref.kind,
          ...(ref.value !== undefined ? { value: ref.value } : {}),
        },
      };
    } else if (input.member.sessionSource?.mode === "rebuild") {
      const { resolveRebuildArtifacts } = await import("./session-source-rebuild-resolver.js");
      const resolved = resolveRebuildArtifacts(input.member.sessionSource);
      if (!resolved.ok) {
        return { status: "failed", error: resolved.error, sessionName: canonicalSessionName };
      }
      rebuildArtifactsOpt = { rebuildArtifacts: resolved.files };
    } else if (input.member.sessionSource?.mode === "agent_image") {
      // PL-016 第 4 项：agent_image → 通过 library 解析，并经 native-fork 代码路径分派，
      // 从而保留 nativeResumeProbe 语义
      //（docs/as-built/architecture/adapters-and-runtimes.md § 续接真实性）。
      const library = this.deps.agentImageLibrary;
      if (!library) {
        return {
          status: "failed",
          error: `session_source: mode: agent_image 要求 daemon 接入 AgentImageLibraryService；请重启 daemon，或检查 ~/.openrig/agent-images/ 是否存在。`,
          sessionName: canonicalSessionName,
        };
      }
      const ref = input.member.sessionSource.ref;
      const version = ref.version ?? "1";
      const image = library.getByNameVersion(ref.value, version);
      if (!image) {
        return {
          status: "failed",
          error: `library 中未找到 agent image '${ref.value}' v${version}。运行 'zrig agent-image list' 查看已安装内容。`,
          sessionName: canonicalSessionName,
        };
      }
      if (image.runtime !== input.member.runtime) {
        return {
          status: "failed",
          error: `Agent image '${ref.value}' v${version} 的 runtime '${image.runtime}' 与 member '${input.member.id}' 的 runtime '${input.member.runtime}' 不匹配。`,
          sessionName: canonicalSessionName,
        };
      }
      forkSourceOpt = {
        forkSource: { kind: "native_id", value: image.sourceResumeToken },
      };
      // 启动前仅更新 lastUsedAt——记录用户消费该 image 的意图。forkCount 稍后增加，
      // 受 startupResult.ok===true 限制（见下方 startNode 后的 block）。best-effort：
      // stat 写入失败不会中止启动。
      try {
        library.recordConsumption(image.id, { incrementForkCount: false });
      } catch (err) {
        console.warn(`[zrig] 更新 agent-image ${image.id} 的统计信息失败：${(err as Error).message}`);
      }
      // 暂存已消费的 image，供启动后增加 fork-count。
      consumedAgentImageId = image.id;
      consumedAgentImageLibrary = library;
    }

    // Agent Starter 解析器分派（Agent Starter v1 纵向切片 M2）。设置 `member.starterRef` 时，
    // 将具名 registry entry 解析为 `ResolvedStartupFile[]`，置于 member 的 per-agent 与 per-pod
    // startup file 前（layer chain 最前端的新 STARTER layer）。credential scan 失败、registry
    // entry 缺失或 YAML 格式错误时，resolver 会抛错；任何抛错都会在 `startNode` 运行前中止启动
    //（不添加 STARTER layer，也不调用 adapter `deliverStartup`）——这是关键 credential-safety contract。
    let starterArtifacts: import("./runtime-adapter.js").ResolvedStartupFile[] | undefined;
    if (input.member.starterRef) {
      const { AgentStarterResolver } = await import("./agent-starter-resolver.js");
      const resolver = new AgentStarterResolver();
      try {
        const resolved = resolver.resolveStarter(input.member.starterRef.name);
        starterArtifacts = resolved.files;
      } catch (err) {
        return {
          status: "failed",
          error: `Agent Starter resolver 失败：${(err as Error).message}`,
          sessionName: canonicalSessionName,
          warnings: launchResult.warnings,
        };
      }
    }

    // STARTER layer（由 artifact 初始化的 fresh-launch context，位于 per-agent 与 per-pod layer 前）。
    // 添加到 dedupedResolvedFiles 前，使既有 `startupOrchestrator.startNode` 通过既有
    // `resolvedStartupFiles` input 消费合并后的 chain——不新增 orchestrator 分支。
    const finalResolvedStartupFiles = starterArtifacts
      ? [...starterArtifacts, ...dedupedResolvedFiles]
      : dedupedResolvedFiles;

    const startupResult = await this.deps.startupOrchestrator.startNode({
      rigId: input.rigId,
      nodeId: input.nodeId,
      sessionId: launchResult.session.id,
      binding,
      adapter,
      plan: planResult.plan,
      resolvedStartupFiles: finalResolvedStartupFiles,
      startupActions: [
        ...configResult.config.startup.actions,
        this.buildSessionIdentityAction({
          rigName: input.rigSpec.name,
          pod: input.pod,
          member: input.member,
          runtime: input.member.runtime,
          sessionName: canonicalSessionName,
          resolvedSpecName: configResult.config.resolvedSpecName,
        }),
      ],
      isRestore: false,
      ...(forkSourceOpt ?? {}),
      ...(rebuildArtifactsOpt ?? {}),
    });

    // 仅在启动成功时增加 fork_count。lastUsedAt 已在上方 agent_image dispatch 分支乐观更新。
    if (startupResult.ok && consumedAgentImageId && consumedAgentImageLibrary) {
      try {
        consumedAgentImageLibrary.recordConsumption(consumedAgentImageId, { incrementForkCount: true });
      } catch (err) {
        console.warn(`[zrig] 增加 agent-image ${consumedAgentImageId} 的 fork_count 失败：${(err as Error).message}`);
      }
    }

    if (startupResult.ok && this.deps.continuityPolicyMaterializer) {
      try {
        this.deps.continuityPolicyMaterializer.arm({
          compactionStrategy: configResult.config.compactionStrategy as CompactionStrategy,
          mechanic: configResult.config.mechanic,
          runtime: input.member.runtime,
          targetSession: canonicalSessionName,
          sessionId: launchResult.session.id,
        });
      } catch (err) {
        (launchResult.warnings ??= []).push(
          `未能为 ${canonicalSessionName} 启用 continuity policy：${(err as Error).message}`,
        );
      }
    }

    // OPR.0.3.2.CT——保留 attention_required 区别，使 instantiator 可以留下可恢复的 rig +
    // session，而非归零折叠。session row 的 startup_status 已由 startupOrchestrator.fail()
    // 持久化（见 startup-orchestrator.ts 第 223-225、241-243 行）。
    if (startupResult.ok) {
      return {
        status: "launched",
        sessionName: canonicalSessionName,
        warnings: launchResult.warnings,
      };
    }
    return {
      status: startupResult.startupStatus === "attention_required" ? "attention_required" : "failed",
      error: startupResult.errors.join("; "),
      evidence: startupResult.evidence,
      sessionName: canonicalSessionName,
      warnings: launchResult.warnings,
    };
  }

  private async launchExistingTerminalMember(input: {
    rigId: string;
    rigSpec: PodRigSpec;
    rigRoot: string;
    pod: RigSpecPod;
    member: RigSpecPodMember;
    qualifiedId: string;
    nodeId: string;
    cwdOverride?: string;
  }): Promise<{ status: "launched" | "failed"; error?: string; sessionName?: string; warnings?: string[] }> {
    const guard = this.deps.tmuxAdapter?.deliveryGuard;
    if (guard && !guard.ownsLifecycle(input.nodeId)) {
      return guard.lifecycle([input.nodeId], () => this.launchExistingTerminalMember(input));
    }
    const effectiveCwd = resolveLaunchCwd(input.member.cwd, input.rigRoot, input.cwdOverride);
    const terminalPolicyAttachment = this.resolveMemberPolicyAttachment(input.member.permissionPolicy, input.rigSpec.permissionPolicy, input.rigRoot);
    if (terminalPolicyAttachment) this.persistNodePolicyProvenance(input.nodeId, terminalPolicyAttachment);
    const terminalLaunchPosture = terminalPolicyAttachment?.launchPosture
      ?? this.deps.rigRepo.getNodePolicyProvenance(input.nodeId)?.launchPosture
      ?? this.deps.rigRepo.getRigPolicyProvenance(input.rigId)?.launchPosture
      ?? "floor"; // R2 terminal：缺失时显式使用锁定的 floor
    const sessionNameErrors = validateSessionComponents(input.pod.id, input.member.id, input.rigSpec.name);
    if (sessionNameErrors.length > 0) {
      return { status: "failed", error: sessionNameErrors.join("; ") };
    }

    const canonicalSessionName = deriveCanonicalSessionName(input.pod.id, input.member.id, input.rigSpec.name);
    const launchResult = await this.deps.nodeLauncher.launchNode(input.rigId, input.qualifiedId, { sessionName: canonicalSessionName });
    if (!launchResult.ok) {
      return { status: "failed", error: launchResult.message };
    }

    try {
      this.db.prepare("UPDATE nodes SET restore_policy = ? WHERE id = ?")
        .run("checkpoint_only", input.nodeId);
    } catch { /* best-effort */ }

    try {
      this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
        .run("checkpoint_only", launchResult.session.id);
    } catch { /* best-effort */ }

    const startup = resolveStartup({
      specStartup: { files: [], actions: [] },
      profileStartup: undefined,
      rigCultureFile: input.rigSpec.cultureFile,
      rigStartup: input.rigSpec.startup,
      podStartup: input.pod.startup,
      memberStartup: input.member.startup,
      operatorStartup: undefined,
    });
    const resolvedFiles = this.buildTerminalResolvedStartupFiles(input.rigSpec, input.rigRoot, input.pod, input.member);
    const binding: NodeBinding = {
      id: launchResult.binding.id,
      nodeId: input.nodeId,
      tmuxSession: launchResult.binding.tmuxSession,
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: effectiveCwd,
      // Seam B：终端席位没有 harness 权限姿态标志，但解析/持久化后的姿态
      //（缺失时为 floor）仍会绑定，供消费 provenance 的组件使用。
      launchPosture: terminalLaunchPosture,
    };
    const adapter = this.deps.adapters["terminal"];
    if (!adapter) {
      return { status: "failed", error: '没有适用于 runtime "terminal" 的 adapter', sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }

    const emptyPlan = {
      entries: [],
      diagnostics: [],
      conflicts: [],
      noOps: [],
      runtime: "terminal",
      cwd: effectiveCwd,
    };

    const startupResult = await this.deps.startupOrchestrator.startNode({
      rigId: input.rigId,
      nodeId: input.nodeId,
      sessionId: launchResult.session.id,
      binding,
      adapter,
      plan: emptyPlan as any,
      resolvedStartupFiles: resolvedFiles,
      startupActions: startup.actions,
      isRestore: false,
    });

    return {
      status: startupResult.ok ? "launched" : "failed",
      error: startupResult.ok ? undefined : startupResult.errors.join("; "),
      sessionName: canonicalSessionName,
      warnings: launchResult.warnings,
    };
  }

  private updateNodeResolvedConfig(
    nodeId: string,
    config: {
      restorePolicy: string;
      resolvedSpecName: string;
      resolvedSpecVersion: string;
      resolvedSpecHash: string;
    },
  ): void {
    try {
      this.db.prepare(
        `UPDATE nodes
         SET restore_policy = ?,
             resolved_spec_name = ?,
             resolved_spec_version = ?,
             resolved_spec_hash = ?
         WHERE id = ?`
      ).run(
        config.restorePolicy,
        config.resolvedSpecName,
        config.resolvedSpecVersion,
        config.resolvedSpecHash,
        nodeId,
      );
    } catch {
      /* best-effort */
    }
  }

  private buildTerminalResolvedStartupFiles(
    rigSpec: PodRigSpec,
    rigRoot: string,
    pod: RigSpecPod,
    member: RigSpecPodMember,
  ): ResolvedStartupFile[] {
    const files: ResolvedStartupFile[] = [];

    // 跳过第 1-2 层（agent base、profile）——terminal node 没有 agent spec
    // 第 3 层：zrig 文化基线，随后是工作组专属叠加层。
    files.push(defaultCultureStartupFile());
    if (rigSpec.cultureFile) {
      files.push({
        path: rigSpec.cultureFile,
        absolutePath: nodePath.resolve(rigRoot, rigSpec.cultureFile),
        ownerRoot: rigRoot,
        deliveryHint: "auto",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      });
    }
    // 第 4 层：工作组 startup
    if (rigSpec.startup) {
      for (const f of rigSpec.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }
    // 第 5 层：pod startup
    if (pod.startup) {
      for (const f of pod.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }
    // 第 6 层：member startup
    if (member.startup) {
      for (const f of member.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }

    return this.resolveAutoHints(files);
  }

  private buildResolvedStartupFiles(
    agentSpec: { startup: { files: StartupFile[] } },
    agentSourcePath: string,
    profile: { startup?: { files: StartupFile[] } } | undefined,
    rigSpec: PodRigSpec,
    rigRoot: string,
    pod: RigSpecPod,
    member: RigSpecPodMember,
  ): ResolvedStartupFile[] {
    const files: ResolvedStartupFile[] = [];
    // nodePath 在顶层导入（ESM）

    // 1. 智能体基础启动文件
    for (const f of agentSpec.startup.files) {
      files.push({ ...f, absolutePath: nodePath.resolve(agentSourcePath, f.path), ownerRoot: agentSourcePath });
    }
    // 2. Profile 启动文件
    if (profile?.startup) {
      for (const f of profile.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(agentSourcePath, f.path), ownerRoot: agentSourcePath });
      }
    }
    // 3. zrig 文化基线，随后是工作组专属叠加层。
    files.push(defaultCultureStartupFile());
    if (rigSpec.cultureFile) {
      files.push({
        path: rigSpec.cultureFile,
        absolutePath: nodePath.resolve(rigRoot, rigSpec.cultureFile),
        ownerRoot: rigRoot,
        deliveryHint: "auto",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      });
    }
    // 4. 工作组 startup
    if (rigSpec.startup) {
      for (const f of rigSpec.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }
    // 5. Pod 启动文件
    if (pod.startup) {
      for (const f of pod.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }
    // 6. 成员启动文件
    if (member.startup) {
      for (const f of member.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }

    // 7. 内置 zrig 入门叠加层（最后追加，不替换智能体引导）
    const onboardingPath = nodePath.resolve(import.meta.dirname, "../../assets/guidance/openrig-start.md");
    files.push({
      path: "openrig-start.md",
      absolutePath: onboardingPath,
      ownerRoot: nodePath.resolve(import.meta.dirname, "../../assets"),
      deliveryHint: "guidance_merge",
      required: false,
      appliesOn: ["fresh_start", "restore"],
    });

    if (this.deps.onboardingEnabledResolver?.() ?? true) {
      const assetsRoot = nodePath.resolve(import.meta.dirname, "../../assets");
      files.push(
        {
          path: "openrig-onboarding-01.md",
          absolutePath: nodePath.resolve(import.meta.dirname, "../../assets/onboarding/01-world-and-purpose.md"),
          ownerRoot: assetsRoot,
          deliveryHint: "guidance_merge",
          required: true,
          appliesOn: ["fresh_start"],
        },
        {
          path: "openrig-onboarding-02.md",
          absolutePath: nodePath.resolve(import.meta.dirname, "../../assets/onboarding/02-self-and-competent-action.md"),
          ownerRoot: assetsRoot,
          deliveryHint: "guidance_merge",
          required: true,
          appliesOn: ["fresh_start"],
        },
      );
    }

    return this.resolveAutoHints(files);
  }

  private dedupeProjectedManagedStartupFiles(
    plan: ProjectionPlan,
    files: ResolvedStartupFile[],
  ): ResolvedStartupFile[] {
    const projectedManagedGuidancePaths = new Set(
      plan.entries
        .filter((entry) => entry.category === "guidance" && entry.mergeStrategy === "managed_block")
        .map((entry) => entry.absolutePath),
    );
    return files.filter((file) => {
      if (file.deliveryHint !== "guidance_merge") {
        return true;
      }
      return !projectedManagedGuidancePaths.has(file.absolutePath);
    });
  }

  private buildSessionIdentityAction(input: {
    rigName: string;
    pod: RigSpecPod;
    member: RigSpecPodMember;
    runtime: string;
    sessionName: string;
    resolvedSpecName?: string | null;
  }): StartupAction {
    const lines = [
      input.sessionName,
      "zrig session 身份：",
      `- rig: ${input.rigName}`,
      `- pod: ${input.pod.id}`,
      `- pod_label: ${input.pod.label}`,
      `- member: ${input.member.id}`,
      input.member.label ? `- member_label: ${input.member.label}` : null,
      `- logical_id: ${input.pod.id}.${input.member.id}`,
      input.resolvedSpecName ? `- agent_spec: ${input.resolvedSpecName}` : null,
      `- runtime: ${input.runtime}`,
      `- session: ${input.sessionName}`,
      "这是你的启动身份提示。要在 compaction 后可靠恢复身份，请运行：",
      "  zrig whoami --json",
      "该命令会返回完整 topology context：rig、pod、peer、edge 与 transcript path。",
    ].filter((line): line is string => Boolean(line));

    return {
      type: "send_text",
      value: lines.join("\n"),
      phase: "after_ready",
      appliesOn: ["fresh_start", "restore"],
      idempotent: true,
      builtin: "session_identity",
    };
  }

  /**
   * 在 plan 阶段把所有剩余的 'auto' delivery hint 解析为具体 hint。使用共享的
   * resolveConcreteHint resolver（唯一真相源）。此后不应再有文件满足 deliveryHint === 'auto'。
   */
  private resolveAutoHints(files: ResolvedStartupFile[]): ResolvedStartupFile[] {
    return files.map((f) => {
      if (f.deliveryHint !== "auto") return f;
      try {
        const content = this.deps.fsOps.readFile(f.absolutePath);
        return { ...f, deliveryHint: resolveConcreteHint(f.path, content) };
      } catch {
        // 文件无法读取时，默认使用 send_text（最安全——在 harness ready 后交付）
        return { ...f, deliveryHint: "send_text" as const };
      }
    });
  }
}
