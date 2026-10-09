// S5b final-fix 第 2 轮（r2 artifact 8d9ec788）——整个 import/materialize
// 交付类，表状以便类型化 rig_name_running 变体不得在兄弟 handler 间漂移：
// pod 感知 import（第 1 轮修复，对照）、legacy import 与 materialize-only
//（两个 500 映射兄弟）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
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

const LEGACY_YAML = (name: string) => [
  "schema_version: 1",
  `name: ${name}`,
  'version: "1.0"',
  "nodes:",
  "  - id: solo",
  "    runtime: claude-code",
  "    cwd: /",
  "edges: []",
].join("\n");

describe("import/materialize 路由——所有同级入口的 rig_name_running 均为 409 冲突（S5b r2）", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

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

  // 该表：每个浮出 instantiate/materialize 结果的生产路由，同等驱动。
  // 加兄弟 handler 而不在此处加一行，就是本测试存在要抓的漂移。
  const ROUTES: Array<{
    label: string;
    path: string;
    yaml: (name: string) => string;
    headers: (name: string) => Record<string, string>;
  }> = [
    {
      label: "pod-aware POST /api/rigs/import (round-1 control)",
      path: "/api/rigs/import",
      yaml: POD_YAML,
      headers: () => ({ "Content-Type": "text/yaml", "X-Rig-Root": "/tmp" }),
    },
    {
      label: "legacy POST /api/rigs/import",
      path: "/api/rigs/import",
      yaml: LEGACY_YAML,
      headers: () => ({ "Content-Type": "text/yaml" }),
    },
    {
      label: "POST /api/rigs/import/materialize",
      path: "/api/rigs/import/materialize",
      yaml: POD_YAML,
      headers: () => ({ "Content-Type": "text/yaml", "X-Rig-Root": "/tmp" }),
    },
  ];

  for (const route of ROUTES) {
    it(`${route.label}: RUNNING same-name rig -> 409, top-level code, teaching text, nothing created or launched`, async () => {
      const name = "dupe-import";
      const rig = seedRunningRig(name);
      const createSession = (setup.tmuxAdapter as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession;

      const res = await setup.app.request(route.path, {
        method: "POST",
        headers: route.headers(name),
        body: route.yaml(name),
      });
      const body = await res.json() as Record<string, unknown>;

      expect(res.status, `${route.label} status`).toBe(409);
      expect(body["code"], `${route.label} top-level code`).toBe("rig_name_running");
      const teaching = String(body["error"] ?? "");
      expect(body["message"], `${route.label} message/error parity`).toBe(teaching);
      expect(teaching).toContain(name);
      expect(teaching).toContain(rig.id);
      expect(teaching).toMatch(/未创建或启动任何内容/);
      expect(teaching).toMatch(/zrig down/);

      expect(rigCount(name), `${route.label} rig count`).toBe(1);
      expect(createSession, `${route.label} launches`).not.toHaveBeenCalled();
    });
  }

  it("对照：带 X-Target-Rig-Id 的 materialize（adopt/expand 族）指向现有工作组且不触发守卫", async () => {
    const rig = seedRunningRig("target-mat");
    const res = await setup.app.request("/api/rigs/import/materialize", {
      method: "POST",
      headers: { "Content-Type": "text/yaml", "X-Rig-Root": "/tmp", "X-Target-Rig-Id": rig.id },
      body: POD_YAML("target-mat"),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body["code"]).not.toBe("rig_name_running");
    expect(rigCount("target-mat")).toBe(1);
  });
});
