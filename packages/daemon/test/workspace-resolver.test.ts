// PL-007 Workspace Primitive v0——workspace-resolver 测试。
//
// 固定以下行为：
//   - 没有 spec 时 resolveWorkspaceContext 返回 null
//   - default_repo 存在于 repos[] 时，activeRepo 取自它
//   - 设置 env override 时，它优先于 default_repo
//   - 声明 knowledge_root 时，knowledgeKind = "knowledge"
//   - cwd 同时位于多个 repo path 下时，resolveNodeWorkspace 选择最长 prefix
//   - cwd 位于 knowledge_root 下时回退到 knowledge
//   - cwd 位于 repos 与 knowledge 外时回退到 default_repo

import { describe, it, expect } from "vitest";
import { resolveWorkspaceContext, resolveNodeWorkspace } from "../src/domain/workspace/workspace-resolver.js";
import type { WorkspaceSpec } from "../src/domain/types.js";

const spec: WorkspaceSpec = {
  workspaceRoot: "/Users/op/hub",
  repos: [
    { name: "main", path: "/Users/op/hub/main", kind: "project" },
    { name: "internal", path: "/Users/op/hub/main/sub", kind: "project" },
    { name: "lab", path: "/Users/op/hub/lab", kind: "lab" },
  ],
  defaultRepo: "main",
  knowledgeRoot: "/Users/op/knowledge",
};

describe("resolveWorkspaceContext (PL-007)", () => {
  it("spec 为 null 时返回 null", () => {
    expect(resolveWorkspaceContext({ spec: null, cwd: "/x", envOverride: null })).toBeNull();
  });

  it("返回 workspace block，activeRepo 取自 default_repo", () => {
    const r = resolveWorkspaceContext({ spec, cwd: "/Users/op/hub/main", envOverride: null });
    expect(r).not.toBeNull();
    expect(r?.activeRepo).toBe("main");
    expect(r?.workspaceRoot).toBe("/Users/op/hub");
    expect(r?.repos).toHaveLength(3);
    expect(r?.knowledgeRoot).toBe("/Users/op/knowledge");
    expect(r?.knowledgeKind).toBe("knowledge");
  });

  it("env override 优先于 default_repo", () => {
    const r = resolveWorkspaceContext({ spec, cwd: "/x", envOverride: "internal" });
    expect(r?.activeRepo).toBe("internal");
  });

  it("即使 env override 不在 repos[] 中，也逐字采用", () => {
    const r = resolveWorkspaceContext({ spec, cwd: "/x", envOverride: "rare-repo" });
    expect(r?.activeRepo).toBe("rare-repo");
  });

  it("knowledge_root 缺失时 knowledgeKind 为 null", () => {
    const noKnowledge: WorkspaceSpec = { ...spec, knowledgeRoot: undefined };
    const r = resolveWorkspaceContext({ spec: noKnowledge, cwd: "/x", envOverride: null });
    expect(r?.knowledgeKind).toBeNull();
    expect(r?.knowledgeRoot).toBeNull();
  });
});

describe("resolveNodeWorkspace (PL-007)", () => {
  it("cwd 位于嵌套 repo path 下时，最长 prefix 优先", () => {
    const r = resolveNodeWorkspace({ spec, cwd: "/Users/op/hub/main/sub/file.ts" });
    expect(r?.activeRepo).toBe("internal");
    expect(r?.kind).toBe("project");
  });

  it("cwd 位于外层 repo 但不在嵌套 repo 下时，匹配外层 repo", () => {
    const r = resolveNodeWorkspace({ spec, cwd: "/Users/op/hub/main/other" });
    expect(r?.activeRepo).toBe("main");
    expect(r?.kind).toBe("project");
  });

  it("cwd 位于 knowledge_root 下时返回 kind=knowledge", () => {
    const r = resolveNodeWorkspace({ spec, cwd: "/Users/op/knowledge/canon" });
    expect(r?.kind).toBe("knowledge");
    // cwd 无法解析到 repo 时，activeRepo 回退到 default_repo
    expect(r?.activeRepo).toBe("main");
  });

  it("cwd 位于所有范围之外时回退到 default_repo", () => {
    const r = resolveNodeWorkspace({ spec, cwd: "/elsewhere" });
    expect(r?.activeRepo).toBe("main");
    expect(r?.kind).toBe("project");
  });

  it("spec 为 null 时返回 null", () => {
    expect(resolveNodeWorkspace({ spec: null, cwd: "/x" })).toBeNull();
  });

  it("即使 cwd 为 null 也返回 workspaceRoot", () => {
    const r = resolveNodeWorkspace({ spec, cwd: null });
    expect(r?.workspaceRoot).toBe("/Users/op/hub");
    expect(r?.activeRepo).toBe("main");
  });
});
