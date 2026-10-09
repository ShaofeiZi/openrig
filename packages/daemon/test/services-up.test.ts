import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function mockExec(responses?: Record<string, string | Error>): ExecFn {
  return async (cmd: string) => {
    if (responses) {
      for (const [pattern, response] of Object.entries(responses)) {
        if (cmd.includes(pattern)) {
          if (response instanceof Error) throw response;
          return response;
        }
      }
    }
    return "";
  };
}

const COMPOSE_PS_HEALTHY = JSON.stringify({
  Service: "vault",
  State: "running",
  Status: "Up",
  Health: "healthy",
});

describe("Bootstrap service gate（T03）", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "services-up-"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSpec(specYaml: string): string {
    const specPath = path.join(tmpDir, "rig.yaml");
    fs.writeFileSync(specPath, specYaml);
    return specPath;
  }

  it("无 services 的 spec 沿现有路径启动，且无 service 开销", async () => {
    const specPath = writeSpec(`
version: "0.2"
name: no-services-rig
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    const setup = createTestApp(db);
    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "apply",
    });

    expect(result.status).toBe("completed");
    // 不应出现 service_boot stage。
    expect(result.stages.some((s) => s.stage === "service_boot")).toBe(false);
  });

  it("启用 services 的 spec 会在 agent 启动前启动 service", async () => {
    const composePath = path.join(tmpDir, "docker-compose.yml");
    fs.writeFileSync(composePath, "version: '3'\nservices:\n  vault:\n    image: vault:1.15\n");

    const specPath = writeSpec(`
version: "0.2"
name: services-rig
services:
  kind: compose
  compose_file: docker-compose.yml
  wait_for:
    - url: http://localhost:8200/v1/sys/health
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    // 接入使用 mock exec 的 ServiceOrchestrator。
    const composeAdapter = new ComposeServicesAdapter(mockExec({
      "up -d": "",
      "ps --format json": COMPOSE_PS_HEALTHY,
      "curl": "200",
    }));
    const rigRepo = new RigRepository(db);
    const serviceOrch = new ServiceOrchestrator({ rigRepo, composeAdapter });

    const setup = createTestApp(db);
    // 通过 reflection 将 service 依赖注入 bootstrap orchestrator。
    (setup.bootstrapOrchestrator as any).deps.serviceOrchestrator = serviceOrch;
    (setup.bootstrapOrchestrator as any).deps.rigRepo = rigRepo;

    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "apply",
    });

    expect(result.status).toBe("completed");
    // service boot stage 应出现并成功。
    const serviceStage = result.stages.find((s) => s.stage === "service_boot");
    expect(serviceStage).toBeDefined();
    expect(serviceStage!.status).toBe("ok");
  });

  it("service 启动失败会以如实错误阻止 agent 启动", async () => {
    const composePath = path.join(tmpDir, "docker-compose.yml");
    fs.writeFileSync(composePath, "version: '3'\nservices:\n  vault:\n    image: vault:1.15\n");

    const specPath = writeSpec(`
version: "0.2"
name: failing-services-rig
services:
  kind: compose
  compose_file: docker-compose.yml
  wait_for:
    - url: http://localhost:8200/v1/sys/health
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    // 接入始终启动失败的 ServiceOrchestrator。
    const composeAdapter = new ComposeServicesAdapter(mockExec());
    const rigRepo = new RigRepository(db);
    const serviceOrch = new ServiceOrchestrator({ rigRepo, composeAdapter });
    // mock boot() 立即返回失败。
    vi.spyOn(serviceOrch, "boot").mockResolvedValue({
      ok: false,
      code: "wait_timeout",
      error: "等待 30 秒后服务目标仍不健康：HTTP 探针失败：http://localhost:8200/v1/sys/health",
      receipt: {
        kind: "compose",
        composeFile: "docker-compose.yml",
        projectName: "failing-services-rig",
        services: [{ name: "vault", status: "running", health: "starting" }],
        waitFor: [{ target: { url: "http://localhost:8200/v1/sys/health" }, status: "unhealthy", detail: "HTTP 探针失败" }],
        capturedAt: new Date().toISOString(),
      },
    });

    const setup = createTestApp(db);
    (setup.bootstrapOrchestrator as any).deps.serviceOrchestrator = serviceOrch;
    (setup.bootstrapOrchestrator as any).deps.rigRepo = rigRepo;

    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "apply",
    });

    expect(result.status).toBe("failed");
    // 错误应提到阻塞目标。
    expect(result.errors.some((e) => e.includes("服务引导失败"))).toBe(true);
    // service boot stage 应显示 failed。
    const serviceStage = result.stages.find((s) => s.stage === "service_boot");
    expect(serviceStage).toBeDefined();
    // OPR.0.3.2.22 Bug 2：修复前，service_boot_failed 会留下 orphan rig record（没有 session，
    // 但 rig 存在），导致下次重试陷入“library spec 与 restore target 有歧义”的 UX 陷阱。修复后，
    // prelaunch-hook 失败会回滚 rig record，因此 spec name 可供干净重试——且“未启动 agent session”
    // 的保证可由“无 rig”传递得出。
    const orphans = rigRepo.findRigsByName("failing-services-rig");
    expect(orphans, `service_boot_failed 后不应有 orphan rig record，实际为 ${JSON.stringify(orphans)}`).toHaveLength(0);
    expect(serviceStage!.status).toBe("failed");
  });

  // OPR.0.3.2.22 Bug 2 后续项（a29c7883 上的 guard BLOCKING）——compose 可能已启动后 boot 返回
  // ok:false（例如 wait_timeout）时，prelaunch-hook 必须在删除 rig record 前尽力调用 teardown。
  // 否则 compose resource 会成为 orphan：rig_services 随 rig 级联删除，并带走正常 teardown handle。
  // 判别条件：断言 boot 失败时调用了 teardown，且 rig record 仍被删除。
  it("service 启动失败时，在删除 rig record 前 teardown compose（无 compose orphan）", async () => {
    const composePath = path.join(tmpDir, "docker-compose.yml");
    fs.writeFileSync(composePath, "version: '3'\nservices:\n  vault:\n    image: vault:1.15\n");

    const specPath = writeSpec(`
version: "0.2"
name: teardown-on-boot-failure-rig
services:
  kind: compose
  compose_file: docker-compose.yml
  wait_for:
    - url: http://localhost:8200/v1/sys/health
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    const composeAdapter = new ComposeServicesAdapter(mockExec());
    const rigRepo = new RigRepository(db);
    const serviceOrch = new ServiceOrchestrator({ rigRepo, composeAdapter });

    vi.spyOn(serviceOrch, "boot").mockResolvedValue({
      ok: false,
      code: "wait_timeout",
      error: "等待 30 秒后服务目标仍不健康：HTTP 探针失败：http://localhost:8200/v1/sys/health",
      receipt: {
        kind: "compose",
        composeFile: "docker-compose.yml",
        projectName: "teardown-on-boot-failure-rig",
        services: [{ name: "vault", status: "running", health: "starting" }],
        waitFor: [{ target: { url: "http://localhost:8200/v1/sys/health" }, status: "unhealthy", detail: "HTTP 探针失败" }],
        capturedAt: new Date().toISOString(),
      },
    });
    const teardownSpy = vi.spyOn(serviceOrch, "teardown").mockResolvedValue({ ok: true });

    const setup = createTestApp(db);
    (setup.bootstrapOrchestrator as any).deps.serviceOrchestrator = serviceOrch;
    (setup.bootstrapOrchestrator as any).deps.rigRepo = rigRepo;

    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "apply",
    });

    expect(result.status).toBe("failed");
    // 判别条件：boot 失败时必须调用 teardown——这正是 bug guard 捕获的问题（删除 rig 后遗留
    // compose orphan）。
    expect(teardownSpy, "boot 失败时应尽力调用 serviceOrch.teardown").toHaveBeenCalledTimes(1);
    // rig record 仍会回滚（Bug 2 原始契约）。
    const orphans = rigRepo.findRigsByName("teardown-on-boot-failure-rig");
    expect(orphans).toHaveLength(0);
  });

  it("plan 模式不启动 service", async () => {
    const composePath = path.join(tmpDir, "docker-compose.yml");
    fs.writeFileSync(composePath, "version: '3'\nservices:\n  vault:\n    image: vault:1.15\n");

    const specPath = writeSpec(`
version: "0.2"
name: plan-services-rig
services:
  kind: compose
  compose_file: docker-compose.yml
pods:
  - id: infra
    label: Infra
    members:
      - id: server
        runtime: terminal
        agent_ref: "builtin:terminal"
        profile: none
        cwd: /tmp
    edges: []
`);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const composeAdapter = new ComposeServicesAdapter(exec);
    const rigRepo = new RigRepository(db);
    const serviceOrch = new ServiceOrchestrator({ rigRepo, composeAdapter });

    const setup = createTestApp(db);
    (setup.bootstrapOrchestrator as any).deps.serviceOrchestrator = serviceOrch;
    (setup.bootstrapOrchestrator as any).deps.rigRepo = rigRepo;

    const result = await setup.bootstrapOrchestrator.bootstrap({
      sourceRef: specPath,
      mode: "plan",
    });

    // plan 模式完全不应调用 docker compose。
    expect(exec).not.toHaveBeenCalled();
    // plan 模式中没有 service_boot stage。
    expect(result.stages.some((s) => s.stage === "service_boot")).toBe(false);
  });
});
