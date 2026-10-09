// OPR activity-hook r3——Claude 托管 activity-hook 投递固定测试。
//
// 与 `activity-hook-rip-proof.test.ts` 共存（不会取代它）：rip-proof 套件守卫独立的
// `deliverStartup` 接缝（旧路径/名称 `activity-hook-relay`），后者继续保持移除状态。
// 本套件固定由始终运行的 `ClaudeCodeAdapter.project()` 接缝驱动的 r3 托管投递。
//
// 始终运行的接缝承担关键语义：`project()` 无条件遍历 `plan.entries`，因此即使 profile
// 移除了资源且没有生成条目，DISABLE（删除自有条目）在生产环境仍可达。存在
// `claude_activity_hooks` runtime_resource 条目，且 relay 源与规范事件清单可读时，
// ENABLE 才会触发。事件词汇从规范 `claude.json` 派生（没有并行手工维护的常量）。
// 所有权严格限定为 `node <quoted relay path>` 结构（仅仅包含该路径的用户命令会被保留）。
// 格式错误的设置会保留（闭合失败）。源缺失时不产生悬空命令，也不产生虚假的已投影声明。

import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { planProjection, type ProjectionPlan, type ProjectionEntry } from "../src/domain/projection-planner.js";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import type { RigSpec, RigSpecPod, RigSpecPodMember } from "../src/domain/types.js";
import { resolveAgentRef, type ResolvedAgentSpec } from "../src/domain/agent-resolver.js";

const CWD = "/project";
const RELAY_SRC = "/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const MANIFEST_SRC = "/assets/plugins/openrig-core/hooks/claude.json";
const RELAY_DEST = "/project/.openrig/hooks/scripts/activity-relay.cjs";
const SETTINGS = "/project/.claude/settings.local.json";
// 具体、绝对且经 shell 引用的 B 支路触发形式——绝不使用 ${CLAUDE_PLUGIN_ROOT}。
const OWNED_CMD = `node ${shellQuote(RELAY_DEST)}`;
const OWNED_MARKER = ".openrig/hooks/scripts/activity-relay.cjs";
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification"] as const;

// 规范 claude.json 的忠实子集：4 个 relay 事件（无 scope 的 relay 组），与必须排除的
// compaction/bridge 组交错。
const CANONICAL_MANIFEST = JSON.stringify({
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] },
      { matcher: "compact", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs"', timeout: 5 }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] },
      { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs"', timeout: 5 }] },
    ],
    PreCompact: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/skills/claude-compaction-restore/scripts/precompact-hook.mjs"', timeout: 30 }] }],
    PostCompact: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/compaction-restore-bridge.cjs"', timeout: 5 }] }],
    Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] }],
    Notification: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 }] }],
  },
});

type Store = Record<string, string>;
type Modes = Record<string, number>;

function mockFs(files?: Store, modes?: Modes): ClaudeAdapterFsOps & { _store: Store; _modes: Modes } {
  const store: Store = { ...files };
  const modeMap: Modes = { ...modes };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`未找到：${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: (src: string, dest: string) => { store[dest] = store[src] ?? ""; if (src in modeMap) modeMap[dest] = modeMap[src]!; },
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    statMode: (p: string) => (p in modeMap ? modeMap[p]! : 0o644),
    chmod: (p: string, m: number) => { modeMap[p] = m; },
    homedir: "/home/test",
    _store: store,
    _modes: modeMap,
  } as ClaudeAdapterFsOps & { _store: Store; _modes: Modes };
}

function mockTmux() {
  return {
    sessionExists: async () => true, sendKeys: async () => {}, capturePaneContent: async () => "",
    getPaneCommand: async () => "", listSessions: async () => [], runCommandInSession: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: async () => {},
  } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"];
}

function makeAdapter(fs: ClaudeAdapterFsOps, relayPath = RELAY_SRC, manifestPath = MANIFEST_SRC) {
  return new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: relayPath, claudeHooksManifestPath: manifestPath } as ConstructorParameters<typeof ClaudeCodeAdapter>[0]);
}

/** 可启用的文件系统：已植入 relay 工件（0755）和规范清单。 */
function enableFs(extra?: Store): ReturnType<typeof mockFs> {
  return mockFs({ [RELAY_SRC]: "// relay", [MANIFEST_SRC]: CANONICAL_MANIFEST, ...extra }, { [RELAY_SRC]: 0o755 });
}

function binding(cwd = CWD): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "t", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd } as NodeBinding;
}

function plan(entries: ProjectionEntry[]): ProjectionPlan {
  return { runtime: "claude-code", cwd: CWD, entries, startup: {} as ProjectionPlan["startup"], conflicts: [], noOps: [], diagnostics: [] };
}

function activityEntry(): ProjectionEntry {
  return {
    category: "runtime_resource", effectiveId: "claude-activity-hooks", sourceSpec: "shared",
    sourcePath: "shared/activity", resourcePath: "activity", absolutePath: RELAY_SRC,
    resourceType: "claude_activity_hooks", classification: "safe_projection",
  };
}

function readSettings(fs: ReturnType<typeof mockFs>): Record<string, any> {
  const raw = fs._store[SETTINGS];
  return raw ? JSON.parse(raw) : {};
}

function allCommands(settings: Record<string, any>): string[] {
  const out: string[] = [];
  const hooks = settings.hooks ?? {};
  for (const groups of Object.values(hooks) as any[]) {
    for (const g of groups ?? []) for (const h of g.hooks ?? []) if (typeof h.command === "string") out.push(h.command);
  }
  return out;
}

/** settings.local.json 已预置 4 个托管自有条目。 */
function seededOwned(): string {
  const hooks: Record<string, any> = {};
  for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: "command", command: OWNED_CMD, timeout: 5 }] }];
  return JSON.stringify({ hooks });
}

// 打包契约（QA 阻塞项 1f53796c）：投影出的 relay 必须为 0755，且生产代码保留源模式
//（适配器没有 chmod 策略）。因此已发布工件本身必须可执行——此回归测试 stat 真实提交的
// 工件，而非合成的 0o755 fixture。
describe("Claude activity-hook 投递——已发布 relay 工件的可执行模式（0755 契约）", () => {
  it("已提交的 activity-relay.cjs 工件可执行且模式为 0755（使保留模式的投影满足契约）", () => {
    const assetPath = pathResolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
    const mode = statSync(assetPath).mode & 0o777;
    expect(mode & 0o111, `已发布 relay 模式为 0${mode.toString(8)}，预期可执行`).not.toBe(0);
    expect(mode, `已发布 relay 模式为 0${mode.toString(8)}，预期为 0755`).toBe(0o755);
  });
});

describe("Claude activity-hook 投递——启用（条目存在，源与清单可读）", () => {
  it("以 0755 模式将 relay 复制到 <cwd>/.openrig/hooks/scripts/", async () => {
    const fs = enableFs();
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    expect(fs._store[RELAY_DEST]).toBe("// relay");
    expect(fs._modes[RELAY_DEST]! & 0o777).toBe(0o755);
  });

  it("用具体绝对命令为恰好 4 个 relay 事件更新或插入自有 relay 命令", async () => {
    const fs = enableFs();
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const settings = readSettings(fs);
    for (const ev of EVENTS) {
      const cmds = (settings.hooks?.[ev] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
      expect(cmds).toContain(OWNED_CMD);
    }
    expect(JSON.stringify(settings.hooks)).not.toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("不注入任何压缩钩子（PreCompact/PostCompact/compaction-restore-bridge）", async () => {
    const fs = enableFs();
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const settings = readSettings(fs);
    expect(settings.hooks?.PreCompact).toBeUndefined();
    expect(settings.hooks?.PostCompact).toBeUndefined();
    expect(JSON.stringify(settings.hooks ?? {})).not.toContain("compaction-restore-bridge");
  });

  it("从规范 claude.json 清单派生注入事件（无硬编码事件集合）", async () => {
    // 仅 Stop 引用 relay 的清单 → 只注入 Stop。
    const onlyStop = JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 9 }] }],
      PreCompact: [{ hooks: [{ type: "command", command: "node bridge.cjs" }] }],
    } });
    const fs = mockFs({ [RELAY_SRC]: "// relay", [MANIFEST_SRC]: onlyStop }, { [RELAY_SRC]: 0o755 });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    expect(Object.keys(readSettings(fs).hooks)).toEqual(["Stop"]);
  });

  it("具备幂等性：第二次 project() 不会添加重复的自有条目", async () => {
    const fs = enableFs();
    const adapter = makeAdapter(fs);
    await adapter.project(plan([activityEntry()]), binding());
    const once = fs._store[SETTINGS];
    await adapter.project(plan([activityEntry()]), binding());
    expect(fs._store[SETTINGS]).toBe(once);
    expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER)).length).toBe(EVENTS.length);
  });

  it("添加自有条目时保留预先存在的用户钩子", async () => {
    const fs = enableFs({ [SETTINGS]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node ./my-stop-hook.cjs", timeout: 10 }] }] } }) });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const cmds = allCommands(readSettings(fs));
    expect(cmds).toContain("node ./my-stop-hook.cjs");
    expect(cmds).toContain(OWNED_CMD);
  });

  it("替换 relay 路径已变化的陈旧自有条目（不重复）", async () => {
    const stale = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node ${shellQuote(`/old/prefix/${OWNED_MARKER}`)}`, timeout: 5 }] }] } });
    const fs = enableFs({ [SETTINGS]: stale });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    const stopCmds = (readSettings(fs).hooks?.Stop ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
    expect(stopCmds.filter((c: string) => c.includes(OWNED_MARKER))).toEqual([OWNED_CMD]);
  });
});

describe("Claude activity-hook 投递——通过始终运行的 project() 接缝禁用", () => {
  function seededManaged(extra?: Record<string, any>) {
    const hooks: Record<string, any> = {};
    for (const ev of EVENTS) hooks[ev] = [{ hooks: [{ type: "command", command: OWNED_CMD, timeout: 5 }] }];
    if (extra) for (const [k, v] of Object.entries(extra)) hooks[k] = [...(hooks[k] ?? []), ...v];
    return JSON.stringify({ hooks });
  }

  it("不存在 claude_activity_hooks 条目时删除自有条目（生产环境可达的禁用路径）", async () => {
    const fs = enableFs({ [SETTINGS]: seededManaged() });
    await makeAdapter(fs).project(plan([]), binding());
    expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER))).toEqual([]);
  });

  it("删除条目后清理已空的事件容器", async () => {
    const fs = enableFs({ [SETTINGS]: seededManaged() });
    await makeAdapter(fs).project(plan([]), binding());
    const settings = readSettings(fs);
    for (const ev of EVENTS) expect(settings.hooks?.[ev]).toBeUndefined();
  });

  it("禁用时仅删除自有条目，并保留用户钩子", async () => {
    const fs = enableFs({ [SETTINGS]: seededManaged({ Stop: [{ hooks: [{ type: "command", command: "node ./my-stop-hook.cjs", timeout: 10 }] }] }) });
    await makeAdapter(fs).project(plan([]), binding());
    const cmds = allCommands(readSettings(fs));
    expect(cmds).toContain("node ./my-stop-hook.cjs");
    expect(cmds.filter((c) => c.includes(OWNED_MARKER))).toEqual([]);
  });
});

describe("Claude activity-hook 投递——加固（守卫 r3 发现）", () => {
  it("精确所有权：不会删除仅仅包含 relay 路径的用户命令", async () => {
    // 参数包含标记的 echo——并非自有的 `node <path>` 结构。
    const userCmd = `echo ${shellQuote(`/somewhere/${OWNED_MARKER}`)}`;
    const fs = enableFs({ [SETTINGS]: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: userCmd, timeout: 3 }] }] } }) });
    await makeAdapter(fs).project(plan([]), binding()); // 通过禁用路径执行删除逻辑
    expect(allCommands(readSettings(fs))).toContain(userCmd);
  });

  it("闭合失败：保留格式错误的设置字节（不覆盖为 {}）", async () => {
    const malformed = "{ broken json";
    const fs = enableFs({ [SETTINGS]: malformed });
    await makeAdapter(fs).project(plan([activityEntry()]), binding());
    expect(fs._store[SETTINGS]).toBe(malformed);
  });

  it("源缺失：不写入悬空命令，并将条目报告为已跳过而非已投影", async () => {
    const fs = mockFs({ [MANIFEST_SRC]: CANONICAL_MANIFEST }, {}); // relay 源缺失
    const res = await makeAdapter(fs, "/assets/missing-relay.cjs").project(plan([activityEntry()]), binding());
    expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER))).toEqual([]);
    expect(res.projected).not.toContain("claude-activity-hooks");
    expect(res.skipped).toContain("claude-activity-hooks");
  });

  // 变更前预校验：relay 源存在但规范清单缺失、格式错误或不产生 relay 事件时，不得删除
  // 现有托管钩子、不得复制 relay、不得更改设置，也不得声明已投影/已投递。
  for (const [label, manifest] of [
    ["清单缺失", undefined],
    ["清单格式错误", "{ broken json"],
    ["清单没有 relay 事件", JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: "node bridge.cjs" }] }] } })],
  ] as const) {
    it(`${label}时启用：保留现有托管钩子与设置字节，不声明已投影，也不复制 relay`, async () => {
      const seeded = seededOwned();
      const files: Store = { [RELAY_SRC]: "// relay", [SETTINGS]: seeded };
      if (manifest !== undefined) files[MANIFEST_SRC] = manifest;
      const fs = mockFs(files, { [RELAY_SRC]: 0o755 });
      const manifestPath = manifest === undefined ? "/assets/missing-manifest.json" : MANIFEST_SRC;
      const res = await makeAdapter(fs, RELAY_SRC, manifestPath).project(plan([activityEntry()]), binding());
      expect(fs._store[SETTINGS]).toBe(seeded); // 设置字节未改变（不删除、不写入）
      expect(allCommands(readSettings(fs)).filter((c) => c.includes(OWNED_MARKER)).length).toBe(EVENTS.length); // 保留托管钩子
      expect(fs._store[RELAY_DEST]).toBeUndefined(); // 未复制 relay
      expect(res.projected).not.toContain("claude-activity-hooks");
      expect(res.skipped).toContain("claude-activity-hooks");
    });
  }
});

// M1（R1 裁决）：所有权必须能往返处理 shellQuote。包含合法撇号的 cwd（O'Brien）会让
// shellQuote 将 ' 转义为 '"'"'，朴素的引号参数匹配器会漏掉它——因此重复启用时自有钩子
// 会无界累积，禁用时还会残留。
describe("Claude activity-hook 投递——所有权可往返处理 shellQuote（cwd 含撇号）", () => {
  it("cwd 包含撇号（O'Brien）时：启用两次仍为每事件一个自有条目，禁用后全部删除", async () => {
    const cwd = "/project/O'Brien";
    const settingsPath = `${cwd}/.claude/settings.local.json`;
    const ownedCmd = `node ${shellQuote(`${cwd}/.openrig/hooks/scripts/activity-relay.cjs`)}`;
    const fs = enableFs();
    const adapter = makeAdapter(fs);
    await adapter.project(plan([activityEntry()]), binding(cwd));
    await adapter.project(plan([activityEntry()]), binding(cwd)); // 幂等地重新启用
    const enabled = JSON.parse(fs._store[settingsPath]!);
    expect(allCommands(enabled).filter((c) => c === ownedCmd).length, "不会无界累积").toBe(EVENTS.length);
    await adapter.project(plan([]), binding(cwd)); // 禁用
    const disabled = fs._store[settingsPath] ? JSON.parse(fs._store[settingsPath]!) : {};
    expect(allCommands(disabled).filter((c) => c.includes(OWNED_MARKER)), "没有悬空的自有钩子").toEqual([]);
  });

  it("保留末尾参数以 relay 后缀结尾的用户多参数命令（并非单个自有令牌）", async () => {
    // 两者都是用户命令：node <user-arg> <relay-path>。它们都不是单个规范 shellQuote
    // 令牌，因此所有权逻辑不得认领（并删除）它们。
    const userSingle = `node 'user-arg' ${shellQuote("/tmp/.openrig/hooks/scripts/activity-relay.cjs")}`;
    const userDouble = `node "user-arg" "/tmp/.openrig/hooks/scripts/activity-relay.cjs"`;
    const seeded = JSON.stringify({ hooks: { Stop: [{ hooks: [
      { type: "command", command: userSingle, timeout: 3 },
      { type: "command", command: userDouble, timeout: 3 },
    ] }] } });
    const fs = enableFs({ [SETTINGS]: seeded });
    await makeAdapter(fs).project(plan([]), binding()); // 通过禁用执行删除逻辑
    const cmds = allCommands(readSettings(fs));
    expect(cmds, "保留单引号多参数用户命令").toContain(userSingle);
    expect(cmds, "保留双引号多参数用户命令").toContain(userDouble);
  });
});

// 生产高度可达性：实际发布的 profile 字节（development/implementer，选择
// shared:claude-activity-hooks）必须通过真实的 resolveAgentRef -> resolveNodeConfig ->
// planProjection -> adapter，解析为适配器会启用的计划条目。从磁盘加载（不是内存中的
// AgentSpec），因此固定的是已发布选择，而非镜像。
describe("Claude activity-hook——真实已发布规范的解析器 -> 规划器 -> 适配器可达性", () => {
  const SHIPPED_SPECS_ROOT = pathResolve(import.meta.dirname, "../specs");
  const realSpecFs = { readFile: (p: string) => readFileSync(p, "utf-8"), exists: (p: string) => existsSync(p) };
  const member = (): RigSpecPodMember => ({ id: "impl", agentRef: "local:agents/development/implementer", profile: "default", runtime: "claude-code", cwd: "." } as RigSpecPodMember);
  const pod = (): RigSpecPod => ({ id: "dev", label: "Dev", members: [member()], edges: [] } as RigSpecPod);
  const rig = (): RigSpec => ({ version: "0.2", name: "test-rig", pods: [pod()], edges: [] } as RigSpec);

  it("已发布 development/implementer profile 选择 claude_activity_hooks -> 计划条目 -> 适配器启用", async () => {
    // 1. 从磁盘解析实际发布的 agent.yaml 及其共享导入。
    const rr = resolveAgentRef("local:agents/development/implementer", SHIPPED_SPECS_ROOT, realSpecFs);
    expect(rr.ok, rr.ok ? "" : `解析失败：${JSON.stringify(rr)}`).toBe(true);
    if (!rr.ok) return;
    const ctx: ResolutionContext = {
      baseSpec: rr.resolved as ResolvedAgentSpec, importedSpecs: rr.imports, collisions: rr.collisions,
      profileName: "default", member: member(), pod: pod(), rig: rig(),
    };
    // 2. 真实解析器——已发布选择解析为 claude_activity_hooks 运行时资源。
    const rc = resolveNodeConfig(ctx);
    expect(rc.ok).toBe(true);
    if (!rc.ok) return;
    expect(rc.config.selectedResources.runtimeResources.some((qr) => (qr.resource as { type?: string }).type === "claude_activity_hooks")).toBe(true);
    // 3. 真实规划器生成该条目。
    const pr = planProjection({ config: rc.config, collisions: [], fsOps: { readFile: () => "{}", exists: () => true } });
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    const entry = pr.plan.entries.find((e) => e.resourceType === "claude_activity_hooks");
    expect(entry, "规划器必须从已发布规范生成 claude_activity_hooks 条目").toBeDefined();
    expect(entry!.category).toBe("runtime_resource");
    // 4. 真实适配器根据真实计划启用（技能条目投影噪声无关紧要——始终运行的协调逻辑
    //    通过清单依赖注入完成投递）。
    const fs = enableFs();
    await makeAdapter(fs).project(pr.plan, binding());
    expect(fs._store[RELAY_DEST]).toBe("// relay");
    for (const ev of EVENTS) {
      const cmds = (readSettings(fs).hooks?.[ev] ?? []).flatMap((g: any) => (g.hooks ?? []).map((h: any) => h.command));
      expect(cmds).toContain(OWNED_CMD);
    }
  });
});
