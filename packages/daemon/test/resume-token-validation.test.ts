// OPR.0.4.0.22 FR-2——per-runtime resume-token 校验。执行 format validation（底线）、
// 拒绝格式错误项、绝不伪造，且绝不在 error message 中回显 raw token（credential-class 脱敏）。

import { describe, it, expect } from "vitest";
import { validateResumeToken, resumeTypeForRuntime } from "../src/domain/resume-token-validation.js";

describe("resumeTypeForRuntime", () => {
  it("将 runtime 映射到各自的 resume-id type", () => {
    expect(resumeTypeForRuntime("claude-code")).toBe("claude_id");
    expect(resumeTypeForRuntime("codex")).toBe("codex_id");
    expect(resumeTypeForRuntime("pi")).toBe("pi_session_file");
    expect(resumeTypeForRuntime("terminal")).toBeNull();
    expect(resumeTypeForRuntime(null)).toBeNull();
  });
});

describe("validateResumeToken", () => {
  it("接受格式正确的 Claude token 并返回 claude_id", () => {
    const r = validateResumeToken("claude-code", "abc-123-def-456");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resumeType).toBe("claude_id");
      expect(r.token).toBe("abc-123-def-456");
    }
  });

  it("接受格式正确的 Codex token 并返回 codex_id", () => {
    const r = validateResumeToken("codex", "0199abcd_thread.id");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resumeType).toBe("codex_id");
  });

  it("校验/持久化前裁剪两端空白", () => {
    const r = validateResumeToken("claude-code", "  tok-123  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe("tok-123");
  });

  it("拒绝不支持的 runtime，且不伪造结果", () => {
    const r = validateResumeToken("terminal", "anything");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/不支持/i);
  });

  it("拒绝空 token", () => {
    const r = validateResumeToken("claude-code", "   ");
    expect(r.ok).toBe(false);
  });

  it("拒绝含禁用字符的 token，且不回显 token（脱敏）", () => {
    const secret = "tok with spaces; rm -rf /";
    const r = validateResumeToken("claude-code", secret);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(secret);
      expect(r.error).not.toContain("rm -rf");
      expect(r.error).toMatch(/不允许的字符/i);
    }
  });

  it("拒绝非 string token", () => {
    const r = validateResumeToken("claude-code", undefined);
    expect(r.ok).toBe(false);
  });

  it("拒绝过长 token，且不回显它", () => {
    const huge = "a".repeat(5000);
    const r = validateResumeToken("codex", huge);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(huge);
      expect(r.error).toMatch(/过长/i);
    }
  });
});

// OPR.0.4.6.PI1 FR-6——per-resume-type 校验。Pi resume token 是 path（session file），
// 因此使用独立底线：absolute、无 ".." segment、shell-inert path charset、1024 上限、
// ".jsonl" suffix。claude/codex id-shape rule 在修改前后逐字节一致（上方 id-rule 测试
// 必须继续原样通过）。
describe("validateResumeToken——pi_session_file（path-shaped、per-type）", () => {
  const validPath = "/Users/someone/.openrig/state/pi/seat-a/sessions/2026-07-06T10-00-00_0197a2f0-1234-7abc-8def-0123456789ab.jsonl";

  it("接受有效 absolute .jsonl session-file path，并返回 pi_session_file", () => {
    const r = validateResumeToken("pi", validPath);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resumeType).toBe("pi_session_file");
      expect(r.token).toBe(validPath);
    }
  });

  it("接受 path 中的 '@'——Pi seat state directory 以 canonical session name（pod-member@rig）为 key", () => {
    // VM 发现的回归：原始 PRD charset 会拒绝每个真实 Pi seat session file，因为 layout
    // 嵌入了 canonical name。
    const seatPath = "/openrig-home/state/pi/devpi-driver1@openrig-delivery/sessions/2026-07-07T00-00-00_0197.jsonl";
    const r = validateResumeToken("pi", seatPath);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe(seatPath);
  });

  it("校验/持久化前裁剪两端空白", () => {
    const r = validateResumeToken("pi", `  ${validPath}  `);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe(validPath);
  });

  it("拒绝 relative path", () => {
    const r = validateResumeToken("pi", "sessions/2026_abc.jsonl");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/绝对路径/i);
  });

  it("拒绝 '..' path segment（raw-operand traversal posture），且不回显 token", () => {
    const sneaky = "/seat/../../../etc/creds_0197.jsonl";
    const r = validateResumeToken("pi", sneaky);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(sneaky);
      expect(r.error).toMatch(/'\.\.' 路径段/);
    }
  });

  it("不拒绝 filename 内出现的 '..'（仅拒绝完整 segment）", () => {
    const dots = "/seat/sessions/2026..07.._abc.jsonl";
    const r = validateResumeToken("pi", dots);
    expect(r.ok).toBe(true);
  });

  it("拒绝超过 1024 字符的 path，且不回显它", () => {
    const huge = "/" + "a".repeat(1100) + ".jsonl";
    const r = validateResumeToken("pi", huge);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(huge);
      expect(r.error).toMatch(/过长/i);
    }
  });

  it("接受较长但未超上限的 path（id-shape 200 上限不适用于 pi）", () => {
    const long = "/" + "a".repeat(400) + "/sessions/x_y.jsonl"; // > 200 chars, < 1024
    expect(long.length).toBeGreaterThan(200);
    const r = validateResumeToken("pi", long);
    expect(r.ok).toBe(true);
  });

  it("拒绝禁用字符（空格、shell metacharacter），且不回显", () => {
    const secret = "/seat/sessions/x y; rm -rf.jsonl";
    const r = validateResumeToken("pi", secret);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(secret);
      expect(r.error).not.toContain("rm -rf");
      expect(r.error).toMatch(/不允许的字符/i);
    }
  });

  it("拒绝没有 .jsonl suffix 的 path", () => {
    const r = validateResumeToken("pi", "/seat/sessions/0197-abc.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/\.jsonl/);
  });

  it("保持 per-type 分离：claude/codex 仍拒绝 path-shaped token", () => {
    expect(validateResumeToken("claude-code", validPath).ok).toBe(false);
    expect(validateResumeToken("codex", validPath).ok).toBe(false);
  });
});
