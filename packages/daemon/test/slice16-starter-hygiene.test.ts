// Slice 16 (OPR.0.4.7.16) — 产品团队 starter 引导的卫生检查。
// 针对**实际发布**的 starter 源码做内容断言,确保旗舰工作组开箱即用:
// (1) claude-settings 片段携带 TDD 工厂所需的开发工具链,同时 rig up/down 仍然受门禁约束;
// (3) QA 智能体携带它所强制执行的 test-driven-development 技能。(第 2 项(culture 席位 ID 过期)
// 由 packages/cli/test/rig.test.ts 中的 rig-spec-audit 测试覆盖。)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const specs = fileURLToPath(new URL("../specs/", import.meta.url));

describe("Slice 16 — starter 引导卫生检查", () => {
  it("第 1 项(OPR.0.4.8.2 去平台化拆除):片段仅保留 acceptEdits 底线 — 无 allow/ask/deny", () => {
    const frag = JSON.parse(readFileSync(specs + "agents/shared/runtime/claude-settings.fragment.json", "utf8"));
    // 13 条 allow 白名单(评估 C1b)与 rig up/down 的 ask 门禁(C1c)已被拆除 —
    // OpenRig 不再内置任何配置文件权限策略。而底线(acceptEdits)保留。
    expect(frag.permissions.defaultMode).toBe("acceptEdits");
    expect(frag.permissions.allow).toBeUndefined();
    expect(frag.permissions.ask).toBeUndefined();
    expect(frag.permissions.deny).toBeUndefined();
  });

  it("第 3 项：QA 智能体携带其强制要求的 test-driven-development 技能", () => {
    const qa = readFileSync(specs + "agents/development/qa/agent.yaml", "utf8");
    // 必须出现在 skills 数组中，而不是仅在文件任意位置出现。
    expect(qa).toMatch(/skills:\s*\[[^\]]*test-driven-development/);
  });
});
