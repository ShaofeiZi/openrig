// Rig Context / Composable Context Injection v0（PL-014）——bundle assembler 测试。

import { describe, it, expect } from "vitest";
import { assembleBundle } from "../src/domain/context-packs/bundle-assembler.js";
import type { ContextPackEntry } from "../src/domain/context-packs/context-pack-types.js";

function makeEntry(opts: Partial<ContextPackEntry> & { files: ContextPackEntry["files"]; purpose?: string | null }): ContextPackEntry {
  return {
    id: opts.id ?? "context-pack:test:1",
    kind: "context-pack",
    name: opts.name ?? "test",
    version: opts.version ?? "1",
    purpose: opts.purpose ?? null,
    taxonomy: opts.taxonomy ?? "world",
    sourceType: opts.sourceType ?? "user_file",
    sourcePath: opts.sourcePath ?? "/tmp/test",
    relativePath: opts.relativePath ?? "test",
    updatedAt: opts.updatedAt ?? "2026-05-04T00:00:00Z",
    manifestEstimatedTokens: opts.manifestEstimatedTokens ?? null,
    derivedEstimatedTokens: opts.derivedEstimatedTokens ?? 0,
    files: opts.files,
  };
}

describe("assembleBundle", () => {
  it("使用 name + version + 每文件 header 构造 bundle 框架", () => {
    const entry = makeEntry({
      name: "alpha",
      version: "1",
      purpose: "Alpha pack purpose",
      files: [
        { path: "prd.md", role: "prd", summary: "PRD summary", absolutePath: "/abs/prd.md", bytes: 12, estimatedTokens: 3 },
        { path: "notes.md", role: "notes", summary: null, absolutePath: "/abs/notes.md", bytes: 5, estimatedTokens: 2 },
      ],
    });
    const reads: Record<string, string> = {
      "/abs/prd.md": "## PRD body",
      "/abs/notes.md": "Note 1",
    };
    const bundle = assembleBundle({
      packEntry: entry,
      readFile: (p) => reads[p]!,
    });
    expect(bundle.text).toContain("# zrig 上下文包：alpha v1");
    expect(bundle.text).toContain("Alpha pack purpose");
    expect(bundle.text).toContain("## 文件：prd.md（角色：prd）——PRD summary");
    expect(bundle.text).toContain("## 文件：notes.md（角色：notes）");
    expect(bundle.text).toContain("## PRD body");
    expect(bundle.text).toContain("Note 1");
    expect(bundle.bytes).toBe(Buffer.byteLength(bundle.text, "utf-8"));
  });

  it("跳过标记为缺失的文件（absolutePath 为 null）并报告它们", () => {
    const entry = makeEntry({
      files: [
        { path: "present.md", role: "r", summary: null, absolutePath: "/abs/present.md", bytes: 5, estimatedTokens: 2 },
        { path: "absent.md", role: "r", summary: null, absolutePath: null, bytes: null, estimatedTokens: null },
      ],
    });
    const reads: Record<string, string> = { "/abs/present.md": "content" };
    const bundle = assembleBundle({ packEntry: entry, readFile: (p) => reads[p]! });
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]!.path).toBe("present.md");
    expect(bundle.missingFiles).toEqual([{ path: "absent.md", role: "r" }]);
    expect(bundle.text).not.toContain("absent.md");
  });

  it("根据组合文本的 byte 数估算 token 数", () => {
    const entry = makeEntry({
      files: [
        { path: "a.md", role: "r", summary: null, absolutePath: "/abs/a.md", bytes: 100, estimatedTokens: 25 },
      ],
    });
    const bundle = assembleBundle({
      packEntry: entry,
      readFile: () => "x".repeat(100),
    });
    // bundle text ≈ header + 100 个字符；estimateTokens = ceil(bytes / 4)
    expect(bundle.estimatedTokens).toBeGreaterThanOrEqual(25);
  });

  it("逐字保留用户提供的 purpose（裁剪首尾空白）", () => {
    const entry = makeEntry({
      purpose: "  Multi-line purpose\nthat spans  ",
      files: [],
    });
    const bundle = assembleBundle({ packEntry: entry, readFile: () => "" });
    expect(bundle.text).toContain("Multi-line purpose\nthat spans");
  });

  it("处理不含文件的 pack（空 bundle、不崩溃）", () => {
    const entry = makeEntry({ files: [] });
    const bundle = assembleBundle({ packEntry: entry, readFile: () => "" });
    expect(bundle.files).toEqual([]);
    expect(bundle.missingFiles).toEqual([]);
    expect(bundle.text).toContain("# zrig 上下文包：test v1");
  });
});
