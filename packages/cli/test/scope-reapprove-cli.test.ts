// OPR.0.5.0.18——amend/re-stamp 动词的 CLI 表面：本地 flag 误用拒绝
//（在任何 daemon 联系前触发）+ `scope audit` amendment-lineage 表面
//（文件系统本地，读原子 re-stamp 写出的 priors frontmatter）。经 commander 树
// 对 tmp substrate fixture 端到端驱动（scope-progress harness 惯用法）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import { scopeCommand } from "../src/commands/scope.js";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-reapprove-"));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function seedSubstrate(): { root: string; missionsRoot: string } {
  const root = mktemp();
  const missionsRoot = path.join(root, "internal-docs", "missions");
  execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
  fs.mkdirSync(missionsRoot, { recursive: true });
  writeFile(
    path.join(missionsRoot, "release-x", "README.md"),
    "---\nid: OPR.X\nstage: wip\n---\n# release-x\n",
  );
  writeFile(
    path.join(missionsRoot, "release-x", "PROGRESS.md"),
    "# Progress\n",
  );
  return { root, missionsRoot };
}

interface CaptureResult { exitCode: number; stdout: string; stderr: string; }

async function run(args: string[], workspace: string): Promise<CaptureResult> {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const origExit = process.exit;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderrBuf.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__EXIT__${exitCode}`); }) as typeof process.exit;
  const prevExitCode = process.exitCode;
  process.exitCode = 0;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", ...args, "--workspace", workspace]);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith("__EXIT__")) {
      // commander exitOverride or a CLI error path — capture continues
    }
  } finally {
    const finalCode = exitCode || (typeof process.exitCode === "number" ? process.exitCode : 0);
    exitCode = finalCode;
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
    process.exitCode = prevExitCode;
  }
  return { exitCode, stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") };
}

describe("rig scope slice approve — amend/re-stamp flag misuse (local, pre-daemon)", () => {
  let root: string;
  let missionsRoot: string;

  beforeEach(() => {
    ({ root, missionsRoot } = seedSubstrate());
    writeFile(
      path.join(missionsRoot, "release-x", "slices", "18-amend-me", "README.md"),
      "---\nid: OPR.X.18\nstatus: spec\n---\n# Slice\n",
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("--re-approve without --reason refuses loudly BEFORE any daemon contact", async () => {
    const res = await run(
      ["slice", "approve", "18-amend-me", "--mission", "release-x", "--scope", "spec", "--actor", "pm@rig", "--re-approve"],
      root,
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/--re-approve 没带 --reason/);
    expect(res.stderr + res.stdout).toMatch(/--reason "<why>"/);
  });

  it("--reason without --re-approve refuses loudly (no silent drop of intent)", async () => {
    const res = await run(
      ["slice", "approve", "18-amend-me", "--mission", "release-x", "--scope", "spec", "--actor", "pm@rig", "--reason", "oops"],
      root,
    );
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/--reason 没有 --re-approve/);
  });
});

describe("rig scope audit — amendment lineage surface (OPR.0.5.0.18 mini-req 4)", () => {
  let root: string;
  let missionsRoot: string;

  beforeEach(() => {
    ({ root, missionsRoot } = seedSubstrate());
    // A re-stamped slice: current attestation + priors count (what the atomic
    // re-stamp frontmatter write leaves behind).
    writeFile(
      path.join(missionsRoot, "release-x", "slices", "01-amended", "README.md"),
      [
        "---",
        "id: OPR.X.1",
        "status: building",
        "approved-spec-by: planner@rig",
        "approved-spec-at: 2026-08-04T21:00:00.000Z",
        "approved-spec-priors: 2",
        "---",
        "# Amended slice",
      ].join("\n") + "\n",
    );
    writeFile(path.join(missionsRoot, "release-x", "slices", "01-amended", "PROGRESS.md"), "# P\n");
    // A never-amended slice: no lineage output.
    writeFile(
      path.join(missionsRoot, "release-x", "slices", "02-plain", "README.md"),
      "---\nid: OPR.X.2\nstatus: building\napproved-spec-by: pm@rig\napproved-spec-at: 2026-08-04T20:00:00.000Z\n---\n# Plain\n",
    );
    writeFile(path.join(missionsRoot, "release-x", "slices", "02-plain", "PROGRESS.md"), "# P\n");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("text output: a re-stamped slice shows current attestation + prior-count; a plain slice shows none", async () => {
    const res = await run(["audit", "--mission", "release-x"], path.join(root, "internal-docs"));
    expect(res.stdout).toMatch(/审计|谱系/);
    expect(res.stdout).toMatch(/01-amended \[spec\]：当前 planner@rig 于 2026-08-04T21:00:00\.000Z——审计日志中 2 条 prior attestation/);
    expect(res.stdout).not.toMatch(/02-plain \[spec\]/);
  });

  it("json output: the attestations field rides only re-stamped slices", async () => {
    const res = await run(["audit", "--mission", "release-x", "--json"], path.join(root, "internal-docs"));
    const parsed = JSON.parse(res.stdout) as { slices: Array<{ name: string; attestations?: Record<string, { by: string; priors: number }> }> };
    const amended = parsed.slices.find((s) => s.name === "01-amended")!;
    expect(amended.attestations?.spec).toMatchObject({ by: "planner@rig", priors: 2 });
    const plain = parsed.slices.find((s) => s.name === "02-plain")!;
    expect(plain.attestations).toBeUndefined();
  });
});
