// UI Enhancement Pack v0——progress indexer 测试。
//
// 使用含少量不同 nesting depth PROGRESS.md 文件的临时 workspace fixture 驱动 indexer。固定：
//   - root walk 遵守 max depth
//   - 拾取更深层级的 PROGRESS.md 文件
//   - 跳过 directory（node_modules、.git、.worktrees、dist 等）
//   - 忽略 frontmatter；从 `[ ]` / `[x]` / `[~]` 与 `## Heading` 行解析 row
//   - 从 indent 派生 hierarchy depth
//   - aggregate count 跨文件正确相加
//   - 空 root → isReady() false；scan 不返回文件
//   - readProgressRootsFromEnv 解析分隔 pair

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgressIndexer, readProgressRootsFromEnv } from "../src/domain/progress/progress-indexer.js";

describe("UI Enhancement Pack v0——readProgressRootsFromEnv", () => {
  it("env 未设置时返回空数组", () => {
    expect(readProgressRootsFromEnv({})).toEqual([]);
  });

  it("解析逗号分隔的 name:path pair", () => {
    const roots = readProgressRootsFromEnv({
      OPENRIG_PROGRESS_SCAN_ROOTS: "shared:/abs/shared, hub:/abs/hub",
    });
    expect(roots.map((r) => r.name)).toEqual(["shared", "hub"]);
  });
});

describe("UI Enhancement Pack v0——ProgressIndexer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "progress-indexer-"));
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("未配置 root 时 isReady() = false", () => {
    const indexer = new ProgressIndexer({ roots: [] });
    expect(indexer.isReady()).toBe(false);
    expect(indexer.scan().files).toEqual([]);
  });

  it("至少配置一个 root 时 isReady() = true", () => {
    mkdirSync(join(tempDir, "ws"), { recursive: true });
    const indexer = new ProgressIndexer({ roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }] });
    expect(indexer.isReady()).toBe(true);
  });

  it("遍历 scan root 并发现各层级的 PROGRESS.md 文件", () => {
    mkdirSync(join(tempDir, "ws", "missions", "alpha"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "PROGRESS.md"), "# Top\n- [x] root-done\n- [ ] root-active\n");
    writeFileSync(join(tempDir, "ws", "missions", "alpha", "PROGRESS.md"), "# Alpha\n- [ ] mission-active\n");
    const indexer = new ProgressIndexer({ roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }] });
    const result = indexer.scan();
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.relPath).sort()).toEqual(["PROGRESS.md", "missions/alpha/PROGRESS.md"]);
  });

  it("解析 checkbox state（active / done / blocked）", () => {
    mkdirSync(join(tempDir, "ws"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "PROGRESS.md"),
      "# Test\n- [ ] active item\n- [x] done item\n- [~] blocked item\n");
    const indexer = new ProgressIndexer({ roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }] });
    const result = indexer.scan();
    const file = result.files[0]!;
    const checkboxes = file.rows.filter((r) => r.kind === "checkbox");
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[0]?.status).toBe("active");
    expect(checkboxes[1]?.status).toBe("done");
    expect(checkboxes[2]?.status).toBe("blocked");
    expect(file.counts).toEqual({ total: 3, done: 1, blocked: 1, active: 1 });
  });

  it("为 ## / ### / #### 输出 heading row", () => {
    mkdirSync(join(tempDir, "ws"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "PROGRESS.md"),
      "# Title\n## Section A\n- [ ] item-a\n### Subsection\n- [ ] item-b\n");
    const indexer = new ProgressIndexer({ roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }] });
    const result = indexer.scan();
    const headings = result.files[0]!.rows.filter((r) => r.kind === "heading");
    expect(headings).toHaveLength(2);
    expect(headings[0]?.text).toBe("Section A");
    expect(headings[0]?.depth).toBe(0); // ## → depth 0
    expect(headings[1]?.text).toBe("Subsection");
    expect(headings[1]?.depth).toBe(1); // ### → depth 1
  });

  it("从前导双空格 pair 派生 indent depth", () => {
    mkdirSync(join(tempDir, "ws"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "PROGRESS.md"),
      "- [ ] level0\n  - [ ] level1\n    - [ ] level2\n");
    const indexer = new ProgressIndexer({ roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }] });
    const checkboxes = indexer.scan().files[0]!.rows.filter((r) => r.kind === "checkbox");
    expect(checkboxes.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("解析 row 前移除 YAML frontmatter", () => {
    mkdirSync(join(tempDir, "ws"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "PROGRESS.md"),
      "---\nslice: foo\nstatus: active\n---\n# Title\n- [x] real-row\n");
    const indexer = new ProgressIndexer({ roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }] });
    const file = indexer.scan().files[0]!;
    expect(file.title).toBe("Title");
    expect(file.counts.total).toBe(1);
  });

  it("跳过 dotdir、node_modules、.git、.worktrees、dist", () => {
    mkdirSync(join(tempDir, "ws", "node_modules", "x"), { recursive: true });
    mkdirSync(join(tempDir, "ws", ".git"), { recursive: true });
    mkdirSync(join(tempDir, "ws", ".worktrees", "branch"), { recursive: true });
    mkdirSync(join(tempDir, "ws", "dist"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "node_modules", "x", "PROGRESS.md"), "- [ ] nope\n");
    writeFileSync(join(tempDir, "ws", ".git", "PROGRESS.md"), "- [ ] nope\n");
    writeFileSync(join(tempDir, "ws", ".worktrees", "branch", "PROGRESS.md"), "- [ ] nope\n");
    writeFileSync(join(tempDir, "ws", "dist", "PROGRESS.md"), "- [ ] nope\n");
    writeFileSync(join(tempDir, "ws", "PROGRESS.md"), "- [ ] real\n");
    const indexer = new ProgressIndexer({ roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }] });
    const result = indexer.scan();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.relPath).toBe("PROGRESS.md");
  });

  it("遵守 maxDepth", () => {
    mkdirSync(join(tempDir, "ws", "a", "b", "c", "d"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "a", "b", "c", "d", "PROGRESS.md"), "- [ ] deep\n");
    const indexer = new ProgressIndexer({
      roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }],
      maxDepth: 2,
    });
    expect(indexer.scan().files).toHaveLength(0);
  });

  it("aggregate count 跨文件相加", () => {
    mkdirSync(join(tempDir, "ws", "x"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "PROGRESS.md"), "- [x] a\n- [ ] b\n");
    writeFileSync(join(tempDir, "ws", "x", "PROGRESS.md"), "- [~] c\n- [x] d\n");
    const result = new ProgressIndexer({ roots: [{ name: "ws", canonicalPath: join(tempDir, "ws") }] }).scan();
    expect(result.aggregate.totalFiles).toBe(2);
    expect(result.aggregate.totalRows).toBe(4);
    expect(result.aggregate.totalDone).toBe(2);
    expect(result.aggregate.totalActive).toBe(1);
    expect(result.aggregate.totalBlocked).toBe(1);
  });
});
