// UI 增强包 v0 —— 进度浏览 hook。
//
// 封装 GET /api/progress/tree。把后台服务的
// "progress_scan_roots_not_configured" 503 路径以结构化的 `unavailable` 哨兵暴露，
// 以便界面能渲染出设置提示。

import { useQuery } from "@tanstack/react-query";

export type CheckboxStatus = "active" | "done" | "blocked" | "unknown";

export interface ProgressRow {
  line: number;
  depth: number;
  status: CheckboxStatus;
  text: string;
  kind: "checkbox" | "heading";
}

export interface ProgressFileNode {
  rootName: string;
  relPath: string;
  absolutePath: string;
  mtime: string;
  rows: ProgressRow[];
  title: string | null;
  counts: { total: number; done: number; blocked: number; active: number };
}

export interface ProgressTreeResult {
  files: ProgressFileNode[];
  aggregate: { totalFiles: number; totalRows: number; totalDone: number; totalBlocked: number; totalActive: number };
  scannedRoots: Array<{ name: string; canonicalPath: string }>;
}

export interface ProgressUnavailable {
  unavailable: true;
  error: string;
  hint?: string;
}

async function fetchProgressTree(): Promise<ProgressTreeResult | ProgressUnavailable> {
  const res = await fetch("/api/progress/tree");
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as Partial<ProgressUnavailable> & { error?: string; hint?: string };
    return { unavailable: true, error: body.error ?? "progress_indexer_unavailable", hint: body.hint };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ProgressTreeResult;
}

export function useProgressTree() {
  return useQuery({
    queryKey: ["progress", "tree"],
    queryFn: fetchProgressTree,
    staleTime: 30_000,
  });
}
