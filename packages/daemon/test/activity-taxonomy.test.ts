import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTIVITY_VALUES,
  SESSION_PRESENCE_VALUES,
  RESUMABILITY_VALUES,
  deriveDisplayActivity,
  type NeedsInput,
} from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A1 — 分类体系就是词汇表。基础层的 RED 枚举（已收到回执）：界面携带
// 各自的本地状态词——terminalActive 布尔值（SeatActivityService）、agentActivity.state
// "running|needs_input|idle|unknown"（AgentActivityStore，其中 needs_input 是枚举值）、
// hydrate.ts 自己的内联显示裁决、attention_required 生命周期词汇。这些固定项声明唯一语言；
// 消费固定项（界面据此渲染）在原子 A8 落地。

// repoRoot 从 import.meta.url 派生，绝不使用 process.cwd()（SOP grep 守卫规则）。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("S19 A1——三轴分类体系，并保持绑定排除项", () => {
  it("activity 枚举严格为 working | idle-at-prompt | unknown——needs-input 和 attention 不是状态值", () => {
    expect([...ACTIVITY_VALUES].sort()).toEqual(["idle-at-prompt", "unknown", "working"]);
    for (const banned of ["needs-input", "needs_input", "attention", "blocked", "waiting"]) {
      expect(ACTIVITY_VALUES.has(banned), `"${banned}" 绝不能成为 activity 枚举值`).toBe(false);
    }
  });

  it("unknown 是一等状态：它是枚举成员，而非错误状态", () => {
    expect(ACTIVITY_VALUES.has("unknown")).toBe(true);
  });

  it("session 轴为 present | detached | exited | absent，且与 activity 正交", () => {
    expect([...SESSION_PRESENCE_VALUES].sort()).toEqual(["absent", "detached", "exited", "present"]);
    for (const v of SESSION_PRESENCE_VALUES) expect(ACTIVITY_VALUES.has(v)).toBe(false);
  });

  it("resumability 轴为 live | resumable | context-walled，且与前两轴正交", () => {
    expect([...RESUMABILITY_VALUES].sort()).toEqual(["context-walled", "live", "resumable"]);
    for (const v of RESUMABILITY_VALUES) {
      expect(ACTIVITY_VALUES.has(v)).toBe(false);
      expect(SESSION_PRESENCE_VALUES.has(v)).toBe(false);
    }
  });

  it("needs-input 以 count+reason 承载，且只能由 DISPLAY 桥接渲染（附录中的人类可读值）", () => {
    const none: NeedsInput = { count: 0, reason: null };
    const two: NeedsInput = { count: 2, reason: "权限提示" };
    // count=0：display 就是 activity 值本身。
    expect(deriveDisplayActivity("working", none)).toBe("working");
    expect(deriveDisplayActivity("idle-at-prompt", none)).toBe("idle");
    expect(deriveDisplayActivity("unknown", none)).toBe("unknown");
    // count>0：display 渲染 needs-input，但它绝不会成为枚举值。
    expect(deriveDisplayActivity("idle-at-prompt", two)).toBe("needs-input");
    expect(deriveDisplayActivity("working", two)).toBe("needs-input"); // 对此信号，chrome 的优先级高于自报告
  });

  it("deriveDisplayActivity 明确拒绝分类体系外的 activity 值（不静默扩展词汇）", () => {
    expect(() => deriveDisplayActivity("running", { count: 0, reason: null })).toThrow(/taxonomy/);
    expect(() => deriveDisplayActivity("needs_input", { count: 0, reason: null })).toThrow(/taxonomy/);
  });
});

describe("S19 A1——参考文档是规范文本，并固定拒绝项", () => {
  const docPath = join(repoRoot, "docs", "reference", "agent-state-taxonomy.md");

  it("docs/reference/agent-state-taxonomy.md 存在", () => {
    expect(existsSync(docPath)).toBe(true);
  });

  it("公开文档声明自身为规范文本，并指向类型化事实源（无分叉）", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toContain("This document is the canonical text for the shipped taxonomy");
    expect(doc).toContain("packages/daemon/src/domain/activity-taxonomy.ts");
  });

  it("文档包含带日期的拒绝回执：transcript-quiescence 与 pane-scraping-as-primary", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toMatch(/transcript[- ]quiescence/i);
    expect(doc).toMatch(/pane[- ]scraping/i);
    expect(doc).toContain("2026-08-26"); // 带日期的回执，而非传闻
    // 引用允许用于不同目的的消费者，避免拒绝范围过度扩张：
    expect(doc).toMatch(/refocus/i);
  });

  it("文档包含协调对照表（ours vs herdr vs omnigent）", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toMatch(/herdr/i);
    expect(doc).toMatch(/omnigent/i);
  });

  it("文档将 PARKED 定义为派生诊断，并将 HELD 定义为其显式对应状态", () => {
    const doc = readFileSync(docPath, "utf8");
    expect(doc).toMatch(/PARKED/);
    expect(doc).toMatch(/HELD/);
    expect(doc).toMatch(/derived/i);
  });
});
