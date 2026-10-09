// OPR.0.5.3.3 slice 03 item 2——alias 形式的 model-pin 提示。
import { describe, it, expect } from "vitest";
import { aliasModelPinAdvisory } from "../src/domain/spec-validation-advisory.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";

describe("aliasModelPinAdvisory——为 alias pin 指明 canonical id", () => {
  it("针对已知 alias 返回指明 canonical id 的命名提示", () => {
    const adv = aliasModelPinAdvisory("fable", "pods.dev.members.driver");
    expect(adv).not.toBeNull();
    expect(adv).toContain("pods.dev.members.driver");
    expect(adv).toContain('"fable"');
    expect(adv).toContain("claude-fable-5"); // canonical id。
  });

  it("alias 匹配不区分大小写和空白", () => {
    expect(aliasModelPinAdvisory("  Fable ", "x")).toContain("claude-fable-5");
  });

  it("canonical pin、未知 pin 或非字符串输入返回 null", () => {
    expect(aliasModelPinAdvisory("claude-fable-5", "x")).toBeNull();
    expect(aliasModelPinAdvisory("gpt-5.6-codex", "x")).toBeNull();
    expect(aliasModelPinAdvisory(undefined, "x")).toBeNull();
    expect(aliasModelPinAdvisory(42 as unknown, "x")).toBeNull();
  });

  it("r2 BLOCKING-1：prototype-key pin 视为 UNKNOWN——返回 null，绝不从继承的 Object 成员伪造提示", () => {
    // 普通对象查询曾为这些有效字符串 pin 返回 Object.prototype 成员，并伪造把
    // `function Object() { [native code] }` 称为 canonical id 的提示。
    expect(aliasModelPinAdvisory("constructor", "x")).toBeNull();
    expect(aliasModelPinAdvisory("__proto__", "x")).toBeNull();
    expect(aliasModelPinAdvisory("hasOwnProperty", "x")).toBeNull();
  });
});

describe("RigSpecSchema.validate——alias pin 作为提示出现，绝不作为错误（fail-open）", () => {
  const base = (model: string) => ({
    name: "test-rig",
    version: "0.2",
    pods: [{ id: "dev", members: [{ id: "driver", model }] }],
  });

  it("alias 形式的 pin 发出命名提示，且不影响 validity/errors", () => {
    const aliasResult = RigSpecSchema.validate(base("fable"));
    const canonResult = RigSpecSchema.validate(base("claude-fable-5"));

    // alias 有提示，canonical pin 没有提示。
    expect(aliasResult.advisories?.some((a) => a.includes("claude-fable-5"))).toBe(true);
    expect(canonResult.advisories ?? []).toHaveLength(0);

    // FAIL-OPEN：提示既不改变 `valid`，也不改变 `errors`。
    expect(aliasResult.valid).toBe(canonResult.valid);
    expect(aliasResult.errors).toEqual(canonResult.errors);
  });
});

// r2 HIGH-1：自动检测的 LEGACY 路径也必须显示 alias-pin 提示，否则 legacy alias-pinned spec 会
// 得到干净的 validate 结果，操作员也收不到迁移提醒。
describe("LegacyRigSpecSchema.validate——legacy 路径同样把 alias pin 显示为提示", () => {
  const legacyBase = (model: string) => ({
    schema_version: 1,
    name: "legacy-rig",
    version: "1",
    nodes: [{ id: "n1", runtime: "claude-code", model }],
  });

  it("legacy 节点的 alias 形式 pin 发出命名提示（fail-open）", () => {
    const aliasResult = LegacyRigSpecSchema.validate(legacyBase("fable"));
    const canonResult = LegacyRigSpecSchema.validate(legacyBase("claude-fable-5"));

    expect(aliasResult.advisories?.some((a) => a.includes("claude-fable-5"))).toBe(true);
    expect(canonResult.advisories ?? []).toHaveLength(0);
    // FAIL-OPEN：有无 alias 时 valid/errors 完全相同。
    expect(aliasResult.valid).toBe(canonResult.valid);
    expect(aliasResult.errors).toEqual(canonResult.errors);
  });

  // r2 HIGH-1 第 2 轮：提示独立于 id 有效性——固定为 fable 且缺少 id（未通过 id 守卫）的节点仍
  // 必须在 `?` 回退位置发出提示。
  it("即使节点缺少 id，也为 alias pin 发出提示", () => {
    const result = LegacyRigSpecSchema.validate({
      schema_version: 1,
      name: "legacy-rig",
      version: "1",
      nodes: [{ runtime: "claude-code", model: "fable" }], // 无 id 会失效，但仍固定到 alias。
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("每个节点都必须有字符串 id");
    expect(result.advisories?.some((a) => a.includes("claude-fable-5"))).toBe(true);
    expect(result.advisories?.some((a) => a.includes("nodes.?"))).toBe(true); // 回退位置。
  });
});
