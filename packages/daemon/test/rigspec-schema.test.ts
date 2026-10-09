import { describe, it, expect } from "vitest";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";

const VALID_RIG = {
  version: "0.2",
  name: "dev-rig",
  summary: "Development rig",
  culture_file: "culture.md",
  pods: [
    {
      id: "dev",
      label: "Development",
      continuity_policy: {
        enabled: true,
        sync_triggers: ["pre_compaction", "manual"],
      },
      members: [
        { id: "impl", agent_ref: "local:agents/impl", profile: "tdd", runtime: "claude-code", cwd: ".", model: "sonnet" },
        { id: "qa", agent_ref: "local:agents/qa", profile: "reviewer", runtime: "codex", cwd: "." },
      ],
      edges: [
        { kind: "can_observe", from: "qa", to: "impl" },
      ],
    },
    {
      id: "arch",
      label: "Architecture",
      members: [
        { id: "reviewer", agent_ref: "local:agents/reviewer", profile: "default", runtime: "claude-code", cwd: "." },
      ],
      edges: [],
    },
  ],
  edges: [
    { kind: "escalates_to", from: "dev.impl", to: "arch.reviewer" },
  ],
};

describe("RigSpec schema（支持 pod）", () => {
  // T1：包含内嵌 pod 的有效工作组通过校验
  it("包含内嵌 pod 的有效工作组通过校验", () => {
    const result = RigSpecSchema.validate(VALID_RIG);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it.each([
    {
      label: "rig root",
      path: "operating_mod",
      key: "operating_mod",
      mutate: (rig: Record<string, unknown>) => { rig["operating_mod"] = "lab"; },
    },
    {
      label: "pod",
      path: "pods[0].summmary",
      key: "summmary",
      mutate: (rig: Record<string, unknown>) => {
        ((rig["pods"] as Record<string, unknown>[])[0]!)["summmary"] = "typo";
      },
    },
    {
      label: "member",
      path: "pods[0].members[0].modle",
      key: "modle",
      mutate: (rig: Record<string, unknown>) => {
        ((((rig["pods"] as Record<string, unknown>[])[0]!["members"] as Record<string, unknown>[])[0]!))["modle"] = "opus";
      },
    },
    {
      label: "edge",
      path: "pods[0].edges[0].weight",
      key: "weight",
      mutate: (rig: Record<string, unknown>) => {
        ((((rig["pods"] as Record<string, unknown>[])[0]!["edges"] as Record<string, unknown>[])[0]!))["weight"] = 2;
      },
    },
  ])("拒绝未知的 $label key，并提供精确 path 与静默 normalize 的后果", ({ path, key, mutate }) => {
    const rig = structuredClone(VALID_RIG) as unknown as Record<string, unknown>;
    mutate(rig);

    const result = RigSpecSchema.validate(rig);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      `${path}：未知键 "${key}"；拒绝该规范，因为规范化会丢弃此键并改变请求的拓扑`,
    );
  });

  it("允许 Codex member 使用 codex_config_profile，并将其 normalize", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[1] as Record<string, unknown>)["codex_config_profile"] = "sysadmin";

    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);

    const normalized = RigSpecSchema.normalize(rig);
    expect(normalized.pods[0]!.members[1]!.codexConfigProfile).toBe("sysadmin");
  });

  it("拒绝非 Codex member 上的 codex_config_profile", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["codex_config_profile"] = "sysadmin";

    const result = RigSpecSchema.validate(rig);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/codex_config_profile.*仅当.*有效/);
  });

  // T2：缺失 pod member agent_ref 时失败
  it("缺失 pod member agent_ref 时失败", () => {
    const rig = structuredClone(VALID_RIG);
    delete (rig.pods[0]!.members[0] as Record<string, unknown>)["agent_ref"];
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/agent_ref.*必填/);
  });

  // T3：缺失 pod member profile 时失败
  it("缺失 pod member profile 时失败", () => {
    const rig = structuredClone(VALID_RIG);
    delete (rig.pods[0]!.members[0] as Record<string, unknown>)["profile"];
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/profile.*必填/);
  });

  // T4：未知 edge kind 会失败
  it("未知 edge kind 会失败", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[0]!.edges[0]!.kind = "unknown_kind";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/kind.*必须是.*之一/);
  });

  // T5：cross-pod edge 使用未限定 id 时失败
  it("cross-pod edge 使用未限定 id 时失败", () => {
    const rig = structuredClone(VALID_RIG);
    rig.edges[0]!.from = "impl";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/完全限定的 pod\.member/);
  });

  // T6：pod-local edge 使用 fully-qualified id 时失败
  it("pod-local edge 使用 fully-qualified id 时失败", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[0]!.edges[0]!.from = "dev.qa";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/pod 本地边.*非限定/);
  });

  // T7：重复 pod id 会失败
  it("重复 pod id 会失败", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[1]!.id = "dev";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/pod id "dev" 重复/);
  });

  // T8：同一个 pod 内重复 member id 会失败
  it("同一个 pod 内重复 member id 会失败", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[0]!.members[1]!.id = "impl";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/member id "impl" 重复/);
  });

  // T9：pod id 或 member id 中包含点号会失败
  it("pod id 或 member id 中包含点号会失败", () => {
    const rig1 = structuredClone(VALID_RIG);
    rig1.pods[0]!.id = "dev.team";
    expect(RigSpecSchema.validate(rig1).errors[0]).toMatch(/不得包含点号/);

    const rig2 = structuredClone(VALID_RIG);
    rig2.pods[0]!.members[0]!.id = "impl.main";
    expect(RigSpecSchema.validate(rig2).errors[0]).toMatch(/不得包含点号/);
  });

  // T10：culture_file 经 normalize 往返保持不变
  it("culture_file 经 normalize 往返保持不变", () => {
    const normalized = RigSpecSchema.normalize(VALID_RIG);
    expect(normalized.cultureFile).toBe("culture.md");
  });

  // T11：normalize 保留 pod/member/edge 顺序
  it("normalize 保留 pod/member/edge 顺序", () => {
    const normalized = RigSpecSchema.normalize(VALID_RIG);
    expect(normalized.pods[0]!.id).toBe("dev");
    expect(normalized.pods[1]!.id).toBe("arch");
    expect(normalized.pods[0]!.members[0]!.id).toBe("impl");
    expect(normalized.pods[0]!.members[1]!.id).toBe("qa");
    expect(normalized.pods[0]!.edges[0]!.from).toBe("qa");
    expect(normalized.edges[0]!.from).toBe("dev.impl");
  });

  // T12：serialize -> parse -> validate 往返
  it("normalize 产生正确的 typed shape", () => {
    const normalized = RigSpecSchema.normalize(VALID_RIG);
    expect(normalized.version).toBe("0.2");
    expect(normalized.name).toBe("dev-rig");
    expect(normalized.pods).toHaveLength(2);
    expect(normalized.pods[0]!.members[0]!.agentRef).toBe("local:agents/impl");
    expect(normalized.pods[0]!.continuityPolicy?.enabled).toBe(true);
    expect(normalized.edges).toHaveLength(1);
  });

  // T13a：拒绝格式错误的 member startup
  it("拒绝格式错误的 member startup block", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = { files: "not-array" };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("files") && e.includes("数组"))).toBe(true);
  });

  // T13b：拒绝格式错误的 continuity_policy artifacts/restore_protocol
  it("拒绝格式错误的 continuity_policy 嵌套字段", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.continuity_policy as Record<string, unknown>)["artifacts"] = "bad";
    (rig.pods[0]!.continuity_policy as Record<string, unknown>)["restore_protocol"] = "bad";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("artifacts") && e.includes("对象"))).toBe(true);
    expect(result.errors.some((e) => e.includes("restore_protocol") && e.includes("对象"))).toBe(true);
  });

  // T13c：拒绝 member startup 中无效的 startup action 语义
  it("拒绝 member startup 中无效的 startup action type", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "shell", value: "npm install", idempotent: true }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("shell") && e.includes("不支持"))).toBe(true);
  });

  // T13d：pod startup 中无效的 startup action phase/applies_on
  it("拒绝无效的 startup action phase 与 applies_on", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods[0] = { ...rig.pods[0]!, startup: {
      files: [],
      actions: [{ type: "slash_command", value: "/test", phase: "before_ready", applies_on: ["rehydrate"], idempotent: true }],
    }};
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("phase") && e.includes("必须是") && e.includes("之一"))).toBe(true);
    expect(result.errors.some((e) => e.includes("applies_on") && e.includes("rehydrate"))).toBe(true);
  });

  // T13e：member startup 中无效的 file delivery_hint 与 applies_on
  it("拒绝 startup 中无效的 file delivery_hint 与 applies_on", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [{ path: "test.md", delivery_hint: "bogus", applies_on: ["rehydrate"] }],
      actions: [],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("delivery_hint"))).toBe(true);
    expect(result.errors.some((e) => e.includes("applies_on") && e.includes("rehydrate"))).toBe(true);
  });

  // T13f：拒绝 startup action 中非 boolean 的 idempotent
  it("拒绝 startup action 中非 boolean 的 idempotent", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", value: "/test", phase: "after_ready", idempotent: "yes" }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("idempotent") && e.includes("布尔值"))).toBe(true);
  });

  // T13g：拒绝 restore 时执行非幂等 action
  it("拒绝 member startup 中 restore 时执行的非幂等 action", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", value: "/setup", phase: "after_ready", idempotent: false, applies_on: ["fresh_start", "restore"] }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("非幂等") && e.includes("restore"))).toBe(true);
  });

  // T13h：拒绝 action 上标量形式的 applies_on
  it("拒绝 startup action 上标量形式的 applies_on", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", value: "/test", phase: "after_ready", idempotent: true, applies_on: "fresh_start" }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("applies_on") && e.includes("数组"))).toBe(true);
  });

  // T13i：校验嵌套 continuity-policy 的 boolean 类型
  it("拒绝非 boolean 的 continuity_policy 嵌套字段", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.continuity_policy as Record<string, unknown>)["artifacts"] = { session_log: "yes" };
    (rig.pods[0]!.continuity_policy as Record<string, unknown>)["restore_protocol"] = { peer_driven: "yes" };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("session_log") && e.includes("布尔值"))).toBe(true);
    expect(result.errors.some((e) => e.includes("peer_driven") && e.includes("布尔值"))).toBe(true);
  });

  // T14：legacy flat-node schema 仍可校验旧 spec
  it("legacy flat-node schema 仍可校验旧 spec", () => {
    const legacySpec = {
      schema_version: 1, name: "test", version: "1.0",
      nodes: [
        { id: "orchestrator", runtime: "claude-code", role: "orchestrator" },
        { id: "impl", runtime: "claude-code", role: "impl" },
      ],
      edges: [{ from: "orchestrator", to: "impl", kind: "delegates_to" }],
    };
    const result = LegacyRigSpecSchema.validate(legacySpec);
    expect(result.valid).toBe(true);
    const normalized = LegacyRigSpecSchema.normalize(legacySpec);
    expect(normalized.nodes).toHaveLength(2);
  });

  // -- Checkpoint 1 review 修复回归 --

  // R2：拒绝缺少 value 的 startup action
  it("拒绝缺少 value 的 startup action", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", phase: "after_ready", idempotent: true }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("value") && e.includes("非空"))).toBe(true);
  });

  // R3：拒绝缺少 idempotent 的 startup action
  it("拒绝缺少 idempotent 的 startup action", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", value: "/test", phase: "after_ready" }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("idempotent") && e.includes("必填"))).toBe(true);
  });

  // R4：undefined idempotent + default applies_on 的 restore-safety
  it("undefined idempotent 与 default applies_on 会触发 restore-safety 拒绝", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["startup"] = {
      files: [],
      actions: [{ type: "slash_command", value: "/setup", phase: "after_ready" }],
    };
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("非幂等") && e.includes("restore"))).toBe(true);
  });

  // R5：拒绝 member restore_policy "bogus"
  it("拒绝 member restore_policy bogus", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["restore_policy"] = "bogus";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/restore_policy.*必须是.*之一/);
  });

  // R6：拒绝 member agent_ref "github:foo/bar"
  it("拒绝 github: 形式的 member agent_ref", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["agent_ref"] = "github:foo/bar";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/agent_ref.*必须以 "local:" 或 "path:" 开头/);
  });

  // R7：拒绝从 dev.impl 到 dev.qa（同 pod）的 cross-pod edge
  it("拒绝引用同一 pod 的 cross-pod edge", () => {
    const rig = structuredClone(VALID_RIG);
    rig.edges = [{ kind: "can_observe", from: "dev.impl", to: "dev.qa" }];
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/跨 pod 边必须引用不同的 pod/);
  });

  // -- NS-T03：Terminal sentinel 校验 --

  // 测试 4：使用精确 sentinel 三元组校验 terminal member
  it("校验使用 builtin:terminal + none + terminal 的 terminal member", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods.push({
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server", agent_ref: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." } as any,
      ],
      edges: [],
    });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);
  });

  // 测试 5：拒绝 sentinel 配对错误的 terminal member
  it("拒绝使用 builtin:terminal 但 profile != none 的 terminal member", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods.push({
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server", agent_ref: "builtin:terminal", profile: "default", runtime: "terminal", cwd: "." } as any,
      ],
      edges: [],
    });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal") && e.includes("profile") && e.includes("none"))).toBe(true);
  });

  // 测试 6：拒绝使用 builtin:terminal 的非 terminal member
  it("拒绝使用 builtin:terminal 的非 terminal member", () => {
    const rig = structuredClone(VALID_RIG);
    rig.pods.push({
      id: "infra",
      label: "Infrastructure",
      members: [
        { id: "server", agent_ref: "builtin:terminal", profile: "none", runtime: "claude-code", cwd: "." } as any,
      ],
      edges: [],
    });
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("builtin:terminal") && e.includes("terminal"))).toBe(true);
  });
});

// ─── OPR.0.5.6.20 A5——member-level compaction_strategy 实时摄取 ─────────
// 基于 d9e01f2e3 的 RED-FIRST：validateMember 没有 compaction_strategy 分支，normalizePod
// 会丢弃该字段，因此 member override 永远无法通过真实 YAML -> validate -> normalize 路径
//（delivery review 发现的精确 bypass；P3 resolver 测试直接构造 member，无法发现此问题）。
describe("member compaction_strategy——实时摄取（OPR.0.5.6.20 A5）", () => {
  const rigWithMemberStrategy = (value: string) => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["compaction_strategy"] = value;
    return rig;
  };

  it("canonical member 值通过校验，并在 normalize 后保留至 resolved member", () => {
    const rig = rigWithMemberStrategy("managed-compaction");
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);
    const normalized = RigSpecSchema.normalize(rig);
    expect(normalized.pods[0]!.members[0]!.compactionStrategy).toBe("managed-compaction");
  });

  it("member-level deprecated alias 在带 advisory 时通过校验，并 normalize 为 canonical 值", () => {
    const rig = rigWithMemberStrategy("harness_native");
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);
    expect((result.advisories ?? []).join(" ")).toMatch(/harness_native.*已弃用.*default-compaction/);
    const normalized = RigSpecSchema.normalize(rig);
    expect(normalized.pods[0]!.members[0]!.compactionStrategy).toBe("default-compaction");
  });

  it("无效 member 值校验失败，error 会指出 member", () => {
    const rig = rigWithMemberStrategy("yolo-mode");
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/members\[0\].*compaction_strategy.*yolo-mode/);
  });

  it("custom_prompt 在 member level 保留逐字节一致的引导性拒绝", () => {
    const rig = rigWithMemberStrategy("custom_prompt");
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('v1 不支持 "custom_prompt"'))).toBe(true);
  });

  it("缺失的 member 字段在 normalize 后仍为 undefined（由 resolver F-6 default 处理缺失）", () => {
    const rig = structuredClone(VALID_RIG);
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);
    const normalized = RigSpecSchema.normalize(rig);
    expect(normalized.pods[0]!.members[0]!.compactionStrategy).toBeUndefined();
  });
});

describe("member mechanic——实时摄取（S20 A7/A8）", () => {
  it("接受并保留 canonical member override", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["mechanic"] = "member-mechanic@kernel";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(true);
    expect(RigSpecSchema.normalize(rig).pods[0]!.members[0]!.mechanic).toBe(
      "member-mechanic@kernel",
    );
  });

  it("拒绝非 canonical member mechanic，而非将其丢弃", () => {
    const rig = structuredClone(VALID_RIG);
    (rig.pods[0]!.members[0] as Record<string, unknown>)["mechanic"] = "member-mechanic";
    const result = RigSpecSchema.validate(rig);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/members\[0\].*mechanic.*规范.*seat@rig/i);
  });
});
