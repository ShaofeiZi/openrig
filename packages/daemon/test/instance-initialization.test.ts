import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ensureOpenRigInstance,
  openRigContextLibraryRoots,
} from "../src/domain/instance-initialization.js";

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openrig-instance-init-"));
  roots.push(root);
  return root;
}

function tree(root: string): Array<{ path: string; kind: "directory" | "file"; content?: string }> {
  const out: Array<{ path: string; kind: "directory" | "file"; content?: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (statSync(abs).isDirectory()) {
        out.push({ path: rel, kind: "directory" });
        walk(abs);
      } else {
        out.push({ path: rel, kind: "file", content: readFileSync(abs, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical OpenRig instance 初始化", () => {
  it("同时声明 canonical addressable 与 System World library root", () => {
    expect(openRigContextLibraryRoots("/instance/context")).toEqual([
      "/instance/context",
      "/instance/context/system",
    ]);
  });

  it("通过一个幂等 owner 创建 canonical root 与 S01 workspace", () => {
    const parent = freshRoot();
    const home = join(parent, "home");

    const first = ensureOpenRigInstance({ home });
    const firstTree = tree(home);
    const second = ensureOpenRigInstance({ home });

    expect(first.ok).toBe(true);
    expect(first.createdPaths.length).toBeGreaterThan(0);
    expect(second).toMatchObject({ ok: true, createdPaths: [], conflicts: [] });
    expect(tree(home)).toEqual(firstTree);
    expect(firstTree).toEqual(expect.arrayContaining([
      { path: "config.json", kind: "file", content: "{}\n" },
      { path: "state", kind: "directory" },
      { path: "context", kind: "directory" },
      { path: "context/system", kind: "directory" },
      { path: "context/system/system-world.yaml", kind: "file", content: expect.stringContaining("schema: openrig.system-world/v0alpha1") },
      { path: "skills", kind: "directory" },
      { path: "workspace", kind: "directory" },
      { path: "workspace/missions", kind: "directory" },
      { path: "workspace/exhaust", kind: "directory" },
      { path: "specs", kind: "directory" },
      { path: "topology", kind: "directory" },
      { path: "plugins", kind: "directory" },
      { path: "run", kind: "directory" },
      { path: "logs", kind: "directory" },
      { path: "transcripts", kind: "directory" },
      { path: "backups", kind: "directory" },
      { path: "secrets", kind: "directory" },
    ]));
  });

  it("逐字节保留用户拥有的文件", () => {
    const home = join(freshRoot(), "home");
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "config.json"), "{\"operator\":true}\n");
    writeFileSync(join(home, "workspace", "SPEC.md"), "# Mine\n");

    const result = ensureOpenRigInstance({ home });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe("{\"operator\":true}\n");
    expect(readFileSync(join(home, "workspace", "SPEC.md"), "utf8")).toBe("# Mine\n");
  });

  it("准确报告类型冲突，且不执行部分写入", () => {
    const home = join(freshRoot(), "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "context"), "owned file\n");

    const result = ensureOpenRigInstance({ home });

    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([
      { path: join(home, "context"), expected: "directory", actual: "file" },
    ]);
    expect(existsSync(join(home, "state"))).toBe(false);
    expect(readFileSync(join(home, "context"), "utf8")).toBe("owned file\n");
  });

  it("把用户拥有的 symlink 视为冲突，而不是穿透写入", () => {
    const parent = freshRoot();
    const home = join(parent, "home");
    const outside = join(parent, "outside");
    mkdirSync(home, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(home, "context"));

    const result = ensureOpenRigInstance({ home });

    expect(result.conflicts).toContainEqual({
      path: join(home, "context"),
      expected: "directory",
      actual: "other",
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(home, "state"))).toBe(false);
  });
});
