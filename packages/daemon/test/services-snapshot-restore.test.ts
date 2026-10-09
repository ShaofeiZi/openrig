import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { RigServicesSpec } from "../src/domain/types.js";

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

describe("服务快照/恢复/拆除（T04）", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedRigWithServices(spec: RigServicesSpec) {
    const rig = setup.rigRepo.createRig("test-rig");
    setup.rigRepo.setServicesRecord(rig.id, {
      kind: "compose",
      specJson: JSON.stringify(spec),
      rigRoot: "/tmp/test-rig",
      composeFile: spec.composeFile,
      projectName: "test-rig",
      latestReceiptJson: JSON.stringify({
        kind: "compose",
        composeFile: spec.composeFile,
        projectName: "test-rig",
        services: [{ name: "vault", status: "running", health: "healthy" }],
        waitFor: [],
        capturedAt: new Date().toISOString(),
      }),
    });
    return rig;
  }

  it("快照从服务记录捕获环境回执", () => {
    const spec: RigServicesSpec = { kind: "compose", composeFile: "docker-compose.yml" };
    const rig = seedRigWithServices(spec);

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "test");

    expect(snapshot.data.envReceipt).toBeDefined();
    expect(snapshot.data.envReceipt!.kind).toBe("compose");
    expect(snapshot.data.envReceipt!.services).toHaveLength(1);
    expect(snapshot.data.envReceipt!.services[0]!.name).toBe("vault");
  });

  it("没有服务的快照其 envReceipt 为 null", () => {
    const rig = setup.rigRepo.createRig("plain-rig");

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "test");

    expect(snapshot.data.envReceipt).toBeNull();
  });

  it("拆除为启用服务的工作组调用服务拆除", async () => {
    const spec: RigServicesSpec = { kind: "compose", composeFile: "docker-compose.yml", downPolicy: "down" };
    const rig = seedRigWithServices(spec);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const composeAdapter = new ComposeServicesAdapter(exec);
    const serviceOrch = new ServiceOrchestrator({ rigRepo: setup.rigRepo, composeAdapter });

    // 将 service orchestrator 注入 teardown
    (setup.teardownOrchestrator as any).deps.serviceOrchestrator = serviceOrch;

    const result = await setup.teardownOrchestrator.teardown(rig.id);

    expect(result.errors).toHaveLength(0);
    // Service teardown 应已调用 docker compose down
    const downCalls = exec.mock.calls.filter((c) => (c[0] as string).includes("down"));
    expect(downCalls.length).toBeGreaterThan(0);
  });

  it("采用 leave_running 策略拆除时不调用 compose down", async () => {
    const spec: RigServicesSpec = { kind: "compose", composeFile: "docker-compose.yml", downPolicy: "leave_running" };
    const rig = seedRigWithServices(spec);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const composeAdapter = new ComposeServicesAdapter(exec);
    const serviceOrch = new ServiceOrchestrator({ rigRepo: setup.rigRepo, composeAdapter });

    (setup.teardownOrchestrator as any).deps.serviceOrchestrator = serviceOrch;

    const result = await setup.teardownOrchestrator.teardown(rig.id);

    expect(result.errors).toHaveLength(0);
    // leave_running = no docker compose down call
    const downCalls = exec.mock.calls.filter((c) => (c[0] as string).includes("down"));
    expect(downCalls).toHaveLength(0);
  });

  it("没有服务时拆除不尝试服务拆除", async () => {
    const rig = setup.rigRepo.createRig("plain-rig");

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const composeAdapter = new ComposeServicesAdapter(exec);
    const serviceOrch = new ServiceOrchestrator({ rigRepo: setup.rigRepo, composeAdapter });

    (setup.teardownOrchestrator as any).deps.serviceOrchestrator = serviceOrch;

    const result = await setup.teardownOrchestrator.teardown(rig.id);

    expect(result.errors).toHaveLength(0);
    expect(exec).not.toHaveBeenCalled();
  });

  it("没有检查点 hook 时快照连续性为 receipt_only", () => {
    const spec: RigServicesSpec = { kind: "compose", composeFile: "docker-compose.yml" };
    const rig = seedRigWithServices(spec);

    const snapshot = setup.snapshotCapture.captureSnapshot(rig.id, "test");

    // envReceipt 存在但无 checkpoint artifact
    expect(snapshot.data.envReceipt).toBeDefined();
    // 无 envCheckpoint 字段——仅 receipt 诚实
    expect((snapshot.data as Record<string, unknown>)["envCheckpoint"]).toBeUndefined();
  });
});
