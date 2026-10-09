// V1 attempt-3 Phase 5 P5-8——HumanSeatCard VellumCard 重构。
//
// 验证 HumanSeatCard 组合 VellumCard 原语（Phase 1）+
// 在规范四角渲染 RegistrationMarks + 对 pending/blocked 状态用
// StatusPip 原语。按仪式 #6
//（命名表面在消费级验证采用的原语）。

import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { HumanSeatCard } from "../src/components/mission-control/components/HumanSeatCard.js";
import type { CompactStatusRow } from "../src/components/mission-control/hooks/useMissionControlView.js";

beforeEach(() => {
  cleanup();
});

function makeRow(state: CompactStatusRow["state"]): CompactStatusRow {
  return {
    session: `seat-${state}@test`,
    role: "qa",
    pod: "test",
    rigName: "test",
    rigId: "rig-1",
    logicalId: `seat-${state}`,
    runtime: "claude-code",
    state,
  } as CompactStatusRow;
}

describe("HumanSeatCard P5-8 VellumCard composition", () => {
  it("composes VellumCard chrome (registration marks present)", () => {
    const { container } = render(
      <HumanSeatCard
        session="human-operator@kernel"
        rows={[makeRow("idle"), makeRow("attention")]}
      />,
    );
    // VellumCard 组合 RegistrationMarks；reg-mark testid 应
    // 出现在全部四角。
    expect(container.querySelector(".reg-mark, [data-testid$='-reg-tl']")).toBeTruthy();
    // 卡根有规范 testid。
    expect(container.querySelector("[data-testid='mc-human-seat-card']")).toBeTruthy();
  });

  it("renders pending count + StatusPip 'pending' when no blocked rows", () => {
    const { container, getByTestId } = render(
      <HumanSeatCard
        session="human-operator@kernel"
        rows={[makeRow("idle"), makeRow("attention")]}
      />,
    );
    expect(getByTestId("mc-human-seat-pending").textContent).toBe("2");
    // 0 blocked 时无 blocked StatusPip。
    expect(container.querySelector("[data-testid='mc-human-seat-blocked']")).toBeNull();
  });

  it("surfaces blocked-count via StatusPip when any row is blocked (warning tone)", () => {
    const { getByTestId } = render(
      <HumanSeatCard
        session="human-operator@kernel"
        rows={[makeRow("blocked"), makeRow("idle")]}
      />,
    );
    const pip = getByTestId("mc-human-seat-blocked");
    expect(pip.textContent).toContain("1 个已阻塞");
  });

  it("renders capability pills with outline-variant border (vellum aesthetic)", () => {
    const { container } = render(
      <HumanSeatCard
        session="human-operator@kernel"
        rows={[]}
        capabilities={["approve", "deny"]}
      />,
    );
    const pills = Array.from(container.querySelectorAll("span")).filter((s) =>
      ["approve", "deny"].includes(s.textContent?.trim() ?? ""),
    );
    expect(pills.length).toBe(2);
    // 每个 pill 有 outline 变体边框类（1px 教条）。
    for (const pill of pills) {
      expect(pill.className).toMatch(/border-outline-variant/);
    }
  });

  it("source asserts no legacy stone-50/stone-300 ad-hoc card chrome remains (ritual #9)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../src/components/mission-control/components/HumanSeatCard.tsx",
      ),
      "utf8",
    );
    // 旧 chrome 是 `border border-stone-300 bg-stone-50 p-3`——
    // 负向断言这些字面模式无一存活到
    // 历史注释之外。
    const codeOnly = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(codeOnly).not.toMatch(/border-stone-300\s+bg-stone-50/);
    expect(codeOnly).toMatch(/VellumCard/);
  });
});
