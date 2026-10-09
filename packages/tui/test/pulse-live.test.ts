import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { buildPulseModel } from "../src/pulse/pulse-model.js";
import { renderExceptionSection } from "../src/pulse/render-pulse.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle } from "../src/theme.js";
import type { FleetSnapshot, QueueRead } from "../src/types.js";

/** 从 stylized 行提取活动 BOLD SGR 下渲染的文本——
 * 走 SGR 状态（1=粗体开，0/22=粗体关），使“渲染粗体”断言落在
 * STYLIZED 层，而非仅 pre-stylize seg。 */
function boldText(styled: string): string {
  let bold = false;
  let out = "";
  let i = 0;
  while (i < styled.length) {
    if (styled[i] === "\x1b" && styled[i + 1] === "[") {
      const m = styled.slice(i).match(/^\x1b\[([0-9;]*)m/);
      if (m) {
        const params = m[1]!.split(";").filter(Boolean).map(Number);
        for (const p of params.length ? params : [0]) {
          if (p === 1) bold = true;
          else if (p === 0 || p === 22) bold = false;
        }
        i += m[0].length;
        continue;
      }
    }
    if (bold) out += styled[i];
    i += 1;
  }
  return out;
}

// 固定参考时钟，使龄计算确定。
const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HR = 60 * MIN;

function liveSnap(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  const base = demoSnapshot();
  // 默认清零所有异常 + lane 源；每个测试自选其驱动的源。
  return { ...base, attention: [], blocked: [], inProgress: [], seatActivity: [], pending: [], recentlyFinished: [], ...over };
}

// daemon 作为 node.logicalId 服务的紧凑规范 id（podNamespace.member）。
// 这里的简单 fixture session `dev50-guard@rig` → `dev50.guard`；在意精确紧凑形态的测试
// 显式传入。
const compact = (session: string) => session.split("@")[0]!.replace(/-/g, ".");
// 一个席的 ps/activity 行（PARKED/NOW join 的右侧）。
const seat = (session: string, terminalActive: boolean | null, lastActivityAt: string | null, logicalId: string = compact(session)) =>
  ({ session, logicalId, terminalActive, lastActivityAt });

// 一个 in-progress qitem（复用 attn 形态，但带真实 owner + in-progress 状态）。
const inprog = (over: Partial<QueueRead>): QueueRead =>
  attn({ state: "in-progress", destinationSession: "dev50-guard@openrig-build", claimedAt: ago(50 * MIN), ...over });

const attn = (over: Partial<QueueRead>): QueueRead => ({
  qitemId: "q",
  state: "pending",
  destinationSession: "human-yeah@kernel",
  blockedOn: null,
  handedOffTo: null,
  tier: "human-gate",
  tags: null,
  summary: null,
  body: "",
  claimedAt: null,
  tsUpdated: ago(0),
  ...over,
});

describe("PULSE 视图增量2——异常条 LIVE", () => {
  it("▲ NEEDS YOU：行由 attention 读取构建（subject 来自 summary，龄来自 claimedAt）", () => {
    const snap = liveSnap({
      attention: [
        attn({ qitemId: "q1", summary: "0.5.0 cut packet ready · 等待你", claimedAt: ago(22 * MIN) }),
        attn({ qitemId: "q2", summary: "slice-20 routing pixels · waiting on you", claimedAt: ago(3 * HR) }),
      ],
    });
    const model = buildPulseModel(snap, NOW);
    const needs = model.exceptions.find((s) => s.label === "需要你");
    expect(needs).toBeDefined();
    expect(needs!.rows.length).toBe(2);
    const text = renderExceptionSection(needs!).map((l) => l.text).join("\n");
    expect(text).toContain("▲ 需要你 (2)");
    expect(text).toContain("0.5.0 cut packet ready · 等待你");
    expect(text).toContain("22 分钟");
    expect(text).toContain("slice-20 routing pixels · waiting on you");
    expect(text).toContain("3 小时");
  });

  it("▲ NEEDS YOU：summary 为 null 时 subject 回退到正文首行", () => {
    const snap = liveSnap({
      attention: [attn({ qitemId: "q1", summary: null, body: "please cut the 0.5.1 release now\nsecond line ignored" })],
    });
    const model = buildPulseModel(snap, NOW);
    const needs = model.exceptions.find((s) => s.label === "需要你")!;
    const text = renderExceptionSection(needs).map((l) => l.text).join("\n");
    expect(text).toContain("please cut the 0.5.1 release now");
    expect(text).not.toContain("second line ignored");
  });

  it("▲ 需要你 (founder Option-1 taste ruling): the who/what SUBJECT leads in BOLD, the detail plain after — split on the ' — ' boundary the summary affords", () => {
    const snap = liveSnap({
      attention: [attn({ qitemId: "q1", summary: "push-go — 0.5.0 cut packet ready · waiting on you", claimedAt: ago(22 * MIN) })],
    });
    const model = buildPulseModel(snap, NOW);
    const row = model.exceptions.find((s) => s.label === "需要你")!.rows[0]!;
    // 模型：summary 在 ' — ' 边界拆分 → subject（谁/什么）+ 主张
    // （detail，保留分隔符使纯运行读起来自然）
    expect(row.subject).toBe("push-go");
    expect(row.claim).toBe(" — 0.5.0 cut packet ready · waiting on you");
    // STYLIZED（paint 证明纪律）：subject 渲染粗体，detail 不粗体
    const v = createViewState({ instanceId: "t", getSnapshot: () => snap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const screen = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: NOW, colorMode: "truecolor" });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const needsLine = styled.find((l) => l.includes("push-go"))!;
    expect(needsLine).toBeDefined();
    expect(boldText(needsLine)).toContain("push-go"); // who/what subject is BOLD
    expect(boldText(needsLine)).not.toContain("0.5.0"); // detail is plain (NOT bold)
  });

  it("▲ NEEDS YOU：无 — 边界的 summary 整体作 subject（诚实降级——扁平 summary 不支持合成）", () => {
    const snap = liveSnap({
      attention: [attn({ qitemId: "q1", summary: "0.5.0 cut packet ready · 等待你", claimedAt: ago(22 * MIN) })],
    });
    const row = buildPulseModel(snap, NOW).exceptions.find((s) => s.label === "需要你")!.rows[0]!;
    expect(row.subject).toBe("0.5.0 cut packet ready · 等待你"); // whole summary is the subject
    expect(row.claim).toBe(""); // no fabricated detail split
  });

  it("⧗ BLOCKED ON AGENTS：点名阻塞 agent（blockedOn qitem-id 解析为其 owner），非 qitem 指针；人工阻塞排除", () => {
    const snap = liveSnap({
      blocked: [
        // 真实：agent 阻塞在 blockedOn 存一个 QITEM ID；阻塞
        // AGENT 是该 qitem 的 owner，由 hydrate 解析为 blockerSession。
        attn({
          qitemId: "b1",
          state: "blocked",
          destinationSession: "dev50-driver@openrig-build",
          blockedOn: "qitem-20260805-blkA", // a qitem POINTER — must NOT be shown as the blocker
          blockerSession: "review-r1@openrig-build", // resolved owner = the blocking agent
          tier: null,
          summary: "terminal verdict for 51209941",
          claimedAt: ago(1 * HR),
        }),
        // 人工 park 在 blockedOn 存 SESSION → 排除（已在 NEEDS YOU 下）
        attn({
          qitemId: "b2",
          state: "blocked",
          destinationSession: "dev50-qa@openrig-build",
          blockedOn: "human-yeah@kernel",
          tier: null,
          summary: "human sign-off pending",
          claimedAt: ago(2 * HR),
        }),
      ],
    });
    const model = buildPulseModel(snap, NOW);
    const blocked = model.exceptions.find((s) => s.label === "被智能体阻塞");
    expect(blocked).toBeDefined();
    expect(blocked!.rows.length).toBe(1);
    const text = renderExceptionSection(blocked!).map((l) => l.text).join("\n");
    expect(text).toContain("⧗ 被智能体阻塞 (1)");
    expect(text).toContain("dev50-driver@openrig-build");
    // label==referent：AGENT 被命名，qitem 指针不渲染
    expect(text).toContain("被 review-r1@openrig-build 阻塞");
    expect(text).not.toContain("qitem-20260805-blkA");
    expect(text).toContain("terminal verdict for 51209941");
    // 人工阻塞项绝不漏进 BLOCKED ON AGENTS
    expect(text).not.toContain("dev50-qa@openrig-build");
    expect(text).not.toContain("human sign-off pending");
  });

  it("⧗ BLOCKED ON AGENTS：未解析阻塞（blockerSession null）回退到原始 blockedOn——诚实，绝不伪造", () => {
    const snap = liveSnap({
      blocked: [
        attn({
          qitemId: "b3",
          state: "blocked",
          destinationSession: "dev50-guard@openrig-build",
          blockedOn: "gate:review", // e.g. a gate name — not a qitem id, does not resolve
          blockerSession: null,
          tier: null,
          summary: "awaiting gate",
          claimedAt: ago(30 * MIN),
        }),
      ],
    });
    const model = buildPulseModel(snap, NOW);
    const blocked = model.exceptions.find((s) => s.label === "被智能体阻塞")!;
    const text = renderExceptionSection(blocked).map((l) => l.text).join("\n");
    expect(text).toContain("被 gate:review 阻塞"); // honest raw reference, not a fabricated agent
  });

  it("◌ PARKED WITH BATON：owner 空闲（terminalActive===false）且未交接的 in-progress qitem 行；空闲时长在渲染器从 lastActivityAt 推导", () => {
    const snap = liveSnap({
      inProgress: [
        inprog({ qitemId: "qitem-20260806-8f3a1b2c", destinationSession: "dev50-guard@openrig-build", summary: "slice 51-06 D2 atom" }),
      ],
      // owner 空闲：terminalActive false，最后输出 47 分钟前
      seatActivity: [seat("dev50-guard@openrig-build", false, ago(47 * MIN))],
    });
    const model = buildPulseModel(snap, NOW);
    const parked = model.exceptions.find((s) => s.label === "停驻待接力");
    expect(parked).toBeDefined();
    expect(parked!.rows.length).toBe(1);
    const text = renderExceptionSection(parked!).map((l) => l.text).join("\n");
    expect(text).toContain("◌ 停驻待接力 (1)");
    expect(text).toContain("dev50-guard@openrig-build");      // owner (baton holder) named
    expect(text).toContain("qitem 8f3a…");                     // qitem-short
    expect(text).not.toContain("qitem-20260806-8f3a1b2c");     // full id pointer NOT rendered
    expect(text).toContain("47 分钟空闲");                      // idle-duration from lastActivityAt (renderer nowMs)
    expect(text).toContain("无交接");
    expect(text).toContain("→ 回车：转录检查");                 // the drill hint
    // join live 后，延迟读占位符消失
    expect(text).not.toContain("idle-age read pending");
  });

  it("◌ PARKED WITH BATON 排除：活动 owner（terminalActive===true）、已交接 baton、未知活动 owner（null）全排除（null≠idle——诚实）", () => {
    const snap = liveSnap({
      inProgress: [
        inprog({ qitemId: "qitem-a-active01", destinationSession: "dev50-driver@openrig-build", summary: "actively working" }),
        inprog({ qitemId: "qitem-b-handed02", destinationSession: "dev50-guard@openrig-build", handedOffTo: "review50-r1@openrig-build", summary: "already handed off" }),
        inprog({ qitemId: "qitem-c-unknwn3", destinationSession: "dev50-qa@openrig-build", summary: "no activity signal" }),
      ],
      seatActivity: [
        seat("dev50-driver@openrig-build", true, ago(1 * MIN)),   // ACTIVE → working, not parked
        seat("dev50-guard@openrig-build", false, ago(47 * MIN)),  // idle, but THIS qitem is handed off
        seat("dev50-qa@openrig-build", null, null),               // no signal → honest-unknown, NOT idle
      ],
    });
    const model = buildPulseModel(snap, NOW);
    // 三者全排除 → ran join 得零 → 静默（省略区段）
    expect(model.exceptions.find((s) => s.label === "停驻待接力")).toBeUndefined();
  });

  it("空 LIVE join 即静默：零 attention/blocked/parked 读取完全省略其区段", () => {
    const model = buildPulseModel(liveSnap(), NOW);
    expect(model.exceptions.find((s) => s.label === "需要你")).toBeUndefined();
    expect(model.exceptions.find((s) => s.label === "被智能体阻塞")).toBeUndefined();
    // PARKED 现在也是 LIVE ran-join → 零 parked = 静默 = 省略
    expect(model.exceptions.find((s) => s.label === "停驻待接力")).toBeUndefined();
  });

  it("in-pane（founder Option-B）：pulse 视图在常规 explorer│content chrome 内渲染——侧栏保留（founder 动作路径）", () => {
    const snap = liveSnap({
      attention: [attn({ qitemId: "q1", summary: "cut packet ready", claimedAt: ago(5 * MIN) })],
    });
    const v = createViewState({ instanceId: "t", getSnapshot: () => snap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: NOW });
    const body = s.lines.join("\n");
    // 常规 chrome：EXPLORER 窗格标题 + G2 分屏接头（侧栏在）
    expect(body).toContain("资源管理器");
    expect(body).toContain("╋");
    // 侧栏是真实 topology 导航器——founder 从它导航
    expect(s.explorerRows.length).toBeGreaterThan(0);
    // pulse 内容在 content 列：NEEDS YOU 条始于
    // L2 侧栏 + 边界之后，绝不靠左缘
    const needsLine = body.split("\n").find((l) => l.includes("需要你"));
    expect(needsLine).toBeDefined();
    expect(needsLine!.startsWith("▲ 需要你")).toBe(false);
    expect(needsLine![s.explorerWidth]).toBe("┃");
  });

  it("回归：非 pulse 视图（table）仍渲染 explorer 侧栏", () => {
    const snap = liveSnap();
    const v = createViewState({ instanceId: "t", getSnapshot: () => snap });
    // 默认视图是 table（topology 区段）——explorer 必须保留
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44 }).lines.join("\n");
    expect(body).toContain("资源管理器");
    expect(body).toContain("╋");
  });
});

describe("PULSE 视图增量3——Lane LIVE（NOW / JUST FINISHED / UP NEXT + live footer）", () => {
  it("NOW：活动席（terminalActive===true）join 其 in-progress 工作；空闲/未知 owner 排除", () => {
    const snap = liveSnap({
      inProgress: [
        inprog({ qitemId: "n1", destinationSession: "dev50-driver@openrig-build", summary: "pulse incr-3 build" }),
        inprog({ qitemId: "n2", destinationSession: "dev50-guard@openrig-build", summary: "guard busywork" }),
        inprog({ qitemId: "n3", destinationSession: "dev50-qa@openrig-build", summary: "qa matrix leg" }),
      ],
      seatActivity: [
        seat("dev50-driver@openrig-build", true, ago(1 * MIN)),   // ACTIVE → NOW (with work)
        seat("dev50-guard@openrig-build", false, ago(47 * MIN)),  // IDLE → PARKED, never NOW
        seat("dev50-qa@openrig-build", null, null),               // UNKNOWN signal → excluded (null ≠ active)
        seat("dev50-planner@openrig-build", true, ago(30_000)),   // ACTIVE, no in-progress qitem → bare NOW row
      ],
    });
    const now = buildPulseModel(snap, NOW).lanes[0];
    expect(now.label).toBe("现在");
    const labels = now.rows.map((r) => r.label);
    // 活动 owner + 其工作——紧凑 logicalId（incr-4），绝非完整 session
    expect(labels.some((l) => l.includes("dev50.driver") && l.includes("pulse incr-3 build"))).toBe(true);
    expect(labels.some((l) => l.includes("dev50-driver@openrig-build"))).toBe(false); // full session dropped → drill recovers it
    // 无 in-progress qitem 的活动席仍在运行 → 裸显（诚实）
    expect(labels.some((l) => l.includes("dev50.planner"))).toBe(true);
    // 空闲 owner 属 PARKED，非此处；未知信号 owner 排除
    expect(labels.some((l) => l.includes("dev50.guard"))).toBe(false);
    expect(labels.some((l) => l.includes("dev50.qa"))).toBe(false);
    // NOW 无溢出：头计数 == 渲染引用
    expect(now.count).toBe(now.rows.length);
    expect(now.count).toBe(2);
    expect(now.rows.every((r) => r.glyph === "●")).toBe(true);
  });

  it("JUST FINISHED：近期 done/handed-off 按最新完成优先（tsUpdated 降序），带 HH:MM 时间", () => {
    const snap = liveSnap({
      recentlyFinished: [
        // 按 ts_created 顺序服务（非完成顺序）——视图按 tsUpdated 重排
        attn({ qitemId: "f1", state: "done", summary: "older close-out", tsUpdated: "2026-08-06T10:58:00.000Z" }),
        attn({ qitemId: "f2", state: "handed-off", summary: "newest fold receipt", tsUpdated: "2026-08-06T11:44:00.000Z" }),
        attn({ qitemId: "f3", state: "done", summary: "mid terminal CLEAR", tsUpdated: "2026-08-06T11:20:00.000Z" }),
      ],
    });
    const jf = buildPulseModel(snap, NOW).lanes[1];
    expect(jf.label).toBe("刚完成");
    expect(jf.rows.map((r) => r.label)).toEqual(["newest fold receipt", "mid terminal CLEAR", "older close-out"]);
    expect(jf.rows.map((r) => r.time)).toEqual(["11:44", "11:20", "10:58"]);
    expect(jf.rows.every((r) => r.glyph === "✓")).toBe(true);
    expect(jf.count).toBe(3);
  });

  it("UP NEXT：pending 按 served 顺序（逐字——无客户端优先级合成）；超上限显示 … 溢出行带真实总数", () => {
    const pend = Array.from({ length: 6 }, (_, i) => attn({ qitemId: `p${i}`, state: "pending", summary: `pending item ${i}`, claimedAt: null }));
    const un = buildPulseModel(liveSnap({ pending: pend }), NOW).lanes[2];
    expect(un.label).toBe("下一个");
    expect(un.count).toBe(6); // TRUE total (honesty floor — header is the referent total)
    expect(un.rows.length).toBe(5); // display cap
    // 服务顺序保留；最后渲染行是溢出标记
    expect(un.rows.slice(0, 4).map((r) => r.label)).toEqual(["pending item 0", "pending item 1", "pending item 2", "pending item 3"]);
    expect(un.rows[4]?.label).toBe("…");
    expect(un.rows.some((r) => r.label === "pending item 5")).toBe(false); // beyond-cap real item not fabricated as shown
    expect(un.rows.slice(0, 4).every((r) => r.glyph === "○")).toBe(true);
  });

  it("UP NEXT：仅未认领 pending（claimedAt null）——已认领滞留者排除", () => {
    const un = buildPulseModel(liveSnap({
      pending: [
        attn({ qitemId: "u1", state: "pending", summary: "unclaimed work", claimedAt: null }),
        attn({ qitemId: "c1", state: "pending", summary: "claimed already", claimedAt: ago(5 * MIN) }),
      ],
    }), NOW).lanes[2];
    expect(un.rows.map((r) => r.label)).toEqual(["unclaimed work"]);
    expect(un.count).toBe(1);
  });

  it("footer 计数 LIVE 且等于其引用集（active=NOW · parked=PARKED · waiting-you=NEEDS YOU）；updated-ago 从 hydratedAt 推导", () => {
    const snap = liveSnap({
      attention: [
        attn({ qitemId: "a1", summary: "gate one", claimedAt: ago(2 * MIN) }),
        attn({ qitemId: "a2", summary: "gate two", claimedAt: ago(3 * MIN) }),
      ],
      inProgress: [
        inprog({ qitemId: "n1", destinationSession: "dev50-driver@openrig-build", summary: "工作中" }),
        inprog({ qitemId: "pk", destinationSession: "dev50-guard@openrig-build", summary: "parked baton" }),
      ],
      seatActivity: [
        seat("dev50-driver@openrig-build", true, ago(1 * MIN)),
        seat("dev50-guard@openrig-build", false, ago(47 * MIN)),
      ],
      hydratedAt: ago(2000),
    });
    const model = buildPulseModel(snap, NOW);
    expect(model.footer.active).toBe(1); // NOW: driver only
    expect(model.footer.parked).toBe(1); // PARKED: guard
    expect(model.footer.waitingYou).toBe(2); // NEEDS YOU: two gates
    expect(model.footer.updatedAgo).toBe("2 秒前");
    // label==referent：footer 数字即构建的引用集（绝不发散）
    expect(model.footer.active).toBe(model.lanes[0].rows.length);
    expect(model.footer.parked).toBe(model.exceptions.find((s) => s.label === "停驻待接力")?.rows.length ?? 0);
    expect(model.footer.waitingYou).toBe(model.exceptions.find((s) => s.label === "需要你")?.rows.length ?? 0);
  });

  it("尚无 hydration 时间戳时 footer updated-ago 为诚实 —（绝不伪造龄）", () => {
    expect(buildPulseModel(liveSnap({ hydratedAt: undefined }), NOW).footer.updatedAgo).toBe("—");
  });

  it("◌ PARKED 龄未知带：空闲 owner（terminalActive false）无 lastActivityAt 渲染 idle (age unknown)，绝不裸露/伪造时长", () => {
    const snap = liveSnap({
      inProgress: [inprog({ qitemId: "qitem-x-noagey1", destinationSession: "dev50-guard@openrig-build", summary: "stranded" })],
      seatActivity: [seat("dev50-guard@openrig-build", false, null)], // idle owner, but NO activity stamp
    });
    const parked = buildPulseModel(snap, NOW).exceptions.find((s) => s.label === "停驻待接力")!;
    expect(parked).toBeDefined();
    const text = renderExceptionSection(parked).map((l) => l.text).join("\n");
    expect(text).toContain("空闲（年龄未知）");
    expect(text).not.toContain("进行中  空闲"); // never the bare double-space form
  });

  it("空 lane 诚实：零 live lane 源渲染空 lane 带 (0)，非陈旧 demo 行", () => {
    const model = buildPulseModel(liveSnap(), NOW);
    expect(model.lanes.map((l) => [l.label, l.count])).toEqual([
      ["现在", 0],
      ["刚完成", 0],
      ["下一个", 0],
    ]);
    expect(model.lanes.every((l) => l.rows.length === 0)).toBe(true);
    // 且旧静态 demo lane 内容必须从 live builder 消失
    expect(model.lanes.flatMap((l) => l.rows.map((r) => r.label)).join(" ")).not.toContain("slice 51-01 stub");
  });
});

describe("PULSE 视图增量4——紧凑 seat lane 形态 + drill-in 动作", () => {
  it("NOW 标签为紧凑 logicalId（r1 mock 权威裁决）；完整 session 从条带丢弃", () => {
    const snap = liveSnap({
      inProgress: [inprog({ qitemId: "n1", destinationSession: "dev50-driver@openrig-build", summary: "pulse incr-4 build" })],
      seatActivity: [seat("dev50-driver@openrig-build", true, ago(1 * MIN), "dev50.driver")],
    });
    const now = buildPulseModel(snap, NOW).lanes[0];
    expect(now.rows[0]!.label).toBe("dev50.driver  pulse incr-4 build"); // compact id + work
    expect(now.rows[0]!.label).not.toContain("@openrig-build"); // full session NOT on the strip
  });

  it("紧凑形态仅 lane：异常行保留完整 session", () => {
    const snap = liveSnap({
      inProgress: [inprog({ qitemId: "pk", destinationSession: "dev50-guard@openrig-build", summary: "stranded" })],
      seatActivity: [seat("dev50-guard@openrig-build", false, ago(47 * MIN), "dev50.guard")],
    });
    const parked = buildPulseModel(snap, NOW).exceptions.find((s) => s.label === "停驻待接力")!;
    const text = renderExceptionSection(parked).map((l) => l.text).join("\n");
    expect(text).toContain("dev50-guard@openrig-build"); // exceptions keep the FULL session
    expect(text).not.toContain("dev50.guard"); // and NOT the compact lane form
  });

  it("NOW 行 drill 到该席的 agent（session→topology）——恢复紧凑标签丢弃的完整身份", () => {
    const snap = liveSnap({
      inProgress: [inprog({ qitemId: "n1", destinationSession: "dev50-driver@openrig-build", summary: "work" })],
      seatActivity: [seat("dev50-driver@openrig-build", true, ago(1 * MIN), "dev50.driver")],
    });
    const now = buildPulseModel(snap, NOW).lanes[0];
    expect(now.rows[0]!.action).toEqual({ type: "drill", resource: "agent", name: "dev50.driver", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
  });

  it("拓扑缺失的 NOW 席降级为 `notice` 揭示完整身份——绝非死键", () => {
    const snap = liveSnap({
      seatActivity: [seat("ghost-seat@remote", true, ago(1 * MIN), "ghost.seat")],
    });
    const now = buildPulseModel(snap, NOW).lanes[0];
    expect(now.rows[0]!.label).toBe("ghost.seat"); // bare compact (no in-progress work)
    expect(now.rows[0]!.action).toEqual({ type: "notice", message: "ghost-seat@remote" });
  });

  it("JUST FINISHED 行 drill 到完成它的席（destinationSession→agent）", () => {
    const snap = liveSnap({
      recentlyFinished: [attn({ qitemId: "f1", state: "done", destinationSession: "dev50-guard@openrig-build", summary: "close-out", tsUpdated: "2026-08-06T11:44:00.000Z" })],
    });
    const jf = buildPulseModel(snap, NOW).lanes[1];
    expect(jf.rows[0]!.action).toEqual({ type: "drill", resource: "agent", name: "dev50.guard", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
  });

  it("UP NEXT 行 drill 到目标席；… 溢出标记无动作（非实体→不可选）", () => {
    const pend = Array.from({ length: 6 }, (_, i) => attn({ qitemId: `p${i}`, state: "pending", destinationSession: "dev50-qa@openrig-build", summary: `item ${i}`, claimedAt: null }));
    const un = buildPulseModel(liveSnap({ pending: pend }), NOW).lanes[2];
    expect(un.rows[0]!.action).toEqual({ type: "drill", resource: "agent", name: "dev50.qa", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    expect(un.rows[4]!.label).toBe("…");
    expect(un.rows[4]!.action).toBeUndefined();
  });
});
