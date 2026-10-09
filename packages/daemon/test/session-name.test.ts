import { describe, it, expect } from "vitest";
import {
  deriveSessionName,
  deriveCanonicalSessionName,
  validateSessionName,
  validateSessionNameChars,
  validateSessionComponents,
} from "../src/domain/session-name.js";

describe("session-name", () => {
  // 现有旧版测试。
  it("保留已匹配 rNN- 的受管 rig stem", () => {
    expect(deriveSessionName("r01", "orchestrator")).toBe("r01-orchestrator");
    expect(validateSessionName("r01-orchestrator")).toBe(true);
  });

  it("将普通 rig 名规范化为受管 r00- stem", () => {
    const derived = deriveSessionName("qa-dogfood-rig", "dev");
    expect(derived).toBe("r00-qa-dogfood-rig-dev");
    expect(validateSessionName(derived)).toBe(true);
  });

  // NS-T01 测试。

  // 测试 1：deriveCanonicalSessionName 生成 {pod}-{member}@{rig}。
  it("deriveCanonicalSessionName 生成 canonical {pod}-{member}@{rig} 格式", () => {
    expect(deriveCanonicalSessionName("dev", "impl", "auth-feats")).toBe("dev-impl@auth-feats");
    expect(deriveCanonicalSessionName("orch1", "lead", "rigged-buildout")).toBe("orch1-lead@rigged-buildout");
    expect(deriveCanonicalSessionName("rev", "r1", "my.rig")).toBe("rev-r1@my.rig");
  });

  // 测试 2：保留 deriveSessionName 旧路径。
  it("deriveSessionName 旧路径仍适用于 flat rig", () => {
    expect(deriveSessionName("qa-rig", "worker")).toBe("r00-qa-rig-worker");
    expect(deriveSessionName("r01", "dev")).toBe("r01-dev");
  });

  // 测试 3：validateSessionName 同时接受旧版和 canonical 格式。
  it("validateSessionName 同时接受旧版 r\\d{2}- 和含 @ 的 canonical 名称", () => {
    // 旧版。
    expect(validateSessionName("r01-foo")).toBe(true);
    expect(validateSessionName("r00-my-rig-worker")).toBe(true);
    // Canonical。
    expect(validateSessionName("dev-impl@auth-feats")).toBe(true);
    expect(validateSessionName("orch1-lead@rigged-buildout")).toBe(true);
    // 无效。
    expect(validateSessionName("")).toBe(false);
    expect(validateSessionName("no-format-at-all")).toBe(false);
    expect(validateSessionName("has spaces@rig")).toBe(false);
    expect(validateSessionName("dev-impl@rig with spaces")).toBe(false);
  });

  // 测试 4：validateSessionNameChars 拒绝无效字符，并给出逐字符错误。
  it("validateSessionNameChars 拒绝无效字符并给出具体错误", () => {
    expect(validateSessionNameChars("valid-name_1", "pod name")).toBeNull();
    expect(validateSessionNameChars("has.dot", "pod name")).toBeNull(); // 允许点。

    const err = validateSessionNameChars("my pod!", "pod name");
    expect(err).not.toBeNull();
    expect(err).toContain("pod name");
    expect(err).toContain("!");
    expect(err).toContain("a-z、A-Z、0-9、-、_、.、@");

    const spaceErr = validateSessionNameChars("has space", "member name");
    expect(spaceErr).not.toBeNull();
    expect(spaceErr).toContain("member name");
    expect(spaceErr).toContain(" ");
  });

  // 测试 5：canonical 派生结果含 @，可通过 validateSessionName。
  it("含 @ 的 canonical session 名可通过 validateSessionName", () => {
    const name = deriveCanonicalSessionName("dev", "impl", "auth-feats");
    expect(name).toContain("@");
    expect(validateSessionName(name)).toBe(true);
  });

  // 测试 6：validateSessionComponents 拒绝空组件。
  it("validateSessionComponents 拒绝空 pod/member/rig 并给出有效错误", () => {
    const emptyPod = validateSessionComponents("", "impl", "my-rig");
    expect(emptyPod.length).toBeGreaterThan(0);
    expect(emptyPod[0]).toContain("pod");
    expect(emptyPod[0]).toContain("不得为空");

    const emptyMember = validateSessionComponents("dev", "", "my-rig");
    expect(emptyMember.length).toBeGreaterThan(0);
    expect(emptyMember[0]).toContain("member");

    const emptyRig = validateSessionComponents("dev", "impl", "");
    expect(emptyRig.length).toBeGreaterThan(0);
    expect(emptyRig[0]).toContain("rig");

    // 有效。
    expect(validateSessionComponents("dev", "impl", "auth-feats")).toEqual([]);
  });
});
