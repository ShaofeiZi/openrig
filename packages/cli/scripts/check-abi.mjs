#!/usr/bin/env node

// @openrig/cli 的 postinstall 原生 SQLite 自检。
// OpenRig 支持 Node.js 22 与 24。better-sqlite3 13 需要 Node 22 或更新版本；
// 在 Node 20 上它能安装并加载，但第一次打开数据库时就会崩溃（SIGSEGV）。
// 本检查在加载任何原生代码之前先拒绝不受支持的主版本号，再证明绑定确实能打开数据库。
// 打开操作放在子进程里执行，这样原生崩溃会以信号形式被捕获，而不是静默带走主进程。
//
// 注意：本文件对用户可见的提示文案已中文化；packages/cli/test/check-abi.test.ts
// 中的人类展示断言已同步改为中文，行为断言（退出码、版本串、命令片段、信号名）保留。

const SUPPORTED_MAJORS = [22, 24];

const box = (lines) =>
  [
    "",
    "  ╔══════════════════════════════════════════════════════════════╗",
    ...lines.map((line) => `  ║  ${line.padEnd(60)}║`),
    "  ╚══════════════════════════════════════════════════════════════╝",
    "",
  ].join("\n");

const FIX_INSTALL = "修复： nvm install 22 && npm install -g @openrig/cli";

/**
 * @param {{
 *   nodeVersion: string,
 *   loadNativeAddon: () => void,
 *   openNativeDatabase?: () => { ok: true } | { ok: false, detail: string },
 * }} deps
 * @returns {{ ok: true, warning?: string } | { ok: false, message: string }}
 */
export function checkAbi({ nodeVersion, loadNativeAddon, openNativeDatabase }) {
  // 第一阶段：版本区间检查。在加载任何原生代码之前运行。
  const match = nodeVersion.match(/^v?(\d+)/);
  const major = match ? parseInt(match[1], 10) : 0;

  if (major < SUPPORTED_MAJORS[0]) {
    return {
      ok: false,
      message: box([
        "@openrig/cli 需要 Node.js 22 或 24（LTS）。",
        `当前版本： ${nodeVersion}`,
        "",
        "不再支持 Node 20：SQLite 绑定",
        "（better-sqlite3 13）在该版本打开数据库时会崩溃。",
        "",
        FIX_INSTALL,
      ]),
    };
  }

  if (major % 2 !== 0) {
    return {
      ok: false,
      message: box([
        "@openrig/cli 不支持奇数版本的 Node。",
        `当前版本： ${nodeVersion}`,
        "",
        "支持版本：Node.js 22 与 24（LTS）。",
        "",
        FIX_INSTALL,
      ]),
    };
  }

  // 高于支持区间的偶数主版本属于“未经验证”，而不是直接拒绝。
  const warning = SUPPORTED_MAJORS.includes(major)
    ? undefined
    : box([
        `Node ${major} 未经 @openrig/cli 验证。`,
        `当前版本： ${nodeVersion}`,
        "",
        "支持版本：Node.js 22 与 24（LTS）。下面的 SQLite 检查",
        "已通过，但该 Node 上的其他行为尚未验证。",
      ]);

  // 第二阶段：加载原生插件（捕获 ABI / 打包 / 权限类问题）。
  try {
    loadNativeAddon();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const isAbiMismatch = detail.includes("NODE_MODULE_VERSION");

    return {
      ok: false,
      message:
        box(
          isAbiMismatch
            ? [
                "better-sqlite3 原生二进制与当前 Node 不匹配。",
                `当前版本： ${nodeVersion}`,
                "",
                "修复： npm rebuild better-sqlite3",
                "或： nvm install 22 && npm install -g @openrig/cli",
              ]
            : [
                "better-sqlite3 原生插件加载失败。",
                `当前版本： ${nodeVersion}`,
                "",
                "修复： npm rebuild better-sqlite3",
                "若仍失败，请用受支持的 Node 版本重装：",
                "      nvm install 22 && npm install -g @openrig/cli",
              ],
        ) + `  Detail: ${detail}\n`,
    };
  }

  // 第三阶段：打开一个内存数据库。仅“能加载”并不能证明绑定可用
  // （Node 20 + better-sqlite3 13 就是能加载、却在这里段错误）。
  if (openNativeDatabase) {
    const opened = openNativeDatabase();
    if (!opened.ok) {
      return {
        ok: false,
        message:
          box([
            "better-sqlite3 已加载，但无法打开数据库。",
            `当前版本： ${nodeVersion}`,
            "",
            "修复： npm rebuild better-sqlite3",
            "若仍失败，请用 Node 22 或 24 重装：",
            "      nvm install 22 && npm install -g @openrig/cli",
          ]) + `  详情： ${opened.detail}\n`,
      };
    }
  }

  return warning ? { ok: true, warning } : { ok: true };
}

/**
 * 在子进程里打开内存数据库，这样原生崩溃（例如 SIGSEGV）会被观察为信号，
 * 而不会直接杀死本脚本。
 * @param {string} addonPath 从本包解析出的原生插件绝对路径
 */
export function openInChildProcess(addonPath, spawnSync) {
  const probe =
    `const Database = require(${JSON.stringify(addonPath)});` +
    `const db = new Database(":memory:");` +
    `db.prepare("select sqlite_version() as v").get();` +
    `db.close();`;
  const result = spawnSync(process.execPath, ["-e", probe], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.signal) return { ok: false, detail: `打开数据库被 ${result.signal} 终止` };
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim().split("\n").slice(-3).join(" ");
    return { ok: false, detail: `打开数据库退出码 ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  return { ok: true };
}

// --- 作为 postinstall 脚本直接运行时 ---
const isMain =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1].endsWith("check-abi.mjs"));

if (isMain) {
  const { createRequire } = await import("node:module");
  const { spawnSync } = await import("node:child_process");
  const require = createRequire(import.meta.url);

  const result = checkAbi({
    nodeVersion: process.version,
    loadNativeAddon: () => require("better-sqlite3"),
    openNativeDatabase: () => openInChildProcess(require.resolve("better-sqlite3"), spawnSync),
  });

  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
  } else if (result.warning) {
    console.error(result.warning);
  }
}
