// 0.3.1 slice 06 forward-fix #2 —— Feed.tsx 适配器的纯逻辑测试：
// 把后台驱动的任务 + 切片行转换为 FeedCardItem[]。证明任务被路由到
// ProgressCard（闭环此前“生产中 ProgressCard 从未挂载”的发现），
// 且切片状态路由在不挂载 Feed.tsx 本身的前提下分发到正确卡片类型。

import { describe, it, expect } from "vitest";
import { buildStorytellingFeedItems } from "../src/components/feed/cards/storytelling-cards.js";
import type { FeedCard } from "../src/lib/feed-classifier.js";
import type { ActivityEvent } from "../src/hooks/useActivityFeed.js";
import {
  isCardKindSubscribed,
  type FeedSubscriptionState,
} from "../src/hooks/useFeedSubscriptions.js";

function makeApprovalFeedCard(opts: {
  qitemId?: string;
  altKey?: "qitem_id";
  title?: string;
  body?: string;
  authorSession?: string;
  id?: string;
}): FeedCard {
  const payload: Record<string, unknown> = {};
  if (opts.qitemId !== undefined) {
    if (opts.altKey === "qitem_id") payload.qitem_id = opts.qitemId;
    else payload.qitemId = opts.qitemId;
  }
  const evt: ActivityEvent = {
    seq: 1,
    type: "queue.created",
    payload,
    createdAt: "2026-05-15T00:00:00.000Z",
    receivedAt: 1_700_000_000_000,
  };
  return {
    id: opts.id ?? "queue.created-1",
    kind: "approval",
    title: opts.title ?? "Approval needed",
    body: opts.body,
    authorSession: opts.authorSession,
    receivedAt: evt.receivedAt,
    createdAt: evt.createdAt,
    source: evt,
  };
}

describe("buildStorytellingFeedItems —— 生产适配器", () => {
  it("把任务路由为 ProgressCard 项（发现 2 修复：ProgressCard 已接线）", () => {
    const items = buildStorytellingFeedItems(
      [
        { name: "release-0.3.1", path: "missions/release-0.3.1" },
        { name: "demo-video-rig-v0", path: "missions/demo-video-rig-v0" },
      ],
      [],
    );
    const progressItems = items.filter((i) => i.kind === "progress");
    expect(progressItems).toHaveLength(2);
    expect(progressItems[0]!.kind).toBe("progress");
    if (progressItems[0]!.kind === "progress") {
      expect(progressItems[0]!.source.missionId).toBe("release-0.3.1");
      expect(progressItems[0]!.source.nextStep).toMatch(/打开任务/);
    }
  });

  it("任务上限 2，保持预览条紧凑", () => {
    const items = buildStorytellingFeedItems(
      [
        { name: "m1", path: "missions/m1" },
        { name: "m2", path: "missions/m2" },
        { name: "m3", path: "missions/m3" },
        { name: "m4", path: "missions/m4" },
      ],
      [],
    );
    expect(items.filter((i) => i.kind === "progress")).toHaveLength(2);
  });

  it("把 shipped/complete/done 切片路由为 ShippedCard", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "a", status: "shipped" },
        { name: "b", status: "complete" },
        { name: "c", status: "done" },
      ],
    );
    expect(items.every((i) => i.kind === "shipped")).toBe(true);
    expect(items).toHaveLength(3);
  });

  it("把 blocked 切片路由为 status=warning 的 IncidentCard", () => {
    const items = buildStorytellingFeedItems([], [{ name: "x", status: "blocked" }]);
    expect(items[0]!.kind).toBe("incident");
    if (items[0]!.kind === "incident") {
      expect(items[0]!.source.status).toBe("warning");
    }
  });

  it("把 failed/danger 切片路由为 status=danger 的 IncidentCard", () => {
    const failed = buildStorytellingFeedItems([], [{ name: "x", status: "failed" }]);
    expect(failed[0]!.kind).toBe("incident");
    if (failed[0]!.kind === "incident") expect(failed[0]!.source.status).toBe("danger");
  });

  it("把其余全部路由为 status=info 的 IncidentCard", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "a", status: "in-flight" },
        { name: "b", status: null },
        { name: "c" },
      ],
    );
    expect(items.every((i) => i.kind === "incident")).toBe(true);
    items.forEach((i) => {
      if (i.kind === "incident") expect(i.source.status).toBe("info");
    });
  });

  it("把任务 + 切片合成单一有序列表（任务在前，切片在后）", () => {
    const items = buildStorytellingFeedItems(
      [{ name: "m1", path: "missions/m1" }],
      [{ name: "s1", status: "shipped" }],
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe("progress");
    expect(items[1]!.kind).toBe("shipped");
  });

  it("两输入皆空时返回空列表（无误产生卡片）", () => {
    expect(buildStorytellingFeedItems([], [])).toEqual([]);
  });

  it("容忍 null/undefined 输入而不抛错", () => {
    // @ts-expect-error —— 故意形状不匹配，验证对运行时数据漂移
    // （后台可能返回 null）的防御。
    expect(buildStorytellingFeedItems(null, undefined)).toEqual([]);
  });

  it("把 approval 类 FeedCard 路由为 ApprovalCard 项，从 payload 提取 qitemId", () => {
    const items = buildStorytellingFeedItems(
      [],
      [],
      undefined,
      [
        makeApprovalFeedCard({ qitemId: "qitem-abc", title: "Approve this", body: "body text", authorSession: "advisor@rig" }),
        makeApprovalFeedCard({ qitemId: "qitem-def", altKey: "qitem_id", title: "Approve that" }),
      ],
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "approval")).toBe(true);
    if (items[0]!.kind === "approval") {
      expect(items[0]!.source.qitemId).toBe("qitem-abc");
      expect(items[0]!.source.title).toBe("Approve this");
      expect(items[0]!.source.oneLiner).toContain("advisor@rig");
      expect(items[0]!.source.bodyPreview).toBe("body text");
      expect(items[0]!.source.drillInHref).toBe("/for-you");
    }
    if (items[1]!.kind === "approval") {
      // 下划线 payload 键也能解析。
      expect(items[1]!.source.qitemId).toBe("qitem-def");
    }
  });

  it("审批上限 2，保持预览条紧凑", () => {
    const items = buildStorytellingFeedItems(
      [],
      [],
      undefined,
      [
        makeApprovalFeedCard({ qitemId: "q1" }),
        makeApprovalFeedCard({ qitemId: "q2" }),
        makeApprovalFeedCard({ qitemId: "q3" }),
        makeApprovalFeedCard({ qitemId: "q4" }),
      ],
    );
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(2);
  });

  it("忽略非审批 FeedCard（Shipped/Progress/Incident 来自任务+切片，不来自 feedCards）", () => {
    const nonApproval: FeedCard[] = [
      { ...makeApprovalFeedCard({ qitemId: "x1" }), kind: "shipped" },
      { ...makeApprovalFeedCard({ qitemId: "x2" }), kind: "progress" },
      { ...makeApprovalFeedCard({ qitemId: "x3" }), kind: "action-required" },
      { ...makeApprovalFeedCard({ qitemId: "x4" }), kind: "observation" },
    ];
    const items = buildStorytellingFeedItems([], [], undefined, nonApproval);
    // 无审批输入 ⇒ 无审批输出。非审批 FeedCard 不经过本适配器路由
    //（那些类型的来源是任务/切片行）。
    expect(items).toEqual([]);
  });

  // OPR.0.3.2.17 —— ConceptCard 数据源（取代 0.3.1 推迟的 pin；
  // HG-6 fail-first 判别）。
  //
  // 来源：塑形后的 backlog 候选——rawStatus === "candidate"（大小写不敏感）
  //   的 SliceListEntry 行。
  // 映射：sliceId ← name；title ← displayName（或 name）；oneLiner ←
  //   frontmatter description（作为适配器行的 `description` 字段透传）。
  // 优雅空态（HG-2）：无候选行 → 无 concept 项、无错误；其他类型不受影响。

  it("HG-1：rawStatus='candidate' 切片经适配器发出 ConceptCard（fail-first；仅当 concept 分支接线才通过）", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        {
          name: "concept-restore-packet",
          missionId: "backlog",
          displayName: "Restore packet primitive",
          status: "draft",
          rawStatus: "candidate",
          description: "First-class restore packet so seats survive compaction.",
        },
      ],
    );
    const concepts = items.filter((i) => i.kind === "concept");
    expect(concepts).toHaveLength(1);
    if (concepts[0]!.kind === "concept") {
      expect(concepts[0]!.source.sliceId).toBe("concept-restore-packet");
      expect(concepts[0]!.source.title).toBe("Restore packet primitive");
      expect(concepts[0]!.source.oneLiner).toBe("First-class restore packet so seats survive compaction.");
    }
  });

  it("HG-1：rawStatus='Candidate'（混合大小写）仍发出 ConceptCard", () => {
    const items = buildStorytellingFeedItems(
      [],
      [{ name: "c1", missionId: "backlog", displayName: "c1", status: "draft", rawStatus: "Candidate", description: "d" }],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(1);
  });

  it("HG-2 优雅空态：零候选行 → 无 concept 项、无错误，其他类型仍渲染", () => {
    const items = buildStorytellingFeedItems(
      [{ name: "m1", path: "missions/m1" }],
      [
        { name: "s-shipped", status: "shipped" },
        { name: "s-blocked", status: "blocked" },
        // 任意位置都没有 rawStatus='candidate' 行
      ],
      undefined,
      [makeApprovalFeedCard({ qitemId: "q1" })],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(0);
    expect(items.filter((i) => i.kind === "progress")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "shipped")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "incident")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(1);
  });

  it("HG-4 上限：按精选条规则 ConceptCard 项上限 2", () => {
    const slices = Array.from({ length: 5 }).map((_, i) => ({
      name: `cand-${i}`,
      missionId: "backlog",
      displayName: `Candidate ${i}`,
      status: "draft" as const,
      rawStatus: "candidate",
      description: `desc-${i}`,
    }));
    const items = buildStorytellingFeedItems([], slices);
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(2);
  });

  it("HG-5 无回归：候选切片不再同时发出 shipped/incident 项（concept 路由互斥）", () => {
    const items = buildStorytellingFeedItems(
      [],
      [{ name: "c1", missionId: "backlog", displayName: "c1", status: "draft", rawStatus: "candidate", description: "d" }],
    );
    // concept 路由的行不得重复计入 shipped/incident。
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("concept");
  });

  it("description 缺失时 ConceptCardSource oneLiner 回退到稳定占位（防御；PRD 允许优雅）", () => {
    const items = buildStorytellingFeedItems(
      [],
      [{ name: "c1", missionId: "backlog", displayName: "c1", status: "draft", rawStatus: "candidate" }],
    );
    expect(items).toHaveLength(1);
    if (items[0]!.kind === "concept") {
      expect(typeof items[0]!.source.oneLiner).toBe("string");
      expect(items[0]!.source.oneLiner.length).toBeGreaterThan(0);
    }
  });

  // 守护 BLOCKER qitem-20260518093643 —— PRD 选项 A 把 ConceptCard
  // 来源限定为 missions/backlog/slices/<slug> 且 `status: candidate`。
  // 任何其他任务下（或 missionId === null）的 `status: candidate` 行
  // 都不得发出 concept 项，而是走普通状态桶路径。
  it("BLOCKER 修复：非 backlog 任务下的候选切片发出零 ConceptCard（PRD 选项 A——仅 backlog）", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "non-backlog-candidate", missionId: "release-0.3.2", displayName: "Non-backlog", status: "draft", rawStatus: "candidate", description: "shaped under release lane" },
      ],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(0);
    // 落到状态桶路径；status="draft" 路由到 incident-info。
    expect(items.filter((i) => i.kind === "incident")).toHaveLength(1);
  });

  it("BLOCKER 修复：missionId=null 的候选切片发出零 ConceptCard", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "orphan-candidate", missionId: null, displayName: "Orphan", status: "draft", rawStatus: "candidate", description: "shaped without mission" },
      ],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(0);
  });

  it("BLOCKER 修复：backlog 候选仍恰好发出一个 ConceptCard（保留正例）", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "backlog-candidate", missionId: "backlog", displayName: "Backlog", status: "draft", rawStatus: "candidate", description: "shaped backlog item" },
      ],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(1);
  });

  it("BLOCKER 修复：混合输入——2 个 backlog 候选 + 2 个非 backlog 候选 → 2 个 ConceptCard（仅 backlog），非 backlog 为 incident", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "b1", missionId: "backlog", displayName: "B1", status: "draft", rawStatus: "candidate", description: "d" },
        { name: "b2", missionId: "backlog", displayName: "B2", status: "draft", rawStatus: "candidate", description: "d" },
        { name: "x1", missionId: "release-0.3.2", displayName: "X1", status: "draft", rawStatus: "candidate", description: "d" },
        { name: "x2", missionId: null, displayName: "X2", status: "draft", rawStatus: "candidate", description: "d" },
      ],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(2);
    // 非 backlog 候选落到 incident（status: draft → info）。
    expect(items.filter((i) => i.kind === "incident")).toHaveLength(2);
  });

  // 纯 helper 单测——谓词单独导出以便独立 pin。
  it("isBacklogCandidateSlice 谓词：backlog+candidate=true；其余皆 false", async () => {
    const { isBacklogCandidateSlice } = await import("../src/components/feed/cards/storytelling-cards.js");
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog", rawStatus: "candidate" })).toBe(true);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog", rawStatus: "Candidate" })).toBe(true);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "release-0.3.2", rawStatus: "candidate" })).toBe(false);
    expect(isBacklogCandidateSlice({ name: "x", missionId: null, rawStatus: "candidate" })).toBe(false);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog", rawStatus: "shipped" })).toBe(false);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog", rawStatus: null })).toBe(false);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog" })).toBe(false);
  });

  it("payload 无 qitemId/qitem_id 键时回退到 FeedCard.id", () => {
    const card = makeApprovalFeedCard({ id: "queue.created-42" });
    const items = buildStorytellingFeedItems([], [], undefined, [card]);
    expect(items).toHaveLength(1);
    if (items[0]!.kind === "approval") {
      expect(items[0]!.source.qitemId).toBe("queue.created-42");
    }
  });

  // OPR.0.4.1.27 qa forward-fix —— 预览条必须反映经过订阅过滤的集合，
  // 而非原始 feed。仅当调用方传入审批卡片时适配器才渲染审批预览，
  // 因此调用方（Feed.tsx）必须传入按级别过滤后的 `cards`，而非 `rawCards`。
  // 这里在调用方契约层同时 pin 住 bug 与修复。
  describe("预览跟随订阅过滤后的集合（级别诚实）", () => {
    const needsYou: FeedSubscriptionState = {
      actionRequired: true,
      approvals: false,
      shipped: false,
      progress: false,
      auditLog: false,
    };
    const actionCard: FeedCard = {
      ...makeApprovalFeedCard({ qitemId: "act-1", title: "Your turn" }),
      kind: "action-required",
      id: "action-1",
    };
    const approvalCard = makeApprovalFeedCard({ qitemId: "ap-1", title: "Needs approval" });

    it("Needs-you（审批关）：过滤后集合排除审批，预览不发出审批项；action-required 保留", () => {
      const raw: FeedCard[] = [actionCard, approvalCard];
      // Feed 必须传给适配器的是订阅过滤后的集合。
      const visible = raw.filter((c) => isCardKindSubscribed(c.kind, needsYou));
      expect(visible.some((c) => c.kind === "action-required")).toBe(true); // 底线保留
      expect(visible.some((c) => c.kind === "approval")).toBe(false); // 审批被过滤掉
      const items = buildStorytellingFeedItems([], [], undefined, visible);
      expect(items.some((i) => i.kind === "approval")).toBe(false);
    });

    it("记录该 bug：传入原始（未过滤）集合会在 Needs-you 处露出审批——修复前接线", () => {
      const raw: FeedCard[] = [actionCard, approvalCard];
      const items = buildStorytellingFeedItems([], [], undefined, raw);
      expect(items.some((i) => i.kind === "approval")).toBe(true);
    });
  });
});
