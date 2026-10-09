// OPR.0.5.6.1（R2/R1 阻断修复）——生产环境的 operator 投递端口与延迟触发 payload
// 构建器。两轮审查都证明线上路径不可达：触发器分派了未声明的 op，真实 wake-ladder
// 组合也从未获得测试注入的 engine 端口。本模块是这两个接缝唯一的生产实现，可通过真实
// dispatcher 与真实 tick 测试。

import type { QueueItem, QueueRepository } from "../queue-repository.js";
import type { LoadResult } from "./human-registry.js";
import { loadHumanRegistry } from "./human-registry.js";
import { loadConfig } from "./slack/config.js";
import { OUTBOUND_OP } from "./slack/outbound-driver.js";
import {
  decideDelivery,
  resolveAvailability,
  type DeliveryDecision,
} from "./delivery-rules-engine.js";

export interface OperatorDeliveryEngine {
  dispatchEscalation: (
    row: QueueItem,
    reason: string,
  ) => Promise<{ decision: string; resolved: boolean; notificationKey?: string }>;
}

/** T+30 触发 payload：采用已声明 op 的形状，并携带 EPISODE key，使 Slice 14 回执精确落到
 * 当前 episode；同时绕过 consult，保证已做出的决策不会再次延迟（AM-F3）。 */
export function buildDeferralFirePayload(row: QueueItem, notificationKey: string): Record<string, unknown> {
  return {
    qitemId: row.qitemId,
    notificationKey,
    summary: row.summary ?? null,
    body: row.body ?? null,
    destinationSession: row.destinationSession ?? null,
    sourceSession: row.sourceSession ?? null,
    ownerNotificationLevel: "ALERT",
    ownerNotificationKind: "human-required",
    tags: [...new Set([...(row.tags ?? []), "escalation"])],
    deliveryDeferralFire: true,
  };
}

function describeDecision(d: DeliveryDecision): string {
  return d.deferMinutes !== undefined ? `${d.outcome}-deferred-${d.deferMinutes}m` : d.outcome;
}

/** operator 层级的生产端口（A1.2：该 engine 就是这一层的投递分支）。它通过唯一 engine
 * 做决策，在已声明 op 上经真实 gateway 分派升级，并返回 resolved=false，使阶梯只会依据当前
 * episode 自身的回执/终止证据耗尽（AM-F3 resolution pass）。分派被拒绝时返回 resolved=true
 * 并点明拒绝原因；这是与 engine 接入前底线同等可见的诚实耗尽，绝不静默等待。 */
export function makeOperatorDeliveryEngine(deps: {
  home: string;
  queueRepo: QueueRepository;
  dispatch: (op: string, entityBindingRef: string, payload: unknown) => { ok: boolean; error?: string };
  registry?: { loadHumanRegistry: () => LoadResult };
}): OperatorDeliveryEngine {
  return {
    async dispatchEscalation(row: QueueItem, _reason: string) {
      const reg = deps.registry ? deps.registry.loadHumanRegistry() : loadHumanRegistry(deps.home);
      const human = reg.ok ? reg.entities[0] : undefined;
      if (!human) {
        // 没有已登记人员：单人兜底没有可投递对象，因此诚实耗尽，保持与 engine 接入前底线相同的可见性。
        return { decision: "undeliverable:no-registered-human", resolved: true };
      }
      const cfg = loadConfig(deps.home);
      const decision = decideDelivery({
        level: "ALERT",
        escalation: true,
        human: {
          entityId: human.entityId,
          deliveryClass: human.prefs.deliveryClass,
          availability: resolveAvailability(human.prefs),
        },
        dials: {
          minimumLevelThatPosts: cfg.minimumLevelThatPosts,
          minimumLevelThatInterrupts: cfg.minimumLevelThatInterrupts,
        },
      });
      // 回执必须携带的 episode 身份：Slice 14 台账只接受当前 qitemId:transitionId key；
      // 没有 owner transition 的 baton 行使用稳定的合成 operator-rung episode。
      const owner = deps.queueRepo.transitionLog.latestOwnerNotificationForQitem(row.qitemId);
      const notificationKey = owner ? `${row.qitemId}:${owner.transitionId}` : `${row.qitemId}:operator-rung`;

      const payload = {
        qitemId: row.qitemId,
        notificationKey,
        summary: row.summary ?? `唤醒阶梯升级：${row.qitemId}`,
        body: row.body ?? null,
        destinationSession: human.address,
        sourceSession: row.sourceSession ?? null,
        ownerNotificationLevel: "ALERT",
        ownerNotificationKind: "human-required",
        tags: [...new Set([...(row.tags ?? []), "escalation"])],
      };
      const res = deps.dispatch(OUTBOUND_OP, human.address, payload);
      if (!res.ok) {
        return { decision: `dispatch-refused:${res.error ?? "unknown"}`, resolved: true, notificationKey };
      }
      return { decision: describeDecision(decision), resolved: false, notificationKey };
    },
  };
}
