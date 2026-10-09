// OPR.0.4.1.19 —— Story 标签页：从 queue-item 谱系重建一组 DAG 森林。
//
// 边是真实的，从不推断。后台服务以三种方式记录谱系
// （queue-repository.ts / migrations 024,025,035）：
//   - chain_of_record：qitem-id 的有序祖先数组
//     `[...source.chain, source.qitemId]`——尾是直接父节点，整个数组是回到根的路径。
//   - handed_off_from：在交接创建的 qitem 上记录的父 QITEM ID（== chain 尾）。
//     （注意不对称：源的 handed_off_to 是一个 SESSION。）
//   - workflow_step_trails prior->next：工作流激活时的显式边。
//
// 每个 qitem 至多一个父节点 => Story 图是真正的无环 git 历史 DAG
// （环是线性重复；分支不必重新汇合）。Fan-out（扇出）是真实数据（一个父节点有多个子节点）。
// 视觉上的 fan-in / 汇合只是渲染辅助，绝不是双父数据节点——这就是 git-merge 始终仅作示意的原因（构建护栏 1）。
//
// fallback() 会向 chain 追加一个非 qitem 哨兵 `fallback-from:<session>`，
// 因此重建器必须容忍无法解析为已知 qitem 的 chain 条目（跳过它们；绝不崩溃）。

export interface StoryQitemInput {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  closureReason?: string | null;
  closureTarget?: string | null;
  priority?: string | null;
  tier?: string | null;
  blockedOn?: string | null;
  tags: string[] | null;
  body: string;
  /** OPR.0.4.1.18 强制的人类可读摘要；缺失时退化为正文首行。 */
  summary?: string | null;
  chainOfRecord: string[] | null;
  handedOffFrom?: string | null;
  handedOffTo?: string | null;
  claimedAt?: string | null;
  expiresAt?: string | null;
  closureRequiredAt?: string | null;
  lastNudgeAttempt?: string | null;
  lastNudgeResult?: string | null;
  lastHeartbeat?: string | null;
  resolution?: string | null;
  targetRepo?: string | null;
}

export interface StoryNode {
  qitemId: string;
  summary: string;
  /** 拥有/曾拥有该工作的席位（目的地）。组件可渲染 源->目的。 */
  owner: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  closureReason: string | null;
  closureTarget: string | null;
  priority: string | null;
  tier: string | null;
  blockedOn: string | null;
  tags: string[];
  body: string;
  tsCreated: string;
  tsUpdated: string;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  claimedAt: string | null;
  expiresAt: string | null;
  closureRequiredAt: string | null;
  lastNudgeAttempt: string | null;
  lastNudgeResult: string | null;
  lastHeartbeat: string | null;
  resolution: string | null;
  targetRepo: string | null;
  /** 完整 chain_of_record（可能含未解析/哨兵条目）。 */
  chain: string[];
  /** 已解析的直接父 qitem id；根节点为 null。 */
  parentId: string | null;
  childIds: string[];
  isRoot: boolean;
  isHumanOrigin: boolean;
  /** 槽道序号（0 = 任务主轴）。 */
  lane: number;
}

export interface StoryForest {
  /** 按最新在前排序（向上生长的图的顶部）。 */
  nodes: StoryNode[];
  roots: string[];
  laneCount: number;
}

function firstBodyLine(body: string): string {
  const line = (body ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? "（无摘要）";
}

function deriveSummary(item: StoryQitemInput): string {
  const summary = item.summary?.trim();
  return summary && summary.length > 0 ? summary : firstBodyLine(item.body);
}

function isHumanOrigin(item: StoryQitemInput, tags: string[]): boolean {
  if (tags.includes("human-origin")) return true;
  const src = item.sourceSession ?? "";
  // 托管席位是 `pod-member@rig`；裸 token（无 `@`）即人类来源。
  if (!src.includes("@")) return true;
  return /\b(founder|human|operator)\b/i.test(src);
}

/**
 * 解析 qitem 的直接父节点：chain_of_record 中最后一个能解析为已知 qitem 的条目
 * （越过未知/哨兵条目），chain 缺失时回退到 handed_off_from。根节点返回 null。
 */
function resolveParent(item: StoryQitemInput, known: Set<string>): string | null {
  const chain = item.chainOfRecord ?? [];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const candidate = chain[i];
    if (candidate && candidate !== item.qitemId && known.has(candidate)) return candidate;
  }
  const handedOffFrom = item.handedOffFrom ?? null;
  if (handedOffFrom && handedOffFrom !== item.qitemId && known.has(handedOffFrom)) {
    return handedOffFrom;
  }
  return null;
}

/**
 * 从 queue 项重建 DAG 森林。纯函数：无 I/O，确定。
 */
export function buildStoryForest(items: StoryQitemInput[]): StoryForest {
  if (items.length === 0) return { nodes: [], roots: [], laneCount: 0 };

  const known = new Set(items.map((i) => i.qitemId));

  // 基础节点对象（lanes 在下方填充）。
  const nodeById = new Map<string, StoryNode>();
  for (const item of items) {
    const tags = item.tags ?? [];
    nodeById.set(item.qitemId, {
      qitemId: item.qitemId,
      summary: deriveSummary(item),
      owner: item.destinationSession,
      sourceSession: item.sourceSession,
      destinationSession: item.destinationSession,
      state: item.state,
      closureReason: item.closureReason ?? null,
      closureTarget: item.closureTarget ?? null,
      priority: item.priority ?? null,
      tier: item.tier ?? null,
      blockedOn: item.blockedOn ?? null,
      tags,
      body: item.body,
      tsCreated: item.tsCreated,
      tsUpdated: item.tsUpdated,
      handedOffTo: item.handedOffTo ?? null,
      handedOffFrom: item.handedOffFrom ?? null,
      claimedAt: item.claimedAt ?? null,
      expiresAt: item.expiresAt ?? null,
      closureRequiredAt: item.closureRequiredAt ?? null,
      lastNudgeAttempt: item.lastNudgeAttempt ?? null,
      lastNudgeResult: item.lastNudgeResult ?? null,
      lastHeartbeat: item.lastHeartbeat ?? null,
      resolution: item.resolution ?? null,
      targetRepo: item.targetRepo ?? null,
      chain: item.chainOfRecord ?? [],
      parentId: resolveParent(item, known),
      childIds: [],
      isRoot: false,
      isHumanOrigin: isHumanOrigin(item, tags),
      lane: 0,
    });
  }

  // 连接子节点与根。
  const roots: string[] = [];
  for (const node of nodeById.values()) {
    if (node.parentId && nodeById.has(node.parentId)) {
      nodeById.get(node.parentId)!.childIds.push(node.qitemId);
    } else {
      node.parentId = null;
      node.isRoot = true;
      roots.push(node.qitemId);
    }
  }

  // 按时间顺序分配 lane（最旧在前 = 图的底部）。
  // 第一个子节点延续父节点的 lane；后续子节点（扇出）获得新 lane；无子节点的尖端释放其 lane。
  // 被释放的 lane 只能被严格更晚且非同父的节点复用——因此并发分支和扇出兄弟在视觉上保持区分，
  // 同时长任务仍保持紧凑（git 图“收束的 lane”），限制总宽度。
  const chronological = [...items].sort(
    (a, b) => tsValue(a.tsCreated) - tsValue(b.tsCreated),
  );
  const freed: { lane: number; ts: number; parentId: string | null }[] = [];
  let nextLane = 0;
  let maxLane = -1;
  const placedChildren = new Map<string, number>();

  const allocateLane = (node: StoryNode): number => {
    const ts = tsValue(node.tsCreated);
    let best: { idx: number; lane: number } | null = null;
    for (let i = 0; i < freed.length; i += 1) {
      const f = freed[i];
      if (!f) continue;
      const eligible = f.ts < ts && !(f.parentId !== null && f.parentId === node.parentId);
      if (eligible && (best === null || f.lane < best.lane)) best = { idx: i, lane: f.lane };
    }
    let lane: number;
    if (best) {
      lane = best.lane;
      freed.splice(best.idx, 1);
    } else {
      lane = nextLane++;
    }
    if (lane > maxLane) maxLane = lane;
    return lane;
  };

  for (const item of chronological) {
    const node = nodeById.get(item.qitemId)!;
    let lane: number;
    if (node.parentId && nodeById.has(node.parentId)) {
      const parent = nodeById.get(node.parentId)!;
      const order = placedChildren.get(parent.qitemId) ?? 0;
      placedChildren.set(parent.qitemId, order + 1);
      lane = order === 0 ? parent.lane : allocateLane(node);
    } else {
      lane = allocateLane(node);
    }
    node.lane = lane;
    if (node.childIds.length === 0) {
      // 尖端收束 -> 其 lane 可被严格更晚的非兄弟节点复用。
      freed.push({ lane, ts: tsValue(node.tsCreated), parentId: node.parentId });
    }
  }

  // 渲染顺序：最新在前（顶部），使图向上生长。
  const nodes = [...nodeById.values()].sort(
    (a, b) => tsValue(b.tsCreated) - tsValue(a.tsCreated),
  );

  return { nodes, roots, laneCount: maxLane + 1 };
}

function tsValue(ts: string): number {
  const v = Date.parse(ts);
  return Number.isNaN(v) ? 0 : v;
}

/**
 * Story 行日期格式（OPR.0.4.1.19 用日期而非时间的修复）。
 *
 * 已发布的行日期曾用 `formatFriendlyDate`，它把同一天的时间戳折叠为
 * "Today HH:MM"——在活跃开发期间每个 story 项都是当天，因此日历日期被隐藏
 * （实际只剩时间）。创始人要求始终显示显式日期。本函数始终渲染 月+日+时间
 * （例如 "6月23日 4:50"），绝不显示 "今天"/"昨天"，与已批准的稿图一致。
 */
export function formatStoryDate(value: string | undefined | null): string {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
