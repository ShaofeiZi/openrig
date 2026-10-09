// OPR.0.4.6.PI1 FR-6——共享 resume-token 派生辅助函数的 Pi 分支。
//
// 本测试固定 guard-fold 回归：PI-1 之前，Pi runtime 在派生辅助函数的防御性 no-op 处终止；
// 即使派生出 token，统一 id 形状 validator 也会拒绝所有路径形 token。因此 capture 路径会软失败
//（skip），Pi 席位虽可正常运行，却永不持久化 resume 状态。测试断言该路径现在会 capture 有效 Pi
// session 文件路径而非跳过，并且校验失败仍诚实 skip，不虚构 token。

import { describe, it, expect } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";

const SESSION = "devpi-seat@some-rig";
const VALID_FILE = "/Users/someone/.openrig/state/pi/seat-a/sessions/2026-07-06T10-00-00_0197a2f0.jsonl";

function piStore(result: { ok: true; sessionFile: string } | { ok: false; reason: string }) {
  return {
    readSessionFile: (sessionName: string) => {
      expect(sessionName).toBe(SESSION);
      return result;
    },
  };
}

describe("deriveResumeToken — pi", () => {
  it("capture 有效绝对 .jsonl session 文件路径，而非跳过", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: true, sessionFile: VALID_FILE }) },
    );
    expect(r.outcome).toBe("captured");
    if (r.outcome === "captured") {
      expect(r.resumeType).toBe("pi_session_file");
      expect(r.token).toBe(VALID_FILE);
    }
  });

  it("校验前移除 sidecar 值首尾空白", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: true, sessionFile: `  ${VALID_FILE}\n` }) },
    );
    expect(r.outcome).toBe("captured");
    if (r.outcome === "captured") expect(r.token).toBe(VALID_FILE);
  });

  it("pi runner-state 依赖缺失时静默 no-op（旧接线/测试）", async () => {
    const r = await deriveResumeToken({ runtime: "pi", sessionName: SESSION }, {});
    expect(r.outcome).toBe("noop");
  });

  it("runner-state sidecar 缺失时诚实跳过", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: false, reason: "missing_sidecar" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
  });

  it("把 sidecar 解析失败映射为 parse_error 跳过原因", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: false, reason: "parse_error" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "parse_error" });
  });

  it("跳过且绝不持久化格式错误的 session 文件值——相对路径", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: true, sessionFile: "sessions/relative.jsonl" }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });

  it("把空 sidecar 值按缺失跳过，绝不把空值校验成可写内容", async () => {
    const r = await deriveResumeToken(
      { runtime: "pi", sessionName: SESSION },
      { piRunnerStateStore: piStore({ ok: true, sessionFile: "   " }) },
    );
    expect(r).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
  });
});
