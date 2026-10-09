// OPR activity-hook r3 第 3 部分——路由层级：受管活动 hook 的交付缺口警告必须穿过真实
// /api/up 路由。应用选择 claude_activity_hooks 但交付资源不可用的 claude-code 成员时，
// 必须成功（rc0，返回 rigId，没有硬失败），并在响应正文中携带准确的非致命警告。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
  runtime_resources:
    - id: claude-activity-hooks
      path: runtime/claude-activity-hooks.json
      runtime: claude-code
      type: claude_activity_hooks
profiles:
  default:
    uses:
      skills: []
      runtime_resources: [claude-activity-hooks]
`;

const RIG_YAML = `version: "0.2"
name: activity-warn-route
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`;

describe("/api/up——受管活动 hook 交付缺口警告穿过路由（rc0）", () => {
  let db: Database.Database;
  let specDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    specDir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-up-route-"));
    const agentDir = path.join(specDir, "agents", "impl");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "agent.yaml"), AGENT_YAML);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(specDir, { recursive: true, force: true });
  });

  const realFs = {
    exists: (p: string) => fs.existsSync(p),
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    readHead: (p: string, n: number) => {
      const buf = Buffer.alloc(n);
      const fd = fs.openSync(p, "r");
      try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
      return buf;
    },
  };

  it("应用交付资源缺失的 claude_activity_hooks 席位时返回 rc0 和准确警告", async () => {
    const { app } = createTestApp(db, {
      upRouterFsOps: realFs,
      podInstantiatorFsOps: { exists: (p: string) => fs.existsSync(p), readFile: (p: string) => fs.readFileSync(p, "utf-8") },
      claudeActivityAssets: { relayPath: "/nope/relay.cjs", manifestPath: "/nope/claude.json" },
    });
    const specPath = path.join(specDir, "rig.yaml");
    fs.writeFileSync(specPath, RIG_YAML);

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: specPath }),
    });
    const body = await res.json();

    // rc0：应用成功并返回 rigId，交付缺口没有阻塞启动。
    expect(res.status, JSON.stringify(body)).toBeLessThan(400);
    expect(body.rigId, JSON.stringify(body)).toBeDefined();
    // 准确的非致命警告已穿过路由。
    const warnings: string[] = body.warnings ?? [];
    expect(warnings.some((w) => /无法交付受管 Claude 活动 hook/.test(w)), JSON.stringify(body)).toBe(true);
    expect(warnings.some((w) => w.includes("dev.impl"))).toBe(true);
  });
});
