import { describe, it, expect } from "vitest";
import { buildTriageModel, renderTriage, type TriageCheckInput } from "../src/crash-cart/triage.js";

// Crash-cart C3 C4——run 后聚合 triage 列表（plan c015d9ed §C4）。一个可键盘走查的
// 列表，绝非每席一个阻塞提示：每行 = 一个席 + 它确切所需（失败
// restore-check 的 remediation）。GREEN 席省略（无需）；红先黄后。C4 无
// mock（文本列表）。conductor 聚合（C1 attention_required/resume_failed）+ resolve→resume
// 交接 + live restore-check fetch 是缝（C1 本波排除）；这是 model+render。

const seat = (seat: string, entries: TriageCheckInput["entries"]): TriageCheckInput => ({ seat, entries });

describe("buildTriageModel——拍平每席失败检查；绿省略", () => {
  it("只保留黄/红检查，每个(席,失败检查)一行，红排在黄前", () => {
    const rows = buildTriageModel([
      seat("dev-driver@r", [
        { check: "resume.token", status: "green", evidence: "ok", remediation: "" },
        { check: "claude.picker", status: "red", evidence: "no session token", remediation: "run claude --resume and pick a session", remediationSafe: false },
      ]),
      seat("dev-qa@r", [{ check: "codex.auth", status: "yellow", evidence: "auth stale", remediation: "re-auth codex", remediationSafe: true }]),
    ]);
    expect(rows.map((r) => `${r.seat}:${r.check}:${r.status}`)).toEqual([
      "dev-driver@r:claude.picker:red",
      "dev-qa@r:codex.auth:yellow",
    ]);
    expect(rows[0]!.need).toBe("run claude --resume and pick a session");
    expect(rows[0]!.remediationSafe).toBe(false);
  });

  it("所有席位皆绿（全部干净恢复）时返回 []", () => {
    expect(buildTriageModel([seat("a@r", [{ check: "x", status: "green", evidence: "ok", remediation: "" }])])).toEqual([]);
  });
});

describe("renderTriage——可键盘遍历列表（或全干净行）", () => {
  it("渲染头 + 每条需要一行（席 + 修复），检查项暗显", () => {
    const body = renderTriage(
      buildTriageModel([seat("dev-driver@r", [{ check: "claude.picker", status: "red", evidence: "no token", remediation: "run claude --resume", remediationSafe: false }])]),
    )
      .map((l) => l.text)
      .join("\n");
    expect(body).toContain("待关注 (1)");
    expect(body).toContain("dev-driver@r");
    expect(body).toContain("run claude --resume");
    expect(body).toContain("claude.picker");
  });

  it("无可分诊项时渲染全干净行", () => {
    const body = renderTriage([]).map((l) => l.text).join("\n");
    expect(body).toContain("所有席位已干净恢复");
    expect(body).not.toContain("待关注");
  });
});
