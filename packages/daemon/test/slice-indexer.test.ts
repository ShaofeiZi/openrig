// Slice Story View v0——slice indexer 专项测试。
//
// 使用临时文件系统 fixture 驱动 indexer；与真实 substrate 侧 slices 文件夹完全隔离，使测试
// 保持确定且可安全并行。覆盖：
//
//   - frontmatter 解析 + display name fallback
//   - status enum mapping（包括 heuristic fallback）
//   - 从 frontmatter 提取 rail-item
//   - qitem 匹配策略（slice-name/mission body + tag）
//   - dogfood-evidence proof packet 探测（含 screenshot / video / trace）
//   - cache TTL 失效
//   - slicesRoot 未设置 / queue_items 缺失时优雅降级

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// qitem-18110994 R4——已建立的 hoisted node:fs importOriginal passthrough，与
// progress-review-done-coherence.test.ts 结构相同：每个 export 保持真实实现，只包装
// readFileSync，使 R4 scoping pin 能观察独立 get() 读取哪些 Markdown 文件。行为不变；
// wrapper 只记录调用。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { SliceIndexer, parseFrontmatter } from "../src/domain/slices/slice-indexer.js";

function makeTempDirs(): { slicesRoot: string; dogfoodRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-test-"));
  const slicesRoot = path.join(base, "slices");
  const dogfoodRoot = path.join(base, "dogfood-evidence");
  fs.mkdirSync(slicesRoot, { recursive: true });
  fs.mkdirSync(dogfoodRoot, { recursive: true });
  return { slicesRoot, dogfoodRoot };
}

function writeSlice(slicesRoot: string, name: string, files: Record<string, string>): void {
  const dir = path.join(slicesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function insertQitem(db: Database.Database, opts: { qitemId: string; body: string; tags?: string[]; tsCreated?: string; tsUpdated?: string }): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tags, body)
     VALUES (?, ?, ?, ?, ?, ?, 'routine', ?, ?)`
  ).run(
    opts.qitemId,
    opts.tsCreated ?? "2026-05-04T00:00:00.000Z",
    opts.tsUpdated ?? "2026-05-04T00:00:00.000Z",
    "src@r",
    "dst@r",
    "in-progress",
    opts.tags ? JSON.stringify(opts.tags) : null,
    opts.body,
  );
}

describe("PL-slice-story-view-v0 SliceIndexer", () => {
  let db: Database.Database;
  let slicesRoot: string;
  let dogfoodRoot: string;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const dirs = makeTempDirs();
    slicesRoot = dirs.slicesRoot;
    dogfoodRoot = dirs.dogfoodRoot;
    cleanup = path.dirname(slicesRoot);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  describe("frontmatter 解析", () => {
    it("解析 --- marker 之间的简单 key: value 对", () => {
      const fm = parseFrontmatter("---\nname: foo\nstatus: active\n---\nbody");
      expect(fm).toEqual({ name: "foo", status: "active" });
    });

    it("移除 value 外层的单引号和双引号", () => {
      const fm = parseFrontmatter(`---\nslice: 'pl-019-x'\ntitle: "Quoted"\n---\nbody`);
      expect(fm.slice).toBe("pl-019-x");
      expect(fm.title).toBe("Quoted");
    });

    it("没有 frontmatter delimiter 时返回空 object", () => {
      expect(parseFrontmatter("# Just markdown")).toEqual({});
    });

    it("frontmatter 未结束时返回空 object", () => {
      expect(parseFrontmatter("---\nslice: x\nno-end-marker")).toEqual({});
    });
  });

  describe("isReady + 优雅降级", () => {
    it("slicesRoot 为空字符串时 isReady() 返回 false", () => {
      const indexer = new SliceIndexer({ slicesRoot: "", dogfoodEvidenceRoot: null, db });
      expect(indexer.isReady()).toBe(false);
      expect(indexer.list()).toEqual([]);
      expect(indexer.get("anything")).toBeNull();
    });

    it("slicesRoot 路径不存在时 isReady() 返回 false", () => {
      const indexer = new SliceIndexer({ slicesRoot: "/nonexistent/path/foo", dogfoodEvidenceRoot: null, db });
      expect(indexer.isReady()).toBe(false);
    });

    it("slicesRoot 作为目录存在时 isReady() 返回 true", () => {
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.isReady()).toBe(true);
    });
  });

  describe("列表 + display name + status mapping", () => {
    it("枚举 slice 目录并跳过 dotfile", () => {
      writeSlice(slicesRoot, "alpha-slice", { "README.md": "---\nstatus: active\n---\n# Alpha" });
      writeSlice(slicesRoot, "beta-slice", { "README.md": "---\nstatus: shipped\n---\n# Beta" });
      fs.mkdirSync(path.join(slicesRoot, ".hidden"));
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries.map((e) => e.name).sort()).toEqual(["alpha-slice", "beta-slice"]);
    });

    it("枚举 missions/<mission>/slices/<slice> 下的 mission-aware workspace layout", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "idea-ledger", "slices"), "capture-product-ideas", {
        "README.md": "---\ntitle: Capture Product Ideas\nstatus: active\n---\n# Capture\n",
      });
      writeSlice(path.join(missionsRoot, "handoff-loop", "slices"), "route-work-packets", {
        "README.md": "---\nstatus: draft\n---\n# Route\n",
      });

      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries.map((e) => [e.name, e.missionId])).toEqual([
        ["capture-product-ideas", "idea-ledger"],
        ["route-work-packets", "handoff-loop"],
      ]);
      expect(indexer.get("capture-product-ideas")?.slicePath).toBe(
        path.join(missionsRoot, "idea-ledger", "slices", "capture-product-ideas"),
      );
    });

    it("可从兼容 root 索引 legacy flat slice 与 mission-aware slice", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(slicesRoot, "legacy-flat-slice", {
        "README.md": "---\nstatus: active\n---\n# Legacy\n",
      });
      writeSlice(path.join(missionsRoot, "demo-seed", "slices"), "idea-ledger-find-ideas-cycle-4", {
        "README.md": "---\ntitle: Find Ideas Cycle 4\nstatus: active\n---\n# Cycle 4\n",
      });

      const indexer = new SliceIndexer({
        slicesRoot,
        additionalSliceRoots: [missionsRoot],
        dogfoodEvidenceRoot: null,
        db,
      });
      const byName = new Map(indexer.list().map((entry) => [entry.name, entry]));
      expect(byName.get("legacy-flat-slice")?.missionId).toBeNull();
      expect(byName.get("idea-ledger-find-ideas-cycle-4")?.missionId).toBe("demo-seed");
      expect(indexer.get("idea-ledger-find-ideas-cycle-4")?.slicePath).toBe(
        path.join(missionsRoot, "demo-seed", "slices", "idea-ledger-find-ideas-cycle-4"),
      );
    });

    it("displayName 依次从 frontmatter title、首个 H1、文件夹名称派生", () => {
      writeSlice(slicesRoot, "from-title", { "README.md": "---\ntitle: Custom Title\n---\n# Heading" });
      writeSlice(slicesRoot, "from-h1", { "README.md": "---\nstatus: draft\n---\n# H1 Heading\nbody" });
      writeSlice(slicesRoot, "no-doc", {});
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const byName = new Map(indexer.list().map((e) => [e.name, e.displayName]));
      expect(byName.get("from-title")).toBe("Custom Title");
      expect(byName.get("from-h1")).toBe("H1 Heading");
      expect(byName.get("no-doc")).toBe("no-doc");
    });

    it("把 frontmatter status 映射到 canonical bucket", () => {
      writeSlice(slicesRoot, "s1", { "README.md": "---\nstatus: active\n---\n" });
      writeSlice(slicesRoot, "s2", { "README.md": "---\nstatus: shipped\n---\n" });
      writeSlice(slicesRoot, "s3", { "README.md": "---\nstatus: parked-with-evidence\n---\n" });
      writeSlice(slicesRoot, "s4", { "README.md": "---\nstatus: draft-pending-orch-ratification\n---\n" });
      writeSlice(slicesRoot, "s5", { "README.md": "---\n---\n" }); // no status
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const byName = new Map(indexer.list().map((e) => [e.name, e.status]));
      expect(byName.get("s1")).toBe("active");
      expect(byName.get("s2")).toBe("done");
      expect(byName.get("s3")).toBe("blocked");
      expect(byName.get("s4")).toBe("draft");
      expect(byName.get("s5")).toBe("draft");
    });

    it("使用 PROGRESS.md status 作为当前 slice cursor，优先于 stale README dispatch status", () => {
      writeSlice(slicesRoot, "mission-control-queue-observability-phase-a", {
        "README.md": "---\nslice: mission-control-queue-observability-phase-a\nstatus: ready-for-delivery-dispatch\nrail-item: PL-005\n---\n# Mission Control Phase A\n",
        "PROGRESS.md": "---\ndoc: mission-control-progress\nstatus: phase-a-closed-locally-promoted\nrail-item: PL-005\n---\n# Progress\n",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entry = indexer.list()[0]!;
      const detail = indexer.get("mission-control-queue-observability-phase-a")!;

      expect(entry.rawStatus).toBe("phase-a-closed-locally-promoted");
      expect(entry.status).toBe("done");
      expect(entry.displayName).toBe("mission-control-queue-observability-phase-a");
      expect(detail.rawStatus).toBe("phase-a-closed-locally-promoted");
      expect(detail.status).toBe("done");
    });
  });

  describe("rail-item 提取", () => {
    it("从 frontmatter scalar 提取 rail-item", () => {
      writeSlice(slicesRoot, "x", { "IMPLEMENTATION-PRD.md": "---\nrail-item: PL-019\n---\n" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.list()[0]!.railItem).toBe("PL-019");
    });

    it("移除 YAML parser 遗留为字符串的 bracket array notation", () => {
      writeSlice(slicesRoot, "x", { "IMPLEMENTATION-PRD.md": "---\nrelated-rail-items: [PL-008]\n---\n" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.list()[0]!.railItem).toBe("PL-008");
    });
  });

  // V0.3.1 slice 13 walk-item 7——workflow_spec frontmatter 解析。即使没有绑定 live workflow
  // instance，任务目标 Topology tab（以及 slice Topology fallback）仍从该声明投影 spec graph。
  // 格式：`workflow_spec: <name>@<version>`。
  describe("workflow_spec frontmatter 解析", () => {
    it("从 frontmatter 解析 workflow_spec: <name>@<version> 到 SliceRecord + SliceListEntry", () => {
      writeSlice(slicesRoot, "topo-slice", {
        "README.md": "---\nstatus: active\nworkflow_spec: openrig-velocity@1.0\n---\n# Topo\n",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const list = indexer.list();
      expect(list[0]!.workflowSpec).toEqual({ name: "openrig-velocity", version: "1.0" });
      const record = indexer.get("topo-slice")!;
      expect(record.workflowSpec).toEqual({ name: "openrig-velocity", version: "1.0" });
    });

    it("frontmatter 字段缺失时返回 workflowSpec: null", () => {
      writeSlice(slicesRoot, "no-topo-slice", {
        "README.md": "---\nstatus: active\n---\n# Plain\n",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const list = indexer.list();
      expect(list[0]!.workflowSpec).toBeNull();
      expect(indexer.get("no-topo-slice")!.workflowSpec).toBeNull();
    });

    it("忽略不匹配 <name>@<version> 的 malformed workflow_spec 值", () => {
      writeSlice(slicesRoot, "bad-topo-slice", {
        "README.md": "---\nstatus: active\nworkflow_spec: not-a-valid-spec-ref\n---\n",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.list()[0]!.workflowSpec).toBeNull();
    });
  });

  describe("qitem 匹配", () => {
    it("按 slice-name body 子串匹配 qitem", () => {
      writeSlice(slicesRoot, "mission-control-phase-a", { "README.md": "---\nstatus: shipped\n---\n" });
      insertQitem(db, { qitemId: "q-match-1", body: "PL-005 Phase A mission-control-phase-a dispatch" });
      insertQitem(db, { qitemId: "q-match-2", body: "Re: mission-control-phase-a Q&A" });
      insertQitem(db, { qitemId: "q-no-match", body: "Some other slice work" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("mission-control-phase-a")!;
      expect(slice.qitemIds.sort()).toEqual(["q-match-1", "q-match-2"]);
    });

    it("也按 rail-item body 子串匹配 qitem，并与 slice-name match 求并集", () => {
      writeSlice(slicesRoot, "topology-activity-indicators-v0", {
        "IMPLEMENTATION-PRD.md": "---\nrail-item: PL-019\nstatus: active\n---\n",
      });
      insertQitem(db, { qitemId: "q-by-name", body: "topology-activity-indicators-v0 dispatch" });
      insertQitem(db, { qitemId: "q-by-rail", body: "PL-019 follow-up" });
      insertQitem(db, { qitemId: "q-none", body: "something else" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("topology-activity-indicators-v0")!;
      expect(slice.qitemIds.sort()).toEqual(["q-by-name", "q-by-rail"]);
    });

    it("按任务目标 id 和 tag 匹配嵌套任务目标 slice", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "idea-ledger", "slices"), "triage-product-ideas", {
        "README.md": "---\nstatus: active\n---\n# Triage\n",
      });
      insertQitem(db, {
        qitemId: "q-by-mission-body",
        body: "Advance the idea-ledger mission.",
      });
      insertQitem(db, {
        qitemId: "q-by-slice-tag",
        body: "No visible slice name here.",
        tags: ["triage-product-ideas"],
      });
      insertQitem(db, {
        qitemId: "q-none",
        body: "Other project",
        tags: ["unrelated"],
      });

      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("triage-product-ideas")!;
      expect(slice.missionId).toBe("idea-ledger");
      expect(slice.railItem).toBe("idea-ledger");
      expect(slice.qitemIds.sort()).toEqual(["q-by-mission-body", "q-by-slice-tag"]);
    });

    // V0.3.1 slice 17 founder-walk-workspace-state-correctness——walk item 3。over-match bug：
    // 只带 mission:<missionId> tag（无 `slice:` tag，body 也未提 slice name）的 qitem 会出现在
    // 该任务目标的每个 slice 下，因为 matchQitems 对所有 slice 都并入 missionId 子串 term。
    // 修复：至少一个 qitem 带 typed `slice:<sliceName>` tag 时，从并集中移除 missionId 子串 term，
    // 让只有 mission tag 的 qitem 不再污染 slice queue。没有 typed-tag qitem 的 slice 保留子串
    // fallback，以兼容 legacy corpus（HG-2）。
    it("存在 typed slice:<name> tag match 时，以 typed tag 为权威，不包含仅 mission 或仅 body 子串 qitem（VM-004）", () => {
      // 生产结构：slices/missions root 下的任务目标文件夹包含 slice。missionId 解析为任务目标
      // 文件夹名称；frontmatter 未指定 railItem 时默认使用 missionId。
      //
      // VM-004（canonical scope-membership matcher）：typed tag 是权威来源。存在任意确认的
      // `slice:<name>` typed row 时，完全关闭 substring fallback 层，因此 mission-only qitem 和
      // body-substring-only qitem 都不会泄漏到 slice queue。VM-004 之前 substring 层始终运行并
      // 保留 sliceName body-substring match；VM-004 正是关闭该泄漏。legacy zero-typed corpus 继续
      // 保留完整 substring fallback，见相邻“保留 legacy substring fallback”测试。
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "release-fake", "slices"), "fake-slice-17", {
        "README.md": "---\nstatus: active\nrail-item: WALK-17\n---\n# Fake 17\n",
      });
      insertQitem(db, {
        qitemId: "q-typed-slice-tag",
        body: "Body without slice name.",
        tags: ["slice:fake-slice-17"],
      });
      insertQitem(db, {
        qitemId: "q-mission-tag-only",
        body: "Body without slice name.",
        tags: ["mission:release-fake"],
      });
      insertQitem(db, {
        qitemId: "q-by-slice-name-body",
        body: "fake-slice-17 mention in body.",
        tags: [],
      });
      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("fake-slice-17")!;
      expect(slice.qitemIds).toEqual(["q-typed-slice-tag"]);
      expect(slice.qitemIds).not.toContain("q-mission-tag-only");
      expect(slice.qitemIds).not.toContain("q-by-slice-name-body");
    });

    it("railItem 默认使用 missionId 时，不重新包含 mission-only qitem", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "release-fake-default-rail", "slices"), "fake-slice-default-rail", {
        "README.md": "---\nstatus: active\n---\n# Fake default rail\n",
      });
      insertQitem(db, {
        qitemId: "q-default-rail-typed-slice-tag",
        body: "Body without slice name.",
        tags: ["slice:fake-slice-default-rail"],
      });
      insertQitem(db, {
        qitemId: "q-default-rail-mission-tag-only",
        body: "Body without slice name.",
        tags: ["mission:release-fake-default-rail"],
      });

      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("fake-slice-default-rail")!;
      expect(slice.railItem).toBe("release-fake-default-rail");
      expect(slice.qitemIds).toEqual(["q-default-rail-typed-slice-tag"]);
      expect(slice.qitemIds).not.toContain("q-default-rail-mission-tag-only");
    });

    it("不存在 typed slice: tag 时保留 legacy substring fallback，包括 mission body", () => {
      // 没有 qitem 带 typed `slice:<name>` tag 时，indexer 回退到修复前的三 term 子串并集，
      // 让旧 dogfood corpus 保持本 slice 落地前的匹配方式。
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "legacy-mission", "slices"), "legacy-slice", {
        "README.md": "---\nstatus: active\nrail-item: LEGACY-RAIL\n---\n",
      });
      insertQitem(db, { qitemId: "q-legacy-by-mission", body: "advance the legacy-mission mission", tags: [] });
      insertQitem(db, { qitemId: "q-legacy-by-name", body: "legacy-slice work item", tags: [] });
      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("legacy-slice")!;
      // 两者都匹配：mission body 通过 missionId 子串，name body 通过 sliceName 子串。
      expect(slice.qitemIds.sort()).toEqual(["q-legacy-by-mission", "q-legacy-by-name"]);
    });

    // V0.3.1 slice 17 walk item 10——forward-fix #1。slice-detail Queue tab 原样消费后端
    // `detail.qitemIds`，因此 indexer 自身必须按 ts_created DESC 排序；Phase A 前端 rollup 排序
    // 只覆盖 workspace/mission rollup view。按已记录 feedback_poc_regression_must_discriminate，
    // 使用三个不同 ts_created 值判别顺序。
    it("matchQitems 返回按 ts_created DESC 排序的 qitemId；slice tab 原样消费该顺序", () => {
      const missionsRoot = path.join(cleanup, "missions");
      writeSlice(path.join(missionsRoot, "fwx-mission", "slices"), "fwx-slice", {
        "README.md": "---\nstatus: active\nrail-item: FWX-RAIL\n---\n",
      });
      insertQitem(db, {
        qitemId: "q-oldest",
        body: "tagged for fwx-slice",
        tags: ["slice:fwx-slice"],
        tsCreated: "2026-05-11T09:00:00.000Z",
      });
      insertQitem(db, {
        qitemId: "q-middle",
        body: "tagged for fwx-slice",
        tags: ["slice:fwx-slice"],
        tsCreated: "2026-05-11T10:00:00.000Z",
      });
      insertQitem(db, {
        qitemId: "q-newest",
        body: "tagged for fwx-slice",
        tags: ["slice:fwx-slice"],
        tsCreated: "2026-05-11T11:00:00.000Z",
      });
      const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
      const slice = indexer.get("fwx-slice")!;
      // 严格顺序：最新在前、最旧在后，不按 id 字母序。
      expect(slice.qitemIds).toEqual(["q-newest", "q-middle", "q-oldest"]);
    });

    it("queue_items 表不存在时返回空 qitem set", () => {
      // 重建不含 queue_items 的 db，以模拟 test-harness 缺口。
      const bareDb = createDb();
      migrate(bareDb, [coreSchema]);
      writeSlice(slicesRoot, "x", { "README.md": "---\nrail-item: PL-005\n---\n" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db: bareDb });
      expect(indexer.list()[0]!.qitemCount).toBe(0);
      bareDb.close();
    });
  });

  describe("proof packet 探测", () => {
    it("匹配名称包含 slice name 的 dogfood-evidence 目录", () => {
      writeSlice(slicesRoot, "mission-control-queue-observability-phase-a", { "README.md": "---\n---\n" });
      const proofDir = path.join(dogfoodRoot, "pl005-phase-a-mission-control-queue-observability-20260504");
      fs.mkdirSync(proofDir);
      fs.writeFileSync(path.join(proofDir, "PL005-phase-a-headed-browser-dogfood.md"), "All green");
      fs.mkdirSync(path.join(proofDir, "screenshots"));
      fs.writeFileSync(path.join(proofDir, "screenshots", "mc-active-work.png"), "fake-png");
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      const slice = indexer.get("mission-control-queue-observability-phase-a")!;
      expect(slice.proofPacket).not.toBeNull();
      expect(slice.proofPacket!.dirName).toBe("pl005-phase-a-mission-control-queue-observability-20260504");
      expect(slice.proofPacket!.markdownFiles).toContain("PL005-phase-a-headed-browser-dogfood.md");
      expect(slice.proofPacket!.screenshots).toEqual(["screenshots/mc-active-work.png"]);
      expect(slice.proofPacket!.videos).toEqual([]); // none captured (matches reality at dispatch time)
      expect(slice.proofPacket!.traces).toEqual([]);
    });

    it("匹配 proof packet 目录时移除尾部 -v0 / -v1 suffix", () => {
      writeSlice(slicesRoot, "topology-activity-indicators-v0", { "README.md": "---\n---\n" });
      const proofDir = path.join(dogfoodRoot, "pl019-topology-activity-indicators-20260504");
      fs.mkdirSync(proofDir);
      fs.writeFileSync(path.join(proofDir, "evidence.md"), "");
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      expect(indexer.get("topology-activity-indicators-v0")!.proofPacket?.dirName)
        .toBe("pl019-topology-activity-indicators-20260504");
    });

    it("多个 proof packet 匹配时选择 mtime 最新目录", () => {
      writeSlice(slicesRoot, "x-slice", { "README.md": "---\n---\n" });
      const oldDir = path.join(dogfoodRoot, "x-slice-20260101");
      const newDir = path.join(dogfoodRoot, "x-slice-20260601");
      fs.mkdirSync(oldDir);
      fs.mkdirSync(newDir);
      // 强制 mtime 顺序。
      fs.utimesSync(oldDir, new Date("2026-01-01"), new Date("2026-01-01"));
      fs.utimesSync(newDir, new Date("2026-06-01"), new Date("2026-06-01"));
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      expect(indexer.get("x-slice")!.proofPacket?.dirName).toBe("x-slice-20260601");
    });

    it("把 .mp4/.webm 文件分类为 video", () => {
      writeSlice(slicesRoot, "video-slice", { "README.md": "---\n---\n" });
      const proofDir = path.join(dogfoodRoot, "video-slice-20260504");
      fs.mkdirSync(proofDir);
      fs.mkdirSync(path.join(proofDir, "videos"));
      fs.writeFileSync(path.join(proofDir, "videos", "demo.mp4"), "fake");
      fs.writeFileSync(path.join(proofDir, "videos", "demo2.webm"), "fake");
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
      expect(indexer.get("video-slice")!.proofPacket!.videos.sort()).toEqual([
        "videos/demo.mp4",
        "videos/demo2.webm",
      ]);
    });

    it("dogfoodRoot 未设置时返回 null proofPacket", () => {
      writeSlice(slicesRoot, "x", { "README.md": "---\n---\n" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      expect(indexer.get("x")!.proofPacket).toBeNull();
    });
  });

  describe("cache 失效", () => {
    it("invalidate() 同时丢弃 list + detail cache", () => {
      writeSlice(slicesRoot, "x", { "README.md": "---\n---\n# X" });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const first = indexer.list();
      expect(first).toHaveLength(1);
      writeSlice(slicesRoot, "y", { "README.md": "---\n---\n# Y" });
      // 来自 cache，仍为 1。
      expect(indexer.list()).toHaveLength(1);
      indexer.invalidate();
      expect(indexer.list()).toHaveLength(2);
    });
  });

  // OPR.0.3.2.17——SliceListEntry 呈现 frontmatter `description`，使 storytelling adapter
  // 可把它用作 `rawStatus === "candidate"` slice 的 ConceptCard.oneLiner。映射顺序：优先
  // description，回退到 summary，两者都缺失时为 null。
  describe("OPR.0.3.2.17——在 SliceListEntry 呈现 frontmatter description", () => {
    it("description: <text> 填充 SliceListEntry.description", () => {
      writeSlice(slicesRoot, "concept-restore", {
        "README.md": "---\nstatus: candidate\ndescription: First-class restore packet.\n---\n# Restore",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.description).toBe("First-class restore packet.");
      expect(entries[0]!.rawStatus).toBe("candidate");
    });

    it("description 缺失时以 summary: <text> 作为 fallback", () => {
      writeSlice(slicesRoot, "concept-with-summary", {
        "README.md": "---\nstatus: candidate\nsummary: Falls back to summary.\n---\n# Slice",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.description).toBe("Falls back to summary.");
    });

    it("description 和 summary 都缺失时 description=null", () => {
      writeSlice(slicesRoot, "no-desc", {
        "README.md": "---\nstatus: candidate\n---\n# No desc",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries[0]!.description).toBeNull();
    });

    it("空或只有空白的 description 值规范化为 null（graceful-empty input）", () => {
      writeSlice(slicesRoot, "empty-desc", {
        "README.md": "---\nstatus: candidate\ndescription: '   '\n---\n# Slice",
      });
      const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
      const entries = indexer.list();
      expect(entries[0]!.description).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// qitem-ccf87c0d——Project mission-index LOAD CONTRACT（guard-amended RED）。取证根因：
// matchQitems 每次 cold rebuild 执行 O(slices) 次 queue_items 全表 LIKE 扫描；tier-1 始终执行
// wildcard+ORDER BY，每个 zero-typed slice 最多再做 3 次 body-LIKE。主机规模 353 个 slice 时
// cold 耗时约 10 秒，同步阻塞后台服务 event loop。下方契约统计 queue_items LIKE statement 的
// 执行次数，而非 prepare 调用：cold rebuild 必须执行常数次 scan-shaped statement，与 slice 数量
// 无关。并列的行为 pin 确保 batch rewrite 不会漂移 membership 语义。
// ---------------------------------------------------------------------------

describe("qitem-ccf87c0d——mission-index load contract + membership pin", () => {
  let db: Database.Database;
  let cleanup: string;
  let missionsRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-load-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  /** 统计同时引用 queue_items 且含 LIKE 的 statement 执行次数（.all/.iterate/.get 调用），即
   *  scan-shaped statement。run() 不计数并直接透传（INSERT 填种）；非 LIKE statement 不包装。 */
  function instrumentLikeExecutions(target: Database.Database): () => number {
    let n = 0;
    const origPrepare = target.prepare.bind(target);
    (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (!/queue_items/i.test(sql) || !/\bLIKE\b/i.test(sql)) return stmt;
      return {
        all: (...a: unknown[]) => { n++; return stmt.all!(...a); },
        iterate: (...a: unknown[]) => { n++; return stmt.iterate!(...a); },
        get: (...a: unknown[]) => { n++; return stmt.get!(...a); },
        run: (...a: unknown[]) => stmt.run!(...a),
      };
    };
    return () => n;
  }

  /** 精确填种：2 个任务目标 × 20 个 slice = 40 个 slice；前 12 个（30%）为 typed，每个各有
   *  一条确认的 `slice:` row；共 60 个 qitem（12 个 typed row + 48 个带 200-byte body 的
   *  zero-typed row）。 */
  function seedFixture(): { typedSlices: string[]; untypedSlices: string[] } {
    const typedSlices: string[] = [];
    const untypedSlices: string[] = [];
    const filler = "b".repeat(200);
    let idx = 0;
    for (let m = 0; m < 2; m++) {
      const mission = `load-mission-${m}`;
      for (let s = 0; s < 20; s++, idx++) {
        const slice = `ld-${String(idx).padStart(2, "0")}-topic`;
        writeSlice(path.join(missionsRoot, mission, "slices"), slice, {
          "README.md": `---\nstatus: active\n---\n# ${slice}\n`,
        });
        if (idx < 12) typedSlices.push(slice);
        else untypedSlices.push(slice);
      }
    }
    for (let i = 0; i < 12; i++) {
      insertQitem(db, {
        qitemId: `q-typed-${String(i).padStart(2, "0")}`,
        body: `typed packet ${i} ${filler}`,
        tags: [`slice:${typedSlices[i]!}`],
        tsCreated: `2026-07-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }
    for (let i = 0; i < 48; i++) {
      insertQitem(db, {
        qitemId: `q-plain-${String(i).padStart(2, "0")}`,
        body: `generic packet ${i} ${filler}`,
        tags: ["release:0.4.7"],
        tsCreated: `2026-07-02T00:${String(i % 60).padStart(2, "0")}:00.000Z`,
      });
    }
    return { typedSlices, untypedSlices };
  }

  it("LOAD CONTRACT（RED）：对 40 个 slice 的一次 cold list() 执行常数个 queue_items LIKE statement（<= 4），与 slice 数量无关", () => {
    const { typedSlices } = seedFixture();
    const likeCount = instrumentLikeExecutions(db);
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const entries = indexer.list();
    expect(entries).toHaveLength(40);
    // 同次 rebuild 内检查 membership：typed slice 携带自身 row。
    const typed0 = entries.find((e) => e.name === typedSlices[0])!;
    expect(typed0.qitemCount).toBe(1);
    // 契约：扫描次数为常数。修复前会执行 40 次 tier-1 LIKE iteration，再为 28 个 zero-typed
    // slice 各执行 2 次已去重 fallback LIKE，共 96 次；修复后为有界常数。
    expect(likeCount()).toBeLessThanOrEqual(4);
  });

  it("PIN：invalidate() 获取新 slice 文件夹及其 typed membership（Explorer auto-show read-after-write）", () => {
    seedFixture();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.list()).toHaveLength(40);
    writeSlice(path.join(missionsRoot, "load-mission-0", "slices"), "ld-fresh-folder", {
      "README.md": "---\nstatus: active\n---\n# Fresh\n",
    });
    insertQitem(db, {
      qitemId: "q-fresh-typed",
      body: "fresh dispatch",
      tags: ["slice:ld-fresh-folder"],
    });
    indexer.invalidate();
    const after = indexer.list();
    expect(after).toHaveLength(41);
    expect(after.find((e) => e.name === "ld-fresh-folder")!.qitemCount).toBe(1);
    expect(indexer.get("ld-fresh-folder")!.qitemIds).toEqual(["q-fresh-typed"]);
  });

  it("PIN：任何 list() 之前的 cold direct get() 能解析正确 typed membership", () => {
    const { typedSlices } = seedFixture();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    // 之前不调用 list()；detail 路径必须延迟构建所需 index。
    const record = indexer.get(typedSlices[3]!)!;
    expect(record.qitemIds).toEqual(["q-typed-03"]);
  });

  it("PIN：TTL 到期后无需显式 invalidate 即刷新 membership", async () => {
    const { typedSlices } = seedFixture();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db, cacheTtlMs: 40 });
    expect(indexer.get(typedSlices[0]!)!.qitemIds).toEqual(["q-typed-00"]);
    insertQitem(db, {
      qitemId: "q-typed-00-later",
      body: "late dispatch",
      tags: [`slice:${typedSlices[0]!}`],
      tsCreated: "2026-07-03T00:00:00.000Z",
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(indexer.get(typedSlices[0]!)!.qitemIds).toEqual(["q-typed-00-later", "q-typed-00"]);
  });

  it("PIN：重叠 zero-typed fallback term 把同一 row 计入每个匹配 slice，不发生 consuming-alternation 丢失", () => {
    // flat root 下 railItem/missionId 为 null，因此每个 slice 唯一 fallback term 是自身名称。
    // 两个名称在同一个 body 字符串中重叠："alpha-beta-gamma" 同时包含 "alpha-beta" 和
    // "beta-gamma"，共享 "beta" segment。简单的单次 consuming alternation 只会计入首项。
    const flatRoot = path.join(cleanup, "flat-slices");
    writeSlice(flatRoot, "alpha-beta", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(flatRoot, "beta-gamma", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-overlap", body: "work on alpha-beta-gamma today", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("alpha-beta")!.qitemIds).toEqual(["q-overlap"]);
    expect(indexer.get("beta-gamma")!.qitemIds).toEqual(["q-overlap"]);
  });

  it("PIN：fallback 层保留 SQL-LIKE ASCII 大小写不敏感语义", () => {
    const flatRoot = path.join(cleanup, "flat-ci");
    writeSlice(flatRoot, "case-probe", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-upper", body: "Ref: CASE-PROBE follow-up", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("case-probe")!.qitemIds).toEqual(["q-upper"]);
  });

  it("PIN：保留 SQL-LIKE wildcard 语义；slice name 中下划线匹配 body 任意单字符（当前逐字节行为）", () => {
    // Fallback term 来自文件夹名称/frontmatter，可以包含 `_`，原则上也可包含 `%`。当前这些
    // 字节是 LIKE wildcard：body LIKE '%under_score-slice%' 会匹配 "underXscore-slice"。
    // batch rewrite 必须转换而非 literalize 这些字节。
    const flatRoot = path.join(cleanup, "flat-wildcard");
    writeSlice(flatRoot, "under_score-slice", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-wild-x", body: "see underXscore-slice notes", tags: [] });
    insertQitem(db, { qitemId: "q-wild-lit", body: "see under_score-slice notes", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("under_score-slice")!.qitemIds.sort()).toEqual(["q-wild-lit", "q-wild-x"]);
  });

  it("PIN：tags-column-missing 降级后 fallback 仍按 body 匹配，并捕获 tier-1 failure", () => {
    const bareDb = createDb();
    migrate(bareDb, [coreSchema]);
    bareDb.exec(`CREATE TABLE queue_items (
      qitem_id TEXT PRIMARY KEY, ts_created TEXT NOT NULL, ts_updated TEXT NOT NULL,
      source_session TEXT NOT NULL, destination_session TEXT NOT NULL, state TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'routine', body TEXT NOT NULL)`);
    bareDb.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
       VALUES ('q-no-tags-col', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'a@r', 'b@r', 'done', 'notagcol-slice work')`,
    ).run();
    const flatRoot = path.join(cleanup, "flat-notags");
    writeSlice(flatRoot, "notagcol-slice", { "README.md": "---\nstatus: active\n---\n" });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db: bareDb });
    expect(indexer.get("notagcol-slice")!.qitemIds).toEqual(["q-no-tags-col"]);
    bareDb.close();
  });
});

// qitem-ccf87c0d guard RED-verdict delta——两个字节等价 blocker
// 在任何 batch matcher 落地前针对当前 engine 固定。
describe("qitem-ccf87c0d——LIKE 字节等价 + fallback 顺序 pin（guard delta）", () => {
  let db: Database.Database;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-eqv-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("PIN：SQLite LIKE 只折叠 ASCII；非 ASCII 大小写变体 æ/Æ 不匹配，ASCII 字母仍折叠", () => {
    const flatRoot = path.join(cleanup, "flat-ascii-fold");
    writeSlice(flatRoot, "graey-æ-slice", { "README.md": "---\nstatus: active\n---\n" });
    // Æ（U+00C6）是 æ（U+00E6）的 Unicode 大写；JS /i regex 会匹配，SQLite LIKE 因只折叠
    // ASCII 而不得匹配。
    insertQitem(db, { qitemId: "q-unicode-upper", body: "ref GRAEY-Æ-SLICE here", tags: [] });
    // æ 字节相同、ASCII 字母大小写不同：LIKE 匹配。
    insertQitem(db, { qitemId: "q-ascii-fold", body: "ref GRAEY-æ-SLICE here", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("graey-æ-slice")!.qitemIds).toEqual(["q-ascii-fold"]);
  });

  it("PIN：LIKE wildcard 可跨 NEWLINE 匹配；slice name 中下划线匹配 body 的 '\\n'，要求等同 dotAll 行为", () => {
    const flatRoot = path.join(cleanup, "flat-nl-wild");
    writeSlice(flatRoot, "nl_probe", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-newline-wild", body: "prefix nl\nprobe suffix", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("nl_probe")!.qitemIds).toEqual(["q-newline-wild"]);
  });

  it("PIN：相同 ts 的 fallback row 保持 TERM-FIRST 顺序 [sliceName, railItem]，而非 DB row 顺序", () => {
    // 只匹配 railItem term 的 row 先插入 DB；只匹配 sliceName term 的 row 后插入；两者
    // ts_created 相同。当前 engine 按 [sliceName, railItem] 迭代 term，id 按 term 顺序进入 Set，
    // 最终 ts-DESC 排序在相等值上稳定，所以 sliceName 匹配 row 先渲染。row-first batch scan
    // 会按 DB 顺序发出并颠倒两者。
    const flatRoot = path.join(cleanup, "flat-term-order");
    writeSlice(flatRoot, "term-order-slice", {
      "README.md": "---\nstatus: active\nrail-item: TORD-RAIL\n---\n",
    });
    const ts = "2026-07-05T12:00:00.000Z";
    insertQitem(db, { qitemId: "q-a-railitem", body: "TORD-RAIL work", tags: [], tsCreated: ts });
    insertQitem(db, { qitemId: "q-b-slicename", body: "term-order-slice work", tags: [], tsCreated: ts });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("term-order-slice")!.qitemIds).toEqual(["q-b-slicename", "q-a-railitem"]);
  });
});

// qitem-ccf87c0d guard POST-EDIT blocker——LIKE '_' 的 code-point parity。
describe("qitem-ccf87c0d——LIKE '_' Unicode code-point parity（guard blocker pin）", () => {
  let db: Database.Database;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-cp-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("PIN：'_' 匹配一个字符（code point）；astral emoji 在 UTF-16 中为 surrogate pair，但与 SQLite 一样满足单个 '_'", () => {
    // SQLite LIKE '%emoji_probe%' 匹配 body 'emoji😀probe'；😀（U+1F600）是一个字符。
    // UTF-16 code-unit matcher（[\s\S]）只消费 surrogate pair 的一半，因而漏匹配；转换必须按
    // code point 正确处理（dotAll + u）。
    const flatRoot = path.join(cleanup, "flat-cp");
    writeSlice(flatRoot, "emoji_probe", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-astral", body: "see emoji\u{1F600}probe notes", tags: [] });
    // 两个 code-unit 的 ASCII 序列仍不得匹配单个 '_'：
    insertQitem(db, { qitemId: "q-two-chars", body: "see emojiXYprobe notes", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("emoji_probe")!.qitemIds).toEqual(["q-astral"]);
  });
});

// qitem-18f3300d——guard 相对 parent 7b19b73e 的两个 candidate-blocking regression；
// 对 sealed candidate c8f85802 为 RED（仅测试 gate）。
describe("qitem-18f3300d——NUL parity + 跨 operation membership freshness（RED vs candidate）", () => {
  let db: Database.Database;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-gate2-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("RED：SQLite LIKE 在原始 U+0000 处截断 haystack；只出现在 NUL 后的 fallback term 必须排除，NUL 前对照仍包含", () => {
    // 生产可达：POST /api/queue/create 把 "before\u0000slice-after" JSON decode 成含原始 NUL 的
    // JS 字符串，并未经拒绝存入 queue_items.body。parent 逐 slice SQL（body LIKE '%<term>%'）
    // 在 term 位于 NUL 后时不返回 row；candidate 的 JS regex 穿过 NUL 扫描并错误包含它。
    const flatRoot = path.join(cleanup, "flat-nul");
    writeSlice(flatRoot, "nul-term-slice", { "README.md": "---\nstatus: active\n---\n" });
    insertQitem(db, { qitemId: "q-after-nul", body: "prefix\u0000nul-term-slice suffix", tags: [] });
    insertQitem(db, { qitemId: "q-before-nul", body: "nul-term-slice mentioned\u0000trailing junk", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("nul-term-slice")!.qitemIds).toEqual(["q-before-nul"]);
  });

  it("RED：PATTERN 侧含 NUL；rail-item 'RAIL\\u0000TAIL' 绑定 %RAIL\\u0000TAIL%，SQLite 截断为 %RAIL 并丢失尾部 wildcard：body 以 RAIL 结尾时匹配，位于中间时不匹配", () => {
    // Parent SQL 绑定完整 pattern '%RAIL\u0000TAIL%'；SQLite 在 NUL 处截断为 '%RAIL'，由于尾部
    // '%' 丢失，现在变成 END-ANCHORED。railItem 经不拒绝 NUL 的最小 frontmatter parser 到达
    // bound pattern，因此生产可达。
    const flatRoot = path.join(cleanup, "flat-nul-pattern");
    writeSlice(flatRoot, "plain-slice", {
      "README.md": "---\nstatus: active\nrail-item: RAIL\u0000TAIL\n---\n",
    });
    insertQitem(db, { qitemId: "q-parent-match", body: "ends with RAIL", tags: [] });
    insertQitem(db, { qitemId: "q-mid-rail", body: "RAIL in middle stuff", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    // Parent：q-parent-match 通过截断后的 '%RAIL'（ends-with）匹配；q-mid-rail 被排除，说明
    // 丢失尾部 wildcard 会影响结果。
    expect(indexer.get("plain-slice")!.qitemIds).toEqual(["q-parent-match"]);
  });

  it("RED：跨 operation freshness（TYPED）——为已知 B 写入 typed qitem 后，B 首次 uncached get() 即可见，无需 invalidate/TTL", () => {
    // Parent 在每次 uncached get() 上运行逐 slice SQL，因此 get(A) 后写入的 row 在首次 get(B)
    // 立即可见。candidate 的 generation-scoped index 因 B 已在 knownSlices 中，会在
    // invalidate/TTL 前返回 stale empty membership。
    const flatRoot = path.join(cleanup, "flat-fresh-typed");
    writeSlice(flatRoot, "fresh-a", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(flatRoot, "fresh-b-typed", { "README.md": "---\nstatus: active\n---\n" });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("fresh-a")!.qitemIds).toEqual([]); // builds the index generation
    insertQitem(db, { qitemId: "q-b-typed", body: "no name mention", tags: ["slice:fresh-b-typed"] });
    expect(indexer.get("fresh-b-typed")!.qitemIds).toEqual(["q-b-typed"]);
  });

  it("RED：跨 operation freshness（FALLBACK）——为已知 C 写入 body-mention qitem 后，C 首次 uncached get() 即可见，无需 invalidate/TTL", () => {
    // 与 typed vector 隔离，使用独立 indexer + fixture，使 assertion 可在 c8f85802 上独立
    // 执行并失败；其他位置由 typed 触发的 rebuild 不得掩盖 fallback 层。
    const flatRoot = path.join(cleanup, "flat-fresh-fallback");
    writeSlice(flatRoot, "fresh-a2", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(flatRoot, "fresh-c-fallback", { "README.md": "---\nstatus: active\n---\n" });
    const indexer = new SliceIndexer({ slicesRoot: flatRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("fresh-a2")!.qitemIds).toEqual([]); // builds the index generation
    insertQitem(db, { qitemId: "q-c-fallback", body: "fresh-c-fallback body mention", tags: [] });
    expect(indexer.get("fresh-c-fallback")!.qitemIds).toEqual(["q-c-fallback"]);
  });
});

// qitem-ccf87c0d amended gate——显式 composite-operation scope API
//（withMembershipBatch）。修复前因 export 缺失而 RED；pin 定义契约：最外层 fresh open、
// scope 内共享、嵌套复用、exception-safe close，以及不变的 standalone 语义。
describe("qitem-ccf87c0d——withMembershipBatch scope API（RED：API 缺失）", () => {
  let db: Database.Database;
  let cleanup: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-scope-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  type Scoped = SliceIndexer & { withMembershipBatch<T>(fn: () => T): T };
  function scoped(indexer: SliceIndexer): Scoped {
    const s = indexer as Scoped;
    expect(typeof s.withMembershipBatch, "withMembershipBatch 必须是公开的 SliceIndexer method").toBe("function");
    return s;
  }

  /** 与 route/Review contract 相同的 membership-scan counter：统计全部 queue_items scan，排除
   *  PK IN lookup + INSERT。indexer seam 没有 gather read，因此这里 total == membership。 */
  function instrumentScans(target: Database.Database): () => number {
    let n = 0;
    const origPrepare = target.prepare.bind(target);
    (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const isScan = /from\s+queue_items/i.test(sql)
        && !/^\s*insert/i.test(sql)
        && !/where\s+qitem_id\s+in/i.test(sql);
      if (!isScan) return stmt;
      return {
        all: (...a: unknown[]) => { n++; return stmt.all!(...a); },
        iterate: (...a: unknown[]) => { n++; return stmt.iterate!(...a); },
        get: (...a: unknown[]) => { n++; return stmt.get!(...a); },
        run: (...a: unknown[]) => stmt.run!(...a),
      };
    };
    return () => n;
  }

  function seedSlices(n: number): string {
    const root = path.join(cleanup, "missions");
    for (let i = 0; i < n; i++) {
      writeSlice(path.join(root, "scope-mission", "slices"), `sc-${String(i).padStart(2, "0")}-topic`, {
        "README.md": "---\nstatus: active\n---\n",
      });
    }
    return root;
  }

  it("scope 内 list() + N 次 get 共享一个 batch：整个 scope 总 queue scan <= 4", () => {
    const root = seedSlices(12);
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
    const s = scoped(indexer);
    const scans = instrumentScans(db);
    s.withMembershipBatch(() => {
      const entries = indexer.list();
      for (const e of entries) indexer.get(e.name);
    });
    expect(scans()).toBeLessThanOrEqual(4);
  });

  it("REQUEST-BOUNDARY FRESHNESS：scope1 经 get(A) 建 batch；为已知但未缓存 B 插入 membership；scope2 get(B) 可见，因为 scope-open 始终 fresh", () => {
    const root = seedSlices(2); // sc-00 (A) + sc-01 (B), both known from the start
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
    const s = scoped(indexer);
    s.withMembershipBatch(() => {
      expect(indexer.get("sc-00-topic")!.qitemIds).toEqual([]); // scope1 builds the generation
    });
    insertQitem(db, { qitemId: "q-scope-b", body: "no mention", tags: ["slice:sc-01-topic"] });
    s.withMembershipBatch(() => {
      // B 已为 scope1 batch 所知；复用 stale generation 会返回 []，新的 scope2 open 必须看到新 row。
      expect(indexer.get("sc-01-topic")!.qitemIds).toEqual(["q-scope-b"]);
    });
  });

  it("嵌套 scope 共享最外层 batch，且只在最外层退出时清除", () => {
    const root = seedSlices(4);
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
    const s = scoped(indexer);
    const scans = instrumentScans(db);
    s.withMembershipBatch(() => {
      indexer.get("sc-00-topic");
      s.withMembershipBatch(() => {
        indexer.get("sc-01-topic");
      });
      // 内层退出不得清除共享 batch。
      indexer.get("sc-02-topic");
    });
    expect(scans()).toBeLessThanOrEqual(4);
    // 最外层退出后 batch 消失，后续写入可见。
    insertQitem(db, { qitemId: "q-after-scope", body: "no mention", tags: ["slice:sc-03-topic"] });
    expect(indexer.get("sc-03-topic")!.qitemIds).toEqual(["q-after-scope"]);
  });

  it("scope 内发生 EXCEPTION 仍会在 finally 退出时清除，使下一 operation 为 fresh", () => {
    const root = seedSlices(2);
    const indexer = new SliceIndexer({ slicesRoot: root, dogfoodEvidenceRoot: null, db });
    const s = scoped(indexer);
    expect(() => s.withMembershipBatch(() => {
      indexer.get("sc-00-topic");
      throw new Error("boom");
    })).toThrow("boom");
    insertQitem(db, { qitemId: "q-post-throw", body: "no mention", tags: ["slice:sc-01-topic"] });
    expect(indexer.get("sc-01-topic")!.qitemIds).toEqual(["q-post-throw"]);
  });
});

// ---------------------------------------------------------------------------
// qitem-render-driver #3——现代任务目标上的 mission-wide qitemCount 泄漏。
//
// 主机证据：/api/slices 为 placeholder slice 02/03 发出 qitemCount=355，而 sibling 报告
// 1/1/2。根因：对 ZERO-TYPED slice，matchQitems 回退到 [sliceName, railItem, missionId] 的
// 子串并集；未编写 rail item 时，extractRailItem 默认把 railItem 设为 missionId，导致 canonical
// multi-slice mission 中的 placeholder slice 以子串方式匹配 corpus 中每个带 mission tag 的 qitem。
//
// 不删除 legacy 原则：corpus 早于 typed membership 的任务目标仍应用 mission-body fallback，
// 由上方现有“保留 legacy substring fallback（包括 mission body）”测试固定。这里的 discriminator
// 是现代任务目标，其中 sibling slice 携带 typed `slice:` membership；mission-only row 不得计入
// zero-typed target，但 target 自身名称和显式 rail-item 仍匹配。
// ---------------------------------------------------------------------------

describe("qitem-render-driver #3——现代任务目标：mission-only row 不得泄漏到 zero-typed slice", () => {
  let db: Database.Database;
  let cleanup: string;
  let missionsRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-leak-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  /** canonical 现代任务目标：typed sibling 证明 corpus 已采用 typed membership；target slice
   *  未编写 rail item（因此 railItem 默认为 missionId），也不携带 typed row。 */
  function seedModernMission(): void {
    const slices = path.join(missionsRoot, "release-x", "slices");
    writeSlice(slices, "01-typed-sibling", { "README.md": "---\nstatus: active\n---\n# sibling\n" });
    writeSlice(slices, "02-placeholder", { "README.md": "---\nstatus: placeholder\n---\n# placeholder\n" });
    // 此任务目标存在 typed membership（现代 signal）。
    insertQitem(db, { qitemId: "q-typed-sibling", body: "no name mention", tags: ["slice:01-typed-sibling"] });
    // 任务目标范围 row：只带任务目标 tag 或只提到任务目标；这些 355 类 row 不得计入
    // 02-placeholder。
    insertQitem(db, { qitemId: "q-mission-tag", body: "no slice mention", tags: ["mission:release-x"] });
    insertQitem(db, { qitemId: "q-mission-body", body: "advance the release-x mission", tags: [] });
  }

  it("RED：现代任务目标中的 zero-typed slice 不吸收 mission-only row", () => {
    seedModernMission();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const target = indexer.get("02-placeholder")!;
    expect(target.qitemIds, "mission-only rows must not be credited to a zero-typed slice").toEqual([]);
  });

  it("RED（路由可观测）：该 slice 的 /api/slices qitemCount 为 0，而非任务目标聚合值", () => {
    seedModernMission();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const entry = indexer.list().find((e) => e.name === "02-placeholder")!;
    expect(entry.qitemCount, "the count the sidebar badge renders").toBe(0);
  });

  it("GREEN pin：body 中 target 自身名称仍匹配，保留 name-legacy match", () => {
    seedModernMission();
    insertQitem(db, { qitemId: "q-by-target-name", body: "work on 02-placeholder today", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("02-placeholder")!.qitemIds).toContain("q-by-target-name");
  });

  it("GREEN pin：显式编写的 rail-item 仍匹配，保留 explicit-rail legacy match", () => {
    const slices = path.join(missionsRoot, "release-y", "slices");
    writeSlice(slices, "01-typed-sib", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(slices, "02-railed", { "README.md": "---\nstatus: active\nrail-item: PL-777\n---\n" });
    insertQitem(db, { qitemId: "q-typed-y", body: "x", tags: ["slice:01-typed-sib"] });
    insertQitem(db, { qitemId: "q-by-explicit-rail", body: "PL-777 follow-up", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("02-railed")!.qitemIds).toContain("q-by-explicit-rail");
  });

  it("GREEN pin：typed sibling 保持自身 typed membership 不变", () => {
    seedModernMission();
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    expect(indexer.get("01-typed-sibling")!.qitemIds).toEqual(["q-typed-sibling"]);
  });
});

// ---------------------------------------------------------------------------
// qitem-18110994——SliceIndexer membership 加固（guard-locked acceptance）。
//
// R1/R2/R4 曾在仅测试 gate 中是真实 RED（针对加固前 indexer 失败），现在作为回归 pin 保护正式
// 行为；R3/R5 始终是 GREEN characterization/differential pin。
//
// fccce9ac 的 advisory 根因：扫描前预填充 fallback bucket，宽泛 catch 让部分填充的 map 被发布
// 并缓存（item 2）；typed-scan catch 把任何 failure 都记录为“tags column missing”（item 4）；
// 两个 500 上限都没有边界 pin（item 3）；即使 standalone detail op 只服务一个 slice，
// fallback-term 派生仍会读取每个已知位置的 frontmatter（item 1）。
// ---------------------------------------------------------------------------

/** 按 SQL 子串为 prepared statement 启用/关闭 fault，并统计执行次数。DB 层是唯一真实的中断源：
 *  canonical `body` 列为 TEXT NOT NULL，因此 row-time null throw 不符合实际。 */
function instrumentDb(target: Database.Database) {
  const state = {
    faultOn: null as string | null,
    faultAfterRows: 0,
    counts: new Map<string, number>(),
  };
  const origPrepare = target.prepare.bind(target);
  (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = origPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const flat = sql.replace(/\s+/g, " ");
    const bump = () => state.counts.set(flat, (state.counts.get(flat) ?? 0) + 1);
    return {
      ...stmt,
      all: (...a: unknown[]) => { bump(); return stmt.all!(...a); },
      get: (...a: unknown[]) => { bump(); return stmt.get!(...a); },
      run: (...a: unknown[]) => stmt.run!(...a),
      iterate: (...a: unknown[]) => {
        bump();
        const inner = stmt.iterate!(...a) as Iterable<unknown>;
        const armed = state.faultOn !== null && flat.includes(state.faultOn);
        if (!armed) return inner;
        const after = state.faultAfterRows;
        return (function* () {
          let n = 0;
          for (const row of inner) {
            if (n >= after) throw new Error("injected scan fault");
            n++;
            yield row;
          }
          throw new Error("injected scan fault");
        })();
      },
    };
  };
  return {
    state,
    countFor: (needle: string) => {
      let total = 0;
      for (const [sql, n] of state.counts) if (sql.includes(needle)) total += n;
      return total;
    },
    reset: () => state.counts.clear(),
  };
}

const TYPED_SCAN_SQL = "WHERE tags LIKE '%slice:%'";
// 通过共同 prefix 覆盖两种 fallback 结构：带 tags 的
// `SELECT qitem_id, body, tags FROM queue_items`，以及 typed scan 被误分类为缺少 tags 列时
// 选择的纯 body `SELECT qitem_id, body FROM queue_items`。只统计带 tags 形式，会在恰好被测的
// 误分类场景中错误报告 0。
const FALLBACK_SCAN_SQL = "SELECT qitem_id, body";

describe("qitem-18110994——membership build 完整性 + scoping", () => {
  let db: Database.Database;
  let cleanup: string;
  let missionsRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "slice-indexer-harden-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
    vi.mocked(fs.readFileSync).mockClear();
  });

  /** legacy 任务目标；任何位置都没有 typed membership，因此会运行 fallback 层。 */
  function seedLegacy(): void {
    const slices = path.join(missionsRoot, "legacy-mission", "slices");
    writeSlice(slices, "01-target", { "README.md": "---\nstatus: active\n---\n# t\n" });
    insertQitem(db, { qitemId: "q-a", body: "work on 01-target now", tags: [] });
    insertQitem(db, { qitemId: "q-b", body: "more 01-target work", tags: [] });
    insertQitem(db, { qitemId: "q-c", body: "unrelated packet", tags: [] });
  }

  it("R1 回归：中断的 fallback scan 拒绝回答，不产生部分 membership 或 detail cache；后续 clean get 返回完整集合", () => {
    seedLegacy();
    const probe = instrumentDb(db);
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });

    // iteration 中途 fault：消费一条 row 后抛错。
    probe.state.faultOn = FALLBACK_SCAN_SQL;
    probe.state.faultAfterRows = 1;
    expect(
      () => indexer.get("01-target"),
      "中断的 fallback build 必须拒绝回答，不能返回 subset",
    ).toThrow("injected scan fault");

    // 解除 fault：同一个 indexer 必须重建并返回完整集合，证明失败尝试既未发布部分 membership
    // index，也未发布 detail cache entry。
    probe.state.faultOn = null;
    const record = indexer.get("01-target");
    expect(record, "clean retry 必须在同一 indexer 上成功").toBeTruthy();
    expect(record!.qitemIds.sort(), "必须是完整 membership，绝不能是部分 subset").toEqual(["q-a", "q-b"]);
  });

  it("R2 回归：tags 存在时 typed-scan fault 抛错，不运行 fallback scan；同一 indexer 重试后干净重建", () => {
    seedLegacy();
    const probe = instrumentDb(db);
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });

    probe.state.faultOn = TYPED_SCAN_SQL;
    probe.state.faultAfterRows = 0;
    expect(
      () => indexer.get("01-target"),
      "tags 列存在时 typed-scan failure 必须传播，不能记录为 tags 列缺失",
    ).toThrow("injected scan fault");
    expect(
      probe.countFor(FALLBACK_SCAN_SQL),
      "被拒绝的 build 不得继续 fallback scan",
    ).toBe(0);

    probe.state.faultOn = null;
    probe.reset();
    const record = indexer.get("01-target");
    expect(record!.qitemIds.sort()).toEqual(["q-a", "q-b"]);
  });

  it("R3 GREEN（typed 上限）：接受第 500 个 confirmed row，拒绝第 501 个；扫描顺序中更早的 false prefilter candidate 不占上限", () => {
    const slices = path.join(missionsRoot, "cap-mission", "slices");
    writeSlice(slices, "01-capped", { "README.md": "---\nstatus: active\n---\n" });
    // Typed scan 顺序为 ts_created DESC、qitem_id DESC。把 false prefilter candidate 按该顺序
    // 放在最前（最新 ts），这样若它们消耗 confirmed 上限，target 就达不到 500。
    for (let i = 0; i < 50; i++) {
      insertQitem(db, {
        qitemId: `q-other-${String(i).padStart(4, "0")}`,
        body: "x",
        tags: ["slice:99-elsewhere"],
        tsCreated: "2026-07-21T00:00:00.000Z",
      });
    }
    // 501 个 CONFIRMED row 共享同一 ts，因此扫描顺序完全由 qitem_id DESC 决定：
    // q-typed-0500 最先，q-typed-0000 最后。
    for (let i = 0; i <= 500; i++) {
      insertQitem(db, {
        qitemId: `q-typed-${String(i).padStart(4, "0")}`,
        body: "no name mention",
        tags: ["slice:01-capped"],
        tsCreated: "2026-07-20T00:00:00.000Z",
      });
    }
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const ids = indexer.get("01-capped")!.qitemIds;
    expect(ids.length, "exactly the 500-confirmed cap").toBe(500);
    // 精确边界：q-typed-0001 是扫描顺序中第 500 个 confirmed row，应接受；
    // q-typed-0000 是第 501 个，应拒绝。
    expect(ids, "the 500th confirmed row must be accepted").toContain("q-typed-0001");
    expect(ids, "the 501st confirmed row must be rejected").not.toContain("q-typed-0000");
    expect(ids.some((id) => id.startsWith("q-other-")), "no foreign-slice prefilter candidate may be credited").toBe(false);
  });

  it("R3 GREEN（fallback 上限）：接受第 500 个 matching row，拒绝第 501 个；先插入的 sibling-term prefilter hit 不占上限", () => {
    const slices = path.join(missionsRoot, "legacy-cap", "slices");
    writeSlice(slices, "01-alpha", { "README.md": "---\nstatus: active\n---\n" });
    writeSlice(slices, "02-beta", { "README.md": "---\nstatus: active\n---\n" });
    // fallback scan 按 ROWID 顺序迭代，因此 sibling-term row 必须先插入；若它们消耗
    // 01-alpha 的逐 term 上限，target 就达不到 500。
    for (let i = 0; i < 50; i++) {
      insertQitem(db, { qitemId: `q-beta-${String(i).padStart(4, "0")}`, body: "touching 02-beta here", tags: [] });
    }
    for (let i = 0; i <= 500; i++) {
      insertQitem(db, { qitemId: `q-alpha-${String(i).padStart(4, "0")}`, body: "touching 01-alpha here", tags: [] });
    }
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const ids = indexer.get("01-alpha")!.qitemIds;
    expect(ids.length, "exactly the 500 per-term cap").toBe(500);
    // rowid 顺序的精确边界：q-alpha-0499 是第 500 个 match（接受）；q-alpha-0500 是第 501 个
    //（拒绝）。
    expect(ids, "the 500th matching row must be accepted").toContain("q-alpha-0499");
    expect(ids, "the 501st matching row must be rejected").not.toContain("q-alpha-0500");
    expect(ids.some((id) => id.startsWith("q-beta-")), "no sibling-term prefilter hit may be credited").toBe(false);
  });

  it("R4 回归：standalone get(X) 不读取无关 slice 路径下的 Markdown", () => {
    const slices = path.join(missionsRoot, "wide-mission", "slices");
    for (let i = 0; i < 6; i++) {
      writeSlice(slices, `s-${i}-topic`, {
        "README.md": "---\nstatus: active\n---\n# s\n",
        "IMPLEMENTATION-PRD.md": "---\nrail-item: PL-1\n---\n# prd\n",
        "PROGRESS.md": "---\nstatus: active\n---\n# p\n",
      });
    }
    insertQitem(db, { qitemId: "q-only", body: "unrelated", tags: [] });
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });

    // fixture 创建后再清空，使观测范围只有当前服务 operation。
    vi.mocked(fs.readFileSync).mockClear();
    indexer.get("s-0-topic");

    const readPaths = vi.mocked(fs.readFileSync).mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.endsWith(".md"));
    const foreign = readPaths.filter((p) => !p.includes(`${path.sep}s-0-topic${path.sep}`));
    expect(
      foreign,
      `a standalone detail op must not read frontmatter for unrelated slices; read ${foreign.length}: ${foreign.slice(0, 3).join(", ")}`,
    ).toEqual([]);
  });

  it("R5 GREEN：现代任务目标上 full-scope batch get 与 standalone narrowed get 返回逐字节相同 qitemId", () => {
    const slices = path.join(missionsRoot, "modern-mission", "slices");
    writeSlice(slices, "01-typed-sib", { "README.md": "---\nstatus: active\n---\n" });
    // 带显式 authored rail 的 zero-typed target：必须保留 own-name + explicit rail，排除
    // missionId 和由 mission 默认得到的 rail。
    writeSlice(slices, "02-target", { "README.md": "---\nstatus: active\nrail-item: PL-777\n---\n" });
    insertQitem(db, { qitemId: "q-typed", body: "x", tags: ["slice:01-typed-sib"] });
    insertQitem(db, { qitemId: "q-by-name", body: "work on 02-target", tags: [] });
    insertQitem(db, { qitemId: "q-by-rail", body: "PL-777 follow-up", tags: [] });
    insertQitem(db, { qitemId: "q-mission-only", body: "advance the modern-mission mission", tags: [] });

    const a = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const fullScope = a.withMembershipBatch(() => a.get("02-target")!.qitemIds);

    const b = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
    const standalone = b.get("02-target")!.qitemIds;

    expect(standalone, "narrowing reads must not move the eligibility verdict").toEqual(fullScope);
    expect(standalone.sort(), "own-name + explicit-rail retained; mission/default rail excluded")
      .toEqual(["q-by-name", "q-by-rail"]);
  });
});
