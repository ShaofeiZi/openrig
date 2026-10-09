// Slice-03 rig-context ATOM 4（STORE）——remove-by-ref，即 path-like verb set
//（list/show/add/rm）的删除部分。rm 通过封闭的 Atom-1 ref boundary 解析并删除：在任何
// filesystem 修改前，不安全 ref 会成为结构化且可见的 failure；安全但不存在的 ref 会如实返回
// pack_not_found；拒绝删除已交付的 `builtin` pack（rm 从不对已交付 asset 执行 rmSync——add 路径
// 只写入 user_file，rm 镜像此 operator-writable contract）。成功 remove 是持久的：ref 不再可解析，
// directory 也已消失。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

function writePack(root: string, ref: string, name = ref.split("/").at(-1)!): void {
  const dir = join(root, ref);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), `name: ${name}\nversion: 1\ntaxonomy: mission\nfiles:\n  - path: notes.md\n    role: source\n`);
  writeFileSync(join(dir, "notes.md"), "existing bytes");
}

function captureError(fn: () => unknown): ContextPackError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContextPackError);
    return err as ContextPackError;
  }
  throw new Error("预期抛出 ContextPackError");
}

describe("ATOM 4——removeByRef（对 path-like ref 执行 rm）", () => {
  let tmp: string;
  let userRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-rm-"));
    userRoot = join(tmp, "user-store");
    mkdirSync(userRoot, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function service(roots?: Array<{ path: string; sourceType: "builtin" | "user_file" | "workspace" }>): ContextPackLibraryService {
    return new ContextPackLibraryService({
      roots: roots ?? [{ path: userRoot, sourceType: "user_file" }],
    });
  }

  it("删除已发现的用户 pack：ref 不再解析且目录消失", () => {
    writePack(userRoot, "packs/compaction-restore");
    const lib = service();
    lib.scan();
    expect(lib.getByRef("packs/compaction-restore")).not.toBeNull();
    const target = join(userRoot, "packs", "compaction-restore");
    expect(existsSync(target)).toBe(true);

    const result = lib.removeByRef("packs/compaction-restore");

    expect(result).toEqual({ removed: true, ref: "packs/compaction-restore", removedPath: target });
    expect(lib.getByRef("packs/compaction-restore")).toBeNull();
    expect(existsSync(target)).toBe(false);
    expect(lib.list()).toEqual([]);
  });

  it("删除一个 pack 后其他 pack 仍可解析（scan refresh 正确）", () => {
    writePack(userRoot, "packs/one");
    writePack(userRoot, "packs/two");
    const lib = service();
    lib.scan();
    expect(lib.list().map((e) => e.relativePath).sort()).toEqual(["packs/one", "packs/two"]);

    lib.removeByRef("packs/one");

    expect(lib.getByRef("packs/one")).toBeNull();
    expect(lib.getByRef("packs/two")).not.toBeNull();
    expect(existsSync(join(userRoot, "packs", "two", "manifest.yaml"))).toBe(true);
  });

  it("在任何 filesystem 修改前，以结构化 error 拒绝不安全 ref", () => {
    writePack(userRoot, "packs/keep");
    const lib = service();
    lib.scan();

    const err = captureError(() => lib.removeByRef("../escape"));

    expect(err.code).toBe("unsafe_ref");
    expect(err.message).toMatch(/不安全的 pack ref/);
    // sibling pack 未受影响——没有发生删除
    expect(lib.getByRef("packs/keep")).not.toBeNull();
    expect(existsSync(join(userRoot, "packs", "keep", "manifest.yaml"))).toBe(true);
  });

  it("对安全但不存在的 ref 返回 pack_not_found，且不作修改", () => {
    writePack(userRoot, "packs/keep");
    const lib = service();
    lib.scan();

    const err = captureError(() => lib.removeByRef("packs/absent"));

    expect(err.code).toBe("pack_not_found");
    expect(lib.getByRef("packs/keep")).not.toBeNull();
    expect(existsSync(join(userRoot, "packs", "keep"))).toBe(true);
  });

  it("拒绝删除已交付的 builtin pack，且绝不删除其目录", () => {
    const builtinRoot = join(tmp, "builtin-store");
    mkdirSync(builtinRoot, { recursive: true });
    writePack(builtinRoot, "packs/shipped", "shipped");
    const manifestBefore = readFileSync(join(builtinRoot, "packs", "shipped", "manifest.yaml"));
    const lib = service([{ path: builtinRoot, sourceType: "builtin" }]);
    lib.scan();
    expect(lib.getByRef("packs/shipped")).not.toBeNull();

    const err = captureError(() => lib.removeByRef("packs/shipped"));

    expect(err.code).toBe("pack_not_removable");
    // 仍可解析且逐字节保留在磁盘上
    expect(lib.getByRef("packs/shipped")).not.toBeNull();
    expect(readFileSync(join(builtinRoot, "packs", "shipped", "manifest.yaml"))).toEqual(manifestBefore);
  });
});
