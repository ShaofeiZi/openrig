// Agent Starter v1 垂直切片 M1 的 Tier 1 schema/normalization/codec 证明：types.ts 在
// RigSpecPodMember 上增加 StarterRefSpec + starterRef?；rigspec-schema.ts 增加
// validateStarterRef + normalizeStarterRef。该包在 v0 强制三条拒绝规则：
// (1) starter_ref + session_source.mode="fork"；(2) terminal runtime + starter_ref；
// (3) 格式错误的 starter_ref.name。允许与 mode="rebuild" 组合，也允许单独使用 starter_ref。

import { describe, it, expect } from "vitest";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";

function rigWithMember(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "0.2",
    name: "starter-test-rig",
    pods: [
      {
        id: "dev",
        label: "Dev",
        members: [
          {
            id: "impl",
            agent_ref: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            ...overrides,
          },
        ],
        edges: [],
      },
    ],
    edges: [],
  };
}

describe("RigSpec starter_ref schema（M1）", () => {
  // === 接受 ===

  it("接受单独的 starter_ref", () => {
    const rig = rigWithMember({ starter_ref: { name: "openrig-builder-base--claude-code" } });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("接受 starter_ref + session_source.mode='rebuild'（允许增量组合）", () => {
    const rig = rigWithMember({
      starter_ref: { name: "openrig-builder-base--claude-code" },
      session_source: {
        mode: "rebuild",
        ref: { kind: "artifact_set", value: ["/tmp/fixture-artifact.md"] },
      },
    });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // === Codec 往返 ===

  it("normalize 在 RigSpecPodMember 上产生 starterRef", () => {
    const rig = rigWithMember({ starter_ref: { name: "fixture-starter" } });
    const normalized = RigSpecSchema.normalize(rig);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toEqual({ name: "fixture-starter" });
  });

  it("starter_ref 缺失时 normalize 结果为 undefined（不破坏现有 spec）", () => {
    const rig = rigWithMember({});
    const normalized = RigSpecSchema.normalize(rig);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toBeUndefined();
    // sessionSource 也为 undefined，确认没有交叉污染。
    expect(member.sessionSource).toBeUndefined();
  });

  it("组合时 normalize 同时保留 starterRef 与 sessionSource（mode=rebuild）", () => {
    const rig = rigWithMember({
      starter_ref: { name: "fixture-starter" },
      session_source: {
        mode: "rebuild",
        ref: { kind: "artifact_set", value: ["/tmp/a.md", "/tmp/b.md"] },
      },
    });
    const normalized = RigSpecSchema.normalize(rig);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toEqual({ name: "fixture-starter" });
    expect(member.sessionSource).toEqual({
      mode: "rebuild",
      ref: { kind: "artifact_set", value: ["/tmp/a.md", "/tmp/b.md"] },
    });
  });

  // === 拒绝：格式错误的 name ===

  it("拒绝 name 为空的 starter_ref", () => {
    const rig = rigWithMember({ starter_ref: { name: "" } });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("starter_ref.name") && e.includes("非空字符串"))).toBe(true);
  });

  it("拒绝 name 非字符串的 starter_ref", () => {
    const rig = rigWithMember({ starter_ref: { name: 42 } });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("starter_ref.name"))).toBe(true);
  });

  it("拒绝 name 含禁用字符的 starter_ref（路径遍历守卫）", () => {
    const rig = rigWithMember({ starter_ref: { name: "../etc/passwd" } });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("字母数字"))).toBe(true);
  });

  it("拒绝非对象的 starter_ref", () => {
    const rig = rigWithMember({ starter_ref: "fixture-starter" });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("starter_ref") && e.includes("对象"))).toBe(true);
  });

  // === 拒绝：与 session_source.mode='fork' 组合 ===

  it("拒绝 starter_ref + session_source.mode='fork'（v1+ named-trigger 覆盖该组合）", () => {
    const rig = rigWithMember({
      starter_ref: { name: "fixture-starter" },
      session_source: {
        mode: "fork",
        ref: { kind: "native_id", value: "abc-123" },
      },
    });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("fork") && e.includes("v1+"))).toBe(true);
  });

  // === 拒绝：terminal runtime + starter_ref（次要清理）===

  it("拒绝 terminal runtime + starter_ref（对应 terminal session_source 拒绝）", () => {
    const rig = rigWithMember({
      runtime: "terminal",
      agent_ref: "builtin:terminal",
      starter_ref: { name: "fixture-starter" },
    });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal") && e.includes("starter_ref"))).toBe(true);
  });

  // === 向前兼容：不含 starter_ref 的现有 rig 仍能通过验证 ===

  it("向前兼容：所有成员均无 starter_ref 的 spec 仍按原方式通过验证", () => {
    const rig = {
      version: "0.2",
      name: "compat-test",
      pods: [
        {
          id: "dev",
          label: "Dev",
          members: [
            { id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." },
            { id: "qa", agent_ref: "local:agents/qa", profile: "reviewer", runtime: "codex", cwd: "." },
          ],
          edges: [],
        },
      ],
      edges: [],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);
  });
});
