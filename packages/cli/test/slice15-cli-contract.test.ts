// Slice 15 (OPR.0.4.7.15) — CLI contract honesty regression tests.
//   1. shared --json error path (machine-parseable error + nonzero exit)
//   2. `queue overdue` rig-scoped + bounded + body-free by default
//   3. 未知 `-o` 格式被拒（queue list）——非接受后忽略
//   4. invalid `--limit` (negative/zero/non-numeric) rejected (queue list)
//   5. `rig ps --active` 诚实：无 --nodes 大声失败（不静默 no-op）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProgram } from "../src/index.js";
import { runProgram } from "../src/cli-error.js";
import type { QueueDeps } from "../src/commands/queue.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

function makeQueueDeps(): { deps: QueueDeps; calls: Array<{ method: string; path: string }> } {
  const calls: Array<{ method: string; path: string }> = [];
  return {
    calls,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => { calls.push({ method: "GET", path }); return { status: 200, data: [] }; }),
        getText: vi.fn(async () => ({ status: 200, data: "" })),
        post: vi.fn(async (path: string) => { calls.push({ method: "POST", path }); return { status: 201, data: {} }; }),
        delete: vi.fn(async () => ({ status: 204, data: null })),
        postText: vi.fn(async () => ({ status: 200, data: "" })),
        postExpectText: vi.fn(async () => ({ status: 200, data: "" })),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

// 经共享错误路径（runProgram）运行 CLI，捕获 stdout/stderr/exit。
async function runCli(args: string[], deps?: Parameters<typeof createProgram>[0]) {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode = 0;
  const program = createProgram(deps);
  await runProgram(program, ["node", "rig", ...args], {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    exit: (c) => { exitCode = c; },
  });
  return { out: out.join("\n"), err: err.join("\n"), exitCode };
}

describe("Slice 15 — CLI contract honesty", () => {
  beforeEach(() => { process.exitCode = undefined; });

  describe("finding 1 — shared --json error path", () => {
    it("under --json, a validation failure emits a parseable JSON error object + nonzero exit", async () => {
      const { deps } = makeQueueDeps();
      const { out, exitCode } = await runCli(["queue", "list", "--limit", "-1", "--json"], { queueDeps: deps });
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(out); // MUST be parseable
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("commander.invalidArgument");
      expect(parsed.error.message).toMatch(/正整数/);
    });

    it("without --json, the same failure is plain text on stderr (no JSON on stdout) + nonzero exit", async () => {
      const { deps } = makeQueueDeps();
      const { out, err, exitCode } = await runCli(["queue", "list", "--limit", "-1"], { queueDeps: deps });
      expect(exitCode).toBe(1);
      expect(out).toBe(""); // nothing parseable-but-wrong on stdout
      expect(err).toMatch(/正整数/);
    });

    it("the path is SHARED across families — a send-family error also emits JSON under --json", async () => {
      const { out, exitCode } = await runCli(["send", "--json", "--no-such-flag"]);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(out);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("commander.unknownOption");
    });

    it("--help passes through cleanly (exit 0, no error object)", async () => {
      const { exitCode } = await runCli(["--help"]);
      expect(exitCode).toBe(0);
    });
  });

  describe("finding 3 — unknown -o rejected (queue list)", () => {
    it("`-o yaml` errors with nonzero exit (not silent JSON)", async () => {
      const { deps } = makeQueueDeps();
      const { err, exitCode } = await runCli(["queue", "list", "-o", "yaml"], { queueDeps: deps });
      expect(exitCode).toBe(1);
      expect(err).toMatch(/one of.*json|必须.*json/);
    });
    it("`-o json` is accepted (exit 0)", async () => {
      const { deps } = makeQueueDeps();
      const { exitCode } = await runCli(["queue", "list", "-o", "json"], { queueDeps: deps });
      expect(exitCode).toBe(0);
    });
  });

  describe("finding 4 — invalid --limit rejected (queue list)", () => {
    it.each(["-1", "0", "abc"])("`--limit %s` errors + nonzero exit", async (bad) => {
      const { deps } = makeQueueDeps();
      const { err, exitCode } = await runCli(["queue", "list", "--limit", bad], { queueDeps: deps });
      expect(exitCode).toBe(1);
      expect(err).toMatch(/正整数/);
    });
    it("`--limit 25` accepted (exit 0)", async () => {
      const { deps } = makeQueueDeps();
      const { exitCode } = await runCli(["queue", "list", "--limit", "25"], { queueDeps: deps });
      expect(exitCode).toBe(0);
    });
  });

  describe("finding 2 — queue overdue scoped + bounded + body-free by default", () => {
    it("default: rig-scoped (current rig) + compact=1 + a default limit", async () => {
      vi.stubEnv("OPENRIG_SESSION_NAME", "dev@my-rig");
      const { deps, calls } = makeQueueDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "overdue", "--json"]);
      const call = calls.find((c) => c.path.startsWith("/api/queue/overdue"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("rig=my-rig");
      expect(call!.path).toContain("compact=1");
      expect(call!.path).toMatch(/limit=\d+/);
      vi.unstubAllEnvs();
    });
    it("--full drops compact; -A drops the rig scope", async () => {
      vi.stubEnv("OPENRIG_SESSION_NAME", "dev@my-rig");
      const { deps, calls } = makeQueueDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "overdue", "-A", "--full"]);
      const call = calls.find((c) => c.path.startsWith("/api/queue/overdue"));
      expect(call!.path).not.toContain("compact=1");
      expect(call!.path).not.toContain("rig=");
      vi.unstubAllEnvs();
    });
    it("--limit is validated on overdue too", async () => {
      const { deps } = makeQueueDeps();
      const { exitCode, err } = await runCli(["queue", "overdue", "--limit", "-3"], { queueDeps: deps });
      expect(exitCode).toBe(1);
      expect(err).toMatch(/正整数/);
    });
  });

  // 0.5.1-54 DR-1 — `queue undelivered` mirrors `overdue` (rig-scoped, bounded, body-free by default).
  describe("DR-1 — queue undelivered scoped + bounded + body-free by default", () => {
    it("default: rig-scoped (current rig) + compact=1 + a default limit, hits /api/queue/undelivered", async () => {
      vi.stubEnv("OPENRIG_SESSION_NAME", "dev@my-rig");
      const { deps, calls } = makeQueueDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "undelivered", "--json"]);
      const call = calls.find((c) => c.path.startsWith("/api/queue/undelivered"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("rig=my-rig");
      expect(call!.path).toContain("compact=1");
      expect(call!.path).toMatch(/limit=\d+/);
      vi.unstubAllEnvs();
    });
    it("--full drops compact; -A drops the rig scope", async () => {
      vi.stubEnv("OPENRIG_SESSION_NAME", "dev@my-rig");
      const { deps, calls } = makeQueueDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "undelivered", "-A", "--full"]);
      const call = calls.find((c) => c.path.startsWith("/api/queue/undelivered"));
      expect(call!.path).not.toContain("compact=1");
      expect(call!.path).not.toContain("rig=");
      vi.unstubAllEnvs();
    });
  });

  describe("finding 5 — ps --active honest at rig tier", () => {
    it("bare `ps --active` (no --nodes) fails loudly with nonzero exit — not a silent no-op", async () => {
      const errs: string[] = [];
      vi.spyOn(console, "error").mockImplementation((...a) => { errs.push(a.join(" ")); });
      process.exitCode = undefined;
      const program = createProgram();
      program.exitOverride();
      try { await program.parseAsync(["node", "rig", "ps", "--active"]); } catch { /* commander throw */ }
      expect(process.exitCode).toBe(1);
      expect(errs.join("\n")).toMatch(/--nodes/);
      expect(errs.join("\n")).toMatch(/节点层/i);
      vi.restoreAllMocks();
    });
  });
});
