// PL-007 Workspace Primitive v0——类型化工作区块的 UI 钩子。
//
// 当工作组声明工作区时，呈现 /api/whoami 的 `workspace` 字段，使消费表面
//（文件、进度、Slices、规范、引导）无需重新推导拓扑即可渲染工作区类型标签。
//
// 下列情况下 workspace 块为 null：
//   - 后台服务的 rigs 行没有 workspace_json（旧版工作组）
//   - 后台服务早于 PL-007（跨 CLI 版本漂移；UI 优雅降级，各表面直接跳过徽章列）
//
// 防御要求：每个消费者迭代 `repos[]` 前都必须用 Array.isArray 守卫，使跨 CLI 版本漂移
// 能够优雅降级。
//
// 注意：/api/whoami 要求 nodeId 或 sessionName 查询参数。没有节点身份的 UI 会话
//（浏览器标签页未绑定托管席位）无法获取 workspace 块；消费者应把 null 视为
// “不显示徽章”，而不是错误。

import { useQuery } from "@tanstack/react-query";
import type { WorkspaceKindLabel } from "../components/WorkspaceKindBadge.js";

export interface WhoamiWorkspaceUI {
  workspaceRoot: string;
  activeRepo: string | null;
  repos: Array<{ name: string; path: string; kind: WorkspaceKindLabel }>;
  knowledgeRoot: string | null;
  knowledgeKind: WorkspaceKindLabel | null;
}

interface WhoamiSnapshot {
  workspace?: WhoamiWorkspaceUI | null;
}

async function fetchWorkspace(): Promise<WhoamiWorkspaceUI | null> {
  // UI 通过席位上下文查询打开时，优先尝试 URL 中的 sessionName；否则回退到通用的
  // 任意会话尝试，存在歧义时返回 null。v0 的 UI 工作区采用尽力而为策略。
  const url = new URL(window.location.href);
  const sessionName = url.searchParams.get("session");
  const params = new URLSearchParams();
  if (sessionName) params.set("sessionName", sessionName);
  // 没有标识符时后台服务返回 400；此处优雅降级为 null。
  if (params.toString() === "") return null;
  const res = await fetch(`/api/whoami?${params.toString()}`);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null) as WhoamiSnapshot | null;
  if (!body || typeof body !== "object") return null;
  const ws = body.workspace;
  if (!ws || typeof ws !== "object") return null;
  // 使用防御性 Array.isArray 守卫处理跨 CLI 漂移。
  if (!Array.isArray(ws.repos)) {
    return { ...ws, repos: [] };
  }
  return ws;
}

export function useWorkspace() {
  return useQuery({
    queryKey: ["workspace", "whoami"],
    queryFn: fetchWorkspace,
    staleTime: 60_000,
  });
}
