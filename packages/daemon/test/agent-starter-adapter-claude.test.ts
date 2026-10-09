// Agent Starter v1 垂直切片 M2 修订版 2 的一级证明——真实的
// `ClaudeCodeAdapter` 证明。M2 R1 使用模拟 RuntimeAdapter，只断言 spy 收到
// STARTER ResolvedStartupFile；这只能证明调用方接线，不能证明适配器行为。
// M2 R2 实例化真实 `ClaudeCodeAdapter`，并在 tmux 边界模拟；证明内容是实际
// `deliverStartup` 会执行 `guidance_merge`，并把起始内容写入逐席位 CLAUDE.md 管理块。

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
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
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
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
  } as unknown as TmuxAdapter;
}

// 沿用 claude-runtime-adapter.test.ts 的内存 FS 适配器模式。预先填充注册表条目
// 路径（解析器会以绝对路径返回），使真实 ClaudeCodeAdapter 可经其 fs 接缝读取；
// 对 <cwd>/CLAUDE.md 的写入落在同一存储中，再读回以验证合并后的指引结果。
function mockClaudeFs(seed: Record<string, string>): ClaudeAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...seed };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
  };
}

const RIG_ROOT = "/project/rigs/test-rig";
const DEFAULT_CULTURE_PATH = path.resolve(import.meta.dirname, "../assets/guidance/CULTURE-default.md");
const DEFAULT_CULTURE = fs.readFileSync(DEFAULT_CULTURE_PATH, "utf8");
const DEFAULT_ONBOARDING = Object.fromEntries(
  ["01-world-and-purpose.md", "02-self-and-competent-action.md"].map((file) => {
    const assetPath = path.resolve(import.meta.dirname, "../assets/onboarding", file);
    return [assetPath, fs.readFileSync(assetPath, "utf8")];
  }),
);

const CLAUDE_STARTER = `draft: false
starter_id: claude-fixture-starter
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "claude-fixture-native-id"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

describe("Agent Starter v1 垂直切片——真实 Claude 适配器交付（M2 R2）", () => {
  it("真实 ClaudeCodeAdapter.deliverStartup 通过 guidance_merge 将 STARTER 内容写入 CLAUDE.md", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "starter-adapter-claude-r2-"));
    const registryRoot = path.join(tmpDir, "registry");
    fs.mkdirSync(registryRoot, { recursive: true });
    const registryEntryPath = path.join(registryRoot, "claude-fixture-starter.yaml");
    fs.writeFileSync(registryEntryPath, CLAUDE_STARTER);
    process.env.OPENRIG_AGENT_STARTER_ROOT = registryRoot;

    try {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const podRepo = new PodRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const tmux = mockTmux();
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const startupOrch = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });

      // 真实 ClaudeCodeAdapter。fs 接缝预载注册表条目内容（与解析器返回的路径匹配），
      // 使适配器的 `readFile(file.absolutePath)` 成功并能运行 merge_guidance 分支。
      const claudeFs = mockClaudeFs({
        [registryEntryPath]: CLAUDE_STARTER,
        [DEFAULT_CULTURE_PATH]: DEFAULT_CULTURE,
        ...DEFAULT_ONBOARDING,
      });
      const claudeAdapter = new ClaudeCodeAdapter({ tmux, fsOps: claudeFs });

      // 直通的 Codex/terminal 适配器让实例化器的适配器映射保持类型完整；
      // 此测试只覆盖 Claude。
      const passThroughAdapter: RuntimeAdapter = {
        runtime: "codex",
        listInstalled: async () => [],
        project: async () => ({ projected: [], skipped: [], failed: [] }),
        deliverStartup: async () => ({ delivered: 0, failed: [] }),
        checkReady: async () => ({ ready: true }),
        launchHarness: async () => ({ ok: true }),
      };

      const fsOps: AgentResolverFsOps = {
        readFile: (p: string) => {
          if (p === `${RIG_ROOT}/agents/impl/agent.yaml`) {
            return `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
          }
          throw new Error(`Not found: ${p}`);
        },
        exists: (p: string) => p === `${RIG_ROOT}/agents/impl/agent.yaml`,
      };

      const inst = new PodRigInstantiator({
        db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher,
        startupOrchestrator: startupOrch, fsOps,
        adapters: {
          "claude-code": claudeAdapter,
          "codex": passThroughAdapter,
          "terminal": passThroughAdapter,
        },
        tmuxAdapter: tmux,
      });

      const spec: RigSpec = {
        version: "0.2",
        name: "claude-starter-rig",
        pods: [{
          id: "dev",
          label: "Dev",
          members: [{
            id: "impl",
            agentRef: "local:agents/impl",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
            starterRef: { name: "claude-fixture-starter" },
          }],
          edges: [],
        }],
        edges: [],
      };
      const yaml = RigSpecCodec.serialize(spec);
      const result = await inst.instantiate(yaml, RIG_ROOT);
      expect(result.ok).toBe(true);

      // Claude 适配器的 `mergeGuidance` 写入 <binding.cwd>/CLAUDE.md，并包裹在
      // `BEGIN OpenRig MANAGED BLOCK` 外壳中。此成员的 cwd 解析为 RIG_ROOT
      //（`cwd: "."`）。
      const expectedClaudeMdPath = path.join(RIG_ROOT, "CLAUDE.md");
      const claudeMd = claudeFs._store[expectedClaudeMdPath];
      expect(claudeMd, "预期真实 ClaudeCodeAdapter 已通过 guidance_merge 写入 CLAUDE.md").toBeDefined();
      // 管理块以起始文件路径作为键（`file.path`，即解析器返回的基本名）。
      expect(claudeMd).toContain("BEGIN OpenRig MANAGED BLOCK: claude-fixture-starter.yaml");
      expect(claudeMd).toContain("END OpenRig MANAGED BLOCK: claude-fixture-starter.yaml");
      // 起始 YAML 正文必须有一部分出现在块内。选择
      // `starter_id: claude-fixture-starter`，因为它是解析器透传的稳定、无歧义标记。
      expect(claudeMd).toContain("starter_id: claude-fixture-starter");
      expect(claudeMd).toContain("BEGIN OpenRig MANAGED BLOCK: CULTURE-default.md");
      expect(claudeMd).toContain("Ship good, working product");
      expect(claudeMd).toContain("How big is the dog?");
      expect(claudeMd).toContain("When a turn ends, you sleep.");

      db.close();
    } finally {
      delete process.env.OPENRIG_AGENT_STARTER_ROOT;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
