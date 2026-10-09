import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import { parseAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";
import type { AgentSpec, RigSpec, RigSpecPod, RigSpecPodMember, StartupBlock } from "../src/domain/types.js";
import type { ResolvedAgentSpec, ResourceCollision } from "../src/domain/agent-resolver.js";

function makeSpec(overrides?: Partial<AgentSpec>): AgentSpec {
  return {
    version: "1.0.0",
    name: "test-agent",
    imports: [],
    startup: { files: [{ path: "startup/base.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    resources: {
      skills: [{ id: "skill-a", path: "skills/a" }],
      guidance: [],
      subagents: [],
      plugins: [],
      runtimeResources: [],
    },
    profiles: {
      default: {
        uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      },
    },
    ...overrides,
  };
}

function makeResolved(spec: AgentSpec, path = "/agents/test"): ResolvedAgentSpec {
  return { spec, sourcePath: path, hash: "abc123" };
}

function makeMember(overrides?: Partial<RigSpecPodMember>): RigSpecPodMember {
  return { id: "impl", agentRef: "local:agents/test", profile: "default", runtime: "claude-code", cwd: ".", ...overrides };
}

function makePod(overrides?: Partial<RigSpecPod>): RigSpecPod {
  return { id: "dev", label: "Dev", members: [makeMember()], edges: [], ...overrides };
}

function makeRig(overrides?: Partial<RigSpec>): RigSpec {
  return { version: "0.2", name: "test-rig", pods: [makePod()], edges: [], ...overrides };
}

function makeCtx(overrides?: Partial<ResolutionContext>): ResolutionContext {
  const spec = makeSpec();
  return {
    baseSpec: makeResolved(spec),
    importedSpecs: [],
    collisions: [],
    profileName: "default",
    member: makeMember(),
    pod: makePod(),
    rig: makeRig(),
    ...overrides,
  };
}

describe("Profile 解析器 + 优先级引擎", () => {
  // T1：profile 从 base+import 合并池中选择
  it("profile 从 base+import 合并池中选择并携带 effectiveId 与 sourcePath", () => {
    const importSpec = makeSpec({
      name: "lib",
      resources: { skills: [{ id: "lib-skill", path: "skills/lib" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        profiles: {
          default: { uses: { skills: ["skill-a", "lib:lib-skill"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
        },
      })),
      importedSpecs: [makeResolved(importSpec, "/agents/lib")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.selectedResources.skills).toHaveLength(2);
      const base = result.config.selectedResources.skills.find((r) => r.effectiveId === "skill-a");
      expect(base).toBeDefined();
      expect(base!.sourcePath).toBe("/agents/test");
      const imported = result.config.selectedResources.skills.find((r) => r.effectiveId === "lib:lib-skill");
      expect(imported).toBeDefined();
      expect(imported!.sourcePath).toBe("/agents/lib");
    }
  });

  // T2：未限定且有歧义的资源引用失败（import/import 冲突）
  it("来自两个 import 的未限定歧义资源引用失败", () => {
    const importA = makeSpec({
      name: "lib-a",
      resources: { skills: [{ id: "shared", path: "skills/shared" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const importB = makeSpec({
      name: "lib-b",
      resources: { skills: [{ id: "shared", path: "skills/shared" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: { default: { uses: { skills: ["shared"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
      })),
      importedSpecs: [makeResolved(importA, "/agents/lib-a"), makeResolved(importB, "/agents/lib-b")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/歧义/);
    }
  });

  // T2b：base/import 冲突——base 保留未限定标识
  it("base/import 冲突：base 保留未限定标识，不产生歧义", () => {
    const importSpec = makeSpec({
      name: "lib",
      resources: { skills: [{ id: "skill-a", path: "skills/a-lib" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      importedSpecs: [makeResolved(importSpec, "/agents/lib")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 选择 base spec 的 skill-a（无歧义）。
      expect(result.config.selectedResources.skills).toHaveLength(1);
      expect(result.config.selectedResources.skills[0]!.effectiveId).toBe("skill-a");
      expect(result.config.selectedResources.skills[0]!.sourceSpec).toBe("test-agent");
    }
  });

  // T3：限定后的冲突引用成功
  it("限定后的冲突引用成功并携带 sourcePath", () => {
    const importSpec = makeSpec({
      name: "lib",
      resources: { skills: [{ id: "skill-a", path: "skills/a-lib" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        profiles: {
          default: { uses: { skills: ["lib:skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
        },
      })),
      importedSpecs: [makeResolved(importSpec, "/agents/lib")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.selectedResources.skills).toHaveLength(1);
      expect(result.config.selectedResources.skills[0]!.effectiveId).toBe("lib:skill-a");
      expect(result.config.selectedResources.skills[0]!.sourcePath).toBe("/agents/lib");
    }
  });

  it("单个 import 的未限定技能保留未限定 effectiveId", () => {
    const importSpec = makeSpec({
      name: "shared",
      resources: { skills: [{ id: "openrig-user", path: "skills/openrig-user" }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
      profiles: {},
    });
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["openrig-user"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
        },
      })),
      importedSpecs: [makeResolved(importSpec, "/agents/shared")],
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.selectedResources.skills).toHaveLength(1);
      expect(result.config.selectedResources.skills[0]!.effectiveId).toBe("openrig-user");
      expect(result.config.selectedResources.skills[0]!.sourcePath).toBe("/agents/shared");
      expect(result.config.selectedResources.skills[0]!.sourceSpec).toBe("shared");
    }
  });

  // T4：工作组成员 runtime 覆盖 profile 偏好
  it("工作组成员 runtime 覆盖 profile 偏好", () => {
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        defaults: { runtime: "codex" },
        profiles: { default: { preferences: { runtime: "codex" }, uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
      })),
      member: makeMember({ runtime: "claude-code" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.runtime).toBe("claude-code");
  });

  // T5：工作组成员 model 覆盖 profile 偏好
  it("工作组成员 model 覆盖 profile 偏好", () => {
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        defaults: { model: "sonnet" },
        profiles: { default: { preferences: { model: "haiku" }, uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
      })),
      member: makeMember({ model: "opus" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.model).toBe("opus");
  });

  // T6：工作组成员 cwd 是权威值
  it("工作组成员 cwd 是权威值", () => {
    const ctx = makeCtx({
      specRoot: "/workspace/spec-root",
      member: makeMember({ cwd: "/custom/workdir" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.cwd).toBe("/custom/workdir");
  });

  it("相对于 specRoot 解析成员的相对 cwd", () => {
    const ctx = makeCtx({
      specRoot: "/workspace/spec-root",
      member: makeMember({ cwd: "." }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.cwd).toBe("/workspace/spec-root");
  });

  it("显式 cwdOverride 即使面对已编写的绝对 cwd 也会覆盖", () => {
    const ctx = makeCtx({
      specRoot: "/workspace/spec-root",
      cwdOverride: "/override/project",
      member: makeMember({ cwd: "/authored/absolute" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.cwd).toBe("/override/project");
  });

  // T7：允许 resume_if_possible -> relaunch_fresh 收窄
  it("允许恢复策略从 resume_if_possible 收窄为 relaunch_fresh", () => {
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        defaults: { lifecycle: { executionMode: "interactive_resident", compactionStrategy: "harness_native", restorePolicy: "resume_if_possible" } },
        profiles: { default: { uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
      })),
      member: makeMember({ restorePolicy: "relaunch_fresh" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.restorePolicy).toBe("relaunch_fresh");
  });

  // T8：拒绝 checkpoint_only -> resume_if_possible 放宽
  it("拒绝恢复策略从 checkpoint_only 放宽为 resume_if_possible", () => {
    const ctx = makeCtx({
      baseSpec: makeResolved(makeSpec({
        defaults: { lifecycle: { executionMode: "interactive_resident", compactionStrategy: "harness_native", restorePolicy: "checkpoint_only" } },
        profiles: { default: { uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } } },
      })),
      member: makeMember({ restorePolicy: "resume_if_possible" }),
    });

    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/扩宽/);
  });

  // T11：工作组不能注入资源（selectedResources 只来自 agent 池）
  it("工作组不能注入资源——只能从 agent 池中选择", () => {
    // 解析器只从 AgentSpec + imports 取得资源，没有供工作组注入资源的机制。
    const ctx = makeCtx();
    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 应当只选择 base spec 中的 skill-a。
      expect(result.config.selectedResources.skills).toHaveLength(1);
      expect(result.config.selectedResources.skills[0]!.effectiveId).toBe("skill-a");
    }
  });

  // T12：startup 只能追加——不存在减法 API
  it("startup 只能追加——不存在移除机制", () => {
    // 解析器只追加。StartupBlock 不提供 subtract/remove/delete。
    // 此测试验证输出结构没有移除概念。
    const ctx = makeCtx();
    const result = resolveNodeConfig(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // startup 块只有 files 和 actions——没有 "removals" 字段。
      const keys = Object.keys(result.config.startup);
      expect(keys.sort()).toEqual(["actions", "files"]);
    }
  });
});

describe("V0.3.0 daemon-skill-discovery——文件系统发现的技能加入资源池", () => {
  // 为解析器集成测试建立包含技能目录的临时主目录 + cwd。这些测试使用真实文件系统，
  // 因为解析器会同步调用 discoverSkillsForRuntime，而 stub 层只能浅显测试接线。
  // mkdtemp / rmSync 使每个用例保持隔离。
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");

  let tmpRoot: string;
  let homedir: string;
  let cwd: string;

  function writeSkill(dir: string, name: string, description: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`, "utf-8");
  }

  function withFsFixture<T>(fn: () => T): T {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "profile-resolver-disc-"));
    homedir = path.join(tmpRoot, "home");
    cwd = path.join(tmpRoot, "rig-cwd");
    fs.mkdirSync(homedir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    try { return fn(); } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  }

  it("接受只能通过发现的 ~/.claude/skills/ 路径解析的 profile.uses.skills 条目", () => {
    withFsFixture(() => {
      writeSkill(path.join(homedir, ".claude/skills/openrig-architect"), "openrig-architect", "Architect rigs");
      const baseSpec = makeSpec({
        // 注意：resources.skills 中没有 `openrig-architect`；profile 只能通过文件系统发现解析它。
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["openrig-architect"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const found = result.config.selectedResources.skills.find((s) => s.effectiveId === "openrig-architect");
        expect(found).toBeDefined();
        expect(found!.sourcePath).toBe(path.join(homedir, ".claude/skills/openrig-architect"));
      }
    });
  });

  it("接受通过工作组内置 <cwd>/.claude/skills/<name>/ 解析的 profile.uses.skills 条目", () => {
    withFsFixture(() => {
      writeSkill(path.join(cwd, ".claude/skills/web-design-guidelines"), "web-design-guidelines", "Web design checks");
      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["web-design-guidelines"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
    });
  });

  it("工作组本地 resources.skills 胜过同标识的发现技能（最具体者优先）", () => {
    withFsFixture(() => {
      writeSkill(path.join(homedir, ".claude/skills/skill-a"), "skill-a", "Discovered version");
      // makeSpec 已在 resources.skills 中声明 { id: 'skill-a', path: 'skills/a' }；
      // 工作组本地版本应胜出。
      const ctx = makeCtx({
        baseSpec: makeResolved(makeSpec()),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const skillA = result.config.selectedResources.skills.find((s) => s.effectiveId === "skill-a");
        expect(skillA).toBeDefined();
        // 使用工作组本地 sourcePath（agent spec 的 sourcePath），而不是主目录中发现的
        // SKILL.md 目录。
        expect(skillA!.sourcePath).toBe("/agents/test");
      }
    });
  });

  it("runtime 为 codex 时扫描 .agents/skills/ 目录树", () => {
    withFsFixture(() => {
      writeSkill(path.join(homedir, ".agents/skills/openrig-architect"), "openrig-architect", "Architect rigs");
      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["openrig-architect"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd, runtime: "codex" }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
    });
  });

  it("profile 引用在工作组本地和发现路径均不存在的技能时，保留现有“找不到技能”错误", () => {
    withFsFixture(() => {
      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["nope-not-anywhere"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes("nope-not-anywhere"))).toBe(true);
      }
    });
  });

  it("profile 引用目录名与被拒绝 SKILL.md 匹配的技能时，呈现结构拒绝原因", () => {
    withFsFixture(() => {
      // 操作人员在 ~/.claude/skills/broken-skill/ 路径放置了没有 frontmatter 的 SKILL.md。
      // profile 引用 "broken-skill"——操作人员应看到“因 <reason> 在 <path> 被拒绝”，
      // 而非裸露的“资源池中找不到”错误，从而明确知道需要修复什么。
      const dir = path.join(homedir, ".claude/skills/broken-skill");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "no frontmatter here\n", "utf-8");

      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["broken-skill"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const msg = result.errors.find((e) => e.includes("broken-skill"));
        expect(msg).toBeDefined();
        expect(msg).toMatch(/被拒绝/);
        expect(msg).toMatch(/frontmatter/i);
        expect(msg).toContain(dir);
      }
    });
  });

  it("不会把无关的被拒绝 SKILL.md 错误关联到缺失技能（只匹配 basename）", () => {
    withFsFixture(() => {
      // 操作人员在 ~/.claude/skills/foo/ 中有一个损坏技能（被拒绝），且 profile 引用
      // 不存在于任何位置的 "bar"。"bar" 错误不应与 foo 的拒绝混为一谈。
      const dir = path.join(homedir, ".claude/skills/foo");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "no frontmatter\n", "utf-8");

      const baseSpec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["bar"], guidance: [], subagents: [], hooks: [], runtimeResources: [] } },
        },
      });
      const ctx = makeCtx({
        baseSpec: makeResolved(baseSpec),
        member: makeMember({ cwd }),
        homedir,
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const msg = result.errors.find((e) => e.includes("bar"));
        expect(msg).toBeDefined();
        // 只是“资源池中找不到”，而非“被拒绝”。
        expect(msg).toMatch(/未在资源池中找到/);
        expect(msg).not.toMatch(/被拒绝/);
      }
    });
  });

  // 分片 15 HG-7——逐席位 silence-window-seconds 通过 ResolvedNodeConfig.activity 传递，
  // 供 rigspec-instantiator 接入 NodeLauncher.launchNode。这里验证透传；启动调用点由
  // node-launcher 测试覆盖。
  describe("分片 15——profile.activity 传入 ResolvedNodeConfig", () => {
    it("设置时 ResolvedNodeConfig.activity.silenceWindowSeconds 反映 profile.activity", () => {
      const ctx = makeCtx({
        baseSpec: makeResolved(makeSpec({
          profiles: {
            default: {
              activity: { silenceWindowSeconds: 9 },
              uses: { skills: ["skill-a"], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
            },
          },
        })),
      });
      const result = resolveNodeConfig(ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.activity?.silenceWindowSeconds).toBe(9);
      }
    });

    it("profile 未声明 activity 时 ResolvedNodeConfig.activity 为 undefined", () => {
      const result = resolveNodeConfig(makeCtx());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.activity).toBeUndefined();
      }
    });
  });
});

// ─── OPR.0.5.6.20 P3 — compactionStrategy resolution, most-specific-WINS ────────
// 基线先红：尚无 compactionStrategy 解析；ResolvedNodeConfig 不携带该字段。分层采用覆盖者优先
//（spec 默认值 < profile < member），有意不采用 restore_policy 的收窄格：四种模式无序
//（经 desk 同意的规划调用，已在 baton bd7eef84 中披露）。

describe("compactionStrategy 解析——最具体者优先（OPR.0.5.6.20）", () => {
  const specLifecycle = (compactionStrategy: string) => makeSpec({
    defaults: {
      runtime: "claude-code",
      lifecycle: { executionMode: "interactive_resident", compactionStrategy, restorePolicy: "resume_if_possible" },
    },
  } as Partial<AgentSpec>);

  it("member 覆盖 profile，profile 覆盖 spec 默认值（两级夹具；红灯：配置缺字段）", () => {
    const spec = specLifecycle("default-compaction");
    spec.profiles["default"].lifecycle = { compactionStrategy: "managed-compaction" } as never;
    const bare = resolveNodeConfig(makeCtx({ baseSpec: makeResolved(spec) }));
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.config.compactionStrategy).toBe("managed-compaction");
    const overridden = resolveNodeConfig(makeCtx({
      baseSpec: makeResolved(spec),
      member: makeMember({ compactionStrategy: "apprentice-handover" } as never),
    }));
    expect(overridden.ok).toBe(true);
    if (overridden.ok) expect(overridden.config.compactionStrategy).toBe("apprentice-handover");
  });

  it("各级均缺失时解析为 default-compaction（红灯：字段缺失）", () => {
    const result = resolveNodeConfig(makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionStrategy).toBe("default-compaction");
  });

  it("任一级存在无效值时，错误指出该层级（恢复策略错误风格；红灯：静默忽略）", () => {
    const result = resolveNodeConfig(makeCtx({
      member: makeMember({ compactionStrategy: "bogus" } as never),
    }));
    expect(result.ok).toBe(false);
  });

  it("成员级废弃别名解析为规范值（harness_native → default-compaction；红灯：无法识别）", () => {
    const result = resolveNodeConfig(makeCtx({
      member: makeMember({ compactionStrategy: "harness_native" } as never),
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionStrategy).toBe("default-compaction");
  });
});

// ─── OPR.0.5.6.20 B-3——非指定 level 不得参与 ────────────
// 在 fad5e26c0 上先红（R1 HOLD 发现，真实入口混合夹具）：规范化步骤将 default-compaction
// 具体化到省略 compaction_strategy 的 profile lifecycle 块中，随后解析器的 truthy 检查使这个
// 未指定值的 profile 击败显式 spec 级策略——旗舰 advisor 结构静默丢失连续性策略。
describe("compactionStrategy 优先级——未指定值的层级不参与（OPR.0.5.6.20 B-3）", () => {
  it("profile lifecycle 块省略 compaction_strategy 时保留 spec 级策略（真实入口：yaml -> normalize -> resolve）", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: b3-fixture
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
profiles:
  default:
    lifecycle:
      execution_mode: interactive_resident
`);
    const spec = normalizeAgentSpec(raw);
    const result = resolveNodeConfig(makeCtx({ baseSpec: makeResolved(spec) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionStrategy).toBe("apprentice-handover");
  });

  it("F-6 下限不变：各级均缺失时仍经同一真实入口解析为 default-compaction（基线绿色，下限固定）", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: b3-floor-fixture
defaults:
  runtime: claude-code
profiles:
  default:
    lifecycle:
      execution_mode: interactive_resident
`);
    const spec = normalizeAgentSpec(raw);
    const result = resolveNodeConfig(makeCtx({ baseSpec: makeResolved(spec) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.compactionStrategy).toBe("default-compaction");
  });
});

// ─── OPR.0.5.6.20 B-4——省略的 restore_policy 也不得参与 ─────
// 在 f35214f55 上先红（R2 HOLD 发现，与 B-3 的相邻字段同类）：normalizeLifecycle 将
// restorePolicy resume_if_possible 具体化到省略 restore_policy 的 profile lifecycle 块中，
// 收窄解析器又把合成值视为虚构的放宽并拒绝——用户若不冗余重复无关恢复策略，就无法选择
// profile 级连续性模式。它早于 S20，但位于候选方案的核心产品路径上。
describe("restorePolicy 优先级——未指定值的层级不参与（OPR.0.5.6.20 B-4）", () => {
  it("只指定 compaction_strategy 的 profile 不破坏也不放宽 spec 恢复策略（真实入口；同时证明两个输出）", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: b4-fixture
defaults:
  runtime: claude-code
  lifecycle:
    restore_policy: checkpoint_only
profiles:
  default:
    lifecycle:
      compaction_strategy: apprentice-handover
`);
    const spec = normalizeAgentSpec(raw);
    const result = resolveNodeConfig(makeCtx({ baseSpec: makeResolved(spec) }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.compactionStrategy).toBe("apprentice-handover");
      expect(result.config.restorePolicy).toBe("checkpoint_only");
    }
  });
});

describe("连续性机制优先级——已发布的三级路径（S20 A8）", () => {
  it("通过真实 AgentSpec 入口解析 spec-default < profile < member", () => {
    const raw = parseAgentSpec(`
version: "0.2"
name: mechanic-precedence
defaults:
  runtime: claude-code
  lifecycle:
    compaction_strategy: apprentice-handover
    mechanic: default-mechanic@default-rig
profiles:
  default:
    lifecycle:
      mechanic: profile-mechanic@profile-rig
`);
    const spec = normalizeAgentSpec(raw);
    const result = resolveNodeConfig(makeCtx({
      baseSpec: makeResolved(spec),
      member: makeMember({ mechanic: "member-mechanic@member-rig" } as never),
    }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.config as unknown as { mechanic?: string }).mechanic).toBe(
        "member-mechanic@member-rig",
      );
      expect(result.config.compactionStrategy).toBe("apprentice-handover");
    }
  });

  it("保留缺失状态，而非虚构默认机制", () => {
    const result = resolveNodeConfig(makeCtx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.config as unknown as { mechanic?: string }).mechanic).toBeUndefined();
    }
  });
});

describe("托管目录选择组合", () => {
  it("围绕仅拓扑 profile 添加系统和项目技能，而不重建拓扑", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-profile-skill-catalog-"));
    try {
      const catalog = join(root, "skills");
      const project = join(root, "project");
      mkdirSync(catalog, { recursive: true });
      mkdirSync(project, { recursive: true });
      execFileSync("git", ["-C", root, "init", "-q"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@openrig.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "OpenRig Test"]);
      writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: [system-skill]\n");
      for (const id of ["system-skill", "topology-skill", "project-skill"]) {
        mkdirSync(join(catalog, id));
        writeFileSync(join(catalog, id, "SKILL.md"), `---\nname: ${id}\ndescription: Use when testing ${id}.\n---\n\n# ${id}\n`);
      }
      writeFileSync(join(project, "project.yaml"), "install:\n  skills: [project-skill]\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);

      const spec = makeSpec({
        resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["topology-skill"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
        },
      });
      const result = resolveNodeConfig(makeCtx({
        baseSpec: makeResolved(spec, root),
        member: makeMember({ cwd: project, runtime: "codex" }),
        skillsRoot: catalog,
        systemSkills: ["system-skill"],
        homedir: join(root, "home"),
      }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.selectedResources.skills.map((skill) => skill.effectiveId)).toEqual([
        "project-skill",
        "system-skill",
        "topology-skill",
      ]);
      expect(result.config.skillLoadout?.entries.map((skill) => [skill.id, skill.selectedBy])).toEqual([
        ["project-skill", ["project"]],
        ["system-skill", ["system"]],
        ["topology-skill", ["topology"]],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("拒绝身份匹配目录但字节不匹配的拓扑来源", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-profile-skill-conflict-"));
    try {
      const catalog = join(root, "skills");
      const local = join(root, "local-skill");
      mkdirSync(join(catalog, "shared"), { recursive: true });
      mkdirSync(local, { recursive: true });
      execFileSync("git", ["-C", root, "init", "-q"]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@openrig.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "OpenRig Test"]);
      writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
      writeFileSync(join(catalog, "shared", "SKILL.md"), "---\nname: shared\ndescription: Use when catalog content is needed.\n---\n\n# catalog\n");
      writeFileSync(join(local, "SKILL.md"), "---\nname: shared\ndescription: Use when local content is needed.\n---\n\n# local\n");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);

      const spec = makeSpec({
        resources: { skills: [{ id: "shared", path: local }], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        profiles: {
          default: { uses: { skills: ["shared"], guidance: [], subagents: [], plugins: [], runtimeResources: [] } },
        },
      });
      const result = resolveNodeConfig(makeCtx({
        baseSpec: makeResolved(spec, root),
        skillsRoot: catalog,
        homedir: join(root, "home"),
      }));

      expect(result).toMatchObject({ ok: false, errors: [expect.stringContaining("skill_identity_conflict")] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
