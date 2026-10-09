// Slice 27——ClaudeCompactionEnforcer 单元测试。
//
// 硬门禁覆盖：
//   HG-2  策略启用且 usedPercentage >= threshold 时触发阈值检查
//   HG-3  通过 SessionTransport 发送时，压缩前准备提示先于 '/compact ...'
//   HG-4  重复触发前，使用量必须先降到阈值以下以重新布防
//   HG-5  选择加入且默认关闭——策略禁用时强制器不得触发
//         （压缩生命周期影响范围的回归门禁）
//
// 另覆盖运行时筛选（仅 claude-code）、低于阈值门禁、缺少用量数据时短路，以及
// 发送失败时不更新去重状态的语义。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import type { SessionTransport } from "../src/domain/session-transport.js";
import type { ClaudeCompactionPolicy, SettingsStore } from "../src/domain/user-settings/settings-store.js";

const DEFAULT_PRE_COMPACT_TEST_INSTRUCTION =
  "Read the claude-compaction-restore skill and create or update the mental-model restore map.";
const DEFAULT_AUDIT_TEST_INSTRUCTION =
  "Read the claude-compaction-restore skill and audit restore read depth.";

function makeSettingsStore(policy: ClaudeCompactionPolicy): SettingsStore {
  return {
    resolveClaudeCompactionPolicy: vi.fn(() => policy),
  } as unknown as SettingsStore;
}

function makeSessionTransport(sendResult: { ok: boolean } = { ok: true }): {
  transport: SessionTransport;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(async () => sendResult);
  return {
    transport: { send } as unknown as SessionTransport,
    send,
  };
}

const POLICY_DISABLED: ClaudeCompactionPolicy = {
  enabled: false,
  thresholdPercent: 80,
  preCompactInstruction: "",
  compactInstruction: "",
  messageInline: "",
  messageFilePath: "",
  postRestoreAuditInstruction: "",
};
const POLICY_ENABLED_AT_80: ClaudeCompactionPolicy = {
  enabled: true,
  thresholdPercent: 80,
  preCompactInstruction: DEFAULT_PRE_COMPACT_TEST_INSTRUCTION,
  compactInstruction: "",
  messageInline: "",
  messageFilePath: "",
  postRestoreAuditInstruction: DEFAULT_AUDIT_TEST_INSTRUCTION,
};

describe("ClaudeCompactionEnforcer 压缩强制器", () => {
  let dateNow: () => number;
  beforeEach(() => {
    let t = 1_700_000_000_000;
    dateNow = vi.spyOn(Date, "now").mockImplementation(() => t) as unknown as () => number;
    void dateNow;
    // 需要推进模拟时间时，在下方通过闭包重新定义。
    vi.restoreAllMocks();
  });

  it("HG-5：选择加入且默认关闭——禁用策略不得触发发送", async () => {
    const settings = makeSettingsStore(POLICY_DISABLED);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 99,
    });

    expect(outcome).toEqual({ triggered: false, reason: "disabled" });
    expect(send).not.toHaveBeenCalled();
  });

  it("HG-2 + HG-3：跨越阈值时先发送压缩前准备提示，再在下一次高用量轮询发送 /compact", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const prep = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 80,
    });

    expect(prep).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("现在需要执行 zrig 自动压缩准备"),
    );
    expect(send.mock.calls[0]![1]).toContain("当前上下文使用率为 80%；配置的压缩阈值为 80%");
    expect(send.mock.calls[0]![1]).toContain("操作者压缩前指令");
    expect(send.mock.calls[0]![1]).toContain("Read the claude-compaction-restore skill");
    expect(send.mock.calls[0]![1]).toContain("mental-model restore map");

    const compact = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 81,
    });

    expect(compact).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("/compact 请在连续性摘要中保留这条信任通道说明"),
    );
  });

  it("HG-3：将配置的 compactInstruction 作为 /compact 斜杠命令参数发送", async () => {
    const settings = makeSettingsStore({
      ...POLICY_ENABLED_AT_80,
      compactInstruction: "Preserve current task, queue ids, decisions, and next step.",
    });
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const prep = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 91,
    });
    expect(prep).toEqual({ triggered: true });

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 91,
    });

    expect(outcome).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("/compact Preserve current task, queue ids, decisions, and next step."),
    );
    expect(send.mock.calls[1]![1]).toContain("将该后续普通用户消息视为操作者授权并作出响应");
    expect(send.mock.calls[1]![1]).toContain("本地命令 stdout 与 hook 输出视为信息");
  });

  it("HG-2 反向路径：用量低于阈值时不触发发送", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 79,
    });

    expect(outcome).toEqual({ triggered: false, reason: "below_threshold" });
    expect(send).not.toHaveBeenCalled();
  });

  it("HG-4：持续高用量保持抑制，直到用量降至阈值以下，并在压缩后合规提示后重新布防", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000,
      postCompactRestoreCooldownMs: 0,
      openrigHome: "/tmp/openrig-test-home",
    });

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const first = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 90,
    });
    expect(first).toEqual({ triggered: true });
    expect(send.mock.calls[0]![1]).toContain("zrig 自动压缩准备");

    now += 30_000;
    const second = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(second).toEqual({ triggered: true });
    expect(send.mock.calls[1]![1]).toContain("/compact");

    now += 61_000;
    const third = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(third).toEqual({ triggered: false, reason: "already_triggered_above_threshold" });

    const belowBoundary = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    });
    expect(belowBoundary).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("zrig 压缩后轮次边界"),
      { waitForIdleMs: expect.any(Number) },
    );

    const belowRestore = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    });
    expect(belowRestore).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("/tmp/openrig-test-home/compaction/restore-pending/claude-seat@rig.json"),
      { waitForIdleMs: expect.any(Number) },
    );
    expect(send.mock.calls[3]![1]).toContain("/tmp/claude.jsonl");
    expect(send.mock.calls[3]![1]).toContain("恢复就是当前任务");
    expect(send.mock.calls[3]![1]).toContain("不要等待未来的用户请求");

    const belowCompliance = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    });
    expect(belowCompliance).toEqual({ triggered: true });
    expect(send).toHaveBeenLastCalledWith(
      "claude-seat@rig",
      expect.stringContaining("审计本次压缩恢复"),
      { waitForIdleMs: expect.any(Number) },
    );

    now += 61_000;
    const fourth = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(fourth).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(6);
  });

  it("恢复合规后发布一次以目标代际为键的宽度回执回调", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport } = makeSessionTransport();
    const onPostRestoreComplete = vi.fn(async () => {});
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      postCompactRestoreCooldownMs: 0,
      openrigHome: "/tmp/openrig-test-home",
      resolveOccupantGeneration: () => "target-generation-7",
      onPostRestoreComplete,
    } as never);

    await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 90,
    });
    await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 91,
    });
    for (let i = 0; i < 3; i++) {
      await enforcer.maybeAutoCompact({
        sessionName: "claude-seat@rig",
        runtime: "claude-code",
        usedPercentage: 20,
        transcriptPath: "/tmp/claude.jsonl",
      });
    }

    expect(onPostRestoreComplete).toHaveBeenCalledTimes(1);
    expect(onPostRestoreComplete).toHaveBeenCalledWith({
      sessionName: "claude-seat@rig",
      occupantGeneration: "target-generation-7",
      postRestoreUsedPercentage: 20,
      saturationBoundPercentage: 80,
    });
  });

  it("幽灵阶段 (a)：策略禁用时不排空任何内容——启用期间排队的阶段在禁用后绝不触发（证明种子 1）", async () => {
    // 旧版压缩阶段缺陷（裁定 05c174e0）：策略禁用时排空已排队的恢复阶段会触发幽灵提示
    //（交接后的继任者继承前任排队的阶段）。此裁定取代 OPR.0.4.3.14 中“无论 enabled
    // 状态如何，低于阈值的后半段都会排空”的规则。禁用的系统不得排空任何内容。
    const policy: ClaudeCompactionPolicy = { ...POLICY_ENABLED_AT_80 }; // mutable so we can disable mid-sequence
    const settings = makeSettingsStore(policy);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000,
      postCompactRestoreCooldownMs: 0,
      openrigHome: "/tmp/openrig-test-home",
    });
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    // 在启用期间排队一个阶段：prep (90)，随后 /compact (95) 设置 pendingPostCompactRestore。
    await enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 90 });
    now += 30_000;
    await enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 95 });
    const queuedSendCount = send.mock.calls.length; // prep + compact only

    // 现在禁用（操作员关闭它/继任者在策略禁用时继承排队阶段）。
    policy.enabled = false;

    // 低于阈值的轮询不得排空任何内容——不能出现幽灵提示。
    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    });
    expect(outcome).toEqual({ triggered: false, reason: "disabled" });
    expect(send.mock.calls.length).toBe(queuedSendCount); // the queued stage did NOT fire
  });

  it("幽灵阶段 (e)：invalidateOccupant 丢弃排队阶段及泄漏的 manualCompactionState——同名继任者不继承任何内容", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000, postCompactRestoreCooldownMs: 0, openrigHome: "/tmp/openrig-test-home",
    });
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    // 排队一个阶段（prep -> /compact 设置 pendingPostCompactRestore）及该席位的手工记录。
    await enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 90 });
    now += 30_000;
    await enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 95 });
    await enforcer.triggerManualCompact({ sessionName: "other-seat@rig", runtime: "claude-code", usedPercentage: 20 }, { operatorInitiated: true });
    expect(enforcer.getManualCompactionState("other-seat@rig")).not.toBeNull();
    const queuedSends = send.mock.calls.length;

    // 切换：即将退出的占用者交接。invalidateOccupant 丢弃其全部内存状态。
    enforcer.invalidateOccupant("claude-seat@rig");
    enforcer.invalidateOccupant("other-seat@rig");
    expect(enforcer.getManualCompactionState("other-seat@rig")).toBeNull(); // 1f leak closed

    // 同名继任者收到低于阈值的轮询：不排空任何内容（无幽灵提示）。
    const drain = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
    });
    expect(drain).toEqual({ triggered: false, reason: "below_threshold" }); // the queued stage was invalidated
    expect(send.mock.calls.length).toBe(queuedSends); // no inherited drain
  });

  // 幽灵阶段 (b)——限定代际的阶段。由已退出占用者代际创建的阶段无法交付给继任者
  //（身份层）。NOTE-2：未知任期保持惰性，绝不会把过时代际当作活跃代际比较而误放行。
  async function queueStageWithGen(gen: string | null) {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    let liveGen = gen;
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000, postCompactRestoreCooldownMs: 0, openrigHome: "/tmp/openrig-test-home",
      resolveOccupantGeneration: () => liveGen,
    });
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 90 });
    now += 30_000;
    await enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 95 }); // queues turn_boundary + captures gen
    return { enforcer, send, setLiveGen: (g: string | null) => { liveGen = g; }, queuedSends: send.mock.calls.length };
  }
  const belowTick = (enforcer: ClaudeCompactionEnforcer) =>
    enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/c.jsonl" });

  it("幽灵阶段 (b)：拒绝已退出代际的阶段（stale_generation），并为继任者丢弃", async () => {
    const { enforcer, send, setLiveGen, queuedSends } = await queueStageWithGen("gen-uuid-1");
    setLiveGen("gen-uuid-2"); // a successor occupant now holds the seat name
    expect(await belowTick(enforcer)).toEqual({ triggered: false, reason: "stale_generation" });
    expect(send.mock.calls.length).toBe(queuedSends); // no ghost prompt fired
    expect(await belowTick(enforcer)).toEqual({ triggered: false, reason: "below_threshold" }); // stage was dropped
  });

  it("幽灵阶段 (b)：匹配代际正常排空（同一占用者）", async () => {
    const { enforcer } = await queueStageWithGen("gen-uuid-1"); // live stays gen-uuid-1
    expect(await belowTick(enforcer)).toEqual({ triggered: true }); // turn_boundary drains
  });

  it("幽灵阶段 (b) NOTE-2：未知活跃任期保持惰性——正常排空，绝不误拒绝或将旧代际当作活跃代际比较", async () => {
    const { enforcer, setLiveGen } = await queueStageWithGen("gen-uuid-1");
    setLiveGen(null); // live tenure UNKNOWN (mint failed / no ledger) — the gate must NOT discriminate on it
    expect(await belowTick(enforcer)).toEqual({ triggered: true }); // inert: normal drain; (a)/(e) are the fail-closed layers
  });

  it("幽灵阶段 (b)：没有解析器时（向后兼容）门禁保持惰性——阶段照旧排空", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, { dedupWindowMs: 60_000, postCompactRestoreCooldownMs: 0, openrigHome: "/tmp/h" });
    let now = 1_700_000_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    await enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 90 });
    now += 30_000;
    await enforcer.maybeAutoCompact({ sessionName: "claude-seat@rig", runtime: "claude-code", usedPercentage: 95 });
    void send;
    expect(await belowTick(enforcer)).toEqual({ triggered: true }); // no resolver -> gate inert -> drains
  });

  it("压缩后合规提示启动冷却，使恢复工作无法立即再次触发 /compact", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 0,
      postCompactRestoreCooldownMs: 60_000,
      openrigHome: "/tmp/openrig-test-home",
    });

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 20,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    now += 1_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: false, reason: "post_restore_cooldown" });
    expect(send).toHaveBeenCalledTimes(5);

    now += 60_000;
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("运行时筛选：仅 claude-code 触发（codex 会话返回 runtime_filter，且不调用 send）", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "codex-seat@rig",
      runtime: "codex",
      usedPercentage: 99,
    });

    expect(outcome).toEqual({ triggered: false, reason: "runtime_filter" });
    expect(send).not.toHaveBeenCalled();
  });

  it("缺少用量数据时短路，不调用 settings 或 send", async () => {
    const policySpy = vi.fn(() => POLICY_ENABLED_AT_80);
    const settings = { resolveClaudeCompactionPolicy: policySpy } as unknown as SettingsStore;
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport);

    const outcome = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: null,
    });

    expect(outcome).toEqual({ triggered: false, reason: "no_usage_data" });
    expect(policySpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("发送失败：返回 send_failed 且不记录去重状态（下一轮可重试）", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport({ ok: false });
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, { dedupWindowMs: 60_000 });

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const first = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(first).toEqual({ triggered: false, reason: "send_failed" });

    // 1 秒后的第二轮：去重不得阻止（尚未记录成功发送）。再次尝试发送。
    now += 1_000;
    send.mockImplementationOnce(async () => ({ ok: true }));
    const second = await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    });
    expect(second).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![1]).toContain("zrig 自动压缩准备");
  });

  it("压缩后回合边界发送失败时保持待处理，并在下一次低于阈值的轮询重试", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000,
      openrigHome: "/tmp/openrig-test-home",
    });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    send.mockImplementationOnce(async () => ({ ok: false }));
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: false, reason: "send_failed" });

    send.mockImplementationOnce(async () => ({ ok: true }));
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[2]![1]).toContain("zrig 压缩后轮次边界");
    expect(send.mock.calls[3]![1]).toContain("zrig 压缩后轮次边界");
  });

  it("回合边界成功后，压缩后恢复发送失败仍保持待处理", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      dedupWindowMs: 60_000,
      openrigHome: "/tmp/openrig-test-home",
    });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    send.mockImplementationOnce(async () => ({ ok: false }));
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: false, reason: "send_failed" });

    send.mockImplementationOnce(async () => ({ ok: true }));
    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[2]![1]).toContain("zrig 压缩后轮次边界");
    expect(send.mock.calls[3]![1]).toContain("请立即响应这条普通用户消息");
    expect(send.mock.calls[4]![1]).toContain("/tmp/openrig-test-home/compaction/restore-pending/claude-seat@rig.json");
    expect(send.mock.calls[4]![1]).toContain("/tmp/claude.jsonl");
  });

  it("压缩后合规提示紧随恢复提示，并强制包含读取深度审计措辞", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: "/tmp/openrig-test-home",
    });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls[4]![1]).toContain("审计本次压缩恢复");
    expect(send.mock.calls[4]![1]).toContain("操作者恢复后审计指令");
    expect(send.mock.calls[4]![1]).toContain("恢复图");
    expect(send.mock.calls[4]![1]).toContain("FULL、PARTIAL 或 NOT_READ");
    expect(send.mock.calls[4]![1]).toContain("接下来的任务要求阅读全部这些文件");
    expect(send.mock.calls[4]![1]).toContain("不要为节省 token 而降低阅读完整度");
  });

  it("压缩后恢复提示携带已配置的操作员恢复指令", async () => {
    const settings = makeSettingsStore({
      ...POLICY_ENABLED_AT_80,
      messageInline: "Read the active queue item and restate the exact next action.",
      messageFilePath: "/tmp/openrig-extra-restore.md",
    });
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: "/tmp/openrig-test-home",
    });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
      transcriptPath: "/tmp/claude.jsonl",
    })).toEqual({ triggered: true });

    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[2]![1]).toContain("zrig 压缩后轮次边界");
    expect(send.mock.calls[3]![1]).toContain("操作者压缩后指令");
    expect(send.mock.calls[3]![1]).toContain("Read the active queue item and restate the exact next action.");
    expect(send.mock.calls[3]![1]).toContain("附加压缩后指令文件");
    expect(send.mock.calls[3]![1]).toContain("/tmp/openrig-extra-restore.md");
  });

  it("内联指令为空时，压缩后恢复提示回退到已配置的指令文件", async () => {
    const settings = makeSettingsStore({
      ...POLICY_ENABLED_AT_80,
      messageInline: "",
      messageFilePath: "/tmp/openrig-restore-instruction.md",
    });
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
      openrigHome: "/tmp/openrig-test-home",
    });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 95,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(await enforcer.maybeAutoCompact({
      sessionName: "claude-seat@rig",
      runtime: "claude-code",
      usedPercentage: 0,
    })).toEqual({ triggered: true });

    expect(send.mock.calls[3]![1]).toContain("附加压缩后指令文件");
    expect(send.mock.calls[3]![1]).toContain("/tmp/openrig-restore-instruction.md");
  });

  it("按会话键控去重：两个不同席位互不阻塞", async () => {
    const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
    const { transport, send } = makeSessionTransport();
    const enforcer = new ClaudeCompactionEnforcer(settings, transport, { dedupWindowMs: 60_000 });

    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect(await enforcer.maybeAutoCompact({ sessionName: "a@rig", runtime: "claude-code", usedPercentage: 99 })).toEqual({ triggered: true });
    expect(await enforcer.maybeAutoCompact({ sessionName: "b@rig", runtime: "claude-code", usedPercentage: 99 })).toEqual({ triggered: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toBe("a@rig");
    expect(send.mock.calls[1]![0]).toBe("b@rig");
  });

  // Slice 27 阻塞修复 2——环境变量来源绕过的集成检查。
  //
  // 借助阻塞修复 2 的解析路径校验，类似
  // OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT=80abc 的环境变量覆盖值会在
  // SettingsStore.resolveOne 被丢弃，强制器看到默认值 80。此测试集成真实 SettingsStore，
  // 由临时配置与环境变量覆盖支持，而非使用模拟——证明该绕过已端到端关闭
  //（解析 → 强制器 → 发送决策）。
  describe("阻塞修复 2 集成：环境变量来源绕过无法污染强制器", () => {
    it("env=80abc，策略启用且阈值不低于席位百分比 → 不触发 /compact（环境变量被拒绝，回退到默认 80；席位 79% 低于阈值）", async () => {
      const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tmpDir = mkdtempSync(join(tmpdir(), "enforcer-env-bypass-"));
      const configPath = join(tmpDir, "config.json");
      // 文件以默认阈值 80 启用策略。环境变量尝试通过 "80abc" 降低阈值；parseInt
      // 转成 80 尚不会破坏触发约定，但更危险的探针是环境变量 "0"，parseInt 会转成
      // 0（始终触发）。应用阻塞修复 2 后，环境变量 "0" 在解析时被拒绝并回退到
      // 默认 80。测试同时断言两个可观察结果。
      writeFileSync(configPath, JSON.stringify({
        policies: { claudeCompaction: { enabled: true, thresholdPercent: 80 } },
      }));
      const settings = new SettingsStore(configPath);

      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "0";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport);

        const outcome = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 79, // 79 < default 80 → no trigger; 79 >= env 0 would trigger if env were honored
        });

        expect(outcome).toEqual({ triggered: false, reason: "below_threshold" });
        expect(send).not.toHaveBeenCalled();
        const warns = stderrSpy.mock.calls.map((c) => String(c[0]));
        expect(warns.some((w) => w.includes("env override for policies.claude_compaction.threshold_percent rejected"))).toBe(true);
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("env=80abc、文件阈值 80、席位 99% → 触发（环境变量被拒绝；回退后文件值 80 胜出；99 >= 80）", async () => {
      const { SettingsStore } = await import("../src/domain/user-settings/settings-store.js");
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");

      const tmpDir = mkdtempSync(join(tmpdir(), "enforcer-env-bypass-2-"));
      const configPath = join(tmpDir, "config.json");
      writeFileSync(configPath, JSON.stringify({
        policies: { claudeCompaction: { enabled: true, thresholdPercent: 80 } },
      }));
      const settings = new SettingsStore(configPath);

      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "80abc";
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport);

        const prep = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 99,
        });

        // 环境变量被拒绝；文件值（threshold=80）胜出；99 >= 80 → 触发准备
        expect(prep).toEqual({ triggered: true });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(
          "claude-seat@rig",
          expect.stringContaining("zrig 自动压缩准备"),
        );

        const compact = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 99,
        });

        expect(compact).toEqual({ triggered: true });
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith(
          "claude-seat@rig",
          expect.stringContaining("/compact 请在连续性摘要中"),
        );
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // Slice 27 阻塞修复——强制器处的纵深防御。
  //
  // CLI 与守护进程的 set() 路径会拒绝无效阈值输入，但手工编辑
  // ~/.openrig/config.json 仍可能注入 0、101、NaN 或非整数（按设计，文件读取路径会
  // 透传值而不重新校验）。强制器是发送前的最后一道安全网：必须将不符合约定的
  // thresholdPercent 视为禁用（返回 `invalid_policy`，不发送）。
  describe("阻塞修复：对手工编辑的错误策略值实施纵深防御", () => {
    const cases: Array<{ name: string; thresholdPercent: number }> = [
      { name: "0 (would trigger on every tick)", thresholdPercent: 0 },
      { name: "101 (above range)", thresholdPercent: 101 },
      { name: "-1 (below range)", thresholdPercent: -1 },
      { name: "80.5 (non-integer)", thresholdPercent: 80.5 },
      { name: "NaN", thresholdPercent: Number.NaN },
      { name: "Infinity", thresholdPercent: Number.POSITIVE_INFINITY },
    ];

    for (const c of cases) {
      it(`将 threshold=${c.name} 视为 invalid_policy；绝不发送`, async () => {
        const settings = makeSettingsStore({
          enabled: true,
          thresholdPercent: c.thresholdPercent,
          preCompactInstruction: "",
          compactInstruction: "",
          messageInline: "",
          messageFilePath: "",
          postRestoreAuditInstruction: "",
        });
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport);

        const outcome = await enforcer.maybeAutoCompact({
          sessionName: "claude-seat@rig",
          runtime: "claude-code",
          usedPercentage: 99, // would trigger if policy were valid
        });

        expect(outcome).toEqual({ triggered: false, reason: "invalid_policy" });
        expect(send).not.toHaveBeenCalled();
      });
    }
  });

  // OPR.0.4.3.14——可配置的手工压缩触发器。
  //
  // 覆盖：单席位引导序列（消息与自动路径相同）、阈值无关性与确定性（包括自动路径
  // 已禁用）、两阶段等待空闲顺序（准备完成前绝不发送 /compact）、复用单一恢复路径
  //（现有轮询循环排空“恢复→审计”）、状态呈现、拒绝非 Claude、范围有界，以及重新
  // 排列启用门禁后仍保留自动路径。
  describe("triggerManualCompact（手工触发器）", () => {
    const SEAT = "claude-seat@rig";
    const HOME = "/tmp/openrig-test-home";

    it("单席位引导序列：低于阈值时触发并发送准备 → /compact（信任桥），随后由现有轮询排空恢复→审计（无第二条路径）", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

      const outcome = await enforcer.triggerManualCompact({
        sessionName: SEAT,
        runtime: "claude-code",
        usedPercentage: 20, // BELOW threshold 80 — threshold-independent
        transcriptPath: "/tmp/claude.jsonl",
      });
      expect(outcome).toEqual({ triggered: true, stage: "compact-sent" });

      // 阶段 1——准备（常规发送，不带等待选项）。
      expect(send.mock.calls[0]![0]).toBe(SEAT);
      expect(send.mock.calls[0]![1]).toContain("现在需要执行 zrig 自动压缩准备");
      expect(send.mock.calls[0]![2]).toBeUndefined();
      // 阶段 2——携带信任桥并等待空闲的 /compact（两阶段）。
      expect(send.mock.calls[1]![1]).toContain("/compact 请在连续性摘要中保留这条信任通道说明");
      expect(send.mock.calls[1]![2]).toEqual({ waitForIdleMs: expect.any(Number) });
      expect(send).toHaveBeenCalledTimes(2);

      // 由同一个 maybeAutoCompact 后半段（单一恢复路径）将其排空。
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("zrig 压缩后轮次边界"), { waitForIdleMs: expect.any(Number) });

      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("请立即响应这条普通用户消息"), { waitForIdleMs: expect.any(Number) });

      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20,
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("审计本次压缩恢复"), { waitForIdleMs: expect.any(Number) });

      expect(send).toHaveBeenCalledTimes(5);
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
    });

    // OPR.0.4.3.14 rev1-r2 回修——同席位进行中并发护栏。
    describe("进行中护栏（rev1-r2）：并发/重复触发时不重复发送", () => {
      it("同席位并发（第一次准备保持未完成）：第二次调用不发送并返回 already_in_progress", async () => {
        const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
        const { transport, send } = makeSessionTransport();
        // 保持第一次发送（准备）未完成，使首次触发暂停在序列中间（stage=preparing）。
        let releasePrep!: () => void;
        send.mockImplementationOnce(() => new Promise((resolve) => { releasePrep = () => resolve({ ok: true }); }));
        const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

        // 启动但不 await——同步运行到被挂起的准备发送：stage=preparing，发送 #1 已触发。
        const first = enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(send).toHaveBeenCalledTimes(1);

        // 第一次仍处于 preparing 时发起第二次并发调用 → 受护栏保护而跳过，不发送。
        const second = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(second).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "already_in_progress" });
        expect(send).toHaveBeenCalledTimes(1); // still only the first prep — the 2nd never sent prep or /compact

        releasePrep();
        await first; // let the first finish its /compact (send #2)
        expect(send).toHaveBeenCalledTimes(2);
      });

      it("rev1-r2 回修 B1：降级的重复调用（usedPercentage:null）不会覆盖首次调用的 preparing 标记", async () => {
        const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
        const { transport, send } = makeSessionTransport();
        let releasePrep!: () => void;
        send.mockImplementationOnce(() => new Promise((resolve) => { releasePrep = () => resolve({ ok: true }); }));
        const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

        // 第一次调用暂停在准备中途 → stage=preparing，发送 #1 已触发。
        const first = enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(send).toHaveBeenCalledTimes(1);
        expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("preparing");

        // 降级重复调用：usedPercentage 为 null（错误 sidecar 投影）。护栏现在位于
        // no_usage_data 的 recordManualFailure 路径之前，因此不得记录 skipped-or-failed
        // 或清除 preparing 标记（rev1-r2 捕获的缺陷）。
        const degraded = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: null });
        expect(degraded).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "already_in_progress" });
        expect(send).toHaveBeenCalledTimes(1); // no send
        expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("preparing"); // marker PRESERVED, not clobbered

        // 第一次仍挂起时，以已知用量发起第三次调用 → 仍受护栏保护，不发送。
        const third = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 30 });
        expect(third).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "already_in_progress" });
        expect(send).toHaveBeenCalledTimes(1);

        releasePrep();
        await first;
      });

      it("compact-sent 后、后半段排空前顺序调用：不再次准备，也不再次发送 /compact", async () => {
        const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

        expect(await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 }))
          .toEqual({ triggered: true, stage: "compact-sent" });
        expect(send).toHaveBeenCalledTimes(2); // prep + /compact
        // 后半段（pendingPostCompactRestore=turn_boundary）尚未排空 → 护栏继续生效。
        const dup = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(dup).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "already_in_progress" });
        expect(send).toHaveBeenCalledTimes(2); // unchanged
      });

      it("序列完成（audit-sent）或失败（skipped-or-failed）后，允许重新触发", async () => {
        const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
        const { transport, send } = makeSessionTransport();
        const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

        // 推进一个完整序列到 audit-sent（后半段会清除待处理映射）。
        await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/c.jsonl" });
        await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/c.jsonl" });
        await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/c.jsonl" });
        await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
        expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
        const before = send.mock.calls.length;
        // audit-sent 后重新触发 → 允许（标记已清除）：新一轮准备 + /compact。
        expect(await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 }))
          .toEqual({ triggered: true, stage: "compact-sent" });
        expect(send.mock.calls.length).toBe(before + 2);

        // 触发失败后（准备发送失败 → skipped-or-failed）也允许重试。
        const { transport: t2, send: send2 } = makeSessionTransport();
        send2.mockImplementationOnce(async () => ({ ok: false, reason: "send_failed" }));
        const enf2 = new ClaudeCompactionEnforcer(settings, t2, { openrigHome: HOME });
        expect((await enf2.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 })).triggered).toBe(false);
        expect(enf2.getManualCompactionState(SEAT)?.stage).toBe("skipped-or-failed");
        // 重试继续进行（不受护栏阻止）。
        expect(await enf2.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 }))
          .toEqual({ triggered: true, stage: "compact-sent" });
      });
    });

    it("与阈值无关且确定：即使自动压缩已禁用也运行引导序列，后半段仍通过单一路径排空", async () => {
      const settings = makeSettingsStore(POLICY_DISABLED);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

      const outcome = await enforcer.triggerManualCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      }, { operatorInitiated: true }); // GHOST-STAGE (a): OPERATOR-initiated → drain-exempt while disabled
      expect(outcome).toEqual({ triggered: true, stage: "compact-sent" });
      expect(send.mock.calls[0]![1]).toContain("zrig 自动压缩准备");
      expect(send.mock.calls[1]![1]).toContain("/compact");
      expect(send).toHaveBeenCalledTimes(2);

      // 即使 enabled=false，低于阈值的后半段也必须排空（操作员发起的豁免）。
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("zrig 压缩后轮次边界"), { waitForIdleMs: expect.any(Number) });
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true });
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20,
      })).toEqual({ triggered: true });
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("审计本次压缩恢复"), { waitForIdleMs: expect.any(Number) });
    });

    it("幽灵阶段 (a) PM 固定：自动化发起的手工触发不享受排空豁免——禁用轮询不排空任何内容（无洗白绕过）", async () => {
      const settings = makeSettingsStore(POLICY_DISABLED);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

      // 自动化在没有操作员发起的情况下调用手工动作（故障安全默认值）。该动作仍会运行
      //（准备 + /compact），但所得阶段不得享受排空豁免——否则手工入口恰好洗白了修复 (a)
      // 所消除的排空行为。
      const outcome = await enforcer.triggerManualCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      }); // NO { operatorInitiated: true } — automation actor
      expect(outcome).toEqual({ triggered: true, stage: "compact-sent" });
      const afterTriggerSends = send.mock.calls.length; // prep + /compact only

      // 策略禁用时，低于阈值的轮询必须拒绝排空自动化植入的阶段。
      const drain = await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      });
      expect(drain).toEqual({ triggered: false, reason: "disabled" });
      expect(send.mock.calls.length).toBe(afterTriggerSends); // no ghost drain — not exempt
    });

    it("重新排列启用门禁后仍保留自动路径：禁用策略在超过阈值时仍不自动触发", async () => {
      const settings = makeSettingsStore(POLICY_DISABLED);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 99,
      })).toEqual({ triggered: false, reason: "disabled" });
      expect(send).not.toHaveBeenCalled();
    });

    it("两阶段顺序：发送 /compact 时携带 waitForIdleMs，因此不会在准备回合完成前落地", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const callOrder: string[] = [];
      send.mockImplementation(async (_session: string, text: string, opts?: unknown) => {
        callOrder.push(text.startsWith("/compact") ? `compact:${JSON.stringify(opts)}` : "prep");
        return { ok: true };
      });
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { manualPrepWaitMs: 90_000 });

      await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });

      expect(callOrder).toEqual(["prep", `compact:${JSON.stringify({ waitForIdleMs: 90_000 })}`]);
    });

    it("等待空闲失败表示 /compact 从未落地：不植入后半段（顺序保证）", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      send.mockImplementationOnce(async () => ({ ok: true })); // prep lands
      send.mockImplementationOnce(async () => ({ ok: false, reason: "wait_for_idle_timeout" })); // /compact never idle
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      const outcome = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
      expect(outcome).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "wait_for_idle_timeout" });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("skipped-or-failed");

      // 未植入 turn_boundary，因此低于阈值的轮询找不到可排空内容。
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20,
      })).toEqual({ triggered: false, reason: "below_threshold" });
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("准备发送失败会呈现传输原因，且不发送 /compact", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      send.mockImplementationOnce(async () => ({ ok: false, reason: "mid_work" }));
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      const outcome = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
      expect(outcome).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "mid_work" });
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("以明确原因拒绝非 Claude 运行时（绝不静默空操作）", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      const outcome = await enforcer.triggerManualCompact({ sessionName: "codex@rig", runtime: "codex", usedPercentage: 20 });
      expect(outcome).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "runtime_filter" });
      expect(send).not.toHaveBeenCalled();
      expect(enforcer.getManualCompactionState("codex@rig")?.stage).toBe("skipped-or-failed");
    });

    it("没有已知用量样本 → 以 no_usage_data 拒绝（绝不盲目触发）", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      const outcome = await enforcer.triggerManualCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: null });
      expect(outcome).toEqual({ triggered: false, stage: "skipped-or-failed", reason: "no_usage_data" });
      expect(send).not.toHaveBeenCalled();
    });

    it("范围限定到被触发席位：仅向该席位发送，其他席位不获得手工状态", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport);

      await enforcer.triggerManualCompact({ sessionName: "a@rig", runtime: "claude-code", usedPercentage: 20 });
      expect(send.mock.calls.every((call) => call[0] === "a@rig")).toBe(true);
      expect(enforcer.getManualCompactionState("b@rig")).toBeNull();
    });

    it("前向修复 B1：手工触发后，超过去重窗口的高于阈值自动轮询不会启动第二次准备（去重）；手工后半段仍会排空", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, {
        dedupWindowMs: 60_000,
        openrigHome: HOME,
      });

      let now = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      // 低于阈值时手工触发 → 准备 + /compact（2 次发送），植入后半段和持久的
      // 高于阈值抑制状态。
      expect(await enforcer.triggerManualCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true, stage: "compact-sent" });
      expect(send).toHaveBeenCalledTimes(2);

      // 推进到短去重窗口之后，再执行一次高于阈值的自动轮询。它必须基于
      // triggeredAboveThreshold 去重，不得启动第二次准备。
      now += 61_000;
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 95,
      })).toEqual({ triggered: false, reason: "already_triggered_above_threshold" });
      expect(send).toHaveBeenCalledTimes(2); // no third message

      // 低于阈值后，手工恢复/审计后半段仍正常排空。
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true }); // turn boundary
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("zrig 压缩后轮次边界"), { waitForIdleMs: expect.any(Number) });
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true }); // restore
      expect(await enforcer.maybeAutoCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20,
      })).toEqual({ triggered: true }); // audit
      expect(send).toHaveBeenLastCalledWith(SEAT, expect.stringContaining("审计本次压缩恢复"), { waitForIdleMs: expect.any(Number) });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
      expect(send).toHaveBeenCalledTimes(5);
    });

    it("状态呈现：序列中依次为 preparing → compact-sent → restore-sent → audit-sent", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      const { transport, send } = makeSessionTransport();
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

      // 保持阶段 1 未完成，以便观察 "preparing"。
      let resolvePrep: (v: { ok: boolean }) => void = () => {};
      send.mockImplementationOnce(() => new Promise<{ ok: boolean }>((r) => { resolvePrep = r; }));
      const pending = enforcer.triggerManualCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      });
      await Promise.resolve();
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("preparing");

      resolvePrep({ ok: true }); // prep completes; phase 2 /compact resolves ok via default mock
      expect(await pending).toEqual({ triggered: true, stage: "compact-sent" });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("compact-sent");

      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl" }); // turn boundary
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("compact-sent");
      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl" }); // restore
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("restore-sent");
      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 }); // audit
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
    });

    // slices 13–14 交付顺序缺陷的回归测试：即使恢复提示从未交付，守护进程也会呈现
    // restore-sent/audit-sent——提示在 /compact 后立即注入忙碌窗格并被丢弃，但发送仍
    // 报告成功（默认路径中 busy 是非阻塞建议）。修复：压缩后每次后半段发送都受空闲
    // 门禁（waitForIdleMs）约束；忙碌轮询不推进阶段，稍后的空闲轮询只推进一次，
    // 审计绝不能越过恢复。
    it("压缩后恢复/审计受空闲门禁约束：忙碌轮询重试同一阶段而不推进；恢复先于审计交付", async () => {
      const settings = makeSettingsStore(POLICY_ENABLED_AT_80);
      let busy = false;
      const send = vi.fn(async (_s: string, _t: string, opts?: { waitForIdleMs?: number }) => {
        // 席位忙碌时，受空闲门禁约束的发送不会交付（waitForIdle 超时）。
        if (opts?.waitForIdleMs !== undefined && busy) return { ok: false, reason: "wait_for_idle_timeout" };
        return { ok: true };
      });
      const transport = { send } as unknown as SessionTransport;
      const enforcer = new ClaudeCompactionEnforcer(settings, transport, { openrigHome: HOME });

      const isRestore = (c: unknown[]) =>
        typeof c[1] === "string" && (c[1] as string).includes("请立即响应这条普通用户消息");
      const isAudit = (c: unknown[]) =>
        typeof c[1] === "string" && (c[1] as string).includes("审计本次压缩恢复");

      // 植入引导序列（准备 + /compact）→ 阶段为 compact-sent，等待 turn_boundary。
      expect(await enforcer.triggerManualCompact({
        sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl",
      })).toEqual({ triggered: true, stage: "compact-sent" });

      // 空闲时执行 turn_boundary 轮询 → 交付；待处理状态推进到 restore_prompt
      //（阶段保持 compact-sent）。
      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl" });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("compact-sent");

      // Claude 处于忙碌状态（仍在处理边界回合）。恢复轮询不得推进。
      busy = true;
      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl" });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("compact-sent"); // busy timeout does NOT advance to restore-sent
      const restoreCall = send.mock.calls.find(isRestore);
      expect(restoreCall, "restore send must be attempted with an idle gate").toBeDefined();
      expect(restoreCall![2]).toEqual({ waitForIdleMs: expect.any(Number) }); // idle-gated, not a busy-pane fire-and-forget
      expect(send.mock.calls.some(isAudit)).toBe(false); // audit cannot overtake restore

      // Claude 变为空闲 → 同一个恢复阶段交付并仅推进一次。
      busy = false;
      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20, transcriptPath: "/tmp/claude.jsonl" });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("restore-sent");

      // 只有恢复交付后才执行审计。
      await enforcer.maybeAutoCompact({ sessionName: SEAT, runtime: "claude-code", usedPercentage: 20 });
      expect(enforcer.getManualCompactionState(SEAT)?.stage).toBe("audit-sent");
      const restoreIdx = send.mock.calls.findIndex(isRestore);
      const auditIdx = send.mock.calls.findIndex(isAudit);
      expect(restoreIdx).toBeGreaterThanOrEqual(0);
      expect(auditIdx).toBeGreaterThan(restoreIdx); // one durable restore enqueue/delivery precedes audit advancement
    });
  });
});
