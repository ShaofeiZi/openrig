// OPR activity-hook r3 第 3 部分——生产高度：managed-activity-hook DELIVERY gap（relay 缺失 /
// canonical manifest 缺失、格式错误或没有 relay event）必须在 READY 路径上呈现为非致命 rig-up
// warning——rig up 成功（ok:true、rc0），warning 随 materialize result（→ up route → CLI）传递。
// 它不得 gate startup，且 delivery 可行时不得出现。Validation 使用 adapter 共用的 module。

import { describe, it, expect, vi } from "vitest";
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
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RigSpec } from "../src/domain/types.js";

const RIG_ROOT = "/project/rigs/my-rig";
const RELAY_FIX = "/fixtures/activity-relay.cjs";
const MANIFEST_FIX = "/fixtures/claude.json";
const GOOD_MANIFEST = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] }] } });

// 声明并选择 claude_activity_hooks runtime resource 的 agent.yaml。
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
      runtime_resources: [claude-activity-hooks]`;

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })), killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })), hasSession: vi.fn(async () => true),
    listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}
function mockAdapter(runtime = "claude-code"): RuntimeAdapter {
  return {
    runtime, listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}
function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}
function makeRigSpec(): RigSpec {
  return {
    version: "0.2", name: "test-rig",
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
    edges: [],
  } as RigSpec;
}

function setup(activityAssets: { relayPath?: string; manifestPath?: string }, extraFiles?: Record<string, string>) {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const files: Record<string, string> = { [`${RIG_ROOT}/agents/impl/agent.yaml`]: AGENT_YAML, ...extraFiles };
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator: startupOrch,
    fsOps: mockFs(files), claudeActivityAssets: activityAssets,
    adapters: { "claude-code": mockAdapter(), "codex": mockAdapter("codex"), "terminal": mockAdapter("terminal") },
    tmuxAdapter: tmux,
  });
  return { db, inst };
}

describe("rig up——managed activity-hook delivery-gap warning（非致命，rc0）", () => {
  it("relay/manifest asset 缺失 → rig up 成功（ok:true）并返回准确的非致命 warning", async () => {
    // claudeActivityAssets 指向 fsOps 中不存在的 path → 无法投递。
    const { db, inst } = setup({ relayPath: "/nope/relay.cjs", manifestPath: "/nope/claude.json" });
    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true); // rc0——不是 hard failure。
    if (!result.ok) return;
    const warnings = result.result.warnings ?? [];
    expect(warnings.some((w) => /无法交付受管 Claude 活动 hook/.test(w))).toBe(true);
    expect(warnings.some((w) => w.includes("dev.impl"))).toBe(true);
    db.close();
  });

  it("asset 可投递（relay + 有效 manifest 存在）→ rig up 成功且无 activity-hook warning", async () => {
    const { db, inst } = setup(
      { relayPath: RELAY_FIX, manifestPath: MANIFEST_FIX },
      { [RELAY_FIX]: "// relay", [MANIFEST_FIX]: GOOD_MANIFEST },
    );
    const result = await inst.instantiate(RigSpecCodec.serialize(makeRigSpec()), RIG_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warnings = result.result.warnings ?? [];
    expect(warnings.some((w) => /无法交付受管 Claude 活动 hook/.test(w))).toBe(false);
    db.close();
  });
});
