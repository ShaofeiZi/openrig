import { describe, it, expect } from "vitest";
import { RigSpecCodec, LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { RigSpec } from "../src/domain/types.js";

const VALID_RIG: RigSpec = {
  version: "0.2",
  name: "dev-rig",
  summary: "Dev rig",
  cultureFile: "culture.md",
  pods: [
    {
      id: "dev",
      label: "Development",
      members: [
        { id: "impl", agentRef: "local:agents/impl", profile: "tdd", runtime: "claude-code", cwd: "." },
        { id: "qa", agentRef: "local:agents/qa", profile: "reviewer", runtime: "codex", cwd: "." },
      ],
      edges: [{ kind: "can_observe", from: "qa", to: "impl" }],
    },
  ],
  edges: [],
};

describe("RigSpec 编解码器（pod 感知）", () => {
  it("序列化 -> 解析 -> 校验 往返", () => {
    const yaml = RigSpecCodec.serialize(VALID_RIG);
    const parsed = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = RigSpecSchema.normalize(parsed as Record<string, unknown>);
    expect(normalized.name).toBe("dev-rig");
    expect(normalized.cultureFile).toBe("culture.md");
    expect(normalized.pods).toHaveLength(1);
    expect(normalized.pods[0]!.members).toHaveLength(2);
    expect(normalized.pods[0]!.edges).toHaveLength(1);
  });

  it("保持 pod/成员/边 的顺序", () => {
    const yaml = RigSpecCodec.serialize(VALID_RIG);
    const parsed = RigSpecCodec.parse(yaml) as Record<string, unknown>;
    const pods = parsed["pods"] as Array<Record<string, unknown>>;
    expect(pods[0]!["id"]).toBe("dev");
    const members = pods[0]!["members"] as Array<Record<string, unknown>>;
    expect(members[0]!["id"]).toBe("impl");
    expect(members[1]!["id"]).toBe("qa");
  });

  it("culture_file 经序列化/解析往返", () => {
    const yaml = RigSpecCodec.serialize(VALID_RIG);
    expect(yaml).toContain("culture_file: culture.md");
    const parsed = RigSpecCodec.parse(yaml) as Record<string, unknown>;
    expect(parsed["culture_file"]).toBe("culture.md");
  });

  // R1：continuity_policy 的嵌套布尔值经 序列化 -> 解析 -> 归一化 正确往返
  it("continuity_policy 嵌套布尔值正确往返", () => {
    const rigWithCp: RigSpec = {
      version: "0.2",
      name: "cp-test",
      pods: [{
        id: "dev",
        label: "Dev",
        continuityPolicy: {
          enabled: true,
          syncTriggers: ["pre_compaction", "manual"],
          artifacts: { sessionLog: true, restoreBrief: false, quiz: true },
          restoreProtocol: { peerDriven: true, verifyViaQuiz: false },
        },
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "tdd", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
      edges: [],
    };

    const yaml = RigSpecCodec.serialize(rigWithCp);
    const parsed = RigSpecCodec.parse(yaml) as Record<string, unknown>;
    const normalized = RigSpecSchema.normalize(parsed);

    const cp = normalized.pods[0]!.continuityPolicy!;
    expect(cp.enabled).toBe(true);
    expect(cp.syncTriggers).toEqual(["pre_compaction", "manual"]);
    expect(cp.artifacts!.sessionLog).toBe(true);
    expect(cp.artifacts!.restoreBrief).toBe(false);
    expect(cp.artifacts!.quiz).toBe(true);
    expect(cp.restoreProtocol!.peerDriven).toBe(true);
    expect(cp.restoreProtocol!.verifyViaQuiz).toBe(false);
  });

  it("旧版编解码器仍能序列化/解析旧的扁平 spec", () => {
    const legacySpec = {
      schemaVersion: 1, name: "test", version: "1.0",
      nodes: [{ id: "impl", runtime: "claude-code" }],
      edges: [],
    };
    const yaml = LegacyRigSpecCodec.serialize(legacySpec);
    expect(yaml).toContain("schema_version: 1");
    const parsed = LegacyRigSpecCodec.parse(yaml) as Record<string, unknown>;
    expect(parsed["name"]).toBe("test");
  });

  // Agent Starter v1 垂直切片 M1 R2 —— `starter_ref` 的编解码器往返。
  // Guard 发现：M1 R1 提交把 snake-case 输入归一化成了
  // `member.starterRef`，但规范化的 pod 感知序列化器从未把
  // `starter_ref` 写回去。pod-rigspec-instantiator 上的前向兼容冒烟测试
  // 因此是伪证。R2 修复：在 `RigSpecCodec.serialize()` 中输出
  // `starter_ref`，并端到端断言线路形状
  //（序列化 → 解析 → 校验 → 归一化）。
  it("starter_ref 经 序列化 → 解析 → 校验 → 归一化 往返(R2)", () => {
    const spec: RigSpec = {
      ...VALID_RIG,
      pods: [
        {
          id: "dev",
          label: "Development",
          members: [
            {
              id: "impl",
              agentRef: "local:agents/impl",
              profile: "default",
              runtime: "claude-code",
              cwd: ".",
              starterRef: { name: "openrig-builder-base--claude-code" },
            },
          ],
          edges: [],
        },
      ],
    };

    // 序列化 → 线路形状必须包含 starter_ref：
    const yaml = RigSpecCodec.serialize(spec);
    expect(yaml).toContain("starter_ref:");
    expect(yaml).toContain("openrig-builder-base--claude-code");

    // 解析 → 校验
    const parsed = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    // 归一化 → starterRef 按种子形状保留
    const normalized = RigSpecSchema.normalize(parsed);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toEqual({ name: "openrig-builder-base--claude-code" });
  });

  it("starter_ref + session_source.mode='rebuild' 同时经往返保留(允许组合)", () => {
    const spec: RigSpec = {
      ...VALID_RIG,
      pods: [
        {
          id: "dev",
          label: "Development",
          members: [
            {
              id: "impl",
              agentRef: "local:agents/impl",
              profile: "default",
              runtime: "claude-code",
              cwd: ".",
              starterRef: { name: "fixture-starter" },
              sessionSource: {
                mode: "rebuild",
                ref: { kind: "artifact_set", value: ["/tmp/fixture.md"] },
              },
            },
          ],
          edges: [],
        },
      ],
    };

    const yaml = RigSpecCodec.serialize(spec);
    expect(yaml).toContain("starter_ref:");
    expect(yaml).toContain("session_source:");
    expect(yaml).toContain("rebuild");

    const parsed = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = RigSpecSchema.normalize(parsed);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.starterRef).toEqual({ name: "fixture-starter" });
    expect(member.sessionSource).toEqual({
      mode: "rebuild",
      ref: { kind: "artifact_set", value: ["/tmp/fixture.md"] },
    });
  });

  it("无 starter_ref 的 spec 干净往返(不输出多余字段)", () => {
    const yaml = RigSpecCodec.serialize(VALID_RIG);
    expect(yaml).not.toContain("starter_ref:");
  });
});
