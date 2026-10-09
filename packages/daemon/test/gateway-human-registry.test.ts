import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import {
  validateHumanFragment,
  addHumanFragment,
  projectHumans,
  writeProjection,
  loadHumanRegistry,
  humansDir,
  projectionPath,
  OPERATOR_HUMAN_DEFAULT_SLOT,
  type HumanFragment,
} from "../src/domain/gateway/human-registry.js";

// M1 A3——human fragment + 生成的 registry 投影。Schema b2a2594b
//（prefs 逐 ENTITY，role 逐 BINDING）。Proof-5：两个 fragment → 投影；
// fragment 编辑会重新投影；手工编辑投影会被拒绝。

function fragment(over: Partial<HumanFragment> = {}): Record<string, unknown> {
  const entityId = (over.entityId as string) ?? "mike";
  return {
    entityId,
    class: "human",
    displayName: "Mike",
    address: `${entityId}@external`, // 已登记约定；覆盖此值用于测试固定规则。
    connectorBindings: [
      { kind: "slack", connectorRef: "slack-main", secretsRef: "vault://slack/mike", role: "primary" },
    ],
    prefs: { deliveryClass: "B" },
    ...over,
  };
}

describe("A3 human fragment 校验（添加时 == 加载时）", () => {
  it("接受格式正确的 fragment", () => {
    const r = validateHumanFragment(fragment());
    expect(r.ok).toBe(true);
  });

  it("拒绝未知 class（闭合枚举）", () => {
    const r = validateHumanFragment(fragment({ class: "agent" as HumanFragment["class"] }));
    expect(r.ok).toBe(false);
  });

  it("拒绝未知 connector kind（闭合枚举）", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [{ kind: "telegram", connectorRef: "x", secretsRef: "v", role: "primary" }] });
    expect(r.ok).toBe(false);
  });

  it("拒绝零个 connectorBindings（必须 >=1）", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [] });
    expect(r.ok).toBe(false);
  });

  it("拒绝没有 primary binding 的 entity（必须恰好一个）", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [{ kind: "slack", connectorRef: "x", secretsRef: "v", role: "secondary" }] });
    expect(r.ok).toBe(false);
  });

  it("拒绝有两个 primary binding 的 entity（必须恰好一个）", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [
      { kind: "slack", connectorRef: "a", secretsRef: "v1", role: "primary" },
      { kind: "slack", connectorRef: "b", secretsRef: "v2", role: "primary" },
    ] });
    expect(r.ok).toBe(false);
  });

  it("接受多个 binding 且恰好一个 primary（逐 binding 路由）", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [
      { kind: "slack", connectorRef: "a", secretsRef: "v1", role: "primary" },
      { kind: "slack", connectorRef: "b", secretsRef: "v2", role: "secondary" },
    ] });
    expect(r.ok).toBe(true);
  });

  it("拒绝无效 deliveryClass（A-D 闭合集合）", () => {
    const r = validateHumanFragment(fragment({ prefs: { deliveryClass: "E" } as HumanFragment["prefs"] }));
    expect(r.ok).toBe(false);
  });

  it("拒绝空 secretsRef（必须是指针，绝不是 secret 本身）", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [{ kind: "slack", connectorRef: "x", secretsRef: "", role: "primary" }] });
    expect(r.ok).toBe(false);
  });

  it("拒绝非 slug 的 entityId", () => {
    expect(validateHumanFragment(fragment({ entityId: "Mike Jones" })).ok).toBe(false);
    expect(validateHumanFragment(fragment({ entityId: "../evil" })).ok).toBe(false);
  });

  it("human-operator@kernel 是 fallback 人工 slot，而不是 fragment", () => {
    expect(OPERATOR_HUMAN_DEFAULT_SLOT).toBe("human-operator@kernel");
  });
});

describe("A3 proof-5——fragment → 生成投影；重新投影；拒绝手工编辑", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "a3-humans-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("两个 fragment（founder + 一个）→ 投影列出两者、排序并带 DO-NOT-EDIT header", () => {
    expect(addHumanFragment(fragment({ entityId: "mike", address: "mike@external" }), home).ok).toBe(true);
    expect(addHumanFragment(fragment({ entityId: "founder", displayName: "Founder", address: "founder@external" }), home).ok).toBe(true);

    // 两个 fragment 文件均存在。
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
    expect(existsSync(join(humansDir(home), "founder.yaml"))).toBe(true);

    const proj = readFileSync(projectionPath(home), "utf8");
    expect(proj).toContain("GENERATED FILE — DO NOT EDIT");

    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.entities.map((e) => e.entityId)).toEqual(["founder", "mike"]); // 已排序。
    }
  });

  it("编辑 fragment 会重新投影（投影追踪作为事实的 fragment）", () => {
    addHumanFragment(fragment({ entityId: "mike", prefs: { deliveryClass: "B" } }), home);
    const before = readFileSync(projectionPath(home), "utf8");
    // 通过显式 replace 路径编辑 fragment（deliveryClass B → D）并重新投影。
    expect(addHumanFragment(fragment({ entityId: "mike", prefs: { deliveryClass: "D" } }), home, { replace: true }).ok).toBe(true);
    const after = readFileSync(projectionPath(home), "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("deliveryClass: D");
    expect(loadHumanRegistry(home).ok).toBe(true);
  });

  it("加载时拒绝手工编辑的投影（fragment 是事实源）", () => {
    addHumanFragment(fragment({ entityId: "mike" }), home);
    expect(loadHumanRegistry(home).ok).toBe(true); // 干净状态。
    // 手工编辑生成的投影。
    const p = projectionPath(home);
    writeFileSync(p, readFileSync(p, "utf8") + "\n# sneaky hand edit\n");
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/手工编辑|漂移/);
  });

  it("加载时拒绝按规范序列化但语义被手工修改的旧版投影", () => {
    const original = fragment({ entityId: "founder", displayName: "Founder", address: "founder@external" });
    addHumanFragment(original, home);
    const path = projectionPath(home);
    const legacy = readFileSync(path, "utf8").replace(
      /# Projection format: v2 content-addressed\n# projection-body-sha256: [a-f0-9]{64}\n/,
      "",
    );
    const originalBody = stringifyYaml({ entities: [original] });
    expect(legacy.endsWith(originalBody)).toBe(true);
    const handEdited = legacy.slice(0, -originalBody.length) + stringifyYaml({
      entities: [fragment({ entityId: "founder", displayName: "Hand Edited Founder", address: "founder@external" })],
    });
    writeFileSync(path, handEdited);

    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/手工编辑|漂移/);
    expect(readFileSync(path, "utf8")).toBe(handEdited);
  });

  it("被动读取校验兼容的旧版投影，但不重写它", () => {
    addHumanFragment(fragment({ entityId: "mike" }), home);
    const path = projectionPath(home);
    const legacy = readFileSync(path, "utf8").replace(
      /# Projection format: v2 content-addressed\n# projection-body-sha256: [a-f0-9]{64}\n/, "",
    );
    writeFileSync(path, legacy);
    expect(loadHumanRegistry(home, { readOnly: true }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(legacy);
  });

  it("一次性接受规范旧版投影，并重写为内容寻址格式", () => {
    addHumanFragment(fragment({ entityId: "mike" }), home);
    const path = projectionPath(home);
    const legacy = readFileSync(path, "utf8").replace(
      /# Projection format: v2 content-addressed\n# projection-body-sha256: [a-f0-9]{64}\n/,
      "",
    );
    writeFileSync(path, legacy);

    expect(loadHumanRegistry(home).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/Projection format: v2 content-addressed/);
  });

  it("磁盘上的无效 fragment 会使投影明确失败（加载时 == 添加时）", () => {
    addHumanFragment(fragment({ entityId: "mike" }), home);
    // 在有效 fragment 旁放入结构无效的 fragment。
    writeFileSync(join(humansDir(home), "bad.yaml"), "entityId: bad\nclass: human\n"); // 缺少 bindings/prefs。
    const proj = projectHumans(home);
    expect(proj.ok).toBe(false);
  });

  it("拒绝 filename != <entityId>.yaml（无冲突 key）", () => {
    addHumanFragment(fragment({ entityId: "mike" }), home); // 创建 humansDir + mike.yaml。
    // 内容有效的 fragment 使用错误文件名：entityId 为 "mike"，文件却是 wrongname.yaml。
    writeFileSync(join(humansDir(home), "wrongname.yaml"), stringifyYaml(fragment({ entityId: "mike" })));
    const proj = projectHumans(home);
    expect(proj.ok).toBe(false);
  });

  // pt2 r1 必须项——禁止静默覆盖（受管配置数据安全；镜像 addHostEntry）。
  it("addHumanFragment 拒绝既有 entityId（不静默覆盖）", () => {
    expect(addHumanFragment(fragment({ entityId: "founder", displayName: "Founder" }), home).ok).toBe(true);
    const dup = addHumanFragment(fragment({ entityId: "founder", displayName: "Impostor" }), home);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("已存在");
    // 磁盘上的 fragment 保持不变，不被覆盖。
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok && loaded.entities[0]!.displayName).toBe("Founder");
  });

  it("addHumanFragment { replace: true } 是显式更新路径", () => {
    addHumanFragment(fragment({ entityId: "founder", displayName: "Founder" }), home);
    const r = addHumanFragment(fragment({ entityId: "founder", displayName: "Founder Renamed" }), home, { replace: true });
    expect(r.ok).toBe(true);
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok && loaded.entities[0]!.displayName).toBe("Founder Renamed");
  });
});

describe("A3 pt2——加固（r1 汇总备注）", () => {
  it("拒绝未知顶层 key（拼写错误不得静默降级）", () => {
    expect(validateHumanFragment({ ...fragment(), bogus: 1 }).ok).toBe(false);
  });
  it("拒绝 prefs 内未知 key（awya 拼写错误）", () => {
    expect(validateHumanFragment(fragment({ prefs: { deliveryClass: "B", awya: true } as unknown as HumanFragment["prefs"] })).ok).toBe(false);
  });
  it("拒绝 connectorBinding 内未知 key", () => {
    expect(validateHumanFragment({ ...fragment(), connectorBindings: [{ kind: "slack", connectorRef: "x", secretsRef: "v", role: "primary", bogus: 1 }] }).ok).toBe(false);
  });
  it("将 address 固定为 <entityId>@external（mike@externalx 不是已登记 ref）", () => {
    expect(validateHumanFragment(fragment({ entityId: "mike", address: "mike@externalx" })).ok).toBe(false);
    expect(validateHumanFragment(fragment({ entityId: "mike", address: "mike@external" })).ok).toBe(true);
    expect(validateHumanFragment(fragment({ entityId: "mike", address: "other@external" })).ok).toBe(false); // 必须匹配 entityId。
  });
});

// `zrig gateway human add` 动词集成测试已移至 cli/test/gateway-human-registry-verb.test.ts；
// 该动词位于 CLI package，并通过 @openrig/daemon/gateway-human-registry 子路径延迟导入本模块。
