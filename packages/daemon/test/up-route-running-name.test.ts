// S5b 最终修复，R2 F1（row r054-s5b-final-fix）——rig_name_running refusal 必须穿过真实
// /api/up boundary：返回结构化非 500（409 conflict）、顶层 code，以及携带 guard 指引文本的
// 顶层 error；不能回退到修复前的裸 500，并把 code 埋在 stages[].detail。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const POD_YAML = (name: string) => [
  'version: "0.2"',
  `name: ${name}`,
  "pods:",
  "  - id: crew",
  "    label: Crew",
  "    members:",
  "      - id: a",
  '        agent_ref: "builtin:terminal"',
  '        profile: "none"',
  "        runtime: terminal",
  "        cwd: /",
  "    edges: []",
  "edges: []",
].join("\n");

describe("POST /api/up——running-name refusal 穿过路由边界（S5b F1）", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let tmpDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    // 使用真实 fs 的 upRouter，让 POST /api/up 可以解析磁盘上的 YAML spec；harness 默认
    // fsOps 始终返回 false。
    setup = createTestApp(db, {
      upRouterFsOps: {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, n: number) => {
          const fd = fs.openSync(p, "r");
          try {
            const buf = Buffer.alloc(n);
            const read = fs.readSync(fd, buf, 0, n, 0);
            return buf.subarray(0, read);
          } finally { fs.closeSync(fd); }
        },
      },
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-rnr-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRunningRig(name: string) {
    const rig = setup.rigRepo.createRig(name);
    const node = setup.rigRepo.addNode(rig.id, "crew.a", { runtime: "claude-code", cwd: "/" });
    const session = setup.sessionRegistry.registerSession(node.id, `crew-a@${name}`);
    setup.sessionRegistry.updateStatus(session.id, "running");
    return rig;
  }

  function rigCount(name: string): number {
    return (db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE name = ?").get(name) as { c: number }).c;
  }

  it("对 RUNNING 名称第二次 up：返回 409、顶层 rig_name_running 与指引错误，不创建或启动任何内容", async () => {
    const rig = seedRunningRig("dupe-route");
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, POD_YAML("dupe-route"));
    const createSession = (setup.tmuxAdapter as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession;

    const res = await setup.app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });
    const body = await res.json() as Record<string, unknown>;

    // 结构化非 500 refusal，code 位于顶层。
    expect(res.status).toBe(409);
    expect(body["code"]).toBe("rig_name_running");
    // 指引内容一直保留到顶层 error 字段。
    const error = String(body["error"] ?? "");
    expect(error).toContain("dupe-route");
    expect(error).toContain(rig.id);
    expect(error).toMatch(/未创建或启动任何内容/i);
    expect(error).toMatch(/zrig down/);

    // 效果侧：未创建、未启动。
    expect(rigCount("dupe-route")).toBe(1);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("对照：通过同一路由 up 全新名称不受影响", async () => {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, POD_YAML("fresh-route"));

    const res = await setup.app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });

    // 无论本 harness 的 launch outcome 如何，guard refusal 都不得触发。
    const body = await res.json() as Record<string, unknown>;
    expect(body["code"]).not.toBe("rig_name_running");
    expect(rigCount("fresh-route")).toBe(1);
  });
});
