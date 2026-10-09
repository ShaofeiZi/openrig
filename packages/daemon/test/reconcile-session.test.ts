// OPR.0.3.4.3 — 无启动协调（接入手动恢复的规范会话）。
//
// “无输入”判别条件（guard rev1，关键约束）：spy tmux 适配器证明 reconcile_session
// 不会对目标调用 launchNode / createSession / killSession / sendText / sendKeys；
// 仅凭 PID 未变化无法发现这类输入注入。deliverClaimHint 由 sendText+sendKeys 实现，
// 因此确认这两个方法调用次数为零，也就覆盖了它。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExpansionRequest } from "../src/domain/types.js";
import { convergeOp, SUPPORTED_OP_KINDS, isSupportedOpKind } from "../src/domain/topology-converge.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

/** 完整插桩的 tmux 适配器：按方法名称记录每次调用。 */
function spyTmux(overrides?: Partial<Record<string, unknown>>) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string, impl: (...args: unknown[]) => unknown) =>
    vi.fn((...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return impl(...args);
    });
  const adapter = {
    hasSession: record("hasSession", async () => true),
    createSession: record("createSession", async () => ({ ok: true as const })),
    killSession: record("killSession", async () => ({ ok: true as const })),
    sendText: record("sendText", async () => ({ ok: true as const })),
    sendKeys: record("sendKeys", async () => ({ ok: true as const })),
    listSessions: record("listSessions", async () => []),
    listWindows: record("listWindows", async () => []),
    listPanes: record("listPanes", async () => []),
    startPipePane: record("startPipePane", async () => ({ ok: true as const })),
    stopPipePane: record("stopPipePane", async () => ({ ok: true as const })),
    setSessionOption: record("setSessionOption", async () => ({ ok: true as const })),
    getSessionOption: record("getSessionOption", async () => null),
    getPanePid: record("getPanePid", async () => 4242),
    getPaneCommand: record("getPaneCommand", async () => "zsh"),
    ...overrides,
  } as unknown as TmuxAdapter;
  return { adapter, calls };
}

function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
  return {
    id,
    label: "Infrastructure",
    members: [{ id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }],
    edges: [],
  };
}

describe("ClaimService.reconcileSession (OPR.0.3.4.3)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let tmuxCalls: Record<string, unknown[][]>;

  beforeEach(() => {
    db = createFullTestDb();
    const spy = spyTmux();
    tmuxCalls = spy.calls;
    setup = createTestApp(db, { tmux: spy.adapter });
  });

  afterEach(() => { db.close(); });

  /** 创建一个受管席位后模拟故障：后台服务的最新会话行变为非运行状态，但实时 tmux
   *  会话仍保留规范名称（操作员已在其中手动恢复）。 */
  async function seedDetachedSeat(podId = "infra", memberId = "server") {
    const rig = setup.rigRepo.createRig("test-rig");
    const expanded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment(podId, memberId) });
    expect(expanded.ok).toBe(true);
    const node = setup.rigRepo.getRig(rig.id)!.nodes.find((n) => n.logicalId === `${podId}.${memberId}`)!;
    const sessionName = `${podId}-${memberId}@test-rig`;
    const sessions = setup.sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    for (const s of sessions) setup.sessionRegistry.markDetached(s.id);
    return { rig, node, sessionName };
  }

  function latestSessionStatus(nodeId: string): string | undefined {
    const row = db.prepare("SELECT status FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(nodeId) as { status: string } | undefined;
    return row?.status;
  }

  it("将实时会话重新接入持久化节点：节点 ID 不变，投影切换为 running", async () => {
    const { rig, node, sessionName } = await seedDetachedSeat();
    expect(latestSessionStatus(node.id)).toBe("detached");

    const result = await setup.claimService.reconcileSession({ sessionName });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 不重新分配标识：保持同一个节点 ID、逻辑 ID 和工作组。
    expect(result.result.nodeId).toBe(node.id);
    expect(result.result.logicalId).toBe("infra.server");
    expect(result.result.rigId).toBe(rig.id);
    // 投影已翻转：最新会话行状态为 running（ps 存活性来源）。
    expect(latestSessionStatus(node.id)).toBe("running");
    // 绑定指向实时规范会话。
    expect(setup.sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe(sessionName);
    // 节点表不变：没有创建新节点。
    const nodes = setup.rigRepo.getRig(rig.id)!.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe(node.id);
  });

  it("reconcileSession 用实时窗格替换 NULL 绑定窗格，下一次身份检查可验证该绑定", async () => {
    const localDb = createFullTestDb();
    const panes = [{ id: "%refreshed", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }];
    const spy = spyTmux({
      listSessions: vi.fn(async () => [{ name: "infra-server@test-rig" }] as never),
      listPanes: vi.fn(async () => panes),
      getPanePid: vi.fn(async () => 4242),
      getPaneCommand: vi.fn(async () => "zsh"),
    });
    const local = createTestApp(localDb, { tmux: spy.adapter });
    const rig = local.rigRepo.createRig("test-rig");
    const expanded = await local.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment() });
    expect(expanded.ok).toBe(true);
    const node = local.rigRepo.getRig(rig.id)!.nodes.find((candidate) => candidate.logicalId === "infra.server")!;
    const sessions = local.sessionRegistry.getSessionsForRig(rig.id).filter((session) => session.nodeId === node.id);
    for (const session of sessions) local.sessionRegistry.markDetached(session.id);
    localDb.prepare("UPDATE bindings SET tmux_pane = NULL WHERE node_id = ?").run(node.id);

    const result = await local.claimService.reconcileSession({ sessionName: "infra-server@test-rig" });

    expect(result.ok).toBe(true);
    expect(local.sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%refreshed");
    await new SeatIdentityReconciler({ db: localDb, tmux: spy.adapter }).reconcileAll();
    const verdict = new SeatIdentityStore(localDb).getForNode(node.id);
    expect(verdict?.verdict).toBe("verified");
    expect(verdict?.evidence.registeredPane).toBe("%refreshed");
    localDb.close();
  });

  it("无输入判别条件：协调不会对目标调用 launch/kill/create/sendText/sendKeys", async () => {
    const { sessionName } = await seedDetachedSeat();
    const launchSpy = vi.spyOn(setup.nodeLauncher, "launchNode");

    // 在准备数据后重置调用日志，因为 expand 会合理地创建会话。
    for (const key of Object.keys(tmuxCalls)) delete tmuxCalls[key];

    const result = await setup.claimService.reconcileSession({ sessionName });
    expect(result.ok).toBe(true);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(tmuxCalls["createSession"] ?? []).toHaveLength(0);
    expect(tmuxCalls["killSession"] ?? []).toHaveLength(0);
    // 不向窗格注入任何按键或文本，因此也覆盖了 deliverClaimHint。
    expect(tmuxCalls["sendText"] ?? []).toHaveLength(0);
    expect(tmuxCalls["sendKeys"] ?? []).toHaveLength(0);
    // 只允许读取和元数据操作。
    expect((tmuxCalls["hasSession"] ?? []).length).toBeGreaterThan(0);
  });

  it("发出 node.reconciled 而非 node.claimed，使操作员知道执行了哪项操作", async () => {
    const { node, sessionName } = await seedDetachedSeat();
    await setup.claimService.reconcileSession({ sessionName });

    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.reconciled'").all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.nodeId).toBe(node.id);
    expect(payload.sessionName).toBe(sessionName);
    expect(db.prepare("SELECT 1 FROM events WHERE type = 'node.claimed'").all()).toHaveLength(0);
  });

  it("如实报告漂移：单独报告无法证实的元数据，且绝不声称会话连续", async () => {
    // 实时窗格命令为 "zsh" 时，无法证实 claude-code 节点的运行时。
    const rig = setup.rigRepo.createRig("drift-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: "/work/repo", podId: null });
    const sess = setup.sessionRegistry.registerSession(node.id, "dev-impl@drift-rig");
    setup.sessionRegistry.markDetached(sess.id);
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@drift-rig" });

    const result = await setup.claimService.reconcileSession({ sessionName: "dev-impl@drift-rig" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.projectionDrift.join(" ")).toContain("运行时未经验证");
    expect(result.result.projectionDrift.join(" ")).toContain("cwd 未经验证");
    // 绝不声称连续性已得到验证。
    expect(result.result.continuity).toBe("unverified");
  });

  it("没有使用规范名称的实时 tmux 会话时返回 session_not_found（绝不接入幽灵会话）", async () => {
    const spy = spyTmux({ hasSession: vi.fn(async () => false) });
    const localDb = createFullTestDb();
    const local = createTestApp(localDb, { tmux: spy.adapter });
    const rig = local.rigRepo.createRig("ghost-rig");
    const node = local.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: null });
    local.sessionRegistry.registerSession(node.id, "dev-impl@ghost-rig");

    const result = await local.claimService.reconcileSession({ sessionName: "dev-impl@ghost-rig" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("session_not_found");
    localDb.close();
  });

  it("后台服务从未管理该会话名称时返回 node_not_found，并指向 discover/bind", async () => {
    const result = await setup.claimService.reconcileSession({ sessionName: "stranger@nowhere" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("node_not_found");
    expect(result.message).toContain("zrig discover");
  });

  it("身份边界：显式 --rig/--node 不能绑定任意从未受管的会话（绕过重新分配标识）", async () => {
    // Guard 复审发现：实时会话名称不属于节点的规范/受管名称，且不存在后台服务历史
    // 映射时，即使显式提供 --rig/--node 也必须拒绝。tmux hasSession 默认为 true。
    const rig = setup.rigRepo.createRig("bypass-rig");
    const podId = "pod-bypass";
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(podId, rig.id, "dev", "Dev");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId });

    const result = await setup.claimService.reconcileSession({
      sessionName: "stranger@nowhere",
      rigId: rig.id,
      logicalId: "dev.impl",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("node_mismatch");
    expect(result.message).toContain("dev-impl@bypass-rig"); // 指向规范名称
    expect(result.message).toContain("zrig discover");
    // 不得发生任何变更：没有绑定、会话行或事件。
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
    expect(db.prepare("SELECT 1 FROM sessions WHERE node_id = ?").all(node.id)).toHaveLength(0);
    expect(db.prepare("SELECT 1 FROM events WHERE type = 'node.reconciled'").all()).toHaveLength(0);
  });

  it("没有历史映射时，显式 --rig/--node 仍可用于节点自己的规范名称", async () => {
    // 正向场景：历史记录已清除，但操作员给出了节点的准确规范会话名称，允许显式消歧。
    const rig = setup.rigRepo.createRig("canon-rig");
    const podId = "pod-canon";
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(podId, rig.id, "dev", "Dev");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId });

    const result = await setup.claimService.reconcileSession({
      sessionName: "dev-impl@canon-rig",
      rigId: rig.id,
      logicalId: "dev.impl",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodeId).toBe(node.id);
    expect(setup.sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@canon-rig");
  });

  it("显式 --rig/--node 与后台服务的会话映射不一致时返回 node_mismatch", async () => {
    const { rig, sessionName } = await seedDetachedSeat();
    // 同一工作组内另一个未映射到此会话的节点。
    const other = setup.rigRepo.addNode(rig.id, "infra.other", { runtime: "terminal", podId: null });

    const result = await setup.claimService.reconcileSession({ sessionName, rigId: rig.id, logicalId: "infra.other" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("node_mismatch");
    // 不得更改不匹配的节点。
    expect(setup.sessionRegistry.getBindingForNode(other.id)).toBeNull();
  });

  it("跨运行时：claude-code、codex 和 terminal 节点均可协调", async () => {
    for (const runtime of ["claude-code", "codex", "terminal"] as const) {
      const rig = setup.rigRepo.createRig(`rt-${runtime}`);
      const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime, podId: null });
      const sess = setup.sessionRegistry.registerSession(node.id, `dev-impl@rt-${runtime}`);
      setup.sessionRegistry.markDetached(sess.id);

      const result = await setup.claimService.reconcileSession({ sessionName: `dev-impl@rt-${runtime}` });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.result.nodeId).toBe(node.id);
      expect(latestSessionStatus(node.id)).toBe("running");
    }
  });
});

describe("converge 主干上的 reconcile_session（OPR.0.3.4.3）", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { tmux: spyTmux().adapter });
  });
  afterEach(() => { db.close(); });

  it("reconcile_session 是主干支持的操作类型", () => {
    expect(SUPPORTED_OP_KINDS).toContain("reconcile_session");
    expect(isSupportedOpKind("reconcile_session")).toBe(true);
  });

  it("convergeOp 将 reconcile_session 分派给认领服务（位于主干而非一次性旁路）", async () => {
    const rig = setup.rigRepo.createRig("spine-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: null });
    const sess = setup.sessionRegistry.registerSession(node.id, "dev-impl@spine-rig");
    setup.sessionRegistry.markDetached(sess.id);

    const result = await convergeOp(
      { instantiator: setup.podInstantiator, claimService: setup.claimService },
      "",
      { kind: "reconcile_session", sessionName: "dev-impl@spine-rig" },
      ".",
    );

    expect(result.kind).toBe("reconcile_session");
    expect(result.supported).toBe(true);
    if (result.kind !== "reconcile_session" || !result.supported) return;
    expect(result.outcome.ok).toBe(true);
    if (!result.outcome.ok) return;
    expect(result.outcome.result.nodeId).toBe(node.id);
  });

  it("缺少认领服务的 convergeOp 会如实报告错误，而不是静默跳过", async () => {
    const result = await convergeOp(
      { instantiator: setup.podInstantiator },
      "",
      { kind: "reconcile_session", sessionName: "dev-impl@spine-rig" },
      ".",
    );
    expect(result.kind).toBe("reconcile_session");
    if (result.kind !== "reconcile_session" || !result.supported) return;
    expect(result.outcome.ok).toBe(false);
  });
});

describe("POST /api/sessions/:sessionName/reconcile (OPR.0.3.4.3)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { tmux: spyTmux().adapter });
  });
  afterEach(() => { db.close(); });

  function post(sessionName: string, body: Record<string, unknown> = {}) {
    return setup.app.request(`/api/sessions/${encodeURIComponent(sessionName)}/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("实时但已脱离的席位协调成功时返回 200 和协调结果", async () => {
    const rig = setup.rigRepo.createRig("route-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: null });
    const sess = setup.sessionRegistry.registerSession(node.id, "dev-impl@route-rig");
    setup.sessionRegistry.markDetached(sess.id);

    const res = await post("dev-impl@route-rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.nodeId).toBe(node.id);
    expect(body.result.continuity).toBe("unverified");
  });

  it("会话名称未映射时返回 404", async () => {
    const res = await post("stranger@nowhere");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("node_not_found");
  });

  it("发生 node_mismatch 时返回 409", async () => {
    const rig = setup.rigRepo.createRig("route-rig2");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: null });
    setup.rigRepo.addNode(rig.id, "dev.other", { runtime: "terminal", podId: null });
    setup.sessionRegistry.registerSession(node.id, "dev-impl@route-rig2");

    const res = await post("dev-impl@route-rig2", { rigId: rig.id, logicalId: "dev.other" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("node_mismatch");
  });

  it("只提供 rigId/logicalId 其中一项时返回 400", async () => {
    const res = await post("dev-impl@route-rig3", { rigId: "some-rig" });
    expect(res.status).toBe(400);
  });

  it("显式工作组/节点尝试绕过限制为任意会话重新分配标识时返回 409，且不产生变更", async () => {
    const rig = setup.rigRepo.createRig("route-bypass");
    const podId = "pod-rb";
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(podId, rig.id, "dev", "Dev");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId });

    const res = await post("stranger@nowhere", { rigId: rig.id, logicalId: "dev.impl" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("node_mismatch");
    expect(setup.sessionRegistry.getBindingForNode(node.id)).toBeNull();
  });
});
