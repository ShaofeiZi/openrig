// 阶段 3a slice 3.3——插件发现 API 的 UI 客户端。
//
// 将 GET /api/plugins、GET /api/plugins/:id、GET /api/plugins/:id/used-by
// 包装成 @tanstack/react-query 钩子，供资源库浏览器（插件类别）、PluginDetailPage 和
// AgentSpec 插件分区使用。
//
// 类型镜像 packages/daemon/src/domain/plugin-discovery-service.ts 中后台服务的
// PluginEntry / PluginDetail / AgentReference 结构。v0 两端保持同步；后台服务结构演进时，
// 必须同时更新两端。

import { useQuery } from "@tanstack/react-query";

export type PluginRuntime = "claude" | "codex";
export type PluginSourceKind = "vendored" | "claude-cache" | "codex-cache";

export interface PluginEntry {
  id: string;
  name: string;
  version: string;
  description: string | null;
  source: PluginSourceKind;
  sourceLabel: string;
  runtimes: PluginRuntime[];
  path: string;
  lastSeenAt: string | null;
  /** Slice 28——<plugin>/skills/ 下的子目录数。由后台服务 detectPlugin 通过读取 skills/
   *  目录填充（SC-29 EXCEPTION #11）。 */
  skillCount: number;
}

export interface PluginManifestSummary {
  raw: Record<string, unknown>;
  name: string | null;
  version: string | null;
  description: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
}

export interface PluginSkillSummary {
  name: string;
  relativePath: string;
}

export interface PluginHookSummary {
  runtime: PluginRuntime;
  relativePath: string;
  events: string[];
}

// Slice 3.3 修复 A——MCP server 摘要镜像后台服务结构。
export interface PluginMcpServerSummary {
  runtime: PluginRuntime;
  name: string;
  command: string | null;
  transport: string | null;
}

export interface PluginDetail {
  entry: PluginEntry;
  claudeManifest: PluginManifestSummary | null;
  codexManifest: PluginManifestSummary | null;
  skills: PluginSkillSummary[];
  hooks: PluginHookSummary[];
  /** Slice 3.3 修复 A——manifest 中声明的 MCP servers。 */
  mcpServers: PluginMcpServerSummary[];
}

export interface PluginAgentReference {
  agentName: string;
  sourcePath: string;
  profiles: string[];
}

export interface UsePluginsOpts {
  runtime?: PluginRuntime;
  source?: PluginSourceKind;
}

function buildListUrl(opts: UsePluginsOpts | undefined): string {
  const params = new URLSearchParams();
  if (opts?.runtime) params.append("runtime", opts.runtime);
  if (opts?.source) params.append("source", opts.source);
  const qs = params.toString();
  return qs.length === 0 ? "/api/plugins" : `/api/plugins?${qs}`;
}

async function fetchPlugins(opts: UsePluginsOpts | undefined): Promise<PluginEntry[]> {
  const res = await fetch(buildListUrl(opts));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PluginEntry[]>;
}

async function fetchPlugin(id: string): Promise<PluginDetail> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PluginDetail>;
}

async function fetchPluginUsedBy(id: string): Promise<PluginAgentReference[]> {
  const res = await fetch(`/api/plugins/${encodeURIComponent(id)}/used-by`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PluginAgentReference[]>;
}

export function usePlugins(opts: UsePluginsOpts = {}) {
  return useQuery<PluginEntry[]>({
    queryKey: ["plugins", "list", opts.runtime ?? "all", opts.source ?? "all"],
    queryFn: () => fetchPlugins(opts),
    staleTime: 30_000,
  });
}

export function usePlugin(id: string | null) {
  return useQuery<PluginDetail>({
    queryKey: ["plugins", "detail", id],
    queryFn: () => fetchPlugin(id!),
    enabled: id !== null,
    staleTime: 30_000,
  });
}

export function usePluginUsedBy(id: string | null) {
  return useQuery<PluginAgentReference[]>({
    queryKey: ["plugins", "used-by", id],
    queryFn: () => fetchPluginUsedBy(id!),
    enabled: id !== null,
    staleTime: 30_000,
  });
}
