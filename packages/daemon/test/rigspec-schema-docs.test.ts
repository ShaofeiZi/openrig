import { describe, it, expect } from "vitest";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";

describe("RigSpec docs 字段", () => {
  function minimalSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: "0.2",
      name: "test-rig",
      pods: [
        {
          id: "dev",
          label: "Development",
          members: [
            { id: "impl", agent_ref: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." },
          ],
          edges: [],
        },
      ],
      edges: [],
      ...overrides,
    };
  }

  it("接受没有 docs 字段的 spec", () => {
    const result = RigSpecSchema.validate(minimalSpec());
    expect(result.valid).toBe(true);
  });

  it("接受带有效 docs 数组的 spec", () => {
    const result = RigSpecSchema.validate(minimalSpec({
      docs: [{ path: "SETUP.md" }, { path: "README.md" }],
    }));
    expect(result.valid).toBe(true);
  });

  it("拒绝非数组的 docs", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: "SETUP.md" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs：必须是数组"))).toBe(true);
  });

  it("拒绝没有 path 的 doc 条目", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [{}] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0].path：必填"))).toBe(true);
  });

  it("拒绝含路径遍历的 doc 条目", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [{ path: "../../../etc/passwd" }] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("路径穿越"))).toBe(true);
  });

  it("将 docs 归一化为类型化数组", () => {
    const spec = RigSpecSchema.normalize(minimalSpec({
      docs: [{ path: "SETUP.md" }, { path: "README.md" }],
    }));
    expect(spec.docs).toEqual([{ path: "SETUP.md" }, { path: "README.md" }]);
  });

  it("没有 docs 字段时归一化为 undefined", () => {
    const spec = RigSpecSchema.normalize(minimalSpec());
    expect(spec.docs).toBeUndefined();
  });

  it("拒绝 docs 数组中的 null 条目且不崩溃", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [null] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0]：必须是带 path 字段的对象"))).toBe(true);
  });

  it("拒绝 docs 数组中的原始值条目且不崩溃", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [42] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0]：必须是带 path 字段的对象"))).toBe(true);
  });

  it("拒绝 docs 数组中的字符串条目且不崩溃", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: ["SETUP.md"] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0]：必须是带 path 字段的对象"))).toBe(true);
  });
});
