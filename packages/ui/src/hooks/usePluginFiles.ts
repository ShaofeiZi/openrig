// Slice 28 Checkpoint C-2 —— 插件文档浏览器的文件 hooks。
//
// 封装 Checkpoint C-1 新增的后台服务端点（SC-29 EXCEPTION #11）：
//   GET /api/plugins/:id/files/list?path=<rel>  → usePluginFilesList
//   GET /api/plugins/:id/files/read?path=<rel>  → usePluginFilesRead
//
// 与 useFilesList / useFilesRead 同为 react-query 形态，但后台服务返回的是
// 限定到单个插件的响应对象（无白名单根概念）。插件不在操作者的
// OPENRIG_FILES_ALLOWLIST 之内，所以这是 v0 下浏览插件文件夹内容的唯一途径。

import { useQuery } from "@tanstack/react-query";
import type { FileEntry } from "./useFiles.js";

export interface PluginFilesListResponse {
  pluginId: string;
  path: string;
  entries: FileEntry[];
}

export interface PluginFilesReadResponse {
  pluginId: string;
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

async function fetchList(pluginId: string, path: string): Promise<PluginFilesListResponse> {
  const res = await fetch(
    `/api/plugins/${encodeURIComponent(pluginId)}/files/list?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PluginFilesListResponse;
}

async function fetchRead(pluginId: string, path: string): Promise<PluginFilesReadResponse> {
  const res = await fetch(
    `/api/plugins/${encodeURIComponent(pluginId)}/files/read?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as PluginFilesReadResponse;
}

export function usePluginFilesList(pluginId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["plugin-files", "list", pluginId, path],
    queryFn: () => fetchList(pluginId!, path ?? ""),
    enabled: !!pluginId,
    staleTime: 15_000,
  });
}

export function usePluginFilesRead(pluginId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["plugin-files", "read", pluginId, path],
    queryFn: () => fetchRead(pluginId!, path!),
    enabled: !!pluginId && !!path,
    staleTime: 15_000,
  });
}
