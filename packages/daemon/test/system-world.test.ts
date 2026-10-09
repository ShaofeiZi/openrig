import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SYSTEM_WORLD_MANIFEST,
  parseSystemWorldManifest,
  resolveSystemWorld,
} from "../src/domain/system-world.js";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openrig-system-world-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("System World", () => {
  it("解析随附 selector，且不嵌入 skill 字节", () => {
    expect(parseSystemWorldManifest(DEFAULT_SYSTEM_WORLD_MANIFEST)).toEqual({
      schema: "openrig.system-world/v0alpha1",
      id: "openrig-default",
      version: "0.5.9",
      context: [
        { ref: "onboarding-width" },
        { ref: "world-public", profiles: { claude: "guided", codex: "codex-coverage" } },
      ],
      skills: [],
    });
    expect(DEFAULT_SYSTEM_WORLD_MANIFEST).not.toContain("SKILL.md");
  });

  it("把 default、replacement 和 disabled 解析为带来源的不同显式状态", () => {
    const contextRoot = freshRoot();
    mkdirSync(join(contextRoot, "system"));
    writeFileSync(join(contextRoot, "system", "system-world.yaml"), DEFAULT_SYSTEM_WORLD_MANIFEST);
    writeFileSync(join(contextRoot, "replacement.yaml"), DEFAULT_SYSTEM_WORLD_MANIFEST.replace("openrig-default", "operator-world"));

    expect(resolveSystemWorld({ contextRoot, selection: "default", source: "default" })).toMatchObject({
      ok: true,
      state: "default",
      source: "default",
      manifest: { id: "openrig-default" },
    });
    expect(resolveSystemWorld({ contextRoot, selection: "replacement.yaml", source: "file" })).toMatchObject({
      ok: true,
      state: "replacement",
      source: "file",
      manifestPath: join(contextRoot, "replacement.yaml"),
      manifest: { id: "operator-world" },
    });
    expect(resolveSystemWorld({ contextRoot, selection: "disabled", source: "env" })).toEqual({
      ok: true,
      state: "disabled",
      source: "env",
      selection: "disabled",
      manifestPath: null,
      manifest: null,
    });
  });

  it("拒绝缺失或格式错误的选定清单，而不是推断为 disabled", () => {
    const contextRoot = freshRoot();
    writeFileSync(join(contextRoot, "bad.yaml"), "schema: wrong\n");
    expect(resolveSystemWorld({ contextRoot, selection: "default", source: "default" })).toMatchObject({
      ok: false,
      error: { code: "system_world_missing" },
    });
    expect(resolveSystemWorld({ contextRoot, selection: "bad.yaml", source: "file" })).toMatchObject({
      ok: false,
      state: "replacement",
      error: { code: "system_world_invalid" },
    });
  });
});
