// Fork 原语 + Starter 智能体镜像 v0（PL-016）—— agent_images 库 + 预览 + 生命周期动词的 UI hooks。
// 形状对齐 useContextPackLibrary（PL-014）。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface AgentImageEntry {
  id: string;
  kind: "agent-image";
  name: string;
  version: string;
  runtime: "claude-code" | "codex";
  sourceSeat: string;
  sourceSessionId: string;
  /** 快照时刻源席位的 cwd。manifest 早于 source_cwd 支持时为 null（向后兼容）。
   *  “用作 starter”片段在该值非空时输出 `cwd: <sourceCwd>`。 */
  sourceCwd: string | null;
  notes: string | null;
  createdAt: string;
  sourceType: "user_file" | "workspace" | "builtin";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: Array<{
    path: string;
    role: string;
    summary: string | null;
    absolutePath: string | null;
    bytes: number | null;
    estimatedTokens: number | null;
  }>;
  /** 线上始终为 "(redacted)"——UI 从不见真实令牌。 */
  sourceResumeToken: string;
  stats: {
    forkCount: number;
    lastUsedAt: string | null;
    estimatedSizeBytes: number;
    lineage: string[];
  };
  lineage: string[];
  pinned: boolean;
}

export interface AgentImagePreview {
  id: string;
  name: string;
  version: string;
  runtime: "claude-code" | "codex";
  sourceSeat: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  stats: AgentImageEntry["stats"];
  lineage: string[];
  pinned: boolean;
  notes: string | null;
  files: AgentImageEntry["files"];
  starterSnippet: string;
}

async function fetchAgentImages(): Promise<AgentImageEntry[]> {
  const res = await fetch("/api/agent-images/library");
  if (!res.ok) {
    if (res.status === 503) return [];
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  return Array.isArray(body) ? body : [];
}

export function useAgentImageLibrary() {
  return useQuery({
    queryKey: ["agent-images", "library"],
    queryFn: fetchAgentImages,
    staleTime: 30_000,
  });
}

async function fetchAgentImagePreview(id: string): Promise<AgentImagePreview> {
  const res = await fetch(`/api/agent-images/library/${encodeURIComponent(id)}/preview`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useAgentImagePreview(id: string | null) {
  return useQuery({
    queryKey: ["agent-images", "preview", id],
    queryFn: () => fetchAgentImagePreview(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useAgentImagePin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; pin: boolean }) => {
      const verb = input.pin ? "pin" : "unpin";
      const res = await fetch(`/api/agent-images/library/${encodeURIComponent(input.id)}/${verb}`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ ok: boolean; pinned: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-images"] });
    },
  });
}
