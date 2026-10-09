// OPR.0.4.0.33 — `rig scope ... progress` update verb + `... repair`
// backfill，经 commander 树端到端驱动，对 tmp
// substrate fixture.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import { scopeCommand } from "../src/commands/scope.js";

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-scope-prog-"));
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
    path.join(missionsRoot, "release-0.4.0", "README.md"),
    "---\nid: OPR.0.4.0\nstage: wip\n---\n# release-0.4.0\n",
  );
  return { root, missionsRoot };
}

interface CaptureResult { exitCode: number; stdout: string; stderr: string; }

async function run(args: string[], workspace: string): Promise<CaptureResult> {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderrBuf.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error(`__EXIT__${exitCode}`); }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", ...args, "--workspace", path.dirname(workspace)]);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.startsWith("__EXIT__")) stderrBuf.push(msg + "\n");
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") };
}

/** 通过 CLI 创建切片并返回其绝对路径。 */
async function createSlice(env: { missionsRoot: string }, slug: string, extra: string[] = []): Promise<string> {
  const r = await run(["slice", "create", "release-0.4.0", slug, ...extra, "--json"], env.missionsRoot);
  return JSON.parse(r.stdout).slice.path as string;
}

describe("zrig scope slice progress（FR-3 add/set）", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("--add 向默认 Rail 章节追加 UI 可解析的复选框行", async () => {
    const slicePath = await createSlice(env, "verb-add");
    const r = await run(["slice", "progress", slicePath, "--add", "Guard approved", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const progress = fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8");
    expect(progress).toMatch(/## Rail\n\n- \[ \] Guard approved/);
    // 保留 H1 标题来源。
    expect(progress).toMatch(/^# 进度 —/m);
  });

  it("--add --section 定位既有章节；--status 设置状态标记", async () => {
    const slicePath = await createSlice(env, "verb-section");
    const r = await run([
      "slice", "progress", slicePath,
      "--add", "QA passed", "--section", "Acceptance", "--status", "done", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const progress = fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8");
    expect(progress).toMatch(/## 验收[\s\S]*- \[x\] QA passed/);
    expect(progress).not.toMatch(/## Acceptance/); // 将英文别名定位到既有中文章节，不创建重复章节。
  });

  it("--set 重写既有行状态；幂等重跑不做修改", async () => {
    const slicePath = await createSlice(env, "verb-set");
    const first = await run([
      "slice", "progress", slicePath, "--set", "实现完成", "--status", "done", "--json",
    ], env.missionsRoot);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).progress.changed).toBe(true);
    const progress = fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8");
    expect(progress).toContain("- [x] 实现完成");

    const again = await run([
      "slice", "progress", slicePath, "--set", "实现完成", "--status", "done", "--json",
    ], env.missionsRoot);
    expect(JSON.parse(again.stdout).progress.changed).toBe(false);
  });

  it("--add 保持幂等：同一行添加两次不会重复", async () => {
    const slicePath = await createSlice(env, "verb-idem");
    await run(["slice", "progress", slicePath, "--add", "Once", "--json"], env.missionsRoot);
    await run(["slice", "progress", slicePath, "--add", "Once", "--json"], env.missionsRoot);
    const progress = fs.readFileSync(path.join(slicePath, "PROGRESS.md"), "utf8");
    const occurrences = progress.split("- [ ] Once").length - 1;
    expect(occurrences).toBe(1);
  });

  it("未提供 --add 或 --set 时返回错误", async () => {
    const slicePath = await createSlice(env, "verb-neither");
    const r = await run(["slice", "progress", slicePath, "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it("同时提供 --add 和 --set 时返回错误", async () => {
    const slicePath = await createSlice(env, "verb-both");
    const r = await run([
      "slice", "progress", slicePath, "--add", "x", "--set", "y", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it("拒绝未知 --status 值", async () => {
    const slicePath = await createSlice(env, "verb-badstatus");
    const r = await run([
      "slice", "progress", slicePath, "--add", "x", "--status", "wip", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).ok).toBe(false);
  });

  it("为仅 README 的切片编辑 README rail（而不是 PROGRESS.md）", async () => {
    const slicePath = await createSlice(env, "verb-readme-only", ["--readme-only"]);
    expect(fs.existsSync(path.join(slicePath, "PROGRESS.md"))).toBe(false);
    const r = await run(["slice", "progress", slicePath, "--add", "Rail item", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(slicePath, "PROGRESS.md"))).toBe(false); // still no PROGRESS.md
    const readme = fs.readFileSync(path.join(slicePath, "SPEC.md"), "utf8");
    expect(readme).toMatch(/## Rail\n\n- \[ \] Rail item/);
    expect(readme).toMatch(/progress_rail:\s*readme-only/); // frontmatter preserved
  });

  it("工作范围没有进度界面时返回错误（stale-host ghost）", async () => {
    // 一个 slice 目录，有 README 但无 PROGRESS.md 且无 readme-only
    // marker——创始人报告的 stale-host artifact 形状。
    const ghost = path.join(env.missionsRoot, "release-0.4.0", "slices", "02-ghost");
    writeFile(path.join(ghost, "README.md"), "---\nid: OPR.0.4.0.2\n---\n# ghost\n");
    const r = await run(["slice", "progress", ghost, "--add", "x", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.action).toMatch(/repair|create/);
  });
});

describe("zrig scope mission progress（FR-3）", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("--add 更新任务目标 PROGRESS.md", async () => {
    // 先 backfill mission PROGRESS.md（seed mission 无）。
    await run(["mission", "repair", "release-0.4.0", "--json"], env.missionsRoot);
    const r = await run([
      "mission", "progress", "release-0.4.0", "--add", "Mission milestone", "--section", "Milestones", "--json",
    ], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    const progress = fs.readFileSync(path.join(env.missionsRoot, "release-0.4.0", "PROGRESS.md"), "utf8");
    expect(progress).toMatch(/## Milestones[\s\S]*- \[ \] Mission milestone/);
  });
});

describe("zrig scope repair（FR-6 回填）", () => {
  let env: { root: string; missionsRoot: string };
  beforeEach(() => { env = seedSubstrate(); });
  afterEach(() => { fs.rmSync(env.root, { recursive: true, force: true }); });

  it("mission repair 回填缺失的 PROGRESS.md；重跑不做修改", async () => {
    const progressPath = path.join(env.missionsRoot, "release-0.4.0", "PROGRESS.md");
    expect(fs.existsSync(progressPath)).toBe(false);
    const first = await run(["mission", "repair", "release-0.4.0", "--json"], env.missionsRoot);
    expect(first.exitCode).toBe(0);
    expect(fs.existsSync(progressPath)).toBe(true);
    const content = fs.readFileSync(progressPath, "utf8");
    expect(content).toMatch(/^# 进度 —/m);

    const second = await run(["mission", "repair", "release-0.4.0", "--json"], env.missionsRoot);
    const parsed = JSON.parse(second.stdout);
    expect(parsed.created.length).toBe(0); // 没有新增内容。
    expect(fs.readFileSync(progressPath, "utf8")).toBe(content); // 保持不变。
  });

  it("mission repair 回填缺少 PROGRESS 的切片，但跳过仅 README 的切片", async () => {
    // stale-host 幽灵切片（有 README、无 PROGRESS、无标记）。
    const ghost = path.join(env.missionsRoot, "release-0.4.0", "slices", "02-ghost");
    writeFile(path.join(ghost, "README.md"), "---\nid: OPR.0.4.0.2\n---\n# ghost\n");
    // 有意创建的仅 README 切片。
    await createSlice(env, "small-one", ["--readme-only"]);

    const r = await run(["mission", "repair", "release-0.4.0", "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    // 幽灵切片获得 PROGRESS.md。
    expect(fs.existsSync(path.join(ghost, "PROGRESS.md"))).toBe(true);
    // 不强制为仅 README 切片创建 PROGRESS.md。
    const readmeOnlySlice = path.join(env.missionsRoot, "release-0.4.0", "slices");
    const roDir = fs.readdirSync(readmeOnlySlice).find((d) => d.includes("small-one"))!;
    expect(fs.existsSync(path.join(readmeOnlySlice, roDir, "PROGRESS.md"))).toBe(false);
  });

  it("slice repair 回填单个缺少 PROGRESS 的切片", async () => {
    const ghost = path.join(env.missionsRoot, "release-0.4.0", "slices", "03-lonely");
    writeFile(path.join(ghost, "README.md"), "---\nid: OPR.0.4.0.3\n---\n# lonely\n");
    const r = await run(["slice", "repair", ghost, "--json"], env.missionsRoot);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).result.created).toBe(true);
    expect(fs.existsSync(path.join(ghost, "PROGRESS.md"))).toBe(true);
  });
});
