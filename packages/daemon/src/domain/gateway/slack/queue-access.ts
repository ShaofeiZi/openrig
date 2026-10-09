// S10——gateway 子系统的进程内 queue port。它接替已退役的 CLI queue-bridge（后者从 relay 的独立
// process shell out 到 `rig queue`）：daemon 内不存在 process boundary，因此 fleet access 直接读写
// QueueRepository。选择语义使用随 queue transition 写入的唯一结构化 owner classification。tag 与
// destination 拼写不是第二套 alert classifier。
//   - read 无上限（B5 教训：默认 limit 会静默截断大 backlog）。

import type { QueueRepository, QueueItem as RepoQueueItem } from "../../queue-repository.js";
import { loadHumanRegistry, resolveRegisteredHumanAddress, type LoadResult, type HumanFragment } from "../human-registry.js";
import { ownerNotificationLevelAtLeast, type OwnerNotificationLevel, type QueueTransition } from "../../queue-transition-log.js";

/** Slack 路径使用的窄 projection（形态兼容已退役 bridge 的 QueueItem，使消息构建与测试可沿用）。 */
export interface QueueItem {
  qitemId: string;
  destinationSession?: string | null;
  sourceSession?: string | null;
  tags?: string[] | null;
  state?: string | null;
  tier?: string | null;
  humanIntent?: "decision" | "update" | null;
  humanDetail?: string | null;
  summary?: string | null;
  body?: string | null;
  evidenceRef?: string | null;
  notificationKey?: string | null;
  ownerNotificationKind?: string | null;
  ownerNotificationLevel?: OwnerNotificationLevel | null;
}

export interface AlertFilterOpts {
  minimumLevel?: OwnerNotificationLevel;
}

/** 纯函数：选择 transition 携带足够 owner classification 的 active qitem。 */
export function filterHumanAlerts(items: QueueItem[], opts: AlertFilterOpts): QueueItem[] {
  const active = new Set(["pending", "in-progress", "blocked"]);
  return items.filter((q) => {
    if (q.state && !active.has(q.state)) return false;
    return q.ownerNotificationLevel
      ? ownerNotificationLevelAtLeast(q.ownerNotificationLevel, opts.minimumLevel ?? "NOTICE")
      : false;
  });
}

export interface CreateQitemInput {
  qitemId?: string;
  source: string;
  destination: string;
  summary: string;
  body: string;
  priority?: string;
  tags?: string[];
}

/** inbound router 所需能力：落盘持久 qitem，并取得其 id（否则抛错）。 */
export interface InboundQueuePort {
  createQitem(input: CreateQitemInput): Promise<string>;
}

/** outbound driver 所需能力：当前 human-alert 集合，包含完整 item。 */
export interface OutboundQueuePort {
  listHumanAlerts(filter: AlertFilterOpts): Promise<QueueItem[]>;
}

function project(q: RepoQueueItem, transition: QueueTransition, entities: readonly HumanFragment[]): QueueItem | null {
  const r = q as unknown as Record<string, unknown>;
  let destinationSession: string | null = null;
  let sourceSession: string | null = null;
  if (transition.ownerNotificationKind === "human-decision-resolved") {
    destinationSession = resolveRegisteredHumanAddress(transition.actorSession, entities);
    sourceSession = q.destinationSession;
  } else if (q.state === "blocked") {
    destinationSession = resolveRegisteredHumanAddress(q.blockedOn, entities);
    sourceSession = q.destinationSession;
  } else {
    destinationSession = resolveRegisteredHumanAddress(q.destinationSession, entities);
    sourceSession = q.sourceSession;
  }
  if (!destinationSession) return null;
  return {
    qitemId: String(r.qitemId),
    destinationSession,
    sourceSession,
    tags: (r.tags as string[] | null) ?? null,
    state: (r.state as string | null) ?? null,
    tier: (r.tier as string | null) ?? null,
    humanIntent: q.humanIntent,
    humanDetail: q.humanDetail,
    summary: (r.summary as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    evidenceRef: (r.evidenceRef as string | null) ?? null,
    notificationKey: `${q.qitemId}:${transition.transitionId}`,
    ownerNotificationKind: transition.ownerNotificationKind,
    ownerNotificationLevel: transition.ownerNotificationLevel,
  };
}

/** Slice-11 第 9 项，从已退役的 outbound.ts 原样继承其语义：启用时，将当前所有 active human alert
 *  seed 为 history/seen 而不发布，使 connector 开启时绝不重放 backlog。返回如实标记该 transition
 *  的 online-status 行。 */
export async function seedBacklogAsHistory(opts: {
  queue: OutboundQueuePort;
  seen: import("./state-store.js").SeenStore;
  filter: AlertFilterOpts;
  log?: (msg: string) => void;
}): Promise<{ seeded: number; onlineStatus: string }> {
  const alerts = await opts.queue.listHumanAlerts(opts.filter);
  const already = opts.seen.load();
  const toSeed = alerts.map((a) => a.notificationKey ?? a.qitemId).filter((id) => !already.has(id));
  const seeded = opts.seen.seed(toSeed, "seeded-at-enable");
  const onlineStatus = `slack outbound 已启用（ENABLED）：${seeded} 条既有 alert 已记为历史（不重新发布）；只会投递此后创建的 alert。`;
  opts.log?.(onlineStatus);
  return { seeded, onlineStatus };
}

/** 在 daemon 自身的 QueueRepository 上构建两个 port。进程内实现：无 shell、无 transport、无 `-A`
 *  scope 陷阱（此处 list() 覆盖整个 repository），也无 bounded-body N+1（row 自带 body）。 */
export function makeQueuePorts(
  queueRepo: QueueRepository,
  opts: { loadHumanRegistry?: () => LoadResult } = {},
): InboundQueuePort & OutboundQueuePort {
  return {
    async createQitem(input: CreateQitemInput): Promise<string> {
      const created = await queueRepo.create({
        qitemId: input.qitemId,
        sourceSession: input.source,
        destinationSession: input.destination,
        body: input.body,
        summary: input.summary,
        priority: (input.priority ?? "routine") as never,
        tags: input.tags ?? ["founder-slack", "inbound"],
      });
      return (created as unknown as { qitemId: string }).qitemId;
    },
    async listHumanAlerts(filter: AlertFilterOpts): Promise<QueueItem[]> {
      const registry = (opts.loadHumanRegistry ?? (() => loadHumanRegistry()))();
      if (!registry.ok) return [];
      const rows = queueRepo.list({ activeOnly: true, limit: 1000000 });
      const projected = rows.flatMap((row) => {
        const transition = queueRepo.transitionLog.latestOwnerNotificationForQitem(row.qitemId);
        if (!transition) return [];
        const notificationKey = `${row.qitemId}:${transition.transitionId}`;
        if (queueRepo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, notificationKey)) return [];
        const item = project(row, transition, registry.entities);
        return item ? [item] : [];
      });
      return filterHumanAlerts(projected, filter);
    },
  };
}
