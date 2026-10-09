// OPR.0.5.3.5 Atom 4a——统一语法背后的两个 `#` 前解析器（Q2 修订 1 的语法裁决）：
// 非 library 来源使用相同的 `#H2-slug/H3-slug` 语法；只有 `#` 前解析器不同——library 引用
// 相对 pack 解析，tree 引用（`project:` / `seat:` / `mission:` 前缀）从已配置根目录解析
//（CE-v2 03-tree-addressability：来自配置，绝非字面量），且两者都在解析失败时响亮报错。
// 不引入第二套寻址约定。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  parseSourceRef,
  makeProfileReadFile,
  sourceKindForAddress,
  SourceResolutionError,
} from "../src/domain/context-packs/profile-source-resolver.js";

let root: string;
let packDir: string;
let projectRoot: string;
let seatRoot: string;
let missionRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "s05-sources-"));
  packDir = join(root, "pack");
  projectRoot = join(root, "project-tree");
  seatRoot = join(root, "seat-tree");
  missionRoot = join(root, "mission-tree");
  for (const d of [packDir, projectRoot, seatRoot, missionRoot]) mkdirSync(d, { recursive: true });
  writeFileSync(join(packDir, "walk.md"), "## Welcome\nhello");
  writeFileSync(join(projectRoot, "SPEC.md"), "# Project\nproject intent");
  writeFileSync(join(seatRoot, "RECAP.md"), "## Recent Decisions\nwe chose X because Y");
  writeFileSync(join(missionRoot, "NOTES.md"), "## Watch Items\nW-1");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseSourceRef——统一语法，以 # 前缀区分 kind", () => {
  it("裸引用属于 library，project:/seat:/mission: 前缀指定 tree 解析器", () => {
    expect(parseSourceRef("walk.md")).toEqual({ kind: "library", rel: "walk.md" });
    expect(parseSourceRef("project:SPEC.md")).toEqual({ kind: "project", rel: "SPEC.md" });
    expect(parseSourceRef("seat:RECAP.md")).toEqual({ kind: "seat", rel: "RECAP.md" });
    expect(parseSourceRef("mission:notes/NOTES.md")).toEqual({ kind: "mission", rel: "notes/NOTES.md" });
  });
  it("对未知前缀和遍历形状引用响亮失败（不暴露堆栈，绝不逃逸）", () => {
    expect(() => parseSourceRef("library2:x.md")).toThrow(SourceResolutionError);
    expect(() => parseSourceRef("seat:../LEARNED.md")).toThrow(SourceResolutionError);
    expect(() => parseSourceRef("seat:/etc/passwd")).toThrow(SourceResolutionError);
    expect(() => parseSourceRef("seat:")).toThrow(SourceResolutionError);
  });
});

describe("makeProfileReadFile——配置解析根目录，读取失败时响亮报错", () => {
  it("将 library 引用派发到 pack 目录，将 tree 引用派发到各自配置根目录", () => {
    const read = makeProfileReadFile({ packDir, roots: { project: projectRoot, seat: seatRoot, mission: missionRoot } });
    expect(read("walk.md")).toContain("hello");
    expect(read("project:SPEC.md")).toContain("project intent");
    expect(read("seat:RECAP.md")).toContain("we chose X because Y");
    expect(read("mission:NOTES.md")).toContain("W-1");
  });

  it("文件缺失时响亮失败，并点名来源 kind 和解析路径", () => {
    const read = makeProfileReadFile({ packDir, roots: { seat: seatRoot, mission: missionRoot } });
    try {
      read("seat:GONE.md");
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SourceResolutionError);
      expect((err as Error).message).toContain("seat");
      expect((err as Error).message).toContain("GONE.md");
    }
  });

  it("tree 引用指向未配置根目录时响亮失败并点名缺失配置，绝不静默返回空", () => {
    const read = makeProfileReadFile({ packDir, roots: {} });
    expect(() => read("seat:RECAP.md")).toThrow(/seat.*tree 根|tree 根.*seat/);
  });
});

describe("sourceKindForAddress——逐片段标签输入（Q2 修订 1 绑定）", () => {
  it("从 atom 地址前缀推导 composer 的来源标签", () => {
    expect(sourceKindForAddress("walk.md#welcome")).toBe("library");
    expect(sourceKindForAddress("project:SPEC.md")).toBe("project");
    expect(sourceKindForAddress("seat:RECAP.md#recent-decisions")).toBe("seat");
    expect(sourceKindForAddress("mission:NOTES.md")).toBe("mission");
  });
});
