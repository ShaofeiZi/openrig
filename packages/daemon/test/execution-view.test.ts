// S27（OPR.0.5.6.27）——execution-view proof fixture，RED-first。
//
// base 为 RED：下方每个测试都因 ViewProjectorError view_not_found 失败——
// “view 'execution' is not registered”——因为 base 中不存在该 view（proof contract 固定的原因）。
// GREEN 会落地 built-in view。
//
// fixture 建模契约的 acceptance shape：两条 lane（一个 EC-3 baton 携带
// worktree_path=<real tmp git worktree>，一个 legacy baton 不携带）、一个 armed wake 的 parked row、
// 通过真实临时 git repo 区分 candidate built-but-unfolded / folded-but-unadopted、一个 wave-map-v1
// data row，以及携带 EC-1 depends_on + approved-spec-dial 的 slice frontmatter。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionWakesSchema } from "../src/db/migrations/073_queue_transition_wakes.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector, ViewProjectorError } from "../src/domain/view-projector.js";
import { Hono } from "hono";
import { viewsRoutes } from "../src/routes/views.js";

const MISSION = "release-9.9";
const SEAT_A = "builder-a@exec-fixture";
const SEAT_B = "builder-b@exec-fixture";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function writeSpec(root: string, dir: string, frontmatter: string, body: string): string {
  const d = path.join(root, MISSION, "slices", dir);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, "SPEC.md");
  fs.writeFileSync(p, `---\n${frontmatter}\n---\n\n${body}\n`);
  return p;
}

describe("execution view——S27（OPR.0.5.6.27）", () => {
  let db: Database.Database;
  let projector: ViewProjector;
  let tmp: string;
  let missionsRoot: string;
  let rigsRoot: string;
  let repoDir: string;
  let laneWorktree: string;
  let candidateSha: string;
  let branchName: string;
  let fixedNow: Date;
  // 唯一 activity oracle（S19 锁定契约）：SeatActivityService 经仲裁且按 seat 索引的 read，按
  // session fake。Q1/Q6 使用此来源——绝不使用 sessions.status，也绝不使用并行 AgentActivityStore
  // ingest。
  let arbitratedBySession: Map<
    string,
    { activity: "working" | "idle-at-prompt" | "unknown"; needsInput: { count: number; reason: string | null }; decidedBy: string | null; changedAt: string }
  >;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exec-view-"));
    missionsRoot = path.join(tmp, "missions");
    rigsRoot = path.join(tmp, "rigs");
    fixedNow = new Date("2026-08-29T22:00:00.000Z");

    // ---- 临时 git repo：candidate = 第一个 commit（main tip 的 ancestor）----
    repoDir = path.join(tmp, "repo");
    fs.mkdirSync(repoDir);
    git(repoDir, "init", "-q", "-b", "main");
    git(repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base");
    candidateSha = git(repoDir, "rev-parse", "HEAD");
    git(repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "tip");
    branchName = "lane-31";
    laneWorktree = path.join(tmp, "wt-lane31");
    git(repoDir, "worktree", "add", "-q", "-b", branchName, laneWorktree, "HEAD");

    // ---- slice fixture（存在 EC-1 字段；33 特意缺少）----
    writeSpec(
      missionsRoot,
      "31-alpha",
      [
        "id: OPR.9.9.31",
        "slice: 31-alpha",
        `mission: ${MISSION}`,
        "approved-spec-at: 2026-08-29T00:00:00.000Z",
        "approved-spec-by: desk@exec-fixture",
        "approved-spec-dial: P1",
        "depends_on: []",
      ].join("\n"),
      "## Intent\nalpha\n\n## Territory\nWRITES: x.\n",
    );
    writeSpec(
      missionsRoot,
      "32-beta",
      [
        "id: OPR.9.9.32",
        "slice: 32-beta",
        `mission: ${MISSION}`,
        "approved-spec-at: 2026-08-29T00:00:00.000Z",
        "approved-spec-dial: P2",
        'depends_on: ["OPR.9.9.31"]',
      ].join("\n"),
      "## Intent\nbeta\n\n## Territory\nWRITES: y.\n\nSOFT-AFTER: [OPR.9.9.31] — serialization fixture\n",
    );
    writeSpec(
      missionsRoot,
      "33-gamma",
      ["id: OPR.9.9.33", "slice: 33-gamma", `mission: ${MISSION}`].join("\n"),
      "## Intent\ngamma (no EC-1 fields — the INDETERMINATE arm)\n",
    );
    const missionDir = path.join(missionsRoot, MISSION);
    fs.writeFileSync(
      path.join(missionDir, "SPEC.md"),
      "---\nid: OPR.9.9\nmission: release-9.9\n---\n\n# Fixture mission\n",
    );
    fs.writeFileSync(path.join(missionDir, "mission.yaml"), [
      "schema: openrig.mission/v0alpha1",
      "kind: mission",
      "composition:",
      "  slices:",
      "    - { ref: slices/31-alpha/slice.yaml, order: 10, active: true }",
      "    - { ref: slices/32-beta/slice.yaml, order: 20, active: true }",
      "arrangement:",
      "  waves:",
      "    - id: WA",
      "      lanes:",
      "        dev: [OPR.9.9.31, OPR.9.9.32]",
      "      review_model: author-excluded-r1-r2-wave",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(missionDir, "slices", "31-alpha", "slice.yaml"), [
      "schema: openrig.slice/v0alpha1",
      "kind: slice",
      "execution:",
      "  wave: WA",
      "  depends_on: []",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(missionDir, "slices", "32-beta", "slice.yaml"), [
      "schema: openrig.slice/v0alpha1",
      "kind: slice",
      "execution:",
      "  wave: WA",
      "  depends_on: [OPR.9.9.31]",
      "",
    ].join("\n"));

    // ---- slice 31 的 review-artifact registry fixture ----
    const reviewDir = path.join(rigsRoot, "exec-fixture", "state", "review-fixture");
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir, "S31-verdict.md"),
      `---\nslice: 31-alpha\nartifact_type: rev1-r2\nverdict: CLEAR\ncandidate_sha: ${candidateSha}\n---\nCLEAR at fixture.\n`,
    );

    // ---- db ----
    db = createDb();
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      queueItemsSchema,
      queueItemSummarySchema,
      queueTransitionsSchema,
      queueTransitionWakesSchema,
      viewsCustomSchema,
    ]);
    const bus = new EventBus(db);
    projector = new ViewProjector(db, bus);
    arbitratedBySession = new Map([
      [SEAT_A, { activity: "working", needsInput: { count: 0, reason: null }, decidedBy: "self-report", changedAt: "2026-08-29T21:59:00.000Z" }],
      [SEAT_B, { activity: "working", needsInput: { count: 0, reason: null }, decidedBy: "lifecycle-hooks", changedAt: "2026-08-29T21:59:00.000Z" }],
    ]);
    // optional call：base 中不存在该 method——RED 因而落在带固定 view_not_found 的
    // show("execution") 上，而不是接线上。
    (projector as unknown as { setExecutionDeps?: (d: unknown) => void }).setExecutionDeps?.({
      db,
      slicesRoot: () => missionsRoot,
      rigsRoot: () => rigsRoot,
      buildInfo: { semver: null, commit: null, dirty: null, builtAt: null },
      now: () => fixedNow,
      seatActivity: {
        getSeatStateBySession: (sessionName: string) => arbitratedBySession.get(sessionName) ?? null,
      },
    });

    const insertRow = db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session,
                                state, priority, tier, tags, body, claimed_at, last_heartbeat, blocked_on)
       VALUES (?, ?, ?, ?, ?, ?, 'normal', 'light', ?, ?, ?, NULL, ?)`,
    );
    const t0 = "2026-08-29T21:00:00.000Z";
    // Lane 1——EC-3 baton：body 上的 worktree_path 字段。
    insertRow.run(
      "qitem-lane-31", t0, t0, "lead@exec-fixture", SEAT_A, "in-progress",
      // Production shape：queue candidate tag 通常为缩写。
      JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.31", `candidate:${candidateSha.slice(0, 9)}`]),
      `Build 31.\nworktree_path=${laneWorktree}\n`, t0, null,
    );
    // Lane 2——legacy baton：无 worktree_path（fragile join）。
    insertRow.run(
      "qitem-lane-32", t0, t0, "lead@exec-fixture", SEAT_B, "in-progress",
      JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.32"]),
      "Build 32 (legacy baton).", t0, null,
    );
    // 带 armed wake 的 parked row。
    insertRow.run(
      "qitem-parked-33", t0, t0, "lead@exec-fixture", SEAT_B, "blocked",
      JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.33"]),
      "Parked on a real blocker.", t0, "qitem-blocker-x",
    );
    db.prepare(
      `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, transition_note, actor_session)
       VALUES (31001, 'qitem-parked-33', ?, 'blocked', 'parked', 'lead@exec-fixture')`,
    ).run(t0);
    db.prepare(
      `INSERT INTO queue_transition_wakes (transition_id, qitem_id, phase, wake_kind, wake_ref)
       VALUES (31001, 'qitem-parked-33', 'armed', 'timer', 'wake-timer-33')`,
    ).run();
    // Wave map data row（EC-2）。
    insertRow.run(
      "qitem-wave-map", t0, t0, "lead@exec-fixture", "lead@exec-fixture", "done",
      JSON.stringify([`mission:${MISSION}`, "wave-map", "format:wave-map-v1"]),
      'Wave map.\n```json\n{"format":"wave-map-v1","mission":"release-9.9","waves":[{"id":"WA","slices":["OPR.9.9.31","OPR.9.9.32"],"serialized_order":["OPR.9.9.31","OPR.9.9.32"],"review_model":"author-excluded-r1-r2-wave"}]}\n```\n',
      null, null,
    );
    // Session：两个 seat 都存在且 running（nodes/rigs row 满足 FK）。
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('rig-x', 'exec-fixture')`).run();
    const insertNode = db.prepare(`INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, 'rig-x', ?)`);
    insertNode.run("n-a", "builder-a");
    insertNode.run("n-b", "builder-b");
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertSession.run("s-a", "n-a", SEAT_A, "running", t0, t0);
    insertSession.run("s-b", "n-b", SEAT_B, "running", t0, t0);
  });

  afterEach(() => {
    try {
      git(repoDir, "worktree", "remove", "--force", laneWorktree);
    } catch { /* fixture teardown best-effort */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  function show(): Record<string, unknown> {
    const result = projector.show("execution", { mission: MISSION });
    expect(result.rowCount).toBe(1);
    return result.rows[0] as Record<string, unknown>;
  }

  it("通过对 fixture 工作组的一次 read 回答六个问题（base 为 RED：view 不存在）", () => {
    const doc = show();
    expect(doc.view).toBe("execution");
    expect(doc.mission).toBe(MISSION);
    for (const key of ["q1_lanes", "q2_sequencing", "q3_care", "q4_ladder", "q5_park", "q6_parallelism"]) {
      expect(doc, `six-question bar: ${key} present`).toHaveProperty(key);
    }
    const lanes = doc.q1_lanes as Record<string, unknown>[];
    expect(lanes.map((l) => l.slice).sort()).toEqual(["OPR.9.9.31", "OPR.9.9.32"]);
    const q6 = doc.q6_parallelism as Record<string, unknown>;
    expect(q6.lanes_live).toBe(2);
  });

  it("优先默认选择有真实 in-progress work 的 mission，而非更新的 planned release directory", () => {
    fs.mkdirSync(path.join(missionsRoot, "release-10.0", "slices"), { recursive: true });
    const result = projector.show("execution");
    expect((result.rows[0] as Record<string, unknown>).mission).toBe(MISSION);
  });

  it("在 newer-directory fallback 前接受 active row 上唯一的 body-only mission", () => {
    fs.mkdirSync(path.join(missionsRoot, "release-10.0", "slices"), { recursive: true });
    db.prepare(`UPDATE queue_items SET state = 'done' WHERE qitem_id = 'qitem-lane-32'`).run();
    db.prepare(`UPDATE queue_items SET tags = ?, body = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      JSON.stringify(["gate:qa"]),
      `Mission: ${MISSION}\nSlice: OPR.9.9.31\nworktree_path=${laneWorktree}\n`,
    );
    const result = projector.show("execution");
    const doc = result.rows[0] as Record<string, unknown>;
    expect(doc.mission).toBe(MISSION);
    expect((doc.q1_lanes as Record<string, unknown>[]).map((lane) => lane.slice)).toContain("OPR.9.9.31");
  });

  it("选择 directory 形式时包含带 legacy id-form mission tag 的 lane", () => {
    db.prepare(`UPDATE queue_items SET tags = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      JSON.stringify(["mission:OPR.9.9", "slice:OPR.9.9.31", `candidate:${candidateSha.slice(0, 9)}`]),
    );
    db.prepare(`UPDATE queue_items SET tags = ? WHERE qitem_id = 'qitem-wave-map'`).run(
      JSON.stringify(["mission:OPR.9.9", "wave-map", "format:wave-map-v1"]),
    );
    const doc = show();
    expect((doc.q1_lanes as Record<string, unknown>[]).map((lane) => lane.qitem_id)).toContain("qitem-lane-31");
    expect(((doc.sources as Record<string, Record<string, unknown>>).wave_map).row).toBe("qitem-wave-map");
  });

  it("将 active legacy id-form mission tag 默认映射到 canonical mission directory", () => {
    fs.mkdirSync(path.join(missionsRoot, "release-10.0", "slices"), { recursive: true });
    db.prepare(`UPDATE queue_items SET state = 'done' WHERE qitem_id = 'qitem-lane-32'`).run();
    db.prepare(`UPDATE queue_items SET tags = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      JSON.stringify(["mission:OPR.9.9", "slice:OPR.9.9.31", `candidate:${candidateSha.slice(0, 9)}`]),
    );
    const result = projector.show("execution");
    const doc = result.rows[0] as Record<string, unknown>;
    expect(doc.mission).toBe(MISSION);
    expect((doc.q1_lanes as Record<string, unknown>[]).map((lane) => lane.qitem_id)).toContain("qitem-lane-31");
  });

  it("将 planned component 与当前 queue ownership 分开携带，包括 waiting 与 handoff", () => {
    const file = path.join(missionsRoot, MISSION, "slices", "31-alpha", "slice.yaml");
    fs.appendFileSync(file, "sdlc:\n  components:\n    - { id: build.minimal-gap, owner: planned@fixture }\n");
    const read = () => (show().q2_sequencing as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect(read().planned_owners).toEqual([{ component: "build.minimal-gap", owner: "planned@fixture", source: fs.realpathSync(file) + "#sdlc.components[0].owner" }]);
    expect(read().work_rows).toEqual(expect.arrayContaining([expect.objectContaining({ qitem_id: "qitem-lane-31", seat: SEAT_A, state: "in-progress" })]));
    db.prepare("UPDATE queue_items SET state='blocked', blocked_on='external:review' WHERE qitem_id='qitem-lane-31'").run();
    expect(read().work_rows).toEqual(expect.arrayContaining([expect.objectContaining({ seat: SEAT_A, state: "blocked", blocked_on: "external:review" })]));
    db.prepare("UPDATE queue_items SET state='handed-off' WHERE qitem_id='qitem-lane-31'").run();
    expect((read().work_rows as Record<string, unknown>[]).some(w => w.qitem_id === "qitem-lane-31")).toBe(false);
    expect(read().planned_owners).toHaveLength(1);
  });

  it("EC-3：worktree_path 字段是 Q1 join key；legacy baton 回退并标记为 fragile", () => {
    const doc = show();
    const lanes = doc.q1_lanes as Record<string, unknown>[];
    const ec3 = lanes.find((l) => l.slice === "OPR.9.9.31")!;
    expect(ec3.worktree_path).toBe(laneWorktree);
    expect(ec3.fragile_join).toBe(false);
    expect(ec3.branch).toBe(branchName);
    expect(ec3.head_sha).toBe(git(laneWorktree, "rev-parse", "HEAD"));
    const legacy = lanes.find((l) => l.slice === "OPR.9.9.32")!;
    expect(legacy.fragile_join).toBe(true);
    expect(legacy.worktree_path).toBe("INDETERMINATE");
    expect(String(legacy.join_basis)).toContain("缺少 EC-3 字段");
  });

  it("EC-2：Q3 只从 row/frontmatter data 派生 {build_wave, review_model, planning_dial}，并引用 wave-map row", () => {
    const doc = show();
    const q3 = doc.q3_care as Record<string, unknown>[];
    const s31 = q3.find((s) => s.slice_id === "OPR.9.9.31")!;
    expect(s31.build_wave).toBe("WA");
    expect(s31.review_model).toBe("author-excluded-r1-r2-wave");
    expect(s31.planning_dial).toBe("P1");
    expect((s31.source as Record<string, unknown>).wave_map_row).toBe("qitem-wave-map");
    // no-data 分支下限为 INDETERMINATE，绝不猜测。
    const s33 = q3.find((s) => s.slice_id === "OPR.9.9.33")!;
    expect(s33.build_wave).toBe("INDETERMINATE");
    expect(s33.planning_dial).toBe("INDETERMINATE");
  });

  it("将 mission/slice YAML 提升到 parity-matched legacy wave map 之前，并点名 superseded authority", () => {
    const doc = show();
    const q2 = doc.q2_sequencing as Record<string, unknown>[];
    expect((q2.find((s) => s.slice_id === "OPR.9.9.31")?.source as Record<string, unknown>).arrangement_path)
      .toContain("31-alpha/slice.yaml");
    expect(q2.find((s) => s.slice_id === "OPR.9.9.32")?.depends_on).toEqual(["OPR.9.9.31"]);
    const q3 = doc.q3_care as Record<string, unknown>[];
    expect(q3.find((s) => s.slice_id === "OPR.9.9.31")?.build_wave).toBe("WA");
    const sources = doc.sources as Record<string, Record<string, unknown>>;
    expect(String(sources.arrangement?.basis)).toContain("mission.yaml");
    expect(String(sources.wave_map?.superseded_by)).toContain("mission.yaml");
    fs.unlinkSync(path.join(missionsRoot, MISSION, "mission.yaml"));
    const legacy = show();
    const comparableQ2 = (value: Record<string, unknown>) => (value.q2_sequencing as Record<string, unknown>[]).map((item) => ({
      slice_id: item.slice_id,
      depends_on: item.depends_on,
    }));
    const comparableQ3 = (value: Record<string, unknown>) => (value.q3_care as Record<string, unknown>[]).map((item) => ({
      slice_id: item.slice_id,
      build_wave: item.build_wave,
      review_model: item.review_model,
    }));
    expect(comparableQ2(doc)).toEqual(comparableQ2(legacy));
    expect(comparableQ3(doc)).toEqual(comparableQ3(legacy));
  });

  it("返回当前 authored admission 与 partial-core guidance，不从 prose 派生 edge 或 acceptance", () => {
    const before = show();
    const manifest = path.join(missionsRoot, MISSION, "mission.yaml");
    fs.appendFileSync(manifest, "  source:\n    rule: Alpha core accepted; full contract remains open.\n");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace(
      "      review_model: author-excluded-r1-r2-wave",
      "      review_model: author-excluded-r1-r2-wave\n      admission: Investigate beta early; implement alpha first.\n      review: Independently judge changed consequences.\n      exit: Both full contracts need the shared journey.",
    ));
    const current = show();
    expect(current.planning_guidance).toEqual(expect.arrayContaining([
      { label: "集成决策", text: "Alpha core accepted; full contract remains open.", source: manifest + "#arrangement.source.rule" },
      { label: "准入", text: "Investigate beta early; implement alpha first.", source: manifest + "#arrangement.waves[0].admission", wave: "WA" },
    ]));
    for (const key of ["q1_lanes", "q2_sequencing", "q3_care", "q4_ladder", "readiness"])
      expect(current[key]).toEqual(before[key]);
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace("Investigate beta early; implement alpha first.", "Defer beta pending the owning decision."));
    expect(JSON.stringify(show().planning_guidance)).toContain("Defer beta pending the owning decision.");
    fs.writeFileSync(manifest, "composition: [invalid");
    expect(show().planning_guidance).toEqual([]);
  });

  it("malformed YAML 输出一个具名 warning cell，并回退到 legacy arrangement 而不清空 view", () => {
    fs.writeFileSync(path.join(missionsRoot, MISSION, "mission.yaml"), "composition: [not: valid");
    const doc = show();
    const q3 = doc.q3_care as Record<string, unknown>[];
    expect(q3.find((s) => s.slice_id === "OPR.9.9.31")?.build_wave).toBe("WA");
    expect(doc.q1_lanes).toBeInstanceOf(Array);
    const arrangement = (doc.sources as Record<string, Record<string, unknown>>).arrangement;
    expect(arrangement.value).toBe("INDETERMINATE");
    expect(String(arrangement.basis)).toMatch(/mission\.yaml[\s\S]*回退/i);
  });

  it("可选 YAML 缺失时静默回退到 legacy arrangement", () => {
    fs.unlinkSync(path.join(missionsRoot, MISSION, "mission.yaml"));
    const doc = show();
    const q3 = doc.q3_care as Record<string, unknown>[];
    expect(q3.find((s) => s.slice_id === "OPR.9.9.31")?.build_wave).toBe("WA");
    expect(JSON.stringify(doc.sources)).not.toMatch(/missing mission\.yaml/i);
  });

  it("Q2：EC-1 frontmatter edge + SOFT-AFTER line + blocked row 派生 sequencing；缺少 EC-1 时下限为 INDETERMINATE", () => {
    const doc = show();
    const q2 = doc.q2_sequencing as Record<string, unknown>[];
    const s32 = q2.find((s) => s.slice_id === "OPR.9.9.32")!;
    expect(s32.depends_on).toEqual(["OPR.9.9.31"]);
    expect(s32.soft_after).toEqual(["OPR.9.9.31"]);
    const s33 = q2.find((s) => s.slice_id === "OPR.9.9.33")!;
    expect(s33.depends_on).toBe("INDETERMINATE");
    expect(s33.next_up).toBe("INDETERMINATE");
    expect(String(s33.next_up_basis)).toContain("EC-1");
  });

  it("ladder 诚实性：folded 在 read 时从 git 派生；adopted 在 dev daemon 上下限为 INDETERMINATE；不存在 done boolean", () => {
    const doc = show();
    const q4 = doc.q4_ladder as Record<string, unknown>[];
    const s31 = q4.find((s) => s.slice_id === "OPR.9.9.31")!;
    expect((s31.locked as Record<string, unknown>).value).toBe(true);
    // built rung 携带 tag 自身的缩写 token 与由 commit 解析的 identity。
    expect((s31.built as Record<string, unknown>).candidate_sha).toBe(candidateSha.slice(0, 9));
    expect((s31.built as Record<string, unknown>).resolved_commit).toBe(candidateSha);
    const folded = s31.folded as Record<string, unknown>;
    expect(folded.value).toBe(true);
    expect(String(folded.basis)).toContain("merge-base --is-ancestor");
    const adopted = s31.adopted as Record<string, unknown>;
    expect(adopted.value).toBe("INDETERMINATE");
    expect(String(adopted.basis)).toContain("开发运行");
    const reviewed = s31.reviewed as Record<string, unknown>;
    expect(reviewed.value).toBe(true);
    expect((reviewed.legs as Record<string, unknown>[])[0].verdict).toBe("CLEAR");
    // schema 明确禁止单一 boolean "done"。
    for (const entry of q4) {
      expect(Object.keys(entry)).not.toContain("done");
    }
  });

  it("Q1 使用仲裁后的 seat state（working）：superseded/stale-hook 样本无法复现", () => {
    // HOLD 的 live 样本：sessions.status 为 superseded，parallel ingest store 有 stale hook，
    // 而 arbitration 判为 working。Q1 必须显示 working。
    db.prepare(`UPDATE sessions SET status = 'superseded' WHERE session_name = ?`).run(SEAT_A);
    const doc = show();
    const lane = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!;
    const act = lane.activity as Record<string, unknown>;
    expect(act.activity).toBe("working");
    expect(String(act.source)).toContain("仲裁");
    expect(act.decided_by).toBe("self-report");
  });

  it("Q1 原样传递 canonical vocabulary 中的 idle-at-prompt 与 unknown，仅对从未见过的 seat 下限为 INDETERMINATE", () => {
    arbitratedBySession.set(SEAT_A, { activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "window-sampling", changedAt: "2026-08-29T21:59:10.000Z" });
    const idle = show();
    expect(((idle.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("idle-at-prompt");
    // 'unknown' 是 arbitrated vocabulary 的 canonical member——原样传递，绝不重写为 INDETERMINATE。
    arbitratedBySession.set(SEAT_A, { activity: "unknown", needsInput: { count: 0, reason: null }, decidedBy: null, changedAt: "2026-08-29T21:59:20.000Z" });
    const unk = show();
    expect(((unk.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("unknown");
    // INDETERMINATE 仅用于完全没有 arbitrated answer。
    arbitratedBySession.delete(SEAT_A);
    const gone = show();
    expect(((gone.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("INDETERMINATE");
  });

  it("Q1 单独携带 needsInput——count 与 reason 与 activity 并列，绝不折叠进去", () => {
    arbitratedBySession.set(SEAT_A, {
      activity: "working",
      needsInput: { count: 1, reason: "permission prompt" },
      decidedBy: "needs-input-chrome",
      changedAt: "2026-08-29T21:59:30.000Z",
    });
    const doc = show();
    const act = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>;
    expect(act.activity).toBe("working");
    expect((act.needs_input as Record<string, unknown>).count).toBe(1);
    expect((act.needs_input as Record<string, unknown>).reason).toBe("permission prompt");
  });

  it("Q6 idle capacity 统计经仲裁且无 needsInput 的 idle-at-prompt seat，而非 sessions.status", () => {
    // Seat C：arbitration 判为 idle-at-prompt，未持有 row——sessions.status 特意设为 superseded，
    // 因而任何 status approximation 都会计为 0。
    const t0 = "2026-08-29T21:00:00.000Z";
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-c', 'rig-x', 'builder-c')`).run();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, last_seen_at, created_at) VALUES ('s-c', 'n-c', 'builder-c@exec-fixture', 'superseded', ?, ?)`,
    ).run(t0, t0);
    arbitratedBySession.set("builder-c@exec-fixture", { activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "window-sampling", changedAt: "2026-08-29T21:59:00.000Z" });
    // needs-input seat 即使 idle at prompt 也不算 capacity。
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-d', 'rig-x', 'builder-d')`).run();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, last_seen_at, created_at) VALUES ('s-d', 'n-d', 'builder-d@exec-fixture', 'running', ?, ?)`,
    ).run(t0, t0);
    arbitratedBySession.set("builder-d@exec-fixture", { activity: "idle-at-prompt", needsInput: { count: 1, reason: "usage limit" }, decidedBy: "needs-input-chrome", changedAt: "2026-08-29T21:59:00.000Z" });
    const doc = show();
    const idle = (doc.q6_parallelism as Record<string, unknown>).idle_seats_with_capacity as Record<string, unknown>;
    expect(idle.value).toBe(1);
    expect(String(idle.basis)).toContain("仲裁");
  });

  it("Q4 按 commit identity 连接 candidate FORM：缩写 built tag 匹配 full/annotated artifact；off-sha、malformed、无法解析 input 诚实降级", () => {
    const reviewDir = path.join(rigsRoot, "exec-fixture", "state", "review-fixture");
    // The S20 production specimen: an ANNOTATED artifact form at the same commit.
    fs.writeFileSync(
      path.join(reviewDir, "S31-annotated.md"),
      `---\nslice: 31-alpha\nartifact_type: rev1-r1\nverdict: CLEAR\ncandidate_sha: ${candidateSha.slice(0, 9)} (exact tip over base 0f0f0f0f0 == refs/heads/main)\n---\nCLEAR, annotated form.\n`,
    );
    // An old BLOCKING artifact at a DIFFERENT (non-resolving here) candidate must
    // neither clear nor poison the at-commit verdict.
    fs.writeFileSync(
      path.join(reviewDir, "S31-old-hold.md"),
      `---\nslice: 31-alpha\nartifact_type: rev1-r1\nverdict: BLOCKING\ncandidate_sha: 0000000000000000000000000000000000000000\n---\nHOLD at a dead candidate.\n`,
    );
    // Malformed input floors honestly (excluded with a basis, never matched).
    fs.writeFileSync(
      path.join(reviewDir, "S31-malformed.md"),
      `---\nslice: 31-alpha\nartifact_type: rev1-r2\nverdict: BLOCKING\ncandidate_sha: not-a-sha\n---\nMalformed candidate field.\n`,
    );
    const doc = show();
    const q4 = doc.q4_ladder as Record<string, unknown>[];
    const s31 = q4.find((s) => s.slice_id === "OPR.9.9.31")!;
    const reviewed = s31.reviewed as Record<string, unknown>;
    // The built tag is abbreviated; the fixture's original artifact is FULL-sha;
    // the annotated one resolves to the same commit — both join, nothing else.
    expect(reviewed.value).toBe(true);
    expect((reviewed.legs as Record<string, unknown>[]).length).toBe(2);
    expect(String(reviewed.basis)).toContain("commit");
    // No built candidate => no commit to scope to => INDETERMINATE, never a verdict.
    const s33 = q4.find((s) => s.slice_id === "OPR.9.9.33")!;
    expect((s33.reviewed as Record<string, unknown>).value).toBe("INDETERMINATE");
    expect(String((s33.reviewed as Record<string, unknown>).basis)).toContain("候选");
  });

  it("Q2 诚实性：own-completion INDETERMINATE 绝不产生 next_up=true，terminal-row blockedOn 不决定 dispatchability", () => {
    // 34-delta: locked, unclaimed, EC-1 present, but NO candidate tag anywhere —
    // own folded is underivable, so dispatchability is INDETERMINATE, not true.
    writeSpec(
      missionsRoot,
      "34-delta",
      ["id: OPR.9.9.34", "slice: 34-delta", `mission: ${MISSION}`, "approved-spec-at: 2026-08-29T00:00:00.000Z", "depends_on: []"].join("\n"),
      "## Intent\ndelta\n",
    );
    // A DONE row with stale blockedOn naming slice 32 must not suppress 32's next_up.
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, blocked_on)
       VALUES ('qitem-stale-done', '2026-08-29T20:00:00.000Z', '2026-08-29T20:00:00.000Z', 'lead@exec-fixture', 'builder-b@exec-fixture', 'done', 'normal', 'light', ?, 'closed long ago', 'qitem-ancient-blocker')`,
    ).run(JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.32"]));
    // Free slice 32 of its live lane so only deps govern it.
    db.prepare(`UPDATE queue_items SET state = 'done', claimed_at = NULL WHERE qitem_id = 'qitem-lane-32'`).run();
    const doc = show();
    const q2 = doc.q2_sequencing as Record<string, unknown>[];
    const s34 = q2.find((s) => s.slice_id === "OPR.9.9.34")!;
    expect(s34.next_up).toBe("INDETERMINATE");
    expect(String(s34.next_up_basis)).toContain("完成层级");
    const s32 = q2.find((s) => s.slice_id === "OPR.9.9.32")!;
    // The stale terminal-row blocker is record, not state: it must not appear.
    expect(s32.blocked_on_rows).toEqual([]);
    // 32 also carries no candidate: own completion is underivable, so
    // dispatchability is INDETERMINATE — never false FROM the stale blocker,
    // never true from ignorance.
    expect(s32.next_up).toBe("INDETERMINATE");
    expect(String(s32.next_up_basis)).toContain("完成层级");
  });

  it("Q5 park_kind 仅使用 closed enum：deliberate-with-wake | stalled | indeterminate", () => {
    // Give lane-31 real post-claim motion so its pickup derives 'working' —
    // the arm that leaked 'working' into park_kind on the live artifact.
    db.prepare(
      `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, transition_note, actor_session)
       VALUES (31002, 'qitem-lane-31', '2026-08-29T21:30:00.000Z', 'in-progress', 'progress note', '${SEAT_A}')`,
    ).run();
    const doc = show();
    const rows = doc.q5_park as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    const lane31 = rows.find((p) => p.qitem_id === "qitem-lane-31")!;
    expect(lane31.pickup_state).toBe("working");
    for (const p of rows) {
      expect(["deliberate-with-wake", "stalled", "indeterminate"]).toContain(p.park_kind);
    }
  });

  it("RECEIVER：GET /api/views/execution?mission=… 通过 HTTP route 派生完整 document（不是 module-direct）", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("viewProjector" as never, projector);
      c.set("eventBus" as never, new EventBus(db));
      await next();
    });
    app.route("/api/views", viewsRoutes());
    const res = await app.request(`/api/views/execution?mission=${MISSION}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rowCount).toBe(1);
    const doc = (body.rows as Record<string, unknown>[])[0]!;
    expect(doc.view).toBe("execution");
    expect(doc.mission).toBe(MISSION);
    expect((doc.q1_lanes as unknown[]).length).toBe(2);
  });

  it("park 诚实性：armed wake => deliberate-with-wake；移除 wake 后 park_kind 变为 INDETERMINATE，绝不是 idle/dead", () => {
    const before = show();
    const parkedBefore = (before.q5_park as Record<string, unknown>[]).find((p) => p.qitem_id === "qitem-parked-33")!;
    expect(parkedBefore.pickup_state).toBe("parked");
    expect(parkedBefore.park_kind).toBe("deliberate-with-wake");
    expect(parkedBefore.wake_target).toBe("wake-timer-33");
    db.prepare(`DELETE FROM queue_transition_wakes WHERE qitem_id = 'qitem-parked-33'`).run();
    const after = show();
    const parkedAfter = (after.q5_park as Record<string, unknown>[]).find((p) => p.qitem_id === "qitem-parked-33")!;
    // The DESIGN's park_kind enum is lowercase; the value floor stays honest.
    expect(parkedAfter.park_kind).toBe("indeterminate");
    expect(String(parkedAfter.park_kind_basis)).toContain("没有已武装唤醒");
  });

  it("INDETERMINATE 下限：不可达 worktree path 的 git 环节渲染 INDETERMINATE，绝不是 idle/dead/done", () => {
    db.prepare(`UPDATE queue_items SET body = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      "Build 31.\nworktree_path=/nonexistent/severed/path\n",
    );
    const doc = show();
    const lane = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!;
    expect(lane.branch).toBe("INDETERMINATE");
    expect(lane.head_sha).toBe("INDETERMINATE");
    expect(String(lane.join_basis)).toContain("不可达");
    for (const forbidden of ["idle", "dead", "done"]) {
      expect(lane.branch).not.toBe(forbidden);
    }
  });

  it("trust stamp：response 带 derived_at + per-source asof；每个 lane 与 sequencing cell 携带 source id", () => {
    const doc = show();
    expect(typeof doc.derived_at).toBe("string");
    const sources = doc.sources as Record<string, Record<string, unknown>>;
    for (const key of ["queue_db", "slice_frontmatter", "wave_map", "git", "build_info", "review_artifacts", "disk"]) {
      expect(sources, `source ${key}`).toHaveProperty(key);
      expect(sources[key].asof, `asof on ${key}`).toBeTruthy();
    }
    for (const lane of doc.q1_lanes as Record<string, unknown>[]) {
      expect((lane.source as Record<string, unknown>).qitem_id).toBeTruthy();
    }
    for (const s of doc.q2_sequencing as Record<string, unknown>[]) {
      expect((s.source as Record<string, unknown>).spec_path).toBeTruthy();
    }
  });

  it("base 中保持 registered-name error，并始终对未知名称返回清晰 not-found", () => {
    expect(() => projector.show("no-such-view")).toThrow(ViewProjectorError);
  });
});
