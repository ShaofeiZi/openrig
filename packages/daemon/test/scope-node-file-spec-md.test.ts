// 后台服务侧 SPEC.md work-node 解析。
//
// 后台服务无法导入 packages/cli，因此按同一契约维护自己的 resolver：SPEC.md 是用户编写的
// node file；README.md 是永久有效的 legacy 名称。这些测试固定契约的后台服务一侧，包括拒绝
// plan-lock 的 surface；若 `zrig scope slice approve` 看不到 SPEC-backed slice，整个 SDLC 流程
// 都会在此终止。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveNodeFile, withSpecFirst, isNodeFile, resolveNodeFileVia } from "../src/domain/scope/node-file.js";
import { projectSliceScope, type ScopeFsDeps } from "../src/domain/scope/scope-view-projection.js";

const SLICE_BODY = `---
id: OPR.9.9.9.1
slice: 01-spec-backed
mission: release-9.9.9
status: spec
---

# Slice 01 — spec-backed

## Intent

Prove the daemon reads a SPEC.md-backed slice.

## Proof contract

- [ ] Something provable.
`;

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-spec-md-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function nodeDir(name: string, fileName: string, body = SLICE_BODY): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), body, "utf8");
  return dir;
}

describe("后台服务 node-file 解析", () => {
  it("解析 SPEC.md，回退到 README.md，两者都没有时返回 null", () => {
    expect(resolveNodeFile(nodeDir("a", "SPEC.md"))).toBe(path.join(root, "a", "SPEC.md"));
    expect(resolveNodeFile(nodeDir("b", "README.md"))).toBe(path.join(root, "b", "README.md"));
    const both = nodeDir("c", "SPEC.md");
    fs.writeFileSync(path.join(both, "README.md"), "legacy", "utf8");
    expect(resolveNodeFile(both)).toBe(path.join(both, "SPEC.md"));
    fs.mkdirSync(path.join(root, "d"), { recursive: true });
    expect(resolveNodeFile(path.join(root, "d"))).toBeNull();
  });

  // 多个 reader 已按各自 surface 选定的顺序搜索多个 authored filename。SPEC.md 加到每个列表
  // 最前面，但不得重新排序已有内容。
  it("把 SPEC.md 加到最前，同时保留各列表原有优先级顺序", () => {
    expect(withSpecFirst(["IMPLEMENTATION-PRD.md", "README.md", "PROGRESS.md"]))
      .toEqual(["SPEC.md", "IMPLEMENTATION-PRD.md", "README.md", "PROGRESS.md"]);
    expect(withSpecFirst(["README.md", "IMPLEMENTATION-PRD.md", "PROGRESS.md"]))
      .toEqual(["SPEC.md", "README.md", "IMPLEMENTATION-PRD.md", "PROGRESS.md"]);
    // 幂等：已以 SPEC.md 开头的列表不会增加重复项。
    expect(withSpecFirst(["SPEC.md", "README.md"])).toEqual(["SPEC.md", "README.md"]);
  });

  it("只把这两个名称视为 node file", () => {
    expect(isNodeFile("SPEC.md")).toBe(true);
    expect(isNodeFile("README.md")).toBe(true);
    expect(isNodeFile("IMPLEMENTATION-PRD.md")).toBe(false);
    expect(isNodeFile("PROGRESS.md")).toBe(false);
  });

  it("为不直接访问 fs 的调用方通过注入 reader 解析", () => {
    const tree = new Map([["/m/01/SPEC.md", "spec body"], ["/m/02/README.md", "legacy body"]]);
    const read = (p: string) => tree.get(p) ?? null;
    expect(resolveNodeFileVia("/m/01", read)).toEqual({ path: "/m/01/SPEC.md", content: "spec body" });
    expect(resolveNodeFileVia("/m/02", read)).toEqual({ path: "/m/02/README.md", content: "legacy body" });
    expect(resolveNodeFileVia("/m/03", read)).toBeNull();
  });
});

describe("scope view projection——由 SPEC.md 支撑的 slice", () => {
  function deps(): ScopeFsDeps {
    return {
      exists: (p) => fs.existsSync(p),
      readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null),
      listDir: (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []),
      isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    };
  }

  it("投影只有 SPEC.md 的 slice，而不是返回 null", () => {
    const dir = nodeDir("01-spec-backed", "SPEC.md");
    const projected = projectSliceScope(deps(), dir);
    expect(projected).not.toBeNull();
    expect(projected!.id).toBe("OPR.9.9.9.1");
  });

  it("仍可投影只有 README.md 的 slice", () => {
    const dir = nodeDir("02-legacy", "README.md");
    const projected = projectSliceScope(deps(), dir);
    expect(projected).not.toBeNull();
    expect(projected!.id).toBe("OPR.9.9.9.1");
  });
});
