import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { daemonCommand } from "../src/commands/daemon.js";
import { STATE_FILE, getDaemonStatus, type LifecycleDeps } from "../src/daemon-lifecycle.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });
function fixture(opts: { survives?: boolean; unknownProbe?: boolean; receipt?: string | null; exited?: boolean; noState?: boolean } = {}) {
  let killed = opts.exited === true;
  let removed = opts.noState === true;
  const state = { pid: 987, host: "127.0.0.1", port: 17433, db: "private.db", startedAt: "2026-01-01T00:00:00Z" };
  const deps = {
    exists: (p: string) => p === STATE_FILE && !removed,
    readFile: (p: string) => p === STATE_FILE ? (removed ? null : JSON.stringify(state))
      : p === path.join(path.dirname(STATE_FILE), "daemon-shutdown.json") ? opts.receipt !== undefined ? opts.receipt : JSON.stringify({
        schema: "openrig.daemon-shutdown/v1", pid: 987, startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(), outcome: "clean", phase: "complete", failures: [],
      }) : null,
    removeFile: () => { removed = true; },
    isProcessAlive: () => !killed || opts.survives === true,
    kill: vi.fn(() => { killed = true; return true; }),
    fetch: vi.fn(async (url: string) => {
      if (!url.includes(":17433/")) return { ok: true }; // unrelated default listener
      if (!killed) return { ok: true };
      if (opts.unknownProbe) throw new Error("probe unavailable");
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }),
  } as unknown as LifecycleDeps;
  return deps;
}
async function stop(deps: LifecycleDeps) {
  process.exitCode = undefined;
  const out = vi.spyOn(console, "log").mockImplementation(() => {}).mockClear();
  const err = vi.spyOn(console, "error").mockImplementation(() => {}).mockClear();
  const p = new Command().addCommand(daemonCommand(deps)).parseAsync(["node", "rig", "daemon", "stop"]);
  await vi.runAllTimersAsync(); await p;
  return { out: out.mock.calls.flat().join(" "), err: err.mock.calls.flat().join(" "), code: process.exitCode };
}
it("verifies the captured target after state removal, without probing the default listener", async () => {
  vi.useFakeTimers(); const deps = fixture(); const result = await stop(deps);
  expect(result.err).toBe(""); expect(result.code).not.toBe(1);
  expect(result.out).toContain("后台服务已停止");
  expect(vi.mocked(deps.fetch).mock.calls.every(([url]) => url === "http://127.0.0.1:17433/healthz")).toBe(true);
});
it("reports a surviving PID and refused listener separately", async () => {
  vi.useFakeTimers(); const result = await stop(fixture({ survives: true }));
  expect(result.code).toBe(1); expect(result.err).toMatch(/PID.*存在/);
  expect(result.err).toMatch(/监听者 refused/); expect(result.err).not.toMatch(/仍在监听/);
});
it("an unavailable final probe cannot certify shutdown", async () => {
  vi.useFakeTimers(); const result = await stop(fixture({ unknownProbe: true }));
  expect(result.code).toBe(1); expect(result.err).toMatch(/未获核实|unavailable/);
  expect(result.out).not.toContain("后台服务已停止");
});
it.each(["failed", "timed-out"])("a %s drain is not success even after process and listener exit", async (outcome) => {
  vi.useFakeTimers(); const now = new Date().toISOString();
  const result = await stop(fixture({ receipt: JSON.stringify({ schema: "openrig.daemon-shutdown/v1", pid: 987,
    startedAt: now, completedAt: now, outcome, phase: "watchdog", failures: [{ phase: "watchdog", error: "incomplete" }] }) }));
  expect(result.code).toBe(1); expect(result.err).toContain(outcome); expect(result.err).toContain("phase=watchdog");
});
it.each([null, { pid: 123 }, { pid: 987, startedAt: "2020-01-01T00:00:00Z" }])("rejects absent, mismatched or stale completion evidence: %s", async (override) => {
  vi.useFakeTimers(); const now = new Date().toISOString();
  const receipt = override === null ? null : { schema: "openrig.daemon-shutdown/v1", pid: 987,
    startedAt: now, completedAt: now, outcome: "clean", phase: "complete", failures: [], ...override };
  const result = await stop(fixture({ receipt: JSON.stringify(receipt) }));
  expect(result.code).toBe(1); expect(result.err).toMatch(/未获核实.*关闭回执/);
});

it.each(["failed", "timed-out"])("retains an already-exited %s outcome and identity on repeated stop", async outcome => {
  vi.useFakeTimers(); const now = new Date().toISOString();
  const deps = fixture({ exited: true, receipt: JSON.stringify({ schema: "openrig.daemon-shutdown/v1", pid: 987,
    startedAt: now, completedAt: now, outcome, phase: "health-diagnosis", failures: [{ phase: "health-diagnosis", error: "incomplete" }] }) });
  for (let i = 0; i < 2; i++) {
    const result = await stop(deps);
    expect(result.code).toBe(1); expect(result.err).toContain(outcome);
    expect(result.err).toContain("phase=health-diagnosis"); expect(deps.exists(STATE_FILE)).toBe(true);
  }
  expect(deps.kill).not.toHaveBeenCalled();
});
it("a missing receipt stays unverified across status and retry without another signal", async () => {
  vi.useFakeTimers(); const deps = fixture({ receipt: null });
  const first = await stop(deps); expect(first.code).toBe(1);
  expect(deps.exists(STATE_FILE)).toBe(true);
  expect((await getDaemonStatus(deps)).state).toBe("stale");
  expect(deps.exists(STATE_FILE)).toBe(true);
  const retry = await stop(deps); expect(retry.code).toBe(1); expect(retry.err).toMatch(/未获核实|无法核实/);
  expect(deps.kill).toHaveBeenCalledTimes(1);
});
it("clean completion permits a truthful no-target repeat", async () => {
  vi.useFakeTimers(); vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:17433");
  const deps = fixture(); const first = await stop(deps);
  expect(first.code).not.toBe(1); expect(first.out).toContain("后台服务已停止");
  expect(deps.exists(STATE_FILE)).toBe(false);
  const again = await stop(deps); expect(again.code).not.toBe(1);
  expect(again.out).toContain("未记录后台服务目标"); expect(again.out).not.toContain("后台服务已停止");
  expect(deps.kill).toHaveBeenCalledTimes(1);
});
it("no recorded target or receipt is a useful no-op, not clean-drain certification", async () => {
  vi.useFakeTimers(); vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:17433");
  const deps = fixture({ noState: true, exited: true, receipt: null });
  const result = await stop(deps);
  expect(result.code).not.toBe(1); expect(result.out).toContain("未记录后台服务目标");
  expect(result.out).toContain("此前排空未认证"); expect(deps.kill).not.toHaveBeenCalled();
});
it.each(["malformed", JSON.stringify({ outcome: "failed", pid: 123 })])("no-state does not silently discard unbound incomplete evidence: %s", async receipt => {
  vi.useFakeTimers(); vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:17433");
  const deps = fixture({ noState: true, exited: true, receipt }); const result = await stop(deps);
  expect(result.code).toBe(1); expect(result.err).toContain("无法核实");
  expect(result.err).toContain("无法把它归因到"); expect(deps.kill).not.toHaveBeenCalled();
});
it.each([{pid: 123}, {startedAt: "2020-01-01T00:00:00Z"}])("an exited target cannot borrow unrelated clean evidence: %s", async override => {
  vi.useFakeTimers(); const now = new Date().toISOString();
  const deps = fixture({ exited: true, receipt: JSON.stringify({ schema: "openrig.daemon-shutdown/v1", pid: 987,
    startedAt: now, completedAt: now, outcome: "clean", phase: "complete", failures: [], ...override }) });
  const result = await stop(deps); expect(result.code).toBe(1); expect(result.err).toContain("未获核实");
  expect(deps.exists(STATE_FILE)).toBe(true); expect(deps.kill).not.toHaveBeenCalled();
});
it("status may clean an exited target only with its matching clean receipt", async () => {
  vi.useFakeTimers(); const deps = fixture({ exited: true });
  expect((await getDaemonStatus(deps)).state).toBe("stale"); expect(deps.exists(STATE_FILE)).toBe(false);
});

it.each(["stop", "status"])("%s cannot remove a concurrently rebound state file", async operation => {
  vi.useFakeTimers(); const deps = fixture({ exited: true }); const read = deps.readFile; let stateReads = 0;
  deps.readFile = p => {
    const raw = read(p);
    return p === STATE_FILE && raw && stateReads++ > 0 ? JSON.stringify({ ...JSON.parse(raw), db: "replacement.db" }) : raw;
  };
  if (operation === "stop") expect((await stop(deps)).code).not.toBe(1);
  else expect((await getDaemonStatus(deps)).state).toBe("stale");
  expect(deps.exists(STATE_FILE)).toBe(true);
});

it("an unreadable target file is not a never-recorded no-target control", async () => {
  vi.useFakeTimers(); vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:17433");
  const deps = fixture({ exited: true, receipt: null }); const read = deps.readFile;
  deps.readFile = p => p === STATE_FILE ? "{malformed" : read(p);
  const result = await stop(deps);
  expect(result.code).toBe(1); expect(result.err).toContain("无法核实");
  expect(result.out).not.toContain("未记录后台服务目标"); expect(deps.kill).not.toHaveBeenCalled();
});
