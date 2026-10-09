// OPR.0.5.6.2 —— 入站图片/文件：双向图片功能中此前推迟的一半。T1076 接缝会干净地
// 忽略带文件事件（ingestDecision 先拒绝 subtype file_share，再拒绝 files[]），因此人类
// 当前向已映射线程投递图片不会产生任何行。这些测试固定如下契约：回复行携带下载到
// 工作区的本地副本及其本地路径（绝不是 Slack URL；按 ToS，Slack 不拥有该副本）；
// 下载失败会如实具名报告，绝不静默丢弃消息或文件；多个文件仍可逐一归因；未映射线程
// 沿用 slice 10 的 unrouted-signal 路径并包含文件；循环安全（机器人消息、编辑 subtype）
// 保持不变。基础版本为红：行落地测试会在准入层失败。
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { InboundRouter, ingestDecision, handleEnvelope, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { makeInboundFilePort } from "../src/domain/gateway/slack/slack-subsystem.js";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 9, 9]);
const MEDIA_DIR = "/media/slack-inbound";

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    existsSync: (p: string) => files.has(p),
    writeFileSync: (p: string, d: string) => { files.set(p, d); },
    appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) ?? "") + d); },
    rename: (a: string, b: string) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-30T01:40:00Z");

/** Slack 传输桩：URL → 字节，或注入失败。 */
function stubFetch(routes: Record<string, Uint8Array | { status: number } | { html: true }>) {
  const seenAuth: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    seenAuth.push(String((init?.headers as Record<string, string> | undefined)?.["authorization"] ?? ""));
    const hit = routes[url];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (hit instanceof Uint8Array) return new Response(hit.slice().buffer as ArrayBuffer, { status: 200, headers: { "content-type": "application/octet-stream" } });
    if ("html" in hit) return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    return new Response("err", { status: hit.status });
  };
  return { fetchImpl, seenAuth };
}

interface Landed { source: string; destination: string; tags?: string[]; summary: string; body: string }

function harness(opts?: {
  routes?: Record<string, Uint8Array | { status: number } | { html: true }>;
  mapped?: Record<string, string>;
}) {
  const fs = memFs();
  const rows: Landed[] = [];
  const logs: string[] = [];
  const media = new Map<string, Uint8Array>();
  const { fetchImpl, seenAuth } = stubFetch(opts?.routes ?? {});
  const filePort = makeInboundFilePort({
    token: "xoxb-test-token",
    mediaDir: MEDIA_DIR,
    fetchImpl,
    mkdirp: () => {},
    writeFile: (p: string, bytes: Uint8Array) => { media.set(p, bytes); },
    log: (m: string) => logs.push(m),
  });
  const threadMap = {
    resolveByThread: (threadTs: string) => (opts?.mapped?.[threadTs] ? { seat: opts.mapped[threadTs]!, state: "open" } : null),
  } as never;
  const router = new InboundRouter({
    queue: { createQitem: async (input: Landed) => { rows.push(input); return `qitem-f-${rows.length}`; } },
    seen: new SeenStore("/s.jsonl", fs, clock),
    deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock),
    destination: "operator-agent@kernel",
    resolveSender: () => ({ admitted: true, source: "founder@humans" }),
    resolveRoute: makeThreadRouteResolver({
      map: threadMap,
      unroutedDestination: "orch-lead@v-openrig-build",
      log: (m: string) => logs.push(m),
    }),
    files: filePort,
    log: (m: string) => logs.push(m),
  } as never);
  return { router, rows, media, logs, seenAuth };
}

/** 最外层真实入口：Socket 信封 → 快速确认 → ingestDecision → route。行测试必须经过
 *  这条路径，使准入回归无法隐藏在直接调用 route() 的测试之后。 */
async function deliver(h: ReturnType<typeof harness>, ev: SlackEvent): Promise<void> {
  await handleEnvelope({ envelope_id: "env-1", type: "events_api", payload: { event: ev } }, () => {}, h.router);
}

const F_IMG = { id: "F1", name: "whiteboard sketch.png", mimetype: "image/png", url_private: "https://files.slack.com/files-pri/T1-F1/sketch.png" };
const F_PDF = { id: "F2", name: "notes.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/files-pri/T1-F2/notes.pdf" };

const fileEvent = (over?: Partial<SlackEvent>): SlackEvent => ({
  type: "message",
  subtype: "file_share",
  user: "U1",
  text: "",
  ts: "500.1",
  channel: "C1",
  thread_ts: "400.0",
  files: [F_IMG],
  ...over,
});

describe("入站文件：准入（取代 T1076 接缝）", () => {
  it("准入带 files 的 file_share 消息（目标场景）", () => {
    expect(ingestDecision(fileEvent()).ingest).toBe(true);
  });
  it("准入文本为空的纯文件消息（纯文件投递没有说明文字）", () => {
    expect(ingestDecision(fileEvent({ text: "" })).ingest).toBe(true);
  });
  it("循环安全保持不变：仍拒绝机器人发送的文件消息", () => {
    const d = ingestDecision(fileEvent({ bot_id: "B9" }));
    expect(d.ingest).toBe(false);
    if (!d.ingest) expect(d.reason).toBe("bot_id");
  });
  it("仍拒绝非文件 subtype（message_changed）", () => {
    const d = ingestDecision({ type: "message", subtype: "message_changed", user: "U1", text: "edit", ts: "1.1", channel: "C1" });
    expect(d.ingest).toBe(false);
    if (!d.ingest) expect(d.reason).toBe("subtype");
  });
});

describe("入站文件：行中携带本地副本，绝不携带 Slack URL", () => {
  it("向已映射线程发送单张图片：行携带本地路径，文件字节哈希与原文件一致", async () => {
    const h = harness({
      routes: { [F_IMG.url_private]: PNG_BYTES },
      mapped: { "400.0": "dev50-driver@v-openrig-build" },
    });
    await deliver(h, fileEvent());
    expect(h.rows, "回复行必须落地（红灯基线：当前准入逻辑忽略文件事件）").toHaveLength(1);
    const body = h.rows[0]!.body;
    const stored = [...h.media.keys()];
    expect(stored, "只存储一个媒体文件").toHaveLength(1);
    expect(stored[0]!.startsWith(MEDIA_DIR + "/"), "文件存储在媒体目录内").toBe(true);
    expect(body, "行引用本地路径").toContain(stored[0]!);
    expect(sha(h.media.get(stored[0]!)!), "字节哈希与原文件一致").toBe(sha(PNG_BYTES));
    expect(h.seenAuth.some((a) => a === "Bearer xoxb-test-token"), "下载使用机器人令牌完成认证").toBe(true);
  });

  it("多个文件仍可逐一归因，图片加文本时保留文本", async () => {
    const h = harness({
      routes: { [F_IMG.url_private]: PNG_BYTES, [F_PDF.url_private]: PDF_BYTES },
      mapped: { "400.0": "dev50-driver@v-openrig-build" },
    });
    await deliver(h, fileEvent({ text: "see attached, both of them", files: [F_IMG, F_PDF] }));
    expect(h.rows).toHaveLength(1);
    const body = h.rows[0]!.body;
    expect(body).toContain("see attached, both of them");
    const stored = [...h.media.keys()];
    expect(stored).toHaveLength(2);
    for (const p of stored) expect(body).toContain(p);
    expect(sha(h.media.get(stored.find((p) => p.includes("notes"))!)!)).toBe(sha(PDF_BYTES));
  });

  it("非图片文件沿用相同机制", async () => {
    const h = harness({ routes: { [F_PDF.url_private]: PDF_BYTES }, mapped: { "400.0": "x@y" } });
    await deliver(h, fileEvent({ files: [F_PDF] }));
    expect(h.rows).toHaveLength(1);
    expect([...h.media.keys()]).toHaveLength(1);
  });

  it("反向保证：生成的行绝不以任何形式引用 Slack URL", async () => {
    const h = harness({
      routes: { [F_IMG.url_private]: PNG_BYTES, [F_PDF.url_private]: PDF_BYTES },
      mapped: { "400.0": "x@y" },
    });
    await deliver(h, fileEvent({ text: "one", files: [F_IMG], ts: "500.1" }));
    await deliver(h, fileEvent({ text: "two", files: [F_IMG, F_PDF], ts: "500.2" }));
    await deliver(h, fileEvent({ text: "three", files: [F_PDF], ts: "500.3" }));
    expect(h.rows.length, "只有对已落地的行执行遍历才有意义").toBeGreaterThanOrEqual(3);
    for (const row of h.rows) {
      const joined = `${row.summary}\n${row.body}`;
      // 正向保证：每个带文件的行至少携带一个本地副本。
      expect([...h.media.keys()].some((p) => joined.includes(p)), "每行都携带本地媒体路径").toBe(true);
      expect(joined).not.toMatch(/url_private/);
      expect(joined).not.toMatch(/files\.slack\.com|slack\.com\/files|hooks\.slack\.com/);
      expect(joined, "机器人令牌绝不会进入行").not.toContain("xoxb-test-token");
    }
  });
});

describe("入站文件：如实呈现失败（绝不静默丢弃）", () => {
  it("注入下载失败时，行仍携带文本及逐文件具名失败，正常的同批文件仍会存储", async () => {
    const h = harness({
      routes: { [F_IMG.url_private]: { status: 403 }, [F_PDF.url_private]: PDF_BYTES },
      mapped: { "400.0": "x@y" },
    });
    await deliver(h, fileEvent({ text: "the message must survive", files: [F_IMG, F_PDF] }));
    expect(h.rows, "消息绝不会因为传输失败而消失").toHaveLength(1);
    const body = h.rows[0]!.body;
    expect(body).toContain("the message must survive");
    expect(body, "每个文件的失败都有明确名称").toContain("文件传输失败");
    expect(body).toContain("whiteboard sketch.png");
    expect([...h.media.keys()], "正常文件仍会存储并可单独归因").toHaveLength(1);
    expect(body).toContain([...h.media.keys()][0]!);
    expect(body).not.toMatch(/url_private|files\.slack\.com/);
  });

  it("R1 F1：在发起请求前拒绝仿冒域名，令牌绝不会发送到 evilslack.com", async () => {
    const EVIL = "https://evilslack.com/files-pri/T1-FX/steal.png";
    const h = harness({ routes: { [EVIL]: PNG_BYTES }, mapped: { "400.0": "x@y" } });
    await deliver(h, fileEvent({ files: [{ id: "FX", name: "steal.png", mimetype: "image/png", url_private: EVIL }] }));
    expect(h.rows, "消息仍会落地").toHaveLength(1);
    expect(h.rows[0]!.body).toContain("文件传输失败");
    expect(h.rows[0]!.body).toContain("并非 Slack URL");
    expect(h.seenAuth, "没有请求离开边界，Bearer 令牌从未外发").toHaveLength(0);
    expect([...h.media.keys()]).toHaveLength(0);
  });

  it("R1 F2：文件端口抛出异常也不会丢失已确认消息，行会落地并逐文件记录具名失败", async () => {
    const h = harness({ mapped: { "400.0": "x@y" } });
    (h.router as unknown as { deps: { files: { transfer: () => Promise<never> } } }).deps.files = {
      transfer: async () => { throw new Error("ENOSPC: no space left on device"); },
    };
    await deliver(h, fileEvent({ text: "must survive a crashing port", files: [F_IMG, F_PDF] }));
    expect(h.rows, "即使端口崩溃，行仍会落地").toHaveLength(1);
    const body = h.rows[0]!.body;
    expect(body).toContain("must survive a crashing port");
    expect(body).toContain("文件传输崩溃");
    expect(body).toContain("whiteboard sketch.png");
    expect(body).toContain("notes.pdf");
    expect(body).toContain("ENOSPC");
  });

  it("识别伪装成 HTML 的认证失败并具名报告，不把垃圾内容存为文件", async () => {
    const h = harness({ routes: { [F_IMG.url_private]: { html: true } }, mapped: { "400.0": "x@y" } });
    await deliver(h, fileEvent());
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.body).toContain("文件传输失败");
    expect([...h.media.keys()], "绝不把 HTML 登录页存为目标文件").toHaveLength(0);
  });
});

describe("入站文件：未映射线程复用 slice-10 的 unrouted-signal 路径并包含文件", () => {
  it("未映射线程中的文件事件路由到未路由目标，携带 unrouted-signal 标签和附件", async () => {
    const h = harness({ routes: { [F_IMG.url_private]: PNG_BYTES }, mapped: {} });
    await deliver(h, fileEvent({ thread_ts: "999.9" }));
    expect(h.rows).toHaveLength(1);
    const row = h.rows[0]!;
    expect(row.destination).toBe("orch-lead@v-openrig-build");
    expect(row.tags ?? [], "沿用 slice 10 的 unrouted-signal 标签，不为文件设置特例").toContain("unrouted-signal");
    expect([...h.media.keys()]).toHaveLength(1);
    expect(row.body).toContain([...h.media.keys()][0]!);
  });
});
