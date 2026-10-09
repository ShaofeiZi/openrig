// Rig Context / Composable Context Injection v0（PL-014）——library service 测试。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ContextPackLibraryService,
  contextPackId,
  estimateTokensFromBytes,
} from "../src/domain/context-packs/context-pack-library-service.js";

function writePack(root: string, name: string, manifest: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
}

describe("ContextPackLibraryService 上下文包库服务", () => {
  let tmp: string;
  let userRoot: string;
  let workspaceRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-lib-"));
    userRoot = join(tmp, "user");
    workspaceRoot = join(tmp, "workspace");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("扫描 pack 并输出 normalized entry", () => {
    writePack(userRoot, "smoke", `
name: smoke
version: 1
taxonomy: world
purpose: Smoke pack
files:
  - path: notes.md
    role: notes
    summary: Smoke notes
`, { "notes.md": "# Smoke\n\nHello world." });

    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const result = lib.scan();
    expect(result.count).toBe(1);
    expect(result.errors).toEqual([]);
    const entries = lib.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.id).toBe(contextPackId("smoke")); // id = context-pack:<ref>
    expect(entry.name).toBe("smoke");
    expect(entry.kind).toBe("context-pack");
    expect(entry.purpose).toBe("Smoke pack");
    expect(entry.files).toHaveLength(1);
    expect(entry.files[0]!.bytes).toBeGreaterThan(0);
    expect(entry.files[0]!.estimatedTokens).toBeGreaterThan(0);
    expect(entry.derivedEstimatedTokens).toBe(entry.files[0]!.estimatedTokens);
  });

  it("以 bytes=null 呈现缺失文件，而非拒绝 entry", () => {
    writePack(userRoot, "missing", `
name: missing
version: 1
taxonomy: world
files:
  - path: present.md
    role: r
  - path: absent.md
    role: r
`, { "present.md": "data" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const entry = lib.getByRef("missing")!;
    expect(entry).toBeDefined();
    const present = entry.files.find((f) => f.path === "present.md")!;
    const absent = entry.files.find((f) => f.path === "absent.md")!;
    expect(present.bytes).toBeGreaterThan(0);
    expect(absent.bytes).toBeNull();
    expect(absent.estimatedTokens).toBeNull();
  });

  it("发生 collision 时 workspace root 胜出（位于 roots array 最后）", () => {
    const sameManifest = `
name: collision
version: 1
taxonomy: world
files:
  - path: notes.md
    role: r
`;
    writePack(userRoot, "collision", sameManifest, { "notes.md": "user content" });
    writePack(workspaceRoot, "collision", sameManifest, { "notes.md": "workspace content" });
    const lib = new ContextPackLibraryService({
      roots: [
        { path: userRoot, sourceType: "user_file" },
        { path: workspaceRoot, sourceType: "workspace" },
      ],
    });
    lib.scan();
    const entry = lib.getByRef("collision")!;
    expect(entry.sourceType).toBe("workspace");
    expect(entry.sourcePath).toContain("/workspace/");
  });

  // Slice-03 Atom 5（colon-id strip，ruled contract §4）——id 现为 `context-pack:<ref>`，因此偶然
  // 共享 manifest name+version 的两个不同 ref 会获得不同 id，且都能 resolve。legacy
  // `context-pack:<name>:<version>` id 会静默 shadow 此 case（两个 ref 在 idIndex 中折叠为一个 id）；
  // strip 修复了这个潜在 bug。
  it("共享 manifest name+version 的不同 ref 获得不同 id，且都能 resolve", () => {
    const sameManifest = `
name: dup
version: 1
taxonomy: world
files:
  - path: notes.md
    role: r
`;
    writePack(userRoot, "packs/a", sameManifest, { "notes.md": "A" });
    writePack(userRoot, "packs/b", sameManifest, { "notes.md": "B" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const a = lib.getByRef("packs/a");
    const b = lib.getByRef("packs/b");
    expect(a, "packs/a resolves").not.toBeNull();
    expect(b, "packs/b resolves").not.toBeNull();
    expect(a!.id).toBe("context-pack:packs/a");
    expect(b!.id).toBe("context-pack:packs/b");
    expect(a!.id).not.toBe(b!.id); // legacy name:version collapsed both to context-pack:dup:1
  });

  it("捕获 parse error，而不是让它中断 scan", () => {
    writePack(userRoot, "broken", "{not valid yaml", { "notes.md": "x" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const result = lib.scan();
    expect(result.count).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("manifest_parse_error");
  });

  it("忽略没有 manifest.yaml 的 directory", () => {
    mkdirSync(join(userRoot, "not-a-pack"));
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    const result = lib.scan();
    expect(result.count).toBe(0);
  });

  it("重新 scan 反映 filesystem edit（workspace-surface reconciliation）", () => {
    writePack(userRoot, "evolve", `
name: evolve
version: 1
taxonomy: world
files:
  - path: a.md
    role: r
`, { "a.md": "initial" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    expect(lib.list()).toHaveLength(1);
    // Operator 编辑 manifest 以提升 version。
    writeFileSync(join(userRoot, "evolve", "manifest.yaml"), `
name: evolve
version: 2
taxonomy: world
files:
  - path: a.md
    role: r
`);
    lib.scan();
    const list = lib.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.version).toBe("2");
  });

  it("resolveFileWithinPack 拒绝 path-traversal attempt", () => {
    writePack(userRoot, "guard", `
name: guard
version: 1
taxonomy: world
files:
  - path: notes.md
    role: r
`, { "notes.md": "x" });
    const lib = new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
    });
    lib.scan();
    const entry = lib.getByRef("guard")!;
    expect(() => lib.resolveFileWithinPack(entry, "../etc/passwd")).toThrow(/位于 pack 目录内/);
    expect(() => lib.resolveFileWithinPack(entry, "/abs")).toThrow(/位于 pack 目录内/);
  });
});

describe("contextPackId 标识构造", () => {
  it("构建不透明 context-pack:<ref> id（Atom 5——ref 就是 identity）", () => {
    expect(contextPackId("packs/compaction-restore")).toBe("context-pack:packs/compaction-restore");
    expect(contextPackId("smoke")).toBe("context-pack:smoke");
  });
});

describe("estimateTokensFromBytes 估算", () => {
  it("使用 chars/4 heuristic", () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(4)).toBe(1);
    expect(estimateTokensFromBytes(7)).toBe(2);
    expect(estimateTokensFromBytes(100)).toBe(25);
  });
});

// Slice-03 lineage repair（R2 terminal HIGH-2）：version predicate 必须在 live ingestion 路径
//（scan → readPackEntry → parseManifest）触发，而非只在 unit test 中触发。伪造 version 必须作为
// scan ERROR 捕获，绝不能索引为可 resolve entry。
describe("ContextPackLibraryService——scan 时在 live 路径拒绝伪造 version（R2 HIGH-2）", () => {
  let tmp: string;
  let userRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-lib-ver-"));
    userRoot = join(tmp, "user");
    mkdirSync(userRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("既不索引含 colon 的 version，也不索引过长 version——两者都呈现为 scan error", () => {
    writePack(userRoot, "colonver", "name: colonver\nversion: '1:0:0'\nfiles: []", {});
    writePack(userRoot, "longver", `name: longver\nversion: '${"a".repeat(300)}'\nfiles: []`, {});
    const lib = new ContextPackLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const result = lib.scan();
    expect(result.count).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((e) => /version/.test(e.error))).toBe(true);
    expect(lib.getByRef("colonver")).toBeNull();
    expect(lib.getByRef("longver")).toBeNull();
  });
});
