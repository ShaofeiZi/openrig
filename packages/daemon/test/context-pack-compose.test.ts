import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { assemblePlainFiles, PLAIN_COMPOSE_SEPARATOR } from "../src/domain/context-packs/bundle-assembler.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { ContextPackError } from "../src/domain/context-packs/context-pack-types.js";

function writePack(root: string, ref: string, name = "existing"): void {
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

describe("ATOM 3——按顺序组合 plain file", () => {
  it.each([
    ["A", "B", `A${PLAIN_COMPOSE_SEPARATOR}B`],
    ["A\n", "B", `A\n${PLAIN_COMPOSE_SEPARATOR}B`],
    ["A", "B\n", `A${PLAIN_COMPOSE_SEPARATOR}B\n`],
    ["A\n", "B\n", `A\n${PLAIN_COMPOSE_SEPARATOR}B\n`],
  ])("保留 EOF 换行 byte：%j + %j", (a, b, expected) => {
    const result = assemblePlainFiles({
      files: [
        { path: "a.md", content: a },
        { path: "b.md", content: b },
      ],
    });
    expect(result.text).toBe(expected);
    expect(result.text).not.toContain("# zrig 上下文包：");
    expect(result.text).not.toContain("## 文件：");
    expect(result.bytes).toBe(Buffer.byteLength(expected));
  });

  it("呈现缺失 member，而不伪造内容", () => {
    const result = assemblePlainFiles({
      files: [
        { path: "present.md", content: "present" },
        { path: "absent.md", content: null },
      ],
    });
    expect(result.text).toBe("present");
    expect(result.missingFiles).toEqual([{ path: "absent.md" }]);
  });
});

describe("ATOM 3——durable compose 到 Atom-2 ref store", () => {
  let tmp: string;
  let userRoot: string;
  let sourceRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-compose-"));
    userRoot = join(tmp, "user-store");
    sourceRoot = join(tmp, "sources");
    mkdirSync(sourceRoot, { recursive: true });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function service(extra?: Record<string, unknown>): ContextPackLibraryService {
    return new ContextPackLibraryService({
      roots: [{ path: userRoot, sourceType: "user_file" }],
      ...extra,
    });
  }

  function source(name: string, content: string): string {
    const path = join(sourceRoot, name);
    writeFileSync(path, content);
    return path;
  }

  it("每个 source 写入一个逐字节一致的 member，manifest 顺序确定，pack 可按 ref 解析", () => {
    const a = source("a.md", "---\naudience: dev\n---\nA\n");
    const c = source("c.yaml", "audience: dev\n");
    const b = source("b.data", "B-without-newline");
    const lib = service();
    const injectionShapedLabel = "a:\nfiles:\n  - path: forged.md";

    const result = lib.composeFromFiles({
      outRef: "packs/qitem-brief",
      sources: [
        { path: a, label: injectionShapedLabel },
        { path: c, label: "c.yaml" },
        { path: b, label: "b.data" },
      ],
    });

    const target = join(userRoot, "packs", "qitem-brief");
    const manifest = parseYaml(readFileSync(join(target, "manifest.yaml"), "utf-8")) as {
      name: string;
      version: string;
      files: Array<{ path: string; role: string; summary: string }>;
    };
    expect(manifest).toEqual({
      name: "qitem-brief",
      version: "1",
      purpose: "由 3 个有序文件组合而成",
      taxonomy: "mission",
      files: [
        { path: "source-0001.md", role: "source", summary: injectionShapedLabel },
        { path: "source-0002.yaml", role: "source", summary: "c.yaml" },
        { path: "source-0003.txt", role: "source", summary: "b.data" },
      ],
    });
    expect(readFileSync(join(target, "source-0001.md"))).toEqual(readFileSync(a));
    expect(readFileSync(join(target, "source-0002.yaml"))).toEqual(readFileSync(c));
    expect(readFileSync(join(target, "source-0003.txt"))).toEqual(readFileSync(b));
    expect(result.text).toBe(
      `${readFileSync(a, "utf-8")}${PLAIN_COMPOSE_SEPARATOR}` +
      `${readFileSync(c, "utf-8")}${PLAIN_COMPOSE_SEPARATOR}${readFileSync(b, "utf-8")}`,
    );
    expect(result.ref).toBe("packs/qitem-brief");
    expect(result.entry.relativePath).toBe("packs/qitem-brief");
    expect(lib.list().map((entry) => entry.relativePath)).toEqual(["packs/qitem-brief"]);
    expect(lib.getByRef("packs/qitem-brief")?.sourcePath).toBe(target);
  });

  it("创建 store root 前拒绝不安全 ref", () => {
    const a = source("a.md", "A");
    const err = captureError(() => service().composeFromFiles({
      outRef: "../escape",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("unsafe_ref");
    expect(existsSync(userRoot)).toBe(false);
  });

  it("呈现缺失 source，且不修改 store", () => {
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/missing",
      sources: [{ path: join(sourceRoot, "absent.md"), label: "absent.md" }],
    }));
    expect(err.code).toBe("missing_files");
    expect(err.details?.["missingFiles"]).toEqual([join(sourceRoot, "absent.md")]);
    expect(existsSync(userRoot)).toBe(false);
  });

  it("在检查或修改 store 前，对空 source list 使用 missing_files", () => {
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/empty",
      sources: [],
    }));
    expect(err.code).toBe("missing_files");
    expect(err.details?.["missingFiles"]).toEqual([]);
    expect(existsSync(userRoot)).toBe(false);
  });

  it("呈现不可读/非文件 source，且不修改 store", () => {
    const dir = join(sourceRoot, "directory.md");
    mkdirSync(dir);
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/unreadable",
      sources: [{ path: dir, label: "directory.md" }],
    }));
    expect(err.code).toBe("file_read_failed");
    expect(existsSync(userRoot)).toBe(false);
  });

  it("触碰用户 target 前拒绝任意 discovery root 中的 exact-ref conflict", () => {
    const workspaceRoot = join(tmp, "workspace-store");
    writePack(workspaceRoot, "packs/taken", "workspace-pack");
    const a = source("a.md", "A");
    const lib = new ContextPackLibraryService({
      roots: [
        { path: userRoot, sourceType: "user_file" },
        { path: workspaceRoot, sourceType: "workspace" },
      ],
    });
    const err = captureError(() => lib.composeFromFiles({
      outRef: "packs/taken",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("pack_exists");
    expect(existsSync(join(userRoot, "packs", "taken"))).toBe(false);
    expect(lib.getByRef("packs/taken")?.name).toBe("workspace-pack");
  });

  it("在 existing-ref conflict 前报告完整 source preflight，且不作修改", () => {
    const workspaceRoot = join(tmp, "workspace-store");
    writePack(workspaceRoot, "packs/taken", "workspace-pack");
    const existingManifest = readFileSync(join(workspaceRoot, "packs", "taken", "manifest.yaml"));
    const missing = join(sourceRoot, "absent.md");
    const lib = new ContextPackLibraryService({
      roots: [
        { path: userRoot, sourceType: "user_file" },
        { path: workspaceRoot, sourceType: "workspace" },
      ],
    });

    const err = captureError(() => lib.composeFromFiles({
      outRef: "packs/taken",
      sources: [{ path: missing, label: "absent.md" }],
    }));

    expect(err.code).toBe("missing_files");
    expect(err.details?.["missingFiles"]).toEqual([missing]);
    expect(existsSync(join(userRoot, "packs", "taken"))).toBe(false);
    expect(readFileSync(join(workspaceRoot, "packs", "taken", "manifest.yaml"))).toEqual(existingManifest);
  });

  it("拒绝没有 manifest 的实体用户 target，且不覆盖它", () => {
    const target = join(userRoot, "packs", "taken");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "sentinel"), "keep-me");
    const a = source("a.md", "A");
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/taken",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("pack_exists");
    expect(readFileSync(join(target, "sentinel"), "utf-8")).toBe("keep-me");
    expect(existsSync(join(target, "manifest.yaml"))).toBe(false);
  });

  it("拒绝位于 manifest-bearing leaf 下的 ref，且零修改", () => {
    writePack(userRoot, "packs", "leaf-pack");
    const a = source("a.md", "A");
    const err = captureError(() => service().composeFromFiles({
      outRef: "packs/hidden-child",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("pack_ref_below_pack");
    expect(existsSync(join(userRoot, "packs", "hidden-child"))).toBe(false);
  });

  it("拒绝 symlink 与非目录 namespace segment，且零修改", () => {
    const a = source("a.md", "A");
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    mkdirSync(userRoot);
    symlinkSync(outside, join(userRoot, "linked"));
    let err = captureError(() => service().composeFromFiles({
      outRef: "linked/escape",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("unsafe_ref_namespace");
    expect(existsSync(join(outside, "escape"))).toBe(false);

    writeFileSync(join(userRoot, "blocked"), "not-a-directory");
    err = captureError(() => service().composeFromFiles({
      outRef: "blocked/child",
      sources: [{ path: a, label: "a.md" }],
    }));
    expect(err.code).toBe("unsafe_ref_namespace");
    expect(readFileSync(join(userRoot, "blocked"), "utf-8")).toBe("not-a-directory");
  });

  it("member 写入失败时清理新建 target；不留下 manifest/ref", () => {
    const a = source("a.md", "A");
    const b = source("b.md", "B");
    let writes = 0;
    const lib = service({
      writeFile: (path: string, data: string | Buffer) => {
        writes += 1;
        if (writes === 2) throw new Error("injected write failure");
        writeFileSync(path, data);
      },
    });
    const err = captureError(() => lib.composeFromFiles({
      outRef: "packs/write-fails",
      sources: [{ path: a, label: "a.md" }, { path: b, label: "b.md" }],
    }));
    expect(err.code).toBe("pack_write_failed");
    expect(existsSync(join(userRoot, "packs", "write-fails"))).toBe(false);
    expect(lib.getByRef("packs/write-fails")).toBeNull();
  });
});
