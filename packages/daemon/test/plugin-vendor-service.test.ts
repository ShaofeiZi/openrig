// plugin-primitive Phase 3a slice 3.2 Phase 2 的测试套件——PluginVendorService
//（vendoring + auto-fetch，404-tolerant fallback）。
//
// Per IMPL-PRD §2.5 + DESIGN.md §5.5 + orch-lead 2026-05-10:
//   - vendored copy seed 缺失的 install；manifest version 决定是否 upgrade
//   - auto-fetch 容忍 404，并回退到 vendored
//   - repo（github.com/mvschwarz/openrig-plugins）当前为空（只有 LICENSE）
//   - 按 IMPL-PRD §2.5 使用 5 秒 network timeout
//   - 任意失败都静默 fallback
//
// Service 职责（HG-2.3、HG-2.4、HG-2.5）：
//   1. ensureVendored()：缺失或严格更新时，从 packages/daemon/assets/plugins/<name>/ 复制到
//      ~/.openrig/plugins/<name>/
//   2. attemptAutoFetch()：尝试从 github.com/mvschwarz/openrig-plugins fetch；容忍
//      404/network/timeout；记录 outcome；永不抛错
//   3. ensureLatest()：编排 ensureVendored + attemptAutoFetch

import { describe, it, expect, vi } from "vitest";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";

// 可注入 fs op，供测试 mock
function mockFs(initialFiles?: Record<string, string>) {
  const store: Record<string, string> = { ...initialFiles };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store || Object.keys(store).some((k) => k.startsWith(p + "/")),
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    rmrf: (p: string) => {
      for (const k of Object.keys(store)) {
        if (k === p || k.startsWith(p + "/")) delete store[k];
      }
    },
    _store: store,
  };
}

const VENDORED_OPENRIG_CORE = {
  "/asset-root/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
  "/asset-root/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0","description":"v"}',
  "/asset-root/openrig-core/skills/openrig-skills/SKILL.md": "# openrig-skills index",
  "/asset-root/openrig-core/skills/openrig-user/SKILL.md": "# openrig-user vendored",
  "/asset-root/openrig-core/hooks/claude.json": '{"hooks":{}}',
};

describe("PluginVendorService——vendoring（HG-2.3）", () => {
  it("ensureVendored 在首次 launch 时将 vendored asset tree 复制到 user plugin dir", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");

    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0"}');
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.codex-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0","description":"v"}');
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/skills/openrig-user/SKILL.md"]).toBe("# openrig-user vendored");
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/hooks/claude.json"]).toBe('{"hooks":{}}');
  });

  it("ensureVendored 幂等——以相同 content 重跑时不重新写入（hash-skip）", async () => {
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      "/home/test/.openrig/plugins/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0","description":"v"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# openrig-skills index",
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-user/SKILL.md": "# openrig-user vendored",
      "/home/test/.openrig/plugins/openrig-core/hooks/claude.json": '{"hooks":{}}',
    });
    const writeCounts: Record<string, number> = {};
    const origWrite = fs.writeFile;
    fs.writeFile = (p: string, c: string) => { writeCounts[p] = (writeCounts[p] ?? 0) + 1; origWrite(p, c); };

    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");

    // hash 匹配 → 不写入
    expect(Object.values(writeCounts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("不让旧 bundled plugin 覆盖更新的 installed plugin", async () => {
    const installedSkill = "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md";
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.2.0"}',
      [installedSkill]: "# newer installed canon",
    });
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger,
    });

    await svc.ensureVendored("openrig-core");

    expect(fs._store[installedSkill]).toBe("# newer installed canon");
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json"]).toContain('"0.2.0"');
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/不比.*新.*保持已安装内容不变/i));
  });

  it("plugin version 相同时不替换不同的 installed byte", async () => {
    const installedSkill = "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md";
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      [installedSkill]: "# same-version installed authority",
    });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");

    expect(fs._store[installedSkill]).toBe("# same-version installed authority");
  });

  it("仅在 bundled manifest version 更新时升级旧 installed plugin", async () => {
    const source = {
      ...VENDORED_OPENRIG_CORE,
      "/asset-root/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.2.0"}',
      "/asset-root/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.2.0"}',
      "/asset-root/openrig-core/skills/openrig-skills/SKILL.md": "# bundled 0.2.0",
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# installed 0.1.0",
    };
    const fs = mockFs(source);
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");

    expect(fs._store["/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md"]).toBe("# bundled 0.2.0");
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json"]).toContain('"0.2.0"');
  });

  it("vendored asset 不存在（无 source 可复制）时 ensureVendored 静默跳过", async () => {
    const fs = mockFs({});
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await expect(svc.ensureVendored("nonexistent-plugin")).resolves.not.toThrow();
    expect(fs._store["/home/test/.openrig/plugins/nonexistent-plugin/anything"]).toBeUndefined();
  });

  it("将 plugin seed skill 投影到两个 harness-global skill root", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");
    svc.ensureSkillGlobally("openrig-core", "openrig-skills", [
      "/home/test/.claude/skills",
      "/home/test/.agents/skills",
    ]);

    expect(fs._store["/home/test/.claude/skills/openrig-skills/SKILL.md"]).toBe("# openrig-skills index");
    expect(fs._store["/home/test/.agents/skills/openrig-skills/SKILL.md"]).toBe("# openrig-skills index");
  });

  it("不覆盖既有 unversioned global skill target", async () => {
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# bundled older",
      "/home/test/.agents/skills/openrig-skills/SKILL.md": "# externally managed newer canon",
    });
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger,
    });

    svc.ensureSkillGlobally("openrig-core", "openrig-skills", ["/home/test/.agents/skills"]);

    expect(fs._store["/home/test/.agents/skills/openrig-skills/SKILL.md"]).toBe("# externally managed newer canon");
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/unversioned\/external authority.*保持不变/i));
  });

  it("仅当 bundled plugin version 新于 target marker 时执行 global projection", async () => {
    const marker = "/home/test/.agents/skills/openrig-skills/.openrig-vendor-version";
    const skill = "/home/test/.agents/skills/openrig-skills/SKILL.md";
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.2.0"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# bundled 0.2.0",
      [marker]: "0.1.0\n",
      [skill]: "# projected 0.1.0",
    });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    svc.ensureSkillGlobally("openrig-core", "openrig-skills", ["/home/test/.agents/skills"]);

    expect(fs._store[skill]).toBe("# bundled 0.2.0");
    expect(fs._store[marker]).toBe("0.2.0\n");
  });

  it("不覆盖相同或更新的 globally projected skill", async () => {
    const marker = "/home/test/.agents/skills/openrig-skills/.openrig-vendor-version";
    const skill = "/home/test/.agents/skills/openrig-skills/SKILL.md";
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# bundled 0.1.0",
      [marker]: "0.2.0\n",
      [skill]: "# projected 0.2.0",
    });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    svc.ensureSkillGlobally("openrig-core", "openrig-skills", ["/home/test/.agents/skills"]);

    expect(fs._store[skill]).toBe("# projected 0.2.0");
    expect(fs._store[marker]).toBe("0.2.0\n");
  });

  it("vendored plugin 缺少必需 global seed 时显著失败", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");
    expect(() =>
      svc.ensureSkillGlobally("openrig-core", "missing-seed", [
        "/home/test/.claude/skills",
        "/home/test/.agents/skills",
      ]),
    ).toThrow(/missing-seed/);
  });
});

describe("PluginVendorService——auto-fetch（HG-2.4 + HG-2.5）", () => {
  it("attemptAutoFetch 静默容忍 404——不抛错并回退到 vendored（HG-2.5）", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger,
    });

    await expect(svc.attemptAutoFetch("openrig-core")).resolves.not.toThrow();
    // vendored copy 仍可用（404-tolerant fallback contract）
    expect(fs._store["/asset-root/openrig-core/.claude-plugin/plugin.json"]).toBeDefined();
  });

  it("attemptAutoFetch 静默容忍 network error（DNS / connection refused 等）", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockRejectedValue(new Error("ENOTFOUND github.com"));
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger,
    });

    await expect(svc.attemptAutoFetch("openrig-core")).resolves.not.toThrow();
  });

  it("attemptAutoFetch 静默容忍 5 秒 timeout（慢速 network）", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)));
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await expect(svc.attemptAutoFetch("openrig-core")).resolves.not.toThrow();
  });

  it("attemptAutoFetch 记录 outcome（success 或 fallback）供 operator 观测", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger,
    });

    await svc.attemptAutoFetch("openrig-core");

    // 某条 log 描述 outcome（404、fallback 等）
    expect(logger).toHaveBeenCalled();
    const allLogs = logger.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allLogs).toMatch(/openrig-core|404|fallback|fetch/i);
  });

  it("attemptAutoFetch 请求 github.com/mvschwarz/openrig-plugins URL（或 release tarball pattern）", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.attemptAutoFetch("openrig-core");

    expect(httpClient).toHaveBeenCalled();
    const url = httpClient.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/github\.com\/mvschwarz\/openrig-plugins|api\.github\.com.*mvschwarz\/openrig-plugins/);
  });

  it("attemptAutoFetch 向 httpClient 传递 timeoutMs=5000（按 IMPL-PRD §2.5 为 5 秒 timeout）", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.attemptAutoFetch("openrig-core");

    expect(httpClient).toHaveBeenCalled();
    const opts = httpClient.mock.calls[0]?.[1] as { timeoutMs?: number } | undefined;
    expect(opts?.timeoutMs).toBe(5000);
  });

  it("attemptAutoFetch v0 success 路径只做 probe——不 extract tarball，也不更新 vendored copy", async () => {
    // 按 slice-3.2 v0 scope（orch-lead 2026-05-10 + velocity-guard 60344b3 BLOCKING-CONCERN）：
    //   - 404 是预期正常状态 response（根据 founder 授权，repo 当前为空）
    //   - 即使返回 200，v0 也不 extract 或 update——extraction/version-compare/update 明确属于
    //     slice 3.6（marketplace-consumption phase）
    // 此测试固定 v0 契约，使意外“implement extract”在有意实现它的 slice 3.6 中形成 TDD-red signal，
    // 而不是静默落入 3.2。
    const initialUserPlugin = "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json";
    const initialContent = '{"name":"openrig-core","version":"0.1.0"}';
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      [initialUserPlugin]: initialContent,
    });
    // mock 成功的 200 response（当前 repo 通常返回 404）
    const httpClient = vi.fn().mockResolvedValue({ ok: true, status: 200, body: "would-be-tarball-bytes" });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.attemptAutoFetch("openrig-core");

    // user plugin content 不变——v0 收到 200 也不 extract/install
    expect(fs._store[initialUserPlugin]).toBe(initialContent);
    // 也不写入 .version 文件
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.version"]).toBeUndefined();
  });
});

describe("PluginVendorService——ensureLatest 编排", () => {
  it("ensureLatest 先调用 ensureVendored，再调用 attemptAutoFetch（vendored fallback 始终可用）", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.ensureLatest("openrig-core");

    // vendored copy 先落盘（因此即使 fetch 失败也始终存在 fallback）
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json"]).toBeDefined();
    // 并且尝试了 fetch
    expect(httpClient).toHaveBeenCalled();
  });

  it("vendored 存在且 fetch 返回 404 时，ensureLatest 仍成功返回", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await expect(svc.ensureLatest("openrig-core")).resolves.not.toThrow();
  });
});
