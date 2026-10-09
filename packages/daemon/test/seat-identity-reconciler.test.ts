// OPR.0.4.3.19——SeatIdentityReconciler 单元测试。
//
// 协调器负责存活身份判定（第三个轴，与 slice-15 的 terminalActive/hasAssignedWork 正交）。
// 它将每个运行中、绑定 tmux 的席位 pane PID/命令与已注册绑定协调，并将持久判定写入
// `seat_identity_verdicts`。它只读取 tmux pane 进程身份——绝不读取队列/分类器/hook 心跳。

import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import {
  SeatIdentityReconciler,
  classifyPaneRuntimeMatch,
} from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

interface TmuxState {
  /** tmux 通过 listSessions() 报告为存活的会话名。 */
  sessions?: string[];
  /** pane id → pid（null = pane 已消失）。 */
  panePid?: Record<string, number | null>;
  /** pane id → 前台命令。 */
  paneCommand?: Record<string, string | null>;
  /** 使 listSessions 抛出异常（tmux 完全不可达）。 */
  throwListSessions?: boolean;
}

function makeTmux(state: TmuxState): Pick<TmuxAdapter, "listSessions" | "getPanePid" | "getPaneCommand"> {
  return {
    listSessions: vi.fn(async () => {
      if (state.throwListSessions) throw new Error("no server running");
      return (state.sessions ?? []).map((name) => ({ name })) as never;
    }),
    getPanePid: vi.fn(async (paneId: string) =>
      Object.prototype.hasOwnProperty.call(state.panePid ?? {}, paneId)
        ? state.panePid![paneId]!
        : null,
    ),
    getPaneCommand: vi.fn(async (paneId: string) =>
      Object.prototype.hasOwnProperty.call(state.paneCommand ?? {}, paneId)
        ? state.paneCommand![paneId]!
        : null,
    ),
  };
}

function seedSeat(
  db: Database.Database,
  opts: {
    nodeId: string;
    rigId?: string;
    logicalId?: string;
    runtime?: string;
    sessionName: string;
    status?: string;
    pane?: string | null;
    attachmentType?: string;
  },
): void {
  const rigId = opts.rigId ?? "rig-1";
  const exists = db.prepare("SELECT 1 FROM rigs WHERE id = ?").get(rigId);
  if (!exists) db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, "test-rig");
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, ?, ?)",
  ).run(opts.nodeId, rigId, opts.logicalId ?? `pod.${opts.nodeId}`, opts.runtime ?? "claude-code", "/tmp");
  db.prepare(
    "INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)",
  ).run(`sess-${opts.nodeId}`, opts.nodeId, opts.sessionName, opts.status ?? "running", "ready");
  db.prepare(
    "INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, ?, ?, ?)",
  ).run(`bind-${opts.nodeId}`, opts.nodeId, opts.attachmentType ?? "tmux", opts.sessionName, opts.pane ?? null);
}

const NOW = () => new Date("2026-07-02T12:00:00.000Z");

describe("classifyPaneRuntimeMatch", () => {
  it("没有命令信号时绝不判为不匹配（pane 存在，命令未知）", () => {
    expect(classifyPaneRuntimeMatch(null, "claude-code")).toBe("match");
  });

  it("存活 Claude 席位的宿主进程 `node` 判为匹配（不误报不匹配）", () => {
    expect(classifyPaneRuntimeMatch("node", "claude-code")).toBe("match");
  });

  it("同运行时的确证命令匹配", () => {
    expect(classifyPaneRuntimeMatch("claude", "claude-code")).toBe("match");
    expect(classifyPaneRuntimeMatch("codex", "codex")).toBe("match");
  });

  it("pane 被不同智能体运行时占用时判为不匹配", () => {
    expect(classifyPaneRuntimeMatch("codex", "claude-code")).toBe("mismatch");
    expect(classifyPaneRuntimeMatch("claude", "codex")).toBe("mismatch");
  });

  it("应运行智能体的位置只有裸 shell 时判为不匹配（进程已终止 / 孤儿占位）", () => {
    expect(classifyPaneRuntimeMatch("zsh", "claude-code")).toBe("mismatch");
    expect(classifyPaneRuntimeMatch("-bash", "codex")).toBe("mismatch");
  });

  it("terminal（基础设施）节点运行 shell 符合预期——匹配", () => {
    expect(classifyPaneRuntimeMatch("zsh", "terminal")).toBe("match");
  });
});

describe("SeatIdentityReconciler.reconcileAll", () => {
  it("在封装的 Codex 席位间共享两次原生观察，并拒绝后续过期或缺失的证明", async () => {
    const db = createFullTestDb();
    for (const n of [1, 2]) {
      seedSeat(db, { nodeId: `c${n}`, sessionName: `c${n}@rig`, pane: `%${n}`, runtime: "codex" });
      db.prepare("UPDATE sessions SET resume_token = ? WHERE node_id = ?").run(`thread-${n}`, `c${n}`);
    }
    const tmux = makeTmux({ sessions: ["c1@rig", "c2@rig"], panePid: { "%1": 10, "%2": 20 }, paneCommand: { "%1": "bash", "%2": "node" } });
    const rows = [1, 2].flatMap(n => [
      { pid: n * 10, ppid: 1, pgid: n * 10, tpgid: n * 10 + 1, executableName: "bash", command: "bash", startedAt: "Sat Jan  1 12:00:00 2000" },
      { pid: n * 10 + 1, ppid: n * 10, pgid: n * 10 + 1, tpgid: n * 10 + 1, executableName: "codex", command: `codex resume thread-${n}`, startedAt: "Sat Jan  1 12:00:00 2000" },
    ]);
    const listProcesses = vi.fn(async () => rows);
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses, now: NOW });
    const store = new SeatIdentityStore(db);
    await rec.reconcileAll();
    expect(listProcesses).toHaveBeenCalledTimes(2);
    for (const n of [1, 2]) expect(store.getForNode(`c${n}`)).toMatchObject({ verdict: "verified", evidence: { observedPid: n * 10 + 1 } });

    // 下一轮清查中复用的原生 PID 不能保留旧 green。
    listProcesses.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.map(r => r.pid === 11 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r));
    await rec.reconcileAll();
    expect(store.getForNode("c1")?.verdict).toBe("mismatch");
    expect(store.getForNode("c2")?.verdict).toBe("verified");

    db.prepare("UPDATE sessions SET resume_token = 'wrong' WHERE node_id = 'c1'").run();
    await rec.reconcileAll();
    expect(store.getForNode("c1")?.verdict).toBe("mismatch");
    listProcesses.mockResolvedValue([]);
    await rec.reconcileAll();
    for (const n of [1, 2]) expect(store.getForNode(`c${n}`)?.verdict).toBe("mismatch");
    db.close();
  });

  it("区分全新 Codex 与 resume，且无法验证不可用 pane", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "c1", sessionName: "c1@rig", pane: "%1", runtime: "codex" });
    const tmux = makeTmux({ sessions: ["c1@rig"], panePid: { "%1": 10 }, paneCommand: { "%1": "codex" } });
    const listProcesses = vi.fn(async () => [{ pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "codex", command: "codex -m configured-model", startedAt: "Sat Jan  1 12:00:00 2000" }]);
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses, now: NOW });
    await rec.reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("c1")?.verdict).toBe("verified");
    vi.mocked(tmux.listSessions).mockRejectedValue(new Error("unavailable"));
    await rec.reconcileAll();
    expect(new SeatIdentityStore(db).getForNode("c1")?.verdict).toBe("mismatch");
    db.close();
  });

  it("VERIFIED——pane pid 与命令匹配时持久化 verified 判定", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 4242 }, paneCommand: { "%1": "node" } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("verified");
    expect(v?.evidence.observedPid).toBe(4242);
    expect(v?.evidence.registeredPane).toBe("%1");
    expect(v?.reason).toBeNull();
    db.close();
  });

  it("MISMATCH——孤儿/占位进程（shell）持久化 process_identity_mismatch 判定", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // 同名会话仍存活（占位），但 pane 现在运行裸 shell。
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 9999 }, paneCommand: { "%1": "zsh" } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("mismatch");
    expect(v?.reason).toBe("process_identity_mismatch");
    expect(v?.evidenceSource).toBe("pane_process");
    expect(v?.evidence.observedCommand).toBe("zsh");
    db.close();
  });

  it("PANE_MISSING（pane 消失、会话存活）→ pane_pid_gone", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // 会话列为存活，但已注册 pane 无法再解析。
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": null } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("pane_missing");
    expect(v?.reason).toBe("pane_pid_gone");
    expect(v?.evidenceSource).toBe("pane_process");
    db.close();
  });

  it("PANE_MISSING（会话完全消失）→ session_missing", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // 另一个会话存活（tmux 正常），但 s1@rig 已消失。
    const tmux = makeTmux({ sessions: ["other@rig"], panePid: { "%1": null } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("pane_missing");
    expect(v?.reason).toBe("session_missing");
    expect(v?.evidenceSource).toBe("tmux_session");
    db.close();
  });

  it("NULL pane + 存活目标 → 具名 binding_absent，而非 tmux_unavailable", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: null, runtime: "claude-code" });
    const tmux = makeTmux({ sessions: ["s1@rig"] });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("binding_absent");
    expect(v?.reason).toBe("binding_pane_missing");
    expect(v?.evidence.registeredPane).toBeNull();
    db.close();
  });

  it("NULL pane + 目标缺失但 tmux 有另一会话 → 降级为 session_missing", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: null, runtime: "claude-code" });
    const tmux = makeTmux({ sessions: ["other@rig"] });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("pane_missing");
    expect(v?.reason).toBe("session_missing");
    expect(v?.evidence.registeredPane).toBeNull();
    db.close();
  });

  it("TMUX 抖动防护——listSessions 抛出异常 → tmux_unavailable，绝不降级", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    const tmux = makeTmux({ throwListSessions: true });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("tmux_unavailable");
    expect(v?.reason).toBe("tmux_unavailable");
    db.close();
  });

  it("TMUX 抖动防护——存在席位但存活会话为零 → tmux_unavailable（而非全部 session_missing）", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    const tmux = makeTmux({ sessions: [], panePid: { "%1": null } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const v = new SeatIdentityStore(db).getForNode("n1");
    expect(v?.verdict).toBe("tmux_unavailable");
    db.close();
  });

  it("剪除非运行中席位；仅运行中且绑定 tmux 的席位获得判定", async () => {
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    seedSeat(db, { nodeId: "n2", sessionName: "s2@rig", pane: "%2", runtime: "claude-code", status: "exited" });
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": 1 }, paneCommand: { "%1": "node" } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    const store = new SeatIdentityStore(db);
    expect(store.getForNode("n1")?.verdict).toBe("verified");
    expect(store.getForNode("n2")).toBeNull();
    db.close();
  });

  it("存活性不从心跳推导——无论是否有心跳，已消失 pane 始终不为 green", async () => {
    // 协调器从不读取队列/分类器/hook 状态；pane 消失的席位即使假设仍有工作/心跳，
    // 也会产生 pane_missing。
    const db = createFullTestDb();
    seedSeat(db, { nodeId: "n1", sessionName: "s1@rig", pane: "%1", runtime: "claude-code" });
    // 模拟该席位的活跃队列心跳（不得升级存活性）。
    db.prepare(
      "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("q1", "2026-07-02T12:00:00Z", "2026-07-02T12:00:00Z", "op@rig", "s1@rig", "pending", "do work");
    const tmux = makeTmux({ sessions: ["s1@rig"], panePid: { "%1": null } });
    const rec = new SeatIdentityReconciler({ db, tmux, now: NOW });

    await rec.reconcileAll();

    expect(new SeatIdentityStore(db).getForNode("n1")?.verdict).toBe("pane_missing");
    db.close();
  });
});

describe("seat_identity_verdicts schema（迁移 046）", () => {
  it("表存在且包含预期列", () => {
    const db = createFullTestDb();
    const cols = (db.pragma("table_info(seat_identity_verdicts)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "node_id", "verdict", "evidence_source", "reason", "registered_pane",
        "observed_pid", "observed_command", "matched_layer", "session_name", "observed_at",
      ]),
    );
    db.close();
  });

  it("upsert 按 node_id 采用最后写入者胜出", () => {
    const db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1','r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1','rig-1','p.n1','claude-code','/tmp')").run();
    const store = new SeatIdentityStore(db);
    const base = {
      nodeId: "n1",
      evidenceSource: "pane_process" as const,
      reason: null,
      evidence: { registeredPane: "%1", observedPid: 1, observedCommand: "node", matchedLayer: 1 },
      sessionName: "s1@rig",
      observedAt: "2026-07-02T12:00:00.000Z",
    };
    store.upsert({ ...base, verdict: "verified" });
    store.upsert({ ...base, verdict: "mismatch", reason: "process_identity_mismatch" });
    expect(store.getForNode("n1")?.verdict).toBe("mismatch");
    expect(db.prepare("SELECT COUNT(*) c FROM seat_identity_verdicts").get()).toEqual({ c: 1 });
    db.close();
  });
});
