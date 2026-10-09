// 缺陷修复切片 plugin-discovery-respects-openrig-home——接线测试。
//
// 验证 PluginDiscoveryService 的启动时接线遵循 `OPENRIG_HOME` 环境覆盖值
//（根据 IMPL-PRD §5 的 HG-1、HG-3、HG-4）。plugin-discovery-service.test.ts 中的
// 服务级测试覆盖针对注入路径的扫描逻辑；本测试覆盖 startup.ts 中调用点的解析，
// 修复前这里硬编码了 `~/.openrig/plugins`。若无此门禁，调用点的下一次回归只能通过
// 端到端 VM dogfood 演练暴露（velocity-qa 最初正是这样发现该缺陷）。
//
// HG-5（audit-grep）在第二个 describe 中作为静态检查断言：daemon src 中不再保留
// `homedir().*\.openrig.*plugins` 字面量。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createDaemon } from "../src/startup.js";

let tmpHome: string;
let savedHome: string | undefined;
let savedNoKernel: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "openrig-home-wiring-"));
  savedHome = process.env.OPENRIG_HOME;
  savedNoKernel = process.env.OPENRIG_NO_KERNEL;
  process.env.OPENRIG_HOME = tmpHome;
  process.env.OPENRIG_NO_KERNEL = "1"; // 双重保险；vitest 已自动跳过
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENRIG_HOME;
  else process.env.OPENRIG_HOME = savedHome;
  if (savedNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
  else process.env.OPENRIG_NO_KERNEL = savedNoKernel;
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeClaudePluginManifest(pluginDir: string, manifest: Record<string, unknown>) {
  const pluginDotDir = join(pluginDir, ".claude-plugin");
  mkdirSync(pluginDotDir, { recursive: true });
  writeFileSync(join(pluginDotDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function writeCodexPluginManifest(pluginDir: string, manifest: Record<string, unknown>) {
  const pluginDotDir = join(pluginDir, ".codex-plugin");
  mkdirSync(pluginDotDir, { recursive: true });
  writeFileSync(join(pluginDotDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function writeHookRegistry(
  pluginDir: string,
  runtime: "claude" | "codex",
  events: string[],
  command: string,
) {
  const hooksDir = join(pluginDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, `${runtime}.json`), JSON.stringify({
    hooks: Object.fromEntries(events.map((event) => [
      event,
      [{ hooks: [{ type: "command", command, timeout: 5 }] }],
    ])),
  }, null, 2));
}

function refocusProviders(runtime: "claude" | "codex"): string[] {
  const pluginsDir = join(tmpHome, "plugins");
  return readdirSync(pluginsDir)
    .filter((plugin) => {
      try {
        return readFileSync(join(pluginsDir, plugin, "hooks", `${runtime}.json`), "utf8")
          .includes("/hooks/scripts/refocus.cjs");
      } catch {
        return false;
      }
    })
    .sort();
}

describe("plugin 发现遵循 OPENRIG_HOME（HG-1、HG-3、HG-4）", () => {
  it("扫描 <OPENRIG_HOME>/plugins 并发现放置于其中的 plugin", async () => {
    // 在 <OPENRIG_HOME>/plugins/example/ 中放置一个合成 plugin
    const pluginDir = join(tmpHome, "plugins", "example");
    writeClaudePluginManifest(pluginDir, {
      name: "example",
      version: "0.1.0",
      description: "测试 plugin",
    });

    const { deps, db } = await createDaemon({ dbPath: ":memory:" });
    try {
      const service = deps.pluginDiscoveryService;
      expect(service).toBeDefined();
      const plugins = await service!.listPlugins({});
      const ids = plugins.map((p) => p.id);
      expect(ids).toContain("example");
      expect(refocusProviders("claude")).toEqual(["openrig-core"]);
      expect(refocusProviders("codex")).toEqual(["openrig-core"]);
    } finally {
      db.close();
    }
  });

  it("启动时清理升级遗留的历史 openrig-lab refocus 注册", async () => {
    const lab = join(tmpHome, "plugins", "openrig-lab");
    writeClaudePluginManifest(lab, {
      name: "openrig-lab",
      version: "0.1.0",
      hooks: "./hooks/claude.json",
    });
    writeCodexPluginManifest(lab, {
      name: "openrig-lab",
      version: "0.1.0",
      hooks: "./hooks/codex.json",
    });
    writeHookRegistry(
      lab,
      "claude",
      ["SessionStart", "UserPromptSubmit", "Stop", "PostCompact"],
      'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"',
    );
    writeHookRegistry(
      lab,
      "codex",
      ["SessionStart", "UserPromptSubmit", "Stop"],
      'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"',
    );

    const { deps, db } = await createDaemon({ dbPath: ":memory:" });
    try {
      expect(deps.pluginDiscoveryService!.listPlugins().map((plugin) => plugin.id)).toContain("openrig-lab");
      expect(JSON.parse(readFileSync(join(lab, ".claude-plugin", "plugin.json"), "utf8"))).not.toHaveProperty("hooks");
      expect(JSON.parse(readFileSync(join(lab, ".codex-plugin", "plugin.json"), "utf8"))).not.toHaveProperty("hooks");
      expect(JSON.parse(readFileSync(join(lab, "hooks", "claude.json"), "utf8"))).toEqual({ hooks: {} });
      expect(JSON.parse(readFileSync(join(lab, "hooks", "codex.json"), "utf8"))).toEqual({ hooks: {} });
      expect(refocusProviders("claude")).toEqual(["openrig-core"]);
      expect(refocusProviders("codex")).toEqual(["openrig-core"]);
    } finally {
      db.close();
    }
  });

  it("vendor 与 discovery 解析到同一个以 OPENRIG_HOME 为根的路径（path startsWith 验证）", async () => {
    // 加固的对称解析检查：断言发现的 PluginEntry.path 确实位于 <tmpHome>/plugins 下，
    // 而不仅是出现同名 id。否则，若主机存在 ~/.openrig/plugins/openrig-core，修复前代码
    // 可能从错误根目录满足只检查 id 的断言。
    //
    // 两层证据：
    //   1. 合成 plugin id（不是 'openrig-core'——某些操作者机器的主机默认位置存在该名称，
    //      因此无法区分修复前后代码）。
    //   2. PluginEntry.path 以 <tmpHome>/plugins/<unique-id> 开头。
    const uniqueId = `synthetic-cross-leak-${Date.now()}`;
    const pluginDir = join(tmpHome, "plugins", uniqueId);
    writeClaudePluginManifest(pluginDir, {
      name: uniqueId,
      version: "0.1.0",
      description: "跨根泄漏探针",
    });

    const { deps, db } = await createDaemon({ dbPath: ":memory:" });
    try {
      const plugins = await deps.pluginDiscoveryService!.listPlugins({});
      const entry = plugins.find((p) => p.id === uniqueId);
      expect(entry, `发现流程应显示合成 plugin ${uniqueId}`).toBeDefined();
      expect(entry!.source).toBe("vendored");
      // Path-startsWith 证明：发现流程基于 tmpHome 解析，而非主机默认的 ~/.openrig。
      expect(entry!.path.startsWith(join(tmpHome, "plugins"))).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("plugin-discovery-respects-openrig-home 审计（HG-2、HG-5）", () => {
  // T5：静态 grep 审计——daemon src 中不得保留硬编码的 `homedir() ... .openrig ...
  // plugins` 字面量。注释中可以出现，运行时路径构造中则不允许。若未来变更重新引入
  // velocity-qa VM dogfood 所暴露的硬编码路径，本测试会失败。
  it("没有 daemon src 文件通过 homedir() 字面量构造 plugins 路径", () => {
    const daemonSrcDir = resolve(__dirname, "..", "src");
    const offenders: string[] = [];
    const NEEDLE = /homedir\(\)\s*,\s*["']\.openrig["']\s*,\s*["']plugins["']/;
    const NEEDLE_PATH_JOIN = /path\.join\([^)]*homedir\(\)[^)]*\.openrig[^)]*plugins/;

    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf-8");
        // 移除行注释和块注释，避免提及旧路径的文档产生误报。
        const stripped = text
          .split("\n")
          .map((line) => {
            const idx = line.indexOf("//");
            return idx === -1 ? line : line.slice(0, idx);
          })
          .join("\n")
          .replace(/\/\*[\s\S]*?\*\//g, "");
        if (NEEDLE.test(stripped) || NEEDLE_PATH_JOIN.test(stripped)) {
          offenders.push(full.replace(daemonSrcDir + "/", ""));
        }
      }
    }
    walk(daemonSrcDir);
    if (offenders.length > 0) {
      throw new Error(
        `Daemon src 文件仍通过 homedir() 字面量构造 plugins 路径——必须改用 getDefaultOpenRigPath('plugins')：\n  - ${offenders.join("\n  - ")}`,
      );
    }
    // 有意引用未使用的 import 以消除 lint 告警
    void statSync;
    void dirname;
  });
});
