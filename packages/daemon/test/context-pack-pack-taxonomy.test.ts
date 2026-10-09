// OPR.0.5.6.10——pack 级 taxonomy（WORLD / LORE / SKILLS / MISSION 成为每个 pack
// 的一等属性，而不只属于声明 atoms 的那个 pack）。
//
// Mini-req 1：每个 manifest 都从唯一共享 enum 声明 pack 级 `taxonomy`
//（导入 ATOM_TAXONOMIES，绝不维护第二份字面量列表）。
// Mini-req 2：缺失或不属于 enum 的值会在解析时响亮失败，并返回教学错误：
// 点名字段、列出合法值，并用一句话说明每个值的含义。
// Mini-req 5：atom 级 taxonomy 保持不变，每个 atom 可以不同。
// Mini-req 6：`lore` 无需修改本 slice 以外的代码即可准入（slice 08 接缝已证明开放）。

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { ATOM_TAXONOMIES, ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

const manifestWith = (taxonomyLine: string) => `
name: probe-pack
version: 1
purpose: taxonomy probe
${taxonomyLine}
files:
  - path: notes.md
    role: notes
`;

describe("pack 级 taxonomy——带教学信息的拒绝（proof contract NEGATIVE 1）", () => {
  it("拒绝没有 taxonomy 的 manifest，并点名字段及所有合法值", () => {
    expect(() => parseManifest(manifestWith(""), "/t/manifest.yaml")).toThrow(ContextPackError);
    try {
      parseManifest(manifestWith(""), "/t/manifest.yaml");
      expect.unreachable("unstamped pack must not parse");
    } catch (err) {
      const e = err as ContextPackError;
      expect(e.code).toBe("manifest_invalid");
      expect(e.message).toContain("'taxonomy'");
      // 列出每个合法值——错误本身就是迁移指引。
      for (const value of ATOM_TAXONOMIES) expect(e.message).toContain(value);
      // 每个值都有一句含义说明（采用术语创设会话的定义）。
      expect(e.message).toContain("你所在的环境");
      expect(e.message).toContain("在此处积累的知识");
      expect(e.message).toContain("你知道如何完成的事情");
      expect(e.message).toContain("你当前正在做的事情");
      // 作者必须添加的精确一行。
      expect(e.message).toMatch(/taxonomy: /);
    }
  });
});

describe("pack 级 taxonomy——非法值（proof contract NEGATIVE 2）", () => {
  it("拒绝 taxonomy: doctrine，并返回相同的教学信息结构", () => {
    try {
      parseManifest(manifestWith("taxonomy: doctrine"), "/t/manifest.yaml");
      expect.unreachable("non-enum taxonomy must not parse");
    } catch (err) {
      const e = err as ContextPackError;
      expect(e.code).toBe("manifest_invalid");
      expect(e.message).toContain("doctrine");
      for (const value of ATOM_TAXONOMIES) expect(e.message).toContain(value);
      expect(e.message).toContain("你所在的环境");
      expect(e.message).toContain("在此处积累的知识");
      expect(e.message).toContain("你知道如何完成的事情");
      expect(e.message).toContain("你当前正在做的事情");
    }
  });

  it("拒绝非字符串 taxonomy", () => {
    expect(() => parseManifest(manifestWith("taxonomy: [world]"), "/t/manifest.yaml")).toThrow(/taxonomy/);
  });
});

describe("pack 级 taxonomy——准入", () => {
  it("接受共享 enum 中的每个值", () => {
    for (const value of ATOM_TAXONOMIES) {
      const m = parseManifest(manifestWith(`taxonomy: ${value}`), "/t/manifest.yaml");
      expect(m.taxonomy).toBe(value);
    }
  });

  it("接受 taxonomy: lore，且本 slice 之外无需改代码（proof contract 接受 LORE）", () => {
    const m = parseManifest(manifestWith("taxonomy: lore"), "/t/manifest.yaml");
    expect(m.taxonomy).toBe("lore");
  });
});

describe("pack 级与 atom 级 taxonomy（mini-req 5：二者可以不同，互不覆盖）", () => {
  it("含 atoms 的 pack 无需保持 taxonomy 一致", () => {
    const manifest = `
name: mixed-pack
version: 1
taxonomy: world
files:
  - path: guide.md
    role: instruction
atoms:
  - id: how-to
    address: guide.md
    taxonomy: skills
    situations: [fresh]
    purpose: depth
    order: 1
    priority: core
`;
    const m = parseManifest(manifest, "/t/manifest.yaml");
    expect(m.taxonomy).toBe("world");
    expect(m.atoms?.[0]?.taxonomy).toBe("skills");
  });
});

describe("库条目投影（mini-req 4：可由命令推导，并由 list --json 暴露字段）", () => {
  const pack = (taxonomyLine: string) => `
name: projected
version: 1
${taxonomyLine}
files:
  - path: notes.md
    role: notes
`;

  it("将 pack taxonomy 投影到库条目", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pack-taxonomy-"));
    try {
      const dir = join(tmp, "projected");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.yaml"), pack("taxonomy: lore"));
      writeFileSync(join(dir, "notes.md"), "# notes\n");
      const lib = new ContextPackLibraryService({ roots: [{ path: tmp, sourceType: "user_file" }] });
      const result = lib.scan();
      expect(result.errors).toEqual([]);
      expect(lib.list()[0]!.taxonomy).toBe("lore");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("composeFromFiles 盖上 taxonomy: mission——自身输出必须通过自身解析器（qitem-20260828092429-d2f94323 的评审裁决；调用方提供值延后到 slice 08）", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pack-taxonomy-"));
    try {
      const src = join(tmp, "src.md");
      writeFileSync(src, "# brief\n");
      const root = join(tmp, "root");
      mkdirSync(root, { recursive: true });
      const lib = new ContextPackLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });
      lib.scan();
      const result = lib.composeFromFiles({
        outRef: "packs/probe-brief",
        sources: [{ path: src, label: "src.md" }],
      });
      expect(result.entry.taxonomy).toBe("mission");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("扫描时拒绝未盖戳 pack——错误可见，绝不建立索引", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pack-taxonomy-"));
    try {
      const dir = join(tmp, "unstamped");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.yaml"), pack(""));
      writeFileSync(join(dir, "notes.md"), "# notes\n");
      const lib = new ContextPackLibraryService({ roots: [{ path: tmp, sourceType: "user_file" }] });
      const result = lib.scan();
      expect(result.count).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toContain("taxonomy");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
