// Slice 09 —— HG-8 漂移规则纪律。
//
// 约定的漂移恢复规则为：长时间间隔、跨日或观测冲突 → 重新确认（提出问题，绝不
// 静默切换）。不存在“信号→自动模式”路径。v0 提供 `expiry_or_stale_rule` 字段和
// 保守默认值；下游消费者读取它并提示重新确认。后台服务绝不自动切换绑定。
//
// 本文件在切片源码层固定这项纪律：
//
//   1. 保守的默认规则类型为 `re_confirm_on_long_gap`。
//   2. 校验器拒绝闭集枚举外形似自动切换的规则值。
//   3. 存储在读取期间绝不修改绑定。resolveEffective 是纯函数：相同绑定、相同
//      setAt，可重复执行。
//   4. 源码 grep：rig-mode 领域代码不含暗示自动模式切换的标识符
//      （auto-switch、auto-apply、signal-based 等）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigModeStore } from "../src/domain/rig-mode/rig-mode-store.js";
import { DEFAULT_STALE_RULE } from "../src/domain/rig-mode/rig-mode-defaults.js";
import { STALE_RULES, type OperatorContextModeRecord } from "../src/domain/rig-mode/rig-mode-types.js";
import { validateRecord } from "../src/domain/rig-mode/rig-mode-validator.js";

function makeRecord(overrides?: Partial<OperatorContextModeRecord>): OperatorContextModeRecord {
  return {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
    scope: "qitem",
    expiry_or_stale_rule: "re_confirm_on_long_gap",
    evidence_citation: "operator confirmed debug",
    ...overrides,
  };
}

describe("HG-8 漂移规则机制——约定 §Component 4 + §Q3", () => {
  it("DEFAULT_STALE_RULE 是约定的保守的重新确认规则", () => {
    expect(DEFAULT_STALE_RULE).toBe("re_confirm_on_long_gap");
    expect(STALE_RULES).toContain(DEFAULT_STALE_RULE);
  });

  it("校验器拒绝闭集枚举外形似自动切换的规则值", () => {
    for (const auto of ["auto_switch", "auto_apply", "switch_on_long_gap", "silent_switch", "on_signal"]) {
      const res = validateRecord(makeRecord({ expiry_or_stale_rule: auto as unknown as OperatorContextModeRecord["expiry_or_stale_rule"] }));
      expect(res.ok, `value '${auto}' must be rejected`).toBe(false);
    }
  });

  it("验证器接受 STALE_RULES 的每个成员", () => {
    for (const rule of STALE_RULES) {
      const res = validateRecord(makeRecord({ expiry_or_stale_rule: rule }));
      expect(res.ok, `value '${rule}' must be accepted`).toBe(true);
    }
  });
});

describe("HG-8 —— 存储读取绝不修改绑定（没有静默切换路径）", () => {
  let db: Database.Database;
  let store: RigModeStore;

  beforeEach(() => {
    db = createFullTestDb();
    store = new RigModeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("resolveEffective 是纯函数：重复读取返回相同绑定（相同 setAt）", () => {
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));
    const r1 = store.resolveEffective({ qitemId: "q-1" });
    const r2 = store.resolveEffective({ qitemId: "q-1" });
    const r3 = store.resolveEffective({ qitemId: "q-1" });
    expect(r1).not.toBeNull();
    expect(r2!.binding.setAt).toBe(r1!.binding.setAt);
    expect(r3!.binding.setAt).toBe(r1!.binding.setAt);
    expect(r1!.binding.mode).toBe("debug");
    expect(r2!.binding.mode).toBe("debug");
  });

  it("getBinding 是纯函数：重复读取返回相同记录", () => {
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    const first = store.getBinding("rig", "rig-a");
    const second = store.getBinding("rig", "rig-a");
    expect(first!.setAt).toBe(second!.setAt);
    expect(first!.record).toEqual(second!.record);
  });

  it("listBindings 是纯函数：多次读取的数量和身份保持稳定", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    const a = store.listBindings();
    const b = store.listBindings();
    expect(a.map((x) => x.id).sort()).toEqual(b.map((x) => x.id).sort());
    expect(a.map((x) => x.setAt)).toEqual(b.map((x) => x.setAt));
  });

  // 负向检查——自动切换类别。切片领域模块中没有任何代码路径会根据信号、计时器或
  // 外部观察修改绑定模式。这是“没有静默切换路径”（HG-8）的源码级判别器。
  it("HG-8 源码 grep：rig-mode 领域代码不含 auto-switch/auto-apply/signal-driven 标识符", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const domainDir = path.join(here, "..", "src", "domain", "rig-mode");
    const sources = ["rig-mode-types.ts", "rig-mode-validator.ts", "rig-mode-defaults.ts", "rig-mode-store.ts"];
    const combined = sources.map((f) => fs.readFileSync(path.join(domainDir, f), "utf-8")).join("\n");
    for (const forbidden of [
      "autoSwitch",
      "auto_switch",
      "autoApply",
      "auto_apply",
      "silentSwitch",
      "silent_switch",
      "onSignal",
      "on_signal",
      "fromSignal",
      "from_signal",
      "autoSetMode",
      "auto_set_mode",
    ]) {
      expect(combined.includes(forbidden), `forbidden token '${forbidden}' must not appear in rig-mode domain source`).toBe(false);
    }
  });
});
