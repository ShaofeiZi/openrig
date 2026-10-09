import { describe, it, expect } from "vitest";
import {
  postWebhook,
  callWebApi,
  verifyScopes,
  verifyChannelMembership,
  openSocketConnection,
  type FetchImpl,
} from "../src/domain/gateway/slack/slack-api.js";

// 伪 Slack：按 URL 路由，返回真实 Response 对象（headers + JSON）。
function fakeSlack(spec: {
  webhookStatus?: number;
  scopesHeader?: string; // value of x-oauth-scopes
  methods?: Record<string, { status?: number; json: Record<string, unknown> }>;
  throwOn?: string;
}): FetchImpl {
  return async (url) => {
    if (spec.throwOn && url.includes(spec.throwOn)) throw new Error("ECONNREFUSED");
    if (url.includes("hooks.slack.com") || (!url.includes("slack.com/api/") && url.startsWith("http"))) {
      const st = spec.webhookStatus ?? 200;
      return new Response(st === 200 ? "ok" : `err ${st}`, { status: st });
    }
    const method = url.split("/api/")[1]!.split("?")[0]!; // S10 shape-fix: read methods carry query args
    const m = spec.methods?.[method] ?? { status: 200, json: { ok: true } };
    const headers = new Headers({ "content-type": "application/json" });
    if (spec.scopesHeader !== undefined) headers.set("x-oauth-scopes", spec.scopesHeader);
    return new Response(JSON.stringify(m.json), { status: m.status ?? 200, headers });
  };
}

describe("Slice-11 slack-api —— 失败可见的 webhook（条目 3）", () => {
  it("200 → ok", async () => {
    expect((await postWebhook("https://hooks.slack.com/x", { text: "hi" }, fakeSlack({ webhookStatus: 200 }))).ok).toBe(true);
  });
  it("非 2xx 返回 ok:false 和有界错误（失败可见）", async () => {
    const r = await postWebhook("https://hooks.slack.com/x", { text: "hi" }, fakeSlack({ webhookStatus: 500 }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("slack 500");
  });
  it("传输抛错返回 ok:false 与状态 0（异常不越过边界）", async () => {
    const r = await postWebhook("https://hooks.slack.com/x", { text: "hi" }, fakeSlack({ throwOn: "hooks" }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe("Slice-11 slack-api —— 从响应头获取已授权 scope（条目 5，设置陷阱）", () => {
  it("从响应头而非配置读取 x-oauth-scopes", async () => {
    const r = await callWebApi("auth.test", "xoxb-t", {}, fakeSlack({ scopesHeader: "incoming-webhook,chat:write", methods: { "auth.test": { json: { ok: true, user: "bot" } } } }));
    expect(r.ok).toBe(true);
    expect(r.grantedScopes).toEqual(["incoming-webhook", "chat:write"]);
  });

  it("捕获设置陷阱：已配置不等于已授权，仅 webhook 安装会缺少机器人 scope", async () => {
    // 模拟 Add-New-Webhook：只授予 incoming-webhook，尚未重装。
    const fetchImpl = fakeSlack({ scopesHeader: "incoming-webhook", methods: { "auth.test": { json: { ok: true } } } });
    const v = await verifyScopes("xoxb-t", ["chat:write", "channels:read"], fetchImpl);
    expect(v.ok).toBe(false);
    expect(v.missing.sort()).toEqual(["channels:read", "chat:write"]);
    expect(v.granted).toEqual(["incoming-webhook"]);
  });

  it("所有必需 scope 均存在时返回 ok", async () => {
    const fetchImpl = fakeSlack({ scopesHeader: "chat:write,channels:read,channels:history", methods: { "auth.test": { json: { ok: true } } } });
    const v = await verifyScopes("xoxb-t", ["chat:write", "channels:read"], fetchImpl);
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it("令牌无效时返回带错误的非 ok 判定，绝不误报通过", async () => {
    const fetchImpl = fakeSlack({ scopesHeader: "", methods: { "auth.test": { status: 200, json: { ok: false, error: "invalid_auth" } } } });
    const v = await verifyScopes("bad", ["chat:write"], fetchImpl);
    expect(v.ok).toBe(false);
    expect(v.error).toBe("invalid_auth");
  });
});

describe("Slice-11 slack-api —— 频道成员关系与 socket（条目 5，入站）", () => {
  it("verifyChannelMembership 如实反映 is_member", async () => {
    const inFetch = fakeSlack({ methods: { "conversations.info": { json: { ok: true, channel: { is_member: true, name: "founder" } } } } });
    const inR = await verifyChannelMembership("xoxb-t", "C1", inFetch);
    expect(inR).toMatchObject({ ok: true, isMember: true, name: "founder" });

    const outFetch = fakeSlack({ methods: { "conversations.info": { json: { ok: true, channel: { is_member: false } } } } });
    expect((await verifyChannelMembership("xoxb-t", "C1", outFetch)).isMember).toBe(false);
  });

  it("openSocketConnection 返回 WebSocket URL", async () => {
    const fetchImpl = fakeSlack({ methods: { "apps.connections.open": { json: { ok: true, url: "wss://slack/ws" } } } });
    const r = await openSocketConnection("xapp-t", fetchImpl);
    expect(r).toMatchObject({ ok: true, url: "wss://slack/ws" });
  });

  it("openSocketConnection 呈现错误判定", async () => {
    const fetchImpl = fakeSlack({ methods: { "apps.connections.open": { json: { ok: false, error: "not_allowed_token_type" } } } });
    const r = await openSocketConnection("xoxb-wrong", fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_allowed_token_type");
  });
});
