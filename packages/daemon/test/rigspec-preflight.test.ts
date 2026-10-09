import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import nodePath from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigSpecPreflight } from "../src/domain/rigspec-preflight.js";
import type { LegacyRigSpec as RigSpec } from "../src/domain/types.js"; // TODO：AS-T08b —— 迁移到 pod 感知的 RigSpec
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, nodeSpecFieldsSchema, rigArchiveSchema]);
  return db;
}

function mockTmux(sessionExists: Record<string, boolean> = {}): TmuxAdapter {
  return {
    hasSession: vi.fn(async (name: string) => sessionExists[name] ?? false),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapter;
}

function validSpec(overrides?: Partial<RigSpec>): RigSpec {
  return {
    schemaVersion: 1,
    name: "r99",
    version: "1.0.0",
    nodes: [
      { id: "worker", runtime: "claude-code", cwd: "/" },
    ],
    edges: [],
    ...overrides,
  };
}

describe("RigSpecPreflight", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createPreflight(opts?: { tmux?: TmuxAdapter; exec?: ExecFn; cmuxExec?: ExecFn }) {
    return new RigSpecPreflight({
      rigRepo,
      tmuxAdapter: opts?.tmux ?? mockTmux(),
      exec: opts?.exec ?? (async () => ""),
      cmuxExec: opts?.cmuxExec ?? (async () => ""),
    });
  }

  it("所有检查通过时返回 { ready: true, warnings: [], errors: [] }", async () => {
    const pf = createPreflight();
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("工作组名称冲突时返回错误", async () => {
    rigRepo.createRig("r99"); // 制造冲突
    const pf = createPreflight();
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("r99"))).toBe(true);
  });

  it("M1 A1——拒绝使用虚拟域 token 'external' 作为工作组名称", async () => {
    const pf = createPreflight();
    const result = await pf.check(validSpec({ name: "external" }));
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("external") && /保留|虚拟域/.test(e))).toBe(true);
  });

  it("tmux 会话名称冲突时返回错误", async () => {
    const tmux = mockTmux({ "r99-worker": true });
    const pf = createPreflight({ tmux });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("r99-worker"))).toBe(true);
  });

  it("普通工作组名称派生出的会话名称经过规范化", async () => {
    const spec = validSpec({ name: "badname" });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.errors.some((e) => e.includes("会话名称"))).toBe(false);
  });

  it("节点 cwd 不存在时返回错误", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/nonexistent/path/xyz" }],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("/nonexistent/path/xyz"))).toBe(true);
  });

  it("claude-code 使用准确命令 'claude --version' 探测", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const pf = createPreflight({ exec });
    await pf.check(validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }],
    }));
    const claudeCall = exec.mock.calls.find((c: unknown[]) => (c[0] as string).includes("claude"));
    expect(claudeCall).toBeDefined();
    expect(claudeCall![0]).toBe("claude --version");
  });

  it("codex 使用准确命令 'codex --version' 探测", async () => {
    const exec = vi.fn<ExecFn>().mockResolvedValue("");
    const pf = createPreflight({ exec });
    await pf.check(validSpec({
      nodes: [{ id: "worker", runtime: "codex", cwd: "/" }],
    }));
    const codexCall = exec.mock.calls.find((c: unknown[]) => (c[0] as string).includes("codex"));
    expect(codexCall).toBeDefined();
    expect(codexCall![0]).toBe("codex --version");
  });

  it("运行时不可用时返回错误", async () => {
    const exec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const pf = createPreflight({ exec });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("claude-code"))).toBe(true);
  });

  it("cwd 指向文件时返回错误", async () => {
    // /etc/hosts 是文件而不是目录。
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/etc/hosts" }],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("/etc/hosts") && e.includes("不是目录"))).toBe(true);
  });

  it("cwd 指向目录时通过 cwd 检查", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/tmp" }],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    // 不应出现 cwd 错误，但可能有会话名称等其他错误。
    expect(result.errors.filter((e) => e.includes("cwd") || e.includes("/tmp"))).toHaveLength(0);
  });

  it("报告多个错误：两个无效 cwd 产生两个错误", async () => {
    const spec = validSpec({
      nodes: [
        { id: "worker-a", runtime: "claude-code", cwd: "/bad/path/a" },
        { id: "worker-b", runtime: "claude-code", cwd: "/bad/path/b" },
      ],
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.errors.filter((e) => e.includes("/bad/path")).length).toBe(2);
  });

  it("cmux 不可用且 spec 含 surfaceHint 时给出警告", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", surfaceHint: "tab:main" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.some((w) => w.toLowerCase().includes("cmux"))).toBe(true);
  });

  it("cmux 不可用但 spec 没有布局提示时不警告", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.filter((w) => w.toLowerCase().includes("cmux"))).toHaveLength(0);
  });

  it("节点没有 cwd 时跳过 cwd 检查并通过", async () => {
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code" }], // 没有 cwd
    });
    const pf = createPreflight();
    const result = await pf.check(spec);
    expect(result.errors.filter((e) => e.includes("cwd"))).toHaveLength(0);
  });

  it("派生名称已存在时检测到 tmux 会话名称冲突", async () => {
    const tmux = mockTmux({ "r99-worker": true });
    const pf = createPreflight({ tmux });
    const result = await pf.check(validSpec());
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("tmux") || e.includes("session"))).toBe(true);
  });

  it("spec 含 workspace 提示但 cmux 不可用时给出警告", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", workspace: "review" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.warnings.some((w) => w.toLowerCase().includes("cmux"))).toBe(true);
  });

  it("错误与警告并存：cwd 无效，且存在布局提示但 cmux 不可用", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(new Error("not found"));
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/nonexistent/bad", surfaceHint: "tab:x" }],
    });
    const pf = createPreflight({ cmuxExec });
    const result = await pf.check(spec);
    expect(result.ready).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("使用准确命令 'cmux capabilities --json' 探测 cmux 可用性", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockResolvedValue("{}");
    const spec = validSpec({
      nodes: [{ id: "worker", runtime: "claude-code", cwd: "/", surfaceHint: "tab:x" }],
    });
    const pf = createPreflight({ cmuxExec });
    await pf.check(spec);
    expect(cmuxExec).toHaveBeenCalledWith("cmux capabilities --json");
  });
});

// -- 重启版工作组预检（AgentSpec reboot）--

import { rigPreflight, type RigPreflightInput } from "../src/domain/rigspec-preflight.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";

function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

function validAgentYaml(name: string, opts?: { profiles?: string }): string {
  const profiles = opts?.profiles ?? "profiles:\n  default:\n    uses:\n      skills: []";
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\n${profiles}`;
}

function makeRigYaml(overrides?: Partial<PodRigSpec>): string {
  const spec: PodRigSpec = {
    version: "0.2", name: "test-rig",
    pods: [{
      id: "dev", label: "Dev",
      members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
      edges: [],
    }],
    edges: [],
    ...overrides,
  };
  return RigSpecCodec.serialize(spec);
}

const RIG_ROOT = "/project/rigs/my-rig";

describe("重启版工作组预检", () => {
  it("从配置的受管 Skill 目录中解析仅含选择器的 profile", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-preflight-skill-catalog-"));
    try {
      const rigRoot = nodePath.join(root, "rig");
      const catalog = nodePath.join(root, "managed-skills");
      const project = nodePath.join(root, "project");
      fs.mkdirSync(nodePath.join(rigRoot, "agents", "impl"), { recursive: true });
      fs.mkdirSync(nodePath.join(rigRoot, "agents", "shared"), { recursive: true });
      fs.mkdirSync(nodePath.join(catalog, "topology-skill"), { recursive: true });
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(
        nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
        `name: impl
version: "1.0.0"
imports:
  - ref: local:../shared
resources:
  skills: []
profiles:
  default:
    uses:
      skills: [topology-skill]
  missing:
    uses:
      skills: [absent-skill]
`,
      );
      fs.writeFileSync(
        nodePath.join(rigRoot, "agents", "shared", "agent.yaml"),
        "name: shared\nversion: \"1.0.0\"\nresources:\n  skills: []\nprofiles: {}\n",
      );
      fs.writeFileSync(nodePath.join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      fs.writeFileSync(
        nodePath.join(catalog, "topology-skill", "SKILL.md"),
        "---\nname: topology-skill\ndescription: Use when testing selector-only preflight.\n---\n\n# Topology skill\n",
      );
      execFileSync("git", ["-C", root, "init", "-q"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@openrig.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "OpenRig Test"]);
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);

      const rigSpecYaml = makeRigYaml({
        pods: [{
          id: "dev", label: "Dev",
          members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "codex", cwd: project }],
          edges: [],
        }],
      });
      const input: RigPreflightInput = {
        rigSpecYaml,
        rigRoot,
        fsOps: {
          readFile: (path: string) => fs.readFileSync(path, "utf-8"),
          exists: (path: string) => fs.existsSync(path),
        },
        skillsRoot: catalog,
      };

      const result = await rigPreflight(input);

      expect(result.ready, JSON.stringify(result.errors)).toBe(true);
      expect(result.errors).toEqual([]);

      const missingResult = await rigPreflight({
        ...input,
        rigSpecYaml: makeRigYaml({
          pods: [{
            id: "dev", label: "Dev",
            members: [{ id: "impl", agentRef: "local:agents/impl", profile: "missing", runtime: "codex", cwd: project }],
            edges: [],
          }],
        }),
      });
      expect(missingResult.ready).toBe(false);
      expect(missingResult.errors).toContain('dev.impl: Profile 使用的 skills："absent-skill" 未在资源池中找到');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // T5：成功解析所有智能体引用。
  it("成功解析所有智能体引用", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = await rigPreflight({ rigSpecYaml: makeRigYaml(), rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // T5b：预检会显示 profile 缺失。
  it("捕获缺失的 profile", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const rigYaml = makeRigYaml({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "nonexistent", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent") && e.includes("未找到"))).toBe(true);
  });

  // T5c：显示无效的恢复策略收窄。
  it("捕获无效的恢复策略收窄", async () => {
    const agentYaml = `name: impl\nversion: "1.0.0"\ndefaults:\n  lifecycle:\n    compaction_strategy: harness_native\n    restore_policy: checkpoint_only\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: agentYaml,
    };
    const rigYaml = makeRigYaml({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", restorePolicy: "resume_if_possible" }],
        edges: [],
      }],
    });
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("扩宽"))).toBe(true);
  });

  // T6：不支持的运行时。
  it("报告不支持的运行时", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const rigYaml = makeRigYaml({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "unsupported-runtime", cwd: "." }],
        edges: [],
      }],
    });
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("不支持运行时"))).toBe(true);
  });

  // Slice 51-01 stub-runtime——仅测试的红灯（没有争议的机械事实 1）：runtime: stub 且
  // agent_ref 可解析的现代 pod 成员必须通过预检。当前因 SUPPORTED_RUNTIMES
  //（rigspec-preflight.ts）遗漏 "stub" 而为红，生产代码加入后转绿。这里不编码任何
  // 有争议的 hook/usage/compaction/packaging 界面。
  it("事实 1：准入 runtime: stub 且 agent_ref 可解析的现代 pod 成员", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const rigYaml = makeRigYaml({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "stub", cwd: "." }],
        edges: [],
      }],
    });
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready, `预检必须准入 runtime: stub；错误：${JSON.stringify(result.errors)}`).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // T7：缺少 cwd。
  it("报告 cwd 缺失", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    // RigSpec schema 要求 cwd，无法提供空 cwd。RigSpecPodMember 的 cwd 为必填，
    // 因此空值会在 schema 验证中失败；这里确认 schema 能捕获它。
    const rigYaml = `version: "0.2"\nname: test-rig\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        agent_ref: "local:agents/impl"\n        profile: default\n        runtime: claude-code\n    edges: []\nedges: []`;
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("cwd"))).toBe(true);
  });

  // T8：导入冲突作为警告。
  it("拒绝 pod/member/rig 名称中的无效会话字符，并逐组件报告错误", async () => {
    const rigYaml = makeRigYaml({
      name: "my rig",
      pods: [{
        id: "dev 1", label: "Dev",
        members: [{ id: "impl!", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = await rigPreflight({ rigSpecYaml: rigYaml, rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    // pod、member 和工作组名称分别产生错误。
    expect(result.errors.some((e) => e.includes("pod 名称") && e.includes("dev 1") && e.includes(" "))).toBe(true);
    expect(result.errors.some((e) => e.includes("member 名称") && e.includes("impl!") && e.includes("!"))).toBe(true);
    expect(result.errors.some((e) => e.includes("rig 名称") && e.includes("my rig") && e.includes(" "))).toBe(true);
  });

  it("将导入冲突报告为警告", async () => {
    const files: Record<string, string> = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nimports:\n  - ref: local:../lib\nresources:\n  skills:\n    - id: shared\n      path: skills/shared\nprofiles:\n  default:\n    uses:\n      skills: [shared]`,
      [`${RIG_ROOT}/agents/lib/agent.yaml`]: `name: lib\nversion: "1.0.0"\nresources:\n  skills:\n    - id: shared\n      path: skills/shared\nprofiles: {}`,
    };
    const result = await rigPreflight({ rigSpecYaml: makeRigYaml(), rigRoot: RIG_ROOT, fsOps: mockFs(files) });
    expect(result.ready).toBe(true);
    expect(result.warnings.some((w) => w.includes("冲突"))).toBe(true);
  });

  it("未提供 --cwd 且 builtin/library cwd 解析到 OpenRig 安装目录内时如实失败", async () => {
    const builtinRoot = nodePath.resolve(import.meta.dirname, "../src/../specs");
    const files: Record<string, string> = {
      [`${builtinRoot}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = await rigPreflight({ rigSpecYaml: makeRigYaml(), rigRoot: builtinRoot, fsOps: mockFs(files) });
    expect(result.ready).toBe(false);
    expect(result.errors.some((e) => e.includes("位于 zrig 安装目录"))).toBe(true);
    expect(result.errors.some((e) => e.includes("--cwd"))).toBe(true);
  });

  it("提供 cwdOverride 时准入 builtin/library spec", async () => {
    const builtinRoot = nodePath.resolve(import.meta.dirname, "../src/../specs");
    const files: Record<string, string> = {
      [`${builtinRoot}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = await rigPreflight({
      rigSpecYaml: makeRigYaml(),
      rigRoot: builtinRoot,
      cwdOverride: "/workspace/project",
      fsOps: mockFs(files),
    });
    expect(result.ready).toBe(true);
  });
});
