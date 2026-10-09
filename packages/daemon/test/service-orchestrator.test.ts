import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { ServiceOrchestrator } from "../src/domain/service-orchestrator.js";
import { evaluateWaitTargets, deriveEnvHealth } from "../src/domain/services-readiness.js";
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

const COMPOSE_PS_LINE = JSON.stringify({
  Service: "vault",
  Name: "myproject-vault-1",
  State: "running",
  Status: "Up 5 seconds",
  Health: "healthy",
});

const COMPOSE_PS_ARRAY = JSON.stringify([
  { Service: "vault", Name: "myproject-vault-1", State: "running", Status: "Up 5 seconds", Health: "healthy" },
  { Service: "redis", Name: "myproject-redis-1", State: "running", Status: "Up 3 seconds", Health: "" },
]);

describe("ComposeServicesAdapter", () => {
  it("up 使用正确参数调用 docker compose up -d", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const adapter = new ComposeServicesAdapter(exec);

    await adapter.up({ composeFile: "/tmp/docker-compose.yml", projectName: "my-rig" });

    expect(exec).toHaveBeenCalledOnce();
    const cmd = exec.mock.calls[0]![0] as string;
    expect(cmd).toContain("docker compose");
    expect(cmd).toContain("-f '/tmp/docker-compose.yml'");
    expect(cmd).toContain("-p 'my-rig'");
    expect(cmd).toContain("up -d");
    expect(cmd).not.toContain("--wait"); // readiness 单独处理。
  });

  it("down 调用 docker compose down", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const adapter = new ComposeServicesAdapter(exec);

    await adapter.down({ composeFile: "/tmp/dc.yml", projectName: "rig", policy: "down" });

    const cmd = exec.mock.calls[0]![0] as string;
    expect(cmd).toContain("down");
    expect(cmd).not.toContain("--volumes");
  });

  it("down 使用 down_and_volumes 时传入 --volumes", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const adapter = new ComposeServicesAdapter(exec);

    await adapter.down({ composeFile: "/tmp/dc.yml", projectName: "rig", policy: "down_and_volumes" });

    const cmd = exec.mock.calls[0]![0] as string;
    expect(cmd).toContain("--volumes");
  });

  it("down 使用 leave_running 时不执行操作", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const adapter = new ComposeServicesAdapter(exec);

    const result = await adapter.down({ composeFile: "/tmp/dc.yml", projectName: "rig", policy: "leave_running" });

    expect(result.ok).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("status 解析每行一个对象的格式", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue(COMPOSE_PS_LINE);
    const adapter = new ComposeServicesAdapter(exec);

    const result = await adapter.status({ composeFile: "/tmp/dc.yml", projectName: "rig" });

    expect(result.ok).toBe(true);
    expect(result.services).toHaveLength(1);
    expect(result.services[0]!.name).toBe("vault");
    expect(result.services[0]!.health).toBe("healthy");
  });

  it("status 解析 JSON 数组格式", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue(COMPOSE_PS_ARRAY);
    const adapter = new ComposeServicesAdapter(exec);

    const result = await adapter.status({ composeFile: "/tmp/dc.yml", projectName: "rig" });

    expect(result.ok).toBe(true);
    expect(result.services).toHaveLength(2);
    expect(result.services[0]!.name).toBe("vault");
    expect(result.services[1]!.name).toBe("redis");
  });

  it("status 对无法解析的非空输出返回如实错误", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("{not-json");
    const adapter = new ComposeServicesAdapter(exec);

    const result = await adapter.status({ composeFile: "/tmp/dc.yml", projectName: "rig" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法解析");
  });

  it("status 忽略只有警告的输出并返回空服务列表", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue(
      'time="2026-04-09T06:06:45-07:00" level=warning msg="compose warning"',
    );
    const adapter = new ComposeServicesAdapter(exec);

    const result = await adapter.status({ composeFile: "/tmp/dc.yml", projectName: "rig" });

    expect(result.ok).toBe(true);
    expect(result.services).toEqual([]);
  });

  it("status 忽略 JSON payload 之前的警告行", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue(
      'time="2026-04-09T06:06:45-07:00" level=warning msg="compose warning"\n'
        + COMPOSE_PS_LINE,
    );
    const adapter = new ComposeServicesAdapter(exec);

    const result = await adapter.status({ composeFile: "/tmp/dc.yml", projectName: "rig" });

    expect(result.ok).toBe(true);
    expect(result.services[0]!.name).toBe("vault");
  });

  it("logs 调用 docker compose logs 并传入服务过滤器", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("vault log output");
    const adapter = new ComposeServicesAdapter(exec);

    const result = await adapter.logs({ composeFile: "/tmp/dc.yml", projectName: "rig", service: "vault", tail: 50 });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("vault log output");
    const cmd = exec.mock.calls[0]![0] as string;
    expect(cmd).toContain("logs");
    expect(cmd).toContain("--tail 50");
    expect(cmd).toContain("'vault'");
  });

  it("captureReceipt 根据 ps 输出构建规范化回执", async () => {
    const adapter = new ComposeServicesAdapter(mockExec({ "ps --format json": COMPOSE_PS_LINE }));

    const result = await adapter.status({ composeFile: "/tmp/dc.yml", projectName: "rig" });
    expect(result.services[0]!.name).toBe("vault");
    expect(result.services[0]!.state).toBe("running");
    expect(result.services[0]!.health).toBe("healthy");
  });

  it("up 失败时呈现底层 compose 输出", async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("Command failed: docker compose up -d"), {
        stdout: "unknown shorthand flag: 'f' in -f",
        stderr: "",
      }),
    );
    const adapter = new ComposeServicesAdapter(exec);

    const result = await adapter.up({ composeFile: "/tmp/docker-compose.yml", projectName: "my-rig" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("unknown shorthand flag");
  });
});

describe("services-readiness", () => {
  it("evaluateWaitTargets——HTTP 目标健康", async () => {
    const adapter = new ComposeServicesAdapter(mockExec({ "curl": "200" }));

    const results = await evaluateWaitTargets(
      [{ url: "http://localhost:8200/v1/sys/health" }],
      adapter,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("healthy");
  });

  it("evaluateWaitTargets——HTTP 目标不健康", async () => {
    const adapter = new ComposeServicesAdapter(mockExec({ "curl": new Error("connection refused") }));

    const results = await evaluateWaitTargets(
      [{ url: "http://localhost:8200/v1/sys/health" }],
      adapter,
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("unhealthy");
  });

  it("evaluateWaitTargets——通过 compose status 满足 condition:healthy", async () => {
    const adapter = new ComposeServicesAdapter(mockExec());

    const results = await evaluateWaitTargets(
      [{ service: "vault", condition: "healthy" }],
      adapter,
      [{ name: "vault", state: "running", status: "Up", health: "healthy" }],
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("healthy");
  });

  it("evaluateWaitTargets——要求 condition:healthy 但服务不健康", async () => {
    const adapter = new ComposeServicesAdapter(mockExec());

    const results = await evaluateWaitTargets(
      [{ service: "vault", condition: "healthy" }],
      adapter,
      [{ name: "vault", state: "running", status: "Up", health: "starting" }],
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("pending");
  });

  it("deriveEnvHealth——全部健康", () => {
    expect(deriveEnvHealth([
      { target: { url: "http://x" }, status: "healthy", detail: null },
    ])).toBe("healthy");
  });

  it("deriveEnvHealth——混合状态", () => {
    expect(deriveEnvHealth([
      { target: { url: "http://x" }, status: "healthy", detail: null },
      { target: { url: "http://y" }, status: "unhealthy", detail: "fail" },
    ])).toBe("degraded");
  });

  it("deriveEnvHealth——全部不健康", () => {
    expect(deriveEnvHealth([
      { target: { url: "http://x" }, status: "unhealthy", detail: "fail" },
    ])).toBe("unhealthy");
  });
});

describe("ServiceOrchestrator", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
  });

  afterEach(() => { db.close(); });

  function seedRigWithServices(spec: RigServicesSpec) {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.setServicesRecord(rig.id, {
      kind: "compose",
      specJson: JSON.stringify(spec),
      rigRoot: "/tmp/test-rig",
      composeFile: spec.composeFile,
      projectName: "test-rig",
    });
    return rig;
  }

  it("boot——启动服务、等待健康并持久化回执", async () => {
    const spec: RigServicesSpec = {
      kind: "compose",
      composeFile: "docker-compose.yml",
      waitFor: [{ url: "http://localhost:8200/v1/sys/health" }],
    };
    const rig = seedRigWithServices(spec);

    const adapter = new ComposeServicesAdapter(mockExec({
      "up -d": "",
      "ps --format json": COMPOSE_PS_LINE,
      "curl": "200",
    }));

    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
    const result = await orchestrator.boot(rig.id, { waitTimeoutMs: 5000, waitPollIntervalMs: 100 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.health).toBe("healthy");
    expect(result.receipt.services).toHaveLength(1);
    expect(result.receipt.waitFor).toHaveLength(1);
    expect(result.receipt.waitFor[0]!.status).toBe("healthy");

    // 验证回执已持久化。
    const record = rigRepo.getServicesRecord(rig.id);
    expect(record?.latestReceiptJson).toBeTruthy();
  });

  it("boot——等待目标失败时返回如实错误与回执", async () => {
    const spec: RigServicesSpec = {
      kind: "compose",
      composeFile: "docker-compose.yml",
      waitFor: [{ url: "http://localhost:8200/v1/sys/health" }],
    };
    const rig = seedRigWithServices(spec);

    const adapter = new ComposeServicesAdapter(mockExec({
      "up -d": "",
      "ps --format json": COMPOSE_PS_LINE,
      "curl": new Error("connection refused"),
    }));

    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
    const result = await orchestrator.boot(rig.id, { waitTimeoutMs: 500, waitPollIntervalMs: 100 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("wait_timeout");
    expect(result.error).toContain("服务目标仍不健康");
    expect(result.receipt).toBeDefined();
    expect(result.receipt!.waitFor[0]!.status).toBe("unhealthy");
  });

  it("teardown——按 down_policy 拆除", async () => {
    const spec: RigServicesSpec = {
      kind: "compose",
      composeFile: "docker-compose.yml",
      downPolicy: "down_and_volumes",
    };
    const rig = seedRigWithServices(spec);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const adapter = new ComposeServicesAdapter(exec);

    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
    const result = await orchestrator.teardown(rig.id);

    expect(result.ok).toBe(true);
    const cmd = exec.mock.calls[0]![0] as string;
    expect(cmd).toContain("down");
    expect(cmd).toContain("--volumes");

    // 拆除后清除回执。
    const record = rigRepo.getServicesRecord(rig.id);
    expect(record?.latestReceiptJson).toBeNull();
  });

  it("teardown——leave_running policy 跳过 compose down", async () => {
    const spec: RigServicesSpec = {
      kind: "compose",
      composeFile: "docker-compose.yml",
      downPolicy: "leave_running",
    };
    const rig = seedRigWithServices(spec);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const adapter = new ComposeServicesAdapter(exec);

    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
    const result = await orchestrator.teardown(rig.id);

    expect(result.ok).toBe(true);
    expect(exec).not.toHaveBeenCalled(); // 未发出 docker compose 命令。
  });

  it("teardown——policyOverride 覆盖已持久化的 down_policy", async () => {
    const spec: RigServicesSpec = {
      kind: "compose",
      composeFile: "docker-compose.yml",
      downPolicy: "down", // 持久化策略只是 "down"。
    };
    const rig = seedRigWithServices(spec);

    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const adapter = new ComposeServicesAdapter(exec);

    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
    const result = await orchestrator.teardown(rig.id, { policyOverride: "down_and_volumes" });

    expect(result.ok).toBe(true);
    const cmd = exec.mock.calls[0]![0] as string;
    expect(cmd).toContain("down");
    expect(cmd).toContain("--volumes"); // 覆盖值优先于持久化的 "down"。
  });

  it("boot——没有 services 记录时返回如实错误", async () => {
    const rig = rigRepo.createRig("bare-rig");

    const adapter = new ComposeServicesAdapter(mockExec());
    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
    const result = await orchestrator.boot(rig.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_services");
  });

  it("boot——没有等待目标时仍捕获回执", async () => {
    const spec: RigServicesSpec = {
      kind: "compose",
      composeFile: "docker-compose.yml",
      // 不设置 waitFor。
    };
    const rig = seedRigWithServices(spec);

    const adapter = new ComposeServicesAdapter(mockExec({
      "up -d": "",
      "ps --format json": COMPOSE_PS_LINE,
    }));

    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
    const result = await orchestrator.boot(rig.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.services).toHaveLength(1);
    expect(result.receipt.waitFor).toHaveLength(0);
  });

  it("boot——没有等待目标但 compose status 失败时返回如实错误", async () => {
    const spec: RigServicesSpec = {
      kind: "compose",
      composeFile: "docker-compose.yml",
    };
    const rig = seedRigWithServices(spec);

    const adapter = new ComposeServicesAdapter(mockExec({
      "up -d": "",
      "ps --format json": new Error("compose ps failed"),
    }));

    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });
    const result = await orchestrator.boot(rig.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("compose_status_failed");
    expect(result.error).toContain("compose ps failed");
  });

  it("compose status 无法读取时 captureReceipt 抛错", async () => {
    const spec: RigServicesSpec = {
      kind: "compose",
      composeFile: "docker-compose.yml",
    };
    const rig = seedRigWithServices(spec);

    const adapter = new ComposeServicesAdapter(mockExec({
      "ps --format json": new Error("compose ps failed"),
    }));

    const orchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter: adapter });

    await expect(orchestrator.captureReceipt(rig.id)).rejects.toThrow("compose ps failed");
  });
});
