// Mechanics-gate 修复（desk BLOCKING 裁定 qitem-20260825153441-d9b3989a）——`zrig walk`
// 逐片段消费验证背后的两个 daemon primitive：
//   1. SessionTransport submitOnly——对暂存文本只重试一次裸 Enter，且结构上安全：pane 必须
//      显示预期暂存内容，否则拒绝 Enter（权限提示处的裸 Enter 会批准操作——mismatch gate
//      正是为此风险而存在）。
//   2. GET /api/sessions/:sessionName/generation-record——按效果判定消费的来源：通过
//      ContextUsageStore sidecar 获得当前 generation identity + 按字节寻址的后缀；无法解析
//      record 时明确拒绝。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, appendFileSync, renameSync } from "node:fs";
import { Command } from "commander";
import { walkCommand } from "../../cli/src/commands/walk.js";
import { STATE_FILE } from "../../cli/src/daemon-lifecycle.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import { CodexThreadIdResolver } from "../src/domain/codex-thread-id.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { createFullTestDb } from "./helpers/test-app.js";

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: overrides?.hasSession ?? (async () => true),
    probeSession: async (name: string) =>
      (await (overrides?.hasSession ?? (async () => true))(name))
        ? { state: "present" as const }
        : { state: "absent" as const },
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle\n❯ "),
    getPaneCommand: async () => null,
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
  } as unknown as TmuxAdapter;
}

describe("SessionTransport submitOnly——受 guard 保护的裸 Enter 重试", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let agentActivityStore: AgentActivityStore;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    agentActivityStore = new AgentActivityStore({ db, eventBus });
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
  });
  afterEach(() => db.close());

  const makeTransport = (tmux: TmuxAdapter) =>
    new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux, agentActivityStore, eventBus });

  const STAGED_PIECE = "# 从 primitive 构建世界\n\n席位通过组合来学习世界……";

  it("pane 显示预期暂存文本时恰好按一次 C-m，且不输入任何内容", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendText, sendKeys,
      capturePaneContent: async () => `❯ ${STAGED_PIECE.slice(0, 50)}\n  paste again to expand`,
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE.slice(0, 200) });
    expect(res.ok).toBe(true);
    expect(res.submitOnly).toBe(true);
    expect(sendText).not.toHaveBeenCalled();                       // 始终不输入任何内容
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith("dev-impl@my-rig", ["C-m"]);
  });

  it("pane 显示其他内容时拒绝（staged_mismatch）——权限提示处的裸 Enter 会批准操作", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "Authorize the 0.4.0 release?\n\n❯ 1. Authorize publish → @latest (Recommended)\n  2. Roll back\n",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();                       // Enter 从未发送
  });

  it("大小匹配但无字面残留的裸 placeholder 会拒绝——大小相似不代表身份相同（第 4 轮契约，取代 R1/R2 接受规则）", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #4 +112 lines]\n  paste again to expand",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 112 });
    expect(res.ok).toBe(false); // 第 4 轮：无残留 → 无身份 → 关闭式失败
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // ROUND-2（r2 R1 HIGH-1，row 66e74676）：陈旧 scrollback 绝不能授权 Enter。证据必须是当前
  // 活动输入且能标识此片段——50 行内任意位置的通用 placeholder 两者都不满足。
  it("R2 HIGH-1 判别器——后续交互提示上方的陈旧 pasted-text placeholder 会拒绝，Enter 调用为零【GREEN——当前输入绑定】", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      // reviewer 给出的形状：scrollback 中有较早 placeholder，随后是占据当前输入的交互提示。
      // 此时按 Enter 会批准该提示。
      capturePaneContent: async () => "❯ [Pasted text #2 +112 lines]\nold output scrolled past\n\nAuthorize the next action?\n❯ 1. Continue\n  2. Cancel\n",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 112 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled(); // Enter 调用为零——禁止的效果从未发生
  });

  it("R2 HIGH-1——placeholder 行数与预期片段不匹配时不构成片段身份：拒绝【GREEN——行数限定】", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #4 +112 lines]\n  paste again to expand",
    }));
    // walk 片段为 6 行；暂存 blob 为 112 行——来自其他人的粘贴。
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 6 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("R2 HIGH-1——当前输入暂存多个 placeholder 属于合并暂存：拒绝，绝不以一次 Enter 提交多个片段【GREEN——拒绝多段暂存】", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #3 +112 lines] [Pasted text #4 +112 lines]\n  paste again to expand",
    }));
    const res = await transport.send("dev-impl@my-rig", "", { submitOnly: true, expectedStagedText: STAGED_PIECE, expectedStagedLineCount: 112 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // ROUND-3（r2 R2 HIGH-1，row d95b2ea7）：身份关系必须符合 Claude 的真实暂存渲染，
  // 固定于保留的 Test-A specimen（t1-mechanics run、receipt 54-direct-tmux-capture.txt +
  // served-profile/02-permission-self-sleep.md），而非凭空构造：一个 walk 片段（8834 字节、
  // 142 个 split("\n") 条目）渲染为八个 placeholder（+16,+15,+19,+15,+17,+15,+17,+16——
  // segment 大小，不是源码换行；总和 130），随后是该片段自身的字面尾部并跨 pane 行换行；
  // placeholder token 本身也会跨行（"+19\n  lines]"）。
  const FIXTURES = join(import.meta.dirname ?? __dirname, "fixtures", "walk-staged-specimen");
  const PIECE_2 = () => readFileSync(join(FIXTURES, "piece-02-permission-self-sleep.md"), "utf8");
  const PANE_SINGLE = () => readFileSync(join(FIXTURES, "pane-single-piece-2.txt"), "utf8");
  const PANE_COALESCED = () => readFileSync(join(FIXTURES, "pane-coalesced-pieces-2-and-3.txt"), "utf8");

  it("R3 SPECIMEN——保留的单片段暂存渲染（8 个 placeholder + 字面尾部）会接受并恰好提交一次【GREEN——真实渲染身份】", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({ sendKeys, capturePaneContent: async () => PANE_SINGLE() }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true,
      expectedStagedText: PIECE_2(),
      expectedStagedLineCount: PIECE_2().split("\n").length, // 142——任何显示计数都不等于此值
    });
    expect(res.ok).toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(1); // 受 guard 保护的恢复恰好提交一次该暂存输入
  });

  it("R3 SPECIMEN GUARD——保留的合并区域（片段 2 与 3 均暂存）拒绝片段 2 且 Enter 调用为零：提交会把两个片段合成一条消息", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({ sendKeys, capturePaneContent: async () => PANE_COALESCED() }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true,
      expectedStagedText: PIECE_2(),
      expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // ROUND-4（r2 R3 HIGH-1，row 7435d61b）：大小相似与短共享短语都不代表身份相同。只有渲染
  // 自身结构（保留字节已证明：字面残留是片段归一化后的后缀，specimen 中为 524 字符）可作为
  // 接受锚点；低于此要求时关闭式失败。
  it("R4 PROBE-A——大小看似合理（142 中的 +100）但不相关的裸 placeholder 会拒绝，Enter 调用为零：无残留即无身份【GREEN——已移除无身份接受】", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #9 +100 lines]\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on",
    }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true,
      expectedStagedText: PIECE_2(),
      expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("R4 PROBE-B——不相关 placeholder 加上碰巧出现在片段中的短语会拒绝，Enter 调用为零：公共子串不能授权另一输入【GREEN——强残留锚定】", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => "❯ [Pasted text #3 +12 lines]What are your options?\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on",
    }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true,
      expectedStagedText: PIECE_2(),
      expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // ROUND-5（r2 R4 HIGH-1，row e039e8d1）：后缀锚点必须连接到不透明 placeholder 前缀。
  // 保留字节证明了该关系：placeholder 总和（130）标识可见后缀正前方的隐藏源码边界（524 字符
  // 残留恰好从 142 条目片段的第 130 个源码换行后开始）。总和与匹配后缀之前的边界不一致，
  // 表明前缀被截断或错误——拒绝。
  const pieceTail = () => PIECE_2().split("\n").slice(-3).join("\n"); // 真实后缀，归一化后 85 字符；边界 = 139

  it("R5——+1 placeholder 带片段精确字面后缀时拒绝且 Enter 调用为零：总和不匹配隐藏边界【GREEN——总和与边界连接】", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => `❯ [Pasted text #5 +1 lines]${pieceTail()}\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on`,
    }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true, expectedStagedText: PIECE_2(), expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("R5——看似合理的 +100 placeholder 带片段精确字面后缀时拒绝且 Enter 调用为零：100 也不是边界【GREEN——总和与边界连接】", async () => {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => `❯ [Pasted text #5 +100 lines]${pieceTail()}\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on`,
    }));
    const res = await transport.send("dev-impl@my-rig", "", {
      submitOnly: true, expectedStagedText: PIECE_2(), expectedStagedLineCount: PIECE_2().split("\n").length,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // ROUND-6（r2 R5，row 98a9a82c / artifact a7ff103e）：±1 容差未经证明——两个单独暂存的
  // 保留片段都呈现精确相等（片段 2：总和 130 = 边界 130；片段 3：总和 82 = 边界 82）。
  // 精确相等才是契约。
  const submitTail = (count: number) => transportFor(count);
  function transportFor(count: number) {
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const transport = makeTransport(mockTmux({
      sendKeys,
      capturePaneContent: async () => `❯ [Pasted text #5 +${count} lines]${PIECE_2().split("\n").slice(-3).join("\n")}\n\n────────────────────────────────────────\n  ⏵⏵ accept edits on`,
    }));
    return { transport, sendKeys };
  }
  const submitOpts = () => ({ submitOnly: true as const, expectedStagedText: PIECE_2(), expectedStagedLineCount: PIECE_2().split("\n").length });

  it("R6——精确边界（+139）接受一次", async () => {
    const { transport, sendKeys } = submitTail(139);
    const res = await transport.send("dev-impl@my-rig", "", submitOpts());
    expect(res.ok).toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(1);
  });

  it("R6——比边界少一（+138）时拒绝且 Enter 调用为零【GREEN——精确相等】", async () => {
    const { transport, sendKeys } = submitTail(138);
    const res = await transport.send("dev-impl@my-rig", "", submitOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("R6——比边界多一（+140）时拒绝且 Enter 调用为零【GREEN——精确相等】", async () => {
    const { transport, sendKeys } = submitTail(140);
    const res = await transport.send("dev-impl@my-rig", "", submitOpts());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("staged_mismatch");
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("缺少 expectedStagedText 或提供 text 时拒绝（invalid_submit_only）", async () => {
    const transport = makeTransport(mockTmux());
    const noExpected = await transport.send("dev-impl@my-rig", "", { submitOnly: true });
    expect(noExpected.ok).toBe(false);
    expect(noExpected.reason).toBe("invalid_submit_only");
    const withText = await transport.send("dev-impl@my-rig", "一些文本", { submitOnly: true, expectedStagedText: "一些文本" });
    expect(withText.ok).toBe(false);
    expect(withText.reason).toBe("invalid_submit_only");
  });
});

describe("GET /api/sessions/:sessionName/generation-record——按效果判定消费的来源", () => {
  let stateDir: string;
  let app: Hono;
  let db: Database.Database;
  let registry: SessionRegistry;
  const threadId = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "walk-genrec-"));
    db = createFullTestDb();
    registry = new SessionRegistry(db);
    const store = new ContextUsageStore(db, { stateDir, codexHomeDir: stateDir });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("contextUsageStore" as never, store as never);
      c.set("sessionRegistry" as never, registry as never);
      c.set("tmuxAdapter" as never, { getPanePid: async () => 10 } as never);
      await next();
    });
    app.route("/api/sessions", sessionAdminRoutes);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(stateDir, { recursive: true, force: true }); });

  function seedCodex(metaId = threadId) {
    const repo = new RigRepository(db);
    const rig = repo.createRig("codex-rig");
    const node = repo.addNode(rig.id, "dev.codex", { runtime: "codex" });
    const seat = "dev-codex@codex-rig";
    const session = registry.registerSession(node.id, seat);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: seat, tmuxPane: "%42" });
    new SeatIdentityStore(db).upsert({ nodeId: node.id, verdict: "verified", evidenceSource: "env", reason: null,
      evidence: { registeredPane: "%42", observedPid: 10, observedCommand: "codex", matchedLayer: 1 },
      sessionName: seat, observedAt: new Date().toISOString() } as never);
    vi.spyOn(ProcessCensus.prototype, "list").mockResolvedValue([
      { pid: 10, ppid: 1, command: "zsh" }, { pid: 20, ppid: 10, command: "codex", startedAt: "start" },
    ]);
    vi.spyOn(CodexThreadIdResolver.prototype, "resolve").mockResolvedValue(threadId);
    mkdirSync(join(stateDir, ".codex"));
    const nativeDb = new Database(join(stateDir, ".codex", "state_5.sqlite"));
    const record = join(stateDir, "rollout.jsonl");
    nativeDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    nativeDb.prepare("INSERT INTO threads VALUES (?, ?)").run(threadId, record);
    nativeDb.close();
    writeFileSync(record, JSON.stringify({ type: "session_meta", payload: { id: metaId } }) + "\n");
    return { node, record, url: `/api/sessions/${seat}/generation-record` };
  }

  it("Codex 当前绑定 thread 在首个 token_count 事件前即可解析", async () => {
    const { url } = seedCodex();
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runtime: "codex", sessionId: threadId });
  });

  it("Codex 拒绝错误 rollout identity，而非接受 thread 表指针", async () => {
    const { url } = seedCodex("old-thread");
    const response = await app.request(url);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "record_identity_mismatch" });
  });

  it("同一路径替换 Codex record 会改变 generation identity", async () => {
    const { url, record } = seedCodex();
    const first = await (await app.request(url)).json();
    const replacement = record + ".next";
    writeFileSync(replacement, readFileSync(record));
    const { renameSync } = await import("node:fs");
    renameSync(replacement, record);
    const second = await (await app.request(url)).json();
    expect(first.generationId).toBeDefined();
    expect(second.generationId).not.toBe(first.generationId);
  });

  it("Codex 拒绝来自已退役 occupant 的 identity observation", async () => {
    const { node, url } = seedCodex();
    db.prepare("UPDATE seat_identity_verdicts SET observed_at = '2000-01-01T00:00:00Z' WHERE node_id = ?").run(node.id);
    const response = await app.request(url);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "record_identity_unverified" });
  });

  it("Codex 拒绝同一 pane 下有歧义的 native thread", async () => {
    const { url } = seedCodex();
    vi.mocked(ProcessCensus.prototype.list).mockResolvedValue([
      { pid: 10, ppid: 1, command: "zsh" },
      { pid: 20, ppid: 10, command: "codex", startedAt: "a" },
      { pid: 21, ppid: 10, command: "codex", startedAt: "b" },
    ]);
    vi.mocked(CodexThreadIdResolver.prototype.resolve).mockImplementation(async pid => pid === 20 ? threadId : "other-thread");
    const response = await app.request(url);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "record_identity_unverified", message: expect.stringContaining("多个 Codex 线程") });
  });

  it.each(["0.5", "-1", "NaN", "", "9007199254740992"])("拒绝无效字节偏移 %s", async offset => {
    seedSidecar("dev-offset@r", "gen-offset", "{}\n");
    expect((await app.request(`/api/sessions/dev-offset@r/generation-record?sinceBytes=${offset}`)).status).toBe(400);
  });

  it.each(["complete", "prefix", "old-file", "replaced-file", "changed-occupant", "wrong-turn", "missing-turn", "missing-file", "claude"])(
    "集成 CLI → route → native record：%s", async (scenario) => {
      const { record, node } = seedCodex();
      const piece = "共享标题。".repeat(8) + "完整中段很重要。\n".repeat(9) + "独特尾部 Ω";
      const seat = scenario === "claude" ? "dev-claude@r" : "dev-codex@codex-rig";
      const claudePath = scenario === "claude" ? seedSidecar(seat, "claude-gen", "") : null;
      const records = (text: string) => scenario === "claude" ? [
        { type: "user", uuid: "input", message: { role: "user", content: text } },
        { type: "assistant", uuid: "answer", parentUuid: "input", message: { role: "assistant", content: "完成" } },
        { type: "system", subtype: "turn_duration", uuid: "closed", parentUuid: "answer" },
      ] : [
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
        { type: "turn_context", payload: { turn_id: "turn" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
        ...(scenario === "missing-turn" ? [] : [{ type: "event_msg", payload: { type: "task_complete", turn_id: scenario === "wrong-turn" ? "other" : "turn" } }]),
      ];
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const oldExit = process.exitCode;
      process.exitCode = undefined;
      let sends = 0;
      try {
        const command = new Command().addCommand(walkCommand({
          lifecycleDeps: {
            readFile: p => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7777, db: "isolated", startedAt: new Date().toISOString() }) : null,
            exists: p => p === STATE_FILE, isProcessAlive: () => true,
            fetch: async () => ({ ok: true }),
          } as never,
          fileExists: () => true, readFile: () => piece,
          clientFactory: () => ({
            get: async (path: string) => {
              const response = await app.request(path);
              return { status: response.status, data: await response.json() };
            },
            post: async (path: string) => {
              if (path.endsWith("/capture")) return { status: 200, data: { content: "空闲" } };
              sends++;
              const text = scenario === "prefix" ? piece.slice(0, 115) : piece;
              const suffix = records(text).map(r => JSON.stringify(r)).join("\n") + "\n";
              if (scenario === "missing-file") rmSync(record);
              else if (scenario === "replaced-file") {
                writeFileSync(record + ".next", readFileSync(record, "utf8") + suffix);
                renameSync(record + ".next", record);
              } else if (scenario === "changed-occupant") {
                registry.mintOccupantTenure(node.id, "handover", "new-native-id");
                appendFileSync(record, suffix);
              } else appendFileSync(scenario === "old-file" ? join(stateDir, "retired.jsonl") : claudePath ?? record, suffix);
              return { status: 200, data: { ok: true } };
            },
          }) as never,
          sleep: async () => {},
        }));
        await command.parseAsync(["node", "zrig", "walk", seat, "--through", "piece.md", "--json", "--pace", "0ms",
          "--consume-timeout", "20ms", "--consume-poll", "1ms", "--turn-timeout", "20ms"]);
        const positive = scenario === "complete" || scenario === "claude";
        expect(process.exitCode).toBe(positive ? undefined : 1);
        expect(log.mock.calls.some(([line]) => String(line).includes('"consumptionVerified":true'))).toBe(positive);
        expect(sends).toBe(1);
      } finally { process.exitCode = oldExit; }
    },
  );

  const seedSidecar = (seat: string, generationId: string, jsonlContent: string): string => {
    const jsonl = join(stateDir, `${generationId}.jsonl`);
    writeFileSync(jsonl, jsonlContent);
    mkdirSync(join(stateDir, "state", "context-usage"), { recursive: true });
    writeFileSync(join(stateDir, "state", "context-usage", `${seat}.json`), JSON.stringify({
      session_id: generationId,
      session_name: seat,
      transcript_path: jsonl,
      context_window: { used_percentage: 10 },
    }));
    return jsonl;
  };

  it("无 sinceBytes 时提供 identity + totalBytes，有该参数时提供按字节寻址的后缀（多字节安全）", async () => {
    // record 故意在后缀边界前包含多字节字符：totalBytes 与返回 slice 的字节寻址必须一致。
    const early = '{"note":"……多字节……省略号……"}\n';
    const late = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"walk 的片段"}]}}\n';
    seedSidecar("dev-x@r", "gen-abc", early + late);
    const idRes = await app.request(`/api/sessions/${encodeURIComponent("dev-x@r")}/generation-record`);
    expect(idRes.status).toBe(200);
    const id = await idRes.json() as { generationId: string; sessionId: string; totalBytes: number; suffix?: string };
    expect(id.sessionId).toBe("gen-abc");
    expect(id.generationId).toEqual(expect.any(String));
    expect(id.totalBytes).toBe(Buffer.byteLength(early + late, "utf8"));
    expect(id.suffix).toBeUndefined();

    const since = Buffer.byteLength(early, "utf8");
    const sufRes = await app.request(`/api/sessions/${encodeURIComponent("dev-x@r")}/generation-record?sinceBytes=${since}`);
    expect(sufRes.status).toBe(200);
    const suf = await sufRes.json() as { generationId: string; suffix: string; truncated: boolean };
    expect(suf.generationId).toBe(id.generationId);
    expect(suf.suffix).toBe(late);
    expect(suf.truncated).toBe(false);
  });

  it("无法解析 sidecar record 时明确拒绝（409 unsupported_runtime），绝不返回空成功", async () => {
    const res = await app.request(`/api/sessions/${encodeURIComponent("ghost@r")}/generation-record`);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("unsupported_runtime");
    expect(body.message).toContain("ghost@r");
  });

  // ROUND-2（r2 R1 HIGH-2，row 66e74676）：原始 generation-record 读取是终端级 surface
  //（原始对话字节，无 transcript 脱敏），必须位于与相邻接口相同的 bearer gate 后。bearer
  // 缺失/错误/正确分别返回 401/401/200；null-token（loopback）daemon 直接放行。
  it("R2 HIGH-2——配置 terminal bearer token 时：缺失与错误 bearer 返回 401，正确 bearer 返回 200【GREEN——terminalAuthGuard】", async () => {
    const stateDir2 = mkdtempSync(join(tmpdir(), "walk-genrec-auth-"));
    try {
      const db2 = createFullTestDb();
      const store2 = new ContextUsageStore(db2, { stateDir: stateDir2 });
      const authed = new Hono();
      authed.use("*", async (c, next) => {
        c.set("contextUsageStore" as never, store2 as never);
        c.set("terminalBearerToken" as never, "sekrit-token" as never);
        await next();
      });
      authed.route("/api/sessions", sessionAdminRoutes);
      const jsonl = join(stateDir2, "gen-z.jsonl");
      writeFileSync(jsonl, '{"x":1}\n');
      mkdirSync(join(stateDir2, "state", "context-usage"), { recursive: true });
      writeFileSync(join(stateDir2, "state", "context-usage", "dev-z@r.json"), JSON.stringify({ session_id: "gen-z", transcript_path: jsonl, context_window: { used_percentage: 5 } }));

      const url = `/api/sessions/${encodeURIComponent("dev-z@r")}/generation-record`;
      const missing = await authed.request(url);
      expect(missing.status).toBe(401);
      const wrong = await authed.request(url, { headers: { Authorization: "Bearer wrong" } });
      expect(wrong.status).toBe(401);
      const right = await authed.request(url, { headers: { Authorization: "Bearer sekrit-token" } });
      expect(right.status).toBe(200);
    } finally {
      rmSync(stateDir2, { recursive: true, force: true });
    }
  });

  it("null-token（loopback）daemon 放行 generation-record 读取——现有无鉴权测试即此模式", async () => {
    // 套件其他 route 测试均未设置 terminalBearerToken，并预期 200/409——这正是 null-token
    // 放行固定点；本用例仅为该契约命名。
    const res = await app.request(`/api/sessions/${encodeURIComponent("nobody@r")}/generation-record`);
    expect([200, 409]).toContain(res.status);
  });

  it("sidecar 指向不存在的 transcript 时明确拒绝（409 record_unreadable）", async () => {
    seedSidecar("dev-y@r", "gen-y", "x\n");
    rmSync(join(stateDir, "gen-y.jsonl"));
    const res = await app.request(`/api/sessions/${encodeURIComponent("dev-y@r")}/generation-record`);
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("record_unreadable");
  });
});
