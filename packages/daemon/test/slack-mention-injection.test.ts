// S10 修复第 1 轮（R2 B1）——通过真实 subsystemSlackDeliver 接缝驱动 mention-injection 的
// posted-byte 判别。契约（mini-req 4）：“升级时 mention，其余 quiet-threaded”是不可信内容的
// POSTED-BYTE 属性，而不只是 renderer 添加内容的属性。queue 控制的字段必须在 Slack 解析器中
// 结构性失活（已记录的三字符中和——&、<、>；所有控制形式 <@U…>、<!here>、<!channel>、
// <!subteam^…> 都需要字面量 "<"，因此无法存活），唯一有意的升级 mention 则由 renderer 在中和后组合。
//
// 修复前字节为 RED：负例失败（四种形式全部进入 text 并保持 mrkdwn 活跃），正例也失败（正文中
// 引用的形式与有意 mention 并存且保持活跃）。
import { describe, it, expect } from "vitest";
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
const clock = () => new Date("2026-08-27T02:00:00.000Z");

/** 该行点名的四种活动控制形式。活动形式是含真实 "<" 的字面序列；转义后的
 * "&lt;@U012AB3CD&gt;" 已失活，不得匹配。 */
const ACTIVE_FORMS = ["<@U012AB3CD>", "<!here>", "<!channel>", "<!subteam^S012AB3CD>"];
const INJECTED = `mentioning <@U012AB3CD> then <!here> then <!channel> then <!subteam^S012AB3CD> end`;

function capture(): { fetchImpl: FetchImpl; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, ts: "2.2" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

function makeDeliver(fetchImpl: FetchImpl, mention?: string) {
  const fsx = memFs();
  return subsystemSlackDeliver({
    botToken: "xoxb-EXAMPLE-fake",
    channel: "C1",
    sourceLabel: "vm",
    fetchImpl,
    delivered: new SeenStore("/del.jsonl", fsx, clock),
    attempted: new SeenStore("/att.jsonl", fsx, clock),
    outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
    resolveMentionUserId: () => mention,
  });
}

const decision = (payload: Record<string, unknown>, id = "d-inj"): OutboundDecision => ({
  kind: "outbound_decision", decisionId: id, op: "post_message", entityBindingRef: "mike#slack", payload,
});

/** 每个 posted-byte surface：顶层 text 加 blocks 中任意位置的每个字符串。 */
function allSurfaces(body: Record<string, unknown>): string {
  return `${String(body.text ?? "")}\n${JSON.stringify(body.blocks ?? [])}`;
}
function activeCount(surfaces: string, form: string): number {
  return surfaces.split(form).length - 1;
}

describe("R2 B1——queue 控制的内容在 posted bytes 中必须结构性失活", () => {
  it("负例：ROUTINE 行的 summary+body 携带四种控制形式时，任何 posted surface 都不输出活动控制语法，且内容仍真实可见而非丢弃", async () => {
    const { fetchImpl, bodies } = capture();
    const out = await makeDeliver(fetchImpl /* routine: no mention resolved */)(decision({
      qitemId: "q-inj-neg",
      summary: `routine ${INJECTED}`,
      body: `please check ${INJECTED}`,
      destinationSession: "human-founder@kernel",
      sourceSession: "dev-driver@v-openrig-build",
      tier: "routine",
    }));
    expect(out.ok).toBe(true);
    const surfaces = allSurfaces(bodies[0]!);
    for (const form of ACTIVE_FORMS) {
      expect(activeCount(surfaces, form), `active form ${form} must not survive into posted bytes`).toBe(0);
    }
    // 真实呈现：引用内容仍可读（已转义，绝不静默丢弃）。
    expect(surfaces).toContain("&lt;@U012AB3CD&gt;");
    expect(surfaces).toContain("&lt;!channel&gt;");
    expect(surfaces).toContain("&lt;!here&gt;");
    expect(surfaces).toContain("&lt;!subteam^S012AB3CD&gt;");
  });

  it("正例：真实 ESCALATION 恰好输出一个有意组合的 mention，同时四种引用形式保持失活", async () => {
    const { fetchImpl, bodies } = capture();
    const out = await makeDeliver(fetchImpl, "U012AB3CD" /* the registry-resolved escalation mention */)(decision({
      qitemId: "q-inj-pos",
      summary: `URGENT ${INJECTED}`,
      body: `decide now ${INJECTED}`,
      destinationSession: "mike@external",
      sourceSession: "dev-driver@v-openrig-build",
      tier: "human-gate",
    }, "d-inj-pos"));
    expect(out.ok).toBe(true);
    const surfaces = allSurfaces(bodies[0]!);
    // 恰好一个活动 user mention，由 renderer 在中和后自行组合。
    expect(activeCount(surfaces, "<@U012AB3CD>"), "exactly one deliberate mention").toBe(2);
    // 计数说明：有意 mention 同时出现在 notification-fallback text 和 summary section block 中
    //（一个逻辑 mention，同一消息的两个 posted surface）。summary+body 中引用的副本本会在每个
    // surface 增加 4 个以上；该边界证明它们已消失。renderer 绝不能组合 group/channel 控制：
    expect(activeCount(surfaces, "<!here>")).toBe(0);
    expect(activeCount(surfaces, "<!channel>")).toBe(0);
    expect(activeCount(surfaces, "<!subteam^S012AB3CD>")).toBe(0);
    // 引用的 user-mention 文本仍以转义形式真实可见：
    expect(surfaces).toContain("&lt;@U012AB3CD&gt;");
  });

  it("F-B1r 负例：敌意调用方提供 qitemId（<!channel>）时，任何 posted surface 都不输出活动控制语法；内部 id 不进入人类文本，reconciliation 仍按 decision 定界", async () => {
    // R1 修复第 1 轮实测：create 路由接受调用方提供且未经字符集验证的 qitemId，因此
    // “daemon 生成且无特殊字符”只是前提，不是构造保证。统一规则：footer id 与其他行字段使用同一转义。
    const { fetchImpl, bodies } = capture();
    const out = await makeDeliver(fetchImpl)(decision({
      qitemId: "<!channel>",
      summary: "routine summary",
      body: "routine body",
      destinationSession: "human-founder@kernel",
      sourceSession: "dev-driver@v-openrig-build",
      tier: "routine",
    }, "d-inj-hostile-id"));
    expect(out.ok).toBe(true);
    const surfaces = allSurfaces(bodies[0]!);
    expect(activeCount(surfaces, "<!channel>"), "a hostile id must not survive as active syntax").toBe(0);
    expect(surfaces).not.toContain("qitem &lt;!channel&gt;"); // honestly visible in the footer, escaped
  });

  it("健全性：queue 内容中的普通格式得以保留（不会过度中和纯文本）", async () => {
    const { fetchImpl, bodies } = capture();
    await makeDeliver(fetchImpl)(decision({
      qitemId: "q-inj-plain",
      summary: "plain *bold* _italic_ summary",
      body: "a normal body with a URL https://example.invalid/x and 5 > 3 comparisons",
      destinationSession: "human-founder@kernel",
      sourceSession: "dev-driver@v-openrig-build",
    }, "d-inj-plain"));
    const surfaces = allSurfaces(bodies[0]!);
    expect(surfaces).toContain("*bold*"); // mrkdwn styling is not control syntax; it survives
    expect(surfaces).toContain("https://example.invalid/x");
    expect(surfaces).toContain("5 &gt; 3"); // the comparison renders as ">" in Slack — visible, inert
  });
});
