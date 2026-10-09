// OPR.0.4.1.27 真实数据保真——FeedCard 绝不可把内部
// card.source.type 字符串渲染为用户可见。attention/needs-input 投影
// 把真实数据包进合成 ActivityEvents，其 `type` 是内部
// 包装码（queue.attention.synthetic / activity.needs_input.synthetic）。
// 两个旧泄漏点：FeedCard.tsx :554 把原始 source.type 渲染为
// author 回退（needs-input 无 authorSession），:460 把 source.type
// 喂给 eventToken，其未知种类回退把该码人化为可见的
// "...Synthetic" 标记。此锚定不变量：渲染 DOM 中无 "synthetic" / 无原始 type，
// 同时人类标题仍渲染。

import type { ReactNode } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeedCard } from "../src/components/for-you/FeedCard.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeCard(overrides: Partial<FeedCardModel> = {}): FeedCardModel {
  return {
    id: "queue.enqueued-1",
    kind: "progress",
    title: "Sample card",
    body: "Sample body",
    receivedAt: 1234567890,
    createdAt: new Date(1234567890 * 1000).toISOString(),
    source: { seq: 1, type: "queue.enqueued", payload: {} } as unknown as FeedCardModel["source"],
    ...overrides,
  };
}

describe("FeedCard — no internal source.type leak (OPR.0.4.1.27 real-data fidelity)", () => {
  afterEach(() => cleanup());

  it("needs-input synthetic card (no authorSession) does NOT render the raw source.type or 'synthetic'", () => {
    const { container } = withQueryClient(
      <FeedCard
        card={makeCard({
          id: "activity-needs-input-rig_delivery-orch.lead",
          kind: "action-required",
          title: "orch.lead needs input",
          source: { seq: -1, type: "activity.needs_input.synthetic", payload: {} } as unknown as FeedCardModel["source"],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/synthetic/i);
    expect(text).not.toContain("activity.needs_input.synthetic");
    // 人类标题仍渲染
    expect(text).toContain("orch.lead needs input");
  });

  it("queue-attention synthetic card does NOT render 'synthetic' (eventToken token scrubbed)", () => {
    const { container } = withQueryClient(
      <FeedCard
        card={makeCard({
          id: "queue-attention-qitem-abc",
          kind: "approval",
          title: "Founder sign-off needed: 0.4.1 release brief",
          source: { seq: -1, type: "queue.attention.synthetic", payload: {} } as unknown as FeedCardModel["source"],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/synthetic/i);
    expect(text).not.toContain("queue.attention.synthetic");
    expect(text).toContain("Founder sign-off needed");
  });

  it("a real event-derived card still renders its meaningful event token (no over-scrub)", () => {
    const { container } = withQueryClient(
      <FeedCard card={makeCard({ kind: "shipped", title: "Slice merged", source: { seq: 7, type: "queue.transition.done", payload: {} } as unknown as FeedCardModel["source"] })} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/synthetic/i);
    // 真实事件 token 仍会呈现（eventToken 把 transition.done 映射为“标记完成”）。
    expect(text).toContain("标记完成");
  });
});
