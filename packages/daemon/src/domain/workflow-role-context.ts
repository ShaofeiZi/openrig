// OPR.0.4.6.FAC1——角色解析上下文构造器：从已交付的工作组作用域 inventory 投影
// 与同步工作补充中物化纯策略事实数组的非纯部分。
//
// 构造上仅同步（arch Q1 = guard B4）：组合 `getNodeInventory`（同步 SQL 投影；
// lifecycle 已折叠会话状态、恢复结果和身份裁决降级）与
// `attachTerminalActivityAndWork`，但不传 SeatActivityService，因此
// `terminalActive` 保持 undefined，只计算同步 pending-work 映射。异步的
// `attachAgentActivity` tmux 探测路径在结构上不存在，无法进入同步 close+create
// 事务（planner2 的首要发现）。
//
// 构造上惰性（guard B1）：构建上下文时零读取；仅调用 `candidatesForRig()` 时
// 才物化快照，而它只发生在第 3 层解析路径（frontier + absorption 守卫之后）。
// 因此已吸收的 waiting replay 与终态 frontier 拒绝不会读取角色解析 inventory；
// commit-4 的读取 spy 固定了这一点。
//
// 每次解析都重新做 NAME→ID（arch Q4）：绑定工作组持久化为名称，每个快照重新解析
// name→id。消失的工作组返回 null，调用方以 `bound_rig_not_found` 类响亮失败；
// WF-5 会捕获失败实例。

import type Database from "better-sqlite3";
import {
  attachTerminalActivityAndWork,
  deriveCanonicalFromEntry,
  getNodeInventory,
} from "./node-inventory.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "./workflow-role-resolver.js";

export interface RoleResolutionContext {
  /** 实例绑定的工作组名称（永不为 null；未绑定实例根本不构建上下文，也就不存在第 3 层）。 */
  boundRig: string;
  /**
   * 立即物化绑定工作组的候选事实快照。null 表示绑定工作组无法再按名称解析
   *（运行中消失）。只在调用本函数时读取，这是 guard-B1 的惰性固定点。
   */
  candidatesForRig: () => RoleSeatCandidateFacts[] | null;
}

/**
 * 为绑定实例构建惰性解析上下文。未绑定实例返回 undefined，
 * 使调用点可直接透传 `instance.boundRig`：
 *   `roleResolutionContext(db, instance.boundRig)`
 */
export function roleResolutionContext(
  db: Database.Database,
  boundRig: string | null | undefined,
): RoleResolutionContext | undefined {
  if (!boundRig) return undefined;
  return {
    boundRig,
    candidatesForRig: () => {
      const rig = db
        .prepare(`SELECT id FROM rigs WHERE name = ? ORDER BY created_at LIMIT 1`)
        .get(boundRig) as { id: string } | undefined;
      if (!rig) return null;
      const entries = attachTerminalActivityAndWork(getNodeInventory(db, rig.id), { db });
      return entries.map((e) => ({
        logicalId: e.logicalId,
        role: e.role,
        nodeKind: e.nodeKind,
        lifecycleState: e.lifecycleState,
        runtime: e.runtime,
        pendingWorkCount: e.pendingWorkCount ?? 0,
        coordinate: deriveCanonicalFromEntry(e),
        rawSessionName: e.canonicalSessionName,
      }));
    },
  };
}

/**
 * 在绑定工作组上解析 `role`。有证据表明确实无匹配，或工作组未绑定/已消失时返回 null。
 * 证据读取失败会继续抛出：它不能证明不存在合格智能体，也不能据此选择人类。
 * 每个异常条目在检测时都使用新快照。
 */
export function tryResolveRoleByCapability(
  ctx: RoleResolutionContext | undefined,
  role: string,
  harness?: string,
): string | null {
  if (!ctx) return null;
  const candidates = ctx.candidatesForRig();
  if (!candidates) return null;
  return selectRoleSeat({ role, harness, candidates }).seat;
}

/**
 * 结构化角色覆盖探针（arch Q2 / guard B1）：绑定工作组上是否有任意生命周期状态的
 * 席位声明了 `role`？检查存在性而非存活性——instantiate 只会在结构覆盖为零
 *（角色拼错或未声明）时硬失败，绝不会因席位尚未运行而失败；工厂工作组需要预热，
 * 存活性属于该步骤自身的投影时关注点。
 */
export function rigDeclaresRole(
  db: Database.Database,
  boundRig: string,
  role: string,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM nodes n
         JOIN rigs r ON r.id = n.rig_id
        WHERE r.name = ? AND n.role = ?`,
    )
    .get(boundRig, role) as { c: number };
  return row.c > 0;
}

/**
 * OPR.0.4.6.FAC3（FR-5）：结构化 MEMBER-EXISTS 探针——`rigName` 的任一成员
 * 是否会派生出规范坐标 `sessionRef`？
 *
 * 检查任意生命周期状态和任意节点种类下的存在性（与 `rigDeclaresRole` 同一纪律）：
 * 已声明但尚未启动的席位，或明确指定为 preferred_target 的终端成员，都是合法目标。
 * 存活性/种类是投影的职责，不是本探针的职责。比较对象是与第 3 层候选相同方式派生的
 * 规范坐标 `{pod}-{member}@{rig}`（FAC-1 Q5 单字符串规则）；占用者时代的原始会话名
 * 从不参与。只执行同步 SQL；未知工作组名返回 false（调用方先执行 registered-rig 跳过，
 * 所以该情况不会在此生成建议）。部分 schema 数据库上可能抛错，因为 inventory 投影会读取
 * `snapshots` 等表；FR-5 sweep 将抛错视为无法担保并跳过（建议绝不抛错；VM run-1 已捕获）。
 */
export function rigMemberExists(
  db: Database.Database,
  rigName: string,
  sessionRef: string,
): boolean {
  const rig = db
    .prepare(`SELECT id FROM rigs WHERE name = ? ORDER BY created_at LIMIT 1`)
    .get(rigName) as { id: string } | undefined;
  if (!rig) return false;
  return getNodeInventory(db, rig.id).some(
    (e) => deriveCanonicalFromEntry(e) === sessionRef,
  );
}
