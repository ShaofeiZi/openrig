// S10 切换——slice-11 锁定回执，经 relay→subsystem 切换继续承载（移植自已退役的
// cli/test/slack-orchestration.test.ts；受测语义是已锁定的持久性契约，在继任路径上必须
// 保持不变），另加双路径缺失回执：每种交付类别都只由 subsystem 路径承载
//（驱动 → 进程内线路 → chat.postMessage 交付）——relay 模块已删除（编译期缺失），
// fetch 捕获证明绝不拨用 webhook。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { InboundRouter, shouldIngest, handleEnvelope, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { seedBacklogAsHistory, type QueueItem, type OutboundQueuePort } from "../src/domain/gateway/slack/queue-access.js";
import { SlackOutboundDriver, OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { buildInProcessWire } from "../src/domain/gateway/gateway-subsystem.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p)!;
    },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-26T00:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));

const ALERT: QueueItem = {
  qitemId: "qitem-a1",
  destinationSession: "human-founder@kernel",
  tags: ["founder-alert"],
  state: "pending",
  summary: "Decide X",
  body: "full body here",
};

function fakePort(items: QueueItem[]): OutboundQueuePort & { listCalls: number } {
  const port = {
    listCalls: 0,
    async listHumanAlerts() {
      port.listCalls++;
      return items;
    },
  };
  return port;
}

/** 捕获每个出站 HTTP 调用：URL 与解析后的 JSON 正文。默认返回 2xx。 */
function capturingFetch(status = 200): { fetchImpl: FetchImpl; calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    fetchImpl: async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: status === 200, ts: "1724.0001", error: status === 200 ? undefined : "posting_failed" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/** 在临时主目录上组合真实 subsystem 出站路径：驱动 → 线路 → 交付。 */
function composeOutbound(home: string, port: OutboundQueuePort, fetchImpl: FetchImpl, fsx = memFs()) {
  const outboundSeen = new SeenStore("/s/outbound-seen.jsonl", fsx, clock);
  const delivered = new SeenStore("/s/delivered.jsonl", fsx, clock);
  const attempted = new SeenStore("/s/attempted.jsonl", fsx, clock);
  let release: (q: string) => void = () => {};
  const deliver = subsystemSlackDeliver({
    botToken: "xoxb-EXAMPLE-fake",
    channel: "C-TEST",
    sourceLabel: "vm",
    fetchImpl,
    delivered,
    attempted,
    outboundSeen,
    release: (q) => release(q),
  });
  const wire = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
  const driver = new SlackOutboundDriver({
    home,
    queue: port,
    seen: outboundSeen,
    filter: { minimumLevel: "NOTICE" },
    dispatch: (op, ref, payload) => wire.dispatcher.dispatch(op, ref, payload),
  });
  release = (q) => driver.release(q);
  return { driver, wire, outboundSeen, delivered };
}

describe("S10 切换——出站类别走 subsystem 路径（保留 slice-11 第 1、2、3 项）", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-cut-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("出站文本：新警报 → chat.postMessage（绝非 webhook）；收到 2xx 后才标记 seen", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver, outboundSeen } = composeOutbound(home, fakePort([ALERT]), fetchImpl);
    const sweep = await driver.sweepOnce();
    await flush();
    expect(sweep.dispatched).toEqual(["qitem-a1"]);
    expect(outboundSeen.load().has("qitem-a1")).toBe(true); // marked after success
    // 双路径缺失，传输层：唯一 HTTP 调用是 Web API post——无 webhook。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls.some((c) => c.url.includes("hooks.slack.com"))).toBe(false);
    expect(calls[0]!.body.channel).toBe("C-TEST");
  });

  it("第 2 项幂等：第二次扫描不发布任何内容", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([ALERT]), fetchImpl);
    await driver.sweepOnce();
    await flush();
    const s2 = await driver.sweepOnce();
    await flush();
    expect(s2.fresh).toBe(0);
    expect(calls).toHaveLength(1); // one post total
  });

  it("第 3 项失败可见：发布失败项保留在持久缓冲区且不标记 seen；恢复时精确重放", async () => {
    const bad = capturingFetch(500);
    const { driver, outboundSeen } = composeOutbound(home, fakePort([ALERT]), bad.fetchImpl);
    await driver.sweepOnce();
    await flush();
    expect(outboundSeen.load().has("qitem-a1")).toBe(false); // not dropped, not lied about
    expect(bad.calls).toHaveLength(1);
    // 后续扫描不会重复派发（进行中护栏）：重试由持久缓冲区负责。
    const s2 = await driver.sweepOnce();
    await flush();
    expect(s2.dispatched).toEqual([]);
    expect(bad.calls).toHaveLength(1);
    // 恢复 = 下一次激活通过交付重放保留的决策（不丢失）。重放属于网络操作，因此走
    // startServices()——绑定后的半程。
    const good = capturingFetch(200);
    const fsx2 = memFs();
    const next = composeOutbound(home, fakePort([]), good.fetchImpl, fsx2);
    next.wire.startServices?.();
    await flush();
    expect(good.calls).toHaveLength(1);
    expect(good.calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
  });

  it("出站图片：https evidenceRef 在同一单一路径上作为 Block Kit 图片传输（A5b）", async () => {
    const IMG = "https://example.invalid/PROGRAM-BOARD-row.png";
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([{ ...ALERT, qitemId: "qitem-img", evidenceRef: IMG }]), fetchImpl);
    await driver.sweepOnce();
    await flush();
    const blocks = (calls[0]!.body.blocks ?? []) as { type?: string; image_url?: string }[];
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]!.image_url).toBe(IMG);
  });

  it("A5b 反向对照：非 https evidenceRef 不产生图片块（卫生护栏保持有效）", async () => {
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([{ ...ALERT, qitemId: "qitem-local", evidenceRef: "/tmp/local-only.png" }]), fetchImpl);
    await driver.sweepOnce();
    await flush();
    const blocks = (calls[0]!.body.blocks ?? []) as { type?: string }[];
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0);
  });

  it("第 9 项：启用时将积压植入为历史——下次扫描不发布任何内容（无重放风暴）", async () => {
    const fsx = memFs();
    const seen = new SeenStore("/s/outbound-seen.jsonl", fsx, clock);
    const seed = await seedBacklogAsHistory({ queue: fakePort([ALERT]), seen, filter: { minimumLevel: "NOTICE" } });
    expect(seed.seeded).toBe(1);
    expect(seed.onlineStatus).toMatch(/ENABLED/);
    const { fetchImpl, calls } = capturingFetch(200);
    const { driver } = composeOutbound(home, fakePort([ALERT]), fetchImpl, fsx);
    const sweep = await driver.sweepOnce();
    expect(sweep.fresh).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("B5：植入覆盖完整积压（150 > 旧 CLI 默认值 100）", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      qitemId: `q-${i}`, destinationSession: "human-founder@kernel", tags: ["founder-alert"], state: "pending", summary: `s${i}`,
    }));
    const seen = new SeenStore("/s/seen.jsonl", memFs(), clock);
    const seed = await seedBacklogAsHistory({ queue: fakePort(many), seen, filter: { minimumLevel: "NOTICE" } });
    expect(seed.seeded).toBe(150);
    expect(seen.load().size).toBe(150);
  });
});

describe("Slice-11 入站 shouldIngest——循环安全与 T1076 非文本忽略（不变）", () => {
  const base: SlackEvent = { type: "message", user: "U1", text: "hello", ts: "1.1" };
  it("摄取真实人类消息", () => expect(shouldIngest(base)).toBe(true));
  it("摄取 app_mention", () => expect(shouldIngest({ ...base, type: "app_mention" })).toBe(true));
  it("拒绝机器人发布（循环护栏）", () => expect(shouldIngest({ ...base, bot_id: "B1" })).toBe(false));
  it("拒绝子类型（编辑/加入；自 OPR.0.5.6.2 起，带文件的 file_share 获准）", () => expect(shouldIngest({ ...base, subtype: "message_changed" })).toBe(false));
  it("OPR.0.5.6.2（替代 T1076）：准入带文件的消息——文件是工作，不是噪声", () => expect(shouldIngest({ ...base, files: [{ id: "F1" }] })).toBe(true));
  it("拒绝空白/缺失文本及无用户消息", () => {
    expect(shouldIngest({ ...base, text: "   " })).toBe(false);
    expect(shouldIngest({ ...base, user: undefined })).toBe(false);
  });
});

describe("Slice-11 入站路由——进程内队列端口上绝不丢失（第 4、8 项）", () => {
  const mk = (createBehavior: () => string | Error) => {
    let n = 0;
    const queue = {
      createQitem: async () => {
        n++;
        const r = createBehavior();
        if (r instanceof Error) throw r;
        return r;
      },
    };
    const fs = memFs();
    const seen = new SeenStore("/s/seen.jsonl", fs, clock);
    const dead = new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fs, clock);
    const router = new InboundRouter({ queue, seen, deadLetter: dead, destination: "operator-agent@kernel", resolveSender: (u) => ({ admitted: true, source: `human-${u}@kernel` }) });
    return { seen, dead, router, createCount: () => n };
  };
  const ev: SlackEvent = { type: "message", user: "U1", text: "hi team", ts: "100.1", channel: "C1" };

  it("第 4 项：人类消息 → 持久 qitem，随后标记 seen", async () => {
    const h = mk(() => "qitem-in-1");
    const r = await h.router.route(ev);
    expect(r.landed).toBe(true);
    expect(r.qitemId).toBe("qitem-in-1");
    expect(h.seen.load().has("100.1")).toBe(true);
  });

  it("第 8 项：按 ts 去重——同一事件两次仅创建一个 qitem", async () => {
    const h = mk(() => "qitem-in-1");
    await h.router.route(ev);
    await h.router.route(ev);
    expect(h.createCount()).toBe(1);
  });

  it("第 8 项：进行中护栏——并发同 ts 派发仅创建一个", async () => {
    const h = mk(() => "qitem-in-1");
    await Promise.all([h.router.route(ev), h.router.route(ev)]);
    expect(h.createCount()).toBe(1);
  });

  it("第 8 项：创建失败 → 返回前进入死信、不标记 seen、可持久保留并随后恢复", async () => {
    let fail = true;
    const h = mk(() => (fail ? new Error("daemon busy") : "qitem-in-9"));
    const r = await h.router.route(ev);
    expect(r.landed).toBe(false);
    expect(h.seen.load().has("100.1")).toBe(false);
    const peek = h.dead.readAll();
    expect(peek).toHaveLength(1);
    expect(peek[0]!.attempts).toBe(1);
    expect(h.dead.readAll()).toHaveLength(1); // non-destructive read
    fail = false;
    const rr = await h.router.retryDeadLetters();
    expect(rr.landed).toBe(1);
    expect(h.seen.load().has("100.1")).toBe(true);
    expect(h.dead.readAll()).toHaveLength(0);
  });

  it("第 8 项：多次失败仍零丢失", async () => {
    const h = mk(() => new Error("still down"));
    await h.router.route(ev);
    for (let round = 0; round < 4; round++) await h.router.retryDeadLetters();
    const remaining = h.dead.readAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.attempts).toBeGreaterThanOrEqual(5);
  });
});

describe("Slice-11 入站 handleEnvelope——快速确认（第 8 项，不变）", () => {
  const mkRouter = () => {
    const fs = memFs();
    return new InboundRouter({
      queue: { createQitem: async () => "qitem-x" },
      seen: new SeenStore("/s/seen.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/s/dead.jsonl", fs, clock),
      destination: "operator-agent@kernel",
      resolveSender: (u) => ({ admitted: true, source: `human-${u}@kernel` }),
    });
  };

  it("确认每个带 ID 的信封——即使它不可摄取", async () => {
    let acked = 0;
    await handleEnvelope({ envelope_id: "e1", type: "events_api", payload: { event: { type: "message", bot_id: "B", ts: "1" } } }, () => acked++, mkRouter());
    expect(acked).toBe(1);
  });

  it("先确认，再路由人类消息", async () => {
    let acked = 0;
    await handleEnvelope(
      { envelope_id: "e2", type: "events_api", payload: { event: { type: "message", user: "U1", text: "hi", ts: "2.2", channel: "C1" } } },
      () => acked++,
      mkRouter(),
    );
    expect(acked).toBe(1);
  });

  it("确认断开连接信封且不路由", async () => {
    let acked = 0;
    await handleEnvelope({ envelope_id: "e3", type: "disconnect", reason: "refresh" }, () => acked++, mkRouter());
    expect(acked).toBe(1);
  });
});

describe("P28——忽略路径遥测区分拒绝分支（不变）", () => {
  const mkRouterStub = () =>
    new InboundRouter({
      queue: { createQitem: async () => "qitem-p28" },
      seen: new SeenStore("/s/p28.jsonl", memFs(), clock),
      deadLetter: new DeadLetterStore("/s/p28d.jsonl", memFs(), clock),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
    });

  async function logFor(ev: Record<string, unknown>): Promise<string> {
    const lines: string[] = [];
    await handleEnvelope({ envelope_id: "e", type: "events_api", payload: { event: ev } }, () => {}, mkRouterStub(), (m) => lines.push(m));
    return lines.join("\n");
  }

  it("指明频道和 bot_id 分支", async () => {
    const out = await logFor({ type: "message", bot_id: "B1", user: "U1", text: "x", channel: "C090L0VFB0U" });
    expect(out).toContain("channel=C090L0VFB0U");
    expect(out).toContain("reason=bot_id");
  });

  it("明确区分用户缺失分支（不与 bot_id 混淆）", async () => {
    const out = await logFor({ type: "message", text: "x", channel: "D0BLHF6VC86" });
    expect(out).toContain("channel=D0BLHF6VC86");
    expect(out).toContain("reason=no-user");
    expect(out).not.toContain("reason=bot_id");
  });

  it("明确区分空文本分支", async () => {
    const out = await logFor({ type: "message", user: "U1", text: "   ", channel: "C3" });
    expect(out).toContain("reason=empty-text");
    expect(out).not.toContain("reason=no-user");
  });

  it("隐私护栏：绝不泄漏用户 ID 或消息文本", async () => {
    const out = await logFor({ type: "message", user: "U09DAG5D14M", text: "secret body text", channel: "C4" });
    expect(out).not.toContain("U09DAG5D14M");
    expect(out).not.toContain("secret body text");
  });
});
