// S10 post-seal request-shape 修复——RED-first。操作员 live 测量（testimony，在此镜像为 fixture——
// 无 credential，不访问 live Slack）：通过 JSON POST 调用 conversations.info 时 Slack 返回
// `invalid_arguments`；相同 token/channel 改用 GET + URL query 时返回 ok + is_member。callWebApi 始终
// 发出 JSON POST，导致 `rig slack verify` 对正确 membership 误报失败。
//
// 已提交的 discriminator 锁定 REQUEST SHAPE（method、URL/query、header、无 body）与效果
//（verifyChannelMembership 从受支持形态返回正确 is_member），同时 JSON-POST family（auth.test、
// apps.connections.open、chat.postMessage、files.completeUploadExternal）保持字节级相同的 POST。
import { describe, it, expect } from "vitest";
import {
  verifyChannelMembership,
  fetchRecentMessageTexts,
  getGrantedScopes,
  postChatMessage,
  type FetchImpl,
} from "../src/domain/gateway/slack/slack-api.js";

interface Captured { url: string; method: string; headers: Record<string, string>; body: string | undefined }

/** 强制 read method 实测 live 契约的 fake Slack：JSON POST → invalid_arguments；GET + query → ok。
 *  JSON-POST family method 与此前一样接受 POST。 */
function shapeEnforcingSlack(): { fetchImpl: FetchImpl; calls: Captured[] } {
  const calls: Captured[] = [];
  const READ_METHODS = ["conversations.info", "conversations.history", "conversations.replies"];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const body = init?.body === undefined ? undefined : String(init.body);
      calls.push({ url, method, headers, body });
      const apiMethod = url.replace("https://slack.com/api/", "").split("?")[0]!;
      const isRead = READ_METHODS.includes(apiMethod);
      const jsonHeaders = { "content-type": "application/json" };
      if (isRead && (method !== "GET" || body !== undefined)) {
        // 实测 live 行为：read endpoint 拒绝 JSON-POST 形态。
        return new Response(JSON.stringify({ ok: false, error: "invalid_arguments" }), { status: 200, headers: jsonHeaders });
      }
      if (apiMethod === "conversations.info") {
        const channel = new URL(url).searchParams.get("channel");
        return new Response(JSON.stringify({ ok: true, channel: { is_member: channel === "C-MEMBER", name: "ops" } }), { status: 200, headers: { ...jsonHeaders, "x-oauth-scopes": "chat:write,channels:read" } });
      }
      if (apiMethod === "conversations.history" || apiMethod === "conversations.replies") {
        return new Response(JSON.stringify({ ok: true, messages: [{ text: "hello (or-mark:d-shape)" }] }), { status: 200, headers: jsonHeaders });
      }
      // JSON-POST family：原样接受。
      return new Response(JSON.stringify({ ok: true, ts: "1.1", url: "wss://fake" }), { status: 200, headers: { ...jsonHeaders, "x-oauth-scopes": "chat:write" } });
    },
  };
}

describe("request shape——READ method 使用 GET + URL query（受支持的 live 形态）", () => {
  it("conversations.info：GET、channel 位于 query、带 Authorization header、无 body、无 JSON content-type，并返回正确 is_member", async () => {
    const { fetchImpl, calls } = shapeEnforcingSlack();
    const r = await verifyChannelMembership("xoxb-EXAMPLE-fake", "C-MEMBER", fetchImpl);
    expect(r.ok, "受支持形态不得误报失败").toBe(true);
    expect(r.isMember).toBe(true);
    const c = calls[0]!;
    expect(c.method).toBe("GET");
    expect(c.url).toContain("https://slack.com/api/conversations.info?");
    expect(new URL(c.url).searchParams.get("channel")).toBe("C-MEMBER");
    expect(c.body).toBeUndefined();
    expect(c.headers["authorization"]).toContain("Bearer ");
    expect(c.headers["content-type"] ?? "").not.toContain("application/json");
  });

  it("conversations.info：真实非 member 读为 FALSE（诚实结果，不是 shape artifact）", async () => {
    const { fetchImpl } = shapeEnforcingSlack();
    const r = await verifyChannelMembership("xoxb-EXAMPLE-fake", "C-OTHER", fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.isMember).toBe(false);
  });

  it("conversations.history 与 conversations.replies 使用相同 read shape（reconcile 门的扫描）", async () => {
    const { fetchImpl, calls } = shapeEnforcingSlack();
    const hist = await fetchRecentMessageTexts("xoxb-EXAMPLE-fake", "C-MEMBER", undefined, fetchImpl);
    expect(hist.ok).toBe(true);
    expect(hist.texts[0]).toContain("or-mark:d-shape");
    const replies = await fetchRecentMessageTexts("xoxb-EXAMPLE-fake", "C-MEMBER", "1724.1", fetchImpl);
    expect(replies.ok).toBe(true);
    for (const c of calls) {
      expect(c.method).toBe("GET");
      expect(c.body).toBeUndefined();
    }
    expect(calls[1]!.url).toContain("conversations.replies?");
    expect(new URL(calls[1]!.url).searchParams.get("ts")).toBe("1724.1");
  });
});

describe("request shape——JSON-POST family 不受影响", () => {
  it("auth.test 保持 JSON POST，且 scope header 仍可解析", async () => {
    const { fetchImpl, calls } = shapeEnforcingSlack();
    const g = await getGrantedScopes("xoxb-EXAMPLE-fake", fetchImpl);
    expect(g.ok).toBe(true);
    expect(g.granted).toContain("chat:write");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toContain("application/json");
  });

  it("chat.postMessage 保持 JSON POST，且 body 完整", async () => {
    const { fetchImpl, calls } = shapeEnforcingSlack();
    const r = await postChatMessage("xoxb-EXAMPLE-fake", { channel: "C-MEMBER", text: "t" }, fetchImpl);
    expect(r.ok).toBe(true);
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body ?? "{}").channel).toBe("C-MEMBER");
  });
});
