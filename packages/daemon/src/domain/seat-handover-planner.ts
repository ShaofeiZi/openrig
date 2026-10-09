import type { RigRepository } from "./rig-repository.js";
import { SeatStatusService, type SeatStatus, type SeatStatusResult } from "./seat-status-service.js";

export type SeatHandoverSourceMode = "fresh" | "rebuild" | "fork" | "discovered";

export interface SeatHandoverSource {
  mode: SeatHandoverSourceMode;
  ref: string | null;
  raw: string;
  defaulted: boolean;
}

export interface SeatHandoverStep {
  id: string;
  title: string;
  description: string;
  willMutate: false;
}

export interface SeatHandoverPhase {
  id: "prepare" | "commit";
  title: string;
  bindingUnchangedUntilComplete: boolean;
  steps: SeatHandoverStep[];
}

export interface SeatHandoverPlan {
  ok: true;
  dryRun: true;
  willMutate: false;
  seat: {
    ref: string;
    rigId: string;
    rigName: string;
    logicalId: string;
    podId: string | null;
    podNamespace: string | null;
    runtime: string | null;
  };
  source: SeatHandoverSource;
  reason: string;
  operator: string | null;
  currentOccupant: string | null;
  currentStatus: {
    sessionStatus: string | null;
    startupStatus: SeatStatus["startup_status"];
    occupantLifecycle: SeatStatus["occupant_lifecycle"];
    continuityOutcome: SeatStatus["continuity_outcome"];
    handoverResult: SeatStatus["handover_result"];
    previousOccupant: string | null;
    handoverAt: string | null;
    restoreOutcome: SeatStatus["restore_outcome"];
  };
  phases: SeatHandoverPhase[];
}

export type SeatHandoverPlanResult =
  | { ok: true; plan: SeatHandoverPlan }
  | { ok: false; code: "missing_reason" | "invalid_source" | "mutation_disabled"; message: string; guidance: string }
  | Extract<SeatStatusResult, { ok: false }>;

export class SeatHandoverPlanner {
  private statusService: SeatStatusService;

  constructor(deps: { rigRepo: RigRepository }) {
    this.statusService = new SeatStatusService({ rigRepo: deps.rigRepo });
  }

  plan(input: {
    seatRef: string;
    reason?: string | null;
    source?: string | null;
    operator?: string | null;
    dryRun?: boolean;
  }): SeatHandoverPlanResult {
    const reason = input.reason?.trim() ?? "";
    if (!reason) {
      return {
        ok: false,
        code: "missing_reason",
        message: "缺少必填选项：--reason <reason>",
        guidance: "请提供明确的 handover 原因，例如：--reason context-wall",
      };
    }

    const source = parseHandoverSource(input.source);
    if (!source.ok) {
      return source;
    }

    const statusResult = this.statusService.getStatus(input.seatRef);
    if (!statusResult.ok) {
      return statusResult;
    }

    if (!input.dryRun) {
      return {
        ok: false,
        code: "mutation_disabled",
        message: "此 slice 尚未实现 seat handover 修改操作。",
        guidance: "请使用 --dry-run 重新运行，以便在不更改拓扑的情况下检查两阶段 handover 计划。",
      };
    }

    return {
      ok: true,
      plan: buildPlan({
        seatRef: input.seatRef,
        status: statusResult.status,
        source: source.source,
        reason,
        operator: input.operator?.trim() || null,
      }),
    };
  }
}


/**
 * OPR.0.5.5.5——dry-run 计划与修改 executor 共享的唯一 source-capability 表。计划从此表渲染
 * source 的实际行为，executor 也按相同行分发，因此计划绝不会承诺 executor 拒绝的 source，反之
 * 亦然。向 `SeatHandoverSourceMode` 新增 mode 会强制在此添加一行（穷尽 Record）。
 */
export const SEAT_HANDOVER_SOURCE_CAPABILITIES: Record<SeatHandoverSourceMode, {
  /** 修改路径端到端执行此 source 时为 true。false 行是唯一可产生 `source_not_supported` 的情况。 */
  executes: boolean;
  /** successor 在此 source 下接收上下文的方式。 */
  contextCarrier: string;
}> = {
  fresh: { executes: true, contextCarrier: "提交前粘贴到新 successor 的已捕获 restore packet" },
  discovered: { executes: true, contextCarrier: "操作员准备的 successor；不投递任何内容" },
  fork: { executes: true, contextCarrier: "从已解析 source conversation 进行原生 fork（successor 从第一个字节起携带 incumbent 上下文；commit 持久化新的 fork 后 token）" },
  rebuild: { executes: true, contextCarrier: "作为 priming packet 投递的持久 artifact 链（编写的 recap / LEARNED / restore 记录）；记录已执行集合及其缺口" },
};

export function parseHandoverSource(source?: string | null): { ok: true; source: SeatHandoverSource } | { ok: false; code: "invalid_source"; message: string; guidance: string } {
  const raw = source?.trim();
  if (!raw || raw === "default" || raw === "fresh") {
    return {
      ok: true,
      source: { mode: "fresh", ref: null, raw: raw || "fresh", defaulted: !raw || raw === "default" },
    };
  }

  if (raw === "rebuild") {
    return {
      ok: true,
      source: { mode: "rebuild", ref: null, raw, defaulted: false },
    };
  }

  if (raw.startsWith("fork:")) {
    const ref = raw.slice("fork:".length).trim();
    if (ref) {
      return {
        ok: true,
        source: { mode: "fork", ref, raw, defaulted: false },
      };
    }
  }

  if (raw.startsWith("discovered:")) {
    const ref = raw.slice("discovered:".length).trim();
    if (ref) {
      return {
        ok: true,
        source: { mode: "discovered", ref, raw, defaulted: false },
      };
    }
  }

  return {
    ok: false,
    code: "invalid_source",
    message: `无效的 handover source "${raw}"。`,
    guidance: "请使用 --source fresh、--source rebuild、--source fork:<id> 或 --source discovered:<id>。",
  };
}

function buildPlan(input: {
  seatRef: string;
  status: SeatStatus;
  source: SeatHandoverSource;
  reason: string;
  operator: string | null;
}): SeatHandoverPlan {
  const { status } = input;
  return {
    ok: true,
    dryRun: true,
    willMutate: false,
    seat: {
      ref: input.seatRef,
      rigId: status.rig_id,
      rigName: status.rig_name,
      logicalId: status.logical_id,
      podId: status.pod_id,
      podNamespace: status.pod_namespace,
      runtime: status.runtime,
    },
    source: input.source,
    reason: input.reason,
    operator: input.operator,
    currentOccupant: status.current_occupant,
    currentStatus: {
      sessionStatus: status.session_status,
      startupStatus: status.startup_status,
      occupantLifecycle: status.occupant_lifecycle,
      continuityOutcome: status.continuity_outcome,
      handoverResult: status.handover_result,
      previousOccupant: status.previous_occupant,
      handoverAt: status.handover_at,
      restoreOutcome: status.restore_outcome,
    },
    phases: [
      {
        id: "prepare",
        title: "阶段 A - 在 seat binding 不变的情况下准备 successor",
        bindingUnchangedUntilComplete: true,
        steps: [
          {
            id: "validate-seat",
            title: "校验 seat",
            description: "确认 seat 存在，并从 node inventory 捕获当前 occupant/status。",
            willMutate: false,
          },
          {
            id: "capture-departing-context",
            title: "捕获离任上下文",
            description: "将在创建 successor 前收集最终 pane 状态、queue 状态和 session 日志尾部。",
            willMutate: false,
          },
          {
            id: "create-successor",
            title: "创建 successor occupant",
            description: `将在保持当前 seat binding 不变的情况下，使用${describeSource(input.source)}创建 successor。上下文载体：${SEAT_HANDOVER_SOURCE_CAPABILITIES[input.source.mode].contextCarrier}。`,
            willMutate: false,
          },
          {
            id: "verify-successor-readiness",
            title: "验证 successor readiness",
            description: "将在允许任何 seat rebind 前运行 runtime readiness 检查。",
            willMutate: false,
          },
        ],
      },
      {
        id: "commit",
        title: "阶段 B - successor ready 后提交原子 seat rebind",
        bindingUnchangedUntilComplete: false,
        steps: [
          {
            id: "archive-departing-occupant",
            title: "归档离任 occupant",
            description: "将标记离任 occupant lifecycle 并保留 handover provenance。",
            willMutate: false,
          },
          {
            id: "rebind-seat",
            title: "重新绑定 seat",
            description: "将以原子方式把稳定 seat identity 指向 successor session。",
            willMutate: false,
          },
          {
            id: "deliver-startup-context",
            title: "投递启动上下文",
            description: "将通过 startup 编排投递 handover 上下文。",
            willMutate: false,
          },
          {
            id: "record-provenance",
            title: "记录 provenance",
            description: "将完成 handover 记录并追加 pod 共享 session 日志。",
            willMutate: false,
          },
        ],
      },
    ],
  };
}

function describeSource(source: SeatHandoverSource): string {
  if (source.mode === "fork") return `分叉来源 ${source.ref}`;
  if (source.mode === "discovered") return `已创建的发现型继任者 ${source.ref}`;
  if (source.mode === "rebuild") return "产物重建来源";
  return source.defaulted ? "默认全新来源" : "全新来源";
}
