// S10——故障下的持久性，固定验证重复不存在（证明契约）：
//   1. 人为触发 Slack API TIMEOUT → 重试在发送前按标记协调：找到标记 → 不重发直接 ack
//     （超时请求实际已送达）；未找到标记 → 发送一次。绝不盲目重发；channel 不可读时继续保留
//     （只延迟，绝不重复）。
//   2. 在 persist 与 dispatch 之间人为触发 CRASH → 下次激活的 replay 恰好投递一次；
//      第二次 replay 不再次 post，直接重新 ack。
// 任何重复的人工通知都会使测试变 red。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { buildInProcessWire } from "../src/domain/gateway/gateway-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { OUTBOUND_OP, type OutboundPostPayload } from "../src/domain/gateway/slack/outbound-driver.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-27T00:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));
const activeCount = (s: string, form: string): number => s.split(form).length - 1;

/** Slack 测试替身可让首次 post TIMEOUT（可选择实际送达或未送达）、通过 conversations.history
 *  返回已送达文本，并统计真实 post 次数。 */
function slackDouble(opts: { timeoutFirstPost: boolean; timeoutLanded: boolean; historyReadable?: boolean; extraHistory?: string[] }) {
  const posted: string[] = []; // 实际已送达 "Slack" 的文本
  let postCalls = 0;
  const fetchImpl: FetchImpl = async (url, init) => {
    if (url.endsWith("chat.postMessage")) {
      postCalls++;
      const text = String((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "");
      if (opts.timeoutFirstPost && postCalls === 1) {
        if (opts.timeoutLanded) posted.push(text); // 实际已送达——但发送方并不知道
        throw new Error("timeout after 15000ms"); // 结果存在歧义
      }
      posted.push(text);
      return new Response(JSON.stringify({ ok: true, ts: `${1000 + postCalls}.1` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("conversations.history")) { // S10 shape-fix：读取扫描现在使用 GET + query
      if (opts.historyReadable === false) {
        return new Response(JSON.stringify({ ok: false, error: "channel_unreadable" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // History = channel 中的其他内容（普通协调文本）+ 已送达 post。
      const texts = [...(opts.extraHistory ?? []), ...posted];
      return new Response(JSON.stringify({ ok: true, messages: texts.map((t) => ({ text: t })) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, posted, postCount: () => postCalls };
}

function harness(fetchImpl: FetchImpl) {
  const fsx = memFs();
  const outboundSeen = new SeenStore("/seen.jsonl", fsx, clock);
  const deliver = subsystemSlackDeliver({
    botToken: "xoxb-EXAMPLE-fake",
    channel: "C1",
    sourceLabel: "vm",
    fetchImpl,
    delivered: new SeenStore("/del.jsonl", fsx, clock),
    attempted: new SeenStore("/att.jsonl", fsx, clock),
    outboundSeen,
  });
  return { deliver, outboundSeen };
}
const payload: OutboundPostPayload = { qitemId: "qitem-dur-1", summary: "Decide X", body: "b", destinationSession: "mike@external", sourceSession: "dev-driver@v-openrig-build" };
const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "d-dur-1", op: OUTBOUND_OP, entityBindingRef: "mike#slack", payload };

describe("H1——人为超时 → 按标记协调，绝不盲目重发", () => {
  it("已送达但超时：重试找到 qitem 标记，不重发而直接 ACK——恰好一个人工通知", async () => {
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: true });
    const { deliver, outboundSeen } = harness(slack.fetchImpl);
    const first = await deliver(decision);
    expect(first.ok).toBe(false); // 歧义结果呈现为失败类别 → 保留
    expect(slack.posted).toHaveLength(1); // 但实际已送达 Slack
    const retry = await deliver(decision); // replay
    expect(retry.ok).toBe(true); // 已协调：找到标记 → ack
    expect(slack.posted).toHaveLength(1); // 不存在重复：仍恰好一条消息
    expect(slack.postCount()).toBe(1); // 甚至没有尝试第二次 post
    expect(outboundSeen.load().has("qitem-dur-1")).toBe(true); // 通过协调确认已见 qitem
  });

  it("超时且未送达：重试找不到标记并发送一次", async () => {
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: false });
    const { deliver } = harness(slack.fetchImpl);
    expect((await deliver(decision)).ok).toBe(false);
    expect(slack.posted).toHaveLength(0); // 确实丢失
    const retry = await deliver(decision);
    expect(retry.ok).toBe(true);
    expect(slack.posted).toHaveLength(1); // 恰好投递一次
  });

  it("F-B1r MARKER EFFECT：包含危险内容的 qitemId 在送达后超时时按转义标记协调——producer 与 scanner 比较相同字节，不重发且绝不发布活跃语法", async () => {
    // 第 2 轮字节保真要求，由效果固定：footer 现在发布转义后的 ID，因此协调扫描必须搜索转义形式；
    // 否则已送达、包含危险内容的 ID post 会被遗漏并重发（重复人工通知——H red）。对于生成的 ID，
    // escaped == raw，因此行为不变。
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: true });
    const { deliver, outboundSeen } = harness(slack.fetchImpl);
    const hostile: OutboundDecision = {
      kind: "outbound_decision", decisionId: "d-hostile-marker", op: OUTBOUND_OP, entityBindingRef: "mike#slack",
      payload: { ...payload, qitemId: "<!channel>" },
    };
    const first = await deliver(hostile);
    expect(first.ok).toBe(false); // 歧义超时 → 保留
    expect(slack.posted).toHaveLength(1); // 但实际已送达
    expect(activeCount(slack.posted[0]!, "<!channel>"), "the landed post itself must carry no active syntax").toBe(0);
    const retry = await deliver(hostile);
    expect(retry.ok).toBe(true); // 已协调：转义标记匹配已送达字节
    expect(slack.posted).toHaveLength(1); // 不存在重复：始终恰好一条消息
    expect(outboundSeen.load().has("<!channel>")).toBe(true); // 通过协调确认已见 qitem
  });

  it("协调扫描 UNREADABLE：保留（延迟），绝不盲目重发", async () => {
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: true, historyReadable: false });
    const { deliver } = harness(slack.fetchImpl);
    await deliver(decision);
    const retry = await deliver(decision);
    expect(retry.ok).toBe(false);
    expect((retry as { class: string }).class).toBe("reconcile-unreadable");
    expect(slack.posted).toHaveLength(1); // 已送达副本始终是唯一副本
  });
});

describe("R2 第 3 轮——协调身份具有结构性：保证存在于扫描范围，并限定到目标消息（仅普通数据）", () => {
  it("EFFECT A：有效的超长 routine summary（2900 单位）+ 已送达但超时 → 恰好一个已送达副本，零重发（完整回退可容纳该身份）", async () => {
    const slack = slackDouble({ timeoutFirstPost: true, timeoutLanded: true });
    const { deliver } = harness(slack.fetchImpl);
    const longRow: OutboundDecision = {
      kind: "outbound_decision", decisionId: "d-long-summary", op: OUTBOUND_OP, entityBindingRef: "mike#slack",
      payload: { ...payload, qitemId: "qitem-routine-long-summary", summary: "s".repeat(2900), body: "ordinary body" },
    };
    const first = await deliver(longRow);
    expect(first.ok).toBe(false); // 歧义超时 → 保留
    expect(slack.posted).toHaveLength(1); // 但实际已送达，且回退文本达到上限
    const retry = await deliver(longRow);
    expect(retry.ok).toBe(true);
    expect(slack.posted, "不存在重复：必须识别已送达的长 summary post，绝不重发").toHaveLength(1);
  });

  it("EFFECT B：无关的 routine 文本引用 ID + 超时且未送达 → 绝不错误 ack；重试时目标恰好 post 一次", async () => {
    const slack = slackDouble({
      timeoutFirstPost: true,
      timeoutLanded: false,
      extraHistory: ["status: qitem-routine-target is waiting on another lane"], // 普通协调文本
    });
    const { deliver } = harness(slack.fetchImpl);
    const target: OutboundDecision = {
      kind: "outbound_decision", decisionId: "d-target", op: OUTBOUND_OP, entityBindingRef: "mike#slack",
      payload: { ...payload, qitemId: "qitem-routine-target", summary: "short summary", body: "b" },
    };
    const first = await deliver(target);
    expect(first.ok).toBe(false);
    expect(slack.posted).toHaveLength(0); // 确实丢失——只存在无关引用
    const retry = await deliver(target);
    expect(retry.ok).toBe(true);
    expect(slack.posted, "引用不得满足协调条件——目标本身必须 post").toHaveLength(1);
    expect(slack.posted[0]).toContain("short summary"); // 已送达副本是目标，而非虚假匹配
  });

  it("SCOPING：包含 qitem ID 和相似 token 形态的文本不能匹配——只有精确限定到 decision 的 token 可以；且 token 在最长消息中仍保留", async () => {
    const slack = slackDouble({
      timeoutFirstPost: true,
      timeoutLanded: false,
      extraHistory: [
        "quoting qitem-routine-scope in prose",
        "even a lookalike (or-mark:qitem-routine-scope) built from the QITEM id must not match",
      ],
    });
    const { deliver } = harness(slack.fetchImpl);
    const scoped: OutboundDecision = {
      kind: "outbound_decision", decisionId: "d-scope-check", op: OUTBOUND_OP, entityBindingRef: "mike#slack",
      payload: { ...payload, qitemId: "qitem-routine-scope", summary: "x".repeat(900), body: "y".repeat(2900) },
    };
    await deliver(scoped);
    const retry = await deliver(scoped);
    expect(retry.ok).toBe(true);
    expect(slack.posted).toHaveLength(1); // 尽管有两个干扰项仍成功 post（无错误 ack）
    // 已发布的最长文本仍在长度上限内携带协调身份：
    expect(slack.posted[0]!.length).toBeLessThanOrEqual(3900);
    expect(slack.posted[0]).toContain("d-scope-check"); // 限定到 decision 的 token 保留在完整回退中
  });
});

describe("H2——persist 与 dispatch 之间崩溃 → replay 恰好投递一次", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-dur-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("已持久化但从未 dispatch 的 decision 在 replay 时投递一次；第二次激活不再次 post，直接重新 ack", async () => {
    // CRASH WINDOW：decision 已进入持久 buffer，但进程在发送前终止。
    new DispatchBuffer(home).enqueue(decision);
    const slack = slackDouble({ timeoutFirstPost: false, timeoutLanded: false });
    const { deliver } = harness(slack.fetchImpl);
    // 第 1 次激活：replay 将其投递。
    const w1 = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    w1.startServices?.();
    await flush();
    expect(slack.posted).toHaveLength(1);
    expect(new DispatchBuffer(home).pending()).toHaveLength(0); // ack 后已清除
    // 第 2 次激活（生产环境会共享同一持久 store；此处 buffer 为空）：
    const w2 = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    w2.startServices?.();
    await flush();
    expect(slack.posted).toHaveLength(1); // 始终恰好一次
  });

  it("delivery 后、ack 清除 buffer 前崩溃：replay 通过 delivered-store 重新 ack，不重复 post", async () => {
    const slack = slackDouble({ timeoutFirstPost: false, timeoutLanded: false });
    const { deliver } = harness(slack.fetchImpl);
    // 通过 replay 持久化并投递（将 decisionId 固定为 d-dur-1）。
    new DispatchBuffer(home).enqueue(decision);
    const w1 = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    w1.startServices?.();
    await flush();
    expect(slack.posted).toHaveLength(1);
    // CRASH WINDOW：delivered.mark 已发生，但 ack-drain 尚未发生——同一 decision 再次持久保留，
    // 等待下次激活。
    new DispatchBuffer(home).enqueue(decision);
    const w2 = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    w2.startServices?.();
    await flush();
    // delivered-store 对 decisionId d-dur-1 重新 ack，而不进行第二次 post。
    expect(slack.posted).toHaveLength(1);
    expect(slack.posted.filter((t) => t.includes("(or-mark:d-dur-1)"))).toHaveLength(1);
  });
});
