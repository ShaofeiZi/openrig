// PL-007 Workspace Primitive v0——frontmatter validator 测试。
//
// 锁定项：
//   - knowledge canon 各 kind 的 missing-required-field
//   - status 不在允许 enum 中时为 unrecognized-status-value
//   - frontmatter 是 malformed YAML 时为 parse-error
//   - 干净 canon（所有字段存在 + status 有效）返回 0 gap
//   - 非 recursive scope 只遍历顶层
//   - 跳过噪声目录（node_modules / .git）

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateWorkspaceFrontmatter } from "../src/domain/workspace/frontmatter-validator.js";

let dir: string;

function write(rel: string, contents: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, "utf-8");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl007-fmv-"));
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略。 */ }
});

describe("validateWorkspaceFrontmatter (PL-007)", () => {
  it("干净 knowledge canon：0 个 gap", () => {
    write("alpha.md", "---\ndoc: alpha\nstatus: active\ncreated: 2026-05-04\nowner: someone\n---\n# Alpha\n");
    write("beta.md",  "---\ndoc: beta\nstatus: draft\ncreated: 2026-05-04\nowner: someone\n---\n# Beta\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.totalFiles).toBe(2);
    expect(r.filesWithFrontmatter).toBe(2);
    expect(r.gapCount).toBe(0);
  });

  it("knowledge canon 缺少 owner 时报告 missing-required-field", () => {
    write("alpha.md", "---\ndoc: alpha\nstatus: active\ncreated: 2026-05-04\n---\n# alpha\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.gapCount).toBe(1);
    expect(r.gaps[0]?.kind).toBe("missing-required-field");
    expect(r.gaps[0]?.field).toBe("owner");
  });

  it("status 无效时报告 unrecognized-status-value", () => {
    write("a.md", "---\ndoc: a\nstatus: in-flight\ncreated: 2026-05-04\nowner: x\n---\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.gaps.some((g) => g.kind === "unrecognized-status-value")).toBe(true);
  });

  it("frontmatter YAML 格式错误时报告 parse-error", () => {
    write("a.md", "---\nthis: is\n  bad: ye:s::\n---\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.gaps.some((g) => g.kind === "parse-error")).toBe(true);
  });

  it("user kind 的必需字段集合更轻", () => {
    write("a.md", "---\ndoc: u\n---\n# u\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "user" });
    expect(r.gapCount).toBe(0);
  });

  it("默认不报告 missing-frontmatter；requireFrontmatter=true 时报告", () => {
    write("a.md", "# alpha\nplain markdown, no fm\n");
    const def = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(def.gapCount).toBe(0);
    const strict = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge", requireFrontmatter: true });
    expect(strict.gaps.some((g) => g.kind === "missing-frontmatter")).toBe(true);
  });

  it("跳过 node_modules 与 .git 噪声目录", () => {
    write("node_modules/a.md", "---\ndoc: a\n---\n");
    write(".git/b.md", "---\ndoc: b\n---\n");
    write("real.md", "---\ndoc: real\nstatus: active\ncreated: 2026-05-04\nowner: x\n---\n");
    const r = validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(r.totalFiles).toBe(1);
  });

  it("non-recursive 只遍历顶层", () => {
    write("a.md", "---\ndoc: a\n---\n");
    write("nested/b.md", "---\ndoc: b\n---\n");
    const r = validateWorkspaceFrontmatter({ root: dir, recursive: false });
    expect(r.totalFiles).toBe(1);
  });

  it("绝不修改任何输入文件（advisory contract）", () => {
    const content = "---\ndoc: a\nstatus: rotten\n---\nbody\n";
    write("a.md", content);
    validateWorkspaceFrontmatter({ root: dir, workspaceKind: "knowledge" });
    expect(fs.readFileSync(path.join(dir, "a.md"), "utf-8")).toBe(content);
  });
});
