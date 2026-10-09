import { useEffect, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  subscribeTopologyEvents,
  subscribeTopologyEventStatus,
  type TopologyEvent,
} from "../lib/topology-events.js";

export const MAX_ACTIVITY_EVENTS = 100;

export interface ActivityEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  receivedAt: number; // Date.now() when received
}

export interface UseActivityFeedResult {
  events: ActivityEvent[];
  connected: boolean;
  feedOpen: boolean;
  setFeedOpen: (open: boolean) => void;
}

export function useActivityFeed(): UseActivityFeedResult {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [feedOpen, setFeedOpen] = useState(false);

  const addEvent = useCallback((parsed: TopologyEvent) => {
    const event: ActivityEvent = {
      seq: typeof parsed["seq"] === "number" ? parsed["seq"] : Date.now(),
      type: (parsed["type"] as string) ?? "unknown",
      payload: parsed,
      createdAt: (parsed["createdAt"] as string) ?? new Date().toISOString(),
      receivedAt: Date.now(),
    };
    setEvents((prev) => [event, ...prev].slice(0, MAX_ACTIVITY_EVENTS));

    // 收到包变更事件时，使包查询失效。
    if (event.type === "package.installed" || event.type === "package.rolledback") {
      queryClient.invalidateQueries({ queryKey: ["packages"] });
    }
    // slice-04：bootstrap.completed/partial 对 ps 与 default-summary 的失效处理现由
    // useGlobalEvents 负责（150 毫秒合并）；ActivityFeed 不再触发。
    if (event.type === "session.discovered" || event.type === "session.vanished") {
      queryClient.invalidateQueries({ queryKey: ["discovery"] });
    }
    if (event.type === "mission_control.action_executed") {
      queryClient.invalidateQueries({ queryKey: ["mission-control", "audit"] });
      queryClient.invalidateQueries({ queryKey: ["slices"] });
      const qitemId = event.payload["qitemId"] as string | undefined;
      if (qitemId) {
        queryClient.invalidateQueries({ queryKey: ["queue", "item", qitemId] });
      }
    }
    if (event.type === "node.claimed") {
      queryClient.invalidateQueries({ queryKey: ["discovery"] });
      const rigId = event.payload["rigId"] as string | undefined;
      if (rigId) {
        queryClient.invalidateQueries({ queryKey: ["rig", rigId, "graph"] });
        queryClient.invalidateQueries({ queryKey: ["rig", rigId, "nodes"] });
        queryClient.invalidateQueries({ queryKey: ["rig", rigId, "sessions"] });
        // slice-04：ps 与 default-summary 现由 useGlobalEvents 合并处理。
      }
    }

    if (event.type === "session.detached") {
      queryClient.invalidateQueries({ queryKey: ["discovery"] });
    }

    if (
      event.type === "session.detached"
      || event.type === "node.removed"
      || event.type === "pod.deleted"
      || event.type === "rig.expanded"
      || event.type === "restore.completed"
      || event.type === "rig.deleted"
    ) {
      const rigId = event.payload["rigId"] as string | undefined;
      if (rigId) {
        queryClient.invalidateQueries({ queryKey: ["rig", rigId, "graph"] });
        queryClient.invalidateQueries({ queryKey: ["rig", rigId, "nodes"] });
        queryClient.invalidateQueries({ queryKey: ["rig", rigId, "sessions"] });
      }
      // slice-04：ps 与 default-summary 现由 useGlobalEvents 合并处理。
    }

    // OPR.0.3.2.20——无需硬刷新即可让“为你推荐”的待关注表面保持实时。任何
    // queue/qitem/inbox 事件都可能改变开放待关注集合（在人类门禁层创建条目、目标路由到
    // 人类席位、条目被认领/关闭/拒绝、添加回退路由、关闭超时）。让持久查询失效，
    // 以便 useAttentionItems 重新获取，并在同一浏览器会话内更新透镜。
    //
    // QA BLOCKING-A qitem-20260518195533：待关注 API 已立即返回新建 qitem，但开放的
    // 审批透镜必须硬刷新后才显示，因为 queue.created 未使 react-query 缓存失效。
    //
    // 字符串匹配模式与 feed-classifier 的 isQueueVisibilityEvent + closed-state 分支一致。
    // 按前缀宽匹配意味着未来新增事件类型（如 `qitem.escalated`）时无需改代码即可自动失效。
    if (
      event.type.startsWith("queue.")
      || event.type.startsWith("qitem.")
      || event.type.startsWith("inbox.")
    ) {
      queryClient.invalidateQueries({ queryKey: ["attention-items"] });
      const qitemId = (event.payload["qitemId"] as string | undefined)
        ?? (event.payload["qitem_id"] as string | undefined);
      if (qitemId) {
        // 已获取的详情（useQueueItem*）也要失效，使完成数据填充的 FeedCard 同步新状态。
        queryClient.invalidateQueries({ queryKey: ["queue", "item", qitemId] });
      }
    }
  }, [queryClient]);

  useEffect(() => {
    const unsubscribeEvents = subscribeTopologyEvents((event) => addEvent(event));
    const unsubscribeStatus = subscribeTopologyEventStatus((status) => {
      setConnected(status.connected);
    });

    return () => {
      unsubscribeEvents();
      unsubscribeStatus();
    };
  }, [addEvent]);

  return { events, connected, feedOpen, setFeedOpen };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function tailId(value: unknown, length = 6): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(-length);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function formatLogTime(timestamp: string | number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "??:??:??";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 将事件类型映射为状态圆点的 CSS 颜色类。 */
export function eventColor(type: string): string {
  if (type === "bundle.created") return "bg-accent";
  if (type.startsWith("bootstrap.")) return "bg-accent";
  if (type.startsWith("package.")) return "bg-primary";
  if (type.startsWith("rig.")) return "bg-accent";
  if (type.startsWith("snapshot.")) return "bg-primary";
  if (type.startsWith("restore.")) return "bg-warning";
  if (type === "chat.message") return "bg-primary";
  if (type === "node.startup_ready") return "bg-green-500";
  if (type === "node.startup_pending") return "bg-amber-400";
  if (type === "node.startup_failed") return "bg-destructive";
  if (type === "session.detached") return "bg-destructive";
  if (type === "session.discovered") return "bg-accent";
  if (type === "session.vanished") return "bg-destructive";
  if (type === "node.claimed") return "bg-primary";
  if (type === "node.launched") return "bg-primary";
  return "bg-foreground-muted-on-dark";
}

/** 将事件映射为单行摘要文本。 */
export function eventSummary(event: ActivityEvent): string {
  const p = event.payload;
  const rigTail = tailId(p["rigId"]);
  const snapTail = tailId(p["snapshotId"]);
  const installTail = tailId(p["installId"]);
  const nodeTail = tailId(p["nodeId"]);
  const logicalId = normalizeText(p["logicalId"]);
  const sender = normalizeText(p["sender"]);
  const body = normalizeText(p["body"]);

  switch (event.type) {
    case "bootstrap.planned":
      return `已规划引导 ${p["sourceRef"]}`;
    case "bootstrap.started":
      return `已开始引导 ${p["sourceRef"]}`;
    case "bootstrap.completed":
      return rigTail ? `工作组#${rigTail} 引导完成` : `引导完成`;
    case "bootstrap.partial":
      return `引导部分完成：${p["completed"]} 项成功，${p["failed"]} 项失败`;
    case "bootstrap.failed":
      return `引导失败：${p["error"]}`;
    case "package.validated":
      return `包 ${p["packageName"]} 已验证`;
    case "package.planned":
      return `包 ${p["packageName"]} 已规划：${p["actionable"]} 项可执行，${p["deferred"]} 项延后`;
    case "package.installed":
      return `包 ${p["packageName"]}@${p["packageVersion"]}：${p["applied"]} 项已应用，${p["deferred"]} 项延后`;
    case "package.rolledback":
      return installTail ? `安装#${installTail} 已回滚，恢复 ${p["restored"]} 项` : `已回滚，恢复 ${p["restored"]} 项`;
    case "package.install_failed":
      return `包 ${p["packageName"]} 安装失败：${p["message"]}`;
    case "rig.created":
      return rigTail ? `工作组#${rigTail} 已创建` : "工作组已创建";
    case "rig.deleted":
      return rigTail ? `工作组#${rigTail} 已删除` : "工作组已删除";
    case "rig.imported":
      return rigTail ? `已导入 ${p["specName"]}，工作组#${rigTail} 已创建` : `已导入并创建 ${p["specName"]}`;
    case "snapshot.created":
      return rigTail && snapTail ? `工作组#${rigTail} 已创建 ${p["kind"]} 快照#${snapTail}` : `已创建 ${p["kind"]} 快照`;
    case "restore.started":
      return rigTail ? `工作组#${rigTail} 已开始恢复` : "已开始恢复";
    case "restore.completed": {
      const nodes = Array.isArray(p["result"]) ? p["result"] : ((p["result"] as Record<string, unknown>)?.["nodes"] as unknown[]) ?? [];
      return rigTail ? `工作组#${rigTail} 已恢复 ${nodes.length} 个节点` : `已恢复 ${nodes.length} 个节点`;
    }
    case "node.launched":
      return `节点 ${logicalId ?? normalizeText(p["nodeId"]) ?? "未知"} 已启动`;
    case "node.startup_pending":
      return nodeTail ? `节点#${nodeTail} 等待启动` : "等待启动";
    case "node.startup_ready":
      return nodeTail ? `节点#${nodeTail} 启动就绪` : "启动就绪";
    case "node.startup_failed":
      return nodeTail ? `节点#${nodeTail} 启动失败：${p["error"]}` : `启动失败：${p["error"]}`;
    case "session.detached":
      return `会话 ${p["sessionName"]} 已丢失`;
    case "bundle.created":
      return `包 ${p["bundleName"]} v${p["bundleVersion"]} 已生成`;
    case "session.discovered":
      return `已发现 ${p["tmuxSession"]}:${p["tmuxPane"]} ${p["runtimeHint"]}`;
    case "session.vanished":
      return `${p["tmuxSession"]}:${p["tmuxPane"]} 已消失`;
    case "node.claimed":
      return rigTail ? `已认领 ${p["logicalId"]}，工作组#${rigTail}` : `已认领 ${p["logicalId"]}`;
    case "chat.message":
      return `聊天 ${sender ?? "未知"}：${body ?? ""}`.trim();
    default:
      return event.type;
  }
}

/** 为可导航事件返回路由路径；不可导航时返回 null。 */
export function eventRoute(event: ActivityEvent): string | null {
  const p = event.payload;
  const rigId = p["rigId"] as string | undefined;

  // 发现事件。
  if (event.type === "session.discovered" || event.type === "session.vanished") return "/discovery";
  if (event.type === "node.claimed") {
    const claimRigId = event.payload["rigId"] as string | undefined;
    return claimRigId ? `/rigs/${claimRigId}` : "/discovery";
  }

  // 引导事件导航到 /bootstrap。
  if (event.type.startsWith("bootstrap.")) return "/bootstrap";

  // 在产品体验中，包事件仍归于引导流程附近。
  if (event.type.startsWith("package.")) return "/bootstrap";

  // 工作组范围事件。
  if (rigId) {
    return `/rigs/${rigId}`;
  }

  return null;
}
