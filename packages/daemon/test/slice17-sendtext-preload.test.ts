// 四个 SDLC 角色不再使用原始 Slice 17 preload：profile skill 仍可用，但 startup 不得调用未选择的
// process。保留 designer 未改动的显式 action，作为 restore 对照。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { normalizeStartupBlock, validateStartupBlock } from "../src/domain/startup-validation.js";

const SPECS = fileURLToPath(new URL("../specs/", import.meta.url));
const SELECTION_DRIVEN_ROLES = [
  "orchestration/orchestrator",
  "development/implementer",
  "development/qa",
  "review/independent-reviewer",
];

function readAgent(spec: string): Record<string, unknown> {
  return parseYaml(readFileSync(`${SPECS}agents/${spec}/agent.yaml`, "utf8"));
}

describe("Product-team startup 遵循 SDLC 选择", () => {
  it.each(SELECTION_DRIVEN_ROLES)("%s：fresh 与 restored 席位获得角色 context，但不预加载 process", (spec) => {
    const raw = readAgent(spec);
    expect(validateStartupBlock(raw.startup, `${spec}.startup`)).toEqual([]);
    const startup = normalizeStartupBlock(raw.startup);

    // 在角色解析其任务前，任何 action 都不得选择工作。
    expect(startup.actions).toEqual([]);
    expect(startup.files).toContainEqual(expect.objectContaining({
      path: "guidance/role.md",
      deliveryHint: "send_text",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    }));
    const role = readFileSync(`${SPECS}agents/${spec}/guidance/role.md`, "utf8");
    expect(role).toContain("product-journey-sdlc.md#resolve-the-selected-path");
    expect(role).not.toMatch(/BEFORE you do anything else|load and invoke your process skills NOW/i);
  });

  it("显式编写的 designer action 保持 runtime-neutral，且可安全 replay", () => {
    const raw = readAgent("design/product-designer");
    expect(validateStartupBlock(raw.startup, "designer.startup")).toEqual([]);
    const startup = normalizeStartupBlock(raw.startup);
    expect(startup.actions).toHaveLength(1);
    expect(startup.actions[0]).toMatchObject({
      type: "send_text",
      phase: "after_ready",
      appliesOn: ["fresh_start", "restore"],
      idempotent: true,
    });
    expect(startup.actions[0]!.value).toContain("frontend-design");
    expect(startup.actions[0]!.value).not.toMatch(/test-driven-development|the Skill tool/i);
  });
});
