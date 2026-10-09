// 基于条件的等待工具完整实现。
// 来源：Lace 测试基础设施改进（2025-10-03）。
// 背景：用条件等待替换任意超时，修复了 15 个不稳定测试。

import type { ThreadManager } from '~/threads/thread-manager';
import type { LaceEvent, LaceEventType } from '~/threads/types';

/**
 * 等待线程中出现指定类型的事件。
 *
 * @param threadManager - 要查询的线程管理器
 * @param threadId - 要检查事件的线程
 * @param eventType - 要等待的事件类型
 * @param timeoutMs - 最长等待时间（默认 5000ms）
 * @returns 解析为首个匹配事件的 Promise
 *
 * 示例：
 *   await waitForEvent(threadManager, agentThreadId, 'TOOL_RESULT');
 */
export function waitForEvent(
  threadManager: ThreadManager,
  threadId: string,
  eventType: LaceEventType,
  timeoutMs = 5000
): Promise<LaceEvent> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      const events = threadManager.getEvents(threadId);
      const event = events.find((e) => e.type === eventType);

      if (event) {
        resolve(event);
      } else if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`等待 ${eventType} 事件超过 ${timeoutMs}ms 后超时`));
      } else {
        setTimeout(check, 10); // 每 10ms 轮询一次，以兼顾效率。
      }
    };

    check();
  });
}

/**
 * 等待指定数量的某类事件。
 *
 * @param threadManager - 要查询的线程管理器
 * @param threadId - 要检查事件的线程
 * @param eventType - 要等待的事件类型
 * @param count - 要等待的事件数量
 * @param timeoutMs - 最长等待时间（默认 5000ms）
 * @returns 达到指定数量后，解析为所有匹配事件的 Promise
 *
 * 示例：
 *   // 等待 2 个 AGENT_MESSAGE 事件（初始响应 + 后续响应）。
 *   await waitForEventCount(threadManager, agentThreadId, 'AGENT_MESSAGE', 2);
 */
export function waitForEventCount(
  threadManager: ThreadManager,
  threadId: string,
  eventType: LaceEventType,
  count: number,
  timeoutMs = 5000
): Promise<LaceEvent[]> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      const events = threadManager.getEvents(threadId);
      const matchingEvents = events.filter((e) => e.type === eventType);

      if (matchingEvents.length >= count) {
        resolve(matchingEvents);
      } else if (Date.now() - startTime > timeoutMs) {
        reject(
          new Error(
            `等待 ${count} 个 ${eventType} 事件超过 ${timeoutMs}ms 后超时（实际收到 ${matchingEvents.length} 个）`
          )
        );
      } else {
        setTimeout(check, 10);
      }
    };

    check();
  });
}

/**
 * 等待与自定义谓词匹配的事件。
 * 适用于不仅要检查类型，还要检查事件数据的场景。
 *
 * @param threadManager - 要查询的线程管理器
 * @param threadId - 要检查事件的线程
 * @param predicate - 事件匹配时返回 true 的函数
 * @param description - 用于错误消息的可读描述
 * @param timeoutMs - 最长等待时间（默认 5000ms）
 * @returns 解析为首个匹配事件的 Promise
 *
 * 示例：
 *   // 等待具有指定 ID 的 TOOL_RESULT。
 *   await waitForEventMatch(
 *     threadManager,
 *     agentThreadId,
 *     (e) => e.type === 'TOOL_RESULT' && e.data.id === 'call_123',
 *     'TOOL_RESULT with id=call_123'
 *   );
 */
export function waitForEventMatch(
  threadManager: ThreadManager,
  threadId: string,
  predicate: (event: LaceEvent) => boolean,
  description: string,
  timeoutMs = 5000
): Promise<LaceEvent> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      const events = threadManager.getEvents(threadId);
      const event = events.find(predicate);

      if (event) {
        resolve(event);
      } else if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`等待 ${description} 超过 ${timeoutMs}ms 后超时`));
      } else {
        setTimeout(check, 10);
      }
    };

    check();
  });
}

// 实际调试会话中的用法示例：
//
// 修改前（不稳定）：
// ---------------
// const messagePromise = agent.sendMessage('Execute tools');
// await new Promise(r => setTimeout(r, 300)); // 期望工具在 300ms 内启动。
// agent.abort();
// await messagePromise;
// await new Promise(r => setTimeout(r, 50));  // 期望结果在 50ms 内到达。
// expect(toolResults.length).toBe(2);         // 随机失败。
//
// 修改后（可靠）：
// ----------------
// const messagePromise = agent.sendMessage('Execute tools');
// await waitForEventCount(threadManager, threadId, 'TOOL_CALL', 2); // 等待工具启动。
// agent.abort();
// await messagePromise;
// await waitForEventCount(threadManager, threadId, 'TOOL_RESULT', 2); // 等待结果。
// expect(toolResults.length).toBe(2); // 始终成功。
//
// 结果：通过率从 60% 提升到 100%，执行速度提升 40%。
