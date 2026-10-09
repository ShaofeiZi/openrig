// V0.3.1 slice 12 walk-item 1——任务目标工作范围数据层。
//
// GET /api/missions/:missionId 返回聚合后的任务目标 metadata：
//   - missionId：回显请求 id
//   - missionPath：任务目标目录的绝对文件系统路径，即包含匹配 slice 的 slices 目录之父目录
//   - slices：筛选出 missionId 匹配项的 SliceListEntry[]
//
// 本路由不自行读取 README.md / PROGRESS.md 内容；UI 通过通用 useScopeMarkdown hook，
// 经既有 /api/files/read 路由获取。这里是任务目标 metadata 层，复用文件内容层。

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
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { missionsRoutes } from "../src/routes/missions.js";

function buildApp(
  indexer: SliceIndexer,
  specCache?: WorkflowSpecCache,
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sliceIndexer" as never, indexer);
    c.set("workflowSpecCache" as never, specCache);
    await next();
  });
  app.route("/api/missions", missionsRoutes());
  return app;
}

function writeMissionReadme(
  missionsRoot: string,
  missionId: string,
  frontmatter: Record<string, string> = {},
): void {
  const dir = path.join(missionsRoot, missionId);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(
    path.join(dir, "README.md"),
    `---\n${fm}\n---\n# ${missionId}\n`,
  );
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

let db: Database.Database;
let cleanupRoot: string;
let missionsRoot: string;
let indexer: SliceIndexer;
let app: Hono;

beforeEach(() => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
  cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "missions-routes-"));
  missionsRoot = path.join(cleanupRoot, "missions");
  fs.mkdirSync(missionsRoot, { recursive: true });
  indexer = new SliceIndexer({ slicesRoot: missionsRoot, dogfoodEvidenceRoot: null, db });
  app = buildApp(indexer);
});

afterEach(() => {
  db.close();
  fs.rmSync(cleanupRoot, { recursive: true, force: true });
});

describe("GET /api/missions/:missionId", () => {
  it("返回 200、missionPath，以及按请求任务目标筛选的 slices", async () => {
    writeSliceInMission(missionsRoot, "getting-started", "first-slice", { status: "active" });
    writeSliceInMission(missionsRoot, "getting-started", "second-slice", { status: "done" });
    writeSliceInMission(missionsRoot, "other-mission", "third-slice", { status: "active" });

    const res = await app.request("/api/missions/getting-started");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      missionId: string;
      missionPath: string;
      slices: Array<{ name: string; missionId: string }>;
    };
    expect(body.missionId).toBe("getting-started");
    expect(body.missionPath).toBe(path.join(missionsRoot, "getting-started"));
    expect(body.slices.map((s) => s.name).sort()).toEqual(["first-slice", "second-slice"]);
    expect(body.slices.every((s) => s.missionId === "getting-started")).toBe(true);
  });

  it("missionId 下不存在 slice 时返回 404", async () => {
    writeSliceInMission(missionsRoot, "getting-started", "first-slice", { status: "active" });

    const res = await app.request("/api/missions/unknown-mission");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("mission_not_found");
  });

  it("indexer 未接线时返回 503", async () => {
    const bareApp = new Hono();
    bareApp.route("/api/missions", missionsRoutes());
    const res = await bareApp.request("/api/missions/anything");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slices_indexer_unavailable");
  });

  it("indexer 未就绪（未配置 slices 根）时返回 503", async () => {
    const emptyIndexer = new SliceIndexer({
      slicesRoot: "",
      dogfoodEvidenceRoot: null,
      db,
    });
    const emptyApp = buildApp(emptyIndexer);
    const res = await emptyApp.request("/api/missions/getting-started");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slices_root_not_configured");
  });

  it("只统计精确 missionId 匹配的 slice（不做子串匹配）", async () => {
    writeSliceInMission(missionsRoot, "release-0.3.1", "slice-a", { status: "active" });
    writeSliceInMission(missionsRoot, "release-0.3.1-followup", "slice-b", { status: "active" });

    const res = await app.request("/api/missions/release-0.3.1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slices: Array<{ name: string }> };
    expect(body.slices.map((s) => s.name)).toEqual(["slice-a"]);
  });

  // V0.3.1 slice 13 walk-item 7——任务目标 frontmatter workflow_spec 声明与拓扑投影。
  describe("workflow_spec + topology (slice 13)", () => {
    it("已声明时返回任务目标 README frontmatter 中的 workflow_spec", async () => {
      writeMissionReadme(missionsRoot, "getting-started", {
        status: "active",
        workflow_spec: "openrig-velocity@1.0",
      });
      writeSliceInMission(missionsRoot, "getting-started", "first-slice", { status: "active" });

      const res = await app.request("/api/missions/getting-started");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workflow_spec: { name: string; version: string } | null;
      };
      expect(body.workflow_spec).toEqual({ name: "openrig-velocity", version: "1.0" });
    });

    it("任务目标 README 未声明时返回 workflow_spec: null", async () => {
      writeMissionReadme(missionsRoot, "plain-mission", { status: "active" });
      writeSliceInMission(missionsRoot, "plain-mission", "child-slice", { status: "active" });

      const res = await app.request("/api/missions/plain-mission");
      const body = (await res.json()) as { workflow_spec: unknown };
      expect(body.workflow_spec).toBeNull();
    });

    it("已声明 workflow_spec 且缓存中存在 spec 时返回 topology.specGraph", async () => {
      // 迁移 workflow_specs 表供 spec cache 使用。
      migrate(db, [workflowSpecsSchema]);
      const specCache = new WorkflowSpecCache(db);

      // 手工编写最小 spec 文件并写入缓存。
      const specPath = path.join(cleanupRoot, "openrig-velocity.workflow.yaml");
      fs.writeFileSync(specPath, [
        "workflow:",
        "  id: openrig-velocity",
        "  version: \"1.0\"",
        "  objective: \"Demo\"",
        "  target:",
        "    rig: openrig-velocity",
        "  roles:",
        "    role-a: {}",
        "  entry:",
        "    role: role-a",
        "  steps:",
        "    - id: step-a",
        "      actor_role: role-a",
        "      next_hop:",
        "        suggested_roles: []",
        "",
      ].join("\n"));
      specCache.readThrough(specPath);

      writeMissionReadme(missionsRoot, "mission-with-spec", {
        status: "active",
        workflow_spec: "openrig-velocity@1.0",
      });
      writeSliceInMission(missionsRoot, "mission-with-spec", "slice-a", { status: "active" });
      const appWithCache = buildApp(indexer, specCache);

      const res = await appWithCache.request("/api/missions/mission-with-spec");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        topology: { specGraph: { specName: string; specVersion: string; nodes: unknown[] } | null };
      };
      expect(body.topology).not.toBeNull();
      expect(body.topology.specGraph).not.toBeNull();
      expect(body.topology.specGraph!.specName).toBe("openrig-velocity");
      expect(body.topology.specGraph!.specVersion).toBe("1.0");
      expect(body.topology.specGraph!.nodes.length).toBeGreaterThan(0);
    });

    it("已声明 workflow_spec 但缓存中没有 spec 时返回 topology: { specGraph: null }", async () => {
      writeMissionReadme(missionsRoot, "unbound-mission", {
        status: "active",
        workflow_spec: "ghost-spec@9.9",
      });
      writeSliceInMission(missionsRoot, "unbound-mission", "child-slice", { status: "active" });

      // 未接入 spec cache；路由回退到 specGraph: null。
      const res = await app.request("/api/missions/unbound-mission");
      const body = (await res.json()) as {
        workflow_spec: { name: string } | null;
        topology: { specGraph: unknown } | null;
      };
      expect(body.workflow_spec?.name).toBe("ghost-spec");
      expect(body.topology?.specGraph).toBeNull();
    });
  });
});
