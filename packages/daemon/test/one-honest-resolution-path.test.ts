import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { transportRoutes } from "../src/routes/transport.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { createFullTestDb } from "./helpers/test-app.js";

// OPR.0.5.4.2——唯一真实解析路径。把 deterministic injected-exec 复现（诊断 row
// 2b986f35）转成回归测试：adapter probe 分类三种错误，shared resolution path 必须按原类别
// 呈现。transport 短暂故障绝不能被读成 dead seat，也不能从故障中伪造 absence verdict。
//
// 四个样本是 tmux 产生的真实错误结构；classifier source 为 adapters/tmux.ts 中的
// isNoServerError / isSessionAbsenceError / isTmuxTransportAbsentError：
const NO_SERVER = () => new Error("no server running on /private/tmp/tmux-501/default");
const SOCKET_GONE = () => new Error("error connecting to /private/tmp/tmux-501/default (No such file or directory)");
const SESSION_GONE = () => new Error("can't find session: dev-impl@my-rig");
const PERMISSION = () => new Error("permission denied");

const failingExec = (make: () => Error): ExecFn => async () => {
  throw make();
};

const SEAT = "dev-impl@my-rig";

describe("adapter gate：probeSession 执行分类而非折叠", () => {
  it("no-server → transport 结果，而非 absence", async () => {
    const adapter = new TmuxAdapter(failingExec(NO_SERVER));
    const probe = await adapter.probeSession(SEAT);
    expect(probe.state).toBe("transport_unavailable");
  });

  it("socket-gone → transport 结果，而非 absence", async () => {
    const adapter = new TmuxAdapter(failingExec(SOCKET_GONE));
    const probe = await adapter.probeSession(SEAT);
    expect(probe.state).toBe("transport_unavailable");
  });

  it("can't find session → 正向 absence", async () => {
    const adapter = new TmuxAdapter(failingExec(SESSION_GONE));
    const probe = await adapter.probeSession(SEAT);
    expect(probe.state).toBe("absent");
  });

  it("permission denied → fail-closed 抛错，与前两类不同", async () => {
    const adapter = new TmuxAdapter(failingExec(PERMISSION));
    await expect(adapter.probeSession(SEAT)).rejects.toThrow("permission denied");
  });

  it("会话存在 → present", async () => {
    const adapter = new TmuxAdapter(async () => "");
    const probe = await adapter.probeSession(SEAT);
    expect(probe.state).toBe("present");
  });

  // Mini-req 6 disposition pin：更广泛的 hasSession 使用方保留折叠语义；本 slice 不得从
  // 28 个未绑定调用点下方改变它们。
  it("hasSession 为未绑定 consumer 保留折叠 view", async () => {
    await expect(new TmuxAdapter(failingExec(NO_SERVER)).hasSession(SEAT)).resolves.toBe(false);
    await expect(new TmuxAdapter(failingExec(SESSION_GONE)).hasSession(SEAT)).resolves.toBe(false);
    await expect(new TmuxAdapter(failingExec(PERMISSION)).hasSession(SEAT)).rejects.toThrow();
  });
});

describe("verb 使用同一路径：send 与 capture 呈现 transport outcome", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSeat() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%5" });
    return { rig, node, session };
  }

  function transportOver(make: () => Error): SessionTransport {
    // 使用注入 failing exec 的真实 adapter，也就是诊断 repro 结构，而不是在被测 seam 上
    // stub error。
    return new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: new TmuxAdapter(failingExec(make)),
    });
  }

  const verdictRows = () =>
    db.prepare("SELECT * FROM seat_identity_verdicts").all() as Array<{ reason: string }>;

  it("no-server 下 send 呈现 tmux_unavailable，绝不是 session_missing", async () => {
    seedSeat();
    const result = await transportOver(NO_SERVER).send(SEAT, "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
  });

  it("socket-gone 下 send 呈现 tmux_unavailable，绝不是 session_missing", async () => {
    seedSeat();
    const result = await transportOver(SOCKET_GONE).send(SEAT, "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
  });

  it("no-server 下 capture 呈现 tmux_unavailable，绝不是 session_missing", async () => {
    seedSeat();
    const result = await transportOver(NO_SERVER).capture(SEAT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
  });

  it("真实 absence 下 send 仍呈现 session_missing", async () => {
    seedSeat();
    const result = await transportOver(SESSION_GONE).send(SEAT, "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("session_missing");
  });

  describe("错误文本点明实际检查内容（queue-create 标准）", () => {
    it("transport 文本同时说明连接失败和未能确定是否存在", async () => {
      seedSeat();
      const result = await transportOver(NO_SERVER).send(SEAT, "hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("无法连接 tmux server");
      expect(result.error).toContain("未能确定");
      // 不得产生错误的世界结论：文本不能声称 session 已消失。
      expect(result.error).not.toMatch(/not found/i);
    });

    it("session-missing 文本说明其正向 tmux evidence", async () => {
      seedSeat();
      const result = await transportOver(SESSION_GONE).send(SEAT, "hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("tmux 报告不存在该名称的会话");
    });
  });

  // Walk 和 nudge 经同一 shared path 继承 gate（mini-req 3）：每个 walk piece 都 POST
  // /api/transport/send；packages/cli/src/commands/walk.ts 中 piece send 与 staged-text Enter
  // submit 都调用该路由。queue nudge 路径则通过 QueueRepository.attachTransport（startup.ts）
  // 接入同一个 SessionTransport instance。这里代表性执行注入 no-server 条件下的该路由。
  it("walk 路由 /api/transport/send 在 no-server 下呈现 transport outcome", async () => {
    seedSeat();
    const app = new Hono();
    const transport = transportOver(NO_SERVER);
    app.use("*", async (c, next) => {
      c.set("sessionTransport" as never, transport);
      await next();
    });
    app.route("/api/transport", transportRoutes());

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: SEAT, text: "hello" }),
    });
    const body = (await res.json()) as { reason?: string; error?: string };
    expect(body.reason).toBe("tmux_unavailable");
    expect(body.error).toContain("未能确定");
  });

  describe("不伪造 verdict（mini-req 5）", () => {
    it("存活注册席位上的 transport blip 不写 absence verdict，ps 也不降级", async () => {
      seedSeat();
      await transportOver(NO_SERVER).send(SEAT, "hello");
      expect(verdictRows()).toHaveLength(0);
      // 验证 EFFECT 而不只是 indicator（证明项 4）：故障后存活席位仍投影为 running。
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      expect(entry.runningCount).toBe(1);
      expect(entry.status).toBe("running");
    });

    it("socket-gone blip 同样不写 absence verdict，ps 也不降级", async () => {
      seedSeat();
      await transportOver(SOCKET_GONE).capture(SEAT);
      expect(verdictRows()).toHaveLength(0);
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      expect(entry.runningCount).toBe(1);
      expect(entry.status).toBe("running");
    });

    it("真实 session absence 仍写入 verdict，ps 会降低席位等级", async () => {
      seedSeat();
      await transportOver(SESSION_GONE).send(SEAT, "hello");
      const rows = verdictRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe("session_missing");
      // 反向判别项：正向 absence 确实会改变 projection。
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      expect(entry.runningCount).toBe(0);
      expect(entry.status).not.toBe("running");
    });
  });
});

describe("保留 cold-start：dead server 下 boot reconciliation 仍会 detach（mini-req 2）", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRunningSession() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    return { rig, node, session };
  }

  it("no-server：stale row 被 detach，而不是报错", async () => {
    const { rig } = seedRunningSession();
    const reconciler = new Reconciler({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: new TmuxAdapter(failingExec(NO_SERVER)),
    });
    const result = await reconciler.reconcile(rig.id);
    expect(result.detached).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("socket-gone：stale row 被 detach，而不是报错", async () => {
    const { rig } = seedRunningSession();
    const reconciler = new Reconciler({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: new TmuxAdapter(failingExec(SOCKET_GONE)),
    });
    const result = await reconciler.reconcile(rig.id);
    expect(result.detached).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("permission denied 保持 fail-closed：报错，绝不 detach", async () => {
    const { rig } = seedRunningSession();
    const reconciler = new Reconciler({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: new TmuxAdapter(failingExec(PERMISSION)),
    });
    const result = await reconciler.reconcile(rig.id);
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(1);
  });
});
