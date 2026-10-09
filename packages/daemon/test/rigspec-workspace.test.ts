// PL-007 Workspace Primitive v0 — RigSpec.workspace block validation +
// normalization tests.
//
// Pins:
//   - validateRigSpec 接受可选 workspace block，含必填
//     workspace_root + repos[] + per-repo (name, path, kind)
//   - rejects malformed (missing workspace_root, unknown kind, duplicate
//     repo name、default_repo 不在 repos[])
//   - 向后兼容：无 workspace block 的 rig 仍有效
//   - normalize 往返字段并解析相对路径相对
//     workspace_root
//   - codec 往返在 serialize/parse 时保留 workspace block

import { describe, it, expect } from "vitest";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";

const baseRig = {
  version: "0.2",
  name: "test-rig",
  pods: [{
    id: "dev",
    label: "Dev pod",
    members: [{
      id: "impl",
      agent_ref: "local:agents/impl",
      profile: "default",
      runtime: "claude-code",
      cwd: "/tmp",
    }],
    edges: [],
  }],
  edges: [],
};

const workspaceBlock = {
  workspace_root: "/Users/test/project",
  repos: [
    { name: "main", path: "main", kind: "project" },
    { name: "internal", path: "/Users/test/project/internal", kind: "project" },
  ],
  default_repo: "main",
  knowledge_root: "/Users/test/knowledge",
};

describe("RigSpec 校验——工作区块（PL-007）", () => {
  it("接受结构正确的工作区块", () => {
    const result = RigSpecSchema.validate({ ...baseRig, workspace: workspaceBlock });
    expect(result.valid).toBe(true);
  });

  it("向后兼容：没有工作区块的工作组仍有效", () => {
    const result = RigSpecSchema.validate(baseRig);
    expect(result.valid).toBe(true);
  });

  it("拒绝缺少 workspace_root", () => {
    const broken = { ...baseRig, workspace: { ...workspaceBlock, workspace_root: "" } };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workspace_root"))).toBe(true);
  });

  it("拒绝未知 kind", () => {
    const broken = {
      ...baseRig,
      workspace: { ...workspaceBlock, repos: [{ name: "x", path: "x", kind: "rd-pod" }] },
    };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /kind/i.test(e))).toBe(true);
  });

  it("拒绝重复仓库名称", () => {
    const broken = {
      ...baseRig,
      workspace: {
        ...workspaceBlock,
        repos: [
          { name: "openrig", path: "openrig", kind: "project" },
          { name: "openrig", path: "openrig-internal", kind: "project" },
        ],
      },
    };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /重复/.test(e))).toBe(true);
  });

  it("拒绝不匹配任何仓库的 default_repo", () => {
    const broken = { ...baseRig, workspace: { ...workspaceBlock, default_repo: "nonexistent" } };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /default_repo/.test(e))).toBe(true);
  });

  it("normalize 相对于 workspace_root 解析仓库相对路径", () => {
    const normalized = RigSpecSchema.normalize({ ...baseRig, workspace: workspaceBlock } as Record<string, unknown>);
    expect(normalized.workspace).toBeDefined();
    expect(normalized.workspace?.workspaceRoot).toBe("/Users/test/project");
    expect(normalized.workspace?.repos[0]?.path).toBe("/Users/test/project/main");
    expect(normalized.workspace?.repos[1]?.path).toBe("/Users/test/project/internal");
    expect(normalized.workspace?.defaultRepo).toBe("main");
    expect(normalized.workspace?.knowledgeRoot).toBe("/Users/test/knowledge");
  });

  it("normalize 接受没有工作区块的工作组", () => {
    const normalized = RigSpecSchema.normalize(baseRig as Record<string, unknown>);
    expect(normalized.workspace).toBeUndefined();
  });

  it("校验全部 5 种类型化 kind（user/project/knowledge/lab/delivery）", () => {
    for (const k of ["user", "project", "knowledge", "lab", "delivery"]) {
      const result = RigSpecSchema.validate({
        ...baseRig,
        workspace: {
          workspace_root: "/r",
          repos: [{ name: "a", path: "a", kind: k }],
        },
      });
      expect(result.valid).toBe(true);
    }
  });

  it("codec 可往返转换工作区块", () => {
    const normalized = RigSpecSchema.normalize({ ...baseRig, workspace: workspaceBlock } as Record<string, unknown>);
    const yaml = RigSpecCodec.serialize(normalized);
    const parsed = RigSpecCodec.parse(yaml) as Record<string, unknown>;
    expect((parsed.workspace as Record<string, unknown>).workspace_root).toBe("/Users/test/project");
    const repos = (parsed.workspace as Record<string, unknown>).repos as Array<Record<string, unknown>>;
    expect(repos).toHaveLength(2);
    expect(repos[0]?.name).toBe("main");
    expect(repos[0]?.kind).toBe("project");
  });
});
