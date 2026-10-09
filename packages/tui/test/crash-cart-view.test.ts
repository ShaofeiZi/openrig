import { describe, it, expect } from "vitest";
import {
  buildCrashCartModel,
  demoCrashCartModel,
  hhmm,
  NO_SHUTDOWN_RECORD,
  type CrashCartDiscoveryInput,
} from "../src/crash-cart/crash-cart-model.js";
import { renderCrashCartView } from "../src/crash-cart/render-crash-cart.js";

// Crash-cart cockpit VIEW（5.2 Wave B，plan c015d9ed §C3）。mock 逐字（批准 mock 3d3c90a0）：
// 精确字符串布局断言（本包通用的字节真值机制）+ seg 绘制
// 意图（粗体文本必带颜色 token 否则渲染为纯——no-op 类）。PM 裁决：
// header stop-reason + prior-uptime 是显式诚实未知，绝不空白/推断。

describe("renderCrashCartView——mock 逐字布局（demo）", () => {
  const body = renderCrashCartView(demoCrashCartModel())
    .map((l) => l.text)
    .join("\n");

  it("渲染 daemon-down 头，含诚实未知 uptime + 原因（结构按 mock）", () => {
    expect(body).toContain(
      "◌ 后台服务未运行 — 最后见于 08:12（运行时间 不可用 — 无关闭记录）· 原因：不可用 — 无关闭记录",
    );
  });

  it("渲染 FOUND ON THIS HOST 行，详情对齐", () => {
    expect(body).toContain("在此主机上找到");
    expect(body).toContain(" ▦ openrig-pm    13 个席位 · 最后活动 08:11 · 7 个会话可恢复");
    expect(body).toContain(" ▦ kernel        4 个席位 · 最后活动 08:12 · 4 个会话可恢复");
    expect(body).toContain(" ▦ oversight     3 个席位 · 最后活动 07:58 · 3 个会话可恢复");
  });

  it("渲染 WHERE WORK STOPPED，先 in-progress 项后 idle-clean 收尾", () => {
    expect(body).toContain("工作停止处（来自持久化台账）");
    expect(body).toContain(' ◌ pm-openrig — qitem 进行中："cut packet assembly" (08:09)');
    expect(body).toContain(" ✓ 其余在停止时均为空闲清理");
  });

  it("渲染 actions 块：高亮 RESTORE EVERYTHING + 次要键", () => {
    expect(body).toContain(
      " ⏎ 恢复全部 — 后台服务 + 内核 + 所有工作组，会话在席位上恢复 ",
    );
    expect(body).toContain(
      "  s 仅启动后台服务  ·  i 检查工作组  ·  n 新用户？引导（策略菜单现在此处）",
    );
  });

  it("区段顺序：header → FOUND → WHERE WORK STOPPED → actions", () => {
    expect(body.indexOf("在此主机上找到")).toBeGreaterThan(body.indexOf("后台服务未运行"));
    expect(body.indexOf("工作停止处")).toBeGreaterThan(body.indexOf("在此主机上找到"));
    expect(body.indexOf("恢复全部")).toBeGreaterThan(body.indexOf("工作停止处"));
  });
});

describe("renderCrashCartView——seg-paint 意图（bold 带 token；选择绘背景）", () => {
  const lines = renderCrashCartView(demoCrashCartModel());

  it("daemon-down 字形/label 为 warn", () => {
    const header = lines.find((l) => l.text.startsWith("◌ 后台服务未运行"))!;
    const warnSeg = header.segs!.find((s) => s.text.includes("后台服务未运行"));
    expect(warnSeg?.token).toBe("warn");
  });

  it("rig name seg 带颜色 token AND bold（绝不只 bold → 绝不 paint no-op）", () => {
    const rigLine = lines.find((l) => l.text.includes("openrig-pm"))!;
    const nameSeg = rigLine.segs!.find((s) => s.text === "openrig-pm")!;
    expect(nameSeg.bold).toBe(true);
    expect(nameSeg.token).toBeTruthy(); // has a color → won't render plain
  });

  it("RESTORE EVERYTHING 行被选中并绘强调背景", () => {
    const restore = lines.find((l) => l.text.includes("恢复全部"))!;
    expect(restore.selected).toBe(true);
    expect(restore.segs!.some((s) => s.bg === "accent")).toBe(true);
  });

  it("idle-clean 行的 ✓ 为 ok 色调", () => {
    const idle = lines.find((l) => l.text.includes("其余在停止时均为空闲清理"))!;
    expect(idle.segs!.find((s) => s.text.includes("✓"))?.token).toBe("ok");
  });
});

describe("buildCrashCartModel——适配 C2 discovery；honest-null → honest-unknown", () => {
  const discovery: CrashCartDiscoveryInput = {
    header: { lastActivityAt: "2026-08-06T08:12:00Z" },
    foundOnHost: [
      { rigName: "alpha", seatCount: 5, resumableCount: 3, lastActiveAt: "2026-08-06 07:58:00" },
    ],
    whereWorkStopped: [
      { destinationSession: "worker@alpha", summary: "build X", tsUpdated: "2026-08-06T08:09:00Z" },
    ],
  };

  it("映射 last-seen/rigs/stopped，并强制两个头槽为 honest-unknown", () => {
    const m = buildCrashCartModel(discovery);
    expect(m.header).toEqual({
      lastSeen: "08:12",
      uptimeText: NO_SHUTDOWN_RECORD,
      reasonText: NO_SHUTDOWN_RECORD,
    });
    expect(m.foundOnHost[0]).toEqual({ name: "alpha", seatCount: 5, lastActive: "07:58", resumableCount: 3 });
    expect(m.whereWorkStopped[0]).toEqual({ session: "worker@alpha", summary: "build X", time: "08:09" });
  });

  it("无 in-progress 项时只显示 idle-clean 收尾（无 ◌ 行）", () => {
    const m = buildCrashCartModel({ ...discovery, whereWorkStopped: [] });
    const body = renderCrashCartView(m).map((l) => l.text).join("\n");
    expect(body).toContain(" ✓ 其余在停止时均为空闲清理");
    expect(body).not.toContain("qitem 进行中");
  });

  it("hhmm 处理 ISO-Z、空格形式与 null", () => {
    expect(hhmm("2026-08-06T08:12:34Z")).toBe("08:12");
    expect(hhmm("2026-08-06 07:58:00")).toBe("07:58");
    expect(hhmm(null)).toBe("未知");
  });
});
