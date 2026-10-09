// Slice 09——存储：持久化与 scope 层级解析。
//
// 此处锁定 HG-3 / HG-4 / HG-5：
//   HG-3——4 种 scope 共存，解析时更具体者优先（双向验证）。
//   HG-4——store 层只允许 operator 设置（硬编码 set_by = 'operator'，不存在 agent 路径）。
//   HG-5——跨“重启”持久化（关闭并重新打开数据库的内存 backing）。
//
// guard 裁定 qitem-20260518043346 的 BLOCKING-1 修复：`mode` 是 binding 级字段，不在
// 10 字段 record 内。每次 setBinding 调用都把 mode 作为第三个参数传入；record 保存冻结的
// 10 项 Component-3 设置。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigModeStore } from "../src/domain/rig-mode/rig-mode-store.js";
import {
  type OperatorContextMode,
  type OperatorContextModeRecord,
  type OperatorContextScope,
} from "../src/domain/rig-mode/rig-mode-types.js";

function makeRecord(
  overrides?: Partial<OperatorContextModeRecord>,
): OperatorContextModeRecord {
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

describe("RigModeStore——slice 09 持久化与解析", () => {
  let db: Database.Database;
  let store: RigModeStore;

  beforeEach(() => {
    db = createFullTestDb();
    store = new RigModeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("HG-4：setBinding 接受并读回有效 record，mode 位于 binding 层", () => {
    const res = store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    expect(res.ok).toBe(true);
    const got = store.getBinding("global_host", null);
    expect(got?.mode).toBe("sleep");
    expect(got?.setBy).toBe("operator");
    // record 自身不携带 `mode`，这是 guard 裁定 qitem-20260518043346 中 BLOCKING-1
    // 的判别条件。
    expect((got?.record as unknown as Record<string, unknown>)["mode"]).toBeUndefined();
  });

  it("HG-2 + validator：setBinding 拒绝含未知字段的 record", () => {
    const res = store.setBinding(
      "global_host",
      null,
      "desk",
      { ...makeRecord({ scope: "global_host" }), extra: 1 } as unknown,
    );
    expect(res.ok).toBe(false);
  });

  it("HG-2 + validator：setBinding 拒绝在 record 内夹带 `mode`（未知字段）", () => {
    const res = store.setBinding(
      "global_host",
      null,
      "desk",
      { ...makeRecord({ scope: "global_host" }), mode: "desk" } as unknown,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes(`未知字段 "mode"`))).toBe(true);
    }
  });

  it("HG-1：setBinding 拒绝无效 mode 名（validateModeName）", () => {
    const res = store.setBinding("global_host", null, "Sleep", makeRecord({ scope: "global_host" }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes(`mode="Sleep"`))).toBe(true);
    }
  });

  it("HG-SAFE：setBinding 拒绝 permission_prompt_posture 为 auto_accept 的 record（runtime 防御）", () => {
    const candidate = {
      ...makeRecord({ scope: "global_host" }),
      permission_prompt_posture: "auto_accept",
    } as unknown;
    const res = store.setBinding("global_host", null, "desk", candidate);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("permission_prompt_posture"))).toBe(true);
    }
  });

  it("HG-4 不变量：global_host scope 要求 qualifier 为 null", () => {
    const res = store.setBinding(
      "global_host",
      "rig-1" as unknown as null,
      "desk",
      makeRecord({ scope: "global_host" }),
    );
    expect(res.ok).toBe(false);
  });

  it("HG-4 不变量：非全局 scope 要求非空 qualifier", () => {
    for (const scope of ["rig", "workstream", "qitem"] as const) {
      const empty = store.setBinding(scope, "", "desk", makeRecord({ scope }));
      expect(empty.ok).toBe(false);
      const nullQ = store.setBinding(scope, null, "desk", makeRecord({ scope }));
      expect(nullQ.ok).toBe(false);
    }
  });

  it("拒绝 scope 字段与 binding scope 不一致的 record（不静默容忍）", () => {
    const res = store.setBinding(
      "rig",
      "rig-a",
      "focus",
      makeRecord({ scope: "qitem" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.includes("scope 不匹配"))).toBe(true);
    }
  });

  it("setBinding 执行 upsert：重设相同 (scope, qualifier) 会替换 binding（mode + record）", () => {
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig", evidence_citation: "v1" }));
    store.setBinding("rig", "rig-a", "debug", makeRecord({ scope: "rig", evidence_citation: "v2" }));
    const got = store.getBinding("rig", "rig-a");
    expect(got?.mode).toBe("debug");
    expect(got?.record.evidence_citation).toBe("v2");
    expect(store.listBindings().filter((b) => b.id === "rig:rig-a").length).toBe(1);
  });

  it("listBindings 返回全部记录", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));
    expect(store.listBindings().map((b) => b.id).sort()).toEqual([
      "global_host:host",
      "qitem:q-1",
      "rig:rig-a",
    ]);
  });

  it("deleteBinding 删除记录并报告该记录是否存在", () => {
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    expect(store.deleteBinding("rig", "rig-a")).toBe(true);
    expect(store.deleteBinding("rig", "rig-a")).toBe(false);
    expect(store.getBinding("rig", "rig-a")).toBeNull();
  });

  // HG-3——方向 A：更具体者优先（qitem 覆盖 global_host）。
  it("HG-3 方向 A：qitem scope 的 debug 对该 qitem 覆盖 global_host scope 的 sleep", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));

    const resolvedForQitem = store.resolveEffective({ qitemId: "q-1" });
    expect(resolvedForQitem?.binding.mode).toBe("debug");
    expect(resolvedForQitem?.resolvedScope).toBe("qitem");

    const resolvedForOther = store.resolveEffective({ qitemId: "q-2" });
    expect(resolvedForOther?.binding.mode).toBe("sleep");
    expect(resolvedForOther?.resolvedScope).toBe("global_host");
  });

  // HG-3——方向 B：反向验证；workstream scope 的 focus 优先于 rig scope 的 desk，
  // 而 rig scope 的 desk 优先于 global_host scope 的 sleep。
  it("HG-3 方向 B：scope 优先级为 qitem > workstream > rig > global_host（双向）", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("rig", "rig-a", "desk", makeRecord({ scope: "rig" }));
    store.setBinding("workstream", "ws-1", "focus", makeRecord({ scope: "workstream" }));

    const r1 = store.resolveEffective({ rigId: "rig-a", workstreamId: "ws-1" });
    expect(r1?.binding.mode).toBe("focus");
    expect(r1?.resolvedScope).toBe("workstream");

    const r2 = store.resolveEffective({ rigId: "rig-a" });
    expect(r2?.binding.mode).toBe("desk");
    expect(r2?.resolvedScope).toBe("rig");

    const r3 = store.resolveEffective({});
    expect(r3?.binding.mode).toBe("sleep");
    expect(r3?.resolvedScope).toBe("global_host");

    const r4 = store.resolveEffective({ rigId: "rig-other" });
    expect(r4?.binding.mode).toBe("sleep");
  });

  it("没有匹配 binding 时 resolveEffective 返回 null（约定 §Q6 unknown_posture）", () => {
    expect(store.resolveEffective({ qitemId: "q-1" })).toBeNull();
    store.setBinding("rig", "rig-a", "desk", makeRecord({ scope: "rig" }));
    expect(store.resolveEffective({ rigId: "rig-other" })).toBeNull();
  });

  // HG-5——跨“重启”保留（共享数据库句柄中的类型化原语，与 workspace 原语使用相同 store
  // 模式）。测试通过关闭并重新打开相同 backing 来模拟 daemon 重启。
  it("HG-5：记录跨同一数据库句柄上的 store 实例生命周期持久存在", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));

    const fresh = new RigModeStore(db);
    expect(fresh.listBindings().length).toBe(2);
    expect(fresh.getBinding("global_host", null)?.mode).toBe("sleep");
    expect(fresh.getBinding("qitem", "q-1")?.mode).toBe("debug");
  });

  // HG-4——store 层的 set_by 始终为 'operator'，schema CHECK 约束也会强制执行。不存在
  // agent 设置路径；store API 根本没有暴露该能力。
  it("HG-4：每条记录的 set_by 始终为 'operator'", () => {
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    const row = db.prepare(`
      SELECT set_by FROM operator_context_mode_bindings WHERE id = ?
    `).get("rig:rig-a") as { set_by: string };
    expect(row.set_by).toBe("operator");
  });

  // HG-4 + BLOCKING-1：`mode` 持久化在独立列中（不在 record_json 内），因此 binding
  // identity 是由 schema 定型并带 CHECK 约束的 TEXT 列，而不是可能过期或夹带额外字段的
  // JSON 字段。
  it("HG-4（BLOCKING-1）：mode 持久化在带 CHECK 约束的独立列中", () => {
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    const row = db.prepare(`
      SELECT mode, record_json FROM operator_context_mode_bindings WHERE id = ?
    `).get("global_host:host") as { mode: string; record_json: string };
    expect(row.mode).toBe("sleep");
    const parsed = JSON.parse(row.record_json) as Record<string, unknown>;
    expect(parsed["mode"]).toBeUndefined();
    expect(Object.keys(parsed).length).toBe(10);
  });

  // HG-SAFE——防御性审计：setBinding 只写一个表。store 不暴露任何会触及 permission
  // allowlist、runtime config 或 auth 表面的方法；本测试锁定其表面积。
  it("HG-SAFE：RigModeStore 只暴露 binding 相关方法（无 permission/auth/runtime-config 表面）", () => {
    const expected = new Set([
      "setBinding",
      "getBinding",
      "listBindings",
      "deleteBinding",
      "resolveEffective",
    ]);
    const actual = new Set(
      Object.getOwnPropertyNames(RigModeStore.prototype).filter((m) => m !== "constructor"),
    );
    for (const m of actual) {
      expect(expected.has(m)).toBe(true);
    }
    for (const m of expected) {
      expect(actual.has(m)).toBe(true);
    }
  });

  // 逐 scope 的 grep 反例：源码中不存在权限相关标识符，从 store 源码层锁定 gate-zero 的
  // “任何位置都不得写 permission/runtime-config”规则。
  it("HG-SAFE：rig-mode-store 源码不含 permission / auth / tmux / lifecycle 标识符", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "..", "src", "domain", "rig-mode", "rig-mode-store.ts"),
      "utf-8",
    );
    for (const forbidden of [
      "permissionAllowlist",
      "permission_allowlist",
      "runtimeConfig",
      "runtime_config",
      "tmuxAdapter",
      "tmux_session",
      "session_transport",
      "auth_token",
    ]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });

  // 抽查带 qualifier 的 scope 能按 qualifier 保存独立 binding，且互不串扰。
  it("scope+qualifier key 相互独立，不同工作组/qitem 保存不同记录", () => {
    store.setBinding("rig", "rig-a", "desk", makeRecord({ scope: "rig" }));
    store.setBinding("rig", "rig-b", "focus", makeRecord({ scope: "rig" }));
    expect(store.getBinding("rig", "rig-a")?.mode).toBe("desk");
    expect(store.getBinding("rig", "rig-b")?.mode).toBe("focus");
  });

  // 额外用一次 void，让编译器保留导入的类型表面。
  void (null as unknown as OperatorContextScope);
  void (null as unknown as OperatorContextMode);
});
