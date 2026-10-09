import type Database from "better-sqlite3";

/**
 * S5b（OPR.0.5.4.11）——运行名称守卫，是防止工作组身份重复的底线：对名称已处于 RUNNING
 * 的工作组执行 `zrig up`，必须在任何创建/启动前拒绝。因为会话地址按名称索引
 *（`{pod}-{member}@{rig}`），第二个同名运行中工作组会使 tmux 名称、队列目标与 transcript
 * 发生冲突，并在同一命名空间重复启动席位。
 *
 * RUNNING 的派生方式与后台服务现有逻辑完全一致：rigs 表没有 status 列；当且仅当工作组至少有
 * 一条 status='running' 的 sessions 行时，工作组才在运行（classifier-lease 存活性派生见
 * startup.ts；ps 摘要的运行计数使用同一谓词）。
 *
 * 此处刻意不处理：全局名称唯一性、已停止代际复用语义（支持复数结果的 findRigsByName 是关键；
 * 同名工作组的会话若全部未运行，绝不会触发此守卫），以及任何 schema 变更。
 * restore 与 up 的名称复用设计属于 0.5.5 intake。
 */

export interface RunningRigIdentity {
  id: string;
  name: string;
  runningSessionCount: number;
}

export type RunningNameGuardVerdict =
  | { ok: true }
  | { ok: false; code: "rig_name_running"; message: string; runningRig: RunningRigIdentity };

export interface RunningNameGuardDeps {
  /** 仓库现有的复数感知名称查询（ORDER BY created_at）。 */
  findRigsByName(name: string): Array<{ id: string; name: string }>;
  /** 属于该工作组节点且 status='running' 的 sessions 行数。 */
  countRunningSessions(rigId: string): number;
}

/** 所有调用方共享的唯一存活性读取：通过工作组节点关联 sessions，并筛选 status='running'；
 * 这是后台服务现有的运行状态派生。 */
export function makeRunningSessionCounter(db: Database.Database): (rigId: string) => number {
  return (rigId: string): number => {
    const row = db.prepare(
      "SELECT COUNT(*) AS c FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE n.rig_id = ? AND s.status = 'running'",
    ).get(rigId) as { c: number };
    return row.c;
  };
}

/**
 * 每条 instantiator 创建路径在 `createRig()` 前调用的唯一守卫。
 * 没有同名工作组运行时返回 ok（包括所有代际均已停止，此时按原逻辑复用）；否则返回引导式拒绝，
 * 指明运行中的工作组、检查内容、未创建或启动任何内容，以及受支持的替代方案。
 */
export function checkRunningNameGuard(deps: RunningNameGuardDeps, name: string): RunningNameGuardVerdict {
  for (const rig of deps.findRigsByName(name)) {
    const runningSessionCount = deps.countRunningSessions(rig.id);
    if (runningSessionCount > 0) {
      return {
        ok: false,
        code: "rig_name_running",
        message:
          `名为 "${name}" 的工作组已在运行：${rig.id}，包含 ${runningSessionCount} 个运行中的会话` +
          `（已检查同名工作组中 status='running' 的会话）。` +
          `未创建或启动任何内容。你可以继续使用当前工作组` +
          `（zrig ps --nodes / zrig send），先用 'zrig down ${name}' 停止它，` +
          `或以其他名称启动此规范。`,
        runningRig: { id: rig.id, name, runningSessionCount },
      };
    }
  }
  return { ok: true };
}
