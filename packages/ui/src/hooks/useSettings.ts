// User Settings v0——后台服务 /api/config 路由的 UI 钩子。
//
// 由系统抽屉的“设置”标签页使用。它不经 CLI shell 调用，因为 CLI 仍是智能体编辑的
// 规范路径，而 UI 直接通过后台服务 HTTP 路由读写设置。

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type SettingSource = "env" | "file" | "default";

export interface ResolvedSetting {
  value: string | number | boolean;
  source: SettingSource;
  defaultValue: string | number | boolean;
}

export type SettingsKey =
  | "daemon.port" | "daemon.host" | "db.path"
  | "transcripts.enabled" | "transcripts.path"
  | "workspace.root" | "workspace.slices_root" | "workspace.steering_path"
  | "workspace.specs_root" | "workspace.projects_root" | "workspace.catalog_path"
  | "files.allowlist" | "progress.scan_roots"
  // Preview Terminal v0（PL-018）键。
  | "ui.preview.refresh_interval_seconds"
  | "ui.preview.max_pins"
  | "ui.preview.default_lines"
  // OPR.0.4.0.1——同时在线终端的全局上限（默认 2）。
  | "ui.terminal.max_live_terminals"
  // V1 阶段 4 ConfigStore 白名单例外（顾问/操作员席位）。
  | "agents.advisor_session" | "agents.operator_session"
  // V1 阶段 5 P5-3 ConfigStore 白名单例外（“为你推荐”feed 订阅开关，见
  // for-you-feed.md 第 144–151 行）。与阶段 4 使用同一 SC-29 例外范围：只扩充白名单，
  // 不新增 schema 迁移、端点或事件类型。
  | "feed.subscriptions.action_required"
  | "feed.subscriptions.approvals"
  | "feed.subscriptions.shipped"
  | "feed.subscriptions.progress"
  | "feed.subscriptions.audit_log"
  // Slice 27——Claude 自动压缩策略键（SC-29 EXCEPTION #10）。
  | "policies.claude_compaction.enabled"
  | "policies.claude_compaction.threshold_percent"
  | "policies.claude_compaction.pre_compact_instruction"
  | "policies.claude_compaction.compact_instruction"
  | "policies.claude_compaction.message_inline"
  | "policies.claude_compaction.message_file_path"
  | "policies.claude_compaction.post_restore_audit_instruction"
  // OPR.0.4.4.15（G15-P1）——唯一注册的动态键类别：逐主机 feed 订阅。v1 的逐主机键集合
  // 封闭为 {enabled}；hostId 段为 [A-Za-z0-9_-]+，保留开关名由后台服务侧排除。
  | `feed.subscriptions.${string}.enabled`;

export interface SettingsResponse {
  settings: Record<SettingsKey, ResolvedSetting>;
  /** OPR.0.4.4.15——增量动态类别枚举：持久化的逐主机 feed 订阅。旧于此 slice 的后台服务
   *  不提供该字段，因此按防御性可选字段处理。 */
  feedHostSubscriptions?: Array<{ hostId: string; enabled: boolean }>;
}

async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/config");
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings", "all"],
    queryFn: fetchSettings,
    staleTime: 0,
  });
}

export function useSetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { key: SettingsKey; value: string }) => {
      const res = await fetch(`/api/config/${encodeURIComponent(input.key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: input.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: boolean; resolved: ResolvedSetting }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useResetSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: SettingsKey) => {
      const res = await fetch(`/api/config/${encodeURIComponent(key)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: boolean; resolved: ResolvedSetting }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export interface InitWorkspaceResponse {
  root: string;
  rootCreated: boolean;
  subdirs: Array<{ name: string; path: string; created: boolean }>;
  files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }>;
  dryRun: boolean;
}

export function useInitWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { root?: string; force?: boolean; dryRun?: boolean }) => {
      const res = await fetch("/api/config/init-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<InitWorkspaceResponse>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
