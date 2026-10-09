// PL-016 第 4 项——session_source: mode: agent_image schema + normalization 测试。
//
// 固定以下行为：
//   - validateRigSpec 接受 kind 为 image_name 的 mode: agent_image
//   - 拒绝 malformed 内容（缺少 value、kind 错误）
//   - 拒绝 terminal runtime 上的 mode: agent_image（与 fork/rebuild 一致）
//   - normalize 往返保留 typed shape
//   - 向后兼容：现有 fork + rebuild mode 仍可正确解析

import { describe, it, expect } from "vitest";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";

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
      session_source: {
        mode: "agent_image",
        ref: {
          kind: "image_name",
          value: "driver-release-primed",
        },
      },
    }],
    edges: [],
  }],
  edges: [],
};

describe("RigSpec validation——session_source: mode: agent_image（PL-016 第 4 项）", () => {
  it("接受格式正确的 agent_image session source", () => {
    const result = RigSpecSchema.validate(baseRig);
    expect(result.valid).toBe(true);
  });

  it("拒绝缺少 ref.value 的 mode: agent_image", () => {
    const broken = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          session_source: { mode: "agent_image", ref: { kind: "image_name" } },
        }],
      }],
    };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ref.value"))).toBe(true);
  });

  it("拒绝 ref.kind 非 image_name 的 mode: agent_image", () => {
    const broken = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          session_source: { mode: "agent_image", ref: { kind: "image_id", value: "x" } },
        }],
      }],
    };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("image_name"))).toBe(true);
  });

  it("拒绝 terminal runtime 上的 mode: agent_image（与 fork rejection 一致）", () => {
    const broken = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          runtime: "terminal",
        }],
      }],
    };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal"))).toBe(true);
  });

  it("normalize 往返保留 typed shape", () => {
    const normalized = RigSpecSchema.normalize(baseRig as Record<string, unknown>);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.sessionSource).toEqual({
      mode: "agent_image",
      ref: {
        kind: "image_name",
        value: "driver-release-primed",
      },
    });
  });

  it("normalize 接受可选 version 并将其转换为 string", () => {
    const withVersion = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          session_source: {
            mode: "agent_image",
            ref: { kind: "image_name", value: "p", version: 2 },
          },
        }],
      }],
    };
    const normalized = RigSpecSchema.normalize(withVersion as Record<string, unknown>);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.sessionSource).toMatchObject({
      mode: "agent_image",
      ref: { kind: "image_name", value: "p", version: "2" },
    });
  });

  it("向后兼容：现有 mode: fork 仍可解析", () => {
    const forkRig = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          session_source: { mode: "fork", ref: { kind: "native_id", value: "abc" } },
        }],
      }],
    };
    const result = RigSpecSchema.validate(forkRig);
    expect(result.valid).toBe(true);
  });
});
