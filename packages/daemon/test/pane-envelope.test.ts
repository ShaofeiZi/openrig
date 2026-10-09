// V0.3.1 slice 23 founder-walk-queue-handoff-envelope。
//
// daemon 侧 wrapPaneEnvelope 对等性测试。约束：相同输入必须与 CLI wrapSendBody
// 产生逐字节一致的输出。两个函数位于不同软件包，因为 CLI 与 daemon 当前不跨包导入；
// 此测试镜像 packages/cli/test/send-header.test.ts 中的断言，因此任一实现漂移时，
// 此测试（或其 CLI 对应测试）都会失败。
//
// IMPL-PRD §5 的 HG-2：“信封格式与 zrig send 信封逐字节一致”。

import { describe, it, expect } from "vitest";
import { wrapPaneEnvelope, appendDeliveredSegment, DELIVERED_LATENCY_FLAG_MS } from "../src/lib/pane-envelope.js";

describe("wrapPaneEnvelope——分片 23 信封渲染器（daemon 侧）", () => {
  it("使用两个会话名渲染 From / To / 正文 / 回复提示", () => {
    const out = wrapPaneEnvelope("driver-3@my-rig", "guard-3@my-rig", "Status: ready.");
    expect(out).toContain("From: driver-3@my-rig");
    expect(out).toContain("To: guard-3@my-rig");
    expect(out).toContain("Status: ready.");
    expect(out).toContain('↩ 回复：zrig send driver-3@my-rig "..."');
  });

  it("通过持久化人工队列路由对外部发送方的回复", () => {
    const out = wrapPaneEnvelope("decision-maker@external", "driver@rig", "Decision received.");
    expect(out).toContain("From: decision-maker@external");
    expect(out).toContain('↩ 如需回复：zrig queue create --destination decision-maker@external --body "..." --verify');
    expect(out).not.toContain("zrig send decision-maker@external");
    expect(wrapPaneEnvelope("driver@external-tools", "guard@rig", "Status.")).toContain('↩ 回复：zrig send driver@external-tools "..."');
  });

  it("在横线分隔符之间逐字保留原始正文", () => {
    const body = "Multi-line\nbody with\nthree lines.";
    const out = wrapPaneEnvelope("a@r", "b@r", body);
    const segments = out.split("\n---\n");
    expect(segments).toHaveLength(3);
    expect(segments[1]).toBe(body);
  });

  it("正文为空时仍正确包裹", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "");
    expect(out).toContain("From: a@r");
    expect(out).toContain("To: b@r");
    expect(out).toContain("---\n\n---");
    expect(out).toContain('↩ 回复：zrig send a@r "..."');
  });

  it("发送方为 undefined 或空值时回退到标记", () => {
    const undef = wrapPaneEnvelope(undefined, "b@r", "hi");
    expect(undef).toContain("From: <unknown sender>");
    expect(undef).toContain('↩ 回复：zrig send <unknown sender> "..."');
    const blank = wrapPaneEnvelope("   ", "b@r", "hi");
    expect(blank).toContain("From: <unknown sender>");
  });

  it("To 标头使用字面接收方字符串，从而保留跨工作组地址", () => {
    const out = wrapPaneEnvelope("from@a", "to@b", "x");
    expect(out).toMatch(/^From: from@a\nTo: to@b\n---\n/);
  });

  // A4 固定点 2——保留分支现在可达。A4 使 CLI 在 X-OpenRig-Session 上标记三段式来源；
  // 远程 daemon 派生该三段式行为方并在此渲染。这里断言 daemon 逐字渲染已为三段式的发送方，
  // 绝不以当前（目标）主机的 selfHostId 重新标记，否则会把来源伪造为目标
  //（回执的精确缺陷）。此前此分支从未触发（没有三段式内容抵达）；A4 依赖它，因此显式覆盖。
  it("A4 固定点 2——逐字渲染抵达的三段式来源发送方，绝不以当前主机重新标记", () => {
    // 根不变量 2026-08-27：wrapper 不再接受（或附加）self-host id；删除该能力后，
    // 抵达的来源三元组可保证逐字渲染。
    const out = wrapPaneEnvelope("dev50@v-rig@origin-host", "guard@my-rig", "hi");
    expect(out).toContain("From: dev50@v-rig@origin-host"); // 保留来源主机
    expect(out).not.toContain("@destination-host"); // 不使用目标标识重新标记（不伪造）
    expect(out).toContain('↩ 回复：zrig send dev50@v-rig@origin-host "..."'); // 回复提示会往返保留来源。
  });

  // V0.3.1 分片 23——队列交接提醒正文必须保持为可 grep 的子字符串（IMPL-PRD §2 BC
  // 中已沉淀的兼容说明）。此测试断言信封内保留规范裸行，使按子字符串
  // 匹配它的解析器仍可工作。
  it("包裹规范的 'Queue handoff: qitem-X - check your queue.' 裸正文时不作修改", () => {
    const bare = "Queue handoff: qitem-20260511200000-abc123 - check your queue.";
    const out = wrapPaneEnvelope("orch-lead@v", "driver-3@v", bare);
    expect(out).toContain(bare);
    // 裸行必须恰好出现一次，位于信封内（两个 `---` 分隔符之间），
    // 使接收方窗格上的子字符串 grep 仍能找到它。
    const matches = out.split(bare).length - 1;
    expect(matches).toBe(1);
  });

  // ── 发送/广播标头（裁定 03c35295）——接收方可见性投影 + 时间戳 ──
  // 信封 = 事实；渲染 = 投影。To 行 + 规模是防风暴约束（接收方仅看标头
  // 即可区分私信、多播、工作组广播与拓扑广播）。时间戳在传输发送时只写一次
  //（它是输入——渲染只读取，绝不重新派生）。

  it("向后兼容：无元数据时，输出恰为当前 6 行私信信封（无 Sent 行）", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi");
    expect(out).toBe("From: a@r\nTo: b@r\n---\nhi\n---\n↩ 回复：zrig send a@r \"...\"");
  });

  it("多播在 To 行渲染完整接收方列表（谁收到了）", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", { scope: { kind: "multi", recipients: ["b@r", "c@r", "d@r"] } });
    expect(out).toContain("To: b@r, c@r, d@r");
  });

  it("工作组广播渲染接收工作组与席位数——防风暴规模", () => {
    const out = wrapPaneEnvelope("a@r", "openrig-pm", "hi", { scope: { kind: "rig-broadcast", rig: "openrig-pm", seats: 11 } });
    expect(out).toContain("To: 广播到 openrig-pm（11 个席位）");
  });

  it("拓扑广播渲染到 topology", () => {
    const out = wrapPaneEnvelope("a@r", "*", "hi", { scope: { kind: "topology" } });
    expect(out).toContain("To: 广播到 topology");
  });

  it("根据传输层 ISO 值标记简短 MM-DD HH:MMZ 时间戳（只读，不重新派生）", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", { stampISO: "2026-08-06T17:42:09Z" });
    expect(out).toContain("Sent: 08-06 17:42Z");
  });

  it("仅标头即可区分（风暴测试）：私信 / 多播 / 工作组广播 / 拓扑广播各自渲染不同 To 行", () => {
    const to = (out: string) => out.split("\n").find((l) => l.startsWith("To:"));
    const dm = to(wrapPaneEnvelope("a@r", "b@r", "x"));
    const multi = to(wrapPaneEnvelope("a@r", "b@r", "x", { scope: { kind: "multi", recipients: ["b@r", "c@r"] } }));
    const rig = to(wrapPaneEnvelope("a@r", "r", "x", { scope: { kind: "rig-broadcast", rig: "r", seats: 4 } }));
    const topo = to(wrapPaneEnvelope("a@r", "*", "x", { scope: { kind: "topology" } }));
    expect(new Set([dm, multi, rig, topo]).size).toBe(4); // 四者视觉上可区分，无需 context
  });

  // ── GHOST-STAGE (g)：Sent: 行上的 sender-generation suffix ──
  // 这些断言在 packages/cli/test/send-header.test.ts 中针对 wrapSendBody 逐字节镜像——
  // 跨包字节一致性约束。两处镜像必须同步更新。
  const GEN = "a1b2c3d4-e5f6-7890-abcd-ef0123456789";

  it("(g) 将发送方的短代次（前 8 位）标记为 Sent: 行后缀", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    expect(out).toContain("Sent: 08-06 17:42Z · gen a1b2c3d4");
  });

  it("(g) 带 gen 的完整信封逐字节精确（跨包对等锚点）", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    expect(out).toBe('From: a@r\nTo: b@r\nSent: 08-06 17:42Z · gen a1b2c3d4\n---\nhi\n---\n↩ 回复：zrig send a@r "..."');
  });

  it("(g) 固定点 a：代次未知时完全省略后缀（不显示 gen unknown，不伪造）", () => {
    const absent = wrapPaneEnvelope("a@r", "b@r", "hi", { stampISO: "2026-08-06T17:42:09Z" });
    const empty = wrapPaneEnvelope("a@r", "b@r", "hi", { stampISO: "2026-08-06T17:42:09Z", genUuid: "" });
    for (const out of [absent, empty]) {
      expect(out.split("\n").find((l) => l.startsWith("Sent:"))).toBe("Sent: 08-06 17:42Z");
      expect(out).not.toContain(" · gen ");
    }
  });

  it("(g) 固定点 a：无 Sent 行 ⇒ 无 gen 后缀（gen 依附于 Sent 时间戳，后者缺失时也省略）", () => {
    const out = wrapPaneEnvelope("a@r", "b@r", "hi", { genUuid: GEN });
    expect(out).not.toContain("Sent:");
    expect(out).not.toContain(" · gen ");
  });

  it("(g) 固定点 b：含 ' · gen …' 的正文无法伪造 Sent: 行代次（隔离性）", () => {
    const body = "totally · gen ffffffff not the real gen";
    const out = wrapPaneEnvelope("a@r", "b@r", body, { stampISO: "2026-08-06T17:42:09Z", genUuid: GEN });
    // Sent: 行位于标头块（第一个 "\n---\n" 前）；正文位于其后。
    const [headerBlock, ...bodyRegion] = out.split("\n---\n");
    expect(headerBlock.split("\n").find((l) => l.startsWith("Sent:"))).toBe("Sent: 08-06 17:42Z · gen a1b2c3d4");
    expect(headerBlock).not.toContain("ffffffff"); // 伪造标记绝不进入标头
    expect(bodyRegion.join("\n---\n")).toContain("· gen ffffffff"); // 它在正文中保持原样
  });

  // (g) 临时固定点（编排范围裁定）：g 只在已有 Sent: 行时渲染 gen（zrig-send 接缝）。
  // 队列交接提醒（queue-repository:537）当前不传元数据，因此不含 Sent:/gen 行——如实省略。
  // 后续项 (h)：投递时间戳会向提醒添加 Sent: 行，此时 gen 无需额外逻辑即可沿同一
  // 渲染带出（h 中一次 HG-5 基线变更，而非两次）。此固定点记录临时缺口及其闭环项。
  it("(g) 临时状态：无元数据的交接提醒不含 Sent:/gen 行（h 将添加时间戳）", () => {
    const nudge = wrapPaneEnvelope("orch-lead@v", "driver-3@v", "Queue handoff: qitem-9 - check your queue.", null);
    expect(nudge).not.toContain("Sent:");
    expect(nudge).not.toContain(" · gen ");
  });

  // ── GHOST-STAGE (h)：Sent: 行上的 delivered-at latency segment ──
  // 仅 daemon 写入时刻使用（CLI 从不负责投递），因此没有跨包镜像——但
  // ' · delivered ' 隔离规则镜像 g 的 ' · gen '。阈值是已裁定值 → 需要
  // 边界镜像（刚好在内不显示 / 刚好在外显示标记）+ 数值固定点。
  const ENV = (extra?: { genUuid?: string }) =>
    wrapPaneEnvelope("a@r", "b@r", "hi", { stampISO: "2026-08-06T17:42:09Z", ...extra });

  it("(h) 数值固定点：延迟投递阈值为 10 秒", () => {
    expect(DELIVERED_LATENCY_FLAG_MS).toBe(10_000);
  });

  it("(h) 边界镜像——刚好在内（9.x 秒）不渲染投递片段", () => {
    expect(appendDeliveredSegment(ENV(), 9_999)).toBe(ENV()); // 不变
    expect(appendDeliveredSegment(ENV(), 9_999)).not.toContain(" · 已投递 ");
  });

  it("(h) 边界镜像——刚好在外（10.x 秒）按整秒标记投递", () => {
    expect(appendDeliveredSegment(ENV(), 10_000)).toContain("Sent: 08-06 17:42Z · 已投递 +10s");
    expect(appendDeliveredSegment(ENV(), 10_999)).toContain(" · 已投递 +10s"); // 向下取整，不四舍五入。
    expect(appendDeliveredSegment(ENV(), 12_000)).toContain(" · 已投递 +12s");
  });

  it("(h) 与 g 的 gen 后缀组合在同一 Sent: 行", () => {
    const out = appendDeliveredSegment(ENV({ genUuid: "a1b2c3d4-e5f6-7890-abcd-ef0123456789" }), 42_000);
    expect(out).toContain("Sent: 08-06 17:42Z · gen a1b2c3d4 · 已投递 +42s");
  });

  it("(h) 无 Sent: 行时不作处理（无信封元数据的发送）", () => {
    const bare = wrapPaneEnvelope("a@r", "b@r", "hi", null); // 无元数据 ⇒ 无 Sent: 行
    expect(appendDeliveredSegment(bare, 60_000)).toBe(bare);
  });

  it("(h) 隔离性：含 ' · delivered …' 的正文无法伪造 Sent: 行片段", () => {
    const out0 = wrapPaneEnvelope("a@r", "b@r", "sneaky · delivered +999s tail", { stampISO: "2026-08-06T17:42:09Z" });
    const out = appendDeliveredSegment(out0, 15_000);
    const [headerBlock, ...bodyRegion] = out.split("\n---\n");
    expect(headerBlock.split("\n").find((l) => l.startsWith("Sent:"))).toBe("Sent: 08-06 17:42Z · 已投递 +15s");
    expect(headerBlock).not.toContain("999s"); // 伪造标记绝不进入标头
    expect(bodyRegion.join("\n---\n")).toContain("· delivered +999s"); // 在正文中保持原样
  });

  it("(h) 格式错误或无法解析的时差不作处理（绝不产生 NaN 片段）", () => {
    expect(appendDeliveredSegment(ENV(), Number.NaN)).toBe(ENV());
  });
});
