import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_CLOCK_ANNOUNCEMENT } from "../src/adapters/stub-runner.js";

// Slice 51-01 条目 6-8——RIDER（review-r1 安全升级，由 orch 裁定）：注入的 clock 会自行通告。
// OPENRIG_TEST_CLOCK_NOW 会在已发布的 precompact hook 中读取，因此泄漏的变量会静默冻结生产环境的
// createdAt。变量处于 ACTIVE 状态时，precompact hook 和 stub runner 都会向 stderr 输出一行醒目消息，
// 从而让任何泄漏都能在席位日志中显现。变量不存在时保持静默（生产路径不变，行为零变化）。
// 固定要求：注入时两个发出方都必须有通告，未注入时都不得有通告。

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(
  HERE, "..", "assets", "plugins", "openrig-core",
  "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs",
);
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";

describe("注入 clock 自行通告（precompact hook）", () => {
  function runHook(clock: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "clock-announce-hook-"));
    try {
      const env = { ...process.env, OPENRIG_HOME: join(dir, ".openrig"), OPENRIG_SESSION_NAME: "seat@x", RIGGED_HOME: undefined } as NodeJS.ProcessEnv;
      if (clock !== undefined) env.OPENRIG_TEST_CLOCK_NOW = clock; else delete env.OPENRIG_TEST_CLOCK_NOW;
      const r = spawnSync(process.execPath, [HOOK_SCRIPT], { input: JSON.stringify({ cwd: dir }), encoding: "utf8", env });
      return r.stderr || "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("OPENRIG_TEST_CLOCK_NOW 生效时向 stderr 发出通告", () => {
    expect(runHook(INJECTED_ISO)).toContain(STUB_CLOCK_ANNOUNCEMENT);
  });

  it("未注入 clock 时保持 SILENT（无通告）——生产路径", () => {
    expect(runHook(undefined)).not.toContain(STUB_CLOCK_ANNOUNCEMENT);
  });
});

describe("注入 clock 自行通告（stub runner）", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function runRunner(clock: string | undefined): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "clock-announce-runner-"));
    const env = { ...process.env, OPENRIG_HOME: join(dir, ".openrig") } as NodeJS.ProcessEnv;
    if (clock !== undefined) env.OPENRIG_TEST_CLOCK_NOW = clock; else delete env.OPENRIG_TEST_CLOCK_NOW;
    let stderr = "";
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", "seat@x", "--cwd", dir, "--launch-id", "ann-1", "--posture", "floor"], { env });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    // 等待 runner 启动（sidecar ready），确保启动通告已经发出。
    const sidecar = join(dir, ".openrig", "stub", "state.json");
    const deadline = Date.now() + 12_000;
    while (!existsSync(sidecar)) {
      if (Date.now() > deadline) throw new Error("runner 未在 12 秒内 ready");
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150)); // 让同一 tick 的 stderr 完成刷新
    return stderr;
  }

  it("OPENRIG_TEST_CLOCK_NOW 生效时向 stderr 发出通告", async () => {
    expect(await runRunner(INJECTED_ISO)).toContain(STUB_CLOCK_ANNOUNCEMENT);
  }, 20_000);

  it("未注入 clock 时保持 SILENT（无通告）——生产路径", async () => {
    expect(await runRunner(undefined)).not.toContain(STUB_CLOCK_ANNOUNCEMENT);
  }, 20_000);
});
