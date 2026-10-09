// OPR.0.4.8.3 接缝 B（R6）——全链路判别固定项：permission_policy 引用与解析后姿态
// 经历“物化 → 列 → 导出 → 数据库重开”后仍然保留；成员优先于装备，并用重新打开的
// 数据库句柄证明开发护栏的重启裁定（自定义 surface:flag 策略恢复为 full_bypass）。
// 此处每项固定断言都能与接缝 B 前的版本区分（80336ff0/4694e86d 尚无这些列和透传）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFullTestDb, createTestApp, migrationsForFullTestDb } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { resolvePermissionPolicyAttachment } from "../src/domain/permission-policy/policy-ref.js";
import { claudePostureFlag, codexPostureArg, piTrust } from "../src/adapters/yolo-mode.js";

const RIG_ROOT = "/project/rigs/policy-rig";
const CUSTOM_POLICY = `---
policy_schema_version: 1
name: operator-full
source: custom
description: 全绕过标志策略（接缝 A 完成夹具）
surface: flag
launch_posture: full_bypass
---
# 操作员全权限
`;

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function rawMember(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...over };
}

function rawSpec(members: Record<string, unknown>[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.2",
    name: "policy-rig",
    pods: [{ id: "dev", label: "Dev", members, edges: [] }],
    edges: [],
    ...over,
  };
}

function fsOps() {
  return {
    readFile: (p: string) => {
      if (p.includes("agents/impl")) return agentYaml("impl");
      if (p.includes("policies/operator-full.md")) return CUSTOM_POLICY;
      throw new Error(`未找到：${p}`);
    },
    exists: (p: string) => p.includes("agents/impl") || p.includes("policies/operator-full.md"),
  };
}

describe("接缝 B R6——全链路接通（物化 → 列 → 导出）", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
  });
  afterEach(() => { db.close(); });

  it("装备级与成员引用落到各自行；解析时成员覆盖装备（优先级）", async () => {
    const spec = rawSpec(
      [rawMember("impl", { permission_policy: "builtin:locked" }), rawMember("helper")],
      { permission_policy: "builtin:yolo" },
    );
    const outcome = await setup.podInstantiator.materializeStructured(spec, RIG_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;

    // 装备行携带装备引用
    expect(setup.rigRepo.getRigPermissionPolicy(rigId)).toBe("builtin:yolo");
    // 成员自身引用位于节点列；无引用的同工作组成员为 NULL（装备引用位于装备上）
    const refOf = (lid: string) => (db.prepare("SELECT permission_policy FROM nodes WHERE logical_id = ?").get(lid) as { permission_policy: string | null }).permission_policy;
    expect(refOf("dev.impl")).toBe("builtin:locked");
    expect(refOf("dev.helper")).toBeNull();

    // 来源：成员引用优先于装备引用 → impl 为 floor（locked），helper 为 full_bypass（装备 yolo）
    const nodeId = (lid: string) => (db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get(lid) as { id: string }).id;
    expect(setup.rigRepo.getNodePolicyProvenance(nodeId("dev.impl"))).toMatchObject({ origin: "builtin", launchPosture: "floor", resolvedTarget: "policies/builtin/locked.policy.md" });
    expect(setup.rigRepo.getNodePolicyProvenance(nodeId("dev.helper"))).toMatchObject({ origin: "builtin", launchPosture: "full_bypass", resolvedTarget: "policies/builtin/yolo.policy.md" });
  });

  it("导出往返保留两个层级：成员引用位于工作组成员，装备引用位于顶层", async () => {
    const spec = rawSpec(
      [rawMember("impl", { permission_policy: "policies/operator-full.md" })],
      { permission_policy: "builtin:standard" },
    );
    const outcome = await setup.podInstantiator.materializeStructured(spec, RIG_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;

    const exported = setup.rigSpecExporter.exportRig(rigId) as import("../src/domain/types.js").RigSpec;
    expect(exported.permissionPolicy).toBe("builtin:standard");
    expect(exported.pods[0]!.members[0]!.permissionPolicy).toBe("policies/operator-full.md");
  });

  it("自定义 surface:flag 策略在物化时解析为 full_bypass，且来源可跨重启稳定保留", async () => {
    const spec = rawSpec([rawMember("impl", { permission_policy: "policies/operator-full.md" })]);
    const outcome = await setup.podInstantiator.materializeStructured(spec, RIG_ROOT);
    expect(outcome.ok).toBe(true);
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string }).id;
    const prov = setup.rigRepo.getNodePolicyProvenance(nodeId);
    expect(prov).toMatchObject({
      origin: "custom",
      launchPosture: "full_bypass", // 护栏裁定的关键：自定义 flag 可以是 full_bypass
      declaringDir: RIG_ROOT,
      resolvedTarget: `${RIG_ROOT}/policies/operator-full.md`,
      nodeRef: "policies/operator-full.md",
    });
  });
});

describe("接缝 B R6——数据库重开后的重启证明（开发护栏裁定）", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seam-b-reopen-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("自定义 surface:flag=full_bypass 附件从重开的数据库恢复为 full_bypass", async () => {
    const dbFile = join(dir, "daemon.sqlite");
    const db1 = createDb(dbFile);
    // 对文件支持的数据库使用与 createFullTestDb 相同的标准迁移集
    migrate(db1, migrationsForFullTestDb);
    const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
    const outcome = await setup1.podInstantiator.materializeStructured(
      rawSpec([rawMember("impl", { permission_policy: "policies/operator-full.md" })]),
      RIG_ROOT,
    );
    expect(outcome.ok).toBe(true);
    const nodeId = (db1.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string }).id;
    db1.close(); // ── 守护进程重启边界 ──

    const db2 = createDb(dbFile); // 重开：内存中已不存在 RigSpec
    const repo2 = new RigRepository(db2);
    const prov = repo2.getNodePolicyProvenance(nodeId);
    expect(prov).not.toBeNull();
    expect(prov!.launchPosture).toBe("full_bypass"); // 持久化姿态可跨重启稳定保留
    // 同时验证裁定的重新推导：重开后仅从来源信息重新校验策略
    const rederived = resolvePermissionPolicyAttachment(prov!.nodeRef!, prov!.declaringDir!, {
      readFile: (p) => { expect(p).toBe(`${RIG_ROOT}/policies/operator-full.md`); return CUSTOM_POLICY; },
    });
    expect(rederived.launchPosture).toBe("full_bypass");
    expect(rederived.surface).toBe("flag");
    db2.close();
  });
});

describe("接缝 B R6——解析后姿态驱动三个 harness 上的真实启动辅助函数", () => {
  const yoloOn = { OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv;
  const yoloOff = {} as NodeJS.ProcessEnv;

  it("即使 YOLO 关闭，full_bypass 姿态仍提升席位（自定义 flag 策略——裁定）", () => {
    expect(claudePostureFlag(yoloOff, "full_bypass")).toBe("--dangerously-skip-permissions");
    expect(codexPostureArg("", yoloOff, "full_bypass")).toBe(" -s danger-full-access -a never");
    expect(piTrust(undefined, yoloOff, "full_bypass")).toBe("approve"); // Pi 表示资源信任，不是权限策略
  });

  it("即使全局 YOLO 开启，floor 姿态仍将席位保持在最低权限（附加策略权威）", () => {
    expect(claudePostureFlag(yoloOn, "floor")).toBe("--permission-mode acceptEdits");
    expect(codexPostureArg(" -p prof", yoloOn, "floor")).toBe(" -p prof");
    expect(piTrust("no-approve", yoloOn, "floor")).toBe("no-approve");
  });

  it("独立 Slice-02 原语在裸调用时保持环境变量行为（非生命周期调用方；接缝 B 生命周期表层始终传入显式姿态——缺省绑定 floor，已在生命周期套件固定）", () => {
    expect(claudePostureFlag(yoloOn)).toBe("--dangerously-skip-permissions");
    expect(claudePostureFlag(yoloOff)).toBe("--permission-mode acceptEdits");
    expect(codexPostureArg("", yoloOff)).toBe(" -s workspace-write");
    expect(piTrust(undefined, yoloOff)).toBe("no-approve");
  });
});
