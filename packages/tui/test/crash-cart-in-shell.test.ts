import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoCrashCartModel, buildCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { buildRestoreLifecycleVM, type RestoreFrame } from "../src/crash-cart/restore-lifecycle.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { strWidth } from "../src/text-width.js";

function sliceFromTerminalColumn(line: string, columns: number): string {
  let index = 0;
  let used = 0;
  for (const char of line) {
    if (used >= columns) break;
    used += strWidth(char);
    index += char.length;
  }
  return line.slice(index);
}

// Crash-cart shell 放置重做（ruling 3c6c2be0）——cockpit 作为 content 窗格视图
// 渲染于标准 shell 内：explorer 侧栏恒在（│ 在 EXPL_W），ledger 供给 +
// 诚实标记 daemon-down；批准内容逐字移入右窗。所有轨成立。

const snap = emptySnapshot();
const view = createViewState({ instanceId: "t", getSnapshot: () => snap });

describe("不可用的启动前提", () => {
  it("点名 native load 失败，不推断缺失历史或提供恢复", () => {
    const screen = renderScreen(view.get(), snap, { cols: 100, rows: 32,
      unavailable: "ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch", unavailableExpanded: false });
    const body = screen.lines.join("\n");
    expect(body).toContain("原生模块");
    expect(body).toContain("r 重试");
    expect(body).not.toContain("恢复全部");
    expect(body).not.toContain("fresh host");
    expect(body).not.toContain("NODE_MODULE_VERSION");
  });
  it("展开有用失败详情，同时移除 terminal 控制与凭证", () => {
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32,
      unavailable: "probe failed https://user:secret@example.test/path Bearer secret-token", unavailableExpanded: true });
    const body = screen.lines.join("\n");
    expect(body).toContain("probe failed");
    expect(body).not.toContain("secret");
    expect(body).toContain("[redacted]");
  });
});

describe("renderScreen daemon-down——in-shell 分屏（explorer 始终在场）", () => {
  const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel() });
  const body = screen.lines.join("\n");

  it("有 explorer│content 分屏（body 行在 EXPL_W 处有 │ 边框）", () => {
    const borderRows = screen.lines.filter((l) => l.charAt(screen.explorerWidth) === "┃");
    expect(borderRows.length).toBeGreaterThan(3);
  });

  it("用 rig 名 + 诚实 ledger 标记 ledger-喂给 explorer（绝不二次读取）", () => {
    const left = screen.lines.map((l) => l.slice(0, screen.explorerWidth)).join("\n");
    expect(left).toContain("openrig-pm");
    expect(left).toContain("kernel");
    expect(left.toLowerCase()).toContain("台账"); // honestly marked ledger-sourced
    expect(left).toContain("后台服务已停止");
    expect(screen.lines.at(-1)).toContain("台账来源 · 后台服务已停止");
  });

  it("把批准的 cockpit CONTENT 逐字移入右窗格（所有轨保持）", () => {
    const right = screen.lines.map((l) => sliceFromTerminalColumn(l, screen.explorerWidth + 1)).join("\n");
    expect(right).toContain("后台服务未运行");
    expect(right).toContain("恢复全部");
    expect(right).toContain("不可用 — 无关闭记录"); // honest-null header slot preserved
    expect(right).toContain("工作停止处");
  });

  it("经 stylize：strip 不变量成立 + RESTORE 强调背景绘出（分屏路径）", () => {
    const styled = stylizeLines(screen, createStyle("truecolor"));
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
    const restoreIdx = screen.lines.findIndex((l) => l.includes("恢复全部"));
    expect(styled[restoreIdx]).toMatch(/48;2;/);
  });
});

// B1 ROUND 2——活动 restore 面经 renderScreen（真实管道）渲染，证明
// mid-run 帧可见（r2 HIGH-3）且 done triage 列表在 shell 内不裁剪（r2 HIGH-4）。
function frame(over: Partial<RestoreFrame>): RestoreFrame {
  return {
    attemptId: "fleet-1",
    phase: over.phase ?? "running",
    done: over.done ?? false,
    cancelled: over.cancelled ?? false,
    verdict: over.verdict ?? "none_attempted",
    rollup: over.rollup ?? { counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] },
  };
}

describe("renderScreen——ACTIVE 恢复优先（运行中进度帧，in-shell）", () => {
  it("running：显示 RESTORING FLEET + 每 rig 进度 + cancel 可操作项，而非 cockpit", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "running",
        rollup: {
          counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 0 },
          sequence: [{ rigId: "kernel", outcome: "fully_restored" }],
          attention_required: [],
        },
      }),
    );
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm });
    const body = screen.lines.join("\n");
    expect(screen.lines.filter((l) => l.charAt(screen.explorerWidth) === "┃").length).toBeGreaterThan(3); // still in-shell
    expect(body).toContain("正在恢复舰队"); // the mid-run frame
    expect(body).toContain("kernel");
    expect(body).toContain("c 取消");
    expect(body).not.toContain("恢复全部"); // the cockpit is superseded by the active restore
    expect(screen.lines.at(-1)).toContain("台账来源 · 后台服务已停止");
  });

  it("done：在 in-shell 渲染可键盘遍历的 triage 列表——确切 need 不被截断", () => {
    const vm = buildRestoreLifecycleVM(
      frame({
        phase: "done",
        done: true,
        verdict: "mixed",
        rollup: {
          counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 1 },
          sequence: [
            { rigId: "kernel", outcome: "fully_restored" },
            { rigId: "beta", outcome: "not_attempted", reason: "no restore-usable snapshot for this rig", remediation: "take a snapshot" },
          ],
          attention_required: [{ rigId: "kernel", seat: "dev.guard", need: "original session not resumable and no --fresh — choose fresh-prime or skip" }],
        },
      }),
    );
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm });
    const body = screen.lines.join("\n");
    expect(body).toContain("舰队恢复：mixed");
    expect(body).toContain("待关注");
    // 完整 need 换行（非裁剪）：每个词都活过窗格，故精确 need 的头与
    // 尾皆在场——无词从右缘掉落（r2 HIGH-4 缺陷）。
    expect(body).toContain("choose");
    expect(body).toContain("fresh-prime");
    expect(body).toContain("or skip");
    expect(body).toContain("take a snapshot"); // the not_attempted remediation survives too
    expect(screen.lines.at(-1)).toContain("台账来源 · 后台服务已停止");
    // 且换行延续在其行下悬挂缩进（第二可见行）
    const paneText = screen.lines.map((l) => l.slice(screen.explorerWidth + 1)).join("\n");
    expect(paneText).toMatch(/skip/);
  });
});

describe("renderScreen——恢复 triage 可键盘遍历超出视口 (r2 HIGH-2)", () => {
  // r2 精确探针：120x32 下 28 个 attention 行。偏移 0 时尾部 need 在屏外；
  // shell 必报可导航的 contentMaxOffset，滚到它必把最终 need 带上屏。
  // 短 need（一行放下，不换行）以把垂直可达性（HIGH-2）与宽度换行隔离。
  const attention = Array.from({ length: 28 }, (_, i) => ({
    rigId: "kernel",
    seat: `seat${i}`,
    need: `NEED-${i}: resume seat ${i}`,
  }));
  const vm = buildRestoreLifecycleVM(
    frame({
      phase: "done",
      done: true,
      verdict: "mixed",
      rollup: { counts: { fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [{ rigId: "kernel", outcome: "fully_restored" }], attention_required: attention },
    }),
  );

  it("offset 0 时列表溢出视口 → 报告可导航的 contentMaxOffset", () => {
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: 0 });
    expect(screen.contentMaxOffset).toBeGreaterThan(0); // scrollable, not a dead fixed window
    const body = screen.lines.join("\n");
    expect(body).toContain("NEED-0"); // first need on-screen
    expect(body).not.toContain("NEED-27"); // the tail is off-screen at offset 0 (the defect r2 probed)
  });

  it("滚到 contentMaxOffset 把最后一行的确切 need 带到屏上（可达）", () => {
    const max = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: 0 }).contentMaxOffset;
    const scrolled = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: max });
    const body = scrolled.lines.join("\n");
    expect(body).toContain("NEED-27: resume seat 27"); // the exact final need is now reachable — R5
    expect(body).toContain("seat27@kernel"); // its seat too
  });
});

// B1 ROUND 10（gap 1）——⏎ 确认必在 cockpit 中可见（不仅在 ViewState.notice，
// daemon-down cockpit 不渲染它——首个 ⏎ 曾看似无反应）。
describe("renderScreen daemon-down——⏎ 确认横幅渲染在 cockpit 内", () => {
  const confirm = "⏎ 恢复：openrig-pm (6/13) 有无法恢复的席位——它们需要在诊断列表中做出决策（全新初始化或跳过）。按 ⏎ 继续，按 Esc 取消。";
  it("在操作者视线处显示确认横幅 + proceed/cancel 可操作项", () => {
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), confirm });
    const body = screen.lines.join("\n");
    expect(body).toContain("确认恢复");
    expect(body).toContain("无法恢复");
    expect(body).toContain("继续"); // ⏎ proceed advertised in the cockpit
    expect(body).toContain("取消"); // Esc cancel advertised in the cockpit
  });
  it("无确认时 cockpit 不显示确认横幅（RESTORE EVERYTHING 是主操作）", () => {
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel() });
    const body = screen.lines.join("\n");
    expect(body).not.toContain("确认恢复");
    expect(body).toContain("恢复全部");
  });
});

describe("renderScreen daemon-down——UNVERIFIED in-shell（explorer 在场，无恢复）", () => {
  it.each([80, 120, 170])("keeps body, sidebar and footer unverified at %i columns, without claiming a ledger read", (cols) => {
    const screen = renderScreen(view.get(), snap, {
      cols,
      rows: 32,
      daemonState: "unverified",
      daemonEvidence: { pidState: "alive (pid 7)", probeResult: "timeout", failedSignal: "healthz timed out" },
    });
    const body = screen.lines.join("\n");
    const sidebar = screen.lines.slice(2, -3).map((line) => line.slice(0, screen.explorerWidth)).join("\n");
    expect(screen.lines.filter((l) => l.charAt(screen.explorerWidth) === "┃").length).toBeGreaterThan(3);
    expect(body).toContain("无法验证后台服务");
    expect(body).toContain("alive (pid 7)");
    expect(body).not.toContain("恢复全部");
    expect(sidebar).toContain("后台服务未验证");
    expect(screen.lines.at(-1)).toContain("后台服务未验证");
    expect(body).not.toContain("后台服务关闭");
    expect(body).not.toContain("ledger-sourced");
  });

  it("让 up daemon 留在常规渲染路径", () => {
    const normal = renderScreen(view.get(), snap, { cols: 120, rows: 32 });
    const up = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "up" });
    expect(up).toEqual(normal);
    expect(up.lines.join("\n")).not.toContain("[故障诊断]");
  });
});

describe("renderScreen daemon-down——first-run in-shell（引导，无崩溃叙事）", () => {
  const screen = renderScreen(view.get(), snap, {
    cols: 120,
    rows: 32,
    daemonState: "down",
    crashCart: buildCrashCartModel({ header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] }),
  });
  const body = screen.lines.join("\n");
  it("有 shell + 引导框架，无崩溃头/RESTORE；无 rig 时 explorer 仍标 ledger", () => {
    expect(screen.lines.filter((l) => l.charAt(screen.explorerWidth) === "┃").length).toBeGreaterThan(3);
    expect(body).not.toContain("后台服务未运行");
    expect(body).not.toContain("恢复全部");
    expect(body).toContain("引导");
    const left = screen.lines.map((l) => l.slice(0, screen.explorerWidth)).join("\n");
    expect(left.toLowerCase()).toContain("台账"); // explorer honestly marked even with no rigs
  });
});
