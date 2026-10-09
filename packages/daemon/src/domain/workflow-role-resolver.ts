// OPR.0.4.6.FAC1——纯 role→seat 选择策略（BR-1）。
//
// 纯度契约（arch Q1 = guard B4，强约束）：本模块是对已物化事实数组的纯函数。
// 它没有任何运行时导入——无数据库、时钟、随机性、locale 或 tmux/activity 探针。
// commit-4 的 import-audit 测试固定本文件绝不能引入 `Date`、`Math.random`、
// `localeCompare` 或 async 依赖：相同候选事实，在每个进程、每次重放和每个版本中
// 都必须选出相同席位。
//
// 封闭事实集（arch Q1）：role、nodeKind、lifecycleState、runtime、pendingWorkCount
//（同步且仅 pending 的 SQL 映射）以及派生规范坐标。其他因素一律不得影响选择。
//
// 门控顺序（guard B4，已固定）：先过滤 nodeKind === "agent" 且
// lifecycleState === "running"，再过受管席位/坐标门、runtime 匹配，最后按容量排序。
//
// 单字符串规则（arch Q5 = guard B2）：用于平局决胜键和记录目标的席位身份，
// 都必须是派生规范坐标 `{pod}-{member}@{rig}`，绝不能是占用者时代的原始会话名。
// 已采纳席位（原始 tmux 名 ≠ 派生坐标）会以具名 disqualifier
// `adopted_seat_not_role_resolvable_v1` 响亮排除在 v1 候选集之外；解除排除是
// 一个具名后续项，并携带投递双重性测试（planner2 第 3.7 节）。
//
// 平局决胜（BR-1）：先按 pendingWorkCount 升序，再用普通码点比较（`<`）排序坐标，
// 绝不使用 localeCompare/自然排序。`driver10@rig < driver2@rig` 是固定的反直觉向量；
// 把它“修正”为自然排序会破坏跨版本确定性。

/** 判断候选席位所用的同步事实——由调用方 workflow-role-context.ts 从已交付的
 *  工作组作用域 inventory 投影和同步工作补充中物化。 */
export interface RoleSeatCandidateFacts {
  logicalId: string;
  /** nodes.role（commit-1 维度）；null 表示无角色。 */
  role: string | null;
  nodeKind: "agent" | "infrastructure";
  lifecycleState: string;
  runtime: string | null;
  /** 仅 pending 的积压（state='pending' 条目；claimed/in-progress 排名为零）；
   *  “负载最小”即“未认领积压最少”。 */
  pendingWorkCount: number;
  /** 派生规范坐标 `{pod}-{member}@{rig}`；无法派生时为 null（无 pod 感知 logical id）。 */
  coordinate: string | null;
  /** 占用者时代的会话名（最新会话行）。受管席位等于 `coordinate`；
   *  已采纳席位则是原始 tmux 名。 */
  rawSessionName: string | null;
}

/** 一个已评估但不合格的候选——带候选响亮报告的证据单元（BR-5）。 */
export interface RoleCandidateVerdict {
  coordinate: string | null;
  logicalId: string;
  disqualifier: string;
  facts: {
    role: string | null;
    lifecycleState: string;
    runtime: string | null;
    pendingWorkCount: number;
  };
}

export interface RoleSelectionResult {
  /** 胜出席位的派生规范坐标（唯一字符串，同时用于平局决胜键和记录目标）；
   *  null 表示没有合格席位。 */
  seat: string | null;
  /** 每个已评估但未胜出的智能体席位及其具名 disqualifier——解析失败和 proof capture
   *  所展示的结构化详情。合格但排名较后的席位列入 `qualified`，绝不列在此处。 */
  disqualified: RoleCandidateVerdict[];
  /** 最终排名顺序的合格集合（胜者在前），便于阅读负载/平局决胜证明。 */
  qualified: Array<{ coordinate: string; logicalId: string; pendingWorkCount: number }>;
}

function verdictOf(c: RoleSeatCandidateFacts, disqualifier: string): RoleCandidateVerdict {
  return {
    coordinate: c.coordinate,
    logicalId: c.logicalId,
    disqualifier,
    facts: {
      role: c.role,
      lifecycleState: c.lifecycleState,
      runtime: c.runtime,
      pendingWorkCount: c.pendingWorkCount,
    },
  };
}

/**
 * 从候选事实中选择承担 `role` 的席位。此函数为纯函数，输入数组顺序绝不影响结果
 *（commit-4 排列向量）。
 *
 * `harness` 是步骤的 WF-2 固定项：设置时，合格席位必须恰好运行该 runtime；
 * 缺失时任意智能体 runtime 均合格，因为 nodeKind 门已排除 infrastructure/terminal。
 */
export function selectRoleSeat(input: {
  role: string;
  harness?: string;
  candidates: RoleSeatCandidateFacts[];
}): RoleSelectionResult {
  const disqualified: RoleCandidateVerdict[] = [];
  const qualified: RoleSeatCandidateFacts[] = [];

  for (const c of input.candidates) {
    // infrastructure/terminal 节点不是智能体席位——schema 会拒绝其 role；
    // 它们静默排除在作用域外，不会列出，因为终端服务器不是可操作候选。
    if (c.nodeKind !== "agent") continue;
    if (c.role !== input.role) {
      disqualified.push(verdictOf(c, "role_not_declared"));
      continue;
    }
    if (c.lifecycleState !== "running") {
      disqualified.push(verdictOf(c, `not_live(lifecycleState=${c.lifecycleState})`));
      continue;
    }
    // v1 受管席位作用域固定项（arch Q5）：已采纳席位的原始名/派生名投递双重性
    // 会造成交接搁浅，因此必须响亮排除，并在每份 candidates 输出中可见。
    if (c.coordinate === null) {
      disqualified.push(verdictOf(c, "coordinate_underivable"));
      continue;
    }
    if (c.rawSessionName !== null && c.rawSessionName !== c.coordinate) {
      disqualified.push(verdictOf(c, "adopted_seat_not_role_resolvable_v1"));
      continue;
    }
    if (input.harness !== undefined && c.runtime !== input.harness) {
      disqualified.push(
        verdictOf(c, `runtime_mismatch(${c.runtime ?? "unknown"}≠${input.harness})`),
      );
      continue;
    }
    qualified.push(c);
  }

  // 容量排序：未认领积压最少者优先；平局时按坐标普通码点升序
  //（driver10@rig < driver2@rig）。
  qualified.sort((a, b) => {
    if (a.pendingWorkCount !== b.pendingWorkCount) {
      return a.pendingWorkCount - b.pendingWorkCount;
    }
    const ka = a.coordinate!;
    const kb = b.coordinate!;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    seat: qualified[0]?.coordinate ?? null,
    disqualified,
    qualified: qualified.map((c) => ({
      coordinate: c.coordinate!,
      logicalId: c.logicalId,
      pendingWorkCount: c.pendingWorkCount,
    })),
  };
}
