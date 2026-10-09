// OPR.0.4.6.WF4（C3）——主要工作流活性 feed（架构 Q5-P1）。
//
// 工作流查询由 `/api/workflow/sse` 触发失效（后台服务流式发送 7 种带 seq id 的
// workflow.* 事件；EventSource 重连时通过 Last-Event-ID 续传）。重新获取由 SSE 失效驱动，
// 并设有防抖下限；不做固定频率的紧密轮询（从设计之初就满足 FS-1 启用约束）。
//
// Q5-P1 具名否定约束：workflow.* 事件持久化时 rig_id=NULL（event-bus 存储 NULL，
// /api/events?rigId=X 会将其过滤掉），因此工作组范围订阅会静默丢失整条工作流主干。
// 所以本 feed 按契约不限定工作组范围；WORKFLOW_SSE_URL 永远不含 `?rigId=`
//（由 useWorkflowSse.test.ts 与源码否定检索共同断言）。
//
// Q5-P2：异常/门禁条目活性（FR-3 待关注行）依赖队列事件和评审条带现有的重新获取，
// 不依赖本 feed（workflow.* 事件不携带条目状态）。此钩子只使 ["workflow"] 查询族
//（instances/show/trace/specs）失效。

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** 工作流 SSE 端点——按契约不限定工作组范围（Q5-P1），永远不带 `?rigId=`。 */
export const WORKFLOW_SSE_URL = "/api/workflow/sse";

/** 失效刷新的防抖下限，与全局中心的 150 毫秒一致。 */
const INVALIDATE_FLOOR_MS = 150;

// 使用引用计数单例，使 N 个已挂载消费者共享一个连接（沿用已交付 topology-events 中心模式），
// 而不是每个钩子各开一个流。
let eventSource: EventSource | null = null;
let refCount = 0;
const listeners = new Set<() => void>();

function ensureConnected(): void {
  if (eventSource || typeof EventSource === "undefined") return;
  // 不带 `?rigId=`——Q5-P1 的不限定工作组范围契约（见文件头）。
  const es = new EventSource(WORKFLOW_SSE_URL);
  eventSource = es;
  es.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (typeof data !== "string") return;
    // 服务端已按工作流过滤此流；格式正确的事件意味着某个实例/轨迹发生变化，因此使查询失效。
    // 跳过心跳和非 JSON 内容。
    try {
      JSON.parse(data);
    } catch {
      return;
    }
    for (const l of [...listeners]) l();
  });
}

function releaseIfIdle(): void {
  if (refCount > 0 || listeners.size > 0) return;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

/** 在工作流表面挂载一次（或少量几次）：订阅主要工作流 SSE feed，并在每个 workflow.*
 *  事件到达时使 ["workflow"] 查询族失效，同时按下限防抖。 */
export function useWorkflowSse(): void {
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onEvent = () => {
      if (debounceRef.current) return; // a flush is already scheduled
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void queryClient.invalidateQueries({ queryKey: ["workflow"] });
      }, INVALIDATE_FLOOR_MS);
    };
    listeners.add(onEvent);
    refCount += 1;
    ensureConnected();
    return () => {
      listeners.delete(onEvent);
      refCount -= 1;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      releaseIfIdle();
    };
  }, [queryClient]);
}

export const __test_internals = {
  WORKFLOW_SSE_URL,
  INVALIDATE_FLOOR_MS,
  reset() {
    if (eventSource) eventSource.close();
    eventSource = null;
    refCount = 0;
    listeners.clear();
  },
};
