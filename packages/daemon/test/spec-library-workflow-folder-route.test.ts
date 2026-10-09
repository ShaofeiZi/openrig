// 切片 11（workflow-spec-folder-discovery）——路由级 TDD。
//
// 当通过上下文变量 `workflowSpecCache` + `workflowsFolderDir` 接线时，
// GET /api/specs/library 会择机扫描 <workspace.specs_root>/workflows/，
// 然后把有效行和诊断行连同内置 starter 一起呈现（OQ-3）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowSpecsDiagnosticSchema } from "../src/db/migrations/040_workflow_specs_diagnostic.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { ActiveLensStore } from "../src/domain/active-lens-store.js";
import { specLibraryRoutes } from "../src/routes/spec-library.js";

const VALID_YAML = (id: string) => `workflow:
  id: ${id}
  version: '1'
  objective: 文件夹扫描 fixture
  target:
    rig: folder-fix
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@folder-fix
  steps:
    - id: produce
      actor_role: producer
      objective: 起草。
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;

const INVALID_YAML = `workflow:
  id: bad-spec
  # 缺少必填的 version、roles、steps
  objective: 此内容无法正常解析
`;

describe("spec-library 路由文件夹扫描（切片 11）", () => {
  let db: Database.Database;
  let tmp: string;
  let folder: string;
  let builtinDir: string;
  let cache: WorkflowSpecCache;
  let lib: SpecLibraryService;
  let lensStore: ActiveLensStore;
  let lensFilePath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
    cache = new WorkflowSpecCache(db);
    tmp = mkdtempSync(join(tmpdir(), "wf-folder-route-"));
    folder = join(tmp, "workflows");
    builtinDir = join(tmp, "builtins", "workflow-specs");
    mkdirSync(folder, { recursive: true });
    mkdirSync(builtinDir, { recursive: true });
    lensFilePath = join(tmp, "active-workflow-lens.json");

    lib = new SpecLibraryService({ roots: [], specReviewService: new SpecReviewService() });
    lib.scan();
    lensStore = new ActiveLensStore({ filePath: lensFilePath });
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function createApp(opts: { withFolder: boolean } = { withFolder: true }): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("specLibraryService" as never, lib);
      c.set("specReviewService" as never, new SpecReviewService());
      c.set("activeLensStore" as never, lensStore);
      c.set("rigRepo" as never, { db });
      c.set("workflowBuiltinSpecsDir" as never, builtinDir);
      c.set("workflowSpecCache" as never, cache);
      if (opts.withFolder) c.set("workflowsFolderDir" as never, folder);
      await next();
    });
    app.route("/api/specs/library", specLibraryRoutes());
    return app;
  }

  it("GET / 触发文件夹扫描，并将有效 YAML 显示为 workflow 条目", async () => {
    writeFileSync(join(folder, "good.yaml"), VALID_YAML("good-spec"));
    const app = createApp();
    const res = await app.request("/api/specs/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ id: string; kind: string; name: string }>;
    const entry = body.find((e) => e.kind === "workflow" && e.name === "good-spec");
    expect(entry).toBeDefined();
    expect(entry?.id).toBe("workflow:good-spec:1");
  });

  it("GET / 将无效 YAML 显示为诊断 workflow 条目", async () => {
    writeFileSync(join(folder, "broken.yaml"), INVALID_YAML);
    const app = createApp();
    const res = await app.request("/api/specs/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{
      id: string;
      kind: string;
      name: string;
      status?: string;
      errorMessage?: string | null;
    }>;
    const diag = body.find((e) => e.kind === "workflow" && e.id.startsWith("workflow:error:"));
    expect(diag).toBeDefined();
    expect(diag?.status).toBe("error");
    expect(diag?.errorMessage).toBeTruthy();
    expect(diag?.name).toBe("broken.yaml");
  });

  it("文件消失后 GET / 移除诊断行（OQ-4）", async () => {
    const brokenPath = join(folder, "broken.yaml");
    writeFileSync(brokenPath, INVALID_YAML);
    let app = createApp();
    let res = await app.request("/api/specs/library");
    let body = await res.json() as Array<{ id: string }>;
    expect(body.some((e) => e.id.startsWith("workflow:error:"))).toBe(true);

    rmSync(brokenPath);
    app = createApp();
    res = await app.request("/api/specs/library");
    body = await res.json() as Array<{ id: string }>;
    expect(body.some((e) => e.id.startsWith("workflow:error:"))).toBe(false);
  });

  it("未设置 workflowsFolderDir 时，GET / 的文件夹扫描为空操作", async () => {
    writeFileSync(join(folder, "good.yaml"), VALID_YAML("ghost-spec"));
    const app = createApp({ withFolder: false });
    const res = await app.request("/api/specs/library");
    const body = await res.json() as Array<{ name: string }>;
    expect(body.some((e) => e.name === "ghost-spec")).toBe(false);
  });

  it("漂移判别项：单次响应中同时包含有效、无效及先前已移除状态", async () => {
    // 为已不存在的文件预先植入诊断。
    cache.writeDiagnostic({
      sourcePath: join(folder, "previously-here.yaml"),
      sourceHash: "h",
      errorMessage: "陈旧",
    });
    writeFileSync(join(folder, "good.yaml"), VALID_YAML("disc-good"));
    writeFileSync(join(folder, "bad.yaml"), INVALID_YAML);
    const app = createApp();
    const res = await app.request("/api/specs/library");
    const body = await res.json() as Array<{
      id: string;
      name: string;
      kind: string;
      status?: string;
    }>;
    expect(body.some((e) => e.name === "disc-good")).toBe(true);
    expect(body.some((e) => e.name === "bad.yaml" && e.status === "error")).toBe(true);
    expect(body.some((e) => e.id === `workflow:error:${join(folder, "previously-here.yaml")}`)).toBe(false);
  });
});
