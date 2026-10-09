import { describe, it, expect } from "vitest";
import { validateAgentSpecFromYaml, validateRigSpecFromYaml } from "../src/domain/spec-validation-service.js";

describe("Spec 验证服务", () => {
  // T1：有效的 AgentSpec 通过验证。
  it("有效的 AgentSpec YAML 通过验证", () => {
    const yaml = 'name: test\nversion: "1.0"\nprofiles: {}';
    const result = validateAgentSpecFromYaml(yaml);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // T2：无效的 AgentSpec 返回结构化错误。
  it("无效的 AgentSpec YAML 返回结构化错误", () => {
    const yaml = "summary: no name or version";
    const result = validateAgentSpecFromYaml(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  // T3：有效的 RigSpec 通过验证。
  it("有效的 RigSpec YAML 通过验证", () => {
    const yaml = `
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;
    const result = validateRigSpecFromYaml(yaml);
    expect(result.valid).toBe(true);
  });

  // T4：无效的 RigSpec 返回结构化错误。
  it("无效的 RigSpec YAML 返回结构化错误", () => {
    const yaml = "name: bad-rig\nversion: '0.2'"; // 缺少 pods。
    const result = validateRigSpecFromYaml(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("pods"))).toBe(true);
  });

  // T9：无副作用。
  it("验证服务没有副作用（相同输入得到相同输出）", () => {
    const yaml = 'name: test\nversion: "1.0"\nprofiles: {}';
    const r1 = validateAgentSpecFromYaml(yaml);
    const r2 = validateAgentSpecFromYaml(yaml);
    expect(r1).toEqual(r2);
  });
});
