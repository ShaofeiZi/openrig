// OPR.0.4.3.16——idle-gate-qitem 看门狗策略。
//
// claim 前停滞：一个 gate qitem（guard code-review / spec-review / human-gate / ...）以
// claimable 状态落到 seat 上，随后 seat 进入 idle 并静默停留。既有 overdue watchdog 只捕获
// 超过 closure deadline 的已 claim 工作（queue-repository.findOverdue → state 'in-progress'），
// 因此 pending/claimable gate 永远不会触发它。
//
// 此 policy（以 workflow-keepalive 为模型）将两个独立来源的 signal 合并为一次有界、可审计 wake：
//   A. 发往 seat X 且携带 gate:* tag 的 pending/claimable qitem
//      （predicate 集中于 domain/gate-predicate.ts）；
//   B. 共享且经过 arbitration 的 SeatActivityService oracle 判定 X 为 idle。unknown 绝不视为
//      idle，needs-input 保持为另一 axis，也会抑制 wake。
// cooldown 由 engine 的 active-wake throttle 免费提供（在已注册 job 上配置
// active_wake_interval_seconds）。它只执行 wake——从不 claim gate 或代为处理。

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { effectiveGateRoles } from "../gate-predicate.js";
import type { SeatActivityService } from "../seat-activity-service.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";

export interface IdleGateQitemDeps {
  db: Database.Database;
  /**
   * 使用与 public surface 相同且经过 arbitration 的 activity oracle。只使用
   * `getSeatStateBySession`；类型为 Pick，使单元测试无需构造第二个 oracle 即可注入轻量 seam。
   */
  seatActivity: Pick<SeatActivityService, "getSeatStateBySession">;
}

interface PendingGateRow {
  qitem_id: string;
  tags: string | null;
  tier: string | null;
}

function parseTags(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as string[]) : null;
  } catch {
    return null;
  }
}

export function makeIdleGateQitemPolicy(deps: IdleGateQitemDeps): Policy {
  const { db, seatActivity } = deps;

  return {
    name: "idle-gate-qitem",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const seat = job.target.session;

      // Signal A——发往此 seat 的 pending/claimable gate qitem。按 queue claim contract，
      // 可领取 = state IN ('pending','blocked')。claimed/closed/canceled/handed-off qitem
      // 不属于这些 state，因此从构造上被排除 → 永不触发（AC：not-claimable → no wake）。
      const rows = db
        .prepare(
          `SELECT qitem_id, tags, tier FROM queue_items
             WHERE destination_session = ? AND state IN ('pending','blocked')
             ORDER BY ts_created ASC`,
        )
        .all(seat) as PendingGateRow[];
      const gated = rows
        .map((r) => ({
          qitemId: r.qitem_id,
          roles: effectiveGateRoles({ tags: parseTags(r.tags), tier: r.tier }),
        }))
        .filter((r) => r.roles.length > 0);
      if (gated.length === 0) {
        return { action: "skip", reason: "no_pending_gate" };
      }

      // Signal B——共享且经过 arbitration 的 activity verdict。public surface 渲染的是同一 oracle；
      // raw hook detail 只是该 oracle 的 evidence，绝不能独立决定 wake。
      const activity = seatActivity.getSeatStateBySession(seat);
      if (!activity) {
        return {
          action: "skip",
          reason: "activity_stale_unknown",
          notes: {
            seat,
            activityState: null,
            activityReason: "no_activity_signal",
          },
        };
      }
      if (activity.needsInput.count > 0) {
        // live picker / approval prompt——绝不通过 wake 驱动。
        return {
          action: "skip",
          reason: "seat_needs_input",
          notes: { seat, activityReason: activity.needsInput.reason },
        };
      }
      if (activity.activity === "unknown") {
        return {
          action: "skip",
          reason: "activity_stale_unknown",
          notes: { seat, activityState: activity.activity, activityReason: "oracle_unknown" },
        };
      }
      if (activity.activity !== "idle-at-prompt") {
        return { action: "skip", reason: "seat_active", notes: { seat, activityState: activity.activity } };
      }

      // Signal C——OPR.0.5.8.1 S2。gated set 的每个 material state 触发一次，
      // 而非每个 window 或每个 idle episode 触发一次。
      //
      // engine 的 active-wake window 曾是唯一 cooldown，但它并非真正 cooldown：
      // `watchdog-policy-engine.ts` 每次 skip 都清除 `actionable`，throttle 的 precondition 又包含
      // `job.actionable`。因此在两次 scan 之间短暂 active 的 seat 会重新允许立即触发——已在 120 秒
      // window 的 60.1 秒处复现。仅 window 到期也会在每个 interval 重新 wake 未变化 row。
      //
      // memory 以 condition 为 key，绝不以 seat activity 为 key：上方 seat_active / needs_input /
      // activity_stale 的 skip 不会触碰它，因此 flicker 无法再制造新的 wake。
      const fingerprint = gatedConditionFingerprint(db, gated.map((g) => g.qitemId));
      const firedFor = (
        db.prepare("SELECT last_fired_condition AS c FROM watchdog_jobs WHERE job_id = ?")
          .get(job.jobId) as { c: string | null } | undefined
      )?.c ?? null;
      if (firedFor !== null && firedFor === fingerprint) {
        return {
          action: "skip",
          reason: "gate_condition_unchanged",
          notes: { seat, pendingGateCount: gated.length },
        };
      }

      // 两个 signal 汇合 → 一次有界 wake（single-target、keepalive shape）。
      //
      // fingerprint 在此提出，仅在 delivery 成功时由 engine 持久化；此时刻刻意不写入。
      //
      // 此修复的第一版确实在这里写入，理由是模仿 engine 在 send 路径上无论 delivery outcome
      // 如何都标记 `last_fire_at` 的方式。但这只模仿 timing，却反转了 consequence：`last_fire_at`
      // 控制一个会过期的 window，failed delivery 因而可自愈；此 gate 则会保持，直到 gated set
      // 发生实质变化。dev50-qa 已复现：transport 失败的 send 仍记录 receipt，seat 此后永远不会再
      // 被 wake，直到无关 transition 释放它。suppression 必须基于 wake 已抵达的 evidence，
      // 绝不能基于尝试发送的决定。
      const primary = gated[0]!;
      const message =
        job.message ??
        buildIdleGateMessage({ seat, qitemId: primary.qitemId, roles: primary.roles, pendingCount: gated.length });

      return {
        action: "send",
        target: { session: seat },
        message,
        conditionReceipt: fingerprint,
        notes: {
          // audit：具体 qitem + activity signal + join decision。
          qitemId: primary.qitemId,
          gateRoles: primary.roles,
          pendingGateCount: gated.length,
          otherPendingGateQitems: gated.slice(1).map((g) => g.qitemId),
          activityState: activity.activity,
          activityNeedsInput: activity.needsInput,
          activityDecidedBy: activity.decidedBy,
          activityChangedAt: activity.changedAt,
        },
      };
    },
  };
}

/**
 * Wake-machinery marker 绝不是 material。否则每次 wake 都会为下一次 wake 提供理由，
 * gate 会沦为装饰。
 */
const WAKE_MACHINERY_NOTE_PREFIXES = [
  "wake-attempt:",
  "escalation-rung:",
  "ladder-exhausted:",
  "ladder-suspend:",
  "ladder-resume:",
  "park wake fired:",
  "idle-gate:",
];

/**
 * gated condition 的稳定 digest：哪些 row 符合条件，以及每条 row 的 material state。
 *
 * 按已裁定定义，material state 包括：row 上的实质 transition（state / claim / 含内容 note /
 * resolution）、其 blocker 上的 transition 或 blocker 达到 terminal，以及 pickup evidence。
 * 只有 row identity 不够：相同两条 row 可能处于不同 state。
 *
 * 完全从现有 queue fact 推导。每次 wake 不记录新内容；唯一存储值是 job 上被覆盖的单个 fingerprint。
 */
function gatedConditionFingerprint(db: Database.Database, qitemIds: readonly string[]): string {
  const notMachinery = WAKE_MACHINERY_NOTE_PREFIXES.map(() => "COALESCE(t.transition_note,'') NOT LIKE ?").join(" AND ");
  const latestSubstantive = db.prepare(
    `SELECT MAX(t.transition_id) AS marker
       FROM queue_transitions t
      WHERE t.qitem_id = ? AND ${notMachinery}`,
  );
  const rowFacts = db.prepare(
    `SELECT q.state AS state, COALESCE(q.blocked_on,'') AS blockedOn,
            COALESCE(q.claimed_at,'') AS claimedAt,
            COALESCE((SELECT b.state FROM queue_items b WHERE b.qitem_id = q.blocked_on),'') AS blockerState
       FROM queue_items q WHERE q.qitem_id = ?`,
  );
  const likeArgs = WAKE_MACHINERY_NOTE_PREFIXES.map((p) => `${p}%`);
  const parts = [...qitemIds].sort().map((id) => {
    const f = rowFacts.get(id) as
      | { state: string; blockedOn: string; claimedAt: string; blockerState: string }
      | undefined;
    const marker = (latestSubstantive.get(id, ...likeArgs) as { marker: number | null } | undefined)?.marker ?? 0;
    // blocker 提供两个独立 axis，而非一个。其 terminal state 由 `blockerState` 承载；若其上的
    // substantive transition 未改变该 state，它仍是独立 material event，需要自己的 marker。
    // 若省略该项，仍为 in-progress blocker 上的 "decision context materially amended" 等 note
    // 会产生相同 digest 并被抑制（review50-r2，已对照此 policy 精确复现）。同样适用
    // wake-machinery exclusion，因此 blocker 上记录的 wake 也不能为下一次 wake 提供理由。
    const blockerMarker =
      f?.blockedOn
        ? (latestSubstantive.get(f.blockedOn, ...likeArgs) as { marker: number | null } | undefined)?.marker ?? 0
        : 0;
    return [
      id,
      f?.state ?? "",
      f?.blockedOn ?? "",
      f?.blockerState ?? "",
      blockerMarker,
      f?.claimedAt ?? "",
      marker,
    ].join("|");
  });
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

function buildIdleGateMessage(input: {
  seat: string;
  qitemId: string;
  roles: string[];
  pendingCount: number;
}): string {
  const rolesLabel = input.roles.map((r) => `gate:${r}`).join(", ");
  const lines = [
    `空闲 seat gate 提醒：你（${input.seat}）有一个 pending gate qitem ${input.qitemId}（${rolesLabel}）等待 review/decision，且你的 seat 当前空闲。`,
    "请 claim 并处理；若不属于你，请 handoff。这只是一次 wake——系统尚未替你 claim 或处理该 gate。",
  ];
  if (input.pendingCount > 1) {
    lines.push("", `（此 seat 共有 ${input.pendingCount} 个 pending gate qitem。）`);
  }
  return lines.join("\n");
}
