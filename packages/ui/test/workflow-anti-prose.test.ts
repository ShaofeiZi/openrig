// OPR.0.4.6.WF4（C4）P3——反散文负向保证（架构 Q6-P3，机械化执行）。
//
// UI 中唯一的工作流身份关联是结构化 Q6 `row.workflow` 指针，由后台服务侧写入。任何 UI
// 模块都不得通过解析散文来派生路由/导航所需的实例 id，包括组合后的 `identity` 字符串、
// `evidenceRef` CLI 命令、summary 或标签前缀。此源码级否定检索让规则可执行，而非停留在愿望。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 通过 import.meta.dirname 解析源文件；这是其他源码检索测试（如
// focused-terminal-lifecycle.test.ts）使用的 Vitest 稳定锚点。旧写法
// `fileURLToPath(new URL("../src/…", import.meta.url))` 在此 Vitest 设置下会解析为
// `test/undefined`，属于测试工具路径缺陷而非产品问题（OPR.0.4.6.WF4 环节 8 测试专用修复）。
function src(rel: string): string {
  return readFileSync(path.resolve(import.meta.dirname, "../src", rel), "utf8");
}

const WORKFLOW_UI_FILES = [
  "components/review/NeedsYouAccordion.tsx",
  "components/workflow/WorkflowsPage.tsx",
  "components/workflow/WorkflowInstancePage.tsx",
  "components/workflow/WorkflowInstancesBand.tsx",
  "components/workflow/InstanceTrailTimeline.tsx",
];

describe("WF-4 P3: workflow routing joins the structured pointer, never prose", () => {
  it("the NEEDS-YOU deep-link derives the instance id ONLY from item.workflow (the Q6 pointer)", () => {
    const accordion = src("components/review/NeedsYouAccordion.tsx");
    // 正向关联：结构化指针逐字传入路由参数。
    expect(accordion).toContain("params={{ instanceId: item.workflow.instanceId }}");
    // 已拒绝的 twin 字段绝不再次出现。
    expect(accordion).not.toContain("workflowInstanceRef");
  });

  it("no workflow UI module parses identity / evidenceRef / summary strings for navigation", () => {
    for (const rel of WORKFLOW_UI_FILES) {
      const s = src(rel);
      // 规则明确禁止由散文解析产生实例 id：包括 `.split(` 生成 id，或使用
      // evidenceRef/identity/summary 构建路由参数。这些模式一律不得出现。
      expect(s, `${rel} must not derive an instanceId from a split() parse`).not.toMatch(
        /instanceId[^\n]*\.split\(|\.split\([^\n]*instanceId/,
      );
      expect(s, `${rel} must not route off the evidenceRef CLI string`).not.toMatch(
        /to=\{[^}]*evidenceRef|params=\{\{[^}]*evidenceRef/,
      );
      expect(s, `${rel} must not route off the composed identity string`).not.toMatch(
        /params=\{\{[^}]*identity[^}]*\}\}/,
      );
    }
  });

  it("the instance route param comes from a structured field, never a tag-prefix slice", () => {
    // 这些文件中的任何 `to="/workflow/instance/..."` 导航都必须从结构化 `.instanceId`
    // 字段解析 instanceId，绝不能通过处理标签/散文字符串得到。
    for (const rel of WORKFLOW_UI_FILES) {
      const s = src(rel);
      const usesInstanceRoute = s.includes("/workflow/instance/$instanceId");
      if (!usesInstanceRoute) continue;
      // 每个此类文件都从 `.instanceId` 结构化读取中解析参数。
      expect(s, `${rel} routes to the instance page but not via a structured .instanceId`).toMatch(
        /instanceId:\s*[A-Za-z0-9_.]*\.instanceId/,
      );
    }
  });
});
