// Rig Context / 可组合上下文注入 v0（PL-014）——面向 context_packs 库 + 评审 + 发送的界面 hooks。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface ContextPackEntryFile {
  path: string;
  role: string;
  summary: string | null;
  absolutePath: string | null;
  bytes: number | null;
  estimatedTokens: number | null;
}

export interface ContextPackEntry {
  id: string;
  kind: "context-pack";
  name: string;
  version: string;
  purpose: string | null;
  sourceType: "builtin" | "user_file" | "workspace";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: ContextPackEntryFile[];
}

export interface ContextPackPreview {
  id: string;
  name: string;
  version: string;
  bundleText: string;
  bundleBytes: number;
  estimatedTokens: number;
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  missingFiles: Array<{ path: string; role: string }>;
}

async function fetchContextPacks(): Promise<ContextPackEntry[]> {
  const res = await fetch("/api/context-packs/library");
  if (!res.ok) {
    if (res.status === 503) return []; // 库未配置时的诚实兜底
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  // 跨 CLI 版本漂移防护：未提供该路由的旧后台服务可能返回 200 但带一个非数组占位。
  // 兜底为空数组，而不是让消费方 .map() 时抛异常。
  return Array.isArray(body) ? body : [];
}

export function useContextPackLibrary() {
  return useQuery({
    queryKey: ["context-packs", "library"],
    queryFn: fetchContextPacks,
    staleTime: 30_000,
  });
}

// Slice-03 Atom 5：预览按 context-pack 类路径 ref 寻址。
async function fetchContextPackPreview(ref: string): Promise<ContextPackPreview> {
  const res = await fetch(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent(ref)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useContextPackPreview(ref: string | null) {
  return useQuery({
    queryKey: ["context-packs", "preview", ref],
    queryFn: () => fetchContextPackPreview(ref!),
    enabled: !!ref,
    staleTime: 30_000,
  });
}

export function useContextPackSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/context-packs/library/sync", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ count: number; entries: ContextPackEntry[] }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["context-packs"] });
    },
  });
}
