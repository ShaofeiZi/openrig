// 动态笔记包 2——/api/review 路由族端到端测试（OPR.0.4.4.20）。
//
// 使用真实磁盘夹具（带 C1 标头的证明工件、C7 固定名称）与真实迁移后的 SQLite 数据库，
// 驱动 gatherer -> 纯 composer -> routes 路径，镜像 server.ts 通过上下文中间件连接依赖的方式。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { reviewRoutes } from "../src/routes/review.js";
import {
  makeFixtureWorkspace,
  writeFixtureSlice,
  writeFullGateSet,
  writeProofArtifact,
  type FixtureWorkspace,
} from "./review-fixtures.js";

const NOW = "2026-07-04T12:00:00.000Z";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeLineageRepo(root: string): { repo: string; oldSha: string; newSha: string } {
  const repo = path.join(root, "lineage-repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "review-test@example.test"]);
  git(repo, ["config", "user.name", "Review Test"]);
  let oldSha = "";
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(repo, "state.txt"), `state-${i}\n`);
    git(repo, ["add", "state.txt"]);
    git(repo, ["commit", "-q", "-m", `state ${i}`]);
    if (i === 0) {
      oldSha = git(repo, ["rev-parse", "HEAD"]);
    }
  }
  const newSha = git(repo, ["rev-parse", "HEAD"]);
  return { repo, oldSha, newSha };
}

describe("GET /api/review/*", () => {
  let ws: FixtureWorkspace;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    ws = makeFixtureWorkspace();
    db = createDb(":memory:");
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      streamItemsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      missionControlActionsSchema,
      queueItemSummarySchema,
    ]);
    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      await next();
    });
    app.route("/api/review", reviewRoutes());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  });

  function insertQitem(opts: { id: string; dest: string; state?: string; tags?: string[]; summary?: string | null; tier?: string | null }) {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, summary)
       VALUES (?, ?, ?, 'src@r', ?, ?, 'high', ?, ?, 'body', ?)`,
    ).run(opts.id, NOW, NOW, opts.dest, opts.state ?? "in-progress", opts.tier ?? null, JSON.stringify(opts.tags ?? []), opts.summary ?? null);
  }

  it("在线路上组合唯一结构：逐字意图、由已记录 QA 比较验证的 DELIVERED，且无废弃键", async () => {
    const dir = writeFixtureSlice(ws, "release-t", "20-green", {
      id: "OPR.T.20",
      intent: "Exactly these words.",
      prd: {
        miniReqs: ["one surface", "verified from recorded QA comparisons"],
        prdCheckboxes: [{ text: "the range probe", done: true }],
        proofContract: ["phone video"],
      },
      progressCheckboxes: [{ text: "the range probe", done: false }],
    });
    writeFullGateSet(dir, "20-green", "cand1234");
    writeProofArtifact(dir, {
      slice: "20-green",
      candidateSha: "cand1234",
      artifactType: "qa",
      verdict: "PASS",
      evidences: ["1"],
      selfCheck: "watched it against the mockup",
      fileName: "qa-2.md",
      mtime: new Date(Date.now() + 1000), // comparison deliberately later than the captured gate set
      body: "Comparison record.\n\n![phone journey](phone-journey.png)\n",
    });

    const res = await app.request("/api/review/slice/20-green");
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const dead of ["sections", "acceptance", "compare", "join", "green", "locked"]) {
      expect(body, `superseded structure '${dead}' must not survive on the wire`).not.toHaveProperty(dead);
    }
    expect(body.intent.text).toBe("Exactly these words.");
    expect(body.intent.ssotPath).toBe("release-t/slices/20-green/README.md");
    expect(body.plan.concise.text).toContain("one surface");
    expect(body.phase).toBe("review");
    expect(body.lineage.mergeSha).toBeNull(); // UNMERGED lineage fact — explicit, never hidden
    expect(body.lineage.mainTip).toBe("unknown"); // honest degrade with no git repo bound
    expect(body.delivered.items).toHaveLength(1);
    expect(body.delivered.items[0]).toMatchObject({
      promised: { text: "phone video" },
      verified: "verified",
      note: "旧版已记录验证（未绑定条目修订）。watched it against the mockup",
    });
    expect(body.delivered.items[0].proof).toEqual([
      { kind: "image", src: "proof/phone-journey.png", caption: "phone-journey.png" },
    ]);
    expect(body.delivered.proofDirPath).toBe("release-t/slices/20-green/proof");
  });

  it("将声称 PASS 的无门禁分片路由到 confirm-faithful（制度 2），items 保持缺失", async () => {
    const dir = writeFixtureSlice(ws, "release-t", "21-claimed", {
      intent: "i",
      prd: { miniReqs: ["m"], proofContract: ["the thing"] },
    });
    fs.writeFileSync(`${dir}/PROOF.md`, "# Proof\n\nResult: PASS\n");

    const res = await app.request("/api/review/slice/21-claimed");
    const body = await res.json();
    expect(body.needsYou.items.some((i: { leg: string }) => i.leg === "confirm-faithful")).toBe(true);
    expect(body.delivered.items[0].verified).toBe("missing"); // a self-claim never verifies a deliverable
  });

  it("将锁绑定到分阶段批准戳记和固定审计结构；无行戳记渲染为 UNVERIFIED", async () => {
    writeFixtureSlice(ws, "release-t", "26-locks", {
      id: "OPR.T.26",
      intent: "i",
      prd: { miniReqs: ["m"] },
      specApprovedBy: "planner@rig",
      specApprovedAt: "2026-07-03T00:00:00.000Z",
      approvedBy: "human@host",
      approvedAt: "2026-07-04T00:00:00.000Z",
      lockedArtifacts: [
        { name: "the PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" },
        { name: "drawer mockup", path: "mockups/drawer.png", kind: "mockup" },
      ],
    });
    // 只有 SPEC 批准有匹配的审计行（固定的 scope-approval audit_notes_json 结构）
    // -> plan.lock 已验证，delivered.lock 为 UNVERIFIED——可见，但绝不阻塞。
    db.prepare(
      `INSERT INTO mission_control_actions (action_id, action_verb, actor_session, acted_at, audit_notes_json)
       VALUES ('act-1', 'approve', 'planner@rig', '2026-07-03T00:00:00.000Z', ?)`,
    ).run(JSON.stringify({ kind: "scope-approval", scope_tier: "slice", scope_id: "OPR.T.26", scope_path: "release-t/slices/26-locks", approval_scope: "spec", on_behalf_of: null }));

    const body = await (await app.request("/api/review/slice/26-locks")).json();
    expect(body.plan.lock).toEqual({ by: "planner@rig", at: "2026-07-03T00:00:00.000Z", auditVerified: true });
    expect(body.delivered.lock).toEqual({ by: "human@host", at: "2026-07-04T00:00:00.000Z", auditVerified: false });
    expect(body.phase).toBe("locked");
    expect(body.plan.lockedArtifacts).toEqual([
      { name: "the PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" },
      { name: "drawer mockup", path: "mockups/drawer.png", kind: "mockup" },
    ]);
    expect(body.plan.concise.media).toContainEqual({ kind: "image", src: "mockups/drawer.png", caption: "mockups/drawer.png" });
  });

  it("重复组合时提供字节一致的响应（端到端幂等）", async () => {
    writeFixtureSlice(ws, "release-t", "22-idem", { intent: "i", prd: { miniReqs: ["m"] } });
    const a = await (await app.request("/api/review/slice/22-idem")).text();
    const b = await (await app.request("/api/review/slice/22-idem")).text();
    expect(a).toBe(b);
  });

  it("已关闭的历史 qitem 不会让分片看似仍在活跃构建", async () => {
    writeFixtureSlice(ws, "release-t", "22-closed-qitem", { intent: "i", prd: { miniReqs: ["m"] } });
    insertQitem({ id: "q-closed", dest: "dev-a@rig", tags: ["slice:22-closed-qitem"], summary: "old handoff", state: "closed" });

    const body = await (await app.request("/api/review/slice/22-closed-qitem")).json();
    expect(body.phase).toBe("spec");
    expect(body.agents.rows).toHaveLength(0);
  });

  it("任务台账无遗漏地重放追踪缺口场景", async () => {
    for (const n of ["s1", "s2", "s3"]) {
      const dir = writeFixtureSlice(ws, "release-gap", n, { intent: "i", prd: { miniReqs: ["m"] } });
      writeFullGateSet(dir, n, `cand-${n}`);
    }
    writeFixtureSlice(ws, "release-gap", "s4-inflight", { intent: "i", prd: { miniReqs: ["m"] } });

    const res = await app.request("/api/review/mission/release-gap");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ledger).toHaveLength(4);
    expect(body.ledger.filter((r: { green: boolean }) => r.green)).toHaveLength(3);
    expect(body.cutComplete).toBe(false); // green-but-unmerged is never cut-complete
    expect(body.cutCompleteBasis).toContain("尚未完成切入");
    expect(body.board).toHaveLength(4);
  });

  it("agents 范围投影：按分片界定成员关系，绝不按工作组共存关系", async () => {
    writeFixtureSlice(ws, "release-t", "23-agents", { intent: "i", prd: { miniReqs: ["m"] } });
    insertQitem({ id: "q1", dest: "dev-a@rig", tags: ["slice:23-agents"], summary: "building the thing" });
    insertQitem({ id: "q2", dest: "dev-b@rig", tags: ["slice:other-slice"], summary: "other work" });

    const res = await app.request("/api/review/agents?scope=slice:23-agents");
    expect(res.status).toBe(200);
    const band = await res.json();
    expect(band.rows).toHaveLength(1);
    expect(band.rows[0]).toMatchObject({ sessionName: "dev-a@rig", doing: "building the thing", holdsCount: 1, stateGlyph: "unknown" });

    const rig = await (await app.request("/api/review/agents?scope=rig")).json();
    expect(rig.rows.map((r: { sessionName: string }) => r.sessionName).sort()).toEqual(["dev-a@rig", "dev-b@rig"]);
  });

  it("校验三值 scope 参数", async () => {
    expect((await app.request("/api/review/agents?scope=pod:x")).status).toBe(400);
    expect((await app.request("/api/review/agents")).status).toBe(400);
    expect((await app.request("/api/review/agents?scope=slice:nope")).status).toBe(404);
  });

  it("路由给人工且带分片标签的 qitem 进入 NEEDS YOU，并携带 #6 行为方/目标成员", async () => {
    writeFixtureSlice(ws, "release-t", "24-needs", { intent: "i", prd: { miniReqs: ["m"] } });
    insertQitem({ id: "q-h", dest: "human-review@kernel", tags: ["slice:24-needs"], summary: "approve the cut", tier: "human-gate", state: "pending" });

    const body = await (await app.request("/api/review/slice/24-needs")).json();
    const item = body.needsYou.items.find((i: { qitemId: string | null }) => i.qitemId === "q-h");
    expect(item).toMatchObject({ summary: "approve the cut", destinationSession: "human-review@kernel", source: "agent" });
    expect(body.needsYou.provenance).toContain("根据 queue+artifacts 计算");
  });

  it("显示来源与 git 新鲜度事实均使用最后丢弃的候选项", async () => {
    const { repo, oldSha, newSha } = makeLineageRepo(ws.root);
    const dir = writeFixtureSlice(ws, "release-t", "24-lineage", { intent: "i", prd: { miniReqs: ["m"] } });
    writeProofArtifact(dir, {
      slice: "24-lineage",
      candidateSha: oldSha,
      artifactType: "qa",
      verdict: "PASS",
      fileName: "a-old.md",
      mtime: new Date("2026-07-04T10:00:00Z"),
    });
    writeProofArtifact(dir, {
      slice: "24-lineage",
      candidateSha: newSha,
      artifactType: "qa",
      verdict: "PASS",
      fileName: "z-new.md",
      mtime: new Date(Date.now() + 1000), // comparison deliberately later than the captured gate set
    });

    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: repo, now: () => NOW });
    const gitApp = new Hono();
    gitApp.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      await next();
    });
    gitApp.route("/api/review", reviewRoutes());

    const body = await (await gitApp.request("/api/review/slice/24-lineage")).json();
    expect(body.lineage.candidateSha).toBe(newSha);
    expect(body.lineage.freshness).toBe("fresh");
    expect(body.lineage.staleBehind).toBeNull();
  });

  it("未知分片和任务返回 404；已证空的 NEEDS YOU 携带来源", async () => {
    expect((await app.request("/api/review/slice/none")).status).toBe(404);
    expect((await app.request("/api/review/mission/none")).status).toBe(404);
    writeFixtureSlice(ws, "release-t", "25-empty", { intent: "i", prd: false });
    const body = await (await app.request("/api/review/slice/25-empty")).json();
    expect(body.phase).toBe("intent");
    expect(body.plan.concise.text).toBeNull(); // not specced — degrades, never synthesized
    expect(body.plan.ssotPath).toBeNull();
    expect(body.needsYou.provenance).toContain("0 个待关注项");
  });
});

// OPR.0.4.4.22——GET /api/review/rig（工作组范围的独立层级根）。
describe("GET /api/review/rig (OPR.0.4.4.22)", () => {
  let ws: FixtureWorkspace;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    ws = makeFixtureWorkspace();
    db = createDb(":memory:");
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      streamItemsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      missionControlActionsSchema,
      queueItemSummarySchema,
    ]);
    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      await next();
    });
    app.route("/api/review", reviewRoutes());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  });

  function insert(opts: {
    id: string;
    dest: string;
    state?: string;
    tags?: string[];
    summary?: string | null;
    tier?: string | null;
    tsUpdated?: string;
    closureRequiredAt?: string | null;
  }) {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, summary, closure_required_at)
       VALUES (?, ?, ?, 'src@r', ?, ?, 'high', ?, ?, 'body', ?, ?)`,
    ).run(
      opts.id,
      NOW,
      opts.tsUpdated ?? NOW,
      opts.dest,
      opts.state ?? "in-progress",
      opts.tier ?? null,
      JSON.stringify(opts.tags ?? []),
      opts.summary ?? null,
      opts.closureRequiredAt ?? null,
    );
  }

  function insertTransition(opts: { qitemId: string; ts: string; actor: string; closureReason?: string; closureTarget?: string }) {
    db.prepare(
      `INSERT INTO queue_transitions (qitem_id, ts, state, actor_session, closure_reason, closure_target)
       VALUES (?, ?, 'handed-off', ?, ?, ?)`,
    ).run(opts.qitemId, opts.ts, opts.actor, opts.closureReason ?? null, opts.closureTarget ?? null);
  }

  it("在单一根中组合 roster + park + health + settled；以 C6 摘要作为标签", async () => {
    insert({ id: "q-hold", dest: "driver@r", tags: ["slice:20-x"], summary: "building the follow-mode half" });
    insert({ id: "q-park", dest: "planner@r", state: "blocked", tags: ["slice:20-x"], summary: "waiting on your call", tier: "human-gate" });
    db.prepare("UPDATE queue_items SET blocked_on = 'human-review@kernel' WHERE qitem_id = 'q-park'").run();
    insertTransition({ qitemId: "q-done", ts: NOW, actor: "driver@r", closureReason: "handed_off_to", closureTarget: "qa@r" });

    const res = await app.request("/api/review/rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("rig");
    const sessions = body.agents.rows.map((r: { sessionName: string }) => r.sessionName);
    expect(sessions).toContain("driver@r");
    const driverRow = body.agents.rows.find((r: { sessionName: string }) => r.sessionName === "driver@r");
    expect(driverRow.doing).toBe("building the follow-mode half");
    // 此夹具没有活动中继 -> 如实为 unknown，绝不猜测。
    expect(driverRow.stateGlyph).toBe("unknown");
    // park 进入 NEEDS YOU。
    expect(body.needsYou.items.some((i: { summary: string }) => i.summary === "waiting on your call")).toBe(true);
    const parkedRow = body.agents.rows.find((r: { sessionName: string }) => r.sessionName === "planner@r");
    expect(parkedRow).toMatchObject({ stateGlyph: "parked", doing: "waiting on your call" });
    // Health + SETTLED 一致（使用相同转换查询）。
    expect(body.agents.coordinationHealth).toContain("今日 1 次交接");
    expect(body.settled).toHaveLength(1);
    expect(body.settled[0]).toMatchObject({ fromSession: "driver@r", toSession: "qa@r" });
  });

  it("将人工路由 qitem 保留在 NEEDS YOU 中，而不把人工席位变为 AGENTS 行", async () => {
    insert({ id: "q-human", dest: "human-review@kernel", tags: ["slice:20-x"], summary: "approve the demo", tier: "human-gate", state: "pending" });

    const body = await (await app.request("/api/review/rig")).json();
    expect(body.needsYou.items.some((i: { qitemId: string | null }) => i.qitemId === "q-human")).toBe(true);
    expect(body.agents.rows.some((r: { sessionName: string }) => r.sessionName === "human-review@kernel")).toBe(false);
  });

  it("近期持有：分片标签条目在今天关闭的 agent 显示为“无已追踪工作项”", async () => {
    insert({ id: "q-closed", dest: "qa1@r", state: "done", tags: ["slice:20-x"], summary: "done work", tsUpdated: NOW });
    const res = await app.request("/api/review/rig");
    const body = await res.json();
    const row = body.agents.rows.find((r: { sessionName: string }) => r.sessionName === "qa1@r");
    expect(row).toBeDefined();
    expect(row.doing).toBe("没有已跟踪的工作项");
    expect(row.holdsCount).toBe(0);
  });

  it("非人工且逾期的进行中分片工作呈现为派生 NEEDS YOU 异常及健康计数", async () => {
    insert({
      id: "q-overdue",
      dest: "driver@r",
      tags: ["slice:20-x"],
      summary: "late handoff",
      closureRequiredAt: "2026-07-04T11:00:00.000Z",
    });

    const res = await app.request("/api/review/rig");
    const body = await res.json();
    expect(body.agents.coordinationHealth).toContain("1 个逾期");
    const overdue = body.needsYou.items.find((i: { derived?: { kind: string } | null; qitemId: string | null }) => i.qitemId === null && i.derived?.kind === "overdue");
    expect(overdue).toMatchObject({ summary: "late handoff 已逾期", where: "rig" });
  });

  it("活动遥测使用 composer 时钟 + 事件时间，使有工作但空闲的证明保持稳定", async () => {
    insert({ id: "q-idle", dest: "driver@r", tags: ["slice:20-x"], summary: "holding work while idle" });
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig-one')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-1', 'rig-1', 'driver', 'codex')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('sess-1', 'node-1', 'driver@r', 'running', ?)").run(NOW);
    const eventBus = new EventBus(db);
    eventBus.emit({
      type: "agent.activity",
      rigId: "rig-1",
      nodeId: "node-1",
      sessionName: "driver@r",
      runtime: "codex",
      activity: {
        state: "idle",
        reason: "idle_prompt",
        evidenceSource: "runtime_hook",
        sampledAt: "2026-07-04T11:13:00.000Z",
        evidence: "idle_prompt",
        eventAt: "2026-07-04T11:13:00.000Z",
        fallback: false,
        stale: false,
      },
    });
    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const activityStore = new AgentActivityStore({
      db,
      eventBus,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      freshnessMs: 10 * 365 * 24 * 60 * 60 * 1000,
    });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, activityStore, now: () => NOW });
    const activityApp = new Hono();
    activityApp.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      await next();
    });
    activityApp.route("/api/review", reviewRoutes());

    const a = await (await activityApp.request("/api/review/rig")).json();
    const b = await (await activityApp.request("/api/review/rig")).json();
    const row = a.agents.rows.find((r: { sessionName: string }) => r.sessionName === "driver@r");
    expect(row).toMatchObject({ stateGlyph: "idle", runtime: "codex" });
    expect(row.exception).toMatchObject({ kind: "stuck", evidence: "空闲 47m >= 默认值 30m · 持有 1" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("已证空工作组以显示窗口渲染来源，绝不留白", async () => {
    const res = await app.request("/api/review/rig");
    const body = await res.json();
    expect(body.agents.rows).toHaveLength(0);
    expect(body.agents.provenance).toContain("窗口：today");
    expect(body.settledProvenance).toContain("今日 0 次交接");
  });

  it("幂等：对未变输入发起两次请求，返回字节一致的正文", async () => {
    insert({ id: "q-1", dest: "a@r", tags: ["slice:s"], summary: "s" });
    const a = await (await app.request("/api/review/rig")).text();
    const b = await (await app.request("/api/review/rig")).text();
    expect(a).toBe(b);
  });

  it("composer 未接线时返回 503（如实报错，而非空结果）", async () => {
    const bare = new Hono();
    bare.route("/api/review", reviewRoutes());
    const res = await bare.request("/api/review/rig");
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// qitem-ccf87c0d 修订门禁——composeMission 复合操作负载契约。在 75245ed6 上，
// composeMission 先运行一次冷 list()（一批 2 次扫描），再针对每个未缓存任务分片运行一次
// gatherSlice()->indexer.get()（每项又一批 2 次扫描）：2 + 2N 次成员扫描——40 个分片时为 82 次
//（由 guard 复现；精确清单是总计 204 次队列读取，其中 82 次为成员扫描——见下方 matcher 文档）。
// 契约：一次任务组合只执行常数次成员扫描。
// ---------------------------------------------------------------------------

describe("qitem-ccf87c0d——composeMission 成员扫描负载契约", () => {
  /** 计算成员扫描结构的执行次数（.all/.iterate/.get）——这是批处理/范围修复负责的语句类别，
   *  按具名结构计数（guard 审计轨迹；40 分片/1 行时的清单：修复前两种结构为 41+41=82，
   *  正是 2+2N 回归；其余 122 次队列读取是原有 Review 投影——82 次 attention/agent 投影读取、
   *  40 次 hasActiveQitem `state IN … AND tags LIKE ?`——它们存在于父提交 7b19b73e，且锁定修复
   *  不触及它们，因此计入会使范围内的常数扫描契约无法满足）：
   *    (a) 类型化成员扫描——tags LIKE '%slice:%'
   *    (b) 批量回退扫描——FROM queue_items 且没有 WHERE 子句
   *    (c) 旧逐分片层级——WHERE tags LIKE ? ORDER BY / body LIKE ?
   *  INSERT 种子写入和主键点查（WHERE qitem_id IN）直接放行。 */
  function instrumentMembershipScans(target: Database.Database): () => number {
    let n = 0;
    const origPrepare = target.prepare.bind(target);
    (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const flat = sql.replace(/\s+/g, " ");
      const isMembershipScan = /from queue_items/i.test(flat)
        && !/^\s*insert/i.test(flat)
        && (
          /tags LIKE '%slice:%'/i.test(flat)
          || !/ where /i.test(flat)
          || /where tags like \? order by/i.test(flat)
          || /where body like \?/i.test(flat)
        );
      if (!isMembershipScan) return stmt;
      return {
        all: (...a: unknown[]) => { n++; return stmt.all!(...a); },
        iterate: (...a: unknown[]) => { n++; return stmt.iterate!(...a); },
        get: (...a: unknown[]) => { n++; return stmt.get!(...a); },
        run: (...a: unknown[]) => stmt.run!(...a),
      };
    };
    return () => n;
  }

  it("对 40 个已索引分片执行一次 composeMission，成员队列扫描不超过 4 次且组合全部 40 个台账条目", () => {
    const db = createDb();
    migrate(db, [
      coreSchema, bindingsSessionsSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema,
      queueItemSummarySchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-load', 'rig')`).run();
    // Guard 复现结构：恰好一条队列行（不匹配任何分片，因此不会触发逐分片 IN 查询——
    // 该计数可隔离扫描类别）。
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-lone', '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:00.000Z', 'a@r', 'b@r', 'done', 'routine', 'fixture')`,
    ).run();
    const ws = makeFixtureWorkspace();
    for (let i = 0; i < 40; i++) {
      writeFixtureSlice(ws, "load-mission", `ld-${String(i).padStart(2, "0")}-topic`, {});
    }
    const indexer = new SliceIndexer({ slicesRoot: ws.root, dogfoodEvidenceRoot: null, db });
    const scans = instrumentMembershipScans(db);
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    const composed = gatherer.composeMission("load-mission");
    expect(composed).toBeTruthy();
    expect(composed!.ledger).toHaveLength(40); // semantic: every slice composed
    // 75245ed6 修复前：2（冷 list 批次）+ 40x2（每个未缓存 gatherSlice get 一批）
    // = 82 次成员扫描。契约要求：常数。
    expect(scans()).toBeLessThanOrEqual(4);
    db.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  });
});
