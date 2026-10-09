import { describe, it, expect } from "vitest";
import { buildOutboundMessage, buildImageBlocks, containsSecret, redactSecrets, SLACK_TEXT_CAP } from "../src/domain/gateway/slack/message.js";

describe("Slice-11 outbound message——内容卫生（第 7 项）", () => {
  const opts = { sourceLabel: "vm-openrig-build" };

  it("展示摘要和发送方，内部 queue 标识符不进入消息", () => {
    const m = buildOutboundMessage(
      { qitemId: "qitem-abc", summary: "Founder needs a decision", body: "context", destinationSession: "human-founder@kernel" },
      opts,
    );
    expect(m.text).toContain("Founder needs a decision");
    expect(m.text).not.toContain("qitem-abc");
    expect(m.text).not.toContain("human-founder@kernel");
    expect(m.text).toContain("vm-openrig-build");
  });

  it("绝不转发从 qitem body 泄漏的 Slack/bearer secret，而是将其脱敏", () => {
    const leaky =
      "here is the token xoxb-EXAMPLE-000000000000-doNotUseFake and hook https://hooks.slack.com/services/T00/B00/xyz and Authorization Bearer EXAMPLEfakebearer000";
    const m = buildOutboundMessage({ qitemId: "q1", summary: "x", body: leaky, destinationSession: "human@kernel" }, opts);
    expect(containsSecret(m.text)).toBe(false);
    expect(m.text).toContain("[redacted-secret]");
    // summary 中的 secret 也必须脱敏。
    const m2 = buildOutboundMessage({ qitemId: "q2", summary: "tok xapp-EXAMPLE-FAKE-token", body: "", destinationSession: "human@kernel" }, opts);
    expect(containsSecret(m2.text)).toBe(false);
    for (const b of m2.blocks) expect(containsSecret(JSON.stringify(b))).toBe(false);
  });

  it("拒绝过大的 body，并给作者可执行的修正提示", () => {
    expect(() => buildOutboundMessage({ qitemId: "q", body: "x".repeat(9000) }, opts)).toThrow(/请缩短人工摘要/);
  });

  it("完整保留超过旧版 800-unit 摘要限制的 body", () => {
    const body = "y".repeat(1000) + " Approve or hold?";
    const m = buildOutboundMessage({ qitemId: "q", summary: "s", body }, opts);
    expect(m.text).toContain(body);
    expect(m.text.length).toBeLessThanOrEqual(SLACK_TEXT_CAP);
    expect(JSON.stringify(m.blocks)).toContain(body);
  });

  it("拒绝没有完整无障碍投影的额外 block", () => {
    expect(() => buildOutboundMessage({ qitemId: "q", body: "b" }, { ...opts, extraBlocks: [{ type: "section", text: "unrepresented" }] })).toThrow(/无障碍 fallback/);
  });

  it("redactSecrets/containsSecret 往返一致", () => {
    expect(containsSecret("xoxb-1-2-abc")).toBe(true);
    expect(containsSecret(redactSecrets("xoxb-1-2-abc"))).toBe(false);
    expect(containsSecret("nothing sensitive here")).toBe(false);
  });
});

describe("M1 A5b——outbound 图片附件（已接线的 T1076 接缝）", () => {
  const opts = { sourceLabel: "vm-openrig-build" };
  const imageBlocks = (m: { blocks: unknown[] }) => m.blocks.filter((b) => (b as { type?: string }).type === "image") as { type: string; image_url: string; alt_text: string }[];

  it("将 media ref 渲染为 Block Kit 图片 block，并在 fallback 中携带图片描述", () => {
    const m = buildOutboundMessage(
      { qitemId: "q1", summary: "chart ready", body: "see attached", destinationSession: "human-founder@kernel" },
      { ...opts, mediaRefs: [{ imageUrl: "https://example.com/shot.png", altText: "the screenshot" }] },
    );
    const imgs = imageBlocks(m);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toEqual({ type: "image", image_url: "https://example.com/shot.png", alt_text: "the screenshot" });
    expect(m.text).toContain("图片：the screenshot");
    // 文本内容和卫生保证仍然存在。
    expect(m.text).toContain("chart ready");
  });

  it("拒绝含 secret 或非 https 的 image_url（第 7 项卫生要求：绝不转发夹带的 secret）", () => {
    const blocks = buildImageBlocks([
      { imageUrl: "https://hooks.slack.com/services/T00/B00/SECRETPART", altText: "leak" }, // webhook URL
      { imageUrl: "http://insecure.example.com/x.png", altText: "insecure" },               // 非 https
      { imageUrl: "not-a-url", altText: "junk" },
      { imageUrl: "https://ok.example.com/fine.png", altText: "fine" },                      // 唯一有效项
    ]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { image_url: string }).image_url).toBe("https://ok.example.com/fine.png");
  });

  it("脱敏从 alt_text 泄漏的 secret；无 media 时既无图片 block，也不计数", () => {
    const blocks = buildImageBlocks([{ imageUrl: "https://ok.example.com/a.png", altText: "tok xoxb-EXAMPLE-000000-leak" }]);
    expect(containsSecret((blocks[0] as { alt_text: string }).alt_text)).toBe(false);
    const plain = buildOutboundMessage({ qitemId: "q2", summary: "x", body: "", destinationSession: "h@kernel" }, opts);
    expect(imageBlocks(plain)).toHaveLength(0);
    expect(plain.text).not.toContain("image attachment");
  });
});
