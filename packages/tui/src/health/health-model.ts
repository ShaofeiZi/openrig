import { DEFAULT_TIME_ZONE, displayTime } from "../time.js";
import { sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import { padEndW, strWidth, clipW } from "../text-width.js";
import type { Action, FleetSnapshot, HealthEvidenceReference, HealthRecord } from "../types.js";
import type { Token } from "../theme.js";

export type HealthDisplayScope =
  | { kind: "instance"; local: boolean }
  | { kind: "rig"; rigId: string; rigName: string; local: boolean }
  | { kind: "seat"; rigId: string; seatId: string | null; seatName: string; local: boolean };

function scopeMatches(record: HealthRecord, scope: HealthDisplayScope): boolean {
  if (scope.kind === "instance") return true;
  if (scope.kind === "rig") {
    return (record.scope.type === "rig" && record.scope.rigId === scope.rigId)
      || (record.scope.type === "seat" && record.scope.rigId === scope.rigId);
  }
  return record.scope.type === "seat"
    && record.scope.rigId === scope.rigId
    && scope.seatId !== null
    && record.scope.seatId === scope.seatId;
}

export function healthRecordsForScope(snap: FleetSnapshot, scope: HealthDisplayScope): HealthRecord[] {
  return [...(snap.health?.records ?? [])].filter((record) => scopeMatches(record, scope)).sort(compareHealthRecords);
}

function compareHealthRecords(a: HealthRecord, b: HealthRecord): number {
  const status = { active: 0, indeterminate: 1, cleared: 2 } as const;
  const severity = { critical: 0, warning: 1, info: 2 } as const;
  return status[a.status] - status[b.status]
    || severity[a.severity] - severity[b.severity]
    || Date.parse(b.lastObservedAt ?? "") - Date.parse(a.lastObservedAt ?? "")
    || a.id.localeCompare(b.id, "en-US");
}

function tokenFor(record: HealthRecord): Token {
  if (record.status === "indeterminate" || record.freshness.state !== "fresh") return "warn";
  if (record.status === "cleared") return "dim";
  if (record.severity === "critical") return "error";
  if (record.severity === "warning") return "warn";
  return "info";
}

function conditionLabel(record: HealthRecord): string | null {
  if (record.freshness.state === "stale") return "过期";
  if (record.status === "indeterminate" || record.freshness.state === "unavailable" || record.freshness.state === "contradictory") return "未知";
  if (record.status === "cleared") return "已清除";
  return null;
}

function stateLabel(record: HealthRecord): string {
  const condition = conditionLabel(record);
  const sevLabel = { critical: "严重", warning: "警告", info: "信息" }[record.severity] ?? record.severity.toUpperCase();
  return `${sevLabel}${condition ? ` ${condition}` : ""}`;
}

function signalLabel(record: HealthRecord): string {
  const condition = conditionLabel(record);
  return `${condition ? `${condition} · ` : ""}${record.summary}`;
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function cell(text: string, width: number): string {
  const clipped = clipW(text, width);
  return clipped + " ".repeat(Math.max(0, width - strWidth(clipped)));
}

function fitLine(parts: Array<{ text: string; token?: Token; bold?: boolean }>, width: number, action?: Action): ContentLine {
  const out: NonNullable<ContentLine["segs"]> = [];
  let room = Math.max(0, width);
  for (const part of parts) {
    if (room <= 0) break;
    const text = clipW(part.text, room);
    out.push({ ...part, text });
    room -= strWidth(text);
    if (strWidth(text) < strWidth(part.text)) break;
  }
  return { text: out.map((part) => part.text).join(""), segs: out, ...(action ? { action } : {}) };
}

function scopeName(record: HealthRecord, snap: FleetSnapshot): string {
  const recordScope = record.scope;
  switch (recordScope.type) {
    case "instance": return recordScope.instanceId;
    case "rig": return snap.hosts.flatMap((host) => host.rigs).find((rig) => rig.id === recordScope.rigId)?.name ?? recordScope.rigId;
    case "seat": {
      for (const host of snap.hosts) for (const rig of host.rigs) for (const pod of rig.pods) {
        const agent = pod.agents.find((candidate) => candidate.nodeId === recordScope.seatId);
        if (agent) return agent.name;
      }
      return recordScope.seatId;
    }
    case "mission": return recordScope.missionId;
    case "slice": return recordScope.sliceId;
  }
}

function age(record: HealthRecord): string {
  const seconds = record.freshness.ageSeconds;
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}时`;
  return `${Math.floor(seconds / 86_400)}天`;
}

function evidenceSummary(record: HealthRecord): string {
  if (record.evidence.length === 0) return "无";
  const counts = new Map<string, number>();
  for (const evidence of record.evidence) counts.set(evidence.type, (counts.get(evidence.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => `${type}${count > 1 ? ` ×${count}` : ""}`).join(", ");
}

function scopedEmptyLabel(scope: HealthDisplayScope): string {
  return `空 — ${scope.kind === "rig" ? "工作组" : "席位"}`;
}

function unavailableLine(width: number, reason = "无法读取规范健康记录"): ContentLine {
  return fitLine([
    { text: "健康  ", token: "bright", bold: true },
    { text: "未知", token: "warn", bold: true },
    { text: ` · ${reason}`, token: "dim" },
  ], width);
}

function unavailableReason(snap: FleetSnapshot, scope: HealthDisplayScope): string | null {
  if (!scope.local) return "不可用 · 远程实例发现未服务";
  if (!snap.health) return "未评估 · 本视图尚未加载健康状态";
  if (snap.health.availability !== "loaded") return "不可用 · 无法读取规范健康记录";
  if (scope.kind === "seat" && scope.seatId === null) return "不可用 · 未服务稳定席位标识；发现无法定位";
  return null;
}

function emptyLine(scope: HealthDisplayScope, width: number): ContentLine {
  return fitLine([
    { text: "健康  ", token: "bright", bold: true },
    { text: scopedEmptyLabel(scope), token: "dim", bold: true },
    { text: " · 未服务发现；非健康验证", token: "dim" },
  ], width);
}

export function healthSummaryLine(snap: FleetSnapshot, scope: HealthDisplayScope, width: number): ContentLine {
  const unavailable = unavailableReason(snap, scope);
  if (unavailable) return unavailableLine(width, unavailable);
  const records = healthRecordsForScope(snap, scope);
  if (records.length === 0) return emptyLine(scope, width);
  const active = records.filter((record) => record.status === "active");
  const counts = {
    critical: active.filter((record) => record.severity === "critical").length,
    warning: active.filter((record) => record.severity === "warning").length,
    info: active.filter((record) => record.severity === "info").length,
  };
  const categories = new Map<string, number>();
  for (const record of active) categories.set(record.category, (categories.get(record.category) ?? 0) + 1);
  const categoryText = [...categories].sort(([a], [b]) => a.localeCompare(b, "en-US")).map(([name, count]) => `${name} ${count}`).join(" ");
  const indeterminate = records.filter((record) => record.status === "indeterminate").length;
  const top = records[0]!;
  const compact = width < 80;
  return fitLine([
    { text: "健康  ", token: "bright", bold: true },
    { text: compact ? "活跃 " : "活跃 · ", token: "bright", bold: true },
    { text: `严重 ${counts.critical}`, token: counts.critical ? "error" : "dim", bold: counts.critical > 0 },
    { text: `  警告 ${counts.warning}`, token: counts.warning ? "warn" : "dim", bold: counts.warning > 0 },
    ...(!compact ? [{ text: `  信息 ${counts.info}`, token: counts.info ? "info" as const : "dim" as const }] : []),
    ...(indeterminate > 0 ? [{ text: ` · 未知 ${indeterminate}`, token: "warn" as const, bold: true }] : []),
    ...(categoryText ? [{ text: ` · 按类型 ${categoryText}`, token: "bright" as const }] : []),
    { text: ` · ${stateLabel(top)} ${top.summary}`, token: tokenFor(top) },
    ...(snap.health?.truncated ? [{ text: " · 部分结果", token: "warn" as const, bold: true }] : []),
  ], width, { type: "tab", tab: "health" });
}

function healthColumnWidths(width: number) {
  const wide = width >= 100;
  const sevWidth = 13;
  const scopeWidth = wide ? 18 : 12;
  const ageWidth = wide ? 7 : 5;
  const confWidth = 6;
  const evidenceWidth = wide ? Math.min(22, Math.max(14, Math.floor(width * 0.24))) : 0;
  const fixed = sevWidth + scopeWidth + ageWidth + (wide ? confWidth + evidenceWidth + 5 : 3);
  const signalWidth = Math.max(12, width - fixed);
  return { wide, sevWidth, signalWidth, scopeWidth, ageWidth, confWidth, evidenceWidth };
}

function healthTableRow(record: HealthRecord, snap: FleetSnapshot, width: number): ContentLine {
  const { wide, sevWidth, signalWidth, scopeWidth, ageWidth, confWidth, evidenceWidth } = healthColumnWidths(width);
  const values = [
    cell({ critical: "严重", warning: "警告", info: "信息" }[record.severity] ?? record.severity.toUpperCase(), sevWidth),
    cell(signalLabel(record), signalWidth),
    cell(scopeName(record, snap), scopeWidth),
    cell(age(record), ageWidth),
    ...(wide ? [cell(record.confidence, confWidth), cell(evidenceSummary(record), evidenceWidth)] : []),
  ];
  const text = values.join(" ").trimEnd();
  return {
    text,
    segs: [{ text: values[0]!, token: tokenFor(record), bold: record.status === "active" }, { text: text.slice(values[0]!.length), token: "bright" }],
    action: { type: "health-open", findingId: record.id },
  };
}

export function healthListLines(snap: FleetSnapshot, scope: HealthDisplayScope, width: number): ContentLine[] {
  const unavailable = unavailableReason(snap, scope);
  if (unavailable) return wrapDetailLines([{ text: `健康  未知 · ${unavailable}` }], width);
  const records = healthRecordsForScope(snap, scope);
  // 包裹完整页面说明；紧凑摘要调用方仍保持单行。
  if (records.length === 0) return wrapDetailLines([emptyLine(scope, Infinity)], width);
  const { wide, sevWidth, signalWidth, scopeWidth, ageWidth, confWidth, evidenceWidth } = healthColumnWidths(width);
  const columns = [
    cell("级别", sevWidth),
    cell("信号", signalWidth),
    cell("范围", scopeWidth),
    cell("年龄", ageWidth),
    ...(wide ? [cell("置信", confWidth), cell("证据", evidenceWidth)] : []),
  ].join(" ").trimEnd();
  const heading = fitLine([{ text: columns, token: "dim", bold: true }], width);
  const lines: ContentLine[] = [sectionRule(`健康 · ${scope.kind} · 规范发现`, width), heading, { text: "─".repeat(Math.min(width, Math.max(1, strWidth(heading.text)))) }];
  lines.push(...records.map((record) => healthTableRow(record, snap, width)));
  if (snap.health?.truncated) lines.push(fitLine([{ text: "部分 · 后台服务结果已达上限", token: "warn", bold: true }], width));
  lines.push(fitLine([{ text: "回车打开解释和类型化证据 · Esc 返回", token: "dim" }], width));
  return lines;
}

function value(evidence: HealthEvidenceReference, key: string): string {
  const item = evidence[key];
  if (item === null || item === undefined) return "—";
  if (Array.isArray(item)) return item.join(", ");
  return String(item);
}

function evidenceText(evidence: HealthEvidenceReference): string {
  switch (evidence.type) {
    case "queue-transition": return `队列项 ${value(evidence, "qitemId")} · 转换 ${value(evidence, "transitionId")} · ${value(evidence, "state")} · 操作者 ${value(evidence, "actorSession")}`;
    case "watchdog-history": return `任务 ${value(evidence, "jobId")} · 历史 ${value(evidence, "historyId")} · ${value(evidence, "outcome")} · 投递 ${value(evidence, "deliveryStatus")}`;
    case "work-graph": return `${value(evidence, "nodeType")} ${value(evidence, "nodeId")} · 任务目标 ${value(evidence, "missionId")} · 阶段 ${value(evidence, "stage")} · 依赖 ${value(evidence, "dependsOn")}`;
    case "topology-activity": return `节点 ${value(evidence, "nodeId")} · 会话 ${value(evidence, "sessionName")} · 活动 ${value(evidence, "activity")} · 序号 ${value(evidence, "activitySequence")}`;
    case "context-usage": return `节点 ${value(evidence, "nodeId")} · 会话 ${value(evidence, "sessionId")} · 已用 ${value(evidence, "usedPercentage")}% · 可用 ${value(evidence, "available")} · 新鲜 ${value(evidence, "fresh")}`;
    case "occupant-model": return `节点 ${value(evidence, "nodeId")} · 代次 ${value(evidence, "occupantGeneration")} · 运行时 ${value(evidence, "runtime")} · 模型 ${value(evidence, "model")}`;
    case "lifecycle-receipt": return `回执 ${value(evidence, "receiptId")} · ${value(evidence, "operation")} · ${value(evidence, "outcome")}`;
  }
}

function wrap(label: string, text: string, width: number, token: Token = "bright"): ContentLine[] {
  const prefix = `  ${padEndW(`${label}:`, 12)} `;
  return wrapDetailLines([{ text: prefix + (text.trim() || "—") }], width).map((line, index) => ({
    ...line, segs: index === 0 && line.text.startsWith(prefix)
      ? [{ text: prefix, token: "dim" }, { text: line.text.slice(prefix.length), token }]
      : [{ text: line.text, token }],
  }));
}

export function healthDetailLines(snap: FleetSnapshot, findingId: string, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  const record = snap.health?.records.find((candidate) => candidate.id === findingId);
  if (!record) return [fitLine([{ text: `健康发现 ${findingId} 已不在有界规范读取中`, token: "warn" }], width)];
  const lines: ContentLine[] = [
    fitLine([{ text: `${stateLabel(record)}  `, token: tokenFor(record), bold: true }, { text: record.detector, token: "bright", bold: true }, { text: " · Esc 返回", token: "dim" }], width),
    { text: "" },
    sectionRule("信号", width),
    ...wrap("摘要", record.summary, width),
    ...wrap("评估", record.status === "indeterminate" || record.freshness.state !== "fresh" ? "未知" : record.status, width),
    ...(record.indeterminateReason ? wrap("原因", record.indeterminateReason, width, "warn") : []),
    ...wrap("发现 ID", record.id, width),
    ...wrap("范围", scopeName(record, snap), width),
    ...wrap("类别", record.category, width),
    ...wrap("严重度", record.severity, width, tokenFor(record)),
    ...wrap("状态", record.status, width),
    ...(record.ceremony ? wrap("诊断阶段", record.ceremony.stage, width) : []),
    ...wrap("置信度", record.confidence, width),
    ...wrap("新鲜度", `${record.freshness.state} · 来源时长 ${age(record)}`, width),
    ...wrap("开始于", displayTime(record.startedAt, timeZone), width),
    ...wrap("观察于", displayTime(record.lastObservedAt, timeZone), width),
    { text: "" },
    sectionRule("说明", width),
    ...wrap("原因", record.explanation, width),
    ...wrap("阈值", record.threshold, width),
    ...wrap("策略", record.policyVersion ?? "源未报告", width),
    ...(record.operatingPosture ? [
      ...wrap("姿态", `${record.operatingPosture.posture} · ${record.operatingPosture.source}${record.operatingPosture.binding ? " · " + record.operatingPosture.binding.id : ""}`, width),
      ...wrap("工作阶段", `${record.operatingPosture.context?.phase.value ?? "未知"} · ${record.operatingPosture.context?.phase.source ?? "不可用"}`, width),
      ...wrap("监督", record.operatingPosture.reason, width),
    ] : []),
    ...wrap("检查建议", record.suggestedInspection, width),
    ...(record.indeterminateReason ? wrap("未知原因", record.indeterminateReason, width, "warn") : []),
    { text: "" },
    sectionRule(`证据 · ${record.evidence.length}`, width),
  ];
  if (record.ceremony) {
    for (const ref of record.ceremony.context) lines.push(...wrap("常规上下文", `${ref.role}: ${ref.path} (${ref.state}${ref.sha256 ? ` sha256:${ref.sha256}` : ""})`, width));
    lines.push(...wrap("评估依据", record.ceremony.basis, width));
  }
  if (record.evidence.length === 0) lines.push(...wrap("证据", "未提供", width, "warn"));
  for (const evidence of record.evidence) {
    lines.push(...wrap(evidence.type, evidenceText(evidence), width));
    lines.push(...wrap("观察于", displayTime(evidence.observedAt, timeZone), width, evidence.observedAt ? "dim" : "warn"));
  }
  return lines;
}

export function healthAgentLines(snap: FleetSnapshot, scope: Extract<HealthDisplayScope, { kind: "seat" }>, width: number): ContentLine[] {
  const unavailable = unavailableReason(snap, scope);
  if (unavailable) return [unavailableLine(width, unavailable)];
  const records = healthRecordsForScope(snap, scope);
  if (records.length === 0) return [emptyLine(scope, width)];
  return records.map((record) => fitLine([
    { text: `${padEndW(stateLabel(record), 13)} `, token: tokenFor(record), bold: record.status === "active" },
    { text: record.summary, token: "bright" },
  ], width, { type: "health-open", findingId: record.id }));
}
