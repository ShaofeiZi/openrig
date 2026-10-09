// PL-004 阶段 D：workflow-keepalive policy（POC `lib/policies/workflow-keepalive.mjs` 的
// TypeScript 移植版，并按审计行 18 调整为直接读取 SQLite workflow_instances）。
//
// 关键约束：workflow-keepalive 必须只读取 SQLite workflow_instances 表。后台服务 policy 层不得
// 从文件系统读取 Markdown workflow runtime。（审计行 18。）
//
// 保留 POC 契约（语义不变；机制从 Markdown frontmatter 切换为 SQLite 列）：
//   - 资格：status === "active" || status === "waiting"。否则 action=terminal、
//     reason="workflow_not_active"。（POC 在 skip 上设置 terminal:true；阶段 C engine 使用独立
//     terminal action 达到相同效果。）
//   - Frontier 为空且无 fallback target：以 reason="empty_frontier" 跳过。
//   - 查询 queue_items 表解析 frontier qitem owner。
//   - 合并已解析和显式的额外 target：
//       - workflow.created_by_session
//       - context.observer_sessions[]
//       - context.observer_session
//       - job.target.session（注册 target 作为 fallback）
//   - 发送给第一个已解析 target。v1 仅支持单 target；其余已解析 owner 会列入消息用于路由。
//     POC 的 send_many 推迟实现（阶段 C engine 的 PolicyEvaluation 契约是单 target）。

import type Database from "better-sqlite3";
import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";
import {
  evaluateStepDeadline,
  type WorkflowDeadlineVerdict,
} from "../workflow-deadline.js";

interface WorkflowKeepaliveContext {
  /** 要保持活跃的 workflow_instances 行 ULID，必填。 */
  workflow_instance_id?: string;
  /** parallel-frontier 自动 armed job 的可选 packet selector。 */
  workflow_packet_id?: string;
  observer_session?: string;
  observer_sessions?: string[];
  /**
   * OPR.0.4.6.WF1 FR-3：在自动 armed job 上设为 true（见 workflow-keepalive-arming.ts）。
   * FR-2 evaluator 报告 healthy 时，受 deadline 门控的 job 保持安静；只有 frontier packet 逾期
   * 才发送，从而维持 FR-2 正常路径零噪声的 AC。操作员注册的 job（无此 flag）保持已发布 POC
   * 始终发送的行为不变。
   */
  deadline_gated?: boolean;
}

interface InstanceRow {
  instance_id: string;
  workflow_name: string;
  workflow_version: string;
  created_by_session: string;
  status: string;
  current_frontier_json: string;
  current_step_id: string | null;
}

interface QueueOwnerRow {
  qitem_id: string;
  destination_session: string;
  state: string;
  ts_created: string;
  claimed_at: string | null;
  closure_required_at: string | null;
}

export interface WorkflowKeepaliveDeps {
  db: Database.Database;
  /** OPR.0.4.6.WF5 FR-2 类别 (b)：提供时，非 healthy deadline verdict 会在检测时确保存在持久
   * exception item，作为本次 evaluation 的副作用。PolicyEvaluation 结构不变（仍为
   * send|skip|terminal——X5）；item 由注入 helper 负责，按 occurrence 去重。失败不会让 evaluation
   * 终止。 */
  ensureStuckExceptionItem?: import("../workflow-exception-escalation.js").EnsureStuckExceptionItem;
  reconcileStuckExceptions?: (instanceId: string) => number;
}

export function makeWorkflowKeepalivePolicy(deps: WorkflowKeepaliveDeps): Policy {
  const { db } = deps;

  return {
    name: "workflow-keepalive",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const context = job.context as WorkflowKeepaliveContext;
      const instanceId = context.workflow_instance_id;
      if (!instanceId) {
        throw Object.assign(
          new Error("workflow-keepalive：context.workflow_instance_id 必填"),
          {
            code: "policy_spec_invalid",
            policy: "workflow-keepalive",
            field: "context.workflow_instance_id",
          },
        );
      }

      // 审计行 18 的关键断言：只从 SQLite 读取。
      const instance = db
        .prepare(
          `SELECT instance_id, workflow_name, workflow_version, created_by_session,
                  status, current_frontier_json, current_step_id
           FROM workflow_instances WHERE instance_id = ?`,
        )
        .get(instanceId) as InstanceRow | undefined;

      if (!instance) {
        return {
          action: "terminal",
          reason: "workflow_instance_missing",
          notes: { instanceId },
        };
      }

      deps.reconcileStuckExceptions?.(instanceId);
      const eligible = instance.status === "active" || instance.status === "waiting";
      if (!eligible) {
        return {
          action: "terminal",
          reason: "workflow_not_active",
          notes: { instanceId, status: instance.status },
        };
      }

      const wholeFrontier = (JSON.parse(instance.current_frontier_json) as string[]) ?? [];
      const packetId = context.workflow_packet_id;
      if (packetId && !wholeFrontier.includes(packetId)) {
        return { action: "terminal", reason: "workflow_packet_not_live", notes: { instanceId, packetId } };
      }
      const frontier = packetId ? [packetId] : wholeFrontier;
      let currentStepId = instance.current_step_id;
      if (packetId) {
        try {
          currentStepId = (db.prepare(
            `SELECT step_id FROM workflow_frontier_bindings WHERE instance_id = ? AND packet_id = ?`,
          ).get(instanceId, packetId) as { step_id: string } | undefined)?.step_id ?? null;
        } catch {
          currentStepId = null;
        }
      }

      // 从 queue_items 解析 frontier qitem owner（以及 FR-2 anchor 字段）。
      const resolvedFrontierOwners: string[] = [];
      let frontierRows: QueueOwnerRow[] = [];
      if (frontier.length > 0) {
        const placeholders = frontier.map(() => "?").join(",");
        frontierRows = db
          .prepare(
            `SELECT qitem_id, destination_session, state, ts_created, claimed_at, closure_required_at
             FROM queue_items WHERE qitem_id IN (${placeholders})`,
          )
          .all(...frontier) as QueueOwnerRow[];
        for (const r of frontierRows) resolvedFrontierOwners.push(r.destination_session);
      }

      // OPR.0.4.6.WF1 FR-2+FR-3：评估派生且从不存储的 step deadline。受 deadline 门控
      //（自动 armed）的 job 在 healthy 时保持安静；逾期时，任何 job 的发送消息都会携带 stuck
      // 证据 + 重新投影引导信息。
      const verdict: WorkflowDeadlineVerdict = evaluateStepDeadline(
        {
          instanceId: instance.instance_id,
          status: instance.status,
          currentFrontier: frontier,
          currentStepId,
        },
        frontierRows.map((r) => ({
          qitemId: r.qitem_id,
          state: r.state,
          destinationSession: r.destination_session,
          tsCreated: r.ts_created,
          claimedAt: r.claimed_at,
          closureRequiredAt: r.closure_required_at,
        })),
        new Date(),
      );
      if (context.deadline_gated === true && verdict.state === "healthy") {
        // 静默跳过——不记录到 watchdog history（保持 POC 对 quiet reason 的行为）；正常路径零噪声。
        return { action: "skip", reason: "workflow_healthy_deadline_gated" };
      }

      // 与显式额外 target 合并。
      const additionalTargets: string[] = [
        instance.created_by_session,
        ...((context.observer_sessions ?? []) as string[]),
        ...(context.observer_session ? [context.observer_session] : []),
        ...(job.target?.session ? [job.target.session] : []),
      ].filter(Boolean);

      const allSessions = Array.from(new Set([...resolvedFrontierOwners, ...additionalTargets]));

      if (allSessions.length === 0) {
        // POC 第 113-118 行：没有解析到任何内容时以 empty_frontier 跳过。
        return { action: "skip", reason: "empty_frontier" };
      }

      // 超过 deadline 的受门控（自动 armed）job 会携带 stuck evidence，将 nudge 引导给逾期 packet
      // 的 owner；恢复或替换后的 agent 读取 steering 并重新投影，stuck marker 会在重新组合时自行清除
      //（FR-2 AC）。操作员注册的 job（无 flag）即使 packet 逾期，也精确保留已发布 POC 消息 +
      // 首个已解析 target 的行为；其契约早于 deadline 模型，并由已发布 policy 测试固定。
      const stuck =
        context.deadline_gated === true && verdict.state !== "healthy" && verdict.evidence
          ? verdict.evidence
          : null;
      // OPR.0.4.6.WF5 FR-2 类别 (b)：检测时 exception item——任何非 healthy verdict 都会触发
      //（无论门控还是操作员注册 job；下方 operator-job 消息契约保持固定不变）。按 occurrence 去重，
      // 使其跨每次 keepalive cadence tick 保持幂等。
      let exceptionItemError: string | undefined;
      if (deps.ensureStuckExceptionItem && verdict.state !== "healthy" && verdict.evidence) {
        try {
          const recovery = await deps.ensureStuckExceptionItem({
            workflowName: instance.workflow_name,
            workflowVersion: instance.workflow_version,
            createdBySession: instance.created_by_session,
            verdict,
          });
          if (context.deadline_gated === true && recovery.qitemId) {
            return { action: "skip", reason: "workflow_recovery_owns_notice", notes: { instanceId, recoveryQitemId: recovery.qitemId, outcome: recovery.outcome } };
          }
        } catch (error) {
          // 保留 owner nudge，同时报告 exception admission 失败。
          exceptionItemError = error instanceof Error ? error.message : String(error);
        }
      }
      const condition = stuck ? JSON.stringify([stuck.packetId, stuck.anchor, stuck.anchorAt]) : undefined;
      const hasReceipt = condition && (db.prepare("PRAGMA table_info(watchdog_jobs)").all() as Array<{ name: string }>).some(column => column.name === "last_fired_condition");
      const receipt = hasReceipt ? (db.prepare("SELECT last_fired_condition AS value FROM watchdog_jobs WHERE job_id = ?").get(job.jobId) as { value: string | null } | undefined)?.value : null;
      if (condition && receipt === condition && !exceptionItemError) return { action: "skip", reason: "workflow_deadline_already_presented" };
      const primary = stuck ? stuck.ownerSession : allSessions[0]!;
      const others = stuck
        ? allSessions.filter((s) => s !== primary)
        : allSessions.slice(1);
      const message = stuck
        ? buildStuckNudgeMessage({
            workflowName: instance.workflow_name,
            workflowVersion: instance.workflow_version,
            verdictState: verdict.state,
            evidence: stuck,
          })
        : (job.message ??
          buildKeepaliveMessage({
            workflowName: instance.workflow_name,
            workflowVersion: instance.workflow_version,
            instanceId: instance.instance_id,
            status: instance.status,
            allSessions,
          }));

      return {
        action: "send",
        ...(condition ? { conditionReceipt: condition } : {}),
        target: { session: primary },
        message: exceptionItemError ? `${message}\nWorkflow exception item 未获准进入：${exceptionItemError}` : message,
        notes: {
          instanceId: instance.instance_id,
          workflowName: instance.workflow_name,
          workflowStatus: instance.status,
          frontierLength: frontier.length,
          additionalRoutingTargets: others,
          ...(stuck ? { deadline: { state: verdict.state, ...stuck } } : {}),
          ...(exceptionItemError ? { exceptionItemError } : {}),
        },
      };
    },
  };
}

const POC_KEEPALIVE_TRAILER =
  "继续当前步骤。如果运行已结束，请如实更新 workflow 状态，并立即生成下一个真实 packet。" +
  "如果你认为需要审批，先判断究竟存在真实的产品歧义，还是只有形式化审批。" +
  "保持沟通连通，明确指出具体 blocker，并主动检查确定性偏见：" +
  "只添加 agent 可靠运行所需的最少确定性代码，其余路由、适配和边缘处理依靠 agent 判断。";

/**
 * OPR.0.4.6.WF1 FR-2：逾期后的再次 nudge。面向对该 step 没有对话记忆的已恢复或替换 agent：
 * 点明 instance、step、packet、anchor evidence 和精确的 re-project 动作。
 */
function buildStuckNudgeMessage(input: {
  workflowName: string;
  workflowVersion: string;
  verdictState: string;
  evidence: {
    instanceId: string;
    stepId: string | null;
    packetId: string;
    ownerSession: string;
    anchor: string;
    anchorAt: string;
    overdueBySeconds: number;
    ageSeconds: number;
  };
}): string {
  const e = input.evidence;
  return [
    `Workflow deadline：${e.instanceId}，packet ${e.packetId}，owner ${e.ownerSession}；逾期 ${Math.floor(e.overdueBySeconds / 60)} 分钟（${e.anchor} 于 ${e.anchorAt}）。`,
    `Packet age 不能证明处于 idle。请检查：rig workflow show ${e.instanceId}。完整 packet：rig queue show ${e.packetId} --full。`,
  ].join("\n");
}

function buildKeepaliveMessage(input: {
  workflowName: string;
  workflowVersion: string;
  instanceId: string;
  status: string;
  allSessions: string[];
}): string {
  const lines = [
    `Workflow keepalive：${input.workflowName}@${input.workflowVersion} / ${input.instanceId} 仍在运行（状态：${input.status}）。`,
    POC_KEEPALIVE_TRAILER,
  ];
  if (input.allSessions.length > 1) {
    lines.push("", `其他 frontier owner + observer：${input.allSessions.slice(1).join(", ")}`);
  }
  return lines.join("\n");
}
