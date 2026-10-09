import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatSwitchClientService } from "../src/domain/seat-switch-client-service.js";
import type { TmuxAdapter, TmuxClient, TmuxWindow, TmuxResult } from "../src/adapters/tmux.js";

/**
 * OPR.0.4.3.26——仅查看的 switch-client 重定向。服务只持有 rigRepo（读取）与
 * tmuxAdapter（探测 + 切换）；从结构上无法修改路由、绑定或会话。这些测试同时固定机制与
 * 仅查看不变量：绝不触发任何会话/绑定修改适配器调用。
 */

/** 监视每个方法的 tmux 模拟，使不变量测试可以断言查看重定向绝不会调用任何修改方法
 * （createSession/killSession/sendText/sendKeys/setSessionOption）。 */
function spyTmux(overrides: {
  hasSession?: boolean;
  windows?: TmuxWindow[];
  clients?: TmuxClient[];
  switchResult?: TmuxResult;
  hasSessionThrows?: Error;
} = {}) {
  const mutators = {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    setSessionOption: vi.fn(async () => ({ ok: true as const })),
    createWindow: vi.fn(async () => ({ ok: true as const })),
  };
  const probes = {
    hasSession: vi.fn(async () => {
      if (overrides.hasSessionThrows) throw overrides.hasSessionThrows;
      return overrides.hasSession ?? true;
    }),
    listWindows: vi.fn(async () => overrides.windows ?? [{ index: 0, name: "main", panes: 1, active: true }]),
    listClients: vi.fn(async () => overrides.clients ?? []),
    switchClient: vi.fn(async () => overrides.switchResult ?? ({ ok: true as const })),
  };
  const adapter = { ...mutators, ...probes } as unknown as TmuxAdapter;
  return { adapter, mutators, probes };
}

function client(name: string, session: string): TmuxClient {
  return { name, session };
}

describe("SeatSwitchClientService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => { db.close(); });

  /** 建立规范会话为 `dev-impl@seat-rig` 的活跃席位。 */
  function seedLiveSeat() {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    return { rig, node, session };
  }

  it("将唯一连接的客户端重定向到 <session>:0，并返回仅查看成功结果", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [client("/dev/ttys003", "wrong-view")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.result).toMatchObject({
      seat_ref: "dev-impl@seat-rig",
      session: "dev-impl@seat-rig",
      window: 0,
      target: "dev-impl@seat-rig:0",
      client: "/dev/ttys003",
      mutated: false,
      retargeted: true,
    });
    expect(probes.switchClient).toHaveBeenCalledWith("/dev/ttys003", "dev-impl@seat-rig:0");
  });

  // 关键证明：成功的查看重定向不会修改 OpenRig 中的任何内容。
  it("仅查看不变量：绝不调用会话/绑定修改适配器方法", async () => {
    seedLiveSeat();
    const { adapter, mutators } = spyTmux({ clients: [client("/dev/ttys003", "wrong-view")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });
    expect(result.ok).toBe(true);

    // 不修改会话生命周期、不发送内容、不写入选项。
    expect(mutators.createSession).not.toHaveBeenCalled();
    expect(mutators.killSession).not.toHaveBeenCalled();
    expect(mutators.sendText).not.toHaveBeenCalled();
    expect(mutators.sendKeys).not.toHaveBeenCalled();
    expect(mutators.setSessionOption).not.toHaveBeenCalled();

    // 也没有绑定/会话修改泄漏进数据库：会话仍是已注册且正在运行的那一个，
    // 没有出现后继或交接记录。
    const rows = db.prepare("SELECT status FROM sessions WHERE session_name = ?").all("dev-impl@seat-rig") as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("running");
  });

  it("确认存在后，将目标设为显式 --to-window", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      clients: [client("/dev/ttys003", "wrong-view")],
      windows: [
        { index: 0, name: "main", panes: 1, active: false },
        { index: 1, name: "logs", panes: 1, active: true },
      ],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", toWindow: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.result.target).toBe("dev-impl@seat-rig:1");
    expect(probes.switchClient).toHaveBeenCalledWith("/dev/ttys003", "dev-impl@seat-rig:1");
  });

  it("--to-window 缺失时如实返回 window_not_found（绝不返回原始 tmux 失败）", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      clients: [client("/dev/ttys003", "wrong-view")],
      windows: [{ index: 0, name: "main", panes: 1, active: true }],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", toWindow: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("window_not_found");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("没有已连接客户端时如实返回 no_client 错误（建议 attach / CMUX）", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("no_client");
    expect(result.guidance).toContain("tmux attach -t dev-impl@seat-rig");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("连接多个客户端且未指定 --client 时如实返回 ambiguous_client（列出客户端且绝不擅自选择）", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      clients: [client("/dev/ttys003", "a"), client("/dev/ttys007", "b")],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("ambiguous_client");
    expect(result.clients).toEqual([
      { name: "/dev/ttys003", session: "a" },
      { name: "/dev/ttys007", session: "b" },
    ]);
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("--client 从多个客户端中选择指定客户端", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      clients: [client("/dev/ttys003", "a"), client("/dev/ttys007", "b")],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", client: "/dev/ttys007" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.result.client).toBe("/dev/ttys007");
    expect(probes.switchClient).toHaveBeenCalledWith("/dev/ttys007", "dev-impl@seat-rig:0");
  });

  it("--client 未命中时，client_not_found 列出已连接客户端", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [client("/dev/ttys003", "a")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", client: "/dev/ttys999" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("client_not_found");
    expect(result.clients).toEqual([{ name: "/dev/ttys003", session: "a" }]);
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("session_not_found 指向路由修复（reconcile/handover），且绝不切换", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ hasSession: false, clients: [client("/dev/ttys003", "a")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("session_not_found");
    expect(result.guidance).toContain("reconcile-session");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("当前无占用者的席位返回 missing_canonical_session（绝不全新启动）", async () => {
    // 节点存在但没有运行中的会话 -> current_occupant 为 null。
    const rig = rigRepo.createRig("seat-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const { adapter, probes, mutators } = spyTmux({ clients: [client("/dev/ttys003", "a")] });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    // 未注册会话 -> 按逻辑标识形式解析（尚无可匹配的规范会话名）。
    const result = await service.switchClient({ seatRef: "dev.impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("missing_canonical_session");
    expect(probes.switchClient).not.toHaveBeenCalled();
    expect(mutators.createSession).not.toHaveBeenCalled();
  });

  it("为未知席位透传 seat_not_found", async () => {
    const { adapter } = spyTmux();
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "ghost@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("seat_not_found");
  });

  it("意外探测错误时呈现 tmux_probe_failed（不静默切换）", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({
      hasSessionThrows: new Error("EACCES: permission denied"),
      clients: [client("/dev/ttys003", "a")],
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("tmux_probe_failed");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("将 listClients 抛错捕获为 tmux_probe_failed（不泄漏原始异常且不切换）", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [client("/dev/ttys003", "a")] });
    // 适配器有意重新抛出意外探测失败（权限/socket）。
    probes.listClients.mockRejectedValueOnce(new Error("error connecting to /private/tmp/tmux-501/default (Permission denied)"));
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("tmux_probe_failed");
    expect(result.message).toContain("list-clients");
    expect(result.message).toContain("Permission denied");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("将 listWindows 抛错（显式 --to-window）捕获为 tmux_probe_failed（不切换）", async () => {
    seedLiveSeat();
    const { adapter, probes } = spyTmux({ clients: [client("/dev/ttys003", "a")] });
    probes.listWindows.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig", toWindow: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("tmux_probe_failed");
    expect(result.message).toContain("list-windows");
    expect(probes.switchClient).not.toHaveBeenCalled();
  });

  it("tmux switch-client 本身失败时呈现 switch_failed", async () => {
    seedLiveSeat();
    const { adapter } = spyTmux({
      clients: [client("/dev/ttys003", "a")],
      switchResult: { ok: false, code: "session_not_found", message: "can't find session" },
    });
    const service = new SeatSwitchClientService({ rigRepo, tmuxAdapter: adapter });

    const result = await service.switchClient({ seatRef: "dev-impl@seat-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.code).toBe("switch_failed");
  });
});
