import { describe, it, expect } from "vitest";
import {
  validateScenario,
  EXPECT_SURFACES,
  RESERVED_SURFACES,
  type ValidationResult,
} from "./helpers/scenario-schema.js";

// 51-02 delta（guard-CLEAR packet rev-2/rev-3 + PM ruling）——schema 增量：
//   D4  proof surface → RESERVED（PM ruling qitem-20260811092250-a80735bc）
//   D1  env.stub_scripts shape（per-seat script map；相对 topology 的 key CONTRACT 属于
//       pipeline-level——见 scenario-pipeline delta 测试）
//   D3  scope expect 对 env.scope_mission 的 teaching requirement
//   D7  env.tui opt-in + tui_socket 教学要求

const errOf = (r: ValidationResult, code: string) =>
  (r as { ok: false; errors: { code: string; message: string; path: string }[] }).errors.find(
    (e) => e.code === code,
  );
const errCodes = (r: ValidationResult): string[] => (r.ok ? [] : r.errors.map((e) => e.code));

const BASE: Record<string, unknown> = {
  scenario: "delta-schema-pins",
  topology: "fixtures/topo.yaml",
  steps: [{ up: {} }, { down: {} }],
};

describe("D4——proof surface 为 RESERVED（PM ruling a80735bc）", () => {
  it("EXPECT_SURFACES 不再包含 proof；RESERVED_SURFACES 点名它", () => {
    expect(EXPECT_SURFACES as readonly string[]).not.toContain("proof");
    expect(RESERVED_SURFACES as readonly string[]).toContain("proof");
  });

  it("以点名 reservation 与 ruling 的 TEACHING error 拒绝 surface:proof", () => {
    const doc = { ...BASE, steps: [{ expect: { surface: "proof", match: {} } }] };
    const r = validateScenario(doc);
    expect(r.ok).toBe(false);
    const e = errOf(r, "RESERVED_EXPECT_SURFACE")!;
    expect(e).toBeDefined();
    expect(e.message).toContain("没有已交付的读取动词");
    expect(e.message).toContain("已保留");
    expect(e.message).toContain("qitem-20260811092250-a80735bc");
  });

  it("明显未知的 surface 仍报告 UNKNOWN_EXPECT_SURFACE，而非 reserved error", () => {
    const doc = { ...BASE, steps: [{ expect: { surface: "database", match: {} } }] };
    const r = validateScenario(doc);
    expect(errCodes(r)).toContain("UNKNOWN_EXPECT_SURFACE");
    expect(errCodes(r)).not.toContain("RESERVED_EXPECT_SURFACE");
  });
});

describe("D1——env.stub_scripts shape（per-seat script map）", () => {
  it("接受 seat→path string map", () => {
    const doc = { ...BASE, env: { stub_scripts: { worker: "./scripts/worker.json" } } };
    expect(validateScenario(doc).ok).toBe(true);
  });

  it("以具名错误拒绝非 map 的 stub_scripts", () => {
    const doc = { ...BASE, env: { stub_scripts: ["worker.json"] } };
    const r = validateScenario(doc);
    expect(errCodes(r)).toContain("STUB_SCRIPTS_NOT_A_MAP");
  });

  it("拒绝每个 entry 中非 string / 空的 script path，并点名 seat key", () => {
    const doc = { ...BASE, env: { stub_scripts: { worker: "", qa: 7 } } };
    const r = validateScenario(doc);
    const codes = errCodes(r).filter((c) => c === "STUB_SCRIPT_PATH_INVALID");
    expect(codes).toHaveLength(2);
    const first = errOf(r, "STUB_SCRIPT_PATH_INVALID")!;
    expect(first.path).toContain("stub_scripts");
  });
});

describe("D3——scope expect 要求 env.scope_mission（必须提供 zrig scope audit --mission）", () => {
  const scopeStep = { expect: { surface: "scope", match: {} } };

  it("存在 scope expect 且缺少 scope_mission 时给出指引", () => {
    const doc = { ...BASE, steps: [scopeStep] };
    const r = validateScenario(doc);
    const e = errOf(r, "SCOPE_MISSION_MISSING")!;
    expect(e).toBeDefined();
    expect(e.message).toContain("--mission");
  });

  it("scope_mission 为空或非 string 时给出指引", () => {
    for (const bad of ["", 42] as const) {
      const doc = { ...BASE, env: { scope_mission: bad }, steps: [scopeStep] };
      expect(errCodes(validateScenario(doc))).toContain("SCOPE_MISSION_MISSING");
    }
  });

  it("接受带非空 scope_mission 的 scope expect", () => {
    const doc = { ...BASE, env: { scope_mission: "release-0.5.1" }, steps: [scopeStep] };
    expect(validateScenario(doc).ok).toBe(true);
  });

  it("不存在 scope expect 时不要求 scope_mission", () => {
    expect(validateScenario(BASE).ok).toBe(true);
  });
});

describe("D7——env.tui opt-in 控制 tui_socket surface", () => {
  const tuiStep = { expect: { surface: "tui_socket", match: {} } };

  it("存在 tui_socket expect 但没有 env.tui:true 时给出指引", () => {
    const doc = { ...BASE, steps: [tuiStep] };
    const r = validateScenario(doc);
    const e = errOf(r, "TUI_NOT_DECLARED")!;
    expect(e).toBeDefined();
    expect(e.message).toContain("env.tui");
  });

  it("拒绝非 boolean 的 env.tui", () => {
    const doc = { ...BASE, env: { tui: "yes" }, steps: [tuiStep] };
    expect(errCodes(validateScenario(doc))).toContain("ENV_TUI_NOT_BOOLEAN");
  });

  it("env.tui 为 true 时接受 tui_socket expect", () => {
    const doc = { ...BASE, env: { tui: true }, steps: [tuiStep] };
    expect(validateScenario(doc).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D11（由 D1 e2e 发现）——对已交付 text surface 使用 `contains`。
//
// containsMatch 要求 raw string，但已交付 text read 返回的是以 `content` 承载文本的 object：
// `zrig capture --json` => {ok, sessionName, content, lines}；`zrig transcript --json` =>
// {session, lines, content, ingestHealth}。因此 contains mode 无法匹配它仅服务的两个 surface
//（pane/transcript）。此前未被发现，因为没有已落地 scenario 对真实 pane 做断言——scenario-02 的
// pane 环节延期到 items 6–8，而 #10 使用 equals。
