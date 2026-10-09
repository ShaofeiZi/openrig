import { describe, it, expect } from "vitest";
import {
  STUB_BEHAVIORS,
  parseStubScript,
  DEFAULT_STUB_SCRIPT,
  StubScriptError,
} from "../src/adapters/stub-script.js";
import { EMIT_BEHAVIORS } from "./helpers/scenario-schema.js";

// Slice 51-01 第 6–8 项——纯 stub 行为脚本模型（pane 托管 runner 执行的确定性驱动器：pane 输出、
// hook 发射和分步计时；PRD §4.2）。此模块无副作用，因此可进行密闭单元测试，runner/adapter
// 也能导入它而不把 daemon 依赖带入 pane。
//
// TWIN-PARITY：stub 行为词汇与 51-02 的 scenario `emit` 动词共享契约
//（scenario-schema.ts EMIT_BEHAVIORS）。生产代码（51-01/src）拥有 canonical 集合；如果两个
// 副本发生漂移，下方逐字节 parity 守卫测试会明确失败（修改任一镜像半边都会在增量中运行跨包
// parity 检查）。

describe("stub-script 行为词汇（twin-parity）", () => {
  it("STUB_BEHAVIORS 与 51-02 的 EMIT_BEHAVIORS 逐字节一致（共享契约，无漂移）", () => {
    expect([...STUB_BEHAVIORS]).toEqual([...EMIT_BEHAVIORS]);
  });

  it("准确包含锁定的四种行为集合", () => {
    expect([...STUB_BEHAVIORS]).toEqual(["compaction", "slow_output", "mid_turn_death", "restore"]);
  });
});

describe("parseStubScript", () => {
  it("解析包含 say + emit 步骤的有效脚本", () => {
    const script = parseStubScript(JSON.stringify({
      steps: [
        { kind: "say", text: "hello from the stub" },
        { kind: "emit", behavior: "compaction" },
      ],
    }));
    expect(script.steps).toHaveLength(2);
    expect(script.steps[0]).toEqual({ kind: "say", text: "hello from the stub" });
    expect(script.steps[1]).toEqual({ kind: "emit", behavior: "compaction" });
  });

  it("接受锁定集合中的每种行为作为 emit 步骤", () => {
    for (const behavior of STUB_BEHAVIORS) {
      const script = parseStubScript(JSON.stringify({ steps: [{ kind: "emit", behavior }] }));
      expect(script.steps[0]).toEqual({ kind: "emit", behavior });
    }
  });

  it("拒绝格式错误的 JSON", () => {
    expect(() => parseStubScript("{not json")).toThrow(StubScriptError);
  });

  it("拒绝非对象或缺少 steps 数组的输入", () => {
    expect(() => parseStubScript(JSON.stringify({}))).toThrow(StubScriptError);
    expect(() => parseStubScript(JSON.stringify({ steps: "nope" }))).toThrow(StubScriptError);
    expect(() => parseStubScript(JSON.stringify([]))).toThrow(StubScriptError);
  });

  it("拒绝未知 step kind", () => {
    expect(() => parseStubScript(JSON.stringify({ steps: [{ kind: "dance" }] }))).toThrow(StubScriptError);
  });

  it("拒绝没有 text 的 say 步骤", () => {
    expect(() => parseStubScript(JSON.stringify({ steps: [{ kind: "say" }] }))).toThrow(StubScriptError);
  });

  it("拒绝未知 emit 行为，并列出允许的集合", () => {
    let err: unknown;
    try {
      parseStubScript(JSON.stringify({ steps: [{ kind: "emit", behavior: "explode" }] }));
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StubScriptError);
    // 消息列出锁定集合（与 51-02 的 UNKNOWN_EMIT_BEHAVIOR 对应）。
    expect(String((err as Error).message)).toContain("compaction");
  });

  it("拒绝仅真实 runtime 支持的 usage_limit（绝不静默成为 stub 空操作）", () => {
    // usage_limit 是已知仅真实 runtime 支持的行为，51-02 会在 stub topology 中令其失败；
    // stub 自身脚本模型必须明确拒绝，而不是接受后丢弃。
    expect(() => parseStubScript(JSON.stringify({ steps: [{ kind: "emit", behavior: "usage_limit" }] })))
      .toThrow(StubScriptError);
  });
});

describe("DEFAULT_STUB_SCRIPT", () => {
  it("是可独立使用的有效内置默认值（prompt+echo+scripted-reply）", () => {
    // 通过解析器往返（结构有效），并至少包含一个 pane 输出步骤，使独立 stub 席位产生可观察输出。
    const reparsed = parseStubScript(JSON.stringify(DEFAULT_STUB_SCRIPT));
    expect(reparsed.steps.length).toBeGreaterThan(0);
    expect(reparsed.steps.some((s) => s.kind === "say")).toBe(true);
  });
});
