/**
 * OPR.0.4.6.WF3 FR-2——面向人、一眼可读的 trace/list/show 渲染器。
 * 仅渲染侧（BR-2）：这些函数只是把 CLI 已经收到的后台服务负载格式化；
 * `--json` 路径绝不经过这里，与已发布输出逐字节一致。
 *
 * 形态移植自仓库内既有先例：`rig ps` 表格机制（fitCell/truncate）
 * 与 argo-get 的逐步骤树状条（STEP / ACTOR / EXIT / DURATION 列 + 状态字形）。
 *
 * 容错字段：WF-2 的 branch/gate 新增
 * （closureEvidence.branch_taken 等）在负载携带时渲染，缺失时不留痕迹——
 * 本模块从不要求它们（WF-3 基于 WF-2 之前的 tip 构建；这些字段随 WF-2 落地）。
 */

import { shellQuote } from "../cross-host-executor.js";

export interface RenderInstance {
  guidance?: {lines: string[]};
  instanceId: string;
  workflowName?: string;
  workflowVersion?: string;
  status: string;
  createdBySession?: string;
  createdAt?: string;
  currentStepId?: string | null;
  currentFrontier?: string[];
  hopCount?: number;
  /** OPR.0.4.6.FAC1：实例绑定的 rig（API 携带；null/缺失 = 未绑定，不渲染）。 */
  boundRig?: string | null;
  /**
   * WF-1 FR-2 由 API 携带的分类（自 384e60f1 的完成回修起就存在）。
   * RAIL 1（架构裁定）：CLI 逐字消费，绝不重新计算阈值或类别。
   */
  deadline?: {
    state: string;
    evidence?: {
      stepId?: string | null;
      ownerSession?: string;
      overdueBySeconds?: number;
      ageSeconds?: number;
    } | null;
  };
  /** 在已记录其驻留决策的等待实例上出现。 */
  lastContinuationDecision?: { blockedOn?: string | null } | null;
  /** S06：按包寻址的 frontier 事实派生自实时队列行。 */
  frontierPackets?: RenderFrontierPacket[];
  /** S06：即使兄弟步骤在运行，未解决的分支失败仍保持可见。 */
  failureOccurrences?: RenderFailureOccurrence[];
  /** 具名断链；绝不把它们折叠成看似可操作的一行。 */
  unknowns?: string[];
  exceptionObligations?: Array<{ qitemId: string; ownerSession: string; state: string; evidenceRef: string | null; inspectCommand: string }>;
  exceptionReadiness?: {
    selection: { state: string; role: string | null; source: string; entryRole: string | null };
    routes: Array<{ exceptionClass: string; state: string; roleResolution: string; destinationSession: string | null; position: string | null; resolvedVia: string | null; message: string }>;
    nextAction: string;
  } | null;
  reconciliation?: {
    status: string; adopted: boolean | null; boundDigest: string | null; proposedDigest: string | null;
    composition: { mode: string; explanation: string; boundSlices: string[]; executableSteps: unknown[] };
    changes: Array<{ kind: string; ref: string; fields?: string[] }>; reasons: string[];
    nextAction: string; applyCommand?: string; operationKey?: string;
  };
  lifecycleBinding?: { graphSource?: { mode?: string; profileSource?: string | null; missionSource?: string | null } } | null;
  boundaryObligations?: Array<{ stepId: string; required: boolean; state: string; receiptState: string;
    receipt: { evidenceRef: string; actorSession: string; closedAt: string } | null }>;

}

export interface RenderFrontierPacket {
  packetId: string;
  stepId: string | null;
  ownerSession: string | null;
  queueState: string | null;
  blockedOn: string | null;
  targetedAction: "project" | "route" | "indeterminate";
  dependsOn?: string[];
  receiptRequired?: boolean;
  acceptance?: {
    candidate: string;
    verdicts: string[];
    evidence_ref: string;
  } | null;
}

export interface RenderFailureOccurrence {
  occurrenceId: string;
  stepId: string;
  status: "unresolved" | "resolved";
  failureReason?: string | null;
  redrivePacketId?: string | null;
  targetedAction: "resume" | "none";
}

export interface RenderTrailRow {
  stepId: string;
  stepRole?: string;
  closedAt?: string;
  closureReason: string;
  closureEvidence?: Record<string, unknown> | null;
  actorSession: string;
  nextQitemId?: string | null;
  priorQitemId?: string;
}

/** 一个命令形态的所有者动作，存在时含带类型的接受契约。 */
export function renderProjectAction(instanceId: string, packet: RenderFrontierPacket): string {
  const base = `zrig workflow project --instance ${instanceId} --current-packet ${packet.packetId} --exit <handoff|waiting|done|failed> --actor-session ${packet.ownerSession ?? "<owner>"}${packet.receiptRequired ? " --evidence-ref <agent-judged-receipt>" : ""}`;
  if (!packet.acceptance) return base;
  const verdict = packet.acceptance.verdicts.length === 1
    ? packet.acceptance.verdicts[0]!
    : `<${packet.acceptance.verdicts.join("|")}>`;
  return `${base} --acceptance-candidate ${shellQuote(packet.acceptance.candidate)} --acceptance-verdict ${shellQuote(verdict)} --acceptance-evidence-ref ${shellQuote(packet.acceptance.evidence_ref)}`;
}

function actionableFailures(instance: RenderInstance): RenderFailureOccurrence[] {
  return (instance.failureOccurrences ?? []).filter(
    (failure) => failure.status === "unresolved" && failure.targetedAction === "resume",
  );
}

const STATUS_GLYPH: Record<string, string> = {
  completed: "✔",
  failed: "✖",
  active: "●",
  waiting: "◐",
  aborted: "■",
};

export function statusGlyph(status: string): string {
  return STATUS_GLYPH[status] ?? "●";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fitCell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

/** 两个 ISO 时间戳之间的紧凑人类时长（"3s"、"4m"、"2h"、"5d"）。 */
export function humanDuration(fromIso: string | undefined, toIso: string | undefined): string {
  if (!fromIso || !toIso) return "";
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  // 分钟渲染到（含）120，使 2 小时内的时长保持精度
  // （判断步骤延迟时，"90m"/"120m" 优于向上取整的 "2h"）。
  // 守卫预扫描 catch：`m < 120` 恰好排除了 120。
  if (m <= 120) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** 实例相对给定"now"的年龄（测试可注入）。 */
export function humanAge(createdAt: string | undefined, nowIso: string): string {
  return humanDuration(createdAt, nowIso);
}

/** 一个秒数的紧凑渲染（同一套尺度规则）。 */
export function humanSeconds(seconds: number): string {
  return humanDuration("1970-01-01T00:00:00.000Z", new Date(seconds * 1000).toISOString());
}

/**
 * trace 树（mini-req 2 的条：它在哪 + 怎么到的，一屏看完，无需读懂 JSON）。
 */
export function renderTraceTree(
  instance: RenderInstance,
  trail: RenderTrailRow[],
  nowIso: string = new Date().toISOString(),
): string[] {
  const lines: string[] = [];
  const name = instance.workflowName ? `${instance.workflowName}${instance.workflowVersion ? ` v${instance.workflowVersion}` : ""}` : "";
  lines.push(`${statusGlyph(instance.status)} ${instance.instanceId}  ${name}  status=${instance.status}${instance.hopCount !== undefined ? `  hops=${instance.hopCount}` : ""}${instance.boundRig ? `  rig=${instance.boundRig}` : ""}`);
  if (instance.createdAt) {
    lines.push(`  创建于 ${instance.createdAt}${instance.createdBySession ? `，由 ${instance.createdBySession}` : ""}  年龄 ${humanAge(instance.createdAt, nowIso)}`);
  }
  lines.push("");
  lines.push(`  ${fitCell("步骤", 22)}${fitCell("执行者", 28)}${fitCell("退出", 10)}时长`);
  let prevClosed = instance.createdAt;
  for (let i = 0; i < trail.length; i++) {
    const row = trail[i];
    if (!row) continue;
    const glyph = row.closureReason === "failed" ? "✖" : "✔";
    const bar = i === trail.length - 1 && !instance.currentStepId ? "└─" : "├─";
    const duration = humanDuration(prevClosed, row.closedAt);
    lines.push(`  ${bar} ${glyph} ${fitCell(row.stepId, 20)}${fitCell(row.actorSession, 28)}${fitCell(row.closureReason, 10)}${duration}`);
    const branchTaken = row.closureEvidence?.["branch_taken"];
    if (typeof branchTaken === "string" && branchTaken.length > 0) {
      lines.push(`  │    ↳ 分支：${branchTaken}`);
    }
    prevClosed = row.closedAt ?? prevClosed;
  }
  const packetRows = instance.frontierPackets ?? [];
  if (packetRows.length > 0) {
    for (let i = 0; i < packetRows.length; i++) {
      const packet = packetRows[i]!;
      const bar = i === packetRows.length - 1 ? "└─" : "├─";
      const step = packet.stepId ?? "不确定";
      const owner = packet.ownerSession ?? "不确定";
      const state = packet.queueState ?? "不确定";
      lines.push(`  ${bar} ▸ ${fitCell(step, 20)}${fitCell(owner, 28)}${fitCell(state, 10)}packet=${packet.packetId}`);
      if (packet.blockedOn) lines.push(`  │    ↳ 阻塞于：${packet.blockedOn}`);
    }
  } else if (instance.currentStepId) {
    const owner = ""; // frontier 所有者是队列侧事实；负载携带的是 frontier packet id
    lines.push(`  └─ ▸ ${fitCell(instance.currentStepId, 20)}${fitCell(owner || "(当前)", 28)}${fitCell("open", 10)}frontier=[${(instance.currentFrontier ?? []).join(", ")}]`);
  } else if (trail.length === 0) {
    lines.push(`  （尚无步骤关闭）`);
  }
  for (const failure of (instance.failureOccurrences ?? []).filter((item) => item.status === "unresolved")) {
    lines.push(`  ▲ 失败 ${failure.occurrenceId}  步骤=${failure.stepId}${failure.failureReason ? `  原因=${failure.failureReason}` : ""}`);
    lines.push(failure.targetedAction === "resume"
      ? `      动作：zrig workflow resume ${instance.instanceId} --occurrence ${failure.occurrenceId} --actor-session <你>`
      : "      动作：无——终态历史");
  }
  for (const unknown of instance.unknowns ?? []) lines.push(`  ? ${unknown}`);
  return lines;
}

/**
 * OPR.0.4.6.WF3 FR-3——列表行的关注标记（唯一的标记归属处）。类别：
 * failed · stuck（从 API 携带的 deadline 分类逐字消费——rail 1：
 * CLI 绝不重算阈值或类别）· waiting。一行显示其最高优先级类别；
 * `status` 动词逐实例显示所有类别（恰好一次、理由合并）。
 */
export function attentionMarker(instance: RenderInstance): string {
  if (instance.status === "failed") return "▲ 失败";
  if (actionableFailures(instance).length > 0) return "▲ 失败分支";
  if (isStuck(instance)) return "▲ 卡住";
  if (instance.status === "waiting") return "▲ 等待";
  return "";
}

/** Rail 1：卡住状态从 API 字段读取，绝不派生。 */
function isStuck(instance: RenderInstance): boolean {
  const state = instance.deadline?.state;
  return typeof state === "string" && state.startsWith("overdue");
}

// ── FR-3 B 部分：需关注汇总（`zrig workflow status`）──

export interface AttentionRow {
  instanceId: string;
  workflowName: string;
  /** 该实例的全部类别——恰好一行，合并展示。 */
  classes: string[];
  reasons: string[];
  /** 可操作的下一步提示，按类别优先级。 */
  affordance: string;
}

export interface AttentionRollup {
  counts: { total: number; active: number; waiting: number; completed: number; failed: number; aborted: number };
  attention: AttentionRow[];
}

/**
 * 从列表行组合汇总。对已分类行做纯算术
 * （架构裁定的边界：计数 + 分组 + 渲染是渲染侧；唯一的正确性规则组合——
 * 阈值分类——在 instance.deadline 中已是完成态）。按 instanceId 逐实例去重
 * （rail 2）：一个有多个关注理由的实例只渲染一次，带上全部理由。
 */
export function composeAttentionRollup(instances: RenderInstance[]): AttentionRollup {
  const counts = { total: instances.length, active: 0, waiting: 0, completed: 0, failed: 0, aborted: 0 };
  const attention: AttentionRow[] = [];
  for (const inst of instances) {
    if (inst.status === "active") counts.active += 1;
    else if (inst.status === "waiting") counts.waiting += 1;
    else if (inst.status === "completed") counts.completed += 1;
    else if (inst.status === "failed") counts.failed += 1;
    else if (inst.status === "aborted") counts.aborted += 1;

    const classes: string[] = [];
    const reasons: string[] = [];
    if (inst.status === "failed") {
      classes.push("failed");
      reasons.push("工作流失败");
    }
    const unresolved = actionableFailures(inst);
    if (unresolved.length > 0 && inst.status !== "failed") {
      classes.push("failed-branch");
      reasons.push(`${unresolved.length} 个未解决的分支失败`);
    }
    if (isStuck(inst)) {
      classes.push("stuck");
      const ev = inst.deadline?.evidence;
      reasons.push(
        `${inst.deadline?.state}${ev?.stepId ? `，位于步骤 ${ev.stepId}` : ""}${ev?.ownerSession ? `（所有者 ${ev.ownerSession}）` : ""}${typeof ev?.overdueBySeconds === "number" ? `，逾期 ${humanSeconds(ev.overdueBySeconds)}` : ""}`,
      );
    }
    if (inst.status === "waiting") {
      classes.push("waiting");
      const blocker = inst.lastContinuationDecision?.blockedOn;
      reasons.push(`等待中${blocker ? `，阻塞于 ${blocker}` : "（未记录阻塞原因）"}`);
    }
    if (classes.length === 0) continue;
    // 按最高优先级类别给出提示。`route` 在同一 slice 内交付
    // （commit 6）——各动词在合并时一起落地（BR-1 在发布边界成立）。
    const affordance = classes.includes("failed") || classes.includes("failed-branch")
      ? `检视：zrig workflow trace ${inst.instanceId}`
      : classes.includes("stuck")
        ? `重路由：zrig workflow route ${inst.instanceId} --to <席位>`
        : `解决阻塞后由所有者投影（zrig workflow trace ${inst.instanceId}）`;
    attention.push({
      instanceId: inst.instanceId,
      workflowName: inst.workflowName ?? "",
      classes,
      reasons,
      affordance,
    });
  }
  return { counts, attention };
}

/** 汇总的人类渲染——已证为空，绝不空白。 */
export function renderStatus(rollup: AttentionRollup): string[] {
  const c = rollup.counts;
  const lines: string[] = [];
  lines.push(
    `${c.total} 个实例：${c.active} 活跃 · ${c.waiting} 等待 · ${c.completed} 完成 · ${c.failed} 失败 · ${c.aborted} 中止`,
  );
  if (rollup.attention.length === 0) {
    lines.push("没有实例需要关注（已证为空——所有在途实例均健康）。");
    return lines;
  }
  lines.push("");
  lines.push(`${fitCell("", 2)}${fitCell("实例", 30)}${fitCell("工作流", 20)}${fitCell("类别", 16)}原因`);
  for (const row of rollup.attention) {
    lines.push(
      `${fitCell("▲", 2)}${fitCell(row.instanceId, 30)}${fitCell(row.workflowName, 20)}${fitCell(row.classes.join("+"), 16)}${row.reasons.join("；")}`,
    );
    lines.push(`  ${fitCell("", 2)}└ ${row.affordance}`);
  }
  return lines;
}

/** 列表表格：实例 · 工作流 · 状态 · 步骤 · 年龄 · 关注。 */
export function renderInstanceList(
  instances: RenderInstance[],
  nowIso: string = new Date().toISOString(),
): string[] {
  if (instances.length === 0) return ["没有工作流实例。"];
  const lines: string[] = [];
  lines.push(`${fitCell("", 2)}${fitCell("实例", 30)}${fitCell("工作流", 22)}${fitCell("状态", 11)}${fitCell("步骤", 20)}${fitCell("年龄", 6)}关注`);
  for (const inst of instances) {
    lines.push(
      `${fitCell(statusGlyph(inst.status), 2)}${fitCell(inst.instanceId, 30)}${fitCell(inst.workflowName ?? "", 22)}${fitCell(inst.status, 11)}${fitCell(renderStepCell(inst), 20)}${fitCell(humanAge(inst.createdAt, nowIso), 6)}${attentionMarker(inst)}`,
    );
  }
  return lines;
}

/** show 摘要，以状态行开头。 */
export function renderInstanceShow(
  instance: RenderInstance,
  nowIso: string = new Date().toISOString(),
): string[] {
  const lines: string[] = [];
  lines.push(`${statusGlyph(instance.status)} ${instance.instanceId}  status=${instance.status}`);
  if (instance.workflowName) lines.push(`  工作流：${instance.workflowName}${instance.workflowVersion ? ` v${instance.workflowVersion}` : ""}`);
  // OPR.0.4.6.FAC1：绑定时渲染绑定 rig（未绑定行不变）。
  if (instance.boundRig) lines.push(`  工作组：${instance.boundRig}`);
  if (instance.createdAt) lines.push(`  创建：  ${instance.createdAt}${instance.createdBySession ? `，由 ${instance.createdBySession}` : ""}  （年龄 ${humanAge(instance.createdAt, nowIso)}）`);
  if ((instance.frontierPackets ?? []).length > 0) {
    lines.push("  frontier：");
    for (const packet of instance.frontierPackets ?? []) {
      lines.push(`    ${packet.packetId}  step=${packet.stepId ?? "不确定"}  owner=${packet.ownerSession ?? "不确定"}  state=${packet.queueState ?? "不确定"}${packet.blockedOn ? `  blocked_on=${packet.blockedOn}` : ""}`);
      const action = packet.targetedAction === "project"
        ? renderProjectAction(instance.instanceId, packet)
        : packet.targetedAction === "route"
          ? `zrig workflow route ${instance.instanceId} --packet ${packet.packetId} --to <席位> --actor-session <你>`
          : "已禁用——检视具名 unknown";
      lines.push(`      动作：${action}`);
    }
  } else if (instance.currentStepId) {
    lines.push(`  位于步骤：${instance.currentStepId}  frontier=[${(instance.currentFrontier ?? []).join(", ")}]`);
  }
  if (instance.lifecycleBinding?.graphSource) {
    const source = instance.lifecycleBinding.graphSource;
    lines.push(`  边界：${source.mode} · ${source.profileSource ?? source.missionSource ?? "legacy"}`);
    if (source.profileSource && source.missionSource) lines.push(`  mission 覆盖：${source.missionSource}`);
  }
  for (const step of instance.boundaryObligations ?? []) {
    lines.push(`    ${step.stepId} · ${step.required ? "required" : "extension"} · ${step.state} · 收据 ${step.receiptState}`);
    if (step.receipt) lines.push(`      ${step.receipt.evidenceRef} · 由 ${step.receipt.actorSession} 记录于 ${step.receipt.closedAt}`);
  }
  const unresolved = (instance.failureOccurrences ?? []).filter((failure) => failure.status === "unresolved");
  if (unresolved.length > 0) {
    lines.push("  失败：");
    for (const failure of unresolved) {
      lines.push(`    ${failure.occurrenceId}  step=${failure.stepId}${failure.failureReason ? `  reason=${failure.failureReason}` : ""}`);
      lines.push(failure.targetedAction === "resume"
        ? `      动作：zrig workflow resume ${instance.instanceId} --occurrence ${failure.occurrenceId} --actor-session <你>`
        : "      动作：无——终态历史");
    }
  }
  for (const unknown of instance.unknowns ?? []) lines.push(`  unknown： ${unknown}`);
  if (instance.guidance) lines.push(...instance.guidance.lines);
  if (instance.exceptionReadiness) {
    const r = instance.exceptionReadiness;
    lines.push(`  异常所有者：${r.selection.state} · ${r.selection.role ?? "未选择"}（普通入口：${r.selection.entryRole ?? "隐式"}）`);
    lines.push(`    选择：${r.selection.source}`);
    for (const route of r.routes) {
      lines.push(`    ${route.exceptionClass}：${route.state} · ${route.position ?? "未知策略"}，经 ${route.resolvedVia ?? "不可用"} · ${route.destinationSession ?? "无已验证目标"} · ${route.roleResolution}`);
      if (route.state !== "ready" || route.position === "fallback") lines.push(`      ${route.message}`);
    }
    lines.push(`    建议：${r.nextAction}`);
  }
  for (const q of instance.exceptionObligations ?? []) {
    lines.push(`  异常义务：${q.qitemId} · owner=${q.ownerSession} · state=${q.state}`);
    lines.push(`    证据：${q.evidenceRef ?? "未验证"} · 检视：${q.inspectCommand}`);
  }
  if (instance.reconciliation) lines.push(...renderGraphRevision(instance.reconciliation, false));
  if (instance.hopCount !== undefined) lines.push(`  跳数：  ${instance.hopCount}`);
  lines.push(`  下一步：zrig workflow trace ${instance.instanceId}`);
  return lines;
}

export function renderGraphRevision(view: NonNullable<RenderInstance["reconciliation"]>, expanded = true): string[] {
  const lines = [
    "  图：    " + view.status + (view.adopted === null ? " · 无已撰写可比内容" : view.adopted ? " · 运行图与已撰写输入一致" : " · 已撰写输入尚未被采纳"),
    "  组合： " + view.composition.mode + "；" + view.composition.boundSlices.length + " 个绑定 slice manifest；" + view.composition.executableSteps.length + " 个可执行步骤",
    "    " + view.composition.explanation,
    "  已绑定：" + (view.boundDigest ?? "不可用"),
    "  提议：  " + (view.proposedDigest ?? "不可用"),
  ];
  if (view.status === "source-only") lines.push("    源字节不同；可执行步骤/策略未变。无需重放已完成的工作。");
  if (expanded) for (const change of view.changes) lines.push("    " + change.kind + "：" + change.ref + (change.fields?.length ? "（" + change.fields.join("、") + "）" : ""));
  for (const reason of view.reasons) lines.push("    " + reason);
  lines.push("  检视：  " + view.nextAction + "（只读；--json 展开完整证据）");
  if (expanded && view.applyCommand) lines.push("  应用：  " + view.applyCommand);
  if (expanded && view.operationKey) lines.push("  恢复：  zrig workflow operation " + shellQuote(view.operationKey));
  return lines;
}

function renderStepCell(instance: RenderInstance): string {
  const packets = instance.frontierPackets ?? [];
  if (packets.length === 1) return packets[0]!.stepId ?? "不确定";
  if (packets.length > 1) return `${packets.length} 个包`;
  return instance.currentStepId ?? "-";
}
