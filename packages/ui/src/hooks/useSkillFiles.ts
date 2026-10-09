// Slice 28 Checkpoint C-4 —— 技能文档浏览器的文件 hooks。
//
// 封装新增的后台服务端点（SC-29 EXCEPTION #11 累计）：
//   GET /api/skills/:id/files/list?path=<rel>  → useSkillFilesList
//   GET /api/skills/:id/files/read?path=<rel>  → useSkillFilesRead
//
// 与 usePluginFiles 对称（slice 28 C-1）。技能的绝对路径由后台服务内部解析；
// 界面只传技能 id + 技能文件夹内可选的相对路径。

import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "./useFiles.js";

export interface SkillFilesListResponse {
  skillId: string;
  path: string;
  entries: FileEntry[];
}

export interface SkillFilesReadResponse {
  skillId: string;
  path: string;
  absolutePath: string;
  content: string;
  mtime: string;
  contentHash: string;
  size: number;
  truncated?: boolean;
  truncatedAtBytes?: number | null;
  totalBytes?: number;
}

async function fetchList(skillId: string, path: string): Promise<SkillFilesListResponse> {
  const res = await fetch(
    `/api/skills/${encodeURIComponent(skillId)}/files/list?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SkillFilesListResponse;
}

async function fetchRead(skillId: string, path: string): Promise<SkillFilesReadResponse> {
  const res = await fetch(
    `/api/skills/${encodeURIComponent(skillId)}/files/read?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SkillFilesReadResponse;
}

export function useSkillFilesList(skillId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["skill-files", "list", skillId, path],
    queryFn: () => fetchList(skillId!, path ?? ""),
    enabled: !!skillId,
    staleTime: 15_000,
  });
}

export function useSkillFilesRead(skillId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["skill-files", "read", skillId, path],
    queryFn: () => fetchRead(skillId!, path!),
    enabled: !!skillId && !!path,
    staleTime: 15_000,
  });
}
