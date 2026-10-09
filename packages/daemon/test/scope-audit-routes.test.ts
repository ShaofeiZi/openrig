import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
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
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { scopeAuditRoutes } from "../src/routes/scope-audit.js";

function buildApp(indexer: SliceIndexer): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, indexer);
    await next();
  });
  app.route("/api/scope/audit", scopeAuditRoutes());
  return app;
}

const VALID_MISSION_BRIEF = [
  "# 测试任务目标——摘要",
  "",
  "## 内容与原因",
  "## Building",
  "## Progress",
  "## Proven",
  "## Needs you",
  "## Pointers",
].join("\n");

function validSliceReadme(frontmatter: string, title = "slice"): string {
  return `${frontmatter}
# ${title}

## Intent

证明切片结构通过 SDLC 约定字段进行投影。

## Mini-requirements

1. 切片携带相称的需求列表。

## Proof contract

- [ ] 证明 artifact 映射到声明的需求。
`;
}

let db: Database.Database;
let cleanupRoot: string;
let missionsRoot: string;
let indexer: SliceIndexer;
let app: Hono;

beforeEach(() => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
  cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-audit-routes-"));
  missionsRoot = path.join(cleanupRoot, "missions");
  fs.mkdirSync(missionsRoot, { recursive: true });
  indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
  app = buildApp(indexer);
});

afterEach(() => {
  db.close();
  fs.rmSync(cleanupRoot, { recursive: true, force: true });
});

describe("GET /api/scope/audit", () => {
  it("缺少 mission 参数时返回 400", async () => {
    const res = await app.request("/api/scope/audit");
    expect(res.status).toBe(400);
  });

  it("mission 不存在时返回 404", async () => {
    const res = await app.request("/api/scope/audit?mission=nonexistent");
    expect(res.status).toBe(404);
  });

  it("对仅当前版、仅旧版、两者兼有和两者皆无使用同一 notes 优先级", async () => {
    for (const [name, files, missing] of [
      ["current", ["NOTES.md"], false],
      ["legacy", ["MISSION_NOTES.md"], false],
      ["both", ["NOTES.md", "MISSION_NOTES.md"], false],
      ["neither", [], true],
    ] as const) {
      const missionName = `notes-${name}`;
      const missionDir = path.join(missionsRoot, missionName);
      fs.mkdirSync(missionDir, { recursive: true });
      fs.writeFileSync(path.join(missionDir, "SPEC.md"), `---\nid: OPR.8.9.${name.length}\nintent: notes\n---\n# notes\n`, "utf8");
      fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
      for (const file of files) fs.writeFileSync(path.join(missionDir, file), file, "utf8");

      const response = await app.request(`/api/scope/audit?mission=${missionName}`);
      const body = await response.json() as { mission: { findings: Array<{ kind: string; message: string }> } };
      const finding = body.mission.findings.find((item) => item.kind === "missing_mission_notes");
      expect(Boolean(finding), name).toBe(missing);
      if (finding) expect(finding.message).toMatch(/NOTES\.md.*MISSION_NOTES\.md/);
    }
  });

  // SPEC.md 兼容性——若没有此项，同时携带两个已编写文件的节点将不可见。按结构属于建议：
  // 严重度较低，且 `ok` 必须保持 true，因此绝不会阻塞构建。
  it("mission 与 slice 各自同时包含 SPEC.md 和 README.md 时给出建议（绝不阻塞）", async () => {
    const missionDir = path.join(missionsRoot, "both-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "SPEC.md"), "---\nid: OPR.99.0.2\n---\n# live\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.2\n---\n# stale\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "01-both");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "SPEC.md"), "---\nid: OPR.99.0.2.1\n---\n# live\n", "utf8");
    fs.writeFileSync(path.join(sliceDir, "README.md"), "---\nid: OPR.99.0.2.1\n---\n# stale\n", "utf8");
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=both-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      mission: { findings: Array<{ kind: string; severity: string; message: string }> };
      slices: Array<{ name: string; findings: Array<{ kind: string; severity: string }> }>;
    };

    const m = body.mission.findings.find((f) => f.kind === "shadowed_node_file");
    expect(m).toBeDefined();
    expect(m!.severity).toBe("low");
    expect(m!.message).toContain("SPEC.md");
    const sl = body.slices.find((s) => s.name === "01-both")!.findings.find((f) => f.kind === "shadowed_node_file");
    expect(sl).toBeDefined();
    expect(sl!.severity).toBe("low");
  });

  it("对只有一个已编写文件的节点不作提示", async () => {
    const missionDir = path.join(missionsRoot, "single-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "SPEC.md"), "---\nid: OPR.99.0.3\n---\n# only\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=single-mission");
    const body = await res.json() as { mission: { findings: Array<{ kind: string }> } };
    expect(body.mission.findings.some((f) => f.kind === "shadowed_node_file")).toBe(false);
  });

  it("没有 README 和 PROGRESS 的 NN-slug 切片目录发出 missing_id + missing_progress", async () => {
    const missionDir = path.join(missionsRoot, "test-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.1\n---\n# test\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "02-bare");
    fs.mkdirSync(sliceDir, { recursive: true });

    const res = await app.request("/api/scope/audit?mission=test-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; slices: Array<{ name: string; findings: Array<{ kind: string }> }> };
    expect(body.ok).toBe(false);
    const bare = body.slices.find((s) => s.name === "02-bare");
    expect(bare).toBeDefined();
    expect(bare!.findings.some((f) => f.kind === "missing_id")).toBe(true);
    expect(bare!.findings.some((f) => f.kind === "missing_progress")).toBe(true);
  });

  it("orphan_progress：切片有 PROGRESS.md 但没有 README.md", async () => {
    const missionDir = path.join(missionsRoot, "test-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.1\n---\n# test\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "03-orphan");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=test-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; slices: Array<{ name: string; railStatus: string; findings: Array<{ kind: string }> }> };
    expect(body.ok).toBe(false);
    const orphan = body.slices.find((s) => s.name === "03-orphan");
    expect(orphan).toBeDefined();
    expect(orphan!.railStatus).toBe("malformed");
    expect(orphan!.findings.some((f) => f.kind === "orphan_progress")).toBe(true);
  });

  it("包含有效切片的干净 mission 返回 ok:true", async () => {
    const missionDir = path.join(missionsRoot, "clean-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.2\n---\n# clean\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_BRIEF.md"), VALID_MISSION_BRIEF, "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_NOTES.md"), "# Notes\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "01-good");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"), validSliceReadme("---\nid: OPR.99.0.2.1\n---", "good"), "utf8");
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=clean-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; totalFindings: number };
    expect(body.ok).toBe(true);
    expect(body.totalFindings).toBe(0);
  });

  it("显示建议性依赖图，并如实呈现 ready、waiting 和 malformed-edge", async () => {
    const missionName = "graph-mission";
    const missionDir = path.join(missionsRoot, missionName);
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "SPEC.md"), "---\nid: OPR.9.8.6\nintent: graph\ndepends_on: []\n---\n# graph\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "NOTES.md"), "# Notes\n", "utf8");

    const writeSlice = (bucket: "slices" | "closed", name: string, id: string, dependsOn: string): void => {
      const sliceDir = path.join(missionDir, bucket, name);
      fs.mkdirSync(sliceDir, { recursive: true });
      fs.writeFileSync(
        path.join(sliceDir, "SPEC.md"),
        validSliceReadme(`---\nid: ${id}\nstatus: active\ndepends_on: ${dependsOn}\n---`, name),
        "utf8",
      );
      if (bucket === "slices") fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");
    };
    writeSlice("closed", "01-foundation", "OPR.9.8.6.1", "[]");
    writeSlice("slices", "02-ready", "OPR.9.8.6.2", "[OPR.9.8.6.1]");
    writeSlice("slices", "03-waiting", "OPR.9.8.6.3", "[OPR.9.8.6.4]");
    writeSlice("slices", "04-active-dependency", "OPR.9.8.6.4", "[]");
    writeSlice("slices", "05-stale-edge", "OPR.9.8.6.5", "[OPR.9.8.6.999, OPR.9.9.1.1]");
    writeSlice("slices", "06-malformed-edge", "OPR.9.8.6.6", "not-a-list");

    const res = await app.request(`/api/scope/audit?mission=${missionName}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; graph?: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.graph).toEqual({
      mission: { id: "OPR.9.8.6", name: missionName, dependsOn: [] },
      nodes: [
        { id: "OPR.9.8.6.2", name: "02-ready", dependsOn: ["OPR.9.8.6.1"] },
        { id: "OPR.9.8.6.3", name: "03-waiting", dependsOn: ["OPR.9.8.6.4"] },
        { id: "OPR.9.8.6.4", name: "04-active-dependency", dependsOn: [] },
        { id: "OPR.9.8.6.5", name: "05-stale-edge", dependsOn: [] },
        { id: "OPR.9.8.6.6", name: "06-malformed-edge", dependsOn: [] },
      ],
      ready: ["OPR.9.8.6.2", "OPR.9.8.6.4", "OPR.9.8.6.5", "OPR.9.8.6.6"],
      waiting: [{ id: "OPR.9.8.6.3", on: ["OPR.9.8.6.4"] }],
      advisories: [
        { id: "OPR.9.8.6.5", dependency: "OPR.9.8.6.999", kind: "missing_sibling", message: "依赖无法解析为同级 slice，已被忽略。" },
        { id: "OPR.9.8.6.5", dependency: "OPR.9.9.1.1", kind: "outside_parent", message: "依赖不在本 mission 内，已被忽略。" },
        { id: "OPR.9.8.6.6", kind: "invalid_field", message: "depends_on 必须是同级 dot-ID 的列表；该值已被忽略。" },
      ],
    });
  });

  it("mission 缺少 NOTES 时返回一条建议，但不恢复已退役的 brief 门禁", async () => {
    const missionDir = path.join(missionsRoot, "briefless-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.3\n---\n# briefless\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=briefless-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      mission: { findings: Array<{ kind: string; severity: string; path: string; remediation: string }> };
      totalFindings: number;
    };
    expect(body.ok).toBe(true);
    expect(body.totalFindings).toBe(1);
    expect(body.mission.findings.some((f) => f.kind === "missing_mission_brief")).toBe(false);
    expect(body.mission.findings.find((f) => f.kind === "missing_mission_notes")).toMatchObject({
      severity: "low",
      path: path.join(missionDir, "NOTES.md"),
    });
  });

  it("done 切片缺少 PROOF.md 或 proof 数据包时返回 missing_proof 指引", async () => {
    const missionDir = path.join(missionsRoot, "proof-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.4\n---\n# proof\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_BRIEF.md"), VALID_MISSION_BRIEF, "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_NOTES.md"), "# Notes\n", "utf8");
    const doneSlice = path.join(missionDir, "slices", "01-done");
    fs.mkdirSync(path.join(doneSlice, "proof"), { recursive: true });
    fs.writeFileSync(path.join(doneSlice, "README.md"), validSliceReadme("---\nid: OPR.99.0.4.1\nstatus: done\n---", "done"), "utf8");
    fs.writeFileSync(path.join(doneSlice, "PROGRESS.md"), "# Progress\n", "utf8");
    const wipSlice = path.join(missionDir, "slices", "02-wip");
    fs.mkdirSync(wipSlice, { recursive: true });
    fs.writeFileSync(path.join(wipSlice, "README.md"), validSliceReadme("---\nid: OPR.99.0.4.2\nstatus: wip\n---", "wip"), "utf8");
    fs.writeFileSync(path.join(wipSlice, "PROGRESS.md"), "# Progress\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=proof-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      slices: Array<{ name: string; findings: Array<{ kind: string; severity: string; path: string; remediation: string }> }>;
      totalFindings: number;
    };
    expect(body.ok).toBe(true);
    const done = body.slices.find((s) => s.name === "01-done");
    const wip = body.slices.find((s) => s.name === "02-wip");
    expect(done?.findings.find((f) => f.kind === "missing_proof")).toMatchObject({
      severity: "medium",
      path: path.join(doneSlice, "PROOF.md"),
    });
    expect(done?.findings.find((f) => f.kind === "missing_proof")?.remediation).toMatch(/proof\//);
    expect(done?.findings.some((f) => f.kind === "missing_impl_prd")).toBe(false);
    expect(wip?.findings.some((f) => f.kind === "missing_proof")).toBe(false);
    expect(body.totalFindings).toBe(1);
  });

  it("由 proof 数据包支持但缺少根 proof 的 proven 切片返回 missing_proof", async () => {
    const dogfoodRoot = path.join(cleanupRoot, "dogfood-evidence");
    fs.mkdirSync(dogfoodRoot, { recursive: true });
    indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: dogfoodRoot, db });
    app = buildApp(indexer);

    const missionDir = path.join(missionsRoot, "proof-packet-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.5\n---\n# proof packet\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_BRIEF.md"), VALID_MISSION_BRIEF, "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_NOTES.md"), "# Notes\n", "utf8");
    const sliceDir = path.join(missionDir, "slices", "03-proof-backed");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"), validSliceReadme("---\nid: OPR.99.0.5.3\nstatus: active\n---", "proof backed"), "utf8");
    fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");
    const packetDir = path.join(dogfoodRoot, "03-proof-backed-20260625");
    fs.mkdirSync(packetDir, { recursive: true });
    fs.writeFileSync(path.join(packetDir, "capture.md"), "proof packet exists\n", "utf8");

    const res = await app.request("/api/scope/audit?mission=proof-packet-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      slices: Array<{ name: string; findings: Array<{ kind: string; severity: string; path: string; remediation: string }> }>;
      totalFindings: number;
    };
    expect(body.ok).toBe(true);
    const slice = body.slices.find((s) => s.name === "03-proof-backed");
    expect(slice?.findings.find((f) => f.kind === "missing_proof")).toMatchObject({
      severity: "medium",
      path: path.join(sliceDir, "PROOF.md"),
    });
    expect(body.totalFindings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// qitem-43d69e17——/api/scope/audit 复合操作负载契约。路由遍历 mission 切片目录，
// 对每个切片调用 indexer.get(entry)（routes/scope-audit.ts:148），且事先不调用 list()：
// 在 5c95a8ee 中，每次未缓存 get 都构建自己的成员批次——2N 次扫描（40 个切片时为 80，
// 经守卫测量）。契约：一次审计请求执行常数次 queue_items 扫描。此路由不执行其他队列读取
//（经源码 grep 验证），因此可以直接应用全量计数规则（LIKE 与非 LIKE；排除 INSERT 和
// WHERE qitem_id IN 的主键点查询）。
// ---------------------------------------------------------------------------

describe("qitem-43d69e17——audit 路由总队列扫描负载契约", () => {
  function instrumentQueueScans(target: Database.Database): () => number {
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

  it("一次针对 40 个有效切片的 GET /api/scope/audit 最多执行 4 次 queue_items 扫描；响应语义完整保留", async () => {
    const missionDir = path.join(missionsRoot, "load-mission");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OPR.99.0.9\n---\n# load mission\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "PROGRESS.md"), "# Progress\n", "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_BRIEF.md"), VALID_MISSION_BRIEF, "utf8");
    fs.writeFileSync(path.join(missionDir, "MISSION_NOTES.md"), "# Notes\n", "utf8");
    const sliceNames: string[] = [];
    for (let i = 0; i < 40; i++) {
      const name = `${String(i + 1).padStart(2, "0")}-load-topic`;
      sliceNames.push(name);
      const sliceDir = path.join(missionDir, "slices", name);
      fs.mkdirSync(sliceDir, { recursive: true });
      fs.writeFileSync(
        path.join(sliceDir, "README.md"),
        validSliceReadme(`---\nid: OPR.99.0.9.${i + 1}\nstatus: active\n---`, name),
        "utf8",
      );
      fs.writeFileSync(path.join(sliceDir, "PROGRESS.md"), "# Progress\n", "utf8");
    }
    // 一条不匹配任何内容的队列行：成员关系扫描占主导，不触发逐切片 IN 查询。
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-lone', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', 'a@r', 'b@r', 'done', 'routine', 'fixture')`,
    ).run();

    const scans = instrumentQueueScans(db);
    const res = await app.request("/api/scope/audit?mission=load-mission");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      mission: { name: string; railStatus: string };
      slices: Array<{ name: string; railStatus: string; findings: Array<{ kind: string }> }>;
      totalFindings: number;
    };
    // 语义一致性：每个切片都经过审计并保留，结构完整。
    expect(body.mission.name).toBe("load-mission");
    expect(body.slices.map((s) => s.name).sort()).toEqual([...sliceNames].sort());
    expect(body.slices).toHaveLength(40);
    for (const s of body.slices) {
      expect(s.railStatus).toBe("present"); // README + PROGRESS 均存在
    }
    // 有效约定切片 + 已填充 mission 文件：完全没有发现项。
    expect(body.totalFindings).toBe(0);
    expect(body.ok).toBe(true);
    // 5c95a8ee 修复前：40 次未缓存 get × 2 次成员扫描 = 80。契约要求为常数。
    expect(scans()).toBeLessThanOrEqual(4);
  });
});
