// ATOM-7（slice-03 rig-context）——STRIP + RENAME 语法 pin。
//
// 创始人锁定的 SPEC §5 / §7：
//   - context-window 用量查看器被完全移除（删命令）；
//   - 裸 `rig context` = 库（list/help），句号；
//   - `rig context-pack` 语法被完全退役——一种语法，无弃用别名、无合并名词幽灵。
//
// 这些 pin 驱动真实装配的顶层程序（createProgram），使
// “help 干净 / 无孤儿机制可达”在接线层被证明，而非
// just at a leaf function.

import { describe, it, expect } from "vitest";
import type { Command } from "commander";
import { createProgram } from "../src/index.js";

const VIEWER_DESCRIPTION_FRAGMENT = "context-usage across running agents";
// OPR.0.5.3.6: `trace` joined the library — the topology chain walk is a pure
// read (config + filesystem, daemon-independent) with no delivery seam, which
// is exactly the class this grammar admits.
// Deliberately updated twice-over (OPR.0.5.3.5 Atom 4d): "get" landed at
// slice-07 R1 and this pin was never updated — it has been RED on main since
// (pre-existing baseline, on orch-lead's ledger); "profile" is slice-05's
// situation-composed delivery verb. Both are delivery-FREE library verbs
// (get/profile SERVE bytes to the caller's stdout; nothing sends to a seat),
// so the delivery-seam exclusion below still holds.
const LIBRARY_SUBCOMMANDS = ["work-install", "trace", "compose", "list", "show", "preview", "get", "profile", "recap-write", "sync", "add", "source", "rm"];

function topLevelNames(program: Command): string[] {
  return program.commands.map((c) => c.name());
}

function contextCmd(program: Command): Command {
  const cmd = program.commands.find((c) => c.name() === "context");
  if (!cmd) throw new Error("no top-level `context` command registered");
  return cmd;
}

describe("ATOM-7 rig context grammar (STRIP viewer + RENAME context-pack)", () => {
  it("(a) VIEWER GONE: `context` is the library, not the usage viewer; no command carries the viewer description", () => {
    const program = createProgram();
    const ctx = contextCmd(program);
    expect(ctx.description()).not.toContain(VIEWER_DESCRIPTION_FRAGMENT);
    // The library description — what `context` now owns.
    expect(ctx.description().toLowerCase()).toContain("context pack");
    // No top-level command anywhere still carries the viewer's description.
    const anyViewer = program.commands.some((c) => c.description().includes(VIEWER_DESCRIPTION_FRAGMENT));
    expect(anyViewer).toBe(false);
  });

  it("(b) HELP CLEAN: top-level lists `context`, never `context-pack`, and help text shows no viewer entry", () => {
    const program = createProgram();
    const names = topLevelNames(program);
    expect(names).toContain("context");
    expect(names).not.toContain("context-pack");
    const help = program.helpInformation();
    expect(help).not.toContain("context-pack");
    expect(help).not.toContain(VIEWER_DESCRIPTION_FRAGMENT);
  });

  it("(c) BARE `rig context` = DELIVERY-FREE LIBRARY: exact ordered subcommands exclude every delivery seam", () => {
    const program = createProgram();
    const context = contextCmd(program);
    const help = context.helpInformation();
    expect(context.commands.map((sub) => sub.name())).toEqual(LIBRARY_SUBCOMMANDS);
    for (const sub of LIBRARY_SUBCOMMANDS) {
      expect(help).toContain(sub);
    }
    expect(context.commands.map((sub) => sub.name())).not.toContain("send");
    expect(help).not.toMatch(/rig context send|^\s*send\b/im);
    expect(help).not.toContain("CONTEXT USAGE");
  });

  it("(d) ALIAS ABSENT: no `context-pack` command; `rig context-pack list` is rejected as unknown", async () => {
    const program = createProgram();
    expect(topLevelNames(program)).not.toContain("context-pack");
    program.exitOverride();
    await expect(
      program.parseAsync(["node", "rig", "context-pack", "list"]),
    ).rejects.toThrow();
  });
});
