// release-0.4.7 intent-stage/scaffold-projection——T1（helper unit vector）+
// T6（generic-triple durability sync）。
//
// T1 从已交付 template 派生 placeholder vector（scope-templates/*.md 中的每个 proof-contract
// checkbox text 与 mini-reqs 编号项都必须归类为 placeholder），使 template drift 会如实破坏
// 测试，而非静默取消 placeholder 分类。T6 解析已交付的 slice-progress.md，并断言导出的
// GENERIC_SCAFFOLD_ACCEPTANCE constant 保持同步（消除 template/constant 静默漂移——plan 的
// durability pin）。

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isScaffoldPlaceholderText,
  GENERIC_SCAFFOLD_ACCEPTANCE,
  LEGACY_GENERIC_SCAFFOLD_ACCEPTANCE,
} from "../src/domain/scope/scaffold-placeholder.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const TEMPLATES_DIR = path.join(REPO_ROOT, "packages/cli/src/lib/scope-templates");

/** `## <heading>` section 到下一个 `#` heading 之前的 body（test-local、line-anchored——
 *  镜像 production extractor 的 section shape）。 */
function sectionBody(content: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, "mi");
  const m = re.exec(content);
  if (!m) return null;
  const rest = content.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,6}\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function checkboxTexts(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*-?\s*\[(?:\s|x|X|~)\]\s+(.+)$/);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

function numberedTexts(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

const SLICE_TEMPLATES_WITH_CONTRACT = [
  "placeholder.md",
  "implementation-prd.md",
  "bug-fix.md",
  "research.md",
  "release-feature.md",
  "backlog-deprecation.md",
  "backlog-tech-debt.md",
];

describe("T1——isScaffoldPlaceholderText 单元 vector", () => {
  it("每个已交付 template 的 proof-contract checkbox text 都归类为 placeholder", () => {
    let vectors = 0;
    for (const file of SLICE_TEMPLATES_WITH_CONTRACT) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf8");
      const body = sectionBody(content, "Proof contract");
      expect(body, `${file} must have a ## Proof contract section`).not.toBeNull();
      for (const text of checkboxTexts(body!)) {
        expect(isScaffoldPlaceholderText(text), `${file}: ${text}`).toBe(true);
        vectors++;
      }
    }
    expect(vectors).toBeGreaterThanOrEqual(SLICE_TEMPLATES_WITH_CONTRACT.length);
  });

  it("每个已交付 template 的 mini-reqs 编号项都归类为 placeholder", () => {
    let vectors = 0;
    for (const file of ["placeholder.md", "implementation-prd.md"]) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf8");
      const body = sectionBody(content, "Mini-requirements");
      expect(body, `${file} must have a ## Mini-requirements section`).not.toBeNull();
      for (const text of numberedTexts(body!)) {
        expect(isScaffoldPlaceholderText(text), `${file}: ${text}`).toBe(true);
        vectors++;
      }
    }
    expect(vectors).toBeGreaterThanOrEqual(2);
  });

  it("真实文本不是 placeholder", () => {
    expect(isScaffoldPlaceholderText("phone journey video")).toBe(false);
    expect(isScaffoldPlaceholderText("Implementation complete")).toBe(false);
    expect(isScaffoldPlaceholderText("1080p capture of the drawer opening")).toBe(false);
  });

  it("bracket 边界：方括号外存在任意字符都会使其成为真实内容", () => {
    expect(isScaffoldPlaceholderText("[P0] ship the drawer")).toBe(false);
    expect(isScaffoldPlaceholderText("a [placeholder-looking] middle")).toBe(false);
    expect(isScaffoldPlaceholderText("[almost].")).toBe(false);
    expect(isScaffoldPlaceholderText("x[wrapped]")).toBe(false);
  });

  it("分类前 trim；退化的 `[]` 是 placeholder", () => {
    expect(isScaffoldPlaceholderText("  [padded placeholder]  ")).toBe(true);
    expect(isScaffoldPlaceholderText("[]")).toBe(true);
  });

  it("`[a] and [b]` 归类为占位内容——忠实于架构语法（以 `[` 开始、`]` 结束），刻意不特殊处理", () => {
    // grammar 逐字为 `^\[.*\]$`（没有私有 grammar）。如此书写的真实 deliverable 使用了
    // template grammar——这是已记录的诚实边界，在此固定，使未来“修复”必须成为明确决策。
    expect(isScaffoldPlaceholderText("[a] and [b]")).toBe(true);
  });
});

describe("T6——GENERIC_SCAFFOLD_ACCEPTANCE 与中英文 slice-progress 模板保持同步", () => {
  it("exported constant 依次包含英文与中文模板的验收项", () => {
    const english = fs.readFileSync(path.join(TEMPLATES_DIR, "slice-progress.md"), "utf8");
    const chinese = fs.readFileSync(path.join(TEMPLATES_DIR, "slice-progress.zh-CN.md"), "utf8");
    const englishBody = sectionBody(english, "Acceptance");
    const chineseBody = sectionBody(chinese, "验收");
    expect(englishBody, "slice-progress.md 必须包含 ## Acceptance 章节").not.toBeNull();
    expect(chineseBody, "slice-progress.zh-CN.md 必须包含 ## 验收章节").not.toBeNull();
    expect(checkboxTexts(englishBody!)).toEqual([...LEGACY_GENERIC_SCAFFOLD_ACCEPTANCE]);
    expect(checkboxTexts(chineseBody!)).toEqual([...GENERIC_SCAFFOLD_ACCEPTANCE]);
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 placeholder-suppression completeness micro-bundle——T-B2
//（isPlaceholderOnlyBlock unit vector）、T-A grammar（hasAuthoredNumberedItem unit vector）、
// T-C（prose/bullet-only suppression pin——断言 arch 裁定的 reviewer-L1 行为）。
// ---------------------------------------------------------------------------

import {
  hasAuthoredNumberedItem,
  isPlaceholderOnlyBlock,
} from "../src/domain/scope/scaffold-placeholder.js";

describe("T-B2——isPlaceholderOnlyBlock（block-level“此处未 authored”）", () => {
  it("null/empty → false（absence 是独立 state；caller 保留 null 处理）", () => {
    expect(isPlaceholderOnlyBlock(null)).toBe(false);
    expect(isPlaceholderOnlyBlock("")).toBe(false);
    expect(isPlaceholderOnlyBlock("   \n  \n")).toBe(false);
  });

  it("单行完整 bracket 包裹 → true（已交付 template Intent scaffold）", () => {
    expect(isPlaceholderOnlyBlock("[The recorded intent, verbatim — what was asked for and why.]")).toBe(true);
    expect(isPlaceholderOnlyBlock("\n  [padded placeholder]  \n")).toBe(true);
  });

  it("multi-line 逐行 case：`[a]\\n[b]` → true（整串 trim 会漏掉此情况）", () => {
    expect(isPlaceholderOnlyBlock("[a]\n[b]")).toBe(true);
  });

  it("忽略 placeholder 行之间的空行", () => {
    expect(isPlaceholderOnlyBlock("[a]\n\n[b]\n")).toBe(true);
  });

  it("任意 authored 行都会使 block 成为 authored（mixed → false）", () => {
    expect(isPlaceholderOnlyBlock("[a]\nreal authored words")).toBe(false);
    expect(isPlaceholderOnlyBlock("The founder's exact words.")).toBe(false);
  });
});

describe("T-A grammar——hasAuthoredNumberedItem（唯一 authored-numbered-item grammar）", () => {
  it("dot-form 与 paren-form authored item 都计入（`1.` / `1)`）", () => {
    expect(hasAuthoredNumberedItem("1. Drawer opens from the right side.")).toBe(true);
    expect(hasAuthoredNumberedItem("1) Drawer opens from the right side.")).toBe(true);
  });

  it("仅 placeholder 的编号项 → false（template `1. [...]` scaffold）", () => {
    expect(hasAuthoredNumberedItem("1. [The concise one-glance requirement tier.]")).toBe(false);
  });

  it("null → false", () => {
    expect(hasAuthoredNumberedItem(null)).toBe(false);
  });

  it("T-C：仅 prose 的 body → false（reviewer-L1 ruling——刻意视为未 authored）", () => {
    expect(hasAuthoredNumberedItem("Some prose describing intent without structure.")).toBe(false);
  });

  it("T-C：仅 bullet 的 body → false（bullet 不属于 numbered requirement tier）", () => {
    expect(hasAuthoredNumberedItem("- bullet item one\n- bullet item two")).toBe(false);
  });

  it("T-C：混合 prose + 一个 authored 编号项 → true", () => {
    expect(hasAuthoredNumberedItem("Context prose first.\n\n1. One real observable outcome.")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PM dogfood #1（qitem-20260720015700-630eef64）——isPristineScaffoldSection：
// section-level pristine 测试（每个非空行均为 scaffold placeholder content，允许 template
// 的结构化 list marker）。使用 dynamic import，使 predicate 尚未构建时此文件仍可 collect
//（RED 阶段表现为 assertion failure，而非 module-load crash）。
// ---------------------------------------------------------------------------

describe("isPristineScaffoldSection——section-level pristine grammar（PM dogfood #1）", () => {
  type Fn = (body: string | null) => boolean;
  const load = async (): Promise<Fn> => {
    const mod = (await import("../src/domain/scope/scaffold-placeholder.js")) as Record<string, unknown>;
    expect(typeof mod.isPristineScaffoldSection, "isPristineScaffoldSection must be exported from the twin module").toBe("function");
    return mod.isPristineScaffoldSection as Fn;
  };

  it("template mini-reqs row（numbered marker + bracket text）是 pristine", async () => {
    const fn = await load();
    expect(fn("1. [The concise one-glance requirement tier — this is where approval starts.]")).toBe(true);
  });

  it("template proof-contract row（checkbox marker + bracket text）是 pristine", async () => {
    const fn = await load();
    expect(fn("- [ ] [One promised deliverable, written as an observable outcome — captured.]")).toBe(true);
  });

  it("multi-row 全 placeholder section（bare + bulleted + numbered）是 pristine", async () => {
    const fn = await load();
    expect(fn("[intro placeholder]\n\n1. [one]\n- [ ] [two]\n- [three]")).toBe(true);
  });

  it("authored 编号 row 会使 section 不再 pristine", async () => {
    const fn = await load();
    expect(fn("1. first authored requirement")).toBe(false);
  });

  it("混合 placeholder + authored row 不 pristine（mixed-authored 保持 canonical）", async () => {
    const fn = await load();
    expect(fn("1. [placeholder row]\n2. real authored outcome")).toBe(false);
  });

  it("authored prose 不 pristine（格式错误的 authored 内容仍可见）", async () => {
    const fn = await load();
    expect(fn("authored prose, deliberately no numbered items")).toBe(false);
  });

  it("null 与仅空白内容不 pristine（absence 是独立 state——绝不触发 fallback）", async () => {
    const fn = await load();
    expect(fn(null)).toBe(false);
    expect(fn("")).toBe(false);
    expect(fn("   \n \n")).toBe(false);
  });
});
