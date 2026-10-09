// OPR.0.4.3.33 hook-trust-autoclear——复现 Codex 自己的 `[hooks.state."<key>"] trusted_hash`
// 记录，用于 daemon 的 4 个 authored activity hooks，在 provisioning seam 预写，使 unmanaged
// inline hooks 在每条路径（launch/adopt/reconcile）上都被信任，无需手动 `/hooks`
// "Trust all" 按键。
//
// GROUND-TRUTH 警示：Codex 的 key/hash 是私有实现。HASH 从开源确定性复现
//（NormalizedHookIdentity 的 canonical-JSON sha256 → version_for_toml；见
// codex-runtime-adapter.ts 的块注释）。下方 fixture 标记为 PIN-TO-VM：它们是本复现发出的值，
// 扰动测试证明 identity 字段被折入——但 DEFINITIVE 正确性检查是真实 Codex `[hooks.state]`
// 在 `/hooks`→"Trust all" 后逐字节 read-back（QA VM 证明）。在该 read-back 确认之前，
// 精确 key_source（canonicalized config 路径）与位置索引为 PROVISIONAL。不匹配是 fail-safe
//（门重现 + Layer-2 按键底线），绝不 false-trusted 运行。
import { describe, it, expect, vi } from "vitest";
import {
  CodexRuntimeAdapter,
  computeCodexHookTrust,
  upsertCodexHookTrust,
  type CodexAdapterFsOps,
} from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RELAY = "/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const CONFIG = "/home/test/.codex/config.toml";
const COMMAND = `node "${RELAY}"`;
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;

// PIN 到 VM read-back（qa 门）——来自开源复现的 PROVISIONAL（PR #20321 / 提交
// 0452dca、ffcc9cc；codex-rs fingerprint.rs version_for_toml）。此处 keySource 是非 canonical
// mock 路径 `/home/test/.codex/config.toml`；真实 key_source 是 std::fs::canonicalize(config.toml)。
const PROVISIONAL_FIXTURE: Record<(typeof EVENTS)[number], { key: string; hash: string }> = {
  SessionStart: {
    key: "/home/test/.codex/config.toml:session_start:0:0",
    hash: "sha256:bbe395fdcffc4448b019a7621ff4c4ca57c43107e775ea286394724944fd4fe1",
  },
  UserPromptSubmit: {
    key: "/home/test/.codex/config.toml:user_prompt_submit:0:0",
    hash: "sha256:88a4916f162eb0fb90e90ebfe5844c4d552efb7e9b70f4616ea497026f6b61d4",
  },
  Stop: {
    key: "/home/test/.codex/config.toml:stop:0:0",
    hash: "sha256:7349b4836f7c53f7fbe92917a5a598b25a0e699b98a91cf5909bb40dc60da822",
  },
  PermissionRequest: {
    key: "/home/test/.codex/config.toml:permission_request:0:0",
    hash: "sha256:f3e7b08eef7376efd47d8cd066a2d7284d5ee12b54c7bac2d484b8bbe6ab803c",
  },
};

function mockCodexFs(files?: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function mockTmux(): TmuxAdapter {
  return { sendText: vi.fn(async () => ({ ok: true as const })) } as unknown as TmuxAdapter;
}

describe("OPR.0.4.3.33——computeCodexHookTrust（key + hash 派生）", () => {
  it("为四个 authored hook 复现 PROVISIONAL（PIN-TO-VM）key + trusted_hash", () => {
    for (const ev of EVENTS) {
      const got = computeCodexHookTrust(ev, { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
      expect(got).toEqual(PROVISIONAL_FIXTURE[ev]);
      expect(got.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("把 timeout 折入 hash（扰动：timeout 5→6 改 hash，不改 key）", () => {
    const base = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const perturbed = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 6 });
    expect(perturbed.key).toBe(base.key);
    expect(perturbed.hash).not.toBe(base.hash);
  });

  it("把 command（relay 路径）折入 hash（扰动：不同 relay → 不同 hash）", () => {
    const base = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const perturbed = computeCodexHookTrust("Stop", {
      keySource: CONFIG,
      command: `node "/other/relay.cjs"`,
      timeoutSec: 5,
    });
    expect(perturbed.hash).not.toBe(base.hash);
  });

  it("把存在的 matcher 折入 hash（证明 matcher 是 identity 一部分，不是缺席）", () => {
    const none = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const withMatcher = computeCodexHookTrust("Stop", {
      keySource: CONFIG,
      command: COMMAND,
      timeoutSec: 5,
      matcher: "Bash",
    });
    expect(withMatcher.hash).not.toBe(none.hash);
  });

  it("以 source path + event label + 位置索引为 key", () => {
    const got = computeCodexHookTrust("PermissionRequest", {
      keySource: "/x/config.toml",
      command: COMMAND,
      timeoutSec: 5,
    });
    expect(got.key).toBe("/x/config.toml:permission_request:0:0");
  });
});

describe("OPR.0.4.3.33——upsertCodexHookTrust（幂等、不覆盖、section 作用域）", () => {
  const KEY = PROVISIONAL_FIXTURE.SessionStart.key;
  const HASH = PROVISIONAL_FIXTURE.SessionStart.hash;

  it("缺失时创建带 trusted_hash 的 [hooks.state.\"<key>\"] 表", () => {
    const out = upsertCodexHookTrust("", KEY, HASH);
    expect(out).toBe(`[hooks.state.${JSON.stringify(KEY)}]\ntrusted_hash = ${JSON.stringify(HASH)}\n`);
  });

  it("幂等——同 key+hash 两次 byte 一致（no-op）", () => {
    const once = upsertCodexHookTrust("", KEY, HASH);
    const twice = upsertCodexHookTrust(once, KEY, HASH);
    expect(twice).toBe(once);
  });

  it("hash 变化时只拼接 trusted_hash 行（不重复表）", () => {
    const first = upsertCodexHookTrust("", KEY, "sha256:old");
    const updated = upsertCodexHookTrust(first, KEY, HASH);
    expect(updated.match(new RegExp(`\\[hooks\\.state\\.`, "g"))?.length).toBe(1);
    expect(updated).toContain(`trusted_hash = ${JSON.stringify(HASH)}`);
    expect(updated).not.toContain("sha256:old");
  });

  it("不覆盖无关 [hooks.state]、[projects] trust 条目或其他内容", () => {
    const existing =
      '[projects."/some/project"]\ntrust_level = "trusted"\n\n' +
      '[hooks.state."/other/config.toml:pre_tool_use:0:0"]\ntrusted_hash = "sha256:other"\n';
    const out = upsertCodexHookTrust(existing, KEY, HASH);
    // 每条既有行 byte 一致保留
    expect(out).toContain('[projects."/some/project"]');
    expect(out).toContain('trust_level = "trusted"');
    expect(out).toContain('[hooks.state."/other/config.toml:pre_tool_use:0:0"]');
    expect(out).toContain('trusted_hash = "sha256:other"');
    // 我们的新条目追加
    expect(out).toContain(`[hooks.state.${JSON.stringify(KEY)}]`);
    expect(out).toContain(`trusted_hash = ${JSON.stringify(HASH)}`);
    // 另一个 state 条目的 hash 未被触碰
    expect(out.match(/sha256:other/g)?.length).toBe(1);
  });
});

describe("OPR.0.4.3.33——provisioning seam 耦合（ensureCodexActivityHooks 预信任我们的 4 个 hook）", () => {
  function makeAdapter(fs: CodexAdapterFsOps): CodexRuntimeAdapter {
    return new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY });
  }

  it("同时发 managed hook 块和恰好 4 条 [hooks.state] trust 记录", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toBeDefined();
    // managed hook 块在场
    expect(cfg).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    for (const ev of EVENTS) expect(cfg).toContain(`[[hooks.${ev}]]`);
    // 且恰好 4 条 trust state 条目（keySource 回退到普通 config 路径，因为 mock fs
    // 从不让文件落到真实磁盘供 realpathSync 使用）
    for (const ev of EVENTS) {
      const { key, hash } = PROVISIONAL_FIXTURE[ev];
      expect(cfg).toContain(`[hooks.state.${JSON.stringify(key)}]`);
      expect(cfg).toContain(`trusted_hash = ${JSON.stringify(hash)}`);
    }
    // 作用域：恰好 4 个 hooks.state 表，不多，无通配/blanket 条目
    expect(cfg.match(/^\[hooks\.state\./gm)?.length).toBe(4);
    expect(cfg).not.toContain('[hooks.state."*"]');
  });

  it("幂等——重跑产生 byte 一致 config（无重复 trust 表）", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    const adapter = makeAdapter(fs);
    adapter.ensureCodexActivityHooks();
    const first = fs._store[CONFIG]!;
    adapter.ensureCodexActivityHooks();
    const second = fs._store[CONFIG]!;
    expect(second).toBe(first);
    expect(second.match(/^\[hooks\.state\./gm)?.length).toBe(4);
  });

  it("在 hook + trust 写入过程中保留既有 [projects] trust 条目", () => {
    const fs = mockCodexFs({
      [RELAY]: "// relay",
      [CONFIG]: '[projects."/some/project"]\ntrust_level = "trusted"\n',
    });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toContain('[projects."/some/project"]');
    expect(cfg).toContain('trust_level = "trusted"');
    expect(cfg).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(cfg.match(/^\[hooks\.state\./gm)?.length).toBe(4);
  });
});
