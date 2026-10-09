// OPR.0.5.6.24 F-14——停放所有者消费者。
//
// 没有消费者的诊断就像开着门却在旁边设闸。此策略是已发布 parked 推导的唯一有界消费者：
// 每个工作组一个工作组级 supervisor job（锚点 `parked-owner-consumer@<rigName>`），
// 通过 `zrig parked` 服务的同一推导诊断整个工作组，并在每次评估时只向首个符合条件的
// 已停放所有者发送一次唤醒。S01 阶梯负责重试/升级，watchdog 引擎负责调度。
//
// 回执保存在行侧（R2 修复，advisor 批准）：episode 回执是其主要义务行上的队列 TRANSITION，
// 在引擎投递前写入（先保留后投递——至多一次契约：保留与投递之间崩溃会以可恢复方式丢失
// 该次唤醒，但绝不重复；没有幂等传输时不声称恰好一次）。持久性来自 queue-retention 的
// 活动前沿承重不变量：任何非终态 qitem 的 transition 无论多旧都不会被触碰，因此开放停放的
// 回执在结构上比 watchdog 遥测裁剪存活更久；行进入终态后义务消失，episode 也失去意义。
//
// 单一判定源法则（mini-req 2）：parked 判定、held 健康分类、indeterminate 分支与义务关联
// 全部来自 diagnoseRigParked；本模块不重新推导任何内容，也绝不读取逐运行时原始证据。

import { createHash } from "node:crypto";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";
import type { WatchdogHistoryEntry } from "../watchdog-history-log.js";

/** 已发布 SeatParkedDiagnosis（parked-query.ts）的结构视图。 */
export interface ParkedSeatDiagnosisView {
  sessionName: string;
  parked: boolean | "indeterminate";
  activity: { value: string; needsInput: { count: number; reason: string | null } };
  obligations: {
    items: Array<{ qitemId: string; state: string; summary: string | null }>;
    held: Array<{ qitemId: string; healthy: boolean }>;
  };
}

export interface RowTransitionView {
  ts: string;
  transitionNote: string | null;
}

export interface ParkedOwnerConsumerDeps {
  /** 已发布的工作组范围诊断（diagnoseRigParked），由适配器构造。 */
  diagnoseRig: (rigName: string) => { seats: ParkedSeatDiagnosisView[] } | null;
  /** 遥测——仅用于把近期投递结果对账到行（即时窗口），绝不作为 episode 状态。 */
  history: {
    listForJob: (jobId: string, limit: number) => WatchdogHistoryEntry[];
    countForJob: (jobId: string) => number;
  };
  /** 持久行侧表面（队列仓库，由适配器接线）。 */
  rows: {
    listTransitions: (qitemId: string) => RowTransitionView[];
    /** 保持状态的说明追加；行已终态或缺失时返回 ok:false（投递边界最后一道守卫）。 */
    appendNote: (qitemId: string, note: string) => { ok: boolean };
    /** 使用阶梯原生词汇把失败唤醒落到 last_nudge_result。 */
    recordNudgeResult: (qitemId: string, result: string) => void;
    /** 发送边界上席位最新的开放义务 ID（B1 复查）。 */
    listOpenIds: (destinationSession: string) => string[];
    /** 既有投递/恢复所有权；不改变 parked 诊断。 */
    recoveryOwnsWake?: (qitemId: string) => boolean;
  };
}

export const PARKED_OWNER_POLICY_NAME = "parked-owner-consumer";

/** 稳定的逐工作组注册锚点：member@rig 形状，以策略名为 slug。 */
export function makeRigAnchor(rigName: string): string {
  return `${PARKED_OWNER_POLICY_NAME}@${rigName}`;
}

export function rigFromAnchor(targetSession: string): string {
  return targetSession.startsWith(`${PARKED_OWNER_POLICY_NAME}@`)
    ? targetSession.slice(PARKED_OWNER_POLICY_NAME.length + 1)
    : targetSession;
}

// ── 行说明契约（稳定前缀；在此解析，S01 阶梯分支通过 last_nudge_result 上的
//    NUDGE_FAIL 前缀查询）──
export const RESERVE_PREFIX = "parked-owner wake reserved:";
export const CLOSE_PREFIX = "parked-owner episode closed:";
export const REFUSED_PREFIX = "parked-owner wake delivery refused:";
export const FAILED_PREFIX = "parked-owner wake delivery failed:";
export const NUDGE_FAIL_PREFIX = "failed: parked-owner wake delivery";

/** 只有传输层的交互式提示拒绝才计入；普通投递失败绝不能被误标为 refused。字面来源：
 *  session-transport.ts:1045 `Refused: '<name>' is at an interactive prompt`. */
function isRefusedInteractive(deliveryReason: unknown): boolean {
  return (
    typeof deliveryReason === "string" &&
    deliveryReason.startsWith("Refused:") &&
    deliveryReason.includes("interactive prompt")
  );
}

function idsHashOf(sortedIds: string[]): string {
  return createHash("sha256").update(sortedIds.join(",")).digest("hex").slice(0, 16);
}

/** key 紧跟在前缀后，以 ';'、' (' 或行尾分隔。解析锚定前缀，使正文词语绝不能伪装成 key。 */
function keyOfNote(note: string): string | null {
  for (const prefix of [RESERVE_PREFIX, CLOSE_PREFIX, REFUSED_PREFIX, FAILED_PREFIX]) {
    if (!note.startsWith(prefix)) continue;
    const rest = note.slice(prefix.length).trim();
    const m = rest.match(/^([^;()]+?)(?:;|\s*\(|$)/);
    return m ? m[1]!.trim() : null;
  }
  return null;
}

interface RowEpisodeState {
  openKey: string | null;
  refused: boolean;
  nextOrdinal: number;
}

/** 从主要行的 transition 推导一个 idsHash 的 episode 状态。Open 表示某 reserve 说明的 key
 *  后续没有 close 说明。FAILED 只批注不关闭（失败归阶梯所有，消费者从不重试）。
 *  episode 保持开放期间，REFUSED 持续标记拒绝单元格。 */
function rowEpisode(transitions: RowTransitionView[], idsHash: string): RowEpisodeState {
  const closed = new Set<string>();
  const refusedKeys = new Set<string>();
  let openKey: string | null = null;
  let reserves = 0;
  // listTransitions 按最旧优先返回；这里按最新优先遍历。
  for (let i = transitions.length - 1; i >= 0; i--) {
    const note = transitions[i]!.transitionNote ?? "";
    const key = keyOfNote(note);
    if (!key) continue;
    if (note.startsWith(CLOSE_PREFIX)) closed.add(key);
    else if (note.startsWith(REFUSED_PREFIX)) refusedKeys.add(key);
    else if (note.startsWith(RESERVE_PREFIX) && key.includes(`|${idsHash}#`)) {
      reserves += 1;
      if (openKey === null && !closed.has(key)) openKey = key;
    }
  }
  return { openKey, refused: openKey !== null && refusedKeys.has(openKey), nextOrdinal: reserves + 1 };
}

/** 一行上跨所有义务集合 hash 的全部开放 reserve key；not-parked 观测必须关闭这些 key。 */
function openKeysOnRow(transitions: RowTransitionView[]): string[] {
  const closed = new Set<string>();
  const open: string[] = [];
  for (let i = transitions.length - 1; i >= 0; i--) {
    const note = transitions[i]!.transitionNote ?? "";
    const key = keyOfNote(note);
    if (!key) continue;
    if (note.startsWith(CLOSE_PREFIX)) closed.add(key);
    else if (note.startsWith(RESERVE_PREFIX) && !closed.has(key) && !open.includes(key)) open.push(key);
  }
  return open;
}

export function makeParkedOwnerConsumerPolicy(deps: ParkedOwnerConsumerDeps): Policy {
  return {
    name: PARKED_OWNER_POLICY_NAME,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const rigName = rigFromAnchor(job.target.session);
      const d = deps.diagnoseRig(rigName);
      if (!d) {
        return { action: "skip", reason: "indeterminate-not-parked", notes: { rig: rigName } };
      }

      // B2 对账（有界、即时窗口）：把近期投递结果落到已保留行。拒绝会标记拒绝单元格；
      // 普通失败通过 last_nudge_result 进入阶梯原生词汇。无论哪种情况 episode 都保持开放，
      // 消费者绝不重试。
      const recent = deps.history.listForJob(job.jobId, Math.min(deps.history.countForJob(job.jobId), 25));
      for (const e of recent) {
        if (e.outcome !== "sent" || !e.deliveryStatus || e.deliveryStatus === "ok") continue;
        const n = e.evaluationNotes ?? {};
        const key = typeof n["episodeKey"] === "string" ? (n["episodeKey"] as string) : null;
        const primary = typeof n["primaryRow"] === "string" ? (n["primaryRow"] as string) : null;
        if (!key || !primary) continue;
        const trans = deps.rows.listTransitions(primary);
        const alreadyRecorded = trans.some((t) => {
          const note = t.transitionNote ?? "";
          return (note.startsWith(REFUSED_PREFIX) || note.startsWith(FAILED_PREFIX)) && keyOfNote(note) === key;
        });
        if (alreadyRecorded) continue;
        const reason = String(n["deliveryReason"] ?? e.deliveryStatus);
        if (isRefusedInteractive(reason)) {
          deps.rows.appendNote(primary, `${REFUSED_PREFIX} ${key}; ${reason}`);
        } else {
          deps.rows.appendNote(primary, `${FAILED_PREFIX} ${key}; ${reason}`);
          deps.rows.recordNudgeResult(primary, `${NUDGE_FAIL_PREFIX} — ${reason}`);
        }
      }

      const closures: string[] = [];
      const skipped: Array<{ seat: string; why: string }> = [];
      const seats = [...d.seats].sort((a, b) => a.sessionName.localeCompare(b.sessionName));

      for (const seat of seats) {
        if (seat.parked === "indeterminate") {
          skipped.push({ seat: seat.sessionName, why: "indeterminate-not-parked" });
          continue;
        }
        const knownRows = [
          ...seat.obligations.items.map((r) => r.qitemId),
          ...seat.obligations.held.map((h) => h.qitemId),
        ].filter((v, i, a) => a.indexOf(v) === i);

        if (seat.parked === false) {
          // 席位读为 not-parked 时 episode 结束：本轮持久关闭席位行上的每个开放 reserve key
          //（有界——每个开放 key 一条 close 说明，绝不在每次干净扫描时写入）。
          for (const qitemId of knownRows) {
            for (const key of openKeysOnRow(deps.rows.listTransitions(qitemId))) {
              deps.rows.appendNote(qitemId, `${CLOSE_PREFIX} ${key} (seat resumed)`);
              if (!closures.includes(key)) closures.push(key);
            }
          }
          continue;
        }

        // 继承完整诊断：开放事项加上不健康的 HELD 行。
        const ids = [
          ...seat.obligations.items.map((r) => r.qitemId),
          ...seat.obligations.held.filter((h) => h.healthy === false).map((h) => h.qitemId),
        ]
          .filter((v, i, a) => a.indexOf(v) === i)
          .sort();
        if (ids.length === 0) {
          skipped.push({ seat: seat.sessionName, why: "no-park-driving-obligation" });
          continue;
        }

        // S16 组合：usage-limit 停放归 S16 定时唤醒所有。
        const niReason = seat.activity.needsInput.reason ?? "";
        if (/usage.?limit/i.test(niReason)) {
          skipped.push({ seat: seat.sessionName, why: "usage-limit-defer-s16" });
          continue;
        }

        // B1——投递边界复查：此刻重新读取席位开放行；诊断后关闭的义务不得再被点名或唤醒。
        const fresh = new Set(deps.rows.listOpenIds(seat.sessionName));
        const namedIds = ids.filter((id) => fresh.has(id) && !deps.rows.recoveryOwnsWake?.(id));
        if (namedIds.length === 0) {
          skipped.push({ seat: seat.sessionName, why: ids.some(id => fresh.has(id)) ? "recovery-already-owns-wake" : "obligation-closed-between-derive-and-wake" });
          continue;
        }

        const idsHash = idsHashOf(namedIds);
        const primaryRow = namedIds[0]!;
        const ep = rowEpisode(deps.rows.listTransitions(primaryRow), idsHash);
        if (ep.openKey !== null) {
          skipped.push({
            seat: seat.sessionName,
            why: ep.refused ? "destination-refused-interactive-prompt" : "already-woken-this-episode",
          });
          continue;
        }

        // B4——引擎投递前先 reserve：此 transition 即持久回执；行上的终态竞态是最后一道诚实守卫。
        const episodeKey = `${seat.sessionName}|${idsHash}#${ep.nextOrdinal}`;
        const reserved = deps.rows.appendNote(
          primaryRow,
          `${RESERVE_PREFIX} ${episodeKey}; obligations ${namedIds.join(",")}`,
        );
        if (!reserved.ok) {
          skipped.push({ seat: seat.sessionName, why: "obligation-closed-between-derive-and-wake" });
          continue;
        }

        const message =
          `你在持有 ${namedIds.length} 个开放义务时处于停放状态（裁定结果：停在提示符）：` +
          `${namedIds.join(", ")}。请恢复工作，或如实更新每一行（关闭、带唤醒停放或移交）。` +
          `这是本次停放 episode 的唯一一次唤醒；后续由“唤醒或升级”阶梯负责。`;
        return {
          action: "send",
          target: { session: seat.sessionName },
          message,
          notes: {
            episodeKey,
            episodeSeat: seat.sessionName,
            idsHash,
            primaryRow,
            obligations: namedIds,
            evidence: "arbitrated-idle-at-prompt",
            episodeClosures: closures,
            skippedSeats: skipped,
          },
        };
      }

      if (closures.length > 0) {
        return { action: "skip", reason: "episode-ended", notes: { episodeClosures: closures, skippedSeats: skipped } };
      }
      if (skipped.length > 0) {
        return { action: "skip", reason: "all-parked-owners-deferred", notes: { skippedSeats: skipped } };
      }
      return { action: "skip", reason: "no-parked-owner", notes: { rig: rigName } };
    },
  };
}
