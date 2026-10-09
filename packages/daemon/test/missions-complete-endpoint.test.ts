// Slice 18 §3.5——POST /api/missions/:missionId/complete 测试。
//
// endpoint 向任务目标 README.md frontmatter 写入 `status: complete`，为 storytelling card 的
// Mark-complete action（Getting Started 完成并隐藏流程）提供能力。行为：
//  - 成功时返回 200 + { missionId, status: "complete" }；
//  - README 没有 frontmatter 时创建 block；
//  - 原地更新现有 status: X 行；
//  - frontmatter 存在但缺少 status 时新增 status 行；
//  - 任务目标不存在时返回 404；
//  - 幂等：调用 complete 两次仍成功。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { missionsRoutes } from "../src/routes/missions.js";
import { slicesRoutes } from "../src/routes/slices.js";

function buildApp(indexer: SliceIndexer): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, indexer);
    await next();
  });
  app.route("/api/missions", missionsRoutes());
  return app;
}

function writeMissionReadme(
  missionsRoot: string,
  missionId: string,
  body: string,
): void {
  const dir = path.join(missionsRoot, missionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), body);
}

function writeSliceInMission(
  missionsRoot: string,
  missionId: string,
  sliceName: string,
  frontmatter: Record<string, string> = {},
): void {
  const dir = path.join(missionsRoot, missionId, "slices", sliceName);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `---\n${fm}\n---\n# ${sliceName}\n`,
  );
}

let cleanupRoot: string;
let missionsRoot: string;
let indexer: SliceIndexer;
let db: Database.Database;

beforeEach(() => {
  cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "missions-complete-"));
  missionsRoot = path.join(cleanupRoot, "missions");
  fs.mkdirSync(missionsRoot, { recursive: true });
  // SliceIndexerOpts 把 `db`（和 dogfoodEvidenceRoot）声明为必需，startup 始终提供它们。此
  // fixture 以前省略 db，只因 indexer 吞掉了随之产生的错误才被容忍。真实内存 DB 满足构造器
  // 契约；刻意不迁移，让空数据库覆盖 queue_items 结构性缺失的降级，也就是 endpoint 预期状态。
  db = createDb(":memory:");
  indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
});

afterEach(() => {
  db.close();
  fs.rmSync(cleanupRoot, { recursive: true, force: true });
});

describe("POST /api/missions/:missionId/complete", () => {
  it("在 README frontmatter 中把现有 status: active 更新为 status: complete", async () => {
    writeMissionReadme(
      missionsRoot,
      "getting-started",
      "---\nid: getting-started\nstatus: active\n---\n# Getting Started\n",
    );
    writeSliceInMission(missionsRoot, "getting-started", "intro");

    const app = buildApp(indexer);
    const res = await app.request("/api/missions/getting-started/complete", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { missionId: string; status: string };
    expect(body.missionId).toBe("getting-started");
    expect(body.status).toBe("complete");

    const readme = fs.readFileSync(path.join(missionsRoot, "getting-started", "README.md"), "utf-8");
    expect(readme).toContain("status: complete");
    expect(readme).not.toContain("status: active");
  });

  it("frontmatter 缺少 status 字段时添加 status: complete", async () => {
    writeMissionReadme(
      missionsRoot,
      "demo-mission",
      "---\nid: demo-mission\n---\n# Demo Mission\n",
    );
    writeSliceInMission(missionsRoot, "demo-mission", "first");

    const app = buildApp(indexer);
    const res = await app.request("/api/missions/demo-mission/complete", { method: "POST" });

    expect(res.status).toBe(200);
    const readme = fs.readFileSync(path.join(missionsRoot, "demo-mission", "README.md"), "utf-8");
    expect(readme).toContain("status: complete");
    expect(readme).toContain("id: demo-mission");
  });

  it("README 完全没有 frontmatter 时创建 block", async () => {
    writeMissionReadme(missionsRoot, "no-fm", "# A mission with no frontmatter\n");
    writeSliceInMission(missionsRoot, "no-fm", "only-slice");

    const app = buildApp(indexer);
    const res = await app.request("/api/missions/no-fm/complete", { method: "POST" });

    expect(res.status).toBe(200);
    const readme = fs.readFileSync(path.join(missionsRoot, "no-fm", "README.md"), "utf-8");
    expect(readme.startsWith("---\n")).toBe(true);
    expect(readme).toContain("status: complete");
    expect(readme).toContain("# A mission with no frontmatter");
  });

  it("保持幂等：调用 complete 两次仍返回 200，status 保持 complete", async () => {
    writeMissionReadme(
      missionsRoot,
      "idempotent-mission",
      "---\nid: idempotent-mission\nstatus: active\n---\n# Body\n",
    );
    writeSliceInMission(missionsRoot, "idempotent-mission", "s");

    const app = buildApp(indexer);
    const res1 = await app.request("/api/missions/idempotent-mission/complete", { method: "POST" });
    expect(res1.status).toBe(200);
    const res2 = await app.request("/api/missions/idempotent-mission/complete", { method: "POST" });
    expect(res2.status).toBe(200);

    const readme = fs.readFileSync(path.join(missionsRoot, "idempotent-mission", "README.md"), "utf-8");
    const occurrences = (readme.match(/status: complete/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("GET /api/missions/:missionId 从 frontmatter 返回 status（slice 18 状态呈现）", async () => {
    writeMissionReadme(
      missionsRoot,
      "has-status",
      "---\nid: has-status\nstatus: complete\n---\n# body\n",
    );
    writeSliceInMission(missionsRoot, "has-status", "s");
    const app = buildApp(indexer);
    const res = await app.request("/api/missions/has-status", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string | null };
    expect(body.status).toBe("complete");
  });

  it("frontmatter 没有 status 字段时 GET /api/missions/:missionId 返回 status=null", async () => {
    writeMissionReadme(
      missionsRoot,
      "no-status",
      "---\nid: no-status\n---\n# body\n",
    );
    writeSliceInMission(missionsRoot, "no-status", "s");
    const app = buildApp(indexer);
    const res = await app.request("/api/missions/no-status", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string | null };
    expect(body.status).toBeNull();
  });

  it("POST complete 后，后续 GET 返回 status=complete（持久往返）", async () => {
    writeMissionReadme(
      missionsRoot,
      "round-trip",
      "---\nid: round-trip\nstatus: active\n---\n# body\n",
    );
    writeSliceInMission(missionsRoot, "round-trip", "s");
    const app = buildApp(indexer);

    const before = await app.request("/api/missions/round-trip", { method: "GET" });
    const beforeBody = (await before.json()) as { status: string | null };
    expect(beforeBody.status).toBe("active");

    const post = await app.request("/api/missions/round-trip/complete", { method: "POST" });
    expect(post.status).toBe(200);

    const after = await app.request("/api/missions/round-trip", { method: "GET" });
    const afterBody = (await after.json()) as { status: string | null };
    expect(afterBody.status).toBe("complete");
  });

  it("任务目标不存在时返回 404", async () => {
    const app = buildApp(indexer);
    const res = await app.request("/api/missions/nonexistent-mission/complete", { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mission_not_found");
  });

  it("SliceIndexer 不可用时返回 503", async () => {
    const app = new Hono();
    app.route("/api/missions", missionsRoutes());
    const res = await app.request("/api/missions/anything/complete", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("更新 status 时保留无关 frontmatter 字段", async () => {
    writeMissionReadme(
      missionsRoot,
      "preserves",
      "---\nid: preserves\nworkflow_spec: my-workflow@1\nstatus: active\nlabel: keep me\n---\n# Body\n",
    );
    writeSliceInMission(missionsRoot, "preserves", "s");

    const app = buildApp(indexer);
    const res = await app.request("/api/missions/preserves/complete", { method: "POST" });
    expect(res.status).toBe(200);

    const readme = fs.readFileSync(path.join(missionsRoot, "preserves", "README.md"), "utf-8");
    expect(readme).toContain("workflow_spec: my-workflow@1");
    expect(readme).toContain("label: keep me");
    expect(readme).toContain("status: complete");
    expect(readme).toContain("id: preserves");
  });
});

// ---------------------------------------------------------------------------
// VM-005 B1——写侧 cache coherence（窄 C-vii 例外；架构裁定 b8d91aee…，plan v1.6.1
// §J-1d，逐字保留 guard repro 结构）。设计上，带外文件写入仍使用 60s TTL；本 seam 只覆盖
// 后台服务自身写路径，不使用 watcher 或 write-through。
// ---------------------------------------------------------------------------

type SidecarBody = { missions: Record<string, { authoredStatus: string | null; readiness: unknown }> };

const legacyReadiness = {
  name: "relx", state: "legacy", historicalStatus: null, slices: [], issues: [],
  revision: expect.stringMatching(/^[a-f0-9]{64}$/),
};

function buildAppWithSlices(ix: SliceIndexer): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, ix);
    // list 路径只触碰 indexer；stub 即可满足 getDeps。
    c.set("sliceDetailProjector" as never, {} as never);
    await next();
  });
  app.route("/api/missions", missionsRoutes());
  app.route("/api/slices", slicesRoutes());
  return app;
}

describe("VM-005 B1——后台服务自身 API 的 read-after-write coherence", () => {
  it("hot GET /api/slices → POST complete → detail + slices 立即都读到 complete；第二次 POST 幂等", async () => {
    writeMissionReadme(missionsRoot, "relx", "---\nid: relx\nstatus: active\n---\n# Relx\n");
    writeSliceInMission(missionsRoot, "relx", "target");
    const app = buildAppWithSlices(indexer);

    // 把 sidecar 预热；刻意不加 ?refresh=1，因为 refresh 会 full-invalidate 并掩盖 seam，
    // 缺陷存在于 hot path。
    const primed = await app.request("/api/slices?filter=all");
    expect(primed.status).toBe(200);
    expect(((await primed.json()) as SidecarBody).missions["relx"]).toEqual({ authoredStatus: "active", readiness: legacyReadiness });

    const post = await app.request("/api/missions/relx/complete", { method: "POST" });
    expect(post.status).toBe(200);

    // 立即读取（不 refresh、不等待 TTL）：两个 payload 都携带新值。
    const detail = await app.request("/api/missions/relx");
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { status?: string | null }).status).toBe("complete");
    const hot = await app.request("/api/slices?filter=all");
    expect(((await hot.json()) as SidecarBody).missions["relx"]).toEqual({ authoredStatus: "complete", readiness: legacyReadiness });

    // 幂等的第二次 POST：仍返回 200，sidecar 仍 coherent。
    const again = await app.request("/api/missions/relx/complete", { method: "POST" });
    expect(again.status).toBe(200);
    const hot2 = await app.request("/api/slices?filter=all");
    expect(((await hot2.json()) as SidecarBody).missions["relx"]).toEqual({ authoredStatus: "complete", readiness: legacyReadiness });
  });

  it("负向：listing + detail cache 不受 complete-write invalidation 影响，只丢 blob，绝不 full-flush", async () => {
    writeMissionReadme(missionsRoot, "relx", "---\nstatus: active\n---\n# Relx\n");
    writeSliceInMission(missionsRoot, "relx", "target");
    const app = buildAppWithSlices(indexer);
    const listBefore = indexer.list(); // primes the listing cache
    const recordBefore = indexer.get("target"); // primes the detail cache
    indexer.missionAuthoredStatuses(); // primes the sidecar
    const post = await app.request("/api/missions/relx/complete", { method: "POST" });
    expect(post.status).toBe(200);
    // 引用相等：同一 cached instance 表明这些 cache 保留下来。
    expect(indexer.list()).toBe(listBefore);
    expect(indexer.get("target")).toBe(recordBefore);
    // 同时 sidecar 从磁盘用新值重建。
    expect(indexer.missionAuthoredStatuses()["relx"]).toEqual({ authoredStatus: "complete" });
  });
});
