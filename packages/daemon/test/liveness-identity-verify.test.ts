// OPR.0.4.3.19 — 存活状态的身份判定投射门控。
//
// 已持久化的身份判定为 `mismatch`/`pane_missing` 时，必须把 `running` 会话
// 在节点清单（供养 `rig ps --nodes` 与节点详情）和拓扑图中从 running/active
// 降级，并附带证据。`verified`、`tmux_unavailable` 以及判定缺失时，必须保持
// 既有投射不变（不得假绿翻转；不得回归）。

import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { getNodeInventory, deriveNodeLifecycleState } from "../src/domain/node-inventory.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { projectRigToGraph, type InventoryOverlay } from "../src/domain/graph-projection.js";
import type { SeatIdentityVerdict, SeatIdentityVerdictKind } from "../src/domain/types.js";
import { identityVerdictDownranksRunning } from "../src/domain/types.js";

function seedRunningSeat(db: Database.Database): void {
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1','test-rig')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n1','rig-1','dev.impl','claude-code','/tmp')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('sess1','n1','dev-impl@rig','running','ready')").run();
  db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('bind1','n1','tmux','dev-impl@rig','%1')").run();
}

function verdict(kind: SeatIdentityVerdictKind, reason: SeatIdentityVerdict["reason"] = null): SeatIdentityVerdict {
  return {
    nodeId: "n1",
    verdict: kind,
    evidenceSource: kind === "verified" ? "pane_process" : (reason === "session_missing" ? "tmux_session" : "pane_process"),
    reason,
    evidence: { registeredPane: "%1", observedPid: 1, observedCommand: "zsh", matchedLayer: 1 },
    sessionName: "dev-impl@rig",
    observedAt: "2026-07-02T12:00:00.000Z",
  };
}

describe("deriveNodeLifecycleState 身份门控（单元）", () => {
  const base = { restoreOutcome: "n-a" as const, nodeId: "n1", usableSnapshot: null };

  it("running + verified → running", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "verified" })).toBe("running");
  });
  it("running + 无判定 → running（不假翻转）", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: null })).toBe("running");
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running" })).toBe("running");
  });
  it("running + tmux_unavailable → running（瞬时抖动不是不匹配）", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "tmux_unavailable" })).toBe("running");
  });
  it("running + binding_absent → running（目标存活但绑定缺失，仅具名，不降级）", () => {
    expect(identityVerdictDownranksRunning("binding_absent")).toBe(false);
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "binding_absent" })).toBe("running");
  });
  it("running + 启动待关注 → attention_required", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", startupStatus: "attention_required" })).toBe("attention_required");
  });
  it("running + mismatch → attention_required", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "mismatch" })).toBe("attention_required");
  });
  it("running + pane_missing → attention_required", () => {
    expect(deriveNodeLifecycleState({ ...base, sessionStatus: "running", identityVerdict: "pane_missing" })).toBe("attention_required");
  });
});

describe("getNodeInventory 身份门控", () => {
  it("无判定 → running/active + identityVerdict 为 null（不回归）", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("running");
    expect(n.occupantLifecycle).toBe("active");
    expect(n.identityVerdict).toBeNull();
    db.close();
  });

  it("verified 判定 → running/active，判定被呈现", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("verified"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("running");
    expect(n.occupantLifecycle).toBe("active");
    expect(n.identityVerdict?.verdict).toBe("verified");
    db.close();
  });

  it("MISMATCH 判定 → 不是 running/active；证据被呈现", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("mismatch", "process_identity_mismatch"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("attention_required");
    expect(n.occupantLifecycle).toBe("unknown");
    expect(n.sessionStatus).toBe("running"); // 原始 session 行不变
    expect(n.identityVerdict?.reason).toBe("process_identity_mismatch");
    expect(n.identityVerdict?.evidence.registeredPane).toBe("%1");
    db.close();
  });

  it("PANE_MISSING 判定 → 不是干净的 running；证据指明其缺失", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("pane_missing", "session_missing"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("attention_required");
    expect(n.occupantLifecycle).toBe("unknown");
    expect(n.identityVerdict?.reason).toBe("session_missing");
    db.close();
  });

  it("NULL-pane 的 binding_absent 匹配判定可见，但不改变 running/active", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    db.prepare("UPDATE bindings SET tmux_pane = NULL WHERE node_id = 'n1'").run();
    new SeatIdentityStore(db).upsert({
      ...verdict("binding_absent", "binding_pane_missing"),
      evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
    });
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict?.verdict).toBe("binding_absent");
    expect(n.identityVerdict?.reason).toBe("binding_pane_missing");
    expect(n.lifecycleState).toBe("running");
    expect(n.occupantLifecycle).toBe("active");
    db.close();
  });

  it("NULL-pane 的 session_missing 匹配判定 → 降到 attention_required", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    db.prepare("UPDATE bindings SET tmux_pane = NULL WHERE node_id = 'n1'").run();
    expect(identityVerdictDownranksRunning("pane_missing")).toBe(true);
    new SeatIdentityStore(db).upsert({
      ...verdict("pane_missing", "session_missing"),
      evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
    });
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict?.verdict).toBe("pane_missing");
    expect(n.lifecycleState).toBe("attention_required");
    expect(n.occupantLifecycle).toBe("unknown");
    db.close();
  });

  it("存活状态不来自心跳——活跃的队列心跳不会把已判为不匹配的席位升回来", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    // 该席位有待处理 qitem（hasAssignedWork 本应为 true），但 pane
    // 身份不匹配 → 仍非绿色。判定胜出，而非心跳。
    db.prepare(
      "INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("q1", "2026-07-02T12:00:00Z", "2026-07-02T12:00:00Z", "op@rig", "dev-impl@rig", "pending", "work");
    new SeatIdentityStore(db).upsert(verdict("mismatch", "process_identity_mismatch"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.lifecycleState).toBe("attention_required");
    db.close();
  });
});

describe("getNodeInventory 判定适用性门控（rev1-r2 B1 —— 无过期假绿）", () => {
  // 持久化判定表只以 node_id 为键。重新绑定/重启后，节点保留其 id，但
  // 获得新的 session + 新 pane。针对旧 session/pane 计算出的判定绝不能
  // 应用到当前绑定：它被视为缺失（fail-open）——既不呈现，也不降级。
  // 只有存储的 sessionName 与 registeredPane 都与当前绑定匹配的判定才
  // 具有约束力。
  function staleVerdict(kind: SeatIdentityVerdictKind, reason: SeatIdentityVerdict["reason"] = null): SeatIdentityVerdict {
    return {
      nodeId: "n1",
      verdict: kind,
      evidenceSource: "pane_process",
      reason,
      // 旧 session + 旧 pane —— 重新绑定之前的绑定。
      evidence: { registeredPane: "%OLD", observedPid: 9, observedCommand: "zsh", matchedLayer: 1 },
      sessionName: "old-dev-impl@rig",
      observedAt: "2026-07-01T00:00:00.000Z",
    };
  }

  it("过期的 VERIFIED 判定（旧 session+pane）不应用到新绑定——视为缺失", () => {
    const db = createFullTestDb();
    seedRunningSeat(db); // 当前 session dev-impl@rig，pane %1
    new SeatIdentityStore(db).upsert(staleVerdict("verified"));
    const [n] = getNodeInventory(db, "rig-1");
    // Fail-open，且过期的 `verified` 不被呈现（否则会在从未针对其计算过的
    // pane 上给出假的 “verified” 标记）。
    expect(n.identityVerdict).toBeNull();
    expect(n.lifecycleState).toBe("running");
    db.close();
  });

  it("过期的 MISMATCH 判定（旧 session+pane）不得降级新 pane（无假红）", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(staleVerdict("mismatch", "process_identity_mismatch"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict).toBeNull();
    expect(n.lifecycleState).toBe("running"); // 过期判定不适用
    expect(n.occupantLifecycle).toBe("active");
    db.close();
  });

  it("session 匹配但 pane 过期的判定（仅 pane 重新绑定）不适用——AND 门控是真实的", () => {
    const db = createFullTestDb();
    seedRunningSeat(db); // 当前 pane %1
    new SeatIdentityStore(db).upsert({
      ...verdict("mismatch", "process_identity_mismatch"), // sessionName 匹配（dev-impl@rig）
      evidence: { registeredPane: "%OLD", observedPid: 9, observedCommand: "zsh", matchedLayer: 1 }, // ……但 pane 不匹配
    });
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict).toBeNull();
    expect(n.lifecycleState).toBe("running");
    db.close();
  });

  it("关键——匹配的 mismatch 判定仍会降级（门控没有过度抑制）", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("mismatch", "process_identity_mismatch")); // session dev-impl@rig + pane %1 均匹配
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict?.verdict).toBe("mismatch");
    expect(n.lifecycleState).toBe("attention_required");
    db.close();
  });

  it("关键——匹配的 pane_missing 判定仍会降级", () => {
    const db = createFullTestDb();
    seedRunningSeat(db);
    new SeatIdentityStore(db).upsert(verdict("pane_missing", "session_missing"));
    const [n] = getNodeInventory(db, "rig-1");
    expect(n.identityVerdict?.reason).toBe("session_missing");
    expect(n.lifecycleState).toBe("attention_required");
    db.close();
  });
});

describe("图投射消费身份判定（无假绿）", () => {
  // 事故的精确形态：原始 session status=running，overlay/startup 为
  // ready，terminalActive=true——mismatch 判定仍必须让图节点非绿。后台服务
  // 合成 graph startupStatus=attention_required，从而所有 UI 环
  // （getBaselineActivityState 在 terminalActive 之前先检查 attention_required）
  // 都渲染为非绿。
  function projectMismatchNode() {
    const overlay: InventoryOverlay[] = [{
      logicalId: "dev.impl",
      startupStatus: "ready", // startup 说 ready……
      canonicalSessionName: "dev-impl@rig",
      restoreOutcome: "n-a",
      terminalActive: true, // ……且（孤儿进程的）tmux 输出是活跃的……
      identityVerdict: verdict("mismatch", "process_identity_mismatch"), // ……但身份不匹配。
    }];
    const graph = projectRigToGraph({
      rig: { id: "rig-1", name: "test-rig" } as never,
      nodes: [{ id: "n1", rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" } as never],
      edges: [],
      sessions: [{ id: "sess1", nodeId: "n1", sessionName: "dev-impl@rig", status: "running", startupStatus: "ready" } as never],
      pods: [],
    }, overlay);
    return graph.nodes.find((n) => n.id === "n1");
  }

  it("主要——mismatch + running + ready + terminalActive=true → 图节点非绿（startupStatus 为 attention_required）", () => {
    const node = projectMismatchNode();
    // 非绿断言：图的有效 startup 状态是 attention_required，
    // UI 环在查询 terminalActive 之前就将其视为 needs_input。
    // 因此不匹配的席位无法被渲染为绿色。
    expect(node?.data.startupStatus).toBe("attention_required");
  });

  it("verified 判定让图节点保持 ready（不回归）", () => {
    const overlay: InventoryOverlay[] = [{
      logicalId: "dev.impl", startupStatus: "ready", canonicalSessionName: "dev-impl@rig",
      restoreOutcome: "n-a", terminalActive: true, identityVerdict: verdict("verified"),
    }];
    const graph = projectRigToGraph({
      rig: { id: "rig-1", name: "test-rig" } as never,
      nodes: [{ id: "n1", rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" } as never],
      edges: [],
      sessions: [{ id: "sess1", nodeId: "n1", sessionName: "dev-impl@rig", status: "running", startupStatus: "ready" } as never],
      pods: [],
    }, overlay);
    expect(graph.nodes.find((n) => n.id === "n1")?.data.startupStatus).toBe("ready");
  });

  it("次要——判定仍暴露在图节点数据上（证据）", () => {
    const node = projectMismatchNode();
    expect(node?.data.identityVerdict?.verdict).toBe("mismatch");
    expect(node?.data.identityVerdict?.reason).toBe("process_identity_mismatch");
  });
});
