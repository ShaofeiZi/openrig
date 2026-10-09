import { describe, it, expect } from "vitest";
import {
  validateScenario,
  EXPECT_SURFACES,
  EMIT_BEHAVIORS,
  type ValidationResult,
} from "./helpers/scenario-schema.js";

// Slice 51-02——证明项 1：schema 保真与明确具名拒绝。验证器接受架构形态的 step，并以不同具名
// 错误分别拒绝未知 expect surface、未知 emit 行为，以及 stub topology 中的 emit usage_limit
//（仅真实 runtime 支持，绝不静默成为空操作）。另覆盖结构保真和禁止 wall-clock 作为断言输入的守卫。

const errCodes = (r: ValidationResult): string[] =>
  r.ok ? [] : r.errors.map((e) => e.code);

const VALID: Record<string, unknown> = {
  scenario: "queue-baton-survives-restart",
  topology: "fixtures/two-seat.yaml",
  steps: [
    { up: {} },
    { send: { to: "dev-impl@rig", text: "work" } },
    { expect: { surface: "queue", within: "5s", match: { state: "in-progress" } } },
    { down: {} },
  ],
};

describe("validateScenario——schema 保真与明确拒绝", () => {
  it("接受结构良好的架构形态 scenario", () => {
    const r = validateScenario(VALID);
    expect(r.ok).toBe(true);
  });

  it("以列出允许集合的具名错误拒绝未知 expect surface", () => {
    const doc = { ...VALID, steps: [{ expect: { surface: "database", match: {} } }] };
    const r = validateScenario(doc);
    expect(r.ok).toBe(false);
    expect(errCodes(r)).toContain("UNKNOWN_EXPECT_SURFACE");
    const e = (r as { ok: false; errors: { code: string; message: string }[] }).errors.find(
      (x) => x.code === "UNKNOWN_EXPECT_SURFACE",
    )!;
    expect(e.message).toContain("database");
    // 列出允许的 surface，便于作者自行修正。
    for (const s of EXPECT_SURFACES) expect(e.message).toContain(s);
  });

  it("以列出四种允许行为的具名错误拒绝未知 emit 行为", () => {
    const doc = { ...VALID, steps: [{ emit: { seat: "dev-impl@rig", behavior: "explode" } }] };
    const r = validateScenario(doc);
    expect(r.ok).toBe(false);
    expect(errCodes(r)).toContain("UNKNOWN_EMIT_BEHAVIOR");
    const e = (r as { ok: false; errors: { code: string; message: string }[] }).errors.find(
      (x) => x.code === "UNKNOWN_EMIT_BEHAVIOR",
    )!;
    for (const b of EMIT_BEHAVIORS) expect(e.message).toContain(b);
  });

  it("在 STUB topology 中以独立具名错误拒绝 emit usage_limit（而非 unknown-behavior）", () => {
    const doc = { ...VALID, steps: [{ emit: { seat: "dev-impl@rig", behavior: "usage_limit" } }] };
    const r = validateScenario(doc, { topologyKind: "stub" });
    expect(r.ok).toBe(false);
    expect(errCodes(r)).toContain("USAGE_LIMIT_IN_STUB_TOPOLOGY");
    // 不能误归类为未知行为；它是已知仅真实 runtime 支持的行为。
    expect(errCodes(r)).not.toContain("UNKNOWN_EMIT_BEHAVIOR");
    const e = (r as { ok: false; errors: { code: string; message: string }[] }).errors.find(
      (x) => x.code === "USAGE_LIMIT_IN_STUB_TOPOLOGY",
    )!;
    expect(e.message).toContain("usage_limit");
    expect(e.message).toContain("仅限真实 runtime");
  });

  it("在真实 runtime topology 中接受 emit usage_limit", () => {
    const doc = { ...VALID, steps: [{ emit: { seat: "dev-impl@rig", behavior: "usage_limit" } }] };
    const r = validateScenario(doc, { topologyKind: "real" });
    expect(r.ok).toBe(true);
  });

  it("要求提供 scenario 名称、topology 和 steps", () => {
    expect(errCodes(validateScenario({ topology: "x", steps: [] }))).toContain("SCENARIO_NAME_MISSING");
    expect(errCodes(validateScenario({ scenario: "x", steps: [] }))).toContain("TOPOLOGY_MISSING");
    expect(errCodes(validateScenario({ scenario: "x", topology: "y" }))).toContain("STEPS_MISSING");
    expect(errCodes(validateScenario("not-an-object"))).toContain("SCENARIO_NOT_OBJECT");
  });

  it("拒绝不是单键对象的 step", () => {
    const doc = { ...VALID, steps: [{ up: {}, down: {} }] };
    expect(errCodes(validateScenario(doc))).toContain("STEP_NOT_SINGLE_KEY");
  });

  it("拒绝未知 step 动词", () => {
    const doc = { ...VALID, steps: [{ teleport: {} }] };
    expect(errCodes(validateScenario(doc))).toContain("UNKNOWN_STEP_VERB");
  });

  it("要求 expect 恰好指定一种匹配模式", () => {
    const none = { ...VALID, steps: [{ expect: { surface: "ps" } }] };
    expect(errCodes(validateScenario(none))).toContain("EXPECT_MATCH_MODE_MISSING");
    const both = { ...VALID, steps: [{ expect: { surface: "ps", match: {}, contains: "x" } }] };
    expect(errCodes(validateScenario(both))).toContain("EXPECT_MATCH_MODE_AMBIGUOUS");
  });

  it("验证后台服务生命周期动词 op 集合（sigterm|restart），与席位 restart 区分", () => {
    expect(validateScenario({ ...VALID, steps: [{ daemon: { op: "sigterm" } }] }).ok).toBe(true);
    expect(validateScenario({ ...VALID, steps: [{ daemon: { op: "restart" } }] }).ok).toBe(true);
    expect(errCodes(validateScenario({ ...VALID, steps: [{ daemon: { op: "reboot" } }] }))).toContain("UNKNOWN_DAEMON_OP");
    // 席位级 restart 是另一个动词，本身仍有效。
    expect(validateScenario({ ...VALID, steps: [{ restart: "dev-impl@rig" }] }).ok).toBe(true);
  });

  it("拒绝用 wall-clock 值作为 within 边界（within 是相对时长，绝不是断言输入）", () => {
    const iso = { ...VALID, steps: [{ expect: { surface: "ps", within: "2026-08-05T21:00:00Z", match: {} } }] };
    expect(errCodes(validateScenario(iso))).toContain("WITHIN_NOT_A_DURATION");
    // 相对时长有效。
    for (const w of ["5s", "500ms", "2m", "1500"]) {
      const ok = { ...VALID, steps: [{ expect: { surface: "ps", within: w, match: {} } }] };
      expect(validateScenario(ok).ok).toBe(true);
    }
  });
});
