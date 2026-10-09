import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { validateNativePermissionSelection } from "../src/domain/native-permission-selection.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeCodexSandbox, observeClaudePermission, diagnoseRuntimePosture, parseClaudePermissionModes } from "../src/domain/permission-drift.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { Hono } from "hono";
import { seatRoutes } from "../src/routes/seat.js";
import { codexPostureArg } from "../src/adapters/yolo-mode.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";

// 下方旧式单元测试接缝隔离参数与存储行为。生产上下文解析与竞态控制位于
// s03-bound-launch.test.ts。
function fakeManaged(modes: readonly string[] | null): ClaudeManagedLaunch {
  return { prepare: async (_target: unknown, mode: string) => {
    validateNativePermissionSelection("claude-code", mode, modes);
    return { configDir: "/inert/.claude", assertCurrent: () => {}, command: (args: string[]) => "claude " + args.join(" ") };
  } } as unknown as ClaudeManagedLaunch;
}
const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.open) db.close(); vi.unstubAllEnvs(); });
function fixture(runtime = "codex", file = ":memory:") {
  const db = new Database(file); opened.push(db); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db); const rig = rigRepo.createRig("permissions");
  const node = rigRepo.addNode(rig.id, "dev.owner", { runtime, cwd: "/inert/project" });
  const sibling = rigRepo.addNode(rig.id, "dev.sibling", { runtime, cwd: "/inert/project" });
  const registry = new SessionRegistry(db); const session = registry.registerSession(node.id, "dev-owner@permissions");
  registry.updateStatus(session.id, "running");
  registry.updateResumeToken(session.id, "native-id", "retained-history", "hook");
  const eventBus = new EventBus(db);
  const tmux = new Proxy({}, { get: (_, key) => key === "deliveryGuard" ? undefined : () => { throw new Error("No lifecycle effect permitted"); } }) as TmuxAdapter;
  const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus,
    tmuxAdapter: tmux,
    runtimeAdapters: { "claude-code": { claudeManagedLaunch: fakeManaged(["default", "acceptEdits", "auto", "bypassPermissions"]) } as RuntimeAdapter } });
  const store = new NativePermissionStore(db);
  return { db, rigRepo, rig, node, sibling, registry, session, eventBus, service, store };
}
const input = (mode: string) => ({ seatRef: "dev-owner@permissions", mode, reason: "deliberate operator choice", actor: "operator@permissions" });
const lineage = (db: Database.Database) => JSON.stringify(["nodes", "sessions", "occupant_tenures", "node_startup_context"].map(t => db.prepare(`SELECT * FROM ${t}`).all()));
const binding = (nodeId = "node"): NodeBinding => ({ id: "binding", nodeId, attachmentType: "tmux", tmuxSession: "seat", tmuxWindow: null, tmuxPane: "%1", cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/inert/project" });

describe("S03 后续原生权限选择（离线，不声称产生原生效果）", () => {
  it("migration 088 保留此前的启动观测与历史，且只应用一次", () => {
    const db = new Database(":memory:"); opened.push(db); db.pragma("foreign_keys = ON");
    migrate(db, ALL_MIGRATIONS.filter(m => !m.name.startsWith("088_")));
    const repo = new RigRepository(db); const rig = repo.createRig("upgrade");
    const node = repo.addNode(rig.id, "owner", { runtime: "codex", cwd: "/inert" });
    const registry = new SessionRegistry(db); registry.registerSession(node.id, "owner@upgrade");
    const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
    db.prepare("INSERT INTO applied_launch_observations(generation_uuid,runtime,axis,observation_state,value) VALUES (?, 'codex','sandbox','observed','workspace-write')").run(generation);
    const before = lineage(db); const prior = db.prepare("SELECT * FROM applied_launch_observations").get();
    migrate(db, ALL_MIGRATIONS); migrate(db, ALL_MIGRATIONS);
    expect(lineage(db)).toBe(before);
    expect(db.prepare("SELECT * FROM applied_launch_observations").get()).toEqual({ ...prior as object, approval_policy: null });
    expect(db.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name LIKE '088_%'").get()).toEqual({ n: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  it("原子审计一个 seat，且不改变同级节点、session 或原生历史", async () => {
    const f = fixture(); const before = lineage(f.db);
    expect(await f.service.setPermissions(input("full_bypass"))).toMatchObject({ ok: true, changed: true, to: { mode: "full_bypass" } });
    expect(lineage(f.db)).toBe(before); expect(f.store.read(f.sibling.id)).toBeNull();
    const events = f.db.prepare("SELECT payload FROM events WHERE type='node.permissions_changed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ nodeId: f.node.id, actor: input("").actor, reason: input("").reason, source: "seat_selection", effect: "future_launches_only" });
    expect(await f.service.setPermissions(input("full_bypass"))).toMatchObject({ ok: true, changed: false });
    expect(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='node.permissions_changed'").get()).toEqual({ n: 1 });
    expect(await f.service.setPermissions(input("inherit"))).toMatchObject({ ok: true, changed: true, to: null });
    expect(f.store.read(f.node.id)).toBeNull(); expect(lineage(f.db)).toBe(before);
    expect(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='node.permissions_changed'").get()).toEqual({ n: 2 });
  });
  it("追加审计失败时回滚选择", async () => {
    const f = fixture(); vi.spyOn(f.eventBus, "persistWithinTransaction").mockImplementation(() => { throw new Error("audit unavailable"); });
    expect(await f.service.setPermissions(input("full_bypass"))).toMatchObject({ ok: false, message: "audit unavailable" });
    expect(f.store.read(f.node.id)).toBeNull();
  });
  it("要求 reason、actor 以及兼容的 runtime/mode", async () => {
    const f = fixture();
    for (const request of [{ ...input("floor"), reason: " " }, { ...input("floor"), actor: "" }, input("auto")]) {
      expect(await f.service.setPermissions(request)).toMatchObject({ ok: false });
    }
    expect(f.store.read(f.node.id)).toBeNull();
    expect(() => validateNativePermissionSelection("pi", "full_bypass")).toThrow(/资源信任是独立设置/);
  });
  it("数据库重开后仍保留选择、应用显式优先级并拒绝 runtime 漂移", async () => {
    const file = join(tmpdir(), `s03-${randomUUID()}.sqlite`); const f = fixture("codex", file);
    await f.service.setPermissions(input("full_bypass")); f.db.close();
    const db = new Database(file); opened.push(db); const store = new NativePermissionStore(db);
    expect(store.apply({ ...binding(f.node.id), launchPosture: "floor" }, "codex").launchPosture).toBe("full_bypass");
    expect(() => store.apply(binding(f.node.id), "claude-code")).toThrow(/运行时已改变/);
  });
  it("将期望选择与 generation 绑定的启动参数及原生效果分开", async () => {
    const f = fixture(); const tenure = f.registry.currentOccupantTenure(f.node.id)!;
    const observations = new AppliedLaunchObservationStore(f.db);
    expect(observations.recordGeneration(tenure.generationUuid, observeCodexSandbox("-s danger-full-access -a never"))).toBe(true);
    await f.service.setPermissions(input("floor"));
    const status = new SeatStatusService({ rigRepo: f.rigRepo }).getStatus(input("").seatRef);
    expect(status).toMatchObject({ ok: true, status: { permissions: { desired: { mode: "floor" }, lastLaunchArguments: { value: "danger-full-access", approvalPolicy: "never" }, nativeEffect: "unverified" } } });
    f.registry.mintOccupantTenure(f.node.id, "handover");
    expect(observations.readCurrent(f.node.id)).toBeNull();
  });
  it("不把不可读取的选择称为 inherit", () => {
    const f = fixture(); f.db.exec("DROP TABLE node_permission_selections");
    expect(new SeatStatusService({ rigRepo: f.rigRepo }).getStatus(input("").seatRef)).toMatchObject({ ok: true, status: { permissions: { selectionState: "unknown", nativeEffect: "unverified" } } });
    expect(() => f.store.apply(binding(f.node.id), "codex")).toThrow();
  });
  it("真实 HTTP route 要求 sender 并审计该 sender，忽略 body 中的 actor 覆盖值", async () => {
    const f = fixture(); const app = new Hono();
    app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries({ rigRepo: f.rigRepo, sessionRegistry: f.registry, eventBus: f.eventBus, tmuxAdapter: {} })) c.set(key as never, value as never);
      await next();
    });
    app.route("/api/seat", seatRoutes);
    const url = "/api/seat/set-permissions/dev-owner%40permissions";
    const request = { method: "POST", body: JSON.stringify({ mode: "full_bypass", reason: "explicit choice", actor: "spoof" }), headers: { "content-type": "application/json" } };
    expect((await app.request(url, request)).status).toBe(400);
    expect((await app.request(url, { ...request, body: "null", headers: { ...request.headers, "x-openrig-session": "real-operator" } })).status).toBe(400);
    const response = await app.request(url, { ...request, headers: { ...request.headers, "x-openrig-session": "real-operator" } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, changed: true });
    expect(f.store.read(f.node.id)?.actor).toBe("real-operator");
  });
  it.each(["codex", "claude-code"])("旧式 restore 为 %s 解析当前已存储选择", async runtime => {
    const f = fixture(runtime); await f.service.setPermissions(input(runtime === "codex" ? "full_bypass" : "auto"));
    const resume = vi.fn(async () => ({ ok: false, code: "offline", message: "stop" }));
    const ctx = { db: f.db, sessionRegistry: f.registry, appliedLaunchStore: new AppliedLaunchObservationStore(f.db),
      claudeResume: { canResume: () => runtime === "claude-code", resume }, codexResume: { canResume: () => runtime === "codex", resume } };
    await (RestoreOrchestrator.prototype as any).attemptResume.call(ctx, f.node.id, "seat", runtime === "codex" ? "codex_id" : "claude_id", "original", "/inert", null, "model", "floor");
    expect(resume).toHaveBeenCalledWith(...(runtime === "codex"
      ? ["seat", "codex_id", "original", "/inert", null, "full_bypass", "model"]
      : ["seat", "claude_id", "original", "/inert", "floor", "model", "auto", f.node.id]));
  });
  it.each(["fresh", "resume", "fork"])("共享启动在 %s 路径应用选定的 Claude auto，并保持继承 posture 独立", async path => {
    const f = fixture("claude-code"); await f.service.setPermissions(input("auto"));
    const launchHarness = vi.fn(async () => ({ ok: false as const, error: "offline stop before native launch" }));
    const adapter = { runtime: "claude-code", project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: [], failed: [] }), launchHarness } as unknown as RuntimeAdapter;
    const orchestrator = new StartupOrchestrator({ db: f.db, sessionRegistry: f.registry, eventBus: f.eventBus, tmuxAdapter: {} as TmuxAdapter });
    await orchestrator.startNode({ rigId: f.rig.id, nodeId: f.node.id, sessionId: f.session.id,
      binding: { ...binding(f.node.id), launchPosture: "full_bypass" }, adapter, plan: { entries: [] } as never,
      resolvedStartupFiles: [], startupActions: [], isRestore: path === "resume",
      ...(path === "resume" ? { resumeToken: "retained", resumeType: "claude_id" } : {}),
      ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent" } } : {}) });
    expect(launchHarness).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "auto", launchPosture: "full_bypass" }), expect.anything());
  });
});

// 适配器运行真实命令构建器；注入的 transport 会在任何输入发生前拒绝。
const fsOps = { readFile: () => { throw new Error("absent fixture"); }, writeFile: () => { throw new Error("unexpected write"); }, exists: () => false, mkdirp: () => {}, copyFile: () => {} };
function refusedTransport() {
  const send = vi.fn(async () => ({ ok: false as const, message: "offline transport" }));
  return { tmux: { sendShellCommand: send, sendText: send } as unknown as TmuxAdapter, send };
}
describe("S03 已选择参数与不变的默认值", () => {
  it.each(["fresh", "resume", "fork"])("Codex 显式 full_bypass 在 %s 路径同时包含 sandbox 与 approval", async path => {
    const t = refusedTransport(); const adapter = new CodexRuntimeAdapter({ tmux: t.tmux, fsOps });
    await adapter.launchHarness({ ...binding(), launchPosture: "full_bypass" }, { name: "seat",
      ...(path === "resume" ? { resumeToken: "original" } : {}),
      ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
    expect(t.send.mock.calls[0]?.[1]).toContain("codex -s danger-full-access -a never");
  });
  it("Codex 旧式 resume 使用同一个显式选择", async () => {
    const t = refusedTransport(); await new CodexResumeAdapter(t.tmux).resume("seat", "codex_id", "original", "/inert", null, "full_bypass");
    expect(t.send.mock.calls[0]?.[1]).toContain("codex -s danger-full-access -a never resume");
  });
  it("不扩大未设置、floor、命名 profile 或仅环境变量控制的行为", () => {
    expect(codexPostureArg("", {})).toBe(" -s workspace-write");
    expect(codexPostureArg(" -p 'custom'", {})).toBe(" -p 'custom'");
    expect(codexPostureArg("", { OPENRIG_YOLO: "1" })).toBe(" -s danger-full-access");
    expect(codexPostureArg("", { OPENRIG_YOLO: "1" }, "floor")).toBe(" -s workspace-write");
  });
  it.each(["fresh", "resume", "fork"])("Claude 支持的 auto 在 %s 路径优先于继承的 bypass", async path => {
    vi.stubEnv("OPENRIG_YOLO", "1"); const t = refusedTransport();
    const adapter = new ClaudeCodeAdapter({ tmux: t.tmux, fsOps, claudeManagedLaunch: fakeManaged(["acceptEdits", "auto"]) });
    await adapter.launchHarness({ ...binding(), launchPosture: "full_bypass", permissionMode: "auto" }, { name: "seat",
      ...(path === "resume" ? { resumeToken: "original" } : {}),
      ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
    const command = t.send.mock.calls[0]?.[1]; expect(command).toContain("--permission-mode auto");
    expect(command).not.toContain("skip-permissions"); expect(command).not.toContain("acceptEdits");
  });
  it.each([null, ["acceptEdits"]])("在任何 transport 调用前拒绝未知或不支持的 Claude auto（%j）", async modes => {
    const t = refusedTransport();
    const adapter = new ClaudeCodeAdapter({ tmux: t.tmux, fsOps, claudeManagedLaunch: fakeManaged(modes) });
    expect(await adapter.launchHarness({ ...binding(), permissionMode: "auto" }, { name: "seat" })).toMatchObject({ ok: false });
    expect(t.send).not.toHaveBeenCalled();
    expect(await new ClaudeResumeAdapter(t.tmux, { claudeManagedLaunch: fakeManaged(modes) }).resume("seat", "claude_id", "original", "/inert", "full_bypass", null, "auto", "node")).toMatchObject({ ok: false, code: "permission_selection_refused" });
    expect(t.send).not.toHaveBeenCalled();
  });
  it("Claude 旧式 resume 携带受支持的显式 mode", async () => {
    const t = refusedTransport(); await new ClaudeResumeAdapter(t.tmux, { claudeManagedLaunch: fakeManaged(["auto"]) }).resume("seat", "claude_id", "original", "/inert", "full_bypass", null, "auto", "node");
    expect(t.send.mock.calls[0]?.[1]).toContain("--permission-mode auto --resume");
    expect(observeClaudePermission("--permission-mode auto")).toMatchObject({ value: "auto" });
  });
  it("区分规范化启动参数与原生 enforcement，并拒绝缺失的 help 语义", () => {
    for (const applied of [observeCodexSandbox("-s danger-full-access -a never"), observeClaudePermission("--permission-mode auto")]) {
      const result = diagnoseRuntimePosture({ runtime: applied.runtime, cwd: "/inert", applied, fs: {} as never });
      expect(result.enforcement).toMatchObject({ state: "unknown", expected: applied.value, effective: null, reason: "native_permission_effect_unverified" });
    }
    expect(parseClaudePermissionModes('--permission-mode <mode>  (choices: "default", "acceptEdits", "auto")')).toEqual(["default", "acceptEdits", "auto"]);
    expect(parseClaudePermissionModes("unreadable options")).toBeNull();
    expect(() => validateNativePermissionSelection("claude-code", "auto", null)).toThrow(/不可用/);
  });
});
