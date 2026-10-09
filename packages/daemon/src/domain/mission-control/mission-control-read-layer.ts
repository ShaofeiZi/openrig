// PL-005 Phase A：Mission Control 读取层。
//
// 将 7 个 Mission Control 视图映射到数据来源：
//   - my-queue            → queue_items，其中 destination_session = operator
//                            AND tier='human-gate'
//   - human-gate          → queue_items，其中 tier='human-gate'
//   - fleet               → 通过 shell 调用 `zrig ps --nodes -A --json`
//                            （按四项子条款规范优雅降级）
//   - active-work         → queue_items，其中 state in (pending, in-progress,
//                            blocked)，按 priority 排序
//   - recent-ships        → queue_items，其中 state in (done, handed-off)
//                            ORDER BY ts_updated DESC LIMIT 10
//   - recently-active     → PL-004 Phase B ViewProjector 内置视图
//   - recent-observations → stream_items 表（Phase A 后台服务支撑的来源）
//                            以 ~/.openrig/stream/<date>.jsonl 作为优雅降级回退
//
// 每行都携带 9 字段的移动端友好内容模型（PRD 验收标准第 1 项；无论 UI 密度如何，
// 7 个视图都必须完整保留）。
//
// 事实源集成：PL-004 后台服务支撑的协调服务是主读取路径；文件系统/CLI 回退仅用于优雅降级。

import { loadHumanRegistry } from "../gateway/human-registry.js";
import type Database from "better-sqlite3";
import type { QueueRepository, QueueItem, QueueState } from "../queue-repository.js";
import type { ViewProjector } from "../view-projector.js";
import type { StreamStore, StreamItem } from "../stream-store.js";
import type { MissionControlFleetCliCapability, FleetRollupRow } from "./mission-control-fleet-cli-capability.js";

export const MISSION_CONTROL_VIEWS = [
  "my-queue",
  "human-gate",
  "fleet",
  "active-work",
  "recent-ships",
  "recently-active",
  "recent-observations",
] as const;

export type MissionControlViewName = (typeof MISSION_CONTROL_VIEWS)[number];

/**
 * 9 字段的移动端友好内容模型。按 PRD 验收标准第 1 项，所有展示行状状态的 7 个视图都必须
 * 完整提供；UI 可以紧凑渲染，但 JSON 必须保留全部 9 个字段。
 *
 * PRD 原样规定的 9 个字段：
 *   1. 工作组/任务目标名称
 *   2. 当前阶段
 *   3. active/idle/attention/blocked/degraded
 *   4. next-action
 *   5. pending-human-decision
 *   6. read-cost（full / skim/approve / summary-only）
 *   7. last-update 时间戳
 *   8. confidence/freshness
 *   9. evidence 链接
 */
export interface CompactStatusRow {
  rigOrMissionName: string;
  currentPhase: string | null;
  state: "active" | "idle" | "attention" | "blocked" | "degraded";
  nextAction: string | null;
  pendingHumanDecision: string | null;
  readCost: "full" | "skim/approve" | "summary-only" | null;
  lastUpdate: string;
  confidenceFreshness: string | null;
  evidenceLink: string | null;
  /** 承载 metadata；id 用于动词动作。 */
  qitemId?: string | null;
  rawSourceRef?: string | null;
  /** 供移动端决策使用的人类可读 qitem 上下文。 */
  qitemSummary?: string | null;
  qitemBody?: string | null;
}

export interface MissionControlReadResult {
  viewName: MissionControlViewName;
  rows: CompactStatusRow[];
  /**
   * 逐视图 metadata。fleet 视图包含“工作组正在运行过期 CLI”的指示器
   *（优雅降级验收的第 4 子条款）。
   */
  meta: {
    rowCount: number;
    rigsRunningStaleCli?: number;
    degradedFields?: string[];
    sourceFallback?: string;
  };
}

interface ReadLayerDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  viewProjector: ViewProjector;
  streamStore?: StreamStore;
  fleetCliCapability: MissionControlFleetCliCapability;
  /** `my-queue` 使用的操作者默认人工席位会话。 */
  defaultOperatorSession?: string;
  now?: () => Date;
}

// 继续支持显式选择操作者。未显式选择时，在读取时发现唯一已登记人员；身份缺失或有歧义时，
// 绝不扩大 my-queue 范围。
const RECENT_SHIPS_LIMIT = 10;
const ACTIVE_WORK_LIMIT = 50;
const RECENT_OBSERVATIONS_LIMIT = 50;

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  routine: 2,
  background: 3,
};

export class MissionControlReadLayer {
  private readonly queueRepo: QueueRepository;
  private readonly viewProjector: ViewProjector;
  private readonly streamStore: StreamStore | undefined;
  private readonly fleetCliCapability: MissionControlFleetCliCapability;
  private readonly defaultOperatorSession: string;

  constructor(deps: ReadLayerDeps) {
    this.queueRepo = deps.queueRepo;
    this.viewProjector = deps.viewProjector;
    this.streamStore = deps.streamStore;
    this.fleetCliCapability = deps.fleetCliCapability;
    this.defaultOperatorSession = deps.defaultOperatorSession ?? "";
  }

  /** V0.3.1 slice 05——已解析 operator 席位会话的公开 getter。路由 handler
   *（listDestinations、audit history）读取它，使 picker 与 audit filter 即使在 kernel
   * 工作组尚未启动时也始终提供已配置的 operator 席位。 */
  getDefaultOperatorSession(): string {
    if (this.defaultOperatorSession) return this.defaultOperatorSession;
    const registry = loadHumanRegistry();
    return registry.ok && registry.entities.length === 1 ? registry.entities[0]!.address : "";
  }

  async readView(
    viewName: MissionControlViewName,
    opts?: { operatorSession?: string },
  ): Promise<MissionControlReadResult> {
    switch (viewName) {
      case "my-queue":
        return this.readMyQueue(opts?.operatorSession ?? this.getDefaultOperatorSession());
      case "human-gate":
        return this.readHumanGate();
      case "fleet":
        return this.readFleet();
      case "active-work":
        return this.readActiveWork();
      case "recent-ships":
        return this.readRecentShips();
      case "recently-active":
        return this.readRecentlyActive();
      case "recent-observations":
        return this.readRecentObservations();
    }
  }

  private readMyQueue(operatorSession: string): MissionControlReadResult {
    if (!operatorSession) return {
      viewName: "my-queue", rows: [],
      meta: { rowCount: 0, degradedFields: ["操作者身份不可用或有歧义：请检查 zrig gateway human list --json 并选择地址"] },
    };
    const items = this.queueRepo.list({
      destinationSession: operatorSession,
      state: ["pending", "in-progress", "blocked"],
      limit: ACTIVE_WORK_LIMIT,
    });
    const humanGateOnly = items.filter((q) => q.tier === "human-gate");
    return {
      viewName: "my-queue",
      rows: humanGateOnly.map((q) => qitemToRow(q, { defaultReadCost: "skim/approve" })),
      meta: { rowCount: humanGateOnly.length },
    };
  }

  private readHumanGate(): MissionControlReadResult {
    const items = this.queueRepo.list({
      state: ["pending", "in-progress", "blocked"],
      limit: ACTIVE_WORK_LIMIT,
    });
    const humanGateOnly = items.filter((q) => q.tier === "human-gate");
    return {
      viewName: "human-gate",
      rows: humanGateOnly.map((q) => qitemToRow(q, { defaultReadCost: "skim/approve" })),
      meta: { rowCount: humanGateOnly.length },
    };
  }

  private async readFleet(): Promise<MissionControlReadResult> {
    const fleet = await this.fleetCliCapability.rollupFleet();
    const rows: CompactStatusRow[] = fleet.rows.map((r) => fleetRowToCompactRow(r));
    return {
      viewName: "fleet",
      rows,
      meta: {
        rowCount: rows.length,
        rigsRunningStaleCli: fleet.staleCliCount,
        degradedFields: fleet.degradedFields.length > 0 ? fleet.degradedFields : undefined,
        sourceFallback: fleet.sourceFallback ?? undefined,
      },
    };
  }

  private readActiveWork(): MissionControlReadResult {
    const items = this.queueRepo.list({
      state: ["pending", "in-progress", "blocked"],
      limit: ACTIVE_WORK_LIMIT,
    });
    items.sort((a, b) => {
      const ar = PRIORITY_RANK[a.priority] ?? 99;
      const br = PRIORITY_RANK[b.priority] ?? 99;
      if (ar !== br) return ar - br;
      return a.tsUpdated.localeCompare(b.tsUpdated);
    });
    return {
      viewName: "active-work",
      rows: items.map((q) => qitemToRow(q, { defaultReadCost: "full" })),
      meta: { rowCount: items.length },
    };
  }

  private readRecentShips(): MissionControlReadResult {
    const done = this.queueRepo.list({
      state: ["done", "handed-off"],
      limit: RECENT_SHIPS_LIMIT * 4,
    });
    done.sort((a, b) => b.tsUpdated.localeCompare(a.tsUpdated));
    const top = done.slice(0, RECENT_SHIPS_LIMIT);
    return {
      viewName: "recent-ships",
      rows: top.map((q) => qitemToRow(q, { defaultReadCost: "summary-only" })),
      meta: { rowCount: top.length },
    };
  }

  private readRecentlyActive(): MissionControlReadResult {
    // 委托给 PL-004 Phase B 内置的 `recently-active` 视图。
    const result = this.viewProjector.show("recently-active");
    const rows: CompactStatusRow[] = result.rows.map((row) =>
      builtinViewRowToCompactRow("recently-active", row),
    );
    return {
      viewName: "recently-active",
      rows,
      meta: { rowCount: rows.length },
    };
  }

  private readRecentObservations(): MissionControlReadResult {
    if (!this.streamStore) {
      return {
        viewName: "recent-observations",
        rows: [],
        meta: { rowCount: 0, sourceFallback: "stream-store-not-wired" },
      };
    }
    const items: StreamItem[] = this.streamStore.list({ limit: RECENT_OBSERVATIONS_LIMIT });
    const rows = items.map((s) => streamItemToCompactRow(s));
    return {
      viewName: "recent-observations",
      rows,
      meta: { rowCount: rows.length },
    };
  }
}

function qitemToRow(
  q: QueueItem,
  opts: { defaultReadCost: CompactStatusRow["readCost"] },
): CompactStatusRow {
  const state = qitemStateToCompactState(q.state);
  const nextAction = q.state === "blocked" ? `解除阻塞：${q.blockedOn ?? "外部门禁"}` : null;
  const pendingHumanDecision = q.tier === "human-gate" ? `${q.priority} 人工门禁项` : null;
  return {
    rigOrMissionName: q.destinationSession,
    currentPhase: q.tier ?? null,
    state,
    nextAction,
    pendingHumanDecision,
    readCost: opts.defaultReadCost,
    lastUpdate: q.tsUpdated,
    confidenceFreshness: q.priority,
    evidenceLink: null,
    qitemId: q.qitemId,
    rawSourceRef: q.sourceSession,
    qitemSummary: summarizeBody(q.body),
    qitemBody: q.body,
  };
}

function summarizeBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= 120) return compact;
  return `${compact.slice(0, 117).trimEnd()}...`;
}

function qitemStateToCompactState(state: QueueState): CompactStatusRow["state"] {
  switch (state) {
    case "in-progress":
      return "active";
    case "pending":
      return "idle";
    case "blocked":
      return "blocked";
    case "failed":
    case "denied":
    case "canceled":
      return "degraded";
    case "done":
    case "handed-off":
      return "idle";
  }
}

function fleetRowToCompactRow(r: FleetRollupRow): CompactStatusRow {
  return {
    rigOrMissionName: r.rigName,
    currentPhase: r.lifecycleState ?? null,
    state: r.activityState,
    nextAction: r.attentionReason ?? null,
    pendingHumanDecision: null,
    readCost: "summary-only",
    lastUpdate: r.lastUpdate,
    confidenceFreshness: r.cliVersionLabel,
    evidenceLink: null,
    qitemId: null,
    rawSourceRef: r.rigName,
  };
}

function builtinViewRowToCompactRow(
  viewName: string,
  row: Record<string, unknown>,
): CompactStatusRow {
  const get = (k: string): string | null => {
    const v = row[k];
    if (v === undefined || v === null) return null;
    return String(v);
  };
  return {
    rigOrMissionName:
      get("destination_session") ?? get("rig_name") ?? get("rigName") ?? viewName,
    currentPhase: get("tier") ?? get("state") ?? null,
    state: "idle",
    nextAction: null,
    pendingHumanDecision: null,
    readCost: "summary-only",
    lastUpdate: get("ts_updated") ?? get("ts_emitted") ?? new Date().toISOString(),
    confidenceFreshness: get("priority") ?? null,
    evidenceLink: null,
    qitemId: get("qitem_id"),
    rawSourceRef: get("source_session"),
  };
}

function streamItemToCompactRow(s: StreamItem): CompactStatusRow {
  return {
    rigOrMissionName: s.sourceSession,
    currentPhase: s.hintType ?? null,
    state: s.hintUrgency === "critical" ? "attention" : "idle",
    nextAction: s.hintDestination ?? null,
    pendingHumanDecision: null,
    readCost: "summary-only",
    lastUpdate: s.tsEmitted,
    confidenceFreshness: s.hintUrgency ?? null,
    evidenceLink: null,
    qitemId: null,
    rawSourceRef: s.streamItemId,
  };
}
