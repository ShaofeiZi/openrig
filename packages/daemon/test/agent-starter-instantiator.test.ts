// Agent Starter v1 垂直切片 M2 的一级证明——实例化器集成。M1 已交付 schema 和
// 解析器脚手架；M2 将解析器接入 `launchExistingAgentMember`，把解析后的 starter
// 产物作为 STARTER 层，放到每智能体/每 pod 启动文件之前。
//
// 关键不变量：
// - 设置 `member.starterRef` 时调用解析器。
// - STARTER 层前置于 `resolvedStartupFiles`（而非另设编排器分支）。
// - 解析器抛出异常（无论原因是条目缺失、YAML 格式错误还是凭证扫描失败）时，
//   在 `startNode` 运行前中止启动——不会调用适配器的 `deliverStartup`，也不会有
//   STARTER 层进入下游。这是关键的凭证安全契约。
// - 与 `session_source.mode: "rebuild"` 的组合独立生效（根据切片 schema，
//   二者都应用于 fresh_start）。

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockAdapter(runtime = "claude-code"): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

const RIG_ROOT = "/project/rigs/test-rig";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function specWithStarterRef(): RigSpec {
  return {
    version: "0.2",
    name: "test-rig",
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "impl",
        agentRef: "local:agents/impl",
        profile: "default",
        runtime: "claude-code",
        cwd: ".",
        starterRef: { name: "fixture-starter" },
      }],
      edges: [],
    }],
    edges: [],
  };
}

const CLEAN_STARTER = `draft: false
starter_id: fixture-starter
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fixture-native-id"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

const MALICIOUS_STARTER = `draft: false
starter_id: fixture-mal
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "x"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
api_key: example-not-real
`;

function setupWithStarter(opts: {
  starterContent?: string | null;        // null → 注册表目录为空
  starterFilename?: string;              // 默认值：fixture-starter.yaml
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-instantiator-"));
  const registryRoot = path.join(tmpDir, "registry");
  fs.mkdirSync(registryRoot, { recursive: true });

  if (opts.starterContent) {
    const filename = opts.starterFilename ?? "fixture-starter.yaml";
    fs.writeFileSync(path.join(registryRoot, filename), opts.starterContent);
  }

  // 通过文档约定的环境变量查找分支，让解析器使用此 fixture 目录。
  process.env.OPENRIG_AGENT_STARTER_ROOT = registryRoot;

  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const adapter = mockAdapter("claude-code");
  const codexAdapter = mockAdapter("codex");
  const fsOps = mockFs({ [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml("impl") });

  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
    startupOrchestrator: startupOrch,
    fsOps,
    adapters: { "claude-code": adapter, "codex": codexAdapter, "terminal": mockAdapter("terminal") },
    tmuxAdapter: tmux,
  });

  const cleanup = () => {
    delete process.env.OPENRIG_AGENT_STARTER_ROOT;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { db, rigRepo, sessionRegistry, eventBus, inst, adapter, codexAdapter, tmux, registryRoot, cleanup };
}

describe("Agent Starter v1 垂直切片——实例化器集成（M2）", () => {
  it("设置 member.starterRef 时调用解析器并前置 STARTER 层", async () => {
    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      // 应已调用 adapter.deliverStartup；第一个参数是首部包含 STARTER 层的
      // ResolvedStartupFile[]。
      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).toHaveBeenCalled();
      const filesArg = deliverStartupSpy.mock.calls[0]![0] as ResolvedStartupFile[];

      // STARTER 层已前置：第一个 ResolvedStartupFile 必须来自这里设置的 registryRoot。
      expect(filesArg.length).toBeGreaterThan(0);
      expect(filesArg[0]!.ownerRoot).toBe(ctx.registryRoot);
      expect(filesArg[0]!.path).toBe("fixture-starter.yaml");
      expect(filesArg[0]!.appliesOn).toEqual(["fresh_start"]);
    } finally {
      ctx.cleanup();
    }
  });

  it("解析器抛出异常时中止启动——不调用 adapter.deliverStartup", async () => {
    // 恶意 starter（含 api_key 字段）→ 解析器抛出 AgentStarterCredentialScanFailedError
    // → 实例化器在 adapter.deliverStartup 运行前返回失败。这是关键的凭证安全契约。
    const ctx = setupWithStarter({ starterContent: MALICIOUS_STARTER });
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);

      // 某个节点（impl 成员）失败——根据部分失败策略，实例化器仍可能报告 ok=true，
      // 但包含失败的节点条目。关键断言是：该节点从未调用 deliverStartup，且节点
      // 状态为 "failed"。
      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).not.toHaveBeenCalled();

      if (result.ok) {
        const node = result.result.nodes.find((n) => n.logicalId === "dev.impl");
        expect(node?.status).toBe("failed");
        expect(node?.error).toContain("Agent Starter resolver 失败");
      } else {
        // result.ok=false 也属于可接受的闭环结果。
        expect(result.ok).toBe(false);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("starter 注册表条目缺失时中止启动（解析器抛出异常）", async () => {
    // 没有注册表文件 → 解析器抛出“找不到注册表条目”。
    const ctx = setupWithStarter({ starterContent: null });
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);

      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).not.toHaveBeenCalled();

      if (result.ok) {
        const node = result.result.nodes.find((n) => n.logicalId === "dev.impl");
        expect(node?.status).toBe("failed");
        expect(node?.error).toContain("Agent Starter resolver 失败");
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("缺少 member.starterRef 时不调用解析器（无 STARTER 层）", async () => {
    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    try {
      // 此规范的成员没有 starterRef。
      const spec: RigSpec = {
        version: "0.2",
        name: "no-starter-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
          }],
          edges: [],
        }],
        edges: [],
      };
      const yaml = RigSpecCodec.serialize(spec);
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).toHaveBeenCalled();
      const filesArg = deliverStartupSpy.mock.calls[0]![0] as ResolvedStartupFile[];

      // 链中不应出现来自 registryRoot 的文件。
      const fromRegistry = filesArg.find((f) => f.ownerRoot === ctx.registryRoot);
      expect(fromRegistry).toBeUndefined();
    } finally {
      ctx.cleanup();
    }
  });

  // M2 R2——补丁行 M2-R2-4——starter 是唯一连续性来源时，continuityOutcome
  // 保持全新启动的默认值。根据 startup-orchestrator.ts:114，continuityOutcome
  // 由 `input.resumeToken` / `input.forkSource` / `input.rebuildArtifacts` 推导
  //（均不存在时初始化为 "fresh"）。仅含 starter 的成员不得设置其中任何一项，
  // 因而 continuityOutcome 保持 "fresh"——这证明 STARTER 只是附加指导层，
  // 不会伪装成连续性接口。
  it("M2-R2-4：starter 是唯一连续性来源时 continuityOutcome 保持 'fresh'", async () => {
    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    const startNodeSpy = vi.spyOn(
      ctx.inst["deps"].startupOrchestrator!,
      "startNode",
    );
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      // 断言调用 startup-orchestrator 时没有任何连续性接口——根据编排器的初值分支，
      // 正是这些输入会让 continuityOutcome 偏离 "fresh"。
      expect(startNodeSpy).toHaveBeenCalled();
      const startNodeInput = startNodeSpy.mock.calls[0]![0];
      expect(startNodeInput.resumeToken).toBeUndefined();
      expect(startNodeInput.forkSource).toBeUndefined();
      const rebuildArr = startNodeInput.rebuildArtifacts ?? [];
      expect(rebuildArr.length).toBe(0);

      // 双重保险：断言已解析的 Promise 携带 continuityOutcome === "fresh"
      //（编排器在成功时公开此值）。
      const startNodeResult = await startNodeSpy.mock.results[0]!.value as
        | { ok: true; continuityOutcome: string }
        | { ok: false };
      expect(startNodeResult.ok).toBe(true);
      if (startNodeResult.ok) {
        expect(startNodeResult.continuityOutcome).toBe("fresh");
      }
    } finally {
      ctx.cleanup();
    }
  });

  // M2 R2——补丁行 M2-R2-4——STARTER 层通过
  // `node_startup_context.resolved_files_json` 完成 SQLite 往返。startup-orchestrator
  // 在 startup-orchestrator.ts:293-301 原样持久化消费的 `input.resolvedStartupFiles`；
  // 恢复重放时 STARTER 层必须完整返回（若此处缺失，说明该层只保存在临时内存中，
  // 会在后台服务重启时静默消失）。
  it("M2-R2-4：STARTER 层经 node_startup_context.resolved_files_json 往返后仍保留", async () => {
    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    try {
      const yaml = RigSpecCodec.serialize(specWithStarterRef());
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const node = result.result.nodes.find((n) => n.logicalId === "dev.impl");
      expect(node).toBeDefined();
      // 实例化器的 NodeOutcome 仅携带 logicalId；通过工作组记录解析数据库 nodeId
      //（logicalId 是节点行中存储的 qualifiedId）。
      const rig = ctx.rigRepo.getRig(result.result.rigId);
      expect(rig).not.toBeNull();
      const dbNode = rig!.nodes.find((n) => n.logicalId === "dev.impl");
      expect(dbNode, "expected dev.impl node row in rig").toBeDefined();
      const nodeId = dbNode!.id;

      const row = ctx.db
        .prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?")
        .get(nodeId) as { resolved_files_json: string } | undefined;

      expect(row, "expected node_startup_context row to exist after launch").toBeDefined();
      const persisted = JSON.parse(row!.resolved_files_json) as Array<{
        path: string;
        ownerRoot: string;
        appliesOn: string[];
        deliveryHint: string;
      }>;
      expect(Array.isArray(persisted)).toBe(true);
      expect(persisted.length).toBeGreaterThan(0);
      // STARTER 层必须位于索引 0（解析器结果中 ownerRoot = registryRoot、
      // appliesOn = ["fresh_start"]、deliveryHint = "guidance_merge"）。
      // 经 JSON 往返后仍然存在即为证明。
      expect(persisted[0]!.ownerRoot).toBe(ctx.registryRoot);
      expect(persisted[0]!.path).toBe("fixture-starter.yaml");
      expect(persisted[0]!.appliesOn).toEqual(["fresh_start"]);
      expect(persisted[0]!.deliveryHint).toBe("guidance_merge");
    } finally {
      ctx.cleanup();
    }
  });

  it("组合：starterRef 与 sessionSource.mode='rebuild' 均在 fresh_start 时生效", async () => {
    // 创建 rebuild 解析器能够找到的真实产物文件。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-rebuild-"));
    const rebuildArtifactPath = path.join(tmpDir, "rebuild-artifact.md");
    fs.writeFileSync(rebuildArtifactPath, "rebuild context fixture");

    const ctx = setupWithStarter({ starterContent: CLEAN_STARTER });
    try {
      const spec: RigSpec = {
        version: "0.2",
        name: "compose-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            starterRef: { name: "fixture-starter" },
            sessionSource: {
              mode: "rebuild",
              ref: { kind: "artifact_set", value: [rebuildArtifactPath] },
            },
          }],
          edges: [],
        }],
        edges: [],
      };
      const yaml = RigSpecCodec.serialize(spec);
      const result = await ctx.inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      // Adapter.deliverStartup 收到前置的 STARTER 层。rebuild 产物通过独立的
      // `rebuildArtifacts` 关键字参数传给 startNode（不经过 resolvedStartupFiles），
      // 因而不会出现在 deliverStartup 的 files 参数中——但启动仍应成功。
      const deliverStartupSpy = ctx.adapter.deliverStartup as ReturnType<typeof vi.fn>;
      expect(deliverStartupSpy).toHaveBeenCalled();
      const filesArg = deliverStartupSpy.mock.calls[0]![0] as ResolvedStartupFile[];
      // STARTER 层位于最前面。
      expect(filesArg[0]!.ownerRoot).toBe(ctx.registryRoot);
    } finally {
      ctx.cleanup();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
