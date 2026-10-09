import type { AttentionRead, AttentionItem } from "@openrig/daemon/attention";
import type { FleetSnapshot, ViewState } from "../types.js";
import { listItem, wrapDetailLines, type ContentLine } from "../detail.js";

/** S02 提供的有界、确认投递投影；客户端不做分类。 */
export interface DeliveredHumanUpdates {
  items: Array<{ qitemId: string; summary: string | null; body: string; humanDetail: string | null;
    destinationSession: string; sourceSession: string; tags: string[] | null; evidenceRef: string | null;
    deliveredAt: string; deliveryReceipt: string }>;
  limit: number;
  truncated: boolean;
}

const ATTENTION_SOURCE_LABELS: Record<string, string> = {
  queue: "队列",
  health: "健康状态",
  "outcomes and health": "结果与健康状态",
  "delivered updates": "已投递更新",
  "mission outcomes": "任务结果",
  "project catalog": "项目目录",
};

function attentionSourceLabel(source: string): string {
  return ATTENTION_SOURCE_LABELS[source] ?? source;
}

function attentionSourceStateLabel(state: string): string {
  return ({ available: "可用", unavailable: "不可用", partial: "部分可用" } as Record<string, string>)[state] ?? state;
}

export function composeHumanUpdates(attention: AttentionRead | null, updates: DeliveredHumanUpdates | null, wanted?: string | null): AttentionRead | null {
  if (!attention && !updates) return null;
  const read: AttentionRead = attention ? { ...attention, items: [...attention.items], sources: [...attention.sources] } : {
    scope: "instance", readAt: new Date().toISOString(), items: [], detail: null, detailError: null,
    sources: [{ source: "queue", state: "unavailable", detail: "人类请求尚未应答。" }, { source: "outcomes and health", state: "unavailable", detail: "待关注来源不可用。" }],
  };
  read.sources.push({ source: "delivered updates", state: !updates ? "unavailable" : updates.truncated ? "partial" : "available",
    detail: updates ? `最新 ${updates.limit} 条确认投递的更新；保留回执窗口${updates.truncated ? "，更多已省略" : ""}。` : "已送达更新尚未应答。" });
  for (const q of updates?.items ?? []) {
    const projects = [...new Set((q.tags ?? []).filter(t => t.startsWith("project:")).map(t => t.slice(8)))];
    const item: AttentionItem = { id: `human-update:${q.qitemId}`, kind: "update", summary: q.summary || q.body.trim().split(/\r?\n/).find(Boolean) || "已投递更新",
      recipient: q.destinationSession, urgency: "update", unblocks: null, at: q.deliveredAt,
      scope: projects.length === 1 ? `项目 ${projects[0]}（队列标签）` : "实例 · 项目未知", project: null,
      source: `/api/queue/${encodeURIComponent(q.qitemId)}` };
    read.items.push(item);
    if (wanted === item.id) {
      read.detailError = null;
      read.detail = { item, lines: [q.body, ...(q.humanDetail ? ["补充详情：", q.humanDetail] : []),
        `来自：${q.sourceSession}`, `投递时间：${q.deliveredAt}`, `投递回执：${q.deliveryReceipt}`, `队列：${q.qitemId}`, `证据：${q.evidenceRef ?? "无记录"}`],
        files: q.evidenceRef?.startsWith("/") ? [{ label: "更新证据", path: q.evidenceRef }] : [] };
    }
  }
  read.items.sort((a, b) => a.kind.localeCompare(b.kind) || (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
  if (wanted?.startsWith("human-update:") && read.detail?.item.id !== wanted) {
    read.detail = null;
    read.detailError = "所选已投递更新不可用或超出保留窗口。返回 Feed 并刷新。";
  }
  return read;
}

export function attentionLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const read = snap.attentionRead;
  const lines: ContentLine[] = [{ text: "待关注 · 实例 / 全部人类" }];
  if (!read) return wrapDetailLines([...lines, { text: "不可用: 待关注源尚未应答。" }, ...snap.readErrors.map(text => ({ text }))], width);
  if (state.attentionOpen) {
    const d = read.detail;
    lines.push(listItem("返回", { type: "back" }));
    if (!d || d.item.id !== state.attentionOpen) lines.push({ text: read.detailError ?? "所选来源不可用。" });
    else {
      const title = read.items.some(i => i.id === d.item.id) ? d.item.kind === "action" ? "人类请求" : "更新" : "来源记录";
      lines.push({ text: `${title} · ${d.item.urgency}` }, { text: d.item.summary });
      if (d.item.recipient) lines.push({ text: `收件人：${d.item.recipient}` });
      if (d.item.id.startsWith("human-update:")) lines.push({ text: "无需操作" });
      if (d.item.unblocks) lines.push({ text: `解除阻塞：${d.item.unblocks}` });
      lines.push({ text: `范围：${d.item.scope}` }, { text: `观察时间：${d.item.at ?? "未知"}` });
      lines.push(...d.lines.map(text => ({ text })));
      for (const f of d.files) lines.push(listItem(f.label, { type: "attention-source", path: f.path }));
      lines.push({ text: `来源：${d.item.source}` });
    }
  } else {
    const bad = read.sources.filter(s => s.state !== "available");
    if (bad.length) lines.push({ text: "部分来源不可用或不完整；此待关注列表不完整。" });
    for (const [kind, title] of [["action", "人类请求"], ["update", "更新"]] as const) {
      if (state.attentionCategory && state.attentionCategory !== kind) continue;
      lines.push({ text: "" }, { text: title });
      const items = read.items.filter(i => i.kind === kind && (!state.filter || `${i.summary} ${i.scope}`.toLowerCase().includes(state.filter.toLowerCase())));
      if (!items.length) lines.push({ text: state.filter ? "  已服务项中无匹配。" : bad.some(s => kind === "action" ? s.source === "queue" : s.source !== "queue") ? "  未知：必需来源不可用或不完整。" : "  可用来源窗口中无当前项。" });
      for (const i of items) {
        lines.push(listItem(`[${i.urgency}] ${i.summary}`, { type: "attention-open", id: i.id }));
        if (i.recipient) lines.push({ text: `    收件人：${i.recipient}` });
        if (i.id.startsWith("human-update:")) lines.push({ text: "    无需操作" });
        if (i.unblocks) lines.push({ text: `    解除阻塞：${i.unblocks}` });
        lines.push({ text: `    ${i.scope} · ${i.at ?? "时间未知"}` });
      }
    }
    lines.push({ text: "" }, { text: `读取于 ${read.readAt}` }, ...read.sources.map(s => ({ text: `${attentionSourceLabel(s.source)}：${attentionSourceStateLabel(s.state)} · ${s.detail}` })));
  }
  lines.push({ text: "" }, { text: "查看不等于批准。必需的 Slack 决策仍然适用。" });
  return wrapDetailLines(lines, width);
}
