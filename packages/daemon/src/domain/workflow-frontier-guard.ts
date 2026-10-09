import type Database from "better-sqlite3";

/**
 * OPR.0.4.6.WF3 FR-6——frontier close-path guard 的谓词（pm 约定裁定：预防优先于检测）。
 *
 * 分层固定点（arch、binding、Rev-1）：queue 是更底层的 primitive，绝不能导入 workflow
 * domain。本模块是 workflow domain 的 export；startup 把该谓词注入 QueueRepository，
 * 完全沿用 `validateRig` 的注入先例。其功能与直接导入相同，但不会形成阻碍后续重构的模块循环。
 *
 * 谓词回答：该 qitem 是否为存活的 workflow-frontier packet？所有非 workflow qitem 均返回
 * null，形成零摩擦负向路径：非 workflow closure 行为保持逐字节一致，普通流量不会因本谓词
 * 新增任何拒绝。
 */

export interface WorkflowFrontierBinding {
  instanceId: string;
  workflowName: string;
}

export type WorkflowFrontierPredicate = (qitemId: string) => WorkflowFrontierBinding | null;

export function createWorkflowFrontierPredicate(db: Database.Database): WorkflowFrontierPredicate {
  return (qitemId: string): WorkflowFrontierBinding | null => {
    // current_frontier 是 JSON array 列；frontier membership 检查是在序列化 id 上执行包含探测。
    // 仅限存活 instance；终态 instance 不持有 frontier。
    let row: { instance_id?: string; workflow_name?: string } | undefined;
    try {
      row = db
        .prepare(
          `SELECT instance_id, workflow_name FROM workflow_instances
           WHERE status IN ('active','waiting') AND current_frontier_json LIKE ?
           LIMIT 1`,
        )
        .get(`%"${qitemId}"%`) as typeof row;
    } catch (err) {
      // workflow 之前的 schema 没有 workflow_instances 表，也就没有需要保护的内容，行为等同于
      // 未提供谓词。只容忍这一种情况；其他 SQL 错误（例如列被重命名）必须明确失败。在此吞错会
      // 静默禁用正确性 guard；VM 曾发现第一版吞掉自身 wrong-column 错误，导致 guard 从未触发。
      if (err instanceof Error && /no such table/i.test(err.message)) return null;
      throw err;
    }
    if (!row?.instance_id) return null;
    return { instanceId: row.instance_id, workflowName: row.workflow_name ?? "(unknown)" };
  };
}
