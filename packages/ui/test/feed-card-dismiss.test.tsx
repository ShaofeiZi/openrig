import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FeedCard } from "../src/components/for-you/FeedCard.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";

function makeCard(overrides: Partial<FeedCardModel> = {}): FeedCardModel {
  return {
    id: "queue.enqueued-42",
    kind: "progress",
    title: "Sample card",
    body: "Sample body",
    receivedAt: 1234567890,
    createdAt: new Date(1234567890 * 1000).toISOString(),
    source: {
      seq: 42,
      type: "queue.enqueued",
      payload: {},
    } as unknown as FeedCardModel["source"],
    ...overrides,
  };
}

describe("FeedCard dismiss surfaces", () => {
  afterEach(() => {
    cleanup();
  });

  it("does NOT render dismiss control when onDismiss is omitted", () => {
    render(<FeedCard card={makeCard()} />);
    expect(screen.queryByTestId("feed-card-dismiss")).toBeNull();
  });

  it("renders dismiss button (hover-X) when onDismiss is provided", () => {
    render(<FeedCard card={makeCard()} onDismiss={() => {}} />);
    expect(screen.getByTestId("feed-card-dismiss")).toBeTruthy();
  });

  // OPR.0.3.2.20——onDismiss 现在接收完整卡片而不只是 seq，使父级能路由到正确的
  // 忽略集合：事件卡使用 event-seq，队列派生的合成卡片使用 card-id。
  it("clicking dismiss button calls onDismiss with the full card (includes source.seq)", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard({ source: { seq: 42, type: "queue.enqueued", payload: {} } as unknown as FeedCardModel["source"] })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("feed-card-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ seq: 42 }) }));
  });

  it("Backspace key on focused card calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    fireEvent.keyDown(article, { key: "Backspace" });
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ seq: 42 }) }));
  });

  it("Delete key on focused card calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    fireEvent.keyDown(article, { key: "Delete" });
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ seq: 42 }) }));
  });

  it("other keys (e.g. Enter, Escape) do NOT call onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    fireEvent.keyDown(article, { key: "Enter" });
    fireEvent.keyDown(article, { key: "Escape" });
    fireEvent.keyDown(article, { key: "a" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // 修复 velocity-guard 15f8252 的阻断问题：嵌套交互子项（忽略按钮本身、VerbActions、
  // QueueItemTrigger、证明缩略图）冒泡出的 Backspace/Delete 不得软忽略卡片；只有焦点在
  // article 本身时的按键才生效。
  it("Backspace from nested button does NOT bubble up to dismiss the card", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const dismissButton = screen.getByTestId("feed-card-dismiss");
    fireEvent.keyDown(dismissButton, { key: "Backspace" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("Delete from nested button does NOT bubble up to dismiss the card", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const dismissButton = screen.getByTestId("feed-card-dismiss");
    fireEvent.keyDown(dismissButton, { key: "Delete" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("article has tabIndex=0 when onDismiss provided so it can receive focus", () => {
    render(<FeedCard card={makeCard()} onDismiss={() => {}} />);
    const article = screen.getByTestId("feed-card-progress");
    expect(article.getAttribute("tabindex")).toBe("0");
  });

  it("touch swipe-right past threshold triggers onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");

    article.getBoundingClientRect = () =>
      ({ width: 400, left: 0, right: 400, top: 0, bottom: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.touchStart(article, { touches: [{ clientX: 50, clientY: 50, identifier: 1 }] });
    fireEvent.touchEnd(article, { changedTouches: [{ clientX: 300, clientY: 50, identifier: 1 }] });

    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ seq: 42 }) }));
  });

  it("touch swipe-right BELOW threshold does NOT trigger onDismiss", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    article.getBoundingClientRect = () =>
      ({ width: 400, left: 0, right: 400, top: 0, bottom: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.touchStart(article, { touches: [{ clientX: 50, clientY: 50, identifier: 1 }] });
    fireEvent.touchEnd(article, { changedTouches: [{ clientX: 100, clientY: 50, identifier: 1 }] });

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("leftward swipe does NOT trigger onDismiss (only right-swipe dismisses)", () => {
    const onDismiss = vi.fn();
    render(<FeedCard card={makeCard()} onDismiss={onDismiss} />);
    const article = screen.getByTestId("feed-card-progress");
    article.getBoundingClientRect = () =>
      ({ width: 400, left: 0, right: 400, top: 0, bottom: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    fireEvent.touchStart(article, { touches: [{ clientX: 300, clientY: 50, identifier: 1 }] });
    fireEvent.touchEnd(article, { changedTouches: [{ clientX: 50, clientY: 50, identifier: 1 }] });

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
