import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeTopologyEventStatus, subscribeTopologyEvents } from "../lib/topology-events.js";

/**
 * 全局事件监听器。订阅共享的 /api/events 中心，并在状态变更事件到达时使相关查询失效。
 * 只在 AppShell 中挂载一次。
 */
export function useGlobalEvents(): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const pendingInvalidations = new Set<string>();

    const unsubscribeStatus = subscribeTopologyEventStatus(status => {
      setConnected(status.connected);
      if (status.connected) for (const key of ["review", "slices", "mission"]) void queryClient.invalidateQueries({ queryKey: [key] });
    });
    const unsubscribe = subscribeTopologyEvents((parsed) => {
      const { type, rigId } = parsed;
      if (!type) return;

      if (type.startsWith("proof.")) for (const key of ["review", "slices", "mission"]) void queryClient.invalidateQueries({ queryKey: [key] });

      // 收集受影响的查询键。
      if (type.startsWith("node.startup_") && rigId) {
        pendingInvalidations.add(`rig:${rigId}:nodes`);
      }
      if (type === "rig.created" || type === "rig.deleted" || type === "rig.stopped" ||
          type === "rig.imported" ||
          type === "bootstrap.completed" || type === "bootstrap.partial") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      if (type === "restore.completed") {
        // slice-04：ps 与 default-summary 是聚合信号，无论是否有 rigId 都加入队列
        //（与原 ActivityFeed 聚合行为一致）；只有工作组专属的 nodes 键仍以 rigId 为条件。
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
        if (rigId) pendingInvalidations.add(`rig:${rigId}:nodes`);
      }
      // slice-04：useGlobalEvents（AppShell 中唯一的 150 毫秒 Set/定时器）现独占合并处理
      // ps 与 default-summary 失效；这些失效过去由 ActivityFeed 逐事件触发。工作组范围的
      // graph/nodes/sessions 与 discovery 失效仍留在 ActivityFeed（不同键语义）。
      if (type === "node.claimed" && rigId) {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      if (type === "session.detached" || type === "node.removed" ||
          type === "pod.deleted" || type === "rig.expanded") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("ps");
      }
      // OPR.0.3.3.19（AC-7）：归档/取消归档会在默认视图与逐主机“归档”分区间移动工作组。
      // 同时重新获取默认摘要、仅归档摘要（独立查询键）和 ps，使通过 CLI 或其他浏览器执行的
      // 归档/取消归档能响应式更新已挂载 UI，而不是一直过期到手动刷新。
      if (type === "rig.archived" || type === "rig.unarchived") {
        pendingInvalidations.add("rigs:summary");
        pendingInvalidations.add("rigs:summary:archived");
        pendingInvalidations.add("ps");
        if (rigId) pendingInvalidations.add(`rig:${rigId}:nodes`);
      }

      // 安排刷新。
      if (debounceRef.current) return; // 已安排。
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;

        // 刷新所有待处理失效项。
        for (const key of pendingInvalidations) {
          if (["review", "slices", "mission"].includes(key)) {
            void queryClient.invalidateQueries({ queryKey: [key] });
          } else if (key === "rigs:summary") {
            queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
          } else if (key === "rigs:summary:archived") {
            // OPR.0.3.3.19：“归档”分区的仅归档查询（见 useArchivedRigs，queryKey
            // ["rigs","summary","archived"]）。显式使其失效以确保重新获取，尽管更宽泛的
            // ["rigs","summary"] 前缀失效本来也会覆盖它。
            queryClient.invalidateQueries({ queryKey: ["rigs", "summary", "archived"] });
          } else if (key === "ps") {
            queryClient.invalidateQueries({ queryKey: ["ps"] });
          } else if (key.startsWith("rig:")) {
            const parts = key.split(":");
            queryClient.invalidateQueries({ queryKey: ["rig", parts[1], parts[2]] });
          }
        }
        pendingInvalidations.clear();
      }, 150);
    });

    return () => {
      unsubscribe();
      unsubscribeStatus();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [queryClient]);
  return { connected };
}
