// OPR.0.3.2.14——HG-5 discriminator。本 slice 之前，四个 hook 相关常量
//（CLAUDE_HOOKS_ROOT + 三个 command-path const）分别复制在 7 个以上测试文件中。0.3.1
// 清理时，source 侧 fallback 子路径发生变化，test 侧副本没有同步，hook check 的纯字符串比较
// 因而报告不匹配，并导致 17 个测试损坏。
//
// 本 slice 从 source 导出常量，并让每个 importer 从那里读取。本文件固定架构修复：
//   - source 模块导出四个常量；
//   - 每个常量都解析到 .openrig 子路径族（option-B 移除内部团队布局）；
//   - source-grep 确认没有后台服务测试文件把常量重新声明为顶层 `const`，也没有测试文件包含
//     被禁止的内部团队路径结构。
//
// 被禁止的 literal 在 runtime 由 segment 组合，因此 assertion 不会逐字写出该字符串。grep 也
// 包含本测试文件，不做自我排除；未来贡献者若在此粘贴 literal，也会触发同一 guard。
//
// 已通过 mutation 验证：重新引入测试侧 `const CLAUDE_HOOKS_ROOT = ...` 声明会使下方两个
// 测试失败。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_HOOKS_ROOT,
  CLAUDE_SESSION_START_COMPACT_COMMAND,
  CLAUDE_USER_PROMPT_SUBMIT_COMMAND,
  CLAUDE_HOOK_FRAGMENT_PATH,
} from "../src/domain/restore-check-service.js";

// 被禁止的 shared-docs 路径结构（内部团队布局）。由 segment 组合，逐字 literal 不会出现在
// 本文件 source text 中，因此下方 source-grep guard 可扫描本文件而不会自我触发。
const FORBIDDEN_SUBPATH = ["code", "substrate", "shared-docs"].join("/");

describe("OPR.0.3.2.14——hook 常量只有一个 source（测试侧不复制）", () => {
  it("CLAUDE_HOOKS_ROOT 从 source 导出并解析到 openrig 子路径，而不是内部团队布局", () => {
    expect(CLAUDE_HOOKS_ROOT).toMatch(/\.openrig[/\\]shared-docs[/\\]control-plane[/\\]services[/\\]claude-hooks/);
    expect(CLAUDE_HOOKS_ROOT).not.toContain(FORBIDDEN_SUBPATH);
    expect(CLAUDE_HOOKS_ROOT).not.toContain(FORBIDDEN_SUBPATH.replace(/\//g, "\\"));
  });

  it("CLAUDE_SESSION_START_COMPACT_COMMAND 已导出且位于 CLAUDE_HOOKS_ROOT/bin/ 下", () => {
    expect(CLAUDE_SESSION_START_COMPACT_COMMAND.startsWith(CLAUDE_HOOKS_ROOT)).toBe(true);
    expect(CLAUDE_SESSION_START_COMPACT_COMMAND).toMatch(/[/\\]bin[/\\]session-start-compact-context\.sh$/);
  });

  it("CLAUDE_USER_PROMPT_SUBMIT_COMMAND 已导出且位于 CLAUDE_HOOKS_ROOT/bin/ 下", () => {
    expect(CLAUDE_USER_PROMPT_SUBMIT_COMMAND.startsWith(CLAUDE_HOOKS_ROOT)).toBe(true);
    expect(CLAUDE_USER_PROMPT_SUBMIT_COMMAND).toMatch(/[/\\]bin[/\\]userpromptsubmit-queue-attention\.sh$/);
  });

  it("CLAUDE_HOOK_FRAGMENT_PATH 已导出且位于 CLAUDE_HOOKS_ROOT/config/ 下", () => {
    expect(CLAUDE_HOOK_FRAGMENT_PATH.startsWith(CLAUDE_HOOKS_ROOT)).toBe(true);
    expect(CLAUDE_HOOK_FRAGMENT_PATH).toMatch(/[/\\]config[/\\]settings\.fragment\.json$/);
  });

  // Source-grep：没有测试文件把 CLAUDE_HOOKS_ROOT 重新声明为顶层 const；从 source 导入可以。
  it("source-grep：后台服务测试文件均未把 CLAUDE_HOOKS_ROOT 重新声明为顶层 const", async () => {
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const testDir = here;
    const entries = fs.readdirSync(testDir);
    const offenders: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) continue;
      const file = path.join(testDir, name);
      const src = fs.readFileSync(file, "utf-8");
      // 匹配 `const CLAUDE_HOOKS_ROOT = `，即 slice 之前的本地重声明模式。
      if (/^const\s+CLAUDE_HOOKS_ROOT\s*=/m.test(src)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  // 隐私泄漏 guard：后台服务测试文件的任何位置都不应携带内部团队路径结构。少数曾需要该路径的
  // 测试通过复制 CLAUDE_HOOKS_ROOT 声明获得它；source 侧清理 + import 而不重声明的修复同时
  // 封闭两个类别。被禁止字符串在 runtime 由 segment 组合，因此本文件可通过自身 grep。
  it("source-grep：后台服务测试文件均不含被禁止的 shared-docs 路径结构", async () => {
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const testDir = here;
    const entries = fs.readdirSync(testDir);
    const offenders: Array<{ file: string; lineNo: number; line: string }> = [];
    for (const name of entries) {
      if (!name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) continue;
      const file = path.join(testDir, name);
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(FORBIDDEN_SUBPATH)) {
          offenders.push({ file: name, lineNo: i + 1, line: lines[i]!.slice(0, 100) });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
