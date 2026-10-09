// S10——identity 政策回执（A1.2）：结构化 attribution 头（rig/host/seat/session）
// 随每条出站 post 以 ONE 诚实 bot identity 出现；ZERO per-message username/icon 覆盖
//（customize ABSENCE 在 posted-bytes 层钉死）；临时 loudness 规则只 mention 升级。
import { describe, it, expect } from "vitest";
import { buildOutboundMessage, attributionFromSession } from "../src/domain/gateway/slack/message.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
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

describe("attributionFromSession——stamped triple 解析为四字段", () => {
  it("三段 triple：seat、rig、host、session", () => {
    expect(attributionFromSession("dev-driver@v-openrig-build@host-84c37990")).toEqual({
      seat: "dev-driver@v-openrig-build",
      rig: "v-openrig-build",
      host: "host-84c37990",
      session: "dev-driver@v-openrig-build@host-84c37990",
    });
  });
  it("两段 ref：seat + rig，无 host", () => {
    expect(attributionFromSession("dev-driver@v-openrig-build")).toMatchObject({ seat: "dev-driver@v-openrig-build", rig: "v-openrig-build" });
  });
  it("裸/缺席诚实降级", () => {
    expect(attributionFromSession("daemon")).toMatchObject({ seat: "daemon", session: "daemon" });
    expect(attributionFromSession(null)).toBeUndefined();
  });
});

describe("buildOutboundMessage——attribution 头 + loudness 规则", () => {
  const q = { qitemId: "q1", summary: "Decide X", body: "b", destinationSession: "mike@external" };

  it("subject 领衔，一条 sender attribution 保留完整 source identity", () => {
    const m = buildOutboundMessage(q, {
      sourceLabel: "vm",
      attribution: { seat: "dev-driver@v-openrig-build", rig: "v-openrig-build", host: "host-84c37990", session: "dev-driver@v-openrig-build@host-84c37990" },
    });
    expect((m.blocks[0] as { type: string }).type).toBe("section");
    const first = m.blocks.at(-1) as { type: string; elements: { text: string }[] };
    expect(first.type).toBe("context");
    const line = first.elements[0]!.text;
    expect(line).toContain("dev-driver@v-openrig-build");
    expect(line).toBe("来自 dev-driver@v-openrig-build@host-84c37990");
    expect(m.text).toContain("来自 dev-driver@v-openrig-build@host-84c37990"); // notification fallback 也带它
  });

  it("ESCALATION 用 USER ID 提到 human；routine 保持安静", () => {
    const loud = buildOutboundMessage(q, { sourceLabel: "vm", mentionUserId: "U012AB3CD" });
    expect(loud.text.startsWith("<@U012AB3CD> :rotating_light: ")).toBe(true);
    expect(JSON.stringify(loud.blocks)).toContain("<@U012AB3CD> :rotating_light:");
    const quiet = buildOutboundMessage(q, { sourceLabel: "vm" });
    expect(quiet.text).not.toContain("<@");
    expect(quiet.text).not.toContain(":rotating_light:");
    expect(JSON.stringify(quiet.blocks)).not.toContain(":rotating_light:");
  });
});

describe("customize ABSENCE——posted bytes 只带 app identity", () => {
  function capture(): { fetchImpl: FetchImpl; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    return {
      bodies,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
  }
  const decision = (payload: Record<string, unknown>): OutboundDecision => ({
    kind: "outbound_decision", decisionId: "d1", op: "post_message", entityBindingRef: "mike#slack", payload,
  });

  it("一次完整投递（升级、attribution、图片）post ZERO username/icon_url/icon_emoji key", async () => {
    const fsx = memFs();
    const { fetchImpl, bodies } = capture();
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-EXAMPLE-fake",
      channel: "C1",
      sourceLabel: "vm",
      fetchImpl,
      delivered: new SeenStore("/del.jsonl", fsx, clock),
      attempted: new SeenStore("/att.jsonl", fsx, clock),
      outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
      resolveMentionUserId: () => "U012AB3CD", // 即便在最大 loudness…
    });
    const out = await deliver(decision({
      qitemId: "q-esc",
      summary: "URGENT decide",
      body: "please",
      destinationSession: "mike@external",
      sourceSession: "dev-driver@v-openrig-build@host-84c37990",
      evidenceRef: "https://example.invalid/x.png",
      tier: "human-gate",
    }));
    expect(out.ok).toBe(true);
    const body = bodies[0]!;
    // …identity 仍是 app 自己的：customize key 在结构上缺席。
    expect(Object.keys(body)).not.toContain("username");
    expect(Object.keys(body)).not.toContain("icon_url");
    expect(Object.keys(body)).not.toContain("icon_emoji");
    expect(JSON.stringify(body)).not.toMatch(/"username"|"icon_url"|"icon_emoji"/);
    // 且 attribution + mention 作为 CONTENT 到达，而非 identity
    expect(String(body.text)).toContain("<@U012AB3CD>");
    expect(JSON.stringify(body.blocks)).toContain("dev-driver@v-openrig-build");
  });
});
