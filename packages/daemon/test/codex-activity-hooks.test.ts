// OPR.0.4.1.10 FR-A——配置层 Codex 活动 hook 投射。ensureCodexActivityHooks()
// 将四个生命周期事件的内联 [hooks] 写入 ~/.codex/config.toml，使 OpenRig 启动的
// Codex 席位从干净的随附配置开始就以 hook 为主。已在 Codex 0.139 上完成一手验证
//（VM 风险排查，2026-06-30）：此 TOML 结构可被发现并信任（通过启动门禁
// "2 Trust all and continue"），回合范围 hook（包括关键的 PermissionRequest）会触发。
import { describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RELAY = "/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const CONFIG = "/home/test/.codex/config.toml";
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;

function mockCodexFs(files?: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function mockTmux(): TmuxAdapter {
  return { sendText: vi.fn(async () => ({ ok: true as const })) } as unknown as TmuxAdapter;
}

function makeAdapter(fs: CodexAdapterFsOps, relay: string | undefined = RELAY): CodexRuntimeAdapter {
  return new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: relay });
}

describe("OPR.0.4.1.10 FR-A——Codex 配置层活动 hooks", () => {
  it("为全部四个事件写入内联 [hooks]，并包含绝对 relay 命令和超时", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG];
    expect(cfg).toBeDefined();
    for (const ev of EVENTS) {
      expect(cfg).toContain(`[[hooks.${ev}]]`);
      expect(cfg).toContain(`[[hooks.${ev}.hooks]]`);
    }
    expect(cfg).toContain(`command = 'node "${RELAY}"'`);
    expect(cfg).toContain("timeout = 5");
  });

  it("GAP-7 通过注入的 Codex home 添加 hook 信任并移除 hooks", () => {
    const customConfig = "/custom-codex/config.toml";
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    const adapter = new CodexRuntimeAdapter({
      tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY, codexHome: "/custom-codex",
    });

    adapter.ensureCodexActivityHooks();
    expect(fs._store[customConfig]).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(fs._store[customConfig]).toContain("[hooks.state.");
    expect(fs._store[CONFIG]).toBeUndefined();

    adapter.removeCodexActivityHooks();
    expect(fs._store[customConfig]).not.toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(fs._store[CONFIG]).toBeUndefined();
  });

  it("使用规范键固定 [features].hooks = true（而非已弃用的 codex_hooks 别名）", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toContain("[features]");
    expect(cfg).toMatch(/^\s*hooks = true\s*$/m);
    expect(cfg).not.toContain("codex_hooks");
  });

  it("保持幂等——重复运行生成相同内容且不产生重复节", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    const adapter = makeAdapter(fs);
    adapter.ensureCodexActivityHooks();
    const first = fs._store[CONFIG]!;
    adapter.ensureCodexActivityHooks();
    const second = fs._store[CONFIG]!;
    expect(second).toBe(first);
    expect(second.match(/\[\[hooks\.PermissionRequest\]\]/g)?.length).toBe(1);
  });

  it("保留现有配置内容（工作区信任在 upsert 后仍存在）", () => {
    const fs = mockCodexFs({
      [RELAY]: "// relay",
      [CONFIG]: '[projects."/some/project"]\ntrust_level = "trusted"\n',
    });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toContain('[projects."/some/project"]');
    expect(cfg).toContain('trust_level = "trusted"');
    expect(cfg).toContain("[[hooks.PermissionRequest]]");
  });

  it("relay 路径变化时替换托管块，而非创建副本", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay", "/new/relay.cjs": "// relay2" });
    makeAdapter(fs, RELAY).ensureCodexActivityHooks();
    makeAdapter(fs, "/new/relay.cjs").ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toContain(`command = 'node "/new/relay.cjs"'`);
    expect(cfg).not.toContain(`command = 'node "${RELAY}"'`);
    expect(cfg.match(/# BEGIN OPENRIG MANAGED ACTIVITY HOOKS/g)?.length).toBe(1);
  });

  it("故障安全：relay 产物缺失时跳过写入并发出警告", () => {
    const fs = mockCodexFs({}); // 存储中不存在 RELAY。
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    makeAdapter(fs, RELAY).ensureCodexActivityHooks();
    expect(fs._store[CONFIG]).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("未配置 activityRelayPath 时静默不操作", () => {
    const fs = mockCodexFs({});
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    // 构造时不传 activityRelayPath（不通过默认参数辅助函数）。
    new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs }).ensureCodexActivityHooks();
    expect(fs._store[CONFIG]).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// B2（rev1-r2）——精确匹配不得漏掉非规范但真实的 [features] 头（带尾随注释/空格），
// 否则会产生重复的 [features] 表，导致 Codex 0.139 拒绝该文件。完全注释掉的
// "# [features]" 行不是节，不能按节处理。
const realFeaturesHeaders = (cfg: string) =>
  cfg.split("\n").filter((l) => /^\[features\]\s*(#.*)?$/.test(l.trim()));

describe("OPR.0.4.1.10 B2——容忍注释的 [features] 头匹配", () => {
  it("不会复制带尾随注释的真实 [features] 头", () => {
    const fs = mockCodexFs({
      [RELAY]: "// relay",
      [CONFIG]: '[features] # user comment\nmodel_reasoning_summary = true\n\n[projects."/x"]\ntrust_level = "trusted"\n',
    });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(realFeaturesHeaders(cfg).length).toBe(1); // 无重复表 → strict-config 有效。
    expect(cfg).toContain("[features] # user comment"); // 保留原始头。
    expect(cfg).toContain("model_reasoning_summary = true");
    expect(cfg).toMatch(/^\s*hooks = true\s*$/m);
  });

  it("不把完全注释掉的 '# [features]' 行当作节（追加一个真实 [features]）", () => {
    const fs = mockCodexFs({
      [RELAY]: "// relay",
      [CONFIG]: '# [features]\n# operator notes\n\n[projects."/x"]\ntrust_level = "trusted"\n',
    });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(realFeaturesHeaders(cfg).length).toBe(1); // 已追加一个真实 [features]。
    expect(cfg).toContain("# [features]"); // 注释行保持不变。
    expect(cfg).toMatch(/^\s*hooks = true\s*$/m);
  });
});

// B2（rev1-r2 增量 #2）——必须匹配所有有效 TOML 写法的 [features] 头
//（TOML v1.0.0：忽略括号键周围的空格；键可不加引号，也可加引号），否则遗漏的头
// 会导致追加重复表并被 Codex 0.139 --strict-config 拒绝。下面的规范化比较计数器
// 与生产匹配器保持一致。
const normFeaturesHeaders = (cfg: string) =>
  cfg.split("\n").filter((l) => {
    const t = l.trim();
    if (t.startsWith("#")) return false;
    const m = /^\[([^[\]]*)\]\s*(#.*)?$/.exec(t);
    if (!m) return false;
    let k = m[1]!.trim();
    if (k.length >= 2 && ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")))) k = k.slice(1, -1);
    return k === "features";
  }).length;

describe("OPR.0.4.1.10 B2——稳健匹配所有有效 TOML 写法的 [features] 头", () => {
  for (const header of ["[features]", "[ features ]", "[  features  ]", "[features] # c", "[ features ] # c", '["features"]', "['features']"]) {
    it(`不会为此写法复制 features 表：${header}`, () => {
      const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: `${header}\nhooks = false\n\n[projects."/x"]\ntrust_level = "trusted"\n` });
      makeAdapter(fs).ensureCodexActivityHooks();
      const cfg = fs._store[CONFIG]!;
      expect(normFeaturesHeaders(cfg)).toBe(1); // 仅有一个 features 表 → strict-config 有效。
      expect(cfg).toContain(header); // 保留原始头写法。
    });
  }

  it("完全注释掉的 '# [features]' 不是节（追加一个真实 features）", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: '# [features]\n\n[projects."/x"]\ntrust_level = "trusted"\n' });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(normFeaturesHeaders(cfg)).toBe(1);
    expect(cfg).toContain("# [features]");
  });
});

describe("OPR.0.4.1.10 B3——通过 removeCodexActivityHooks 持久禁用", () => {
  it("禁用时移除托管哨兵块，并保留用户所有的 hooks 与 [features]", () => {
    const fs = mockCodexFs({
      [RELAY]: "// relay",
      [CONFIG]: '[features]\nhooks = true\n\n[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/usr/bin/true"\n',
    });
    const adapter = makeAdapter(fs);
    adapter.ensureCodexActivityHooks();
    expect(fs._store[CONFIG]!).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    adapter.removeCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).not.toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(cfg).not.toContain("# END OPENRIG MANAGED ACTIVITY HOOKS");
    expect(cfg).not.toContain(`command = 'node "${RELAY}"'`); // 已移除托管 hooks。
    expect(cfg).toContain("[[hooks.PreToolUse]]"); // 保留用户所有的 hook。
    expect(cfg).toContain('command = "/usr/bin/true"');
    expect(cfg).toContain("[features]"); // 保持不变（0.139 默认值）。
  });

  it("没有配置或托管块时 removeCodexActivityHooks 不执行操作", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    makeAdapter(fs).removeCodexActivityHooks();
    expect(fs._store[CONFIG]).toBeUndefined();
    const fs2 = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: '[features]\nhooks = true\n' });
    makeAdapter(fs2).removeCodexActivityHooks();
    expect(fs2._store[CONFIG]).toBe('[features]\nhooks = true\n'); // 保持不变。
  });
});
