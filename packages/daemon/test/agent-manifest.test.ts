import { describe, it, expect } from "vitest";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";

const VALID_SPEC = `
version: "0.2"
name: implementer
summary: Single-agent blueprint for code implementation work

imports:
  - ref: local:agents/acme-standards
    version: "1.0.0"

defaults:
  runtime: claude-code
  model: claude-sonnet-4.5
  lifecycle:
    execution_mode: interactive_resident
    compaction_strategy: pod_continuity
    restore_policy: resume_if_possible

startup:
  files:
    - path: startup/base/operating-model.md
      delivery_hint: auto
    - path: startup/base/repo-contract.md
  actions:
    - type: slash_command
      value: /rename implementer
      phase: after_ready
      applies_on: [fresh_start]
      idempotent: true

resources:
  skills:
    - id: deep-pr-review
      path: skills/workflows/deep-pr-review
  guidance:
    - id: tdd-rules
      path: guidance/tdd-rules.md
      target: claude_md
      merge: managed_block
  subagents:
    - id: diff-auditor
      path: subagents/diff-auditor.yaml
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
  runtime_resources:
    - id: codex-review-toolbar
      path: extensions/codex-review-toolbar/
      runtime: codex
      type: plugin

profiles:
  tdd:
    summary: TDD loop
    preferences:
      model: claude-opus-4.1
    startup:
      files:
        - path: startup/profiles/tdd-loop.md
          delivery_hint: auto
      actions: []
    lifecycle:
      execution_mode: interactive_resident
      compaction_strategy: pod_continuity
      restore_policy: resume_if_possible
    uses:
      skills: [deep-pr-review, acme-standards:repo-rules]
      guidance: [tdd-rules]
      subagents: [diff-auditor]
      plugins: [openrig-core]
      runtime_resources: []
`;

describe("AgentSpec manifest 解析器 + 校验器", () => {
  // T1：有效 agent.yaml 可解析并使用正确默认值规范化。
  it("有效 spec 可解析、校验和规范化", () => {
    const raw = parseAgentSpec(VALID_SPEC);
    const validation = validateAgentSpec(raw);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);

    const spec = normalizeAgentSpec(raw);
    expect(spec.name).toBe("implementer");
    expect(spec.version).toBe("0.2");
    expect(spec.imports).toHaveLength(1);
    expect(spec.imports[0]!.ref).toBe("local:agents/acme-standards");
    expect(spec.startup.files).toHaveLength(2);
    // 已应用默认值。
    expect(spec.startup.files[0]!.deliveryHint).toBe("auto");
    expect(spec.startup.files[1]!.deliveryHint).toBe("auto"); // defaulted
    expect(spec.startup.files[0]!.required).toBe(true);
    expect(spec.startup.files[0]!.appliesOn).toEqual(["fresh_start", "restore"]); // defaulted
    expect(spec.resources.skills).toHaveLength(1);
    expect(spec.resources.runtimeResources).toHaveLength(1);
    expect(spec.profiles["tdd"]).toBeDefined();
    expect(spec.profiles["tdd"]!.uses.skills).toContain("deep-pr-review");
    expect(spec.profiles["tdd"]!.uses.skills).toContain("acme-standards:repo-rules");
    expect(spec.defaults?.lifecycle?.executionMode).toBe("interactive_resident");
  });

  // T2：缺少 name 或 version 时失败并报告两个错误。
  it("缺少 name 或 version 时失败并报告两个错误", () => {
    const raw = parseAgentSpec("summary: no name or version");
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  // T3a：拒绝远程 import source。
  it("拒绝远程 import source（github:）", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: github:foo/bar
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/必须以 "local:" 或 "path:" 开头/);
  });

  // T3b：拒绝 local:/abs/path。
  it("拒绝带绝对路径的 local:", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: "local:/abs/path"
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/local:.*相对路径/);
  });

  // T3c：拒绝 path:relative/file。
  it("拒绝带相对路径的 path:", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: "path:relative/file"
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/path:.*绝对路径/);
  });

  // T4：拒绝 version range。
  it("拒绝 version range 字符串", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: local:agents/foo
    version: "^1.0.0"
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/不支持版本范围/);
  });

  // T5：拒绝 shell startup action。
  it("拒绝 shell startup action", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  actions:
    - type: shell
      value: "npm install"
      idempotent: true
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/不支持.*shell/);
  });

  // T5b：拒绝缺少 idempotent 字段。
  it("拒绝缺少 idempotent 字段的 startup action", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  actions:
    - type: slash_command
      value: /test
      phase: after_ready
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("idempotent") && e.includes("必填"))).toBe(true);
  });

  // T5c：拒绝 restore + idempotent=false。
  it("拒绝 applies_on 包含 restore 的非幂等 action", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  actions:
    - type: slash_command
      value: /setup
      phase: after_ready
      idempotent: false
      applies_on: [fresh_start, restore]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/非幂等.*不得应用于 restore/);
  });

  // T5d：接受仅用于 fresh_start 的非幂等 action。
  it("接受仅用于 fresh_start 的非幂等 action", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  actions:
    - type: slash_command
      value: /setup
      phase: after_ready
      idempotent: false
      applies_on: [fresh_start]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
  });

  // T6：拒绝 wake_on_demand。
  it("拒绝 wake_on_demand execution mode", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
defaults:
  lifecycle:
    execution_mode: wake_on_demand
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/不支持.*wake_on_demand/);
  });

  // T7a：拒绝无效 compaction strategy。
  it("拒绝无效 compaction strategy", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
defaults:
  lifecycle:
    compaction_strategy: bogus
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/compaction_strategy/);
  });

  // T7b：拒绝 custom_prompt compaction strategy。
  it("拒绝 custom_prompt compaction strategy", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
defaults:
  lifecycle:
    compaction_strategy: custom_prompt
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/custom_prompt.*not supported/);
  });

  // T8：拒绝 resource path 中的路径穿越（正斜杠 + 反斜杠）。
  it("拒绝 resource path 中的路径穿越", () => {
    // 正斜杠穿越。
    const raw1 = parseAgentSpec("name: test\nversion: '1.0'\nresources:\n  skills:\n    - id: evil\n      path: '../escape/evil.md'");
    expect(validateAgentSpec(raw1).valid).toBe(false);
    expect(validateAgentSpec(raw1).errors[0]).toMatch(/路径穿越/);

    // 反斜杠穿越——直接注入已解析对象，避免 YAML 转义问题。
    const raw2 = { name: "test", version: "1.0", resources: { skills: [{ id: "evil", path: "..\\escape\\evil.md" }] } };
    expect(validateAgentSpec(raw2).valid).toBe(false);
    expect(validateAgentSpec(raw2).errors[0]).toMatch(/路径穿越/);
  });

  // T8b：拒绝绝对 resource path（Unix + Windows）。
  it("拒绝绝对 resource path", () => {
    // Unix 绝对路径。
    const raw1 = parseAgentSpec("name: test\nversion: '1.0'\nresources:\n  skills:\n    - id: evil\n      path: /tmp/evil.md");
    expect(validateAgentSpec(raw1).valid).toBe(false);
    expect(validateAgentSpec(raw1).errors[0]).toMatch(/不允许使用绝对路径/);

    // Windows 盘符——直接注入。
    const raw2 = { name: "test", version: "1.0", resources: { skills: [{ id: "evil", path: "C:\\evil.md" }] } };
    expect(validateAgentSpec(raw2).valid).toBe(false);
    expect(validateAgentSpec(raw2).errors[0]).toMatch(/不允许使用绝对路径/);
  });

  // T9：拒绝 startup 文件路径中的路径穿越。
  it("拒绝 startup 文件路径中的路径穿越", () => {
    // 正斜杠。
    const raw1 = parseAgentSpec("name: test\nversion: '1.0'\nstartup:\n  files:\n    - path: '../evil.md'");
    expect(validateAgentSpec(raw1).valid).toBe(false);
    expect(validateAgentSpec(raw1).errors[0]).toMatch(/路径穿越/);

    // 反斜杠——直接注入。
    const raw2 = { name: "test", version: "1.0", startup: { files: [{ path: "..\\evil.md" }] } };
    expect(validateAgentSpec(raw2).valid).toBe(false);
    expect(validateAgentSpec(raw2).errors[0]).toMatch(/路径穿越/);
  });

  // T9b：拒绝绝对 startup 文件路径。
  it("拒绝绝对 startup 文件路径", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  files:
    - path: /etc/passwd
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/不允许使用绝对路径/);
  });

  // T10：同一类别中 resource id 重复时失败。
  it("同一类别中 resource id 重复时失败", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
resources:
  skills:
    - id: foo
      path: skills/foo
    - id: foo
      path: skills/foo2
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/ID "foo" 重复/);
  });

  // T11：profile uses——未限定且缺失的 ref 失败；限定 ref 接受。
  it("profile uses：未限定且缺失的 ref 失败，限定 ref 接受", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
resources:
  skills:
    - id: local-skill
      path: skills/local
profiles:
  main:
    uses:
      skills: [missing-skill, imported-ns:remote-skill]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    // 未限定的 "missing-skill" 应失败。
    expect(result.errors.some((e) => e.includes('找不到资源 "missing-skill"'))).toBe(true);
    // 限定的 "imported-ns:remote-skill" 不应产生错误。
    expect(result.errors.some((e) => e.includes("imported-ns:remote-skill"))).toBe(false);
  });

  it("profile uses：声明 import 时允许已导入的未限定 skill", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [openrig-user]
      guidance: []
      subagents: []
      plugins: []
      runtime_resources: []
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // T12：缺少 runtime 字段的 runtime_resources 失败。
  it("缺少 runtime 字段的 runtime_resources 失败", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
resources:
  runtime_resources:
    - id: foo
      path: extensions/foo
      type: plugin
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/runtime.*必填/);
  });

  it("缺少 type 字段的 runtime_resources 失败", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
resources:
  runtime_resources:
    - id: foo
      path: extensions/foo
      runtime: claude-code
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/type.*必填/);
  });

  // T13：同时报告多个错误（包括无效 enum）。
  it("同时报告多个校验错误", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  files:
    - path: startup/test.md
      delivery_hint: bogus
  actions:
    - type: slash_command
      value: /test
      phase: before_ready
      idempotent: true
      applies_on: [rehydrate]
defaults:
  lifecycle:
    execution_mode: wake_on_demand
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(result.errors.some((e) => e.includes("delivery_hint"))).toBe(true);
    expect(result.errors.some((e) => e.includes("phase"))).toBe(true);
    expect(result.errors.some((e) => e.includes("applies_on") && e.includes("rehydrate"))).toBe(true);
    expect(result.errors.some((e) => e.includes("wake_on_demand"))).toBe(true);
  });

  // T14a：拒绝 object 而非 array 形式的 startup.files。
  it("拒绝 object 而非 array 形式的 startup.files", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
startup:
  files:
    path: startup/test.md
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("files") && e.includes("数组"))).toBe(true);
  });

  // T14b：拒绝 array 而非 map 形式的 profiles。
  it("拒绝 array 而非 map 形式的 profiles", () => {
    const raw = parseAgentSpec(`
name: test
version: "1.0"
profiles:
  - name: tdd
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("profiles") && e.includes("map"))).toBe(true);
  });

  // T14：parse → validate → normalize 具有确定性。
  it("parse → validate → normalize 具有确定性", () => {
    const raw1 = parseAgentSpec(VALID_SPEC);
    const raw2 = parseAgentSpec(VALID_SPEC);
    const v1 = validateAgentSpec(raw1);
    const v2 = validateAgentSpec(raw2);
    expect(v1).toEqual(v2);
    const n1 = normalizeAgentSpec(raw1);
    const n2 = normalizeAgentSpec(raw2);
    expect(n1).toEqual(n2);
  });

  // 逐 seat silence-window-seconds 覆盖。AgentSpec parser 在规范化时保留
  // `profile.activity.silenceWindowSeconds`。当前未生效（live poller 使用全局 3s 默认值）；为未来
  // 逐 seat poller 决策保留。同时接受两种 YAML 约定（snake_case + camelCase）。
  describe("profile.activity.silenceWindowSeconds 规范化（slice 15 HG-7）", () => {
    const baseSpec = (activityBlock: string) => `
name: test-agent
version: "1.0"
profiles:
  default:
    uses:
      skills: []
      guidance: []
      subagents: []
      plugins: []
      runtime_resources: []
${activityBlock}
`;

    it("接受有效整数覆盖（snake_case YAML 形式）", () => {
      const raw = parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: 7`));
      const spec = normalizeAgentSpec(raw);
      expect(spec.profiles["default"]!.activity?.silenceWindowSeconds).toBe(7);
    });

    it("接受有效整数覆盖（camelCase 形式）", () => {
      const raw = parseAgentSpec(baseSpec(`    activity:\n      silenceWindowSeconds: 12`));
      const spec = normalizeAgentSpec(raw);
      expect(spec.profiles["default"]!.activity?.silenceWindowSeconds).toBe(12);
    });

    it("接受边界值 1 和 3600", () => {
      const lo = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: 1`)));
      expect(lo.profiles["default"]!.activity?.silenceWindowSeconds).toBe(1);
      const hi = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: 3600`)));
      expect(hi.profiles["default"]!.activity?.silenceWindowSeconds).toBe(3600);
    });

    it("丢弃越界值（0、3601、-1），使 launcher 默认值生效", () => {
      const zero = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: 0`)));
      expect(zero.profiles["default"]!.activity).toBeUndefined();
      const tooBig = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: 3601`)));
      expect(tooBig.profiles["default"]!.activity).toBeUndefined();
      const negative = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: -1`)));
      expect(negative.profiles["default"]!.activity).toBeUndefined();
    });

    it("丢弃非整数值（3.5、NaN、Infinity）", () => {
      const fractional = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: 3.5`)));
      expect(fractional.profiles["default"]!.activity).toBeUndefined();
      const nan = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: .nan`)));
      expect(nan.profiles["default"]!.activity).toBeUndefined();
      const inf = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: .inf`)));
      expect(inf.profiles["default"]!.activity).toBeUndefined();
    });

    it("丢弃非数值（'seven'、null）——在 parser 边界保持类型安全", () => {
      const stringy = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity:\n      silence_window_seconds: "seven"`)));
      expect(stringy.profiles["default"]!.activity).toBeUndefined();
      const empty = normalizeAgentSpec(parseAgentSpec(baseSpec(`    activity: {}`)));
      expect(empty.profiles["default"]!.activity).toBeUndefined();
    });

    it("activity block 缺席 → spec.profiles.default.activity 为 undefined（应用 launcher 默认值）", () => {
      const raw = normalizeAgentSpec(parseAgentSpec(baseSpec(``)));
      expect(raw.profiles["default"]!.activity).toBeUndefined();
    });
  });
});

// ─── OPR.0.5.6.20 P3——compaction_strategy 接线（锁定 A1 兼容规则）───────
// RED-FIRST：在实现提交前基于 pristine base f7301d6ba 提交。基线状态：四个新值被拒绝（旧封闭
// 集合），alias 情形没有 advisory，normalize 输出旧拼写；下方逐项标注。

describe("compaction_strategy——S20 四模式接线 + A1 兼容（OPR.0.5.6.20）", () => {
  const specWithStrategy = (v: string) => `
version: "0.2"
name: s20-fixture
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: ${v}
profiles:
  default: {}
`;

  it("接受全部四个新 canonical 值（基线 RED：封闭集合拒绝）", () => {
    for (const v of ["default-compaction", "managed-compaction", "handover", "apprentice-handover"]) {
      const result = validateAgentSpec(parseAgentSpec(specWithStrategy(v)));
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it("harness_native：已弃用 alias——校验带 advisory，规范化为 default-compaction（基线 RED：无 advisory，规范化为旧拼写）", () => {
    const raw = parseAgentSpec(specWithStrategy("harness_native"));
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
    expect((result.advisories ?? []).join(" ")).toMatch(/harness_native.*已弃用.*default-compaction/);
    const spec = normalizeAgentSpec(raw);
    expect(spec.defaults.lifecycle.compactionStrategy).toBe("default-compaction");
  });

  it("pod_continuity：已弃用 alias——校验带 advisory，规范化为 handover（基线 RED：无 advisory，规范化为旧拼写）", () => {
    const raw = parseAgentSpec(specWithStrategy("pod_continuity"));
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
    expect((result.advisories ?? []).join(" ")).toMatch(/pod_continuity.*已弃用.*handover/);
    const spec = normalizeAgentSpec(raw);
    expect(spec.defaults.lifecycle.compactionStrategy).toBe("handover");
  });

  it("custom_prompt 拒绝与已发布教学错误按字节一致（回归底线——基线为绿）", () => {
    const result = validateAgentSpec(parseAgentSpec(specWithStrategy("custom_prompt")));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"custom_prompt" is not supported in v1'))).toBe(true);
  });

  it("未知值以点名当前词汇的教学错误拒绝（基线 RED：错误只点名旧集合）", () => {
    const result = validateAgentSpec(parseAgentSpec(specWithStrategy("yolo-mode")));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/default-compaction/);
  });

  it("未指定时规范化为 default-compaction——新名称下的当前行为，F-6 权威（基线 RED：harness_native）", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: s20-fixture
defaults:
  runtime: claude-code
profiles:
  default: {}
`);
    const spec = normalizeAgentSpec(raw);
    expect(spec.defaults.lifecycle.compactionStrategy).toBe("default-compaction");
  });
});

describe("continuity mechanic——AgentSpec lifecycle ingress（S20 A7/A8）", () => {
  const specWithMechanic = (value: string) => `
version: "0.2"
name: mechanic-fixture
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
    mechanic: ${value}
profiles:
  default: {}
`;

  it("接受并保留 canonical 跨 rig seat address", () => {
    const raw = parseAgentSpec(specWithMechanic("operator-agent@kernel"));
    expect(validateAgentSpec(raw).valid).toBe(true);
    expect(normalizeAgentSpec(raw).defaults?.lifecycle?.mechanic).toBe("operator-agent@kernel");
  });

  it("以字段结构错误拒绝非 canonical mechanic address", () => {
    const result = validateAgentSpec(parseAgentSpec(specWithMechanic("operator-agent")));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/lifecycle\.mechanic.*规范.*seat@rig/i);
  });
});
