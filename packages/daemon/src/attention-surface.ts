/** 对 queue、原生 proof 判断与 canonical health 的被动投影。 */
export interface AttentionItem {
  id: string;
  kind: "action" | "update";
  summary: string;
  unblocks: string | null;
  urgency: string;
  at: string | null;
  scope: string;
  project: { id: string; root: string } | null;
  source: string;
  recipient?: string | null;
}
export interface AttentionDetail {
  item: AttentionItem;
  lines: string[];
  files: Array<{ label: string; path: string }>;
}
export interface AttentionRead {
  scope: "instance";
  readAt: string;
  items: AttentionItem[];
  sources: Array<{ source: string; state: "available" | "unavailable" | "partial"; detail: string }>;
  detail: AttentionDetail | null;
  detailError: string | null;
}

// 消费方必须使用与 queue 选择相同的词法人工分类。
export { isHumanSeatSessionRef } from "./domain/session-name.js";
