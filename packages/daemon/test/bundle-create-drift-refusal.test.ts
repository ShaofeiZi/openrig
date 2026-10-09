// Bundle create 拒绝导出与其具名 rig 不一致的 spec。
//
// Build B 已检测 spec-vs-live drift，并在 201 上返回 `warning`（见锁定检测接线的
// bundle-export-drift-warning.test.ts）。仅检测还不够：.rigbundle 是灾难恢复 artifact，附在成功
// 结果上的 warning 往往会在最承担不起代价时才被发现。这些测试锁定强制行为：默认拒绝；仅当操作员
// 明确表示有意如此时继续；继续时让 artifact 自身携带警告。
//
// 四种情形中，三种必须保持静默的情形与一种必须显著失败的情形同样重要：通过拒绝测试最省事的方式
// 是拒绝所有操作，这虽能通过第一个断言，却会破坏每个合法的编写导出。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";

const RIG_NAME = "drift-export-rig";

describe("bundle create——拒绝与 live rig 不一致的 spec", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-drift-refusal-"));
    app = createTestApp(db).app;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 数据库中运行的 rig，包含给定全限定 seat id。 */
  function seedLiveRig(name: string, logicalIds: string[]): void {
    const rigId = `rig-${name}`;
    db.prepare("INSERT INTO rigs (id, name, created_at, updated_at) VALUES (?,?,datetime('now'),datetime('now'))").run(rigId, name);
    for (const [i, lid] of logicalIds.entries()) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?,?,?)").run(`${rigId}-n${i}`, rigId, lid);
    }
  }

  /** 磁盘上的 pod-aware spec，精确声明给定 pod/member 及其引用的 agent。 */
  function writeSpec(name: string, pods: Array<{ id: string; members: string[] }>): string {
    const agentsDir = path.join(tmpDir, "agents", "impl");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "agent.yaml"), [
      "name: impl-agent",
      'version: "1.0.0"',
      "resources:",
      "  skills: []",
      "profiles:",
      "  default:",
      "    uses:",
      "      skills: []",
    ].join("\n"));

    const lines = ['version: "0.2"', `name: ${name}`, "pods:"];
    for (const pod of pods) {
      lines.push(`  - id: ${pod.id}`, `    label: ${pod.id}`, "    members:");
      for (const member of pod.members) {
        lines.push(
          `      - id: ${member}`,
          '        agent_ref: "local:agents/impl"',
          "        profile: default",
          "        runtime: claude-code",
          "        cwd: .",
        );
      }
      lines.push("    edges: []");
    }
    lines.push("edges: []");

    const specPath = path.join(tmpDir, `${name}.yaml`);
    fs.writeFileSync(specPath, lines.join("\n"));
    return specPath;
  }

  function create(specPath: string, outputName: string, extra: Record<string, unknown> = {}) {
    return app.request("/api/bundles/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        specPath,
        bundleName: outputName,
        bundleVersion: "0.1.0",
        outputPath: path.join(tmpDir, `${outputName}.rigbundle`),
        ...extra,
      }),
    });
  }

  // RED：这是已发布缺陷。spec 声明一个 pod/一个 seat；rig 正运行两个 pod/三个 seat。当前行为会
  // 以 201 导出，并附带无人必须阅读的 warning；生成的 DR artifact 会重建较小 rig。
  it("spec 小于 live rig 时以 409 拒绝，并点名两套拓扑", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl", "dev.qa", "orch.lead"]);
    const specPath = writeSpec(RIG_NAME, [{ id: "dev", members: ["impl"] }]);

    const res = await create(specPath, "stale");

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    // diff 必须具体到可执行；笼统的“topology 不同”很容易被读者忽略。两侧数量以及会丢弃的 seat
    // 都应具名出现。
    expect(body.error).toContain("1 pods/1 seats");
    expect(body.error).toContain("2/3");
    expect(body.error).toContain("dev.qa");
    expect(body.error).toContain("orch.lead");
    // 拒绝就是真拒绝：磁盘上没有 artifact。
    expect(fs.existsSync(path.join(tmpDir, "stale.rigbundle"))).toBe(false);
  });

  // escape hatch 及其代价：artifact 携带自身 caveat。
  it("使用 allowDrift 时继续，并将分歧写入 bundle provenance", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl", "dev.qa", "orch.lead"]);
    const specPath = writeSpec(RIG_NAME, [{ id: "dev", members: ["impl"] }]);

    const res = await create(specPath, "allowed", { allowDrift: true });

    expect(res.status).toBe(201);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toContain("2/3");

    // caveat 必须存在于 provenance：HTTP 响应中的 warning 随输出它的终端消失；六周后安装此
    // bundle 的人会读取 manifest。
    const inspectRes = await app.request("/api/bundles/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundlePath: path.join(tmpDir, "allowed.rigbundle") }),
    });
    expect(inspectRes.status).toBe(200);
    const inspected = await inspectRes.json() as { manifest?: { provenance?: { notes?: string } } };
    expect(inspected.manifest?.provenance?.notes ?? "").toContain("2/3");
  });

  // PRESERVE 1——为未运行的 rig 编写 spec 是合法操作，必须保持静默。拒绝一切的实现会破坏此情形。
  it("具名 rig 未运行时保持静默", async () => {
    const specPath = writeSpec("not-a-running-rig", [{ id: "dev", members: ["impl"] }]);

    const res = await create(specPath, "authoring");

    expect(res.status).toBe(201);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "authoring.rigbundle"))).toBe(true);
  });

  // PRESERVE 2——spec 与 live 一致：正确路径上不拒绝、不警告、不增加新 ceremony。
  it("spec 与 live rig 完全匹配时保持静默", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl", "orch.lead"]);
    const specPath = writeSpec(RIG_NAME, [
      { id: "dev", members: ["impl"] },
      { id: "orch", members: ["lead"] },
    ]);

    const res = await create(specPath, "conforming");

    expect(res.status).toBe(201);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "conforming.rigbundle"))).toBe(true);
  });

  // 旧版（v1）spec 通过同一 endpoint 导出，并产生同样确信但错误的 artifact。它们需要相同 guard，
  // 而非第二个 detector：v1 rig 是没有 pod 层级的 topology，node 的 `logical_id` 就是 spec 的
  // `node.id`，所以格式只改变 id 读取方式。
  function writeLegacySpec(name: string, nodeIds: string[]): string {
    const lines = ["schema_version: 1", `name: ${name}`, 'version: "1.0"', "nodes:"];
    for (const id of nodeIds) lines.push(`  - id: ${id}`, "    runtime: claude-code");
    lines.push("edges: []");
    const specPath = path.join(tmpDir, `${name}-legacy.yaml`);
    fs.writeFileSync(specPath, lines.join("\n"));
    return specPath;
  }

  it("拒绝小于 live rig 的旧版 spec，并点名被丢弃 seat", async () => {
    seedLiveRig(RIG_NAME, ["dev", "qa", "lead"]);
    const specPath = writeLegacySpec(RIG_NAME, ["dev"]);

    const res = await create(specPath, "legacy-stale");

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("qa");
    expect(body.error).toContain("lead");
    expect(fs.existsSync(path.join(tmpDir, "legacy-stale.rigbundle"))).toBe(false);
  });

  // flat reader 是旧版支持的承重部分。通过 pod-aware reader 读取 flat rig 会把每个 id 解析为
  // malformed、将 live rig 读为空，并让 guard 报告“没有任何内容运行”；这是一个虚假缺席，且发生在
  // 唯一能发现将丢弃内容的路径上。若该 reader 被换回，本用例会显著失败。
  it("旧版 spec 与 live rig 完全匹配时保持静默", async () => {
    seedLiveRig(RIG_NAME, ["dev", "qa"]);
    const specPath = writeLegacySpec(RIG_NAME, ["dev", "qa"]);

    const res = await create(specPath, "legacy-conforming");

    expect(res.status).toBe(201);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "legacy-conforming.rigbundle"))).toBe(true);
  });

  // 测试的是不一致，而非方向。早期修订会放行此情形，理由是声明比 live 更多内容的 spec bundle
  // 本就用于启动其余内容。该理解把 `nodes` 行视为“当前运行的 session”；但它们是 rig 的持久拓扑。
  // restore 若启动 spec 从未声明的 seat，与丢弃 seat 同样会生成不同 rig，因此也要拒绝，并以
  // --allow-drift 作为通道。
  it("spec 声明内容多于 rig 持久拓扑时拒绝", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl"]);
    const specPath = writeSpec(RIG_NAME, [
      { id: "dev", members: ["impl"] },
      { id: "orch", members: ["lead"] },
    ]);

    const res = await create(specPath, "extra");

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("orch.lead");
    expect(fs.existsSync(path.join(tmpDir, "extra.rigbundle"))).toBe(false);
  });

  it("操作员传入 allowDrift 时仍导出声明过多的 spec", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl"]);
    const specPath = writeSpec(RIG_NAME, [
      { id: "dev", members: ["impl"] },
      { id: "orch", members: ["lead"] },
    ]);

    const res = await create(specPath, "extra-allowed", { allowDrift: true });

    expect(res.status).toBe(201);
    expect(fs.existsSync(path.join(tmpDir, "extra-allowed.rigbundle"))).toBe(true);
  });

  // 畸形 SPEC 是损坏文件，不是 drifted rig。下方两个 fixture 同时也存在 drift，因此若实现先评估再
  // 校验，会返回 409 并让操作员去协调 topology，而真实答案是“此 spec 无法解析”。
  it("畸形 pod-aware spec 返回 schema 400，而非 drift 409", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl", "dev.qa", "orch.lead"]);
    const specPath = path.join(tmpDir, "malformed-pod.yaml");
    fs.writeFileSync(specPath, [
      'version: "0.2"',
      `name: ${RIG_NAME}`,
      "pods:",
      "  - id: dev",
      "    label: Dev",
      "    members:",
      "      - id: impl",           // 无 agent_ref、runtime 或 profile。
      "    edges: []",
      "edges: []",
    ].join("\n"));

    const res = await create(specPath, "malformed-pod");

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("非法 pod-aware 工作组 spec");
  });

  it("畸形旧版 spec 返回 schema 400，而非 drift 409", async () => {
    seedLiveRig(RIG_NAME, ["dev", "qa", "lead"]);
    const specPath = path.join(tmpDir, "malformed-legacy.yaml");
    fs.writeFileSync(specPath, [
      "schema_version: 1",
      `name: ${RIG_NAME}`,
      'version: "1.0"',
      "nodes:",
      "  - id: dev",                // 无 runtime。
      "edges: []",
    ].join("\n"));

    const res = await create(specPath, "malformed-legacy");

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("非法工作组 spec");
  });

  // FAIL-CLOSED。若无法执行比较，绝不能给出“无 drift，已导出”。guard 因自身查询抛错而报告 clean，
  // 比没有 guard 更糟：这是 recovery artifact 上无人可信的绿灯。
  it("topology 查询本身失败时 fail-closed——绝不静默执行 clean export", async () => {
    seedLiveRig(RIG_NAME, ["dev.impl", "dev.qa"]);
    const specPath = writeSpec(RIG_NAME, [{ id: "dev", members: ["impl"] }]);
    db.prepare("DROP TABLE nodes").run();

    const res = await create(specPath, "db-broken");

    expect(res.status).toBe(500);
    expect(fs.existsSync(path.join(tmpDir, "db-broken.rigbundle"))).toBe(false);
  });
});
