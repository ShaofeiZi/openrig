import { describe, it, expect } from "vitest";
import { generateDraftRig } from "../src/domain/draft-rig-generator.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { DiscoveredSession } from "../src/domain/discovery-types.js";

function makeSession(overrides: Partial<DiscoveredSession>): DiscoveredSession {
  return {
    id: "sess-1",
    tmuxSession: "dev-impl",
    tmuxWindow: null,
    tmuxPane: "0",
    pid: 1234,
    cwd: "/project/code",
    activeCommand: "claude",
    runtimeHint: "claude-code",
    confidence: "high",
    evidenceJson: null,
    configJson: null,
    status: "active",
    claimedNodeId: null,
    firstSeenAt: "2026-03-31T00:00:00Z",
    lastSeenAt: "2026-03-31T00:00:00Z",
    ...overrides,
  };
}

describe("工作组草稿生成器", () => {
  // 测试 1：按共享 CWD 分组。
  it("按共享 CWD 把 session 分组为 pod", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "impl", cwd: "/project/code" }),
      makeSession({ id: "s2", tmuxSession: "qa", cwd: "/project/code", runtimeHint: "codex" }),
      makeSession({ id: "s3", tmuxSession: "server", cwd: "/project/infra", runtimeHint: "terminal" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const pods = (raw as Record<string, unknown>)["pods"] as Array<Record<string, unknown>>;
    expect(pods.length).toBe(2); // code pod + infra pod。
  });

  // 测试 2：根据 session 名分配 pod/member 名称。
  it("根据 session 名分配 pod 与成员名称", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "dev-lead", cwd: "/project" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const pods = (raw as Record<string, unknown>)["pods"] as Array<Record<string, unknown>>;
    const members = (pods[0] as Record<string, unknown>)["members"] as Array<Record<string, unknown>>;
    expect(members[0]!["id"]).toBe("dev-lead");
  });

  // 测试 3：生成有效的工作组规范 YAML。
  it("生成可通过 schema 验证的有效工作组规范", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "impl", cwd: "/project" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);
  });

  // 测试 4：处理混合 runtime。
  it("处理混合 runtime（claude-code + codex + terminal）", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "impl", runtimeHint: "claude-code", cwd: "/project" }),
      makeSession({ id: "s2", tmuxSession: "qa", runtimeHint: "codex", cwd: "/project" }),
      makeSession({ id: "s3", tmuxSession: "server", runtimeHint: "terminal", cwd: "/project" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);

    // Terminal 成员应使用哨兵值。
    const pods = (raw as Record<string, unknown>)["pods"] as Array<Record<string, unknown>>;
    const members = (pods[0] as Record<string, unknown>)["members"] as Array<Record<string, unknown>>;
    const terminal = members.find((m) => m["runtime"] === "terminal");
    expect(terminal).toBeDefined();
    expect(terminal!["agent_ref"]).toBe("builtin:terminal");
    expect(terminal!["profile"]).toBe("none");
  });

  // 测试 5：单 session 工作组。
  it("处理单 session 工作组", () => {
    const sessions = [makeSession({ id: "s1", tmuxSession: "solo", cwd: "/project" })];
    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);
  });

  // 测试 6：排除未知 runtime 并给出警告。
  it("排除 runtime 未知的 session 并给出警告", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "known", runtimeHint: "claude-code", cwd: "/project" }),
      makeSession({ id: "s2", tmuxSession: "mystery", runtimeHint: "unknown", cwd: "/project" }),
    ];

    const result = generateDraftRig(sessions);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("mystery");
    expect(result.yaml).toContain("# 警告");
  });

  // 测试 7：对冲突名称去重。
  it("对冲突的成员名称去重", () => {
    const sessions = [
      makeSession({ id: "s1", tmuxSession: "impl", cwd: "/project" }),
      makeSession({ id: "s2", tmuxSession: "impl", cwd: "/project", runtimeHint: "codex" }),
    ];

    const result = generateDraftRig(sessions);
    const raw = RigSpecCodec.parse(result.yaml);
    const pods = (raw as Record<string, unknown>)["pods"] as Array<Record<string, unknown>>;
    const members = (pods[0] as Record<string, unknown>)["members"] as Array<Record<string, unknown>>;
    const ids = members.map((m) => m["id"]);
    expect(new Set(ids).size).toBe(2); // 不允许重复。
    expect(ids).toContain("impl");
    expect(ids).toContain("impl-2");
  });
});
