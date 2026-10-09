// OPR.0.5.6.1 mini-req 3 + AM-F1——C/D digest flush v3（dual-rebind 修复，
// R1 76a8cfd1 + R2 003f4786）：以 transport truth 保证 LOSSLESS 与 EXACTLY-ONCE。membership 等于
// 当前 episode 在消息时刻记录的 decision（containment 在决策时使用实时 dial 写入）。digest 使用
// 持久且 episode 稳定的 decision ID（`digest:<stable-hash>`）通过 gateway 发帖：dispatch buffer
// 会持续重新驱动直到真实 post 成功；delivered store 使任意 replay/re-dispatch 收敛到同一次 post；
// S14 retain-and-repair 路径负责 post/stamp 崩溃边界。member receipt 只在 post 后由 delivery seam
// 盖章，因此 transport failure 不会产生虚假 receipt，所有 member 仍可 flush；重新驱动就是恢复，
// 绝不静默丢失。

import { createHash } from "node:crypto";
import type { QueueRepository } from "../queue-repository.js";
import { makeQueuePorts } from "../gateway/slack/queue-access.js";
import type { OwnerNotificationLevel } from "../queue-transition-log.js";
import { OUTBOUND_OP } from "../gateway/slack/outbound-driver.js";
import { DispatchBuffer } from "../gateway/dispatch-buffer.js";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

export const DELIVERY_DIGEST_FLUSH_POLICY = "delivery-digest-flush";

interface RegistrySurfaceLike {
  loadHumanRegistry: (home: string) => {
    ok: boolean;
    entities?: Array<{ entityId: string; address: string }>;
  };
}

export interface RunDeliveryDigestFlushInput {
  queueRepo: QueueRepository;
  registry: RegistrySurfaceLike;
  home: string;
  dispatch: (op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }) => { ok: boolean; error?: string };
  window: "4h" | "daily";
  minimumLevel?: OwnerNotificationLevel;
}

export async function runDeliveryDigestFlush(input: RunDeliveryDigestFlushInput): Promise<{ dispatched: number; members: number }> {
  const reg = input.registry.loadHumanRegistry(input.home);
  if (!reg.ok || !reg.entities || reg.entities.length === 0) return { dispatched: 0, members: 0 };
  const human = reg.entities[0]!;

  const ports = makeQueuePorts(input.queueRepo, {
    loadHumanRegistry: () => reg,
  } as never);
  // selection 已排除带 receipt 的 episode。receipt 只在真实 post 后存在，因此在 transport truth
  // 出现前，member 始终保持可 flush。
  const alerts = await ports.listHumanAlerts({ minimumLevel: input.minimumLevel ?? "NOTICE" });

  // MEMBERSHIP EXCLUSIVITY（R1 HOLD c7818ceb）：已搭载 PENDING digest decision 的 member 正在
  // IN FLIGHT。持久 buffer 是恢复安全的真源，不新增状态，也没有排序窗口：enqueue 前丢失的 mint
  // 不会留下 pending entry，因此其 member 仍可 mint；已 enqueue 的 mint 会重新驱动到 transport truth。
  // 排除 in-flight member 后，结构上不可能重叠，因此持续增长的 member 集合绝不会重复投递 pending 项。
  const inFlight = new Set<string>();
  try {
    for (const d of new DispatchBuffer(input.home).pending()) {
      if (!d.decisionId.startsWith("digest:")) continue;
      const ownKey = (d.payload as { notificationKey?: string } | null)?.notificationKey;
      if (ownKey) inFlight.add(ownKey);
      const mrs = (d.payload as { memberReceipts?: Array<{ notificationKey?: string }> } | null)?.memberReceipts ?? [];
      for (const m of mrs) if (m.notificationKey) inFlight.add(m.notificationKey);
    }
  } catch { /* buffer 不可读时开放到 selection；dispatcher 的 stable-ID 幂等仍会守卫同集合情形。 */ }

  const selected = alerts.filter((alert) => {
    const key = alert.notificationKey ?? alert.qitemId;
    if (inFlight.has(key)) return false;
    return input.queueRepo.listTransitions(alert.qitemId).some((t) =>
      t.transitionNote?.startsWith("delivery-decision: digest")
        && t.transitionNote.includes(`notification_key=${key}`)
        && t.transitionNote.includes(`window=${input.window}`));
  });
  if (selected.length === 0) return { dispatched: 0, members: 0 };
  // 选定时机继续沿用既有 digest policy。到达该时机时，人工 request/update 需要自身完整 brief 与
  // reply identity，而不是只有 summary 的 member receipt；普通系统通知仍保持聚合。
  let completeDispatched = 0;
  const members = [] as typeof selected;
  for (const item of selected) {
    if (item.ownerNotificationKind !== "human-required" && item.ownerNotificationKind !== "human-update" && !item.humanDetail) {
      members.push(item);
      continue;
    }
    const id = createHash("sha256").update(input.window + "|" + (item.notificationKey ?? item.qitemId)).digest("hex").slice(0, 32);
    const result = input.dispatch(OUTBOUND_OP, item.destinationSession!, { ...item, deliveryDigestPost: true }, { decisionId: `digest:complete:${id}` });
    if (result.ok) completeDispatched++;
  }
  if (!members.length) return { dispatched: completeDispatched, members: selected.length };

  const memberReceipts = members.map((m) => ({
    qitemId: m.qitemId,
    notificationKey: m.notificationKey ?? m.qitemId,
    level: m.ownerNotificationLevel ?? "RECORD",
    kind: m.ownerNotificationKind ?? "unclassified",
  }));
  // 持久且 episode 稳定的 identity：相同 member 集合 + window -> 相同 decision ID。
  const digestId = createHash("sha256")
    .update(input.window + "|" + memberReceipts.map((m) => m.notificationKey).sort().join(","))
    .digest("hex")
    .slice(0, 16);

  const payload = {
    deliveryDigestPost: true,
    digestId,
    qitemId: memberReceipts[0]!.qitemId, // transport failure ledger 写入的锚点行。
    destinationSession: human.address,
    summary: `投递摘要（${input.window}）——${members.length} 项`,
    body: members.map((m) => `• ${m.summary ?? m.qitemId} [${m.qitemId}]`).join("\n"),
    memberReceipts,
  };
  const res = input.dispatch(OUTBOUND_OP, human.address, payload, { decisionId: `digest:${digestId}` });
  return { dispatched: completeDispatched + (res.ok ? 1 : 0), members: selected.length };
}

/** Watchdog engine policy wrapper——重复执行的窗口 flush；digest 会重复，只有 deferral 是 one-shot。 */
export function makeDeliveryDigestFlushPolicy(deps: {
  queueRepo: QueueRepository;
  registry: RegistrySurfaceLike;
  home: string;
  dispatch: (op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }) => { ok: boolean; error?: string };
}): Policy {
  return {
    name: DELIVERY_DIGEST_FLUSH_POLICY,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const window = ((job.context as { window?: string }).window === "daily" ? "daily" : "4h") as "4h" | "daily";
      const r = await runDeliveryDigestFlush({ ...deps, window });
      if (r.dispatched > 0) return { action: "skip", reason: `已分发 digest（${r.members} 项）` };
      return { action: "skip", reason: "没有需要 flush 的内容" };
    },
  } as Policy;
}
