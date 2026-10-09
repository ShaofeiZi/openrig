// OPR.0.5.3.5 recap-write 原子——出向 occupant 的 write 动词（store 单独
// 不满足的 Q2 边界要求）。与 trace 一样独立于 daemon：seat 目录从
// topology.root CONFIG 解析（slice-06 D1 布局），写入流经唯一 store
//（取代 + 可寻址门），提示契约发现走 stderr，门大声拒绝。

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";

async function runRecapWrite(argv: string[]): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errLogs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
  process.exitCode = undefined;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(contextCommand());
    await program.parseAsync(["node", "rig", "context", ...argv]);
  } catch { /* commander exitOverride */ } finally {
    exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  return { logs, errLogs, exitCode };
}

describe("rig context recap-write — the boundary write verb", () => {
  it("writes RECAP.md to the topology seat dir, supersedes into the chain, and echoes advisory findings on stderr", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s05-recap-verb-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(join(tmp, "topology", "rigs", "r1", "seats", "s1"), { recursive: true });
      const f1 = join(tmp, "era1.md");
      writeFileSync(f1, "## Recent Decisions\nchose X because Y");
      const first = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", f1]);
      expect(first.exitCode ?? 0).toBe(0);
      const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("chose X because Y");
      // 第二次写入取代；缺 decisions section 的内容在 stderr 引出
      // ADVISORY 发现但仍落盘（绝不因 prose 拦截）。
      const f2 = join(tmp, "era2.md");
      writeFileSync(f2, "## Status\nall done");
      const second = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", f2]);
      expect(second.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("all done");
      expect(readdirSync(join(seatDir, "recap-superseded"))).toHaveLength(1);
      expect(second.errLogs.join("\n")).toMatch(/decisions/i);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("provisions a missing seat directory beneath an existing topology rig", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-provision-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const rigDir = join(tmp, "topology", "rigs", "r1");
      const seatDir = join(rigDir, "seats", "s1");
      mkdirSync(rigDir, { recursive: true });
      expect(existsSync(seatDir)).toBe(false);
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nchose provisioning because manual mkdir is not a product path");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);

      expect(res.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("chose provisioning");
      writeFileSync(recap, "## Recent Decisions\nkept the supported store path because it preserves the chain");
      const second = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);
      expect(second.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("preserves the chain");
      expect(readdirSync(join(seatDir, "recap-superseded"))).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a missing rig instead of manufacturing an arbitrary topology", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-missing-rig-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "missing", "--seat", "s1", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/rig.*does not exist|topology/i);
      expect(existsSync(join(tmp, "topology", "rigs", "missing"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses unsafe rig or seat path segments before provisioning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-path-guard-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(join(tmp, "topology", "rigs", "r1"), { recursive: true });
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "../escape", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/不安全.*段/);
      expect(existsSync(join(tmp, "topology", "rigs", "r1", "escape"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to provision through a symlinked topology namespace", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-symlink-guard-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const rigDir = join(tmp, "topology", "rigs", "r1");
      const outside = join(tmp, "outside");
      mkdirSync(rigDir, { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(rigDir, "seats"));
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/symlink|escape|unsafe/i);
      expect(existsSync(join(outside, "s1"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the addressability gate refuses LOUD and leaves nothing behind", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s05-recap-verb2-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
      mkdirSync(seatDir, { recursive: true });
      const bad = join(tmp, "bad.md");
      writeFileSync(bad, "## Same\na\n## Same\nb");
      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", bad]);
      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/addressab|duplicate/i);
      expect(existsSync(join(seatDir, "RECAP.md"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
