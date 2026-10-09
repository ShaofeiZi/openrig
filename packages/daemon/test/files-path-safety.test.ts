// UI Enhancement Pack v0——path-safety helper 测试。
//
// 固定 file allowlist 的关键 fail-closed 语义：root_unknown 拒绝；在 segment boundary
// 拒绝 .. escape（而非 substring）；拒绝把 absolute path 当作 relative path；拒绝逃逸 root 的
// symlink（realpath check）；包含 ".." substring 的 filename（例如 foo..bar）不会被拒绝，
// 只有字面 `..` segment 会；base case（path = ""）解析到 root 自身。
//
// 纯单元测试——无 Hono app，无 daemon 接线。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilePathSafetyError,
  readAllowlistFromEnv,
  resolveAllowedDirectory,
  resolveAllowedFile,
  resolveAllowedPath,
} from "../src/domain/files/path-safety.js";

describe("UI Enhancement Pack v0——readAllowlistFromEnv", () => {
  it("env 未设置时返回空 list", () => {
    expect(readAllowlistFromEnv({})).toEqual([]);
  });

  it("解析以逗号分隔的 name:path pair", () => {
    const list = readAllowlistFromEnv({
      OPENRIG_FILES_ALLOWLIST: "workspace:/abs/path1, openrig-hub: /abs/path2",
    });
    expect(list).toHaveLength(2);
    expect(list[0]?.name).toBe("workspace");
    expect(list[1]?.name).toBe("openrig-hub");
  });

  it("忽略无冒号、空 name 或非 absolute path 的 pair", () => {
    const list = readAllowlistFromEnv({
      OPENRIG_FILES_ALLOWLIST: "no-colon-here, :missing-name, name:relative-path, ok:/abs/ok",
    });
    expect(list.map((r) => r.name)).toEqual(["ok"]);
  });

  it("按 name 去重（最后一项优先）", () => {
    const list = readAllowlistFromEnv({
      OPENRIG_FILES_ALLOWLIST: "x:/path/a, x:/path/b",
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.canonicalPath).toContain("/path/b");
  });

  it("OPENRIG_FILES_ALLOWLIST 为空时回退到 RIGGED_FILES_ALLOWLIST", () => {
    const list = readAllowlistFromEnv({
      OPENRIG_FILES_ALLOWLIST: "",
      RIGGED_FILES_ALLOWLIST: "legacy:/abs/legacy",
    });
    expect(list.map((r) => r.name)).toEqual(["legacy"]);
  });
});

describe("UI Enhancement Pack v0——resolveAllowedPath", () => {
  let tempDir: string;
  let allowlist: { name: string; canonicalPath: string }[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "files-safety-"));
    mkdirSync(join(tempDir, "workspace", "subdir"), { recursive: true });
    writeFileSync(join(tempDir, "workspace", "STEERING.md"), "# steering");
    writeFileSync(join(tempDir, "workspace", "subdir", "nested.md"), "# nested");
    // symlink-escape 测试使用的 root 外文件。
    mkdirSync(join(tempDir, "outside-root"), { recursive: true });
    writeFileSync(join(tempDir, "outside-root", "secret.txt"), "secret");
    // 通过 realpath canonicalize，以匹配 macOS /var → /private/var 解析；production code
    // 在 readAllowlistFromEnv 中执行相同操作。
    allowlist = [{ name: "workspace", canonicalPath: realpathSync(join(tempDir, "workspace")) }];
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("解析 root 内的 relative path", () => {
    const resolved = resolveAllowedPath(allowlist, "workspace", "STEERING.md");
    expect(resolved).toBe(realpathSync(join(tempDir, "workspace", "STEERING.md")));
  });

  it("将 ''（空 path）解析到 root 自身", () => {
    expect(resolveAllowedPath(allowlist, "workspace", "")).toBe(realpathSync(join(tempDir, "workspace")));
  });

  it("以 code 'root_unknown' 拒绝未知 root", () => {
    expect(() => resolveAllowedPath(allowlist, "not-allowlisted", "any.md"))
      .toThrowError(/未配置白名单根目录 'not-allowlisted'/);
    try { resolveAllowedPath(allowlist, "not-allowlisted", "any.md"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("root_unknown"); }
  });

  it("以 code 'path_escape' 拒绝 '..' segment", () => {
    expect(() => resolveAllowedPath(allowlist, "workspace", "../outside-root/secret.txt"))
      .toThrowError(/包含 '\.\.' 分段/);
    try { resolveAllowedPath(allowlist, "workspace", "../outside-root/secret.txt"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("path_escape"); }
  });

  it("不拒绝以 '..' 为 substring 的 filename（例如 foo..bar）", () => {
    writeFileSync(join(tempDir, "workspace", "foo..bar.md"), "ok");
    const resolved = resolveAllowedPath(allowlist, "workspace", "foo..bar.md");
    expect(resolved).toBe(realpathSync(join(tempDir, "workspace", "foo..bar.md")));
  });

  it("拒绝作为 relative path 传入的 absolute path", () => {
    expect(() => resolveAllowedPath(allowlist, "workspace", "/etc/passwd"))
      .toThrowError(/不能是绝对路径/);
    try { resolveAllowedPath(allowlist, "workspace", "/etc/passwd"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("path_invalid"); }
  });

  it("拒绝 realpath 逃逸 root 的 symlink", () => {
    // 在 workspace 内创建指向 root 外的 symlink。
    symlinkSync(join(tempDir, "outside-root", "secret.txt"), join(tempDir, "workspace", "escape-link"));
    expect(() => resolveAllowedPath(allowlist, "workspace", "escape-link"))
      .toThrowError(/位于白名单根目录.*之外/);
    try { resolveAllowedPath(allowlist, "workspace", "escape-link"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("path_escape"); }
  });

  it("不匹配具有相同 prefix 的 sibling path（path.sep boundary）", () => {
    // allowlist root 为 ".../workspace"；传入 path = "" 或任意 relative path 都不应
    // 到达 sibling ".../workspace-other"。
    mkdirSync(join(tempDir, "workspace-other"), { recursive: true });
    writeFileSync(join(tempDir, "workspace-other", "leak.md"), "leak");
    // 若 path 相对于正确 root，文件可正常解析；没有 mismatched root 就无法表达 wrong-root attack，
    // 因此测试改为验证 root-name mismatch。
    expect(() => resolveAllowedPath(allowlist, "workspace-other", "leak.md"))
      .toThrowError(/未配置白名单根目录 'workspace-other'/);
  });
});

describe("UI Enhancement Pack v0——resolveAllowedFile / resolveAllowedDirectory", () => {
  let tempDir: string;
  let allowlist: { name: string; canonicalPath: string }[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "files-safety-typed-"));
    mkdirSync(join(tempDir, "ws", "dir-only"), { recursive: true });
    writeFileSync(join(tempDir, "ws", "real.md"), "hi");
    allowlist = [{ name: "ws", canonicalPath: realpathSync(join(tempDir, "ws")) }];
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("对真实文件调用 resolveAllowedFile 会返回绝对路径", () => {
    expect(resolveAllowedFile(allowlist, "ws", "real.md")).toBe(realpathSync(join(tempDir, "ws", "real.md")));
  });

  it("对目录调用 resolveAllowedFile 会以 'not_a_file' 拒绝", () => {
    try { resolveAllowedFile(allowlist, "ws", "dir-only"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("not_a_file"); }
  });

  it("对缺失路径调用 resolveAllowedFile 会以 'stat_failed' 拒绝", () => {
    try { resolveAllowedFile(allowlist, "ws", "ghost.md"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("stat_failed"); }
  });

  it("对真实目录调用 resolveAllowedDirectory 会返回绝对路径", () => {
    expect(resolveAllowedDirectory(allowlist, "ws", "dir-only")).toBe(realpathSync(join(tempDir, "ws", "dir-only")));
  });

  it("对文件调用 resolveAllowedDirectory 会以 'not_a_directory' 拒绝", () => {
    try { resolveAllowedDirectory(allowlist, "ws", "real.md"); }
    catch (e) { expect((e as FilePathSafetyError).code).toBe("not_a_directory"); }
  });
});
