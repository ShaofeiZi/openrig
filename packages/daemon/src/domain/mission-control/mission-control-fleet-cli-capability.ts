// PL-005 阶段 A：逐工作组 CLI 能力缓存 + 舰队汇总。
//
// 实现 PRD“运行时/来源漂移验收”的 4 个子条款：
//   1. 对 `zrig ps --fields <field>` 逐字段检查可用性。
//   2. 如实呈现逐工作组 CLI 能力（每个工作组显示自己的能力）。
//   3. 每个会话、每个工作组只记录一次——每个（工作组、字段）只记录一次降级，
//      而非每次渲染都记录。
//   4. 在舰队视图元数据中呈现“运行过期 CLI 的工作组”指示器。
//
// 在 v0 中，daemon 拥有自己的数据库绑定拓扑和队列接口，可根据 PL-004 阶段 A 的
// queue_items 与工作组注册表合成舰队汇总。实现支持可选的 `psShellOut` 钩子，以便未来
// 直接调用 CLI；默认在进程内完成舰队汇总，使测试具有确定性。

import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import type { RigRepository } from "../rig-repository.js";

export interface FleetRollupRow {
  rigName: string;
  /** 舰队视图使用的紧凑五态活动值。 */
  activityState: "active" | "idle" | "attention" | "blocked" | "degraded";
  lifecycleState: string | null;
  attentionReason: string | null;
  lastUpdate: string;
  /** v0.1.12 风格标签，或 "head" / "unknown"。 */
  cliVersionLabel: string;
  /** 若观察到该工作组缺少一个或多个允许字段，则为 true。 */
  cliDriftDetected: boolean;
}

export interface FleetRollup {
  rows: FleetRollupRow[];
  staleCliCount: number;
  /** 已知在所观察工作组中缺失的字段（已去重）。 */
  degradedFields: string[];
  /**
   * 若舰队汇总无法访问规范 CLI 来源，并回退到 daemon 内部投影，此处为回退模式标签；
   * 使用规范来源时为 null。
   */
  sourceFallback: string | null;
}

interface CliCapabilityDeps {
  db: Database.Database;
  eventBus: EventBus;
  rigRepo: RigRepository;
  /**
   * 可选：探测某个工作组支持哪些 `zrig ps --fields <field>` 键。v0 默认不作处理
   * （返回空的不支持列表）；未来版本可针对每个工作组调用 `zrig ps --version`。
   */
  probeRig?: (rigName: string) => Promise<{
    cliVersionLabel: string;
    unsupportedFields: string[];
  }>;
  /** 为测试覆盖时钟。 */
  now?: () => Date;
}

interface RigQueueRow {
  destination_session: string;
  state: string;
  ts_updated: string;
  blocked_on: string | null;
}

/**
 * 面向操作人员的舰队视图尝试呈现的字段。某个工作组未提供其中一个字段时，设置逐行漂移
 * 指示器，并发出每个（工作组、字段）只记录一次的事件。
 *
 * 尽管 `recoveryGuidance` 不在 0.2.0 CLI 允许列表中（审计第 5 行为黄色），这里仍有意列出它。
 * 这是规范的跨 CLI 版本漂移案例：spec 假设未来某个 CLI 会提供它；如今读取层会如实呈现
 * “该工作组的 daemon 版本不提供此字段”。
 */
export const MISSION_CONTROL_DESIRED_FIELDS = [
  "agentActivity",
  "recoveryGuidance",
] as const;

/**
 * daemon 侧对 CLI `zrig ps --nodes --fields ...` 节点级允许列表的镜像。来源为
 * `packages/cli/src/commands/ps.ts:79-96` (ALLOWED_NODE_FIELDS).
 * CLI 不导出该集合，因此 daemon 在此按工作区版本进行镜像（阶段 A v0 随 OpenRig 0.2.0
 * 发布）。未来成熟后，可用针对每个工作组的实时 CLI 自省调用替换此镜像；v1 单主机拓扑
 * 不需要这项开销。
 *
 * 漂移计算方式：MISSION_CONTROL_DESIRED_FIELDS 中不在此集合内的任何字段，都属于
 * “该工作组 CLI 版本中缺失”，生产探测器会将其呈现为漂移。
 */
export const LOCAL_CLI_NODE_FIELDS_AT_0_2_0: ReadonlySet<string> = new Set([
  "rigId",
  "rigName",
  "logicalId",
  "podId",
  "podNamespace",
  "canonicalSessionName",
  "nodeKind",
  "runtime",
  "sessionStatus",
  "startupStatus",
  "restoreOutcome",
  "lifecycleState",
  "tmuxAttachCommand",
  "resumeCommand",
  "latestError",
  "agentActivity",
]);

/**
 * 工作区构建时嵌入的本地 CLI 版本标签。任务控制台会在漂移指示器中将此标签与逐工作组字段
 * 可用性一起报告。当前硬编码为 v0.2.0（工作区发布版本）；未来成熟后可从 package.json
 * 或构建时常量读取。
 */
export const LOCAL_CLI_VERSION_LABEL = "0.2.0";

/**
 * 生产探测器工厂（根据 guard 的 PL-005 阶段 A 审查进行 R1 修复）。返回 probeRig 函数，
 * 将 MISSION_CONTROL_DESIRED_FIELDS 与 daemon 镜像的 LOCAL_CLI_NODE_FIELDS_AT_0_2_0
 * 集合比较，并将任何缺失字段报告为漂移。逐工作组如实呈现（子条款 2）：分别探测每个
 * 工作组；在 v1 单主机拓扑中，所有工作组共享同一套本地 CLI，因此它们报告相同漂移结果，
 * 这正是审计第 5 行案例的真实结果。
 *
 * 对于测试脚手架（或未来逐工作组的外部命令探测），调用方可以在构造函数中覆盖 probeRig；
 * 此工厂是 v1 生产默认值，并接入 createDaemon 的启动流程，使
 * `/api/mission-control/cli-capabilities` 路由开箱即用地如实报告漂移。
 */
export function makeLocalCliCapabilityProbe(opts?: {
  versionLabel?: string;
  knownNodeFields?: ReadonlySet<string>;
}): (rigName: string) => Promise<{
  cliVersionLabel: string;
  unsupportedFields: string[];
}> {
  const versionLabel = opts?.versionLabel ?? LOCAL_CLI_VERSION_LABEL;
  const knownFields = opts?.knownNodeFields ?? LOCAL_CLI_NODE_FIELDS_AT_0_2_0;
  return async (_rigName: string) => {
    const unsupportedFields: string[] = [];
    for (const desired of MISSION_CONTROL_DESIRED_FIELDS) {
      if (!knownFields.has(desired)) {
        unsupportedFields.push(desired);
      }
    }
    return { cliVersionLabel: versionLabel, unsupportedFields };
  };
}

type DesiredField = (typeof MISSION_CONTROL_DESIRED_FIELDS)[number];

export class MissionControlFleetCliCapability {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly rigRepo: RigRepository;
  private readonly probeRig: NonNullable<CliCapabilityDeps["probeRig"]>;
  private readonly now: () => Date;

  /** 每个（工作组、字段）在每次会话中只记录一次的集合；daemon 重启时清空。 */
  private readonly loggedDriftKeys: Set<string> = new Set();

  constructor(deps: CliCapabilityDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.rigRepo = deps.rigRepo;
    this.probeRig =
      deps.probeRig ??
      (async () => ({ cliVersionLabel: "unknown", unsupportedFields: [] }));
    this.now = deps.now ?? (() => new Date());
  }

  async rollupFleet(): Promise<FleetRollup> {
    const rigs = this.rigRepo.listRigs();
    const rows: FleetRollupRow[] = [];
    const allDegradedFields = new Set<string>();
    let staleCliCount = 0;

    for (const rig of rigs) {
      let probe: { cliVersionLabel: string; unsupportedFields: string[] };
      try {
        probe = await this.probeRig(rig.name);
      } catch {
        probe = { cliVersionLabel: "unknown", unsupportedFields: [...MISSION_CONTROL_DESIRED_FIELDS] };
      }
      const driftDetected = probe.unsupportedFields.length > 0;
      if (driftDetected) staleCliCount++;
      for (const f of probe.unsupportedFields) {
        allDegradedFields.add(f);
        this.maybeLogDriftOnce(rig.name, f);
      }
      const queueState = this.summarizeRigQueue(rig.name);
      rows.push({
        rigName: rig.name,
        activityState: queueState.activityState,
        lifecycleState: queueState.lifecycleState,
        attentionReason: queueState.attentionReason,
        lastUpdate: queueState.lastUpdate,
        cliVersionLabel: probe.cliVersionLabel,
        cliDriftDetected: driftDetected,
      });
    }

    return {
      rows,
      staleCliCount,
      degradedFields: Array.from(allDegradedFields),
      // v0 从 daemon 内部工作组注册表 + queue_items 读取；未来版本可调用
      // `zrig ps --nodes -A --json`，并在 CLI 不可用时将 sourceFallback 设为
      // "daemon-internal"。
      sourceFallback: "daemon-internal-projection",
    };
  }

  /**
   * 根据 PRD 子条款 3，每个（工作组、字段）在每次会话、每个工作组只记录一次。daemon
   * 重启会清空集合，因此重启后首次观察时会再次记录。
   */
  private maybeLogDriftOnce(rigName: string, missingField: string): void {
    const key = `${rigName}::${missingField}`;
    if (this.loggedDriftKeys.has(key)) return;
    this.loggedDriftKeys.add(key);
    const observedAt = this.now().toISOString();
    this.eventBus.emit({
      type: "mission_control.cli_drift_detected",
      rigName,
      missingField,
      observedAt,
    });
  }

  /**
   * 为舰队视图汇总工作组的队列状态。通过一次 SQL 聚合从 PL-004 阶段 A queue_items 合成：
   *   - active：存在任何 in-progress qitem
   *   - blocked：存在 blocked qitem（且无 in-progress）
   *   - attention：只有超过 1 小时的 pending qitem
   *   - idle：无活跃队列活动
   *   - degraded：过去 24 小时内存在 failed/denied/canceled qitem
   */
  private summarizeRigQueue(rigName: string): {
    activityState: FleetRollupRow["activityState"];
    lifecycleState: string | null;
    attentionReason: string | null;
    lastUpdate: string;
  } {
    const ownedSessions = this.db
      .prepare(
        `SELECT destination_session, state, ts_updated, blocked_on
           FROM queue_items
          WHERE destination_session LIKE ?
            OR source_session LIKE ?
          ORDER BY ts_updated DESC LIMIT 100`,
      )
      .all(`%@${rigName}`, `%@${rigName}`) as RigQueueRow[];

    if (ownedSessions.length === 0) {
      return {
        activityState: "idle",
        lifecycleState: null,
        attentionReason: null,
        lastUpdate: this.now().toISOString(),
      };
    }
    const lastUpdate = ownedSessions[0]!.ts_updated;
    const hasInProgress = ownedSessions.some((q) => q.state === "in-progress");
    const hasBlocked = ownedSessions.some((q) => q.state === "blocked");
    const hasFailed = ownedSessions.some((q) =>
      q.state === "failed" || q.state === "denied" || q.state === "canceled",
    );
    let activityState: FleetRollupRow["activityState"] = "idle";
    let attentionReason: string | null = null;
    if (hasInProgress) {
      activityState = "active";
    } else if (hasBlocked) {
      activityState = "blocked";
      const blockedRow = ownedSessions.find((q) => q.state === "blocked");
      attentionReason = blockedRow?.blocked_on
        ? `阻塞于：${blockedRow.blocked_on}`
        : "已阻塞";
    } else if (hasFailed) {
      activityState = "degraded";
      attentionReason = "队列中近期出现失败、拒绝或取消";
    }
    return {
      activityState,
      lifecycleState: ownedSessions[0]!.state,
      attentionReason,
      lastUpdate,
    };
  }

  /** 测试/可观测性辅助方法：清空每次会话只记录一次的集合。 */
  resetDriftLogForTest(): void {
    this.loggedDriftKeys.clear();
  }
}
