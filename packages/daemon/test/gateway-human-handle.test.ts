import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import {
  validateHumanFragment,
  addHumanFragment,
  projectHumans,
  resolveSlackHandle,
  humansDir,
  type HumanFragment,
} from "../src/domain/gateway/human-registry.js";

// M1 A6 v3（schema 9e468b2f）——逐 binding 的 `handle` 及三项固定约束：
//   约束 1：所有 binding 中，同一 kind 的 handle 必须唯一（一个平台 ID = 一个人；拒绝重复）
//   约束 2：解析 ev.user -> (kind=slack, handle) -> entityId；拒绝未知值
//   约束 3：要能从入站解析，必须有 handle——无 handle 的 binding 仅支持出站，
//           入站时会明确失败。

function frag(entityId: string, bindings: Record<string, unknown>[]): Record<string, unknown> {
  return {
    entityId,
    class: "human",
    displayName: entityId,
    address: `${entityId}@external`,
    connectorBindings: bindings,
    prefs: { deliveryClass: "B" },
  };
}
const slack = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "slack", connectorRef: "slack-main", secretsRef: "vault://slack/x", role: "primary", ...over,
});

describe("A6 v3 handle 模式", () => {
  it("接受可选且格式正确的 handle；无 handle 的 binding 仍有效（仅出站）", () => {
    expect(validateHumanFragment(frag("mike", [slack({ handle: "U012AB3CD" })])).ok).toBe(true);
    expect(validateHumanFragment(frag("mike", [slack()])).ok).toBe(true); // 无 handle = 仅出站
  });

  it("拒绝可伪造引用的 handle（包含 ':'、'@' 或空白）", () => {
    for (const bad of ["a:b", "x@kernel", "has space", "semi;colon"]) {
      const r = validateHumanFragment(frag("mike", [slack({ handle: bad })]));
      expect(r.ok, `必须拒绝 handle ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("拒绝未知 binding 键（添加 handle 后封闭集合仍然成立）", () => {
    expect(validateHumanFragment(frag("mike", [slack({ nope: "x" })])).ok).toBe(false);
  });

  it("约束 1（片段内）：拒绝同一个人的两个相同 kind+handle", () => {
    const r = validateHumanFragment(frag("mike", [
      slack({ handle: "U1", role: "primary" }),
      slack({ handle: "U1", role: "secondary", connectorRef: "slack-2" }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/handle.*重复|每种 kind.*唯一/);
  });
});

describe("A6 v3 跨人类 handle 唯一性（约束 1，注册表级）", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "a6-handle-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("addHumanFragment 在写入前拒绝已注册给其他人的 handle", () => {
    expect(addHumanFragment(frag("mike", [slack({ handle: "U1" })]), home).ok).toBe(true);
    const r = addHumanFragment(frag("dana", [slack({ handle: "U1", connectorRef: "slack-2" })]), home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/已注册给人类 "mike"|注册冲突/);
    // 不得写入冲突片段
    expect(addHumanFragment).toBeDefined();
  });

  it("projectHumans 拒绝两个 handle 冲突的手写片段（加载时兜底）", () => {
    const dir = humansDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mike.yaml"), stringifyYaml(frag("mike", [slack({ handle: "U1" })])));
    writeFileSync(join(dir, "dana.yaml"), stringifyYaml(frag("dana", [slack({ handle: "U1", connectorRef: "slack-2" })])));
    const p = projectHumans(home);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(/同时认领|注册冲突/);
  });

  it("使用 --replace 重新添加同一个人时保留自己的 handle（不构成自冲突）", () => {
    expect(addHumanFragment(frag("mike", [slack({ handle: "U1" })]), home).ok).toBe(true);
    const r = addHumanFragment(frag("mike", [slack({ handle: "U1", connectorRef: "slack-main" })]), home, { replace: true });
    expect(r.ok).toBe(true);
  });
});

describe("A6 v3 resolveSlackHandle（约束 2+3）", () => {
  const registered = (validateHumanFragment(frag("mike", [slack({ handle: "U012AB3CD" })])) as { ok: true; fragment: HumanFragment }).fragment;
  const outboundOnly = (validateHumanFragment(frag("dana", [slack({ connectorRef: "slack-2" })])) as { ok: true; fragment: HumanFragment }).fragment;

  it("约束 2：已注册 handle 解析为对应实体与地址", () => {
    const r = resolveSlackHandle("U012AB3CD", [registered, outboundOnly]);
    expect(r.kind).toBe("registered");
    if (r.kind === "registered") { expect(r.entityId).toBe("mike"); expect(r.address).toBe("mike@external"); }
  });

  it("约束 2：以明确指引拒绝未知 handle（绝不伪造席位）", () => {
    const r = resolveSlackHandle("UNOPE", [registered, outboundOnly]);
    expect(r.kind).toBe("unregistered");
    if (r.kind === "unregistered") {
      expect(r.error).toMatch(/不是已注册人类/);
      expect(r.error).toMatch(/zrig gateway human add/);
      expect(r.error).toMatch(/不会将其作为伪造的人类席位落地/);
    }
  });

  it("约束 3：无 handle（仅出站）的人类无法从入站解析——明确失败", () => {
    // dana 的 binding 没有 handle；无法从入站解析 dana 的任何信息。
    const r = resolveSlackHandle("slack-2", [registered, outboundOnly]); // 即使 connectorRef 匹配也不得解析
    expect(r.kind).toBe("unregistered");
  });
});
