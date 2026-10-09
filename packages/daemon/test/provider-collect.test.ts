// Slice-04（OPR.0.5.0.4）C1 恢复——getReadModel 收集接缝固定。
import { describe, it, expect } from "vitest";
import { collectFourBlockReadModel, type ProviderCollectDeps } from "../src/domain/provider/provider-collect.js";
import type { CodexAuthMetadata } from "../src/domain/provider/codex-auth-reader.js";

const ASOF = "2026-08-04T00:00:00.000Z";

function deps(over: Partial<ProviderCollectDeps> & { auth?: CodexAuthMetadata }): ProviderCollectDeps {
  return {
    readCodexAuth: () => over.auth ?? { profiles: [], seats: [] },
    listSeats: over.listSeats ?? (() => []),
    collectSignals: over.collectSignals,
    now: over.now ?? (() => ASOF),
  };
}

describe("collectFourBlockReadModel——getReadModel 收集接缝", () => {
  it("将每个 codex profile 映射为 authState=unknown 的账户（BR-3 使用时校验）", () => {
    const model = collectFourBlockReadModel(deps({ auth: { profiles: ["work", "personal"], seats: [] } }));
    expect(model.accounts).toEqual([
      { accountId: "work", label: "work", provider: "codex", authState: "unknown", profileRef: "work", asOf: ASOF },
      { accountId: "personal", label: "personal", provider: "codex", authState: "unknown", profileRef: "personal", asOf: ASOF },
    ]);
  });

  it("将已注册 codex 席位绑定到其 profile，boundAt/source 来自注册表", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [{ seat: "dev-driver@rig-a", rig: "rig-a", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "2026-08-03T10:00:00Z" }] },
      listSeats: () => [{ seatSession: "dev-driver@rig-a", rigName: "rig-a", runtime: "codex", lifecycleState: "running" }],
    }));
    expect(model.bindings).toEqual([
      { accountId: "work", seatSession: "dev-driver@rig-a", rigName: "rig-a", boundAt: "2026-08-03T10:00:00Z", bindingSource: "codex_auth_seat_registry", anomalies: [] },
    ]);
  });

  it("claude（或未注册）席位保持未绑定，并携带 seat_with_no_account", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [] },
      listSeats: () => [{ seatSession: "pm@rig-a", rigName: "rig-a", runtime: "claude-code", lifecycleState: "running" }],
    }));
    expect(model.bindings).toHaveLength(1);
    const b = model.bindings[0]!;
    expect(b.accountId).toBeNull();
    expect(b.anomalies[0]).toMatchObject({ kind: "seat_with_no_account", seat: "pm@rig-a" });
  });

  it("同一 profile 绑定到两个不同席位时产生 same_account_on_n_seats 异常", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [
        { seat: "a@rig", rig: "rig", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t1" },
        { seat: "b@rig", rig: "rig", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t2" },
      ] },
      listSeats: () => [
        { seatSession: "a@rig", rigName: "rig", runtime: "codex", lifecycleState: "running" },
        { seatSession: "b@rig", rigName: "rig", runtime: "codex", lifecycleState: "running" },
      ],
    }));
    for (const b of model.bindings) {
      expect(b.anomalies.some((a) => a.kind === "same_account_on_n_seats" && a.count === 2)).toBe(true);
    }
  });

  it("codex home 为空 → 账户为空、所有席位未绑定；signals 默认为 []", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: [], seats: [] },
      listSeats: () => [{ seatSession: "s@rig", rigName: "rig", runtime: "codex", lifecycleState: "running" }],
    }));
    expect(model.accounts).toEqual([]);
    expect(model.bindings[0]!.accountId).toBeNull();
    expect(model.signals).toEqual([]);
    expect(model.asOf).toBe(ASOF);
  });

  it("提供收集器时原样透传已收集信号", () => {
    const sig = { provider: "codex" as const, accountRef: "work", sourceClass: "unknown" as const, authority: "unknown" as const, asOf: ASOF, unknownReason: "无读数", automationUse: "do_not_automate" as const };
    const model = collectFourBlockReadModel(deps({ auth: { profiles: ["work"], seats: [] }, collectSignals: () => [sig] }));
    expect(model.signals).toEqual([sig]);
  });

  it("过期的同会话 Codex 注册表行不会绑定 claude 席位（运行时身份门禁）", () => {
    const model = collectFourBlockReadModel(deps({
      auth: { profiles: ["work"], seats: [{ seat: "shared@rig", rig: "rig", runtime: "codex", cwd: "/p", authProfile: "work", updatedTs: "t1" }] },
      // 实时清单中同名会话是 Claude 席位——codex 行已过期。
      listSeats: () => [{ seatSession: "shared@rig", rigName: "rig", runtime: "claude-code", lifecycleState: "running" }],
    }));
    expect(model.bindings).toHaveLength(1);
    const b = model.bindings[0]!;
    expect(b.accountId).toBeNull(); // 即使存在过期同会话行，也不得绑定到 Codex 账户
    expect(b.anomalies[0]).toMatchObject({ kind: "seat_with_no_account", seat: "shared@rig" });
  });

  it("丢弃按席位键控的过期 Claude 缓存信号，并为实时 Claude 席位发出如实 unknown", () => {
    const model = collectFourBlockReadModel(deps({
      listSeats: () => [{ seatSession: "live@rig", rigName: "rig", runtime: "claude-code", lifecycleState: "running" }],
      collectSignals: () => [{
        provider: "claude", seatSession: "dead@rig", sourceClass: "provider_statusline",
        authority: "account_cross_device", window: "five_hour", usedPercent: 12, asOf: ASOF,
        automationUse: "allow_switch_decision",
      }],
    }));

    expect(model.signals.some((signal) => signal.seatSession === "dead@rig")).toBe(false);
    expect(model.signals).toEqual([expect.objectContaining({
      provider: "claude", seatSession: "live@rig", sourceClass: "unknown",
      authority: "unknown", automationUse: "do_not_automate",
    })]);
  });

  it("会话名仅以非 Claude 运行时存活时，丢弃 Claude 缓存信号", () => {
    const model = collectFourBlockReadModel(deps({
      listSeats: () => [{ seatSession: "reused@rig", rigName: "rig", runtime: "codex", lifecycleState: "running" }],
      collectSignals: () => [{
        provider: "claude", seatSession: "reused@rig", sourceClass: "provider_statusline",
        authority: "account_cross_device", window: "five_hour", usedPercent: 12, asOf: ASOF,
        automationUse: "allow_switch_decision",
      }],
    }));

    expect(model.signals.filter((signal) => signal.provider === "claude")).toEqual([]);
  });
});
