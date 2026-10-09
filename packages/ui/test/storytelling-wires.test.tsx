// 0.3.1 slice 06——guard-3 发现前瞻修复的生产接线测试：
// (1) TimelineTab 在 prop 提供时渲染 timeline.md 内容；
// (2) ForYouFeed 在 sliceRows 有数据时挂载 storytelling
// 预览段；(3) ProgressCard 按 IMPL-PRD §6 在折叠视图渲染进度条。

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TimelineTab } from "../src/components/slices/tabs/TimelineTab.js";
import { ProgressCard } from "../src/components/feed/cards/storytelling-cards.js";

afterEach(cleanup);

describe("TimelineTab — timeline.md production wire (Finding 1)", () => {
  it("renders the story-timeline-markdown section when timelineMarkdown prop is provided", () => {
    const markdown = `---
kind: incident-timeline
title: Slice narrative
---

Body content.
`;
    const { container } = render(
      <TimelineTab
        events={[]}
        phaseDefinitions={null}
        timelineMarkdown={markdown}
      />
    );
    expect(container.querySelector("[data-testid='story-timeline-markdown']")).toBeTruthy();
    // 内部 MarkdownViewer 把 body 包进已知 kind 的 KindFrame，
    // 故接线在 live tab 中真正组合 storytelling 原语。
    expect(container.querySelector("[data-testid='kind-frame-incident-timeline']")).toBeTruthy();
  });

  it("falls back to the empty-state when neither events nor timeline.md exist", () => {
    const { container } = render(
      <TimelineTab events={[]} phaseDefinitions={null} />
    );
    expect(container.querySelector("[data-testid='story-empty']")).toBeTruthy();
    expect(container.querySelector("[data-testid='story-timeline-markdown']")).toBeNull();
  });

  it("does NOT render the empty-state when timeline.md exists but events are absent", () => {
    const { container } = render(
      <TimelineTab events={[]} phaseDefinitions={null} timelineMarkdown="# Just markdown" />
    );
    expect(container.querySelector("[data-testid='story-empty']")).toBeNull();
    expect(container.querySelector("[data-testid='story-timeline-markdown']")).toBeTruthy();
  });
});

describe("ProgressCard — progress bar + next-step (Finding 2 sub-issue)", () => {
  it("renders a progress bar accessory on the collapsed view with the correct fill width", () => {
    const { getByTestId } = render(
      <ProgressCard source={{
        missionId: "m1",
        title: "Release 0.3.1",
        oneLiner: "default text",
        percent: 73,
      }} />
    );
    const bar = getByTestId("feed-card-progress-m1-bar");
    expect(bar.getAttribute("data-percent")).toBe("73");
    const fill = getByTestId("feed-card-progress-m1-bar-fill");
    expect(fill.style.width).toBe("73%");
  });

  it("renders nextStep text in the collapsed view when supplied (replacing oneLiner)", () => {
    const { getByTestId } = render(
      <ProgressCard source={{
        missionId: "m1",
        title: "x",
        oneLiner: "fallback line",
        nextStep: "Driver hand-back; awaiting verify",
        percent: 50,
      }} />
    );
    expect(getByTestId("feed-card-progress-m1-one-liner").textContent).toContain("Driver hand-back; awaiting verify");
    expect(getByTestId("feed-card-progress-m1-one-liner").textContent).not.toContain("fallback line");
  });

  it("clamps percent into the 0..100 range so out-of-bounds values don't break the bar geometry", () => {
    const { getByTestId, rerender } = render(
      <ProgressCard source={{ missionId: "m1", title: "x", oneLiner: "y", percent: 200 }} />
    );
    expect(getByTestId("feed-card-progress-m1-bar").getAttribute("data-percent")).toBe("100");
    rerender(
      <ProgressCard source={{ missionId: "m1", title: "x", oneLiner: "y", percent: -25 }} />
    );
    expect(getByTestId("feed-card-progress-m1-bar").getAttribute("data-percent")).toBe("0");
  });
});
