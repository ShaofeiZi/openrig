import type { EventBus } from "./event-bus.js";
import type { ViewProjector } from "./view-projector.js";
import type { PersistedEvent } from "./types.js";
import { BUILT_IN_VIEW_NAMES } from "./view-projector.js";

/**
 * 视图事件桥（PL-004 阶段 B R1；关闭 guard BLOCKER 2）。
 *
 * 订阅 event-bus 上的协作状态变更事件，并通过 ViewProjector.notifyViewChanged
 * 为受影响的内置视图发出 `view.changed`。若没有此桥，连接
 * /api/views/:name/sse 的 SSE 消费者永远收不到变更通知，因为生产接线中没有其他组件
 * 将队列/项目变更连接到 view.changed 事件源。
 *
 * PRD § L5 验收标准：“底层状态变更时，view-projector 发出 view.changed”。
 *
 * 映射（事件类型 → 受影响的内置视图）：
 * - queue.created            → recently-active, founder, pod-load, activity
 * - queue.handed_off         → recently-active, pod-load, activity
 * - queue.claimed            → recently-active, pod-load, activity
 * - queue.unclaimed          → recently-active, pod-load, activity
 * - qitem.fallback_routed    → recently-active, pod-load, activity
 * - qitem.closure_overdue    → recently-active, escalations, activity
 * - inbox.absorbed           → recently-active, pod-load, activity
 * - inbox.denied             → activity
 * - project.classified       → activity（下游视图可消费 project_classifications）
 *
 * 保守原则：有疑问就发出。SSE 消费者可按视图名称过滤。多发是正确的，因为不会漏掉
 * 事件；阶段 B 可以接受少量额外 SSE 流量。
 *
 * 此桥不会为 `view.changed` 自身再次发出 view.changed（避免反馈循环），也不会处理
 * `classifier.lease_*` 事件（租约状态通过项目 SSE 暴露，而非视图 SSE）。
 *
 * 自定义视图：此桥不会为每个自定义视图单独发出事件。自定义视图消费者可订阅通用流
 * /api/views/sse，并按 viewName 过滤。后续可解析自定义视图 SQL，判断其依赖哪些内置
 * 事件类型；v0 仅处理内置视图。
 */

const EVENT_TO_VIEWS: Record<string, readonly string[]> = {
  "proof.judged": ["execution"],
  "proof.sources_changed": ["execution"],
  "queue.created":          ["recently-active", "founder", "pod-load", "activity"],
  "queue.handed_off":       ["recently-active", "pod-load", "activity"],
  "queue.claimed":          ["recently-active", "pod-load", "activity"],
  "queue.unclaimed":        ["recently-active", "pod-load", "activity"],
  // R2 修复（关闭 queue.updated 覆盖的 guard BLOCKER）：通用状态变更接口
  //（POST /api/queue/:qitemId/update）会为任意 pending → blocked、
  // in-progress → done、关闭或升级转换发出 queue.updated。它映射到所有状态派生视图，
  // 因为任何视图的投影结果集都可能变化（例如 done 会从 recently-active 和 pod-load
  // 移除；blocked 会加入 held；closure_reason='escalation' 会加入 escalations；
  // ts_updated 变化会重新排序 activity）。
  "queue.updated":          ["recently-active", "founder", "pod-load", "escalations", "held", "activity"],
  "qitem.fallback_routed":  ["recently-active", "pod-load", "activity"],
  "qitem.closure_overdue":  ["recently-active", "escalations", "activity"],
  "inbox.absorbed":         ["recently-active", "pod-load", "activity"],
  "inbox.denied":           ["activity"],
  "project.classified":     ["activity"],
};

export interface ViewEventBridgeStop {
  (): void;
}

/**
 * 接入事件桥，并返回取消订阅函数（供测试和后台服务优雅关闭使用）。事件桥订阅 event-bus，
 * 只响应已知的协作事件类型。
 */
export function wireViewEventBridge(
  eventBus: EventBus,
  viewProjector: ViewProjector,
): ViewEventBridgeStop {
  // 校验映射只引用内置视图名。若重命名或删除内置视图时未同步 EVENT_TO_VIEWS，
  // 则在启动阶段快速失败。
  const builtInSet = new Set<string>(BUILT_IN_VIEW_NAMES as readonly string[]);
  for (const [evt, views] of Object.entries(EVENT_TO_VIEWS)) {
    for (const v of views) {
      if (!builtInSet.has(v)) {
        throw new Error(
          `view-event-bridge：EVENT_TO_VIEWS 将事件 '${evt}' 映射到未知内置视图 '${v}'；请更新映射或内置视图列表`,
        );
      }
    }
  }

  return eventBus.subscribe((event: PersistedEvent) => {
    const affectedViews = EVENT_TO_VIEWS[event.type];
    if (!affectedViews) return;
    for (const viewName of affectedViews) {
      try {
        viewProjector.notifyViewChanged(viewName, event.type);
      } catch {
        // 尽力而为：事件桥错误不能回滚底层状态变更。静默丢弃即可；对 SSE 消费者而言，
        // 最坏结果是漏掉一次唤醒，而不是状态损坏。
      }
    }
  });
}
