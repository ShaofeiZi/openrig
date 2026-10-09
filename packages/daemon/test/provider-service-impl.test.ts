// Slice-04（OPR.0.5.0.4）C1——生产 ProviderService 接线固定项：通过注入依赖调用 getReadModel；
// 按 BR-3，precheck 遇到未知认证时失败关闭；switch 绝不虚构成功。
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";

const ASOF = "2026-08-04T00:00:00.000Z";

function emptyCodexHomeEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-impl-codex-"));
  return { CODEX_HOME: home } as NodeJS.ProcessEnv;
}

function makeSvc() {
  return new ProviderServiceImpl({
    db: createFullTestDb(),
    listRigs: () => [], // no rigs → no seats; getReadModel never touches getNodeInventory
    env: emptyCodexHomeEnv(),
    now: () => ASOF,
  });
}

describe("ProviderServiceImpl——生产 getReadModel/precheck/switch 接线", () => {
  it("空 codex home 且无工作组时，getReadModel 返回格式正确的空 four-block", async () => {
    const model = await makeSvc().getReadModel();
    // S-A 修订（OPR.0.5.0.4 A2，README 21a5cb73）：读取模型以增量方式携带主机级 usage rollup；
    // 此处为空，因为没有 provider，因而诚实地没有行。
    expect(model).toEqual({ accounts: [], bindings: [], signals: [], hostUsage: [], asOf: ASOF });
  });

  it("未知/缺失目标的 precheck 失败关闭（target_auth_unknown），绝不标为安全", async () => {
    const r = await makeSvc().precheck({ seat: "dev-driver@rig", toAccount: "no-such-account" });
    expect(r.safe).toBe(false);
    if (r.safe === false) expect(r.reasons).toContain("target_auth_unknown");
  });

  it("switchAccount 经 precheck 门禁得到 failed_safely，绝不虚构 succeeded", async () => {
    const r = await makeSvc().switchAccount({ seat: "dev-driver@rig", toAccount: "no-such-account", forceUnsafe: false });
    expect(r.outcome).toBe("failed_safely");
    if (r.outcome === "failed_safely") expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("forceUnsafe 下 switchAccount 仍不能成功：switch-exec D 接缝未接线，如实返回 failed_safely", async () => {
    const r = await makeSvc().switchAccount({ seat: "dev-driver@rig", toAccount: "no-such-account", forceUnsafe: true });
    expect(r.outcome).toBe("failed_safely");
    if (r.outcome === "failed_safely") expect(r.reasons).toContain("switch_execution_not_yet_wired");
  });

  it("getReadModel 呈现 collectClaudeSignals 依赖提供的 Claude statusline 信号（C3 接线）", async () => {
    const sig = { provider: "claude" as const, accountRef: "sub", sourceClass: "unknown" as const, authority: "unknown" as const, asOf: ASOF, unknownReason: "claude_no_statusline_cache_yet", automationUse: "do_not_automate" as const };
    const svc = new ProviderServiceImpl({ db: createFullTestDb(), listRigs: () => [], env: emptyCodexHomeEnv(), now: () => ASOF, collectClaudeSignals: () => [sig] });
    const model = await svc.getReadModel();
    expect(model.signals).toEqual([sig]);
  });
});
