import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAllowlistedProviderAuthEnv, createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { StreamStore } from "../src/domain/stream-store.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { DEFAULT_SYSTEM_WORLD_MANIFEST } from "../src/domain/system-world.js";

function saveEnv(...names: string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function seedDbWithStaleSessions(dbPath: string, rigs: { rigName: string; logicalId: string; sessionName: string }[]) {
  const db = createDb(dbPath);
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, nodeSpecFieldsSchema, checkpointsSchema, agentspecRebootSchema]);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);

  for (const r of rigs) {
    const rig = rigRepo.createRig(r.rigName);
    const node = rigRepo.addNode(rig.id, r.logicalId);
    const session = sessionRegistry.registerSession(node.id, r.sessionName);
    sessionRegistry.updateStatus(session.id, "running");
  }

  db.close();
}

describe("createDaemon 启动组合", () => {
  // V0.3.1 slice 05 kernel-rig-as-default——启动测试构造 daemon，但不启动 kernel rig。
  // kernel 启动路径由 kernel-boot.test.ts（单元）与 kernel-rig-spec-validate.test.ts（variant gate）
  // 分别覆盖；这些测试断言外围 daemon 组合契约，因此无论 host 的 runtime auth 状态如何，
  // OPENRIG_NO_KERNEL=1 escape hatch 都能使它们快速且确定。
  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    delete process.env.OPENRIG_NO_KERNEL;
  });

  it("启动期间调用 cmuxAdapter.connect()", async () => {
    const connectCalled = vi.fn();
    const cmuxFactory: CmuxTransportFactory = async () => {
      connectCalled();
      const err = new Error("no socket") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    };
    const tmuxExec: ExecFn = async () => "";

    const { db } = await createDaemon({ cmuxFactory, tmuxExec });

    // 启动期间调用了 factory（调用 connect()）。
    expect(connectCalled).toHaveBeenCalled();

    db.close();
  });

  // Slice 51-01 stub-runtime——步骤 2（Registry-B 组合，RED-first）：createDaemon 组装的生产
  // runtime-adapter registry 必须注册 "stub" adapter，使 runtime:stub seat 能在暴露的
  // AppDeps.runtimeAdapters map 中解析（而不只是通过测试注入的 instantiator map）。当前为 RED：
  // startup.ts:898 runtimeAdapters = {claude-code, codex, pi, terminal}——没有 stub；构造并注册 stub
  // adapter（步骤 4）后转绿。驱动真实 createDaemon 组合，而非 mock。
  it("步骤 2：createDaemon 在生产 runtimeAdapters registry 中注册 stub adapter [startup.ts:898 添加 stub 前为 RED]", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      expect(deps.runtimeAdapters, "已暴露 AppDeps.runtimeAdapters").toBeDefined();
      expect(deps.runtimeAdapters!["stub"], "生产 runtimeAdapters registry 必须注册 stub adapter").toBeDefined();
    } finally {
      db.close();
    }
  }, 30000); // createDaemon 完整组合在冷启动时可能超过默认 5 秒。

  // GHOST-STAGE（e/Class-B）接缝共存锁定：dev-driver 的 fold 在 SeatHandoverService.commit() 中
  // 增加了 invalidateRetiringOccupant 调用，但从未接入具体 invalidator，因此生产环境中该调用会
  // 静默无效。这里断言 createDaemon 现在会构造并注入真实 OccupantInvalidator，使 re-key 失效在
  // 生产环境中实际触发（service 级调用触发由 seat-handover-service.test.ts 单独锁定）。去重时绝不能
  // 丢失 live 调用。
  it("接入具体 OccupantInvalidator，使 seat-handover re-key 失效在生产环境中实际触发", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    try {
      expect(deps.occupantInvalidator, "必须构造并注入 AppDeps.occupantInvalidator").toBeDefined();
      expect(typeof deps.occupantInvalidator!.invalidateRetiringOccupant).toBe("function");
    } finally {
      db.close();
    }
  }, 30000);

  // Slice 51-01 stub-runtime——步骤 3（首个生产 dispatch 证明，RED-first）：组装后的
  // PodRigInstantiator 私有 adapters map（startup.ts:710——与步骤 2 检查的 :898 runtimeAdapters map
  // 是不同字面量）必须把 runtime:stub seat dispatch 给 stub adapter，从而到达其 project() 生命周期
  // 方法。这里驱动真实 createDaemon 组合与生产 instantiate() entry（不是测试注入的 adapters map，
  // 也不只检查错误字符串缺失）。当前为 RED：adapters[:710] = {claude-code,codex,pi,terminal}，
  // 没有 stub → instantiate 遇到 "No adapter for runtime stub"（rigspec-instantiator.ts:1669），
  // 永远不会到达 startNode/project（:130）。步骤 4 在 :710 注册 stub adapter 后转绿。30 秒超时是
  // harness 预算（createDaemon 冷启动组合），不是产品 readiness。
  it("步骤 3：组装后的 instantiator 将 runtime:stub dispatch 到 stub adapter 并到达 project() [startup.ts:710 添加 stub 前为 RED]", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error("no socket"), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    // 真实 fs：组装后的 instantiator 使用 fs.readFileSync（startup.ts:709），因此 agent_ref 必须
    // 解析到 <rigRoot>/agents/impl/agent.yaml 上的真实文件。
    const rigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-stub-dispatch-"));
    fs.mkdirSync(path.join(rigRoot, "agents", "impl"), { recursive: true });
    fs.writeFileSync(
      path.join(rigRoot, "agents", "impl", "agent.yaml"),
      `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`,
    );

    // dispatch 前需要真实的 selected World。私下提供随附 selector，不依赖操作员的安装。
    const worldPath = path.join(rigRoot, "world.yaml");
    fs.writeFileSync(worldPath, DEFAULT_SYSTEM_WORLD_MANIFEST);
    const saved = saveEnv("OPENRIG_CONTEXT_SYSTEM_WORLD");
    process.env.OPENRIG_CONTEXT_SYSTEM_WORLD = worldPath;
    let db: ReturnType<typeof createDb> | undefined;
    try {
      const daemon = await createDaemon({ cmuxFactory, tmuxExec });
      db = daemon.db;
      const { deps } = daemon;
      // 访问生产 instantiator 的私有 adapters map（startup.ts:710）。
      const adapters = (deps.podInstantiator as unknown as {
        deps: { adapters: Record<string, RuntimeAdapter> };
      }).deps.adapters;

      const stub = adapters["stub"];
      // 当前 RED guard：步骤 4 前，生产 instantiator adapters map 没有 stub adapter。
      expect(stub, "生产 instantiator adapters map（startup.ts:710）必须注册 stub adapter").toBeDefined();

      // 观测真实生产 adapter 上具名的生命周期方法（spy 会透传调用）。
      const projectSpy = vi.spyOn(stub!, "project");

      const specYaml = RigSpecCodec.serialize({
        version: "0.2",
        name: "stub-dispatch-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "stub", cwd: "." }],
          edges: [],
        }],
        edges: [],
      });

      const result = await deps.podInstantiator.instantiate(specYaml, rigRoot);

      // 承重断言：dispatch 到达 stub adapter 的 project()（startup-orchestrator.ts:130）。
      expect(projectSpy, `instantiate 必须将 project() dispatch 到生产 stub adapter：${JSON.stringify(result)}`).toHaveBeenCalled();
    } finally {
      restoreEnv(saved);
      db?.close();
      fs.rmSync(rigRoot, { recursive: true, force: true });
    }
  }, 30000); // harness 预算（createDaemon 冷启动组合），不是产品 readiness。

  it("terminal auth 默认为 local-trusted 模式，且不创建 token 文件", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-terminal-auth-"));
    const priorHome = process.env.OPENRIG_HOME;
    const priorToken = process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
    process.env.OPENRIG_HOME = tmpDir;
    delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

      expect(deps.terminalBearerToken).toBeNull();
      expect(fs.existsSync(path.join(tmpDir, "terminal-token"))).toBe(false);

      db.close();
    } finally {
      if (priorHome === undefined) delete process.env.OPENRIG_HOME;
      else process.env.OPENRIG_HOME = priorHome;
      if (priorToken === undefined) delete process.env.OPENRIG_TERMINAL_BEARER_TOKEN;
      else process.env.OPENRIG_TERMINAL_BEARER_TOKEN = priorToken;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("createDaemon app：GET /api/rigs/:rigId/sessions 返回 200（session 路由已挂载）", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

    // 预置 rig，使 sessions endpoint 有内容可查询。
    const rig = deps.rigRepo.createRig("r01");

    const res = await app.request(`/api/rigs/${rig.id}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    db.close();
  });

  it("没有实体化 kernel rig 时，createDaemon queue 校验仍接受一等 human seat", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

    const canonical = await deps.queueRepo.create({
      sourceSession: "dev-qa@implementation-pair",
      destinationSession: "human-operator@kernel",
      body: "human gate smoke",
      tier: "human-gate",
      summary: "test summary (FR-4 human-routed fixture)",
      evidenceRef: "proof/test-evidence.md",
      nudge: false,
    });
    const generic = await deps.queueRepo.create({
      sourceSession: "dev-qa@implementation-pair",
      destinationSession: "human@host",
      body: "human host smoke",
      tier: "human-gate",
      summary: "test summary (FR-4 human-routed fixture)",
      evidenceRef: "proof/test-evidence.md",
      nudge: false,
    });

    expect(canonical.destinationSession).toBe("human-operator@kernel");
    expect(generic.destinationSession).toBe("human@host");
    await expect(
      deps.queueRepo.create({
        sourceSession: "dev-qa@implementation-pair",
        destinationSession: "driver@phantom-rig",
        body: "must still reject phantom rigs",
        nudge: false,
      }),
    ).rejects.toThrow(/未知 rig/);

    db.close();
  });

  it("createDaemon app：GET /api/adapters/cmux/status 返回 200（adapter 路由已挂载）", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app, db } = await createDaemon({ cmuxFactory, tmuxExec });

    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("available");

    db.close();
  });

  it("将 daemon CLI 可达性环境变量与 PATH 传入已启动的 tmux session", async () => {
    vi.stubEnv("PATH", "/proof/openrig/bin:/usr/bin:/bin");
    vi.stubEnv("OPENRIG_PORT", "17433");
    vi.stubEnv("OPENRIG_HOST", "127.0.0.1");
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec = vi.fn<ExecFn>(async () => "");

    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      const rig = deps.rigRepo.createRig("path-env-rig");
      deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });

      const result = await deps.nodeLauncher.launchNode(rig.id, "worker");

      expect(result.ok).toBe(true);
      const newSessionCmd = tmuxExec.mock.calls
        .map((call) => call[0])
        .find((cmd) => cmd.includes("tmux new-session"));
      expect(newSessionCmd).toBeDefined();
      expect(newSessionCmd).toContain("-e 'PATH=/proof/openrig/bin:/usr/bin:/bin'");
      expect(newSessionCmd).toContain("-e 'OPENRIG_PORT=17433'");
      expect(newSessionCmd).toContain("-e 'OPENRIG_HOST=127.0.0.1'");

      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("GAP-7 将 daemon HOME 与默认绝对 CODEX_HOME 投影到生产 launch env", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-gap7-default-"));
    const daemonHome = path.join(root, "daemon-home");
    fs.mkdirSync(daemonHome, { recursive: true });
    const saved = saveEnv("HOME", "CODEX_HOME", "PATH", "OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST", "OPENAI_API_KEY");
    process.env.HOME = daemonHome;
    delete process.env.CODEX_HOME;
    process.env.PATH = "/proof/openrig/bin:/usr/bin:/bin";
    process.env.OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST = "OPENAI_API_KEY";
    process.env.OPENAI_API_KEY = "gap7-openai-key";
    const tmuxExec = vi.fn<ExecFn>(async () => "");
    let result: Awaited<ReturnType<typeof createDaemon>> | undefined;

    try {
      result = await createDaemon({
        cmuxFactory: async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); },
        tmuxExec,
      });
      expect(result.deps.sessionEnv).toMatchObject({
        HOME: daemonHome,
        CODEX_HOME: path.join(daemonHome, ".codex"),
        PATH: "/proof/openrig/bin:/usr/bin:/bin",
        OPENAI_API_KEY: "gap7-openai-key",
      });

      const rig = result.deps.rigRepo.createRig("gap7-default");
      result.deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });
      expect((await result.deps.nodeLauncher.launchNode(rig.id, "worker")).ok).toBe(true);
      const command = tmuxExec.mock.calls.map((call) => call[0]).find((line) => line.includes("tmux new-session"));
      expect(command).toContain(`-e 'HOME=${daemonHome}'`);
      expect(command).toContain(`-e 'CODEX_HOME=${path.join(daemonHome, ".codex")}'`);
      expect(command).toContain("-e 'PATH=/proof/openrig/bin:/usr/bin:/bin'");
      expect(command).toContain("-e 'OPENAI_API_KEY=gap7-openai-key'");
    } finally {
      result?.db.close();
      restoreEnv(saved);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP-7 在生产 session env 与 adapter config 写入之间共享同一个自定义绝对 CODEX_HOME", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-gap7-custom-"));
    const daemonHome = path.join(root, "daemon-home");
    const codexHome = path.join(root, "daemon-codex");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const saved = saveEnv("HOME", "CODEX_HOME");
    process.env.HOME = daemonHome;
    process.env.CODEX_HOME = codexHome;
    let result: Awaited<ReturnType<typeof createDaemon>> | undefined;

    try {
      result = await createDaemon({
        cmuxFactory: async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); },
        tmuxExec: async () => "",
      });
      expect(result.deps.sessionEnv).toMatchObject({ HOME: daemonHome, CODEX_HOME: codexHome });
      const adapter = result.deps.runtimeAdapters?.codex;
      expect(adapter).toBeDefined();
      await adapter!.deliverStartup([], {
        id: "gap7-binding", nodeId: "gap7-node", tmuxSession: "gap7-session",
        tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
        updatedAt: "", cwd: workspace,
      });
      const configPath = path.join(codexHome, "config.toml");
      expect(fs.readFileSync(configPath, "utf8")).toContain(`[projects."${workspace}"]`);
      expect(fs.existsSync(path.join(daemonHome, ".codex", "config.toml"))).toBe(false);
    } finally {
      result?.db.close();
      restoreEnv(saved);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GAP-7 在组合期间、启动任何 tmux session 前拒绝相对 CODEX_HOME", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-gap7-relative-"));
    const saved = saveEnv("HOME", "CODEX_HOME");
    process.env.HOME = path.join(root, "daemon-home");
    process.env.CODEX_HOME = "relative-codex-home";
    const tmuxExec = vi.fn<ExecFn>(async () => "");
    let result: Awaited<ReturnType<typeof createDaemon>> | undefined;
    let thrown: unknown;

    try {
      try {
        result = await createDaemon({
          cmuxFactory: async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); },
          tmuxExec,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/CODEX_HOME.*绝对路径/);
      expect(tmuxExec.mock.calls.some((call) => call[0].includes("tmux new-session"))).toBe(false);
    } finally {
      result?.db.close();
      restoreEnv(saved);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // OPR.0.4.3.28 阻塞项 2——自动配置的 OPENRIG_URL 必须遵循显式 daemon bind host（daemon 只
  // 绑定该 host），不能使用 tailnet/hostname-bound daemon 未监听的硬编码 loopback。
  it("根据显式 bind host 自动配置 OPENRIG_URL，并传入已启动 tmux session", async () => {
    vi.stubEnv("OPENRIG_PORT", "17433");
    vi.stubEnv("OPENRIG_HOST", "100.64.0.5");
    vi.stubEnv("OPENRIG_URL", ""); // 非操作员提供 → 由 daemon 推导。
    vi.stubEnv("OPENRIG_ACTIVITY_HOOK_TOKEN", "");
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec = vi.fn<ExecFn>(async () => "");
    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      const rig = deps.rigRepo.createRig("url-derive-rig");
      deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });
      const result = await deps.nodeLauncher.launchNode(rig.id, "worker");
      expect(result.ok).toBe(true);
      const newSessionCmd = tmuxExec.mock.calls
        .map((call) => call[0])
        .find((cmd) => cmd.includes("tmux new-session"));
      expect(newSessionCmd).toBeDefined();
      expect(newSessionCmd).toContain("-e 'OPENRIG_URL=http://100.64.0.5:17433'");
      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("只将显式 allowlist 中的 provider auth env 传入已启动 tmux session", async () => {
    vi.stubEnv("OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST", "ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENAI_API_KEY,BOGUS_TOKEN");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-test-token");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    vi.stubEnv("BOGUS_TOKEN", "must-not-leak");
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec = vi.fn<ExecFn>(async () => "");

    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      const rig = deps.rigRepo.createRig("provider-auth-env-rig");
      deps.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

      const result = await deps.nodeLauncher.launchNode(rig.id, "worker");

      expect(result.ok).toBe(true);
      const newSessionCmd = tmuxExec.mock.calls
        .map((call) => call[0])
        .find((cmd) => cmd.includes("tmux new-session"));
      expect(newSessionCmd).toBeDefined();
      expect(newSessionCmd).toContain("-e 'ANTHROPIC_API_KEY=anthropic-test-key'");
      expect(newSessionCmd).toContain("-e 'CLAUDE_CODE_OAUTH_TOKEN=claude-oauth-test-token'");
      expect(newSessionCmd).toContain("-e 'OPENAI_API_KEY=openai-test-key'");
      expect(newSessionCmd).not.toContain("BOGUS_TOKEN");

      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("collectAllowlistedProviderAuthEnv 忽略空、非法与未知名称", () => {
    expect(collectAllowlistedProviderAuthEnv(
      "ANTHROPIC_API_KEY, nope, ../BAD, OPENAI_API_KEY, BOGUS_TOKEN, CLAUDE_CODE_OAUTH_TOKEN",
      {
        ANTHROPIC_API_KEY: "anthropic-test-key",
        OPENAI_API_KEY: "",
        BOGUS_TOKEN: "must-not-leak",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-test-token",
      },
    )).toEqual({
      ANTHROPIC_API_KEY: "anthropic-test-key",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-test-token",
    });
  });

  it("createDaemon 为 POST /api/rigs/:rigId/nodes/:logicalId/open-cmux 接入 node cmux service", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") return { capabilities: ["workspace.current", "surface.create", "surface.focus"] };
        if (method === "workspace.current") return { workspace_id: "workspace:1" };
        if (method === "surface.create") return { created_surface_ref: "surface:99" };
        return {};
      },
      close: () => {},
    });
    const tmuxExec: ExecFn = async () => "";

    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    const rig = deps.rigRepo.createRig("r01");
    const node = deps.rigRepo.addNode(rig.id, "dev1-impl");
    deps.sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    deps.sessionRegistry.updateBinding(node.id, {
      attachmentType: "tmux",
      tmuxSession: "r01-dev1-impl",
    });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    const binding = deps.sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");

    db.close();
  });

  it("createDaemon 接受 cmuxExec，connect() 通过它探测 live cmux surface", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("command not found"), { code: "ENOENT" })
    );
    const tmuxExec: ExecFn = async () => "";

    const { db } = await createDaemon({ cmuxExec, tmuxExec });

    // 启动 connect() 期间调用了注入的 cmuxExec。transport 现在会先通过 `cmux --help` 探测 live
    // command surface，再发出适配版本的请求。
    expect(cmuxExec).toHaveBeenCalled();
    const helpCall = cmuxExec.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("cmux --help")
    );
    expect(helpCall).toBeDefined();

    db.close();
  });

  it("cmuxExec 抛错时，createDaemon 仍可干净降级", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("command not found"), { code: "ENOENT" })
    );
    const tmuxExec: ExecFn = async () => "";

    const { app, db } = await createDaemon({ cmuxExec, tmuxExec });

    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);

    db.close();
  });

  it("启动时对账陈旧 session：status=detached，且 DB 中存在 event row", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
    ]);

    // tmux 报告没有 session（session 已消失）：list-sessions 返回空；has-session 抛错
    //（session not found）。
    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

    // createDaemon 返回后，session 应为 detached。
    const sessions = db.prepare("SELECT status FROM sessions").all() as { status: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("detached");

    // event row 应存在。
    const events = db.prepare("SELECT type FROM events WHERE type = 'session.detached'").all();
    expect(events).toHaveLength(1);

    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("启动时对账多个 rig：所有陈旧 session 均 detached", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
      { rigName: "r02", logicalId: "dev2-impl", sessionName: "r02-dev2-impl" },
    ]);

    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

    // 两个 session 都应为 detached。
    const sessions = db.prepare("SELECT status FROM sessions ORDER BY session_name").all() as { status: string }[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.status).toBe("detached");
    expect(sessions[1]!.status).toBe("detached");

    // 两个 event 都应存在。
    const events = db.prepare("SELECT type FROM events WHERE type = 'session.detached'").all();
    expect(events).toHaveLength(2);

    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("空 DB 上的启动对账可无错运行", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ tmuxExec, cmuxExec });

    // 没有 session、event 或错误。
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(0);

    db.close();
  });

  // L1 冷启动 tmux truth 修复：启动必须呈现紧凑 reconcile 摘要，使静默对账 drift 在 daemon
  // 输出中可见。
  it("启动时记录紧凑 reconcile 摘要行", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
    ]);

    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const summary = calls.find((line) => line.startsWith("启动协调："));
      expect(summary).toBeDefined();
      expect(summary).toMatch(/rigs=1\b/);
      expect(summary).toMatch(/checked=1\b/);
      expect(summary).toMatch(/detached=1\b/);
      expect(summary).toMatch(/errors=0\b/);

      db.close();
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("setDegradedHandler 注册抛错不会中止 createDaemon", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const recorder = {
      setDegradedHandler() {
        throw new Error("registration boom");
      },
      snapshot: () => ({ healthy: true }),
    };
    const { db, eventLoopMonitor } = await createDaemon({
      cmuxFactory,
      tmuxExec,
      slowOpRecorder: recorder,
    } as never);
    eventLoopMonitor.stop();
    db.close();
  });

  it("将抛错的 degradation callback body（streamStore.emit）与后续工作隔离", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";
    const originalEmit = StreamStore.prototype.emit;
    const spy = vi
      .spyOn(StreamStore.prototype, "emit")
      .mockImplementation(function (this: StreamStore, item: Parameters<StreamStore["emit"]>[0]) {
        if (typeof item?.body === "string" && item.body.includes("slow-operation instrumentation degraded")) {
          throw new Error("emit boom");
        }
        return originalEmit.call(this, item);
      });
    let captured: ((snapshot: { reason: string; site: string }) => void) | undefined;
    const recorder = {
      setDegradedHandler(handler: (snapshot: { reason: string; site: string }) => void) {
        captured = handler;
      },
      snapshot: () => ({ healthy: true }),
    };
    try {
      const { db, eventLoopMonitor } = await createDaemon({
        cmuxFactory,
        tmuxExec,
        slowOpRecorder: recorder,
      } as never);
      expect(captured).toBeTypeOf("function");
      // 后续 degradation 会触发所提供 callback；其 body 内抛错的 emit 必须被吞掉，绝不能逸出到
      // 被包装的工作。
      expect(() => captured!({ reason: "recorder_worker_failed", site: "recorder.worker" })).not.toThrow();
      eventLoopMonitor.stop();
      db.close();
    } finally {
      spy.mockRestore();
    }
  });
});
