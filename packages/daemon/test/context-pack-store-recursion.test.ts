// Slice-03 rig-context 原子 2（存储）——递归的路径寻址发现，在发现与解析信任边界
// 使用已封存的原子 1 assertSafePackRef（规范 §2：“引用就是契约……稳定、类似路径的
// 地址（例如 `packs/compaction-restore`、`as-built/queue-internals`）”）。
// PM 关注项（编排）：矩阵依据 §2 与封存契约逐字断言逐段/遍历拒绝行为——绝不只是
// 断言调用发生过。冒号 ID 寻址保持不变（移除属于后续原子）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";
import { openRigContextLibraryRoots } from "../src/domain/instance-initialization.js";

function writePackAt(root: string, refPath: string, name: string, version = "1") {
  const dir = join(root, refPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), `
name: ${name}
version: ${version}
taxonomy: world
purpose: test pack
files:
  - path: notes.md
    role: notes
`);
  writeFileSync(join(dir, "notes.md"), `# ${name}\n`);
}

describe("原子 2——递归路径寻址发现（规范 §2 引用）", () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ctx-store-recursion-"));
    root = join(tmp, "store");
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const lib = () => new ContextPackLibraryService({ roots: [{ path: root, sourceType: "user_file" }] });

  it("发现规范自身的示例引用——两层的 `packs/compaction-restore` 与 `as-built/queue-internals`（红灯：单层扫描会漏掉）", () => {
    writePackAt(root, "packs/compaction-restore", "compaction-restore");
    writePackAt(root, "as-built/queue-internals", "queue-internals");
    const service = lib();
    const result = service.scan();
    expect(result.errors).toEqual([]);
    expect(result.count).toBe(2);
    const refs = service.list().map((e) => e.relativePath).sort();
    expect(refs).toEqual(["as-built/queue-internals", "packs/compaction-restore"]);
  });

  it("单层包保持现有形态（ref = 目录名），更深层嵌套也可用", () => {
    writePackAt(root, "flat", "flat");
    writePackAt(root, "a/b/c", "deep");
    const service = lib();
    expect(service.scan().count).toBe(2);
    expect(service.list().map((e) => e.relativePath).sort()).toEqual(["a/b/c", "flat"]);
  });

  it("通过真实重叠启动根目录为 System World 包分配单一身份", () => {
    writePackAt(root, "system/baseline", "system-baseline");
    const service = new ContextPackLibraryService({
      roots: openRigContextLibraryRoots(root).map((path) => ({ path, sourceType: "user_file" })),
    });

    const result = service.scan();

    expect(result).toMatchObject({ count: 1, errors: [] });
    expect(service.list().map((entry) => entry.relativePath)).toEqual(["system/baseline"]);
    expect(service.getByRef("baseline")).toBeNull();
  });

  it("通过真实启动根目录保持同名顶层包与 System World 包相互独立", () => {
    writePackAt(root, "baseline", "operator-baseline");
    writePackAt(root, "system/baseline", "system-baseline");
    const service = new ContextPackLibraryService({
      roots: openRigContextLibraryRoots(root).map((path) => ({ path, sourceType: "user_file" })),
    });

    const result = service.scan();

    expect(result).toMatchObject({ count: 2, errors: [] });
    expect(service.getByRef("baseline")?.sourcePath).toBe(join(root, "baseline"));
    expect(service.getByRef("system/baseline")?.sourcePath).toBe(join(root, "system", "baseline"));
  });

  it("包是叶节点：包目录下方的清单属于该包子树，不会被索引为独立包", () => {
    writePackAt(root, "outer", "outer");
    writePackAt(root, "outer/inner", "inner"); // 位于包含清单的目录下方
    const service = lib();
    const result = service.scan();
    expect(result.count).toBe(1);
    expect(service.list()[0]!.relativePath).toBe("outer");
  });

  it("发现边界：不安全的磁盘引用产生结构化、失败可见的错误，且跳过该包（绝不索引）", () => {
    writePackAt(root, "bad name", "badpack"); // 含空白的段——依据封存契约不安全
    writePackAt(root, "good", "goodpack");
    const service = lib();
    const result = service.scan();
    expect(result.count).toBe(1); // 仅索引安全包
    expect(service.list().map((e) => e.relativePath)).toEqual(["good"]);
    expect(result.errors).toHaveLength(1); // 失败可见且结构化
    expect(result.errors[0]!.source).toContain("bad name");
    expect(result.errors[0]!.error).toMatch(/不安全的 pack ref/);
    expect(result.errors[0]!.error).toMatch(/'\/' 分隔的路径段/); // 逐字匹配封存的逐段契约
  });

  it("解析边界：getByRef 对安全引用返回条目，对安全但不存在的引用返回 null", () => {
    writePackAt(root, "packs/compaction-restore", "compaction-restore");
    const service = lib();
    service.scan();
    const entry = service.getByRef("packs/compaction-restore");
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe("compaction-restore");
    expect(entry!.relativePath).toBe("packs/compaction-restore");
    expect(service.getByRef("packs/absent")).toBeNull();
  });

  // PM 关注项逐字矩阵：每个案例对应 §2/封存契约中的条款，固定的是实际拒绝行为——
  // 结构化 ContextPackError，且消息携带封存模块中的逐段契约文本。
  it.each([
    ["遍历段", "../escape"],
    ["内部遍历", "a/../b"],
    ["点号段", "packs/./x"],
    ["绝对路径（首段为空）", "/abs"],
    ["内部空段", "a//b"],
    ["尾部斜杠（空段）", "a/"],
    ["段内空白", "bad name"],
    ["段内冒号注入", "a:b"],
    ["空引用", ""],
    ["前导点（点文件段）", ".hidden/x"],
  ])("解析边界以结构化错误拒绝 %s（`%s`），且不执行查找", (_label, ref) => {
    writePackAt(root, "good", "goodpack");
    const service = lib();
    service.scan();
    let thrown: unknown;
    try {
      service.getByRef(ref);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ContextPackError);
    expect((thrown as ContextPackError).code).toBe("unsafe_ref");
    expect((thrown as ContextPackError).message).toMatch(/不安全的 pack ref/);
  });

  it("护栏探针 1（标准）：清单名称/版本相同的不同引用保持独立——每个引用解析到各自的物理包", () => {
    writePackAt(root, "packs/a", "same", "1");
    writePackAt(root, "packs/b", "same", "1");
    const service = lib();
    const result = service.scan();
    expect(result.errors).toEqual([]);
    expect(result.count).toBe(2); // ref 是主要身份——不会合并
    expect(service.list().map((e) => e.relativePath).sort()).toEqual(["packs/a", "packs/b"]);
    const a = service.getByRef("packs/a");
    const b = service.getByRef("packs/b");
    expect(a!.sourcePath.endsWith("packs/a")).toBe(true);
    expect(b!.sourcePath.endsWith("packs/b")).toBe(true);
  });

  it("护栏探针 2（标准）：跨根目录的同一引用处处遵循后根胜出——列表一行、计数为一，并解析到最后条目", () => {
    const rootB = join(tmp, "storeB2");
    mkdirSync(rootB, { recursive: true });
    writePackAt(root, "packs/dup", "first", "1");
    writePackAt(rootB, "packs/dup", "second", "2");
    const service = new ContextPackLibraryService({
      roots: [
        { path: root, sourceType: "builtin" },
        { path: rootB, sourceType: "user_file" },
      ],
    });
    const result = service.scan();
    expect(result.count).toBe(1); // 不是两个——优先级应用于整个索引
    const rows = service.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("second");
    expect(service.getByRef("packs/dup")!.version).toBe("2");
  });

  it("两个根目录提供同一引用时后根胜出（与 ID 索引优先级一致）", () => {
    const rootB = join(tmp, "storeB");
    mkdirSync(rootB, { recursive: true });
    writePackAt(root, "packs/dup", "dup", "1");
    writePackAt(rootB, "packs/dup", "dup", "2");
    const service = new ContextPackLibraryService({
      roots: [
        { path: root, sourceType: "builtin" },
        { path: rootB, sourceType: "user_file" },
      ],
    });
    service.scan();
    expect(service.getByRef("packs/dup")!.version).toBe("2");
  });

  it("跨根目录的同引用覆盖按后根胜出解析；不同引用保持不同 ID（原子 5——不再按旧共享 ID 合并）", () => {
    // packs/a 在两个根目录中都存在（root-2 覆盖）；packs/b 仅在 root-1 中。
    // ref 就是身份：packs/a → 后根（user_file）胜出；packs/b → builtin。虽然三者都共享
    // 清单 same:1，但两个保留的引用仍有不同 ID——旧版 name:version ID 会把它们合并为
    // 一次共享 ID 解析（此切片消除了这种遮蔽）。
    const rootB = join(tmp, "storeB3");
    mkdirSync(rootB, { recursive: true });
    writePackAt(root, "packs/a", "same", "1");
    writePackAt(root, "packs/b", "same", "1");
    writePackAt(rootB, "packs/a", "same", "1");
    const service = new ContextPackLibraryService({
      roots: [
        { path: root, sourceType: "builtin" },
        { path: rootB, sourceType: "user_file" },
      ],
    });
    const result = service.scan();
    expect(result.count).toBe(2); // 主要 ref 语义不变
    expect(service.getByRef("packs/a")!.sourceType).toBe("user_file"); // root-2 覆盖值赢得引用
    expect(service.getByRef("packs/b")!.sourceType).toBe("builtin");
    expect(service.getByRef("packs/a")!.id).toBe("context-pack:packs/a");
    expect(service.getByRef("packs/b")!.id).toBe("context-pack:packs/b");
    expect(service.getByRef("packs/a")!.id).not.toBe(service.getByRef("packs/b")!.id);
  });

  it("冒号 ID 寻址已移除（原子 5）：ID 为 context-pack:<ref>，仅按 ref 解析", () => {
    writePackAt(root, "packs/compaction-restore", "compaction-restore", "3");
    const service = lib();
    service.scan();
    const entry = service.getByRef("packs/compaction-restore");
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("context-pack:packs/compaction-restore");
    // 服务上不再存在旧版冒号 ID 访问器
    expect((service as unknown as { get?: unknown }).get).toBeUndefined();
  });

  it("发现期间不遍历符号链接目录（现有 lstat-dirent 语义延续到递归）", () => {
    writePackAt(root, "real/target", "target");
    // 树中其他位置的符号链接不得形成第二条发现路径
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync(join(root, "real"), join(root, "alias"));
    const service = lib();
    const result = service.scan();
    expect(result.count).toBe(1);
    expect(service.list()[0]!.relativePath).toBe("real/target");
  });
});
