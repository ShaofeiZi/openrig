// Slice-04 S-A（OPR.0.5.0.4，founder re-center A2）——主机级用量汇总。
// 将 seat-sourced C3（Claude statusline）row + C4（Codex reactive）signal 聚合为每个
//（host、provider）一条诚实 state row：
//   ok | nearing | limited（已知时持续到 resets_at）| explicit_unknown。
// 三个 BINDING 诚实条件（PM）：
//   (i)  host==account 是 DEPLOYMENT INVARIANT，并在 provenance 中如此标注——rollup key 仅为
//        （host、provider）；绝不输出 account id；
//   (ii) 同一 host 上冲突的 seat window = FIRST-CLASS ANOMALY + explicit-unknown host state，
//        绝不静默 merge；
//   (iii) usage-limit 粒度只使用 C3 row 已携带的数据。

import { describe, it, expect } from "vitest";
import {
  rollupHostUsage,
  NEARING_THRESHOLD_PERCENT,
  CONFLICTING_RESETS_EPSILON_MS,
  type HostUsageRow,
} from "../src/domain/provider/host-usage-rollup.js";
import { collectFourBlockReadModel } from "../src/domain/provider/provider-collect.js";
import type { ProviderSignal } from "../src/domain/provider/provider-types.js";

const NOW = "2026-08-05T00:00:00.000Z";
const RESETS = "2026-08-05T03:00:00.000Z";

function claudeRow(seat: string, usedPercent: number | undefined, over: Partial<ProviderSignal> = {}): ProviderSignal {
  return {
    provider: "claude",
    seatSession: seat,
    sourceClass: usedPercent === undefined ? "unknown" : "provider_statusline",
    authority: usedPercent === undefined ? "unknown" : "account_cross_device",
    ...(usedPercent === undefined ? { unknownReason: "statusline_cache_absent" } : { usedPercent, window: "five_hour" as const, resetsAt: RESETS }),
    asOf: NOW,
    automationUse: usedPercent === undefined ? "do_not_automate" : "allow_switch_decision",
    ...over,
  };
}

function codexEventRow(over: Partial<ProviderSignal> = {}): ProviderSignal {
  return {
    provider: "codex",
    accountRef: "acct-profile-a", // input MAY carry it; the rollup must never emit it
    sourceClass: "provider_event",
    authority: "reactive_error",
    asOf: NOW,
    staleAfter: "2026-08-05T00:05:00.000Z",
    automationUse: "allow_switch_decision", // at_limit exhaustion
    ...over,
  };
}

function rowFor(rows: HostUsageRow[], provider: string): HostUsageRow {
  const r = rows.find((x) => x.provider === provider);
  expect(r, `expected a ${provider} rollup row`).toBeDefined();
  return r!;
}

describe("S-A host-level usage rollup（纯函数）", () => {
  it("Claude OK：一致的 seat window 聚合为一条（host、provider）row，保留 C3 粒度与 deployment-invariant provenance label", () => {
    const rows = rollupHostUsage({
      signals: [claudeRow("dev-a@r", 30), claudeRow("dev-b@r", 33)],
      codexProfilesPresent: false,
      now: NOW,
    });
    expect(rows).toHaveLength(1);
    const r = rowFor(rows, "claude");
    expect(r.host).toBe("local");
    expect(r.state).toBe("ok");
    expect(r.windows.length).toBeGreaterThan(0);
    expect(r.windows.every((w) => w.window === "five_hour")).toBe(true);
    expect(r.evidenceSeats.sort()).toEqual(["dev-a@r", "dev-b@r"]);
    expect(r.provenance.basis).toBe("one_account_per_host_deployment_invariant");
    expect(r.provenance.note).toMatch(/deployment invariant/i);
    expect(r.provenance.note).toMatch(/not.*account classification/i);
    expect(r.anomalies).toEqual([]);
    expect(r.asOf).toBe(NOW);
  });

  it("Claude 在 threshold 处为 NEARING；达到 100 时为 LIMITED，并携带 exhausted window 的 resets_at", () => {
    const nearing = rollupHostUsage({
      signals: [claudeRow("a@r", NEARING_THRESHOLD_PERCENT)],
      codexProfilesPresent: false,
      now: NOW,
    });
    expect(rowFor(nearing, "claude").state).toBe("nearing");

    const limited = rollupHostUsage({
      signals: [claudeRow("a@r", 100)],
      codexProfilesPresent: false,
      now: NOW,
    });
    const lr = rowFor(limited, "claude");
    expect(lr.state).toBe("limited");
    expect(lr.resetsAt).toBe(RESETS);
  });

  it("(ii) 冲突 seat window = 一等 anomaly + explicit_unknown——绝不静默 merge", () => {
    const otherReset = "2026-08-05T06:30:00.000Z"; // a different account's schedule
    const rows = rollupHostUsage({
      signals: [
        claudeRow("a@r", 30),
        claudeRow("b@r", 90, { resetsAt: otherReset }),
      ],
      codexProfilesPresent: false,
      now: NOW,
    });
    const r = rowFor(rows, "claude");
    expect(r.state).toBe("explicit_unknown");
    expect(r.unknownReason).toMatch(/conflict/i);
    expect(r.anomalies).toHaveLength(1);
    const a = r.anomalies[0]!;
    expect(a.kind).toBe("conflicting_seat_windows");
    expect(a.window).toBe("five_hour");
    expect(a.seats.sort()).toEqual(["a@r", "b@r"]);
    expect(a.evidence).toContain(RESETS);
    expect(a.evidence).toContain(otherReset);
    // 冲突事实保持可见（不伪造 merge/average 数值）
    expect(r.windows).toHaveLength(2);
  });

  it("(ii) 容差：epsilon 内的 resets_at sampling skew 不构成冲突", () => {
    // 绝对 anchor（裁定 epsilon = 120 秒）：spread 为 119 秒。特意不根据 imported constant 计算——
    // 相对 epsilon 的 fixture 会随 constant 漂移，因而永远无法捕获它。
    const skewed = new Date(Date.parse(RESETS) + 119_000).toISOString();
    const rows = rollupHostUsage({
      signals: [claudeRow("a@r", 30), claudeRow("b@r", 31, { resetsAt: skewed })],
      codexProfilesPresent: false,
      now: NOW,
    });
    const r = rowFor(rows, "claude");
    expect(r.state).toBe("ok");
    expect(r.anomalies).toEqual([]);
  });

  it("(ii) 固定已裁定 epsilon 值（任一方向的 drift 都是有意重新裁定，而非意外）", () => {
    expect(CONFLICTING_RESETS_EPSILON_MS).toBe(120_000);
  });

  it("(ii) 边界刚超出：eps+1 秒分歧就是 conflict——一等 anomaly + explicit_unknown（guard 6b2e84d3：可从上方证伪 epsilon）", () => {
    // 绝对 anchor：spread 为 121 秒——比裁定的 120 秒 epsilon 多一秒。constant 只要向上 drift
    //（guard 的 30x probe），这里就不再冲突并导致失败。
    const skewed = new Date(Date.parse(RESETS) + 121_000).toISOString();
    const rows = rollupHostUsage({
      signals: [claudeRow("a@r", 30), claudeRow("b@r", 31, { resetsAt: skewed })],
      codexProfilesPresent: false,
      now: NOW,
    });
    const r = rowFor(rows, "claude");
    expect(r.state).toBe("explicit_unknown");
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]!.kind).toBe("conflicting_seat_windows");
    expect(r.anomalies[0]!.seats.sort()).toEqual(["a@r", "b@r"]);
  });

  it("Claude 全部为 unknown seat row → 携带 unknownReason 的 explicit_unknown（绝不因缺失而判 ok）", () => {
    const rows = rollupHostUsage({
      signals: [claudeRow("a@r", undefined), claudeRow("b@r", undefined)],
      codexProfilesPresent: false,
      now: NOW,
    });
    const r = rowFor(rows, "claude");
    expect(r.state).toBe("explicit_unknown");
    expect(r.unknownReason).toBeTruthy();
  });

  it("Codex：fresh at-limit event → limited（exhaustion evidence；缺少 resets_at 是诚实结果）", () => {
    const rows = rollupHostUsage({
      signals: [codexEventRow()],
      codexProfilesPresent: true,
      now: NOW,
    });
    const r = rowFor(rows, "codex");
    expect(r.state).toBe("limited");
    expect(r.resetsAt).toBeUndefined();
  });

  it("Codex：advisory-only event（stream/stop error）不是 usage evidence → explicit_unknown，而非 limited 或 ok", () => {
    const rows = rollupHostUsage({
      signals: [codexEventRow({ automationUse: "advisory_only" })],
      codexProfilesPresent: true,
      now: NOW,
    });
    expect(rowFor(rows, "codex").state).toBe("explicit_unknown");
  });

  it("Codex：stale at-limit event 绝不会驱动 limited（BR-2 类；inclusive expiry）", () => {
    const rows = rollupHostUsage({
      signals: [codexEventRow({ staleAfter: NOW })], // now >= staleAfter → stale
      codexProfilesPresent: true,
      now: NOW,
    });
    expect(rowFor(rows, "codex").state).toBe("explicit_unknown");
  });

  it("Codex 存在（磁盘有 profile）但无 signal → 一条点名 meter 缺失的 explicit_unknown row——呈现 blindside 而非省略", () => {
    const rows = rollupHostUsage({ signals: [], codexProfilesPresent: true, now: NOW });
    const r = rowFor(rows, "codex");
    expect(r.state).toBe("explicit_unknown");
    expect(r.unknownReason).toMatch(/meter|no usage/i);
  });

  it("(i) 任何 rollup row 都不出现 account identity——即使 input signal 携带 accountRef", () => {
    const rows = rollupHostUsage({
      signals: [codexEventRow(), claudeRow("a@r", 42, { accountRef: "acct-claude-forged" })],
      codexProfilesPresent: true,
      now: NOW,
    });
    const json = JSON.stringify(rows);
    expect(json).not.toContain("accountRef");
    expect(json).not.toContain("accountId");
    expect(json).not.toContain("acct-profile-a");
    expect(json).not.toContain("acct-claude-forged");
  });

  it("无 deployment presence 的 provider 不输出 row（无 Claude seat、无 Codex profile）", () => {
    expect(rollupHostUsage({ signals: [], codexProfilesPresent: false, now: NOW })).toEqual([]);
  });
});

describe("S-A composition——hostUsage 随 read model 输出（增量 block）", () => {
  it("collectFourBlockReadModel 从自己收集的同一批 signal 聚合并输出 hostUsage", () => {
    const model = collectFourBlockReadModel({
      readCodexAuth: () => ({ profiles: ["p1"], seats: [] }),
      listSeats: () => [],
      collectSignals: () => [codexEventRow()],
      now: () => NOW,
    });
    expect(model.hostUsage).toBeDefined();
    const codex = model.hostUsage!.find((r) => r.provider === "codex");
    expect(codex?.state).toBe("limited");
    expect(JSON.stringify(model.hostUsage)).not.toContain("accountRef");
  });
});
