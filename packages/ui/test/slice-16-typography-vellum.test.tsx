// Slice 16 FeedCard 排版 + vellum 密度断言。
//
// 2026-05-14 按 for-you-feedcard-redesign-spec-2026-05-14.md
// 为 FeedCard vellum 一致重构更新。chrome 从
// VellumCard + bg-white/35 迁到 vellum 配方（bg-stone-100/45 +
// backdrop-blur-[10px] + 环境 3 段 box-shadow + 4 CornerBrackets），
// prose 正文字号按可读性北极星升到 12px。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const packageRoot = nodePath.resolve(here, "..");

async function readSource(packageRelPath: string): Promise<string> {
  return readFileSync(nodePath.join(packageRoot, packageRelPath), "utf-8");
}

describe("FeedCard typography + vellum-coherent chrome", () => {
  it("FeedCard outer chrome uses the vellum recipe (bg-stone-100/45 + backdrop-blur-[10px])", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // 卡表面 = vellum 一致（匹配 storytelling-cards.tsx 的 CardShell，
    // 使 /for-you 读作单一表面）。
    expect(source).toContain("bg-surface-low/45 backdrop-blur-[10px]");
    // 旧 VellumCard + 左条 chrome 已消失。
    expect(source).not.toMatch(/VellumCard/);
    expect(source).not.toMatch(/border-l-4 border-l-/);
    // 环境 3 段阴影透过 vellum 定义卡边缘。
    expect(source).toContain("CARD_SHADOW_STYLE");
    expect(source).toContain("0 2px 4px rgba(0, 0, 0, 0.14)");
  });

  it("FeedCard imports CornerBracket from the dashboard/vellum barrel", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain('from "../dashboard/vellum/index.js"');
    expect(source).toContain("CornerBracket");
  });

  it("FeedCard title is 16px font-headline bold (legibility north star)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-headline text-[16px] font-bold leading-tight text-on-surface");
  });

  it("FeedCard qitem body paragraph is 12px font-body (prose; not font-mono; not 11px)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-body text-[12px] leading-relaxed text-on-surface whitespace-pre-line");
    expect(source).not.toMatch(/font-mono text-xs leading-relaxed text-on-surface-variant whitespace-pre-line/);
  });

  it("FeedCard ActionOutcomePanel outcome sentence stays prose font-body 12px", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-body text-[12px] leading-relaxed text-on-surface");
  });

  it("FeedCard prose copy is font-body 12px (bumped from 11px; the 'Your turn' hint itself is GONE per corrective \u00a77.1)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    expect(source).toContain("font-body text-[12px] leading-relaxed text-on-surface");
  });

  it("FeedCard kind indicator uses mono+leading-dot (no colored pills)", async () => {
    const source = await readSource("src/components/for-you/FeedCard.tsx");
    // KIND_DOT map 把每个 FeedCardKind 映射到设计 token 点色。
    expect(source).toContain("KIND_DOT");
    expect(source).toContain('"action-required": "bg-tertiary"');
    expect(source).toContain('approval: "bg-warning"');
    expect(source).toContain('shipped: "bg-success"');
    expect(source).toContain('progress: "bg-secondary"');
    // 旧彩色 pill chrome 应消失。
    expect(source).not.toMatch(/bg-emerald-50/);
    expect(source).not.toMatch(/bg-rose-50/);
    expect(source).not.toMatch(/bg-amber-50/);
    expect(source).not.toMatch(/text-emerald-800/);
    expect(source).not.toMatch(/text-rose-800/);
    expect(source).not.toMatch(/text-amber-800/);
  });
});
