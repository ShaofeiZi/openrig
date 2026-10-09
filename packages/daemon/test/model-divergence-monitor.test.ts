// B8 / slice-07 A3——model-divergence detector + 四 channel proclamation。按 PRD 采用 RED-first
// 结构：EFFECTIVE model 不同的 pinned seat 可正常启动，且四个 channel 都携带 proclamation
//（三次 delivery + 具名 Slack deferral）；任一 channel 静默都算失败。不关心原因：这里不检查
// model 为什么不同。

import { describe, it, expect, vi } from "vitest";
import {
  ModelDivergenceMonitor,
  SLACK_DEFERRAL_LINE,
  PENDING_VISIBILITY_POLLS,
  modelsMatch,
  formatProclamation,
  type PinnedSeat,
} from "../src/domain/model-divergence/model-divergence-monitor.js";
import { SPEC_VALIDATION_CAPABILITIES } from "../src/domain/rigspec-schema.js";
import { ProcessCensus } from "../src/domain/process-census.js";

const SEAT: PinnedSeat = {
  nodeId: "n1",
  sessionName: "dev-impl@r",
  rigId: "rig-1",
  rigName: "r",
  runtime: "codex",
  pinnedModel: "gpt-5.1-codex-mini",
  generation: "gen-1",
};

function makeMonitor(overrides?: Partial<ConstructorParameters<typeof ModelDivergenceMonitor>[0]>) {
  const sent: Array<{ target: string; message: string }> = [];
  const recorded: unknown[] = [];
  const monitor = new ModelDivergenceMonitor({
    listPinnedSeats: () => [SEAT],
    readEffectiveModel: () => ({ ok: true as const, model: "gpt-5.4-mini" }), // specimen #1's silent fallback
    sendToSession: async (target, message) => { sent.push({ target, message }); return { ok: true }; },
    resolveOrchSeats: () => ["orch-lead@r", "orch-advisor@r"],
    resolveOperatorSeat: () => "operator-admin@kernel",
    resolveOversightSeat: () => "watch-lead@oversight",
    recordProclamation: (p) => { recorded.push(p); },
    warn: () => {},
    ...overrides,
  });
  return { monitor, sent, recorded };
}

describe("ModelDivergenceMonitor——每轮只做一次 process census（perf-process-census，row 20260825035200）", () => {
  it("N 个 unresolved 席位在整轮 checkOnce 中只触发一次 process 枚举，而非逐席位一次", async () => {
    const seats: PinnedSeat[] = Array.from({ length: 5 }, (_, i) => ({
      ...SEAT, nodeId: `n${i}`, sessionName: `seat${i}@r`, generation: `g${i}`,
    }));
    let scans = 0;
    let reads = 0;
    let clock = 0;
    // 生产 census 底层只枚举一次，每轮 cycle-scoped，并带 freshness window（默认 2s）。注入
    // 时钟，使第二轮超过 freshness 并必须重新扫描；否则 freshness 复用也会正确地把相近两轮
    // 折叠成一次扫描。
    const census = new ProcessCensus({ list: async () => { scans += 1; return []; }, now: () => clock });
    const { monitor } = makeMonitor({
      listPinnedSeats: () => seats,
      processCensus: census,
      // 每个席位都是 UNRESOLVED（永不 settle），并通过逐轮 census 拉取 process table，与 live
      // claude/codex current-generation reader 完全一致。
      readEffectiveModel: async (_seat, cycle) => {
        reads += 1;
        await cycle!.listProcesses();
        return { ok: false as const, reason: "pending — no live record this pass" };
      },
    });

    await monitor.checkOnce();
    expect(reads).toBe(5);   // all five unresolved seats were read...
    expect(scans).toBe(1);   // ...but the whole pass did a SINGLE enumeration (not 5)

    // 超过 freshness window 的第二轮仍只为五个席位做一次扫描，绝不逐席位扫描。
    clock = 10_000;
    await monitor.checkOnce();
    expect(reads).toBe(10);
    expect(scans).toBe(2);
  });

  it("存在 processCensus 时，checkOnce 向每个席位传递 poll-scoped cycle（关键接线）", async () => {
    let everySeatGotACycle = true;
    const census = new ProcessCensus({ list: async () => [] });
    const { monitor } = makeMonitor({
      listPinnedSeats: () => [{ ...SEAT }, { ...SEAT, nodeId: "n2", sessionName: "b@r", generation: "g2" }],
      processCensus: census,
      readEffectiveModel: async (_seat, cycle) => {
        if (!cycle) everySeatGotACycle = false;
        return { ok: false as const, reason: "pending" };
      },
    });
    await monitor.checkOnce();
    expect(everySeatGotACycle).toBe(true);
  });
});

describe("ModelDivergenceMonitor——逐席位 throw 隔离（row 3f66664a，纵深防御）", () => {
  it("席位 check 抛错会报告 detector error，但不抑制其余席位检查", async () => {
    const thrower: PinnedSeat = { ...SEAT, sessionName: "thrower@r", nodeId: "nT" };
    const diverger: PinnedSeat = { ...SEAT, sessionName: "diverger@r", nodeId: "nD" };
    const warns: string[] = [];
    // 抛错席位位于首位；修复前它会中止整轮，使其后的 diverging 席位永远不检查，形成静默截断。
    const { monitor, recorded } = makeMonitor({
      listPinnedSeats: () => [thrower, diverger],
      readEffectiveModel: (seat: PinnedSeat) => {
        if (seat.sessionName === "thrower@r") throw new Error("boom: this seat's comparison threw");
        return { ok: true as const, model: "gpt-5.4-mini" }; // diverges from the codex pin
      },
      warn: (m: string) => warns.push(m),
    });

    const fired = await monitor.checkOnce();

    // thrower 后的 diverging 席位仍被检查并 proclamation。
    expect(fired.map((p) => p.sessionName)).toContain("diverger@r");
    expect((recorded as Array<{ sessionName: string }>).map((p) => p.sessionName)).toContain("diverger@r");
    // 抛错席位明确报告为 detector error。
    expect(warns.some((w) => w.includes("thrower@r") && /threw/i.test(w))).toBe(true);
  });
});

describe("ModelDivergenceMonitor——不关心原因的比较", () => {
  it("DIVERGENCE（founder RED case）：pinned != effective 时触发一次 proclamation，并覆盖全部四个 channel", async () => {
    const { monitor, sent, recorded } = makeMonitor();
    const fired = await monitor.checkOnce();

    expect(fired).toHaveLength(1);
    const p = fired[0]!;
    expect(p.pinnedModel).toBe("gpt-5.1-codex-mini");
    expect(p.effectiveModel).toBe("gpt-5.4-mini");

    // 三次 live delivery：两个 orch 席位 + operator + oversight。
    expect(sent.map((s) => s.target)).toEqual(["orch-lead@r", "orch-advisor@r", "operator-admin@kernel", "watch-lead@oversight"]);
    for (const s of sent) {
      expect(s.message).toContain("pinned=gpt-5.1-codex-mini");
      expect(s.message).toContain("effective=gpt-5.4-mini");
    }
    // Slack channel 以具名 deferral 呈现（DS2：无 shadow path、不静默）。
    const slack = p.channels.find((c) => c.channel === "slack")!;
    expect(slack.status).toBe("deferred");
    expect(slack.detail).toBe(SLACK_DEFERRAL_LINE);
    // 每个 channel outcome 都写入持久 record。
    expect(recorded).toHaveLength(1);
    expect(p.channels.filter((c) => c.status === "delivered")).toHaveLength(4);
  });

  it("以 GENERATION 为粒度逐 occurrence：同一 generation 不重复 proclamation，新 generation 会触发", async () => {
    const seats: PinnedSeat[] = [{ ...SEAT }];
    const { monitor, recorded } = makeMonitor({ listPinnedSeats: () => seats });
    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(recorded).toHaveLength(1); // no spam within a generation

    seats[0] = { ...SEAT, generation: "gen-2" }; // the successor occupant diverges too
    await monitor.checkOnce();
    expect(recorded).toHaveLength(2); // every occurrence = every occupant
  });

  it("MATCH 静默 settle generation；PENDING 在无 signal 时持续检查，直到可读", async () => {
    let effective: string | null = null;
    const { monitor, recorded } = makeMonitor({ readEffectiveModel: () => (effective ? { ok: true as const, model: effective } : { ok: false as const, reason: "no signal" }) });

    await monitor.checkOnce();
    expect(recorded).toHaveLength(0); // pending — never assumed, never settled

    effective = "gpt-5.1-codex-mini";
    await monitor.checkOnce();
    expect(recorded).toHaveLength(0); // match — settled silently

    effective = "gpt-5.4-mini"; // a later flip within the SAME generation stays settled (one verdict per occupant)
    await monitor.checkOnce();
    expect(recorded).toHaveLength(0);
  });

  it("不可达 channel 在 record 上具名为 failure/deferral，绝不静默", async () => {
    const { monitor } = makeMonitor({
      sendToSession: async () => ({ ok: false, error: "route down" }),
      resolveOperatorSeat: () => null,
      resolveOversightSeat: () => null,
    });
    const [p] = await monitor.checkOnce();
    const byChannel = Object.fromEntries(p!.channels.map((c) => [c.channel + ":" + (c.target ?? "-"), c]));
    expect(byChannel["orchestrator:orch-lead@r"]).toMatchObject({ status: "failed", detail: "route down" });
    expect(byChannel["operator:-"]).toMatchObject({ status: "failed", detail: "未配置 operator 席位" });
    expect(byChannel["oversight:-"]).toMatchObject({ status: "deferred" });
    expect(byChannel["slack:-"]).toMatchObject({ status: "deferred", detail: SLACK_DEFERRAL_LINE });
    expect(p!.channels).toHaveLength(5); // 2 orch + operator + oversight + slack — all accounted for
  });

  it("proclamation record 失败会告警，但绝不阻塞 delivery", async () => {
    const warn = vi.fn();
    const { monitor, sent } = makeMonitor({
      recordProclamation: () => { throw new Error("db locked"); },
      warn,
    });
    const fired = await monitor.checkOnce();
    expect(fired).toHaveLength(1);
    expect(sent.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });

  it("r1 finding——可观测 PENDING：无 signal 的 pinned 席位超过 threshold 后只具名报告一次 unchecked，绝不永久静默跳过", async () => {
    const warn = vi.fn();
    const { monitor } = makeMonitor({ readEffectiveModel: () => ({ ok: false as const, reason: "sidecar record belongs to session aaaa…, live occupant is bbbb… (stale-generation record)" }), warn });
    for (let i = 0; i < PENDING_VISIBILITY_POLLS + 5; i++) await monitor.checkOnce();
    const unchecked = warn.mock.calls.filter((c) => String(c[0]).includes("尚未检查"));
    expect(unchecked).toHaveLength(1); // named once, not spammed
    expect(String(unchecked[0]![0])).toContain("dev-impl@r");
    expect(String(unchecked[0]![0])).toContain("gpt-5.1-codex-mini");
    // D-a——READER 的具名 reason 逐字进入 warning 和 pending surface。
    expect(String(unchecked[0]![0])).toContain("stale-generation record");
    expect(monitor.pendingSeats()).toHaveLength(1);
    expect(monitor.pendingSeats()[0]!.polls).toBe(PENDING_VISIBILITY_POLLS + 5);
    expect(monitor.pendingSeats()[0]!.reason).toContain("stale-generation");
  });

  it("延迟到达的 signal 清除 pending state 并正常 settle", async () => {
    let effective: string | null = null;
    const { monitor, recorded } = makeMonitor({ readEffectiveModel: () => (effective ? { ok: true as const, model: effective } : { ok: false as const, reason: "no signal" }) });
    await monitor.checkOnce();
    expect(monitor.pendingSeats()).toHaveLength(1);
    effective = "gpt-5.1-codex-mini";
    await monitor.checkOnce();
    expect(monitor.pendingSeats()).toHaveLength(0);
    expect(recorded).toHaveLength(0); // match — settled
  });

  it("没有 pin 时 detector 完全不介入", async () => {
    const read = vi.fn(() => ({ ok: true as const, model: "anything" }));
    const { monitor, recorded } = makeMonitor({ listPinnedSeats: () => [], readEffectiveModel: read });
    await monitor.checkOnce();
    expect(read).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(0);
  });

  it("diagnosis 只作为信息携带，绝不作为 trigger", async () => {
    const { monitor } = makeMonitor({ diagnose: () => "runtime returned 400 invalid_request_error" });
    const [p] = await monitor.checkOnce();
    expect(p!.diagnosis).toContain("400");
    expect(formatProclamation(p!)).toContain("诊断（仅供参考）");
  });
});

describe("modelsMatch——pin 通过唯一正式 map canonicalize 后精确匹配（f7dfca0c）", () => {
  it("精确 id 不区分大小写匹配", () => {
    expect(modelsMatch("gpt-5.6-luna", " GPT-5.6-Luna ")).toBe(true);
    expect(modelsMatch("claude-fable-5", "claude-fable-5")).toBe(true);
  });

  it("单一 MAPPING 归属：已删除的 migration bridge 保持删除；monitor 查询 advisory 的 map", async () => {
    // bridge 自身删除契约已在 f7dfca0c 完成。monitor 模块不得导出自己的 alias map；
    // spec-validation-advisory.ts 中的 CANONICAL_MODEL_PINS 是 spec validation 与 runtime
    // detector 唯一的 mapping 归属点。复活本地 map 会形成双 registry 失败模式，reviewer 以本
    // pin 为检查依据。
    const monitorMod = await import("../src/domain/model-divergence/model-divergence-monitor.js");
    expect("CLAUDE_ALIAS_MIGRATION_BRIDGE" in monitorMod).toBe(false);
    const advisory = await import("../src/domain/spec-validation-advisory.js");
    expect(advisory.CANONICAL_MODEL_PINS.fable).toBe("claude-fable-5");
    expect(modelsMatch("fable", advisory.CANONICAL_MODEL_PINS.fable)).toBe(true); // same data drives both
    // r2 BLOCKING-1 结构侧：map 必须保持 null-prototype，使任意字符串 pin 都不能读取继承的
    // Object member；行为 pin 覆盖两个 consumer。
    expect(Object.getPrototypeOf(advisory.CANONICAL_MODEL_PINS)).toBeNull();
  });

  it("OPR.0.5.3.3：model-pin-canonicalization capability 保持 REGISTERED（spec advisory contract）", () => {
    expect(SPEC_VALIDATION_CAPABILITIES.has("model-pin-canonicalization")).toBe(true);
  });

  it("r2 ambiguity discriminator 保持 false：一个 pin 绝不能接受多个不同 model", () => {
    expect(modelsMatch("codex", "gpt-5.6-codex")).toBe(false);
    expect(modelsMatch("codex", "gpt-5.1-codex-mini")).toBe(false);
    expect(modelsMatch("mini", "gpt-5.4-mini")).toBe(false);
  });

  it("真实 divergence 失败：错误 family、部分 id", () => {
    expect(modelsMatch("fable", "claude-opus-5")).toBe(false);
    expect(modelsMatch("gpt-5.6-luna", "gpt-5.6")).toBe(false);
    expect(modelsMatch("gpt-5.1-codex-mini", "gpt-5.4-mini")).toBe(false);
  });
});

describe("f7dfca0c——alias-pin false positive 在 detector 处由唯一正式 canonical map 截止", () => {
  // 经 founder 指导、desk 裁定：alias-pinned 席位运行 alias 所指的准确 model 时不算 divergent，
  // 否则该类别会按 generation 和后台服务重启重复 proclamation。pin 先通过唯一 mapping 归属点
  // spec-validation-advisory.ts 中的 CANONICAL_MODEL_PINS canonicalize，再精确比较。不做 token
  // containment；上方相邻测试确保 r2 ambiguity discriminator（一个 pin 接受多个 model）为 false。
  it("RED-1：alias pin canonicalize；fable 匹配 claude-fable-5，并保留 trim/case", () => {
    expect(modelsMatch("fable", "claude-fable-5")).toBe(true);
    expect(modelsMatch(" FABLE ", " Claude-Fable-5 ")).toBe(true);
  });

  it("对照：alias pin 与不同 canonical model 仍 divergence，未知 alias 同样如此", () => {
    expect(modelsMatch("fable", "claude-opus-5")).toBe(false);
    expect(modelsMatch("fable", "claude-fable-6")).toBe(false);
    expect(modelsMatch("opus", "claude-opus-5")).toBe(false); // unmapped alias: no blessing
  });

  it("RED-2（monitor 级）：alias-pinned Claude 席位运行其 canonical model 时不产生 proclamation", async () => {
    const seat: PinnedSeat = { ...SEAT, runtime: "claude", pinnedModel: "fable" };
    const { monitor, recorded } = makeMonitor({
      listPinnedSeats: () => [seat],
      readEffectiveModel: () => ({ ok: true as const, model: "claude-fable-5" }),
    });
    expect(await monitor.checkOnce()).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("r2 BLOCKING-1：prototype-key pin 是 UNKNOWN alias，不是继承的 Object member；产生 divergence 而不抛错", () => {
    // r2 判别项：普通 object 上的 CANONICAL_MODEL_PINS[pin] 会为 "constructor"/"__proto__"
    // 等有效字符串 pin 返回继承的 Object.prototype member，导致 `?? pin` 不执行，
    // `.toLowerCase()` 抛错并中止整轮 detector。lookup 必须只读 own property。
    expect(modelsMatch("constructor", "claude-opus-5")).toBe(false);
    expect(modelsMatch("__proto__", "claude-opus-5")).toBe(false);
    expect(modelsMatch("hasOwnProperty", "claude-opus-5")).toBe(false);
  });

  it("r2 BLOCKING-1（monitor 级）：prototype-key pin 按原值 proclamation，且不遮蔽本轮后续席位", async () => {
    const evil: PinnedSeat = { ...SEAT, nodeId: "n-evil", sessionName: "evil@r", runtime: "claude", pinnedModel: "constructor" };
    const later: PinnedSeat = { ...SEAT, nodeId: "n-later", sessionName: "later@r", pinnedModel: "gpt-5.1-codex-mini" };
    const { monitor, recorded } = makeMonitor({
      listPinnedSeats: () => [evil, later],
      readEffectiveModel: (seat: PinnedSeat) =>
        ({ ok: true as const, model: seat.sessionName === "evil@r" ? "claude-opus-5" : "gpt-5.4-mini" }),
    });
    const fired = await monitor.checkOnce();
    // 两个 divergence 都会 proclamation；整轮在 adversarial pin 下继续，raw string 保持完整。
    expect(fired).toHaveLength(2);
    expect(fired[0]!.pinnedModel).toBe("constructor");
    expect(fired[0]!.effectiveModel).toBe("claude-opus-5");
    expect(fired[1]!.pinnedModel).toBe("gpt-5.1-codex-mini");
    expect(recorded).toHaveLength(2);
  });

  it("对照（monitor 级）：错误 model 上的 alias pin 触发 proclamation，并保留原始字符串", async () => {
    const seat: PinnedSeat = { ...SEAT, runtime: "claude", pinnedModel: "fable" };
    const { monitor } = makeMonitor({
      listPinnedSeats: () => [seat],
      readEffectiveModel: () => ({ ok: true as const, model: "claude-opus-5" }),
    });
    const fired = await monitor.checkOnce();
    expect(fired).toHaveLength(1);
    expect(fired[0]!.pinnedModel).toBe("fable"); // raw pin, never the canonicalized form
    expect(fired[0]!.effectiveModel).toBe("claude-opus-5");
  });
});
