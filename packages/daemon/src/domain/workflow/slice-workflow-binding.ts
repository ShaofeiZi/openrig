// 切片故事视图 v1——切片到 workflow_instance 的绑定辅助函数。
//
// 给定切片的 qitem 集合，查找涉及其中任一 qitem 的 workflow_instance。使用两个信号取并集：
//
//   1. workflow_step_trails.prior_qitem_id IN (slice qitems)——步骤关闭
//      或 workflow_step_trails.next_qitem_id IN (slice qitems)——步骤投影
//      → 表示实例历史上涉及该切片
//   2. workflow_instances.current_frontier_json LIKE '%qitemId%'
//      → 实例当前活跃在某个切片 qitem 上
//
// 返回按 created_at DESC 排序的实例 ID。多个实例绑定同一切片时，v1 选择最近
// 实例（依据 PRD：“切片有多个 workflow_instance 时，v1 选择最近一个或显示
// ‘多个实例’提示；具体 UX 由实现者在审计时评审确定”）。选择最近实例是对操作员
// 友好的默认行为；同时通过 `additionalInstanceIds` 暴露其他实例，使 UI 可显示
// “另有 N 个”而不丢失数据。
//
// MVP 单主机场景：查询在每次获取切片详情时临时运行，不缓存；详情投影器自身按切片
// 索引器的 TTL 边界。

import type Database from "better-sqlite3";

export interface SliceWorkflowBinding {
/** 最近涉及切片 qitem 集合的 workflow_instance。 */
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  status: string;
  currentStepId: string | null;
/** 从 JSON 列解析出的前沿 qitem_id。 */
  currentFrontier: string[];
  hopCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface SliceWorkflowBindingResult {
  primary: SliceWorkflowBinding | null;
/** 涉及该切片的其他实例，供 UI 显示“另有 N 个”。 */
  additionalInstanceIds: string[];
}

interface InstanceRow {
  instance_id: string;
  workflow_name: string;
  workflow_version: string;
  status: string;
  current_frontier_json: string;
  current_step_id: string | null;
  hop_count: number;
  created_at: string;
  completed_at: string | null;
}

export function findSliceWorkflowBinding(
  db: Database.Database,
  qitemIds: string[],
): SliceWorkflowBindingResult {
  if (qitemIds.length === 0) return { primary: null, additionalInstanceIds: [] };

  const instanceIds = new Set<string>();

// 信号 1：轨迹通过 prior_qitem_id 或 next_qitem_id 引用切片 qitem。
  try {
    const placeholders = qitemIds.map(() => "?").join(",");
    const trailRows = db.prepare(
      `SELECT DISTINCT instance_id FROM workflow_step_trails
       WHERE prior_qitem_id IN (${placeholders})
          OR next_qitem_id  IN (${placeholders})`
    ).all(...qitemIds, ...qitemIds) as Array<{ instance_id: string }>;
    for (const r of trailRows) instanceIds.add(r.instance_id);
  } catch {
    // workflow_step_trails 缺失，跳过。
  }

  // 信号 2：切片 qitem 上的实时前沿（活跃步骤 packet）。
  // current_frontier_json 是字符串 JSON 数组；LIKE '%"qitem"%'
// 这是匹配 JSON 编码形式的低成本启发式方法。若 qitem ID 作为其他字符串的子串
  // 可能理论上匹配无关 ID，但 ULID 前缀规则（时间戳加随机值）使单主机 MVP 规模下的冲突概率
  // 极低。
  try {
    for (const qid of qitemIds) {
      const liveRows = db.prepare(
        `SELECT instance_id FROM workflow_instances
         WHERE current_frontier_json LIKE ?`
      ).all(`%${qid}%`) as Array<{ instance_id: string }>;
      for (const r of liveRows) instanceIds.add(r.instance_id);
    }
  } catch {
    // workflow_instances 缺失，跳过。
  }

  if (instanceIds.size === 0) return { primary: null, additionalInstanceIds: [] };

// 解析完整记录，按 created_at DESC 排序，并选择最近一条作为主实例。
  const idList = Array.from(instanceIds);
  const idPlaceholders = idList.map(() => "?").join(",");
  let rows: InstanceRow[] = [];
  try {
    rows = db.prepare(
      `SELECT instance_id, workflow_name, workflow_version, status,
              current_frontier_json, current_step_id, hop_count,
              created_at, completed_at
         FROM workflow_instances
         WHERE instance_id IN (${idPlaceholders})
         ORDER BY created_at DESC, instance_id DESC`
    ).all(...idList) as InstanceRow[];
  } catch {
    return { primary: null, additionalInstanceIds: [] };
  }

  if (rows.length === 0) return { primary: null, additionalInstanceIds: [] };

  const primary = rowToBinding(rows[0]!);
  const additional = rows.slice(1).map((r) => r.instance_id);
  return { primary, additionalInstanceIds: additional };
}

function rowToBinding(row: InstanceRow): SliceWorkflowBinding {
  let frontier: string[] = [];
  try {
    const parsed = JSON.parse(row.current_frontier_json);
    if (Array.isArray(parsed)) frontier = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // JSON 畸形时使用空前沿；实例处于降级状态，但 v1 UI 仍会渲染已绑定 workflow_name 和 status。
  }
  return {
    instanceId: row.instance_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    status: row.status,
    currentStepId: row.current_step_id,
    currentFrontier: frontier,
    hopCount: row.hop_count,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}
