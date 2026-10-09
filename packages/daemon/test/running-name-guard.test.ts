// S5b（OPR.0.5.4.11）——running-name guard，RED-first。复现样本：第一个 rig 仍在运行时，
// 对同一个 spec 名连续执行两次 `rig up`，会静默创建共享名称命名空间的重复 rig
//（dev50-driver 08-26 样本；0.5.3 import-retry 先例）。底线：同名 rig 正在运行时（至少一个
// session 行 status='running'——由后台服务自身派生），每条 instantiator create 路径都要拒绝，
// 告知正在运行的 rig identity 与替代方案，并且不消耗资源。停止 generation 的名称复用行为保持不变。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { checkRunningNameGuard } from "../src/domain/running-name-guard.js";
import type { PodRigSpec } from "../src/domain/types.js";

function rigCount(db: Database.Database, name: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE name = ?").get(name) as { c: number }).c;
}

function sessionCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
}

describe("running-name guard（S5b 底线）", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  /** 一个含单 seat 的同名 rig；session 状态由参数给定。 */
  function existingRig(name: string, sessionStatus: string) {
    const rig = setup.rigRepo.createRig(name);
    const node = setup.rigRepo.addNode(rig.id, "crew.a", { runtime: "claude-code", cwd: "/" });
    const session = setup.sessionRegistry.registerSession(node.id, `crew-a@${name}`);
    setup.sessionRegistry.updateStatus(session.id, sessionStatus);
    return { rig, node, session };
  }

  function flatSpec(name: string) {
    return {
      schemaVersion: 1,
      name,
      version: "1.0.0",
      nodes: [{ id: "solo", runtime: "claude-code" as const, role: "worker", cwd: "/" }],
      edges: [],
    };
  }

  function podSpec(name: string): PodRigSpec {
    return {
      version: "0.2",
      name,
      pods: [{
        id: "crew",
        label: "Crew",
        members: [{ id: "a", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "/" }],
        edges: [],
      }],
      edges: [],
    } as unknown as PodRigSpec;
  }

  function tmuxMock() {
    return setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
  }

  // ——proof 项 1：拒绝第二次 UP，RED-FIRST（flat create 位置）——

  it("同名 rig 运行时拒绝 flat instantiate：给出教学式错误，不创建也不启动任何内容", async () => {
    const { rig } = existingRig("dupe-rig", "running");
    const sessionsBefore = sessionCount(db);

    const result = await setup.rigInstantiator.instantiate(flatSpec("dupe-rig") as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`DEFECT: second up proceeded; rig rows for name = ${rigCount(db, "dupe-rig")}`);
    expect((result as { code: string }).code).toBe("rig_name_running");
    const message = (result as { message: string }).message;
    // Mini-req 2——拒绝信息说明：运行中 rig identity、检查内容、未创建/启动任何内容，以及支持的替代方案。
    expect(message).toContain("dupe-rig");
    expect(message).toContain(rig.id);
    expect(message).toMatch(/1 个运行中的会话/);
    expect(message).toMatch(/已检查/);
    expect(message).toMatch(/未创建或启动任何内容/);
    expect(message).toMatch(/rig down/);
    expect(message).toMatch(/其他名称/);

    // 未创建、未启动，也未消耗资源。
    expect(rigCount(db, "dupe-rig")).toBe(1);
    expect(sessionCount(db)).toBe(sessionsBefore);
    expect(tmuxMock().createSession).not.toHaveBeenCalled();
  });

  // ——proof 项 2：STOPPED-GENERATION 控制（行为锁定不变）——
  //
  // 在基线 ba0550af2 上发现的机制（已记录用于 receipt）：FLAT 路径的 RigSpecPreflight 已会拒绝
  // 任何同名 rig（"Rig name '<x>' already exists"），不论运行状态，因此 flat 路径无法创建重复项。
  // 无守卫的是 POD 路径（`rig up`），样本就发生在那里。因此“不变”表示：flat + stopped generation
  // 保持当前 preflight 拒绝；pod + stopped generation 继续执行。

  it("同名 rig 全部 STOPPED 时，flat instantiate 保持当前 preflight 行为（锁定不变）", async () => {
    existingRig("gen-rig", "exited");
    existingRig("gen-rig", "detached");

    const result = await setup.rigInstantiator.instantiate(flatSpec("gen-rig") as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("flat path behavior changed: proceeded where pre-fix preflight refused");
    expect((result as { code: string }).code).toBe("preflight_failed");
    expect(JSON.stringify((result as { errors?: string[] }).errors)).toContain("已存在");
    expect(rigCount(db, "gen-rig")).toBe(2); // nothing new created — same as today
  });

  // ——proof 项 4：一个守卫覆盖所有路径（pod create 位置）——

  it("pod materializeValidatedSpec 拒绝运行中的同名 rig（create 分支），且不消耗资源", async () => {
    existingRig("dupe-pod", "running");
    const before = rigCount(db, "dupe-pod");

    const result = await setup.podInstantiator.materializeValidatedSpec(podSpec("dupe-pod"), "/tmp", []);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("DEFECT: pod materialize created a duplicate running-name rig");
    expect((result as { code: string }).code).toBe("rig_name_running");
    expect(rigCount(db, "dupe-pod")).toBe(before);
  });

  it("带 targetRigId（expand 路径）的 pod materializeValidatedSpec 不被 guard 阻止", async () => {
    const { rig } = existingRig("expand-rig", "running");

    const result = await setup.podInstantiator.materializeValidatedSpec(
      podSpec("expand-rig"), "/tmp", [], { targetRigId: rig.id },
    );

    // Expansion 指向现有 rig——不会新增 rig 行，因此 guard 不应触发；无论其他结果如何，都不能是
    // running-name 拒绝。
    expect((result as { code?: string }).code).not.toBe("rig_name_running");
    expect(rigCount(db, "expand-rig")).toBe(1);
  });

  it("pod YAML instantiate 在 preflight 前拒绝运行中的同名 rig（rig-up 路径）", async () => {
    existingRig("dupe-yaml", "running");
    const yaml = [
      'version: "0.2"',
      "name: dupe-yaml",
      "pods:",
      "  - id: crew",
      "    label: Crew",
      "    members:",
      "      - id: a",
      '        agent_ref: "builtin:terminal"',
      '        profile: "none"',
      "        runtime: terminal",
      "        cwd: /",
      "    edges: []",
      "edges: []",
    ].join("\n");

    const result = await setup.podInstantiator.instantiate(yaml, "/tmp");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("DEFECT: pod YAML instantiate created a duplicate running-name rig");
    expect((result as { code: string }).code).toBe("rig_name_running");
    expect(rigCount(db, "dupe-yaml")).toBe(1);
    expect(tmuxMock().createSession).not.toHaveBeenCalled();
  });

  it("同名 generation 全部停止时，pod YAML instantiate 可通过 guard", async () => {
    existingRig("gen-yaml", "exited");
    const yaml = [
      'version: "0.2"',
      "name: gen-yaml",
      "pods:",
      "  - id: crew",
      "    label: Crew",
      "    members:",
      "      - id: a",
      '        agent_ref: "builtin:terminal"',
      '        profile: "none"',
      "        runtime: terminal",
      "        cwd: /",
      "    edges: []",
      "edges: []",
    ].join("\n");

    const result = await setup.podInstantiator.instantiate(yaml, "/tmp");

    // 判别依据只有 guard verdict：无论此 harness 的 preflight 产生什么结果，stopped-generation 名称
    // 都不得产生 running-name 拒绝（这是 guard 放行的正面证据）。
    expect((result as { code?: string }).code).not.toBe("rig_name_running");
  });

  // ——helper 自身的契约——

  it("checkRunningNameGuard：verdict 携带运行中 rig identity；全部 stopped 的名称通过", () => {
    const deps = {
      findRigsByName: (name: string) => name === "x" ? [{ id: "RIG1", name: "x" }, { id: "RIG2", name: "x" }] : [],
      countRunningSessions: (rigId: string) => (rigId === "RIG2" ? 2 : 0),
    };

    const blocked = checkRunningNameGuard(deps, "x");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected refusal");
    expect(blocked.runningRig).toEqual({ id: "RIG2", name: "x", runningSessionCount: 2 });
    expect(blocked.message).toMatch(/2 个运行中的会话/);

    const clear = checkRunningNameGuard({ ...deps, countRunningSessions: () => 0 }, "x");
    expect(clear.ok).toBe(true);
  });
});
