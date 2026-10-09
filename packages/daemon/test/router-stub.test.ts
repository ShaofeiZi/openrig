import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// slice-07 R3——thin router stub 的 RED-first 钉死：openrig-core router 必须携带 rig
// TOOL GRANT，并教经 `rig context get`（R1 的 serving verb）按需加载条目，使测试工具有
// 一个 skill 教 pull——这是 CE-08 瘦身的前置条件。其他 skills 的批量移除和 hidden-from-listing
// 属 CE-08，挡在 R3 之外。
const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = resolve(HERE, "..", "assets", "plugins", "openrig-core", "skills", "openrig-skills", "SKILL.md");
const COMMAND_REFERENCE = resolve(
  HERE,
  "..",
  "assets",
  "plugins",
  "openrig-core",
  "skills",
  "openrig-user",
  "SKILL.md",
);

function frontmatterAndBody(md: string): { fm: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md);
  if (!m) throw new Error("router stub 无 YAML frontmatter");
  return { fm: parseYaml(m[1]!) as Record<string, unknown>, body: m[2]! };
}

describe("R3——openrig-core router stub 教 pull", () => {
  const { fm, body } = frontmatterAndBody(readFileSync(STUB, "utf-8"));
  const { fm: commandReferenceFm } = frontmatterAndBody(
    readFileSync(COMMAND_REFERENCE, "utf-8"),
  );

  it("在 allowed-tools 中携带 rig tool grant", () => {
    expect(String(fm["allowed-tools"] ?? "")).toMatch(/\brig\b/);
  });

  it("在 description 中携带 R6 选择 trigger 网", () => {
    const description = String(fm.description ?? "");
    const triggerNet = [
      /\bfleet (recovery|restore)\b/i,
      /\bseat handover\b/i,
      /\bnew-seat orientation\b/i,
      /\bwatchdog wake\b/i,
      /\bcross-host\b/i,
      /\brig packaging\b/i,
      /\bOpenRig upgrade\b/i,
      /\bsystematic debugging\b/i,
      /\bqueue triage\b/i,
      /\bimplementation planning\b/i,
    ];

    for (const trigger of triggerNet) expect(description).toMatch(trigger);
  });

  it("教经 `rig context get` 按需加载条目", () => {
    expect(body).toMatch(/rig context get/);
  });

  it("在 core 保持 mode-free（router 中无 mode-conditional trigger）", () => {
    // CE slice-05 裁决：mode 知识随 mode plugin，不随 core。描述性 host-scale 提及可以；
    // mode-CONDITIONAL trigger 不行。
    expect(body).not.toMatch(/\b(if|when)\b[^.\n]{0,40}\b(factory|lab|hq)\s+mode\b/i);
  });

  it("REPAIR 1——教 ask->ref 发现步骤（get 前 list/select）", () => {
    expect(body).toMatch(/rig context list/);
  });

  it("REPAIR 1——教规范全路径 ref 格式（skills/<ns>/<name>）", () => {
    expect(body).toMatch(/rig context get\s+skills\//);
  });

  it("把自然能力发现路由到 router，优先于 command reference", () => {
    const routerDescription = String(fm.description ?? "").replace(/\s+/g, " ");
    const commandReferenceDescription = String(commandReferenceFm.description ?? "").replace(/\s+/g, " ");

    expect.soft(routerDescription).toMatch(/\bcross-host\b.*\banother machine\b/i);
    expect.soft(commandReferenceDescription).toMatch(/\balready (known|selected)\b/i);
    expect.soft(commandReferenceDescription).toMatch(/\bNOT for natural capability discovery\b/i);
  });
});
