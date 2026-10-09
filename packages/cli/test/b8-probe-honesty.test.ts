// B8 PROBE-HONESTY（shape 73ee4b25，floor-A 裁定）——CLI 如实说明它
// 知道什么 vs 推断什么。对当前 main 先 RED。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { statusGuardMessage, daemonStatusGuard } from "../src/daemon-lifecycle.js";
import type { DaemonStatus } from "../src/daemon-lifecycle.js";

describe("B8-1b — epistemic-matched precheck language (the ONE helper)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); process.exitCode = undefined; });
  afterEach(() => { errSpy.mockRestore(); process.exitCode = undefined; });

  it("UNVERIFIED renders may-be-busy-or-stopped — NEVER 'not running' (down ≠ busy)", () => {
    const ok = daemonStatusGuard({ state: "unverified" } as DaemonStatus);
    expect(ok).toBe(false);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/未响应|繁忙或已停止/);
    expect(out).not.toMatch(/未运行/);
    expect(process.exitCode).toBe(1);
  });

  it("STOPPED renders the not-running 3-part (positive evidence keeps the plain truth)", () => {
    const ok = daemonStatusGuard({ state: "stopped" } as DaemonStatus);
    expect(ok).toBe(false);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/未运行/);
  });

  it("RUNNING+healthy passes silently; RUNNING+unhealthy renders unhealthy — not 'not running'", () => {
    expect(daemonStatusGuard({ state: "running", healthy: true } as DaemonStatus)).toBe(true);
    expect(errSpy.mock.calls.length).toBe(0);
    expect(daemonStatusGuard({ state: "running", healthy: false } as DaemonStatus)).toBe(false);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/未响应|未经确认/);
    expect(out).not.toMatch(/未运行/);
  });

  it("sibling hint renders when present (the wrong-home teaching line rides the guard)", () => {
    daemonStatusGuard({ state: "unverified", siblingHint: { resolvedHome: "/a/.openrig", siblingHome: "/a/.openrig-vm" } } as DaemonStatus);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("/a/.openrig-vm");
  });

  it("statusGuardMessage is pure (language derives from the epistemic state)", () => {
    expect(statusGuardMessage({ state: "unverified" } as DaemonStatus).fact).toMatch(/未响应/);
    expect(statusGuardMessage({ state: "stopped" } as DaemonStatus).fact).toMatch(/未运行/);
  });
});

describe("B8-1b — chokepoint adoption census (the grep-guard pin)", () => {
  it("ZERO literal 'Daemon not running' renders outside daemon-lifecycle.ts (55-site class killed)", async () => {
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "../src");
    let out = "";
    try {
      // RENDER forms only: console prints, thrown Errors, and structured facts. The
      // detection regex（cross-host-executor）、help-text 退出码文档与注释
      // 合法地携带该短语，且非渲染位点。
      out = execFileSync("grep", ["-rnE", "(console\\.(error|log)\\(|new Error\\(|fact:)[^\\n]*\"Daemon not running", root, "--include=*.ts"], { encoding: "utf-8" });
    } catch { out = ""; } // grep exit 1 = no matches
    const offenders = out.split("\n").filter((l) => l && !l.includes("daemon-lifecycle.ts"));
    expect(offenders).toEqual([]); // every precheck RENDER routes through the ONE helper
  });
});

// ── B8-2：send 超时 = 投递 UNCONFIRMED，绝不 "not sent" ─────────────────
import { printTransportFailureForTest } from "../src/commands/send.js";
import { DaemonTimeoutError, DaemonConnectionError } from "../src/client.js";

describe("B8-2 — send transport honesty (indeterminate ≠ failed)", () => {
  let errSpy2: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy2 = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => errSpy2.mockRestore());

  it("a TIMEOUT renders delivery-unconfirmed + reconcile-by-effect — NEVER 'was not sent'", () => {
    printTransportFailureForTest(new DaemonTimeoutError("Request to /api/transport/send timed out after 5000ms"));
    const out = errSpy2.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/交付未确认|可能已收到/);
    expect(out).toMatch(/检查 (pane|target)|对账/);
    expect(out).not.toMatch(/was not sent/i);
  });

  it("a connection REFUSAL keeps the hard 'not sent' truth", () => {
    printTransportFailureForTest(new DaemonConnectionError("fetch failed: ECONNREFUSED"));
    const out = errSpy2.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/消息未发送/);
  });
});
