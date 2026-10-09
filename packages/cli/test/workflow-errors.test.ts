import { describe, it, expect, vi, afterEach } from "vitest";
import { describeDaemonRejection, formatThreePart } from "../src/commands/workflow-errors.js";
import type { WorkflowDeps } from "../src/commands/workflow.js";
import { createProgram } from "../src/index.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

/**
 * OPR.0.4.6.WF3 FR-5——error-UX pin（commit 4）。每个具名 daemon
 * 拒绝在人类模式渲染三段 what/why/fix 与正确修复指针；--json 保持原始 body
 * 逐字节一致；退出码不变。
 */

describe("describeDaemonRejection (WF3 FR-5)", () => {
  it("packet_not_on_frontier → explains the moved frontier, points at trace", () => {
    const rej = describeDaemonRejection({ error: "packet_not_on_frontier", instanceId: "WF1" });
    expect(rej?.fact).toContain("该数据包不在实例前沿上");
    expect(rej?.consequence).toContain("前沿已经越过它");
    expect(rej?.action).toContain("zrig workflow trace WF1");
  });

  it("instance_not_active → names the actual state; fix pointer names ONLY shipped verbs (BR-1 — flipped at WF-5: resume is real now)", () => {
    const rej = describeDaemonRejection({ error: "instance_not_active", message: "failed", instanceId: "WF1" });
    expect(rej?.fact).toContain("failed");
    expect(rej?.action).toContain("zrig workflow show WF1");
    // OPR.0.4.6.WF5 FR-4：WF-3 时代的负向断言无 resume
    // 指针，因为该动词尚未发布（BR-1：绝不指向不存在的
    // 动词）。WF-5 发布了它，指针
    // upgraded exactly as the WF-3 comment promised — same BR-1
    // principle, inverted assertion.
    expect(rej?.action).toContain("zrig workflow resume");
  });

  it("instance_version_conflict → names expected/actual, says whole-rollback, fix = re-read + retry", () => {
    const rej = describeDaemonRejection({ error: "instance_version_conflict", expectedVersion: 4, actualVersion: 5 });
    expect(rej?.fact).toContain("期望版本 4");
    expect(rej?.fact).toContain("实际 5");
    expect(rej?.consequence).toContain("整体回滚");
    expect(rej?.action).toContain("重试");
  });

  it("exit_not_allowed → lists allowed exits when the body carries them", () => {
    const rej = describeDaemonRejection({ error: "exit_not_allowed", allowedExits: ["handoff", "failed"] });
    expect(rej?.action).toBe("可选其一：handoff | failed。");
  });

  it("no_next_step / next_owner_unresolved / instance_not_found all render with fixes", () => {
    expect(describeDaemonRejection({ error: "no_next_step" })?.action).toContain("--exit done | failed");
    expect(describeDaemonRejection({ error: "next_owner_unresolved" })?.action).toContain("--next-owner");
    expect(describeDaemonRejection({ error: "instance_not_found" })?.action).toContain("zrig workflow list");
  });

  it("unrecognized bodies return null (raw-JSON fallback preserved)", () => {
    expect(describeDaemonRejection({ error: "something_new" })).toBeNull();
    expect(describeDaemonRejection({ message: "no error code" })).toBeNull();
    expect(describeDaemonRejection("string body")).toBeNull();
    expect(describeDaemonRejection(null)).toBeNull();
  });

  it("formatThreePart renders the emit3PartError shape", () => {
    const lines = formatThreePart({ fact: "f", consequence: "c", action: "a" });
    expect(lines).toEqual(["错误：f", "c", "a"]);
  });
});

describe("wire-level FR-5 behavior", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeDeps(routes: Record<string, { status: number; data: unknown }>): WorkflowDeps {
    return {
      lifecycleDeps: {} as WorkflowDeps["lifecycleDeps"],
      clientFactory: () =>
        ({
          get: async (path: string) => routes[`GET ${path}`] ?? { status: 200, data: {} },
          post: async (path: string, _body: unknown) => routes[`POST ${path}`] ?? { status: 200, data: {} },
        }) as never,
    };
  }

  const CONFLICT = {
    status: 409,
    data: { error: "instance_version_conflict", message: "conflict", expectedVersion: 1, actualVersion: 2 },
  };

  it("human mode: named 409 renders 3-part on stderr, exit code stays 1", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "POST /api/workflow/project": CONFLICT }),
    });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync([
      "node", "rig", "workflow", "project",
      "--instance", "WF1", "--current-packet", "Q1", "--exit", "handoff", "--actor-session", "a@r",
    ]);
    const stderrText = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("有并发写入方先推进了该实例");
    // The raw JSON blob is NOT dumped in human mode for a named rejection.
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("")).not.toContain("instance_version_conflict");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("--json: the raw daemon error body passes through byte-identically", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({ "POST /api/workflow/project": CONFLICT }),
    });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync([
      "node", "rig", "workflow", "project",
      "--instance", "WF1", "--current-packet", "Q1", "--exit", "handoff", "--actor-session", "a@r", "--json",
    ]);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(CONFLICT.data));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("human mode: unrecognized 500 keeps the raw-JSON fallback and exit 2", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram({
      workflowDeps: makeDeps({
        "GET /api/workflow/WF1": { status: 500, data: { error: "internal_error", message: "boom" } },
      }),
    });
    program.exitOverride();
    process.exitCode = undefined;
    await program.parseAsync(["node", "rig", "workflow", "show", "WF1"]);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("internal_error");
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });
});
