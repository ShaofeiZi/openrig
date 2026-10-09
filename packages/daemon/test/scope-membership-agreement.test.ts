// 标准范围成员关系匹配器（VM-003 + VM-004）——一致性测试（消除整类缺陷）。
// 使用一个预置 queue_items 夹具；四个历史上存在分歧的匹配器（matchQitems -> qitemIds、
// agentsForSlices -> 区域、hasActiveQitem -> 阶段信号、attentionForTag -> NeedsYou）
// 必须对以下成员关系达成一致：干净标签、逗号内嵌旧版标签、未索引 slice 上带任务标签的
// qitem，以及反例（slice:X 后缀过度匹配、同级名称、仅正文提及）。同时覆盖过度匹配
// 反例与匹配不足正例。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";

const NOW = "2026-07-11T12:00:00.000Z";

function writeSlice(root: string, rel: string, name: string): void {
  const dir = path.join(root, rel, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `---\nstatus: active\n---\n# ${name}\n`);
}

function insertQitem(
  db: Database.Database,
  opts: { id: string; dest: string; tags: string[]; body?: string; tier?: string | null; state?: string },
): void {
  db.prepare(
    `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, summary)
     VALUES (?, ?, ?, 'src@rig', ?, ?, 'high', ?, ?, ?, ?)`,
  ).run(
    opts.id,
    NOW,
    NOW,
    opts.dest,
    opts.state ?? "in-progress",
    opts.tier ?? null,
    JSON.stringify(opts.tags),
    opts.body ?? "body",
    opts.id,
  );
}

describe("范围成员关系一致性（VM-003 + VM-004 整类缺陷消除器）", () => {
  let missionsRoot: string;
  let cleanup: string;
  let db: Database.Database;

  beforeEach(() => {
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "scope-agreement-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    // 任务 "relx" 含已索引的 slice：受测 target、sibling 与 legacyonly。
    writeSlice(missionsRoot, path.join("relx", "slices"), "target");
    writeSlice(missionsRoot, path.join("relx", "slices"), "sibling");
    writeSlice(missionsRoot, path.join("relx", "slices"), "legacyonly");
    db = createDb(":memory:");
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueItemSummarySchema]);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  function seedFixture(): void {
    // --- slice:target 的成员 ---
    insertQitem(db, { id: "qc", dest: "alice@rig", tags: ["mission:relx", "slice:target"] }); // 干净标签
    insertQitem(db, { id: "ql", dest: "bob@rig", tags: ["mission:relx,slice:target"] }); // 逗号旧版格式（VM-003）
    // --- 反例（必须处处排除）---
    insertQitem(db, { id: "qsuf", dest: "carol@rig", tags: ["slice:target-extra"] }); // 后缀过度匹配
    insertQitem(db, { id: "qsib", dest: "dave@rig", tags: ["slice:sibling"] }); // 同级
    insertQitem(db, { id: "qbody", dest: "erin@rig", tags: [], body: "在此处理 target" }); // 仅正文提及
    // --- 任务直接成员（C3）---
    insertQitem(db, { id: "qmis", dest: "frank@rig", tags: ["mission:relx"] });
    // --- 用于验证 attentionForTag 一致性的 human-gate 行 ---
    insertQitem(db, { id: "qhg_member", dest: "grace@rig", tags: ["mission:relx,slice:target"], tier: "human-gate" });
    insertQitem(db, { id: "qhg_non", dest: "heidi@rig", tags: ["slice:target-extra"], tier: "human-gate" });
    // --- 无类型旧版语料（子字符串层仍须运行）---
    insertQitem(db, { id: "qleg", dest: "ivan@rig", tags: [], body: "legacyonly 发布记录" });
  }

  function makeIndexerAndGatherer() {
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    return { indexer, gatherer };
  }

  it("matchQitems（qitemIds）：类型化来源权威，包含逗号旧版，排除后缀/同级/正文", () => {
    seedFixture();
    const { indexer } = makeIndexerAndGatherer();
    const ids = new Set(indexer.get("target")?.qitemIds ?? []);
    expect(ids.has("qc")).toBe(true); // 干净标签
    expect(ids.has("ql")).toBe(true); // 逗号旧版格式（VM-003）
    expect(ids.has("qhg_member")).toBe(true); // 逗号旧版成员（human-gate）
    expect(ids.has("qsuf")).toBe(false); // 后缀过度匹配（VM-004）
    expect(ids.has("qsib")).toBe(false); // 同级
    expect(ids.has("qbody")).toBe(false); // 正文提及（存在类型化行 -> 跳过子字符串层）
    expect(ids.has("qmis")).toBe(false); // 仅任务成员，不是 slice 成员
  });

  it("agentsForSlices 区域（slice 范围）：包含逗号旧版席位，排除反例与仅任务成员", () => {
    seedFixture();
    const { gatherer } = makeIndexerAndGatherer();
    const band = gatherer.composeAgents("slice:target");
    const sessions = new Set((band?.rows ?? []).map((r) => r.sessionName));
    expect(sessions.has("alice@rig")).toBe(true); // 干净标签
    expect(sessions.has("bob@rig")).toBe(true); // 逗号旧版格式（VM-003 修复）
    expect(sessions.has("carol@rig")).toBe(false); // 后缀
    expect(sessions.has("dave@rig")).toBe(false); // 同级
    expect(sessions.has("erin@rig")).toBe(false); // 正文提及
    expect(sessions.has("frank@rig")).toBe(false); // 仅任务成员 -> 不在 slice 区域
  });

  it("hasActiveQitem 与区域保持一致（阶段/区域一致性固定）", () => {
    seedFixture();
    const { indexer, gatherer } = makeIndexerAndGatherer();
    const rec = indexer.get("target")!;
    const active = (gatherer as unknown as { hasActiveQitem(n: string, s: unknown): boolean }).hasActiveQitem("target", rec);
    const band = gatherer.composeAgents("slice:target");
    expect(active).toBe(true);
    // 一致性：存在活跃工作 => 区域至少有一行（已消除“一次组合、两个答案”）。
    expect((band?.rows.length ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("attentionForTag 保持一致：包含逗号旧版成员，排除后缀过度匹配", () => {
    seedFixture();
    const { gatherer } = makeIndexerAndGatherer();
    const attn = (gatherer as unknown as { attentionForTag(t: string): Array<{ qitemId: string }> }).attentionForTag("slice:target");
    const ids = new Set(attn.map((a) => a.qitemId));
    expect(ids.has("qhg_member")).toBe(true); // 逗号旧版成员（已修复匹配不足）
    expect(ids.has("qhg_non")).toBe(false); // 标准确认拒绝后缀过度匹配
  });

  it("任务区域（C3）：即使没有已索引 slice 标签，任务标签直接席位也会出现", () => {
    seedFixture();
    const { gatherer } = makeIndexerAndGatherer();
    const band = gatherer.composeAgents("mission:relx");
    const sessions = new Set((band?.rows ?? []).map((r) => r.sessionName));
    expect(sessions.has("frank@rig")).toBe(true); // 带 mission:relx 标签，无 slice 标签（C3 修复）
    expect(sessions.has("alice@rig")).toBe(true); // slice 成员仍通过并集出现
  });

  it("任务关注项排除携带 slice 标签的行（d2 excludeTagPrefix，识别逗号旧版格式）", () => {
    seedFixture();
    const { gatherer } = makeIndexerAndGatherer();
    const attn = (gatherer as unknown as { attentionForTag(t: string, ex?: string): Array<{ qitemId: string }> }).attentionForTag("mission:relx", "slice:");
    const ids = new Set(attn.map((a) => a.qitemId));
    // qhg_member 是携带 slice:target 的逗号旧版行 -> 从任务关注项中排除
    //（d2：原始 startsWith 无法识别逗号旧版格式；标准集合可以）。
    expect(ids.has("qhg_member")).toBe(false);
  });

  it("分层门禁：无类型语料仍通过保留的子字符串回退匹配", () => {
    seedFixture();
    const { indexer } = makeIndexerAndGatherer();
    const ids = new Set(indexer.get("legacyonly")?.qitemIds ?? []);
    // 没有类型化 slice:legacyonly 行 -> typedTagMatchCount 为 0 -> 子字符串层在
    // [sliceName, railItem, missionId] 上运行，并匹配正文提及。
    expect(ids.has("qleg")).toBe(true);
  });
});

describe("范围成员关系字节一致性例外（干净语料，零回归）", () => {
  let missionsRoot: string;
  let cleanup: string;
  let db: Database.Database;

  beforeEach(() => {
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "scope-carve-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    writeSlice(missionsRoot, path.join("relx", "slices"), "target");
    db = createDb(":memory:");
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueItemSummarySchema]);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  it("干净的单成员 slice 区域匹配变更前固定的字面值", () => {
    insertQitem(db, { id: "qc", dest: "alice@rig", tags: ["mission:relx", "slice:target"] });
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    const band = gatherer.composeAgents("slice:target");
    // 固定预期（结构良好语料在变更前的行为）。
    expect(band).toEqual({
      scope: "slice:target",
      rows: [
        {
          agentName: "alice",
          runtime: "unknown",
          stateGlyph: "unknown",
          doing: "qc",
          holdsCount: 1,
          lastTransitionIso: NOW,
          exception: null,
          sessionName: "alice@rig",
          slices: ["target"],
        },
      ],
      provenance: `根据队列计算于 ${NOW}`,
      coordinationHealth: null,
    });
  });

  it("空的干净区域保持确定性来源字符串逐字节一致（C4 无变更）", () => {
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    const band = gatherer.composeAgents("slice:target");
    expect(band?.rows).toEqual([]);
    expect(band?.provenance).toBe(`没有正在或近期持有工作的智能体 · 根据队列计算于 ${NOW}`);
  });
});

// v1.4 回修回归——让双层原则变得可观察。
describe("范围成员关系 B1/B2/P2 阻塞项回归（回修）", () => {
  let missionsRoot: string;
  let cleanup: string;
  let db: Database.Database;

  beforeEach(() => {
    cleanup = fs.mkdtempSync(path.join(os.tmpdir(), "scope-fixback-"));
    missionsRoot = path.join(cleanup, "missions");
    fs.mkdirSync(missionsRoot, { recursive: true });
    for (const s of ["target", "sibling", "legacyonly", "tie-slice"]) {
      writeSlice(missionsRoot, path.join("relx", "slices"), s);
    }
    db = createDb(":memory:");
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueItemSummarySchema]);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(cleanup, { recursive: true, force: true });
  });

  function harness() {
    const indexer = new SliceIndexer({ slicesRoot: missionsRoot, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    return { indexer, gatherer };
  }

  it("§3.9 B1：无类型且仅正文提及的行出现在展示层，但不出现在信号层（阶段/区域一致）", () => {
    // legacyonly 没有类型化 slice: 行；有一个活跃且仅正文提及的 qitem。
    insertQitem(db, { id: "q-body-legacy", dest: "leg@rig", tags: [], body: "推进 legacyonly 发布" });
    const { indexer, gatherer } = harness();
    // 展示层（queue-tab qitemIds）：旧版子字符串回退会保留它。
    const rec = indexer.get("legacyonly")!;
    expect(new Set(rec.qitemIds).has("q-body-legacy")).toBe(true);
    // 信号层：hasActiveQitem 为 false（已删除分支 2），且区域为空 -> 一致。将索引记录
    // 作为可选第二参数传入，使两个候选上的差异都是真实行为差异（而非签名崩溃）：
    // 冻结的 302036aa 签名 hasActiveQitem(name, slice) 会使用它——分支 2 读取包含展示层
    // 仅正文 ID 的 rec.qitemIds，因而返回 true（区域为空但阶段为 BUILD 的分歧）；修复后的
    // cab26bb0 hasActiveQitem(name) 忽略额外参数并返回 false。
    const active = (gatherer as unknown as { hasActiveQitem(n: string, s?: unknown): boolean }).hasActiveQitem("legacyonly", rec);
    const band = gatherer.composeAgents("slice:legacyonly");
    expect(active).toBe(false); // 302036aa 返回 true（收到）；B1 修复使其为 false
    expect(band?.rows).toEqual([]);
  });

  it("§3.10 B2 后缀风暴：真实行前有 >500 个 slice:target-extra 诱饵——保留真实成员、关闭回退、阶段为 true", () => {
    // 先写入诱饵（在 302036aa 中，它们会填满确认前 LIMIT-500 窗口并隐藏真实行）。
    const seedDecoys = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        insertQitem(db, { id: `q-decoy-${String(i).padStart(3, "0")}`, dest: "decoy@rig", tags: ["slice:target-extra"] });
      }
    });
    seedDecoys(550);
    insertQitem(db, { id: "q-true-target", dest: "truebuilder@rig", tags: ["slice:target"] });
    insertQitem(db, { id: "q-body-target", dest: "bodyer@rig", tags: [], body: "此处为 target 的记录" });
    const { indexer, gatherer } = harness();
    const ids = new Set(indexer.get("target")?.qitemIds ?? []);
    expect(ids.has("q-true-target")).toBe(true); // 即使存在风暴仍保留（确认前不截断）
    expect(ids.has("q-body-target")).toBe(false); // 已确认类型化项 >=1 -> 关闭子字符串回退
    expect(ids.has("q-decoy-000")).toBe(false); // 标准确认拒绝后缀过度匹配
    // 信号层不受截断影响：hasActiveQitem 为 true，区域仅显示真实席位。
    const active = (gatherer as unknown as { hasActiveQitem(n: string): boolean }).hasActiveQitem("target");
    expect(active).toBe(true);
    const sessions = new Set((gatherer.composeAgents("slice:target")?.rows ?? []).map((r) => r.sessionName));
    expect(sessions.has("truebuilder@rig")).toBe(true);
    expect(sessions.has("decoy@rig")).toBe(false);
    expect(sessions.has("bodyer@rig")).toBe(false);
  });

  it("§3.10a P2 并列向量：两个可确认行共享同一 ts_created——多次运行保持确定性 ID 降序", () => {
    insertQitem(db, { id: "qtie-a", dest: "a@rig", tags: ["slice:tie-slice"] });
    insertQitem(db, { id: "qtie-b", dest: "b@rig", tags: ["slice:tie-slice"] }); // 相同 ts_created（NOW）
    const { indexer } = harness();
    const mq = indexer as unknown as { matchQitems(s: string, r: string | null, m: string | null): string[] };
    const first = mq.matchQitems("tie-slice", null, "relx");
    const second = mq.matchQitems("tie-slice", null, "relx");
    expect(first).toEqual(second); // 时间戳相同时仍具确定性
    expect(first).toEqual(["qtie-b", "qtie-a"]); // qitem_id 降序打破并列（P2）
  });
});
