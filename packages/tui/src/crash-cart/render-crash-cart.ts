// 故障诊断座舱渲染器（5.2 Wave B，计划 c015d9ed §C3）——model → 行，以 TUI 惯用方式复现
// 批准 mock（3d3c90a0）的结构/顺序/强调。字形集 ◌/▦/⏎/✓ 和分区措辞是契约；
// 仅主题 token（无发明颜色）。粗体文本携带颜色 token（`bright`），因为纯粗体 seg
// 在此管道中渲染为普通墨色。
import type { Token } from "../theme.js";
import type { CrashCartModel } from "./crash-cart-model.js";
import type { DaemonUnverifiedEvidence } from "./contract.js";
import type { RestoreLifecycleVM } from "./restore-lifecycle.js";
import { renderTriage } from "./triage.js";

interface Seg {
  text: string;
  token?: Token;
  bold?: boolean;
  bg?: Token;
  inverse?: boolean;
}
interface Line {
  text: string;
  segs?: Seg[];
  selected?: boolean;
}

/** 构建一行，其纯 `text` 是 segs 的拼接（捕获/宽度真值）。 */
function line(segs: Seg[], opts?: { selected?: boolean }): Line {
  return { text: segs.map((s) => s.text).join(""), segs, ...(opts?.selected ? { selected: true } : {}) };
}

/** 后台服务停止头部：`◌ 后台服务未运行`（warn）+ 置灰状态尾部。运行时间 + 原因
 *  槽位渲染显式诚实未知文本（PM 裁决）——结构/顺序按 mock。 */
export function renderCrashCartHeader(model: CrashCartModel): Line {
  const h = model.header;
  return line([
    { text: "◌ 后台服务未运行", token: "warn" },
    {
      text: ` — 最后见于 ${h.lastSeen}（运行时间 ${h.uptimeText}）· 原因：${h.reasonText}`,
      token: "dim",
    },
  ]);
}

/** `在此主机上找到` + 每个工作组一行：`▦ <名称>  <n> 个席位 · 最后活动 <t> · <r> 个会话可恢复`。
 *  名称列填充到最宽名称 + 4 空格间距，使详情对齐（mock 的固定列）。 */
export function renderFoundOnHost(model: CrashCartModel): Line[] {
  const out: Line[] = [line([{ text: "在此主机上找到", token: "dim" }])];
  const nameCol = Math.max(0, ...model.foundOnHost.map((r) => r.name.length)) + 4;
  for (const r of model.foundOnHost) {
    const pad = " ".repeat(Math.max(0, nameCol - r.name.length));
    out.push(
      line([
        { text: " ▦ " },
        { text: r.name, token: "bright", bold: true },
        { text: pad },
        {
          text: `${r.seatCount} 个席位 · 最后活动 ${r.lastActive} · ${r.resumableCount} 个会话可恢复`,
          token: "dim",
        },
      ]),
    );
  }
  return out;
}

/** `工作停止处（来自持久化台账）` + 每个进行中项一行 `◌ <会话> — qitem 进行中："<摘要>" (<t>)`，
 *  然后始终为 `✓ 其余在停止时均为空闲清理` 的结束行。 */
export function renderWhereWorkStopped(model: CrashCartModel): Line[] {
  const out: Line[] = [
    line([
      { text: "工作停止处", token: "dim" },
      { text: "（来自持久化台账）", token: "dim" },
    ]),
  ];
  for (const w of model.whereWorkStopped) {
    out.push(
      line([
        { text: " ◌ ", token: "warn" },
        { text: w.session },
        { text: ` — qitem 进行中："${w.summary}" (${w.time})`, token: "dim" },
      ]),
    );
  }
  out.push(line([{ text: " ✓ ", token: "ok" }, { text: "其余在停止时均为空闲清理" }]));
  return out;
}

/** 动作块：高亮主行 `⏎ 恢复全部 …` + 副键行。 */
export function renderActions(): Line[] {
  return [
    line(
      [
        {
          text: " ⏎ 恢复全部 — 后台服务 + 内核 + 所有工作组，会话在席位上恢复 ",
          bg: "accent",
        },
      ],
      { selected: true },
    ),
    line([
      { text: "  s 仅启动后台服务  ·  i 检查工作组  ·  n 新用户？引导" },
      { text: "（策略菜单现在此处）", token: "dim" },
    ]),
  ];
}

/** 首次运行框架（停止 + 无数据库）：全新主机，非故障——引导，绝非故障头部或
 *  恢复空内容（PM 裁决：故障语言需要先前生命证据）。 */
export function renderFirstRunView(): Line[] {
  return [
    line([
      { text: "◌ 无后台服务运行", token: "warn" },
      { text: " — 此主机上尚未找到工作组（全新主机）", token: "dim" },
    ]),
    { text: "" },
    line([{ text: "无可恢复内容——这看起来像首次运行。", token: "dim" }]),
    { text: "" },
    line([{ text: " ⏎ n 新用户？引导（策略菜单现在此处） ", bg: "accent" }], { selected: true }),
    line([{ text: "  s 仅启动后台服务" }]),
  ];
}

/** 整个故障诊断座舱视图：recovery = 头部 → 在此主机上找到 → 工作停止处 →
 *  动作（mock 逐字顺序）；first-run = 引导框架。 */
export function renderCrashCartView(model: CrashCartModel): Line[] {
  if (model.mode === "first-run") return renderFirstRunView();
  return [
    renderCrashCartHeader(model),
    { text: "" },
    ...renderFoundOnHost(model),
    { text: "" },
    ...renderWhereWorkStopped(model),
    { text: "" },
    ...renderActions(),
  ];
}

/** DONE 头部的字形 + token，按派生的舰队判决——结论必须匹配
 *  真相：仅全恢复舰队佩戴成功 ✓；all_failed 是 ✗；none_attempted / mixed 携带
 *  警告，绝不成功字形（BLOCKER 2——汇总诚实，头部不诚实）。 */
function verdictGlyph(verdict: string): { glyph: string; token: Token } {
  switch (verdict) {
    case "all_fully_restored":
      return { glyph: "✓", token: "ok" };
    case "all_failed":
      return { glyph: "✗", token: "error" };
    default:
      return { glyph: "⚠", token: "warn" }; // none_attempted / mixed / partially — 非成功
  }
}

/** 按汇总结果的按工作组进度行字形。 */
function outcomeGlyph(outcome: string): { glyph: string; token: Token } {
  switch (outcome) {
    case "fully_restored":
      return { glyph: "✓", token: "ok" };
    case "partially_restored":
      return { glyph: "◑", token: "warn" };
    case "failed":
      return { glyph: "✗", token: "error" };
    default:
      return { glyph: "◌", token: "dim" }; // not_attempted
  }
}

/** 恢复生命周期视图（B1 ROUND 2）。运行中：实时头部 + 按工作组进度列表
 *  从每次轮询更新（汇总流）+ 取消可用性。完成时：判决 + 计数
 *  和已发布的可键盘遍历诊断列表（renderTriage）——每个席位/工作组在自己行上，带有其
 *  确切需要，绝非宽度裁剪的一行页脚摘要。 */
export function renderRestoreLifecycleView(vm: RestoreLifecycleVM): Line[] {
  const c = vm.counts;
  const total = c.fully_restored + c.partially_restored + c.failed + c.not_attempted;
  const countsSeg: Seg = {
    text: `${c.fully_restored} 已恢复 · ${c.partially_restored} 部分 · ${c.failed} 失败 · ${c.not_attempted} 未尝试`,
    token: "dim",
  };

  if (vm.phase === "running") {
    const out: Line[] = [
      line([
        { text: "⟳ 正在恢复舰队", token: "bright", bold: true },
        { text: `  — 到目前为止 ${total} 个已完成`, token: "dim" },
      ]),
      line([countsSeg]),
    ];
    // HIGH-1——已接受的取消诚实渲染：状态说明已请求取消且
    // 当前工作组将完成，不再提供初始 `c cancel` 可用性。
    if (vm.cancelled) out.push(line([{ text: "⚠ 已请求取消——当前工作组将完成，然后停止", token: "warn" }]));
    out.push({ text: "" });
    for (const p of vm.progress) {
      const g = outcomeGlyph(p.outcome);
      out.push(line([{ text: ` ${g.glyph} `, token: g.token }, { text: p.rigId, token: "bright" }, { text: `  ${p.outcome}`, token: "dim" }]));
    }
    out.push({ text: "" });
    out.push(
      vm.cancelled
        ? line([{ text: "  取消已接受——等待当前工作组；恢复在下一个之前停止", token: "dim" }])
        : line([{ text: "  c 取消（在下一个工作组前停止）  ·  按工作组继续恢复", token: "dim" }]),
    );
    return out;
  }

  if (vm.phase === "detached") {
    // 实时视图超出窗口暂停（轮询上限或持续轮询错误连击）——
    // 恢复在后台服务上继续，而非停止。显式、可操作的状态：重新附着恢复
    // 实时视图，取消按保留 ID 在下一个工作组前停止（两者通过恢复的轮询可观察）。
    const out: Line[] = [
      line([
        { text: "⚠ 恢复仍在后台服务上运行", token: "warn", bold: true },
        { text: `  — 尝试 ${vm.attemptId}`, token: "dim" },
      ]),
      line([{ text: "实时视图超出窗口暂停；恢复在后台服务上继续，而非停止。", token: "dim" }]),
      line([countsSeg]),
    ];
    // HIGH-1——如果已请求取消，说明并丢弃 `c cancel` 提供；重新附着确认。
    if (vm.cancelled) out.push(line([{ text: "⚠ 已请求取消——重新附着以确认其到达后台服务", token: "warn" }]));
    out.push({ text: "" });
    for (const p of vm.progress) {
      const g = outcomeGlyph(p.outcome);
      out.push(line([{ text: ` ${g.glyph} `, token: g.token }, { text: p.rigId, token: "bright" }, { text: `  ${p.outcome}`, token: "dim" }]));
    }
    out.push({ text: "" });
    out.push(
      vm.cancelled
        ? line([{ text: "  r 重新附着（确认取消）  ·  任意键关闭", token: "dim" }])
        : line([{ text: "  r 重新附着（恢复实时视图）  ·  c 取消（在下一个工作组前停止）  ·  任意键关闭", token: "dim" }]),
    );
    return out;
  }

  // done
  const vg = verdictGlyph(vm.verdict);
  const out: Line[] = [
    line([
      { text: `${vg.glyph} 舰队恢复：${vm.verdict}`, token: vg.token, bold: true },
      ...(vm.cancelled ? [{ text: "（已取消）", token: "warn" as Token }] : []),
    ]),
    line([countsSeg]),
    { text: "" },
    // 已发布的诊断渲染器——每个需要一行可键盘遍历行（席位 + 确切补救），
    // 或全清理行。这是门测试断言的表面。
    ...renderTriage(vm.triage),
  ];
  return out;
}

/** B1 ROUND 10——⏎ 确认横幅，渲染在座舱顶部，使操作者在看的位置
 *  看到确认。第一次 ⏎ 曾不可见，因为确认进入了 ViewState.notice，
 *  后台服务停止座舱不渲染它。消息已列出差异和 ⏎ 继续 / Esc 取消可用性。 */
export function renderConfirmBanner(message: string): Line[] {
  return [
    line([{ text: "⚠ 确认恢复", token: "warn", bold: true }]),
    line([{ text: message, token: "bright" }]),
    { text: "" },
  ];
}

/** UNVERIFIED 屏幕（规划器+PM 裁决）：最小化的独特视图——证据逐字 + 重试 +
 *  退出 + 工作组状态提示，零恢复动作（绝不座舱，绝不恢复）。 */
export function renderUnverifiedView(evidence: DaemonUnverifiedEvidence): Line[] {
  return [
    line([
      { text: "◌ 无法验证后台服务", token: "warn" },
      { text: " — 可能繁忙/卡住，未确认已停止", token: "dim" },
    ]),
    { text: "" },
    line([{ text: " pid:    ", token: "dim" }, { text: evidence.pidState }]),
    line([{ text: " 探测:  ", token: "dim" }, { text: evidence.probeResult }]),
    line([{ text: " 信号: ", token: "dim" }, { text: evidence.failedSignal }]),
    { text: "" },
    line([{ text: "  r 重试  ·  q 退出  ·  尝试：zrig status", token: "dim" }]),
  ];
}

// 全宽 Screen 包装器（renderCrashCartScreen/renderUnverifiedScreen/linesToScreen）在
// shell 布局重做中移除（裁决 3c6c2be0）：座舱现在作为内容面板视图渲染在
// 标准 shell 内（render.ts crashCartShell），因此上面的内容构建器产生
// Line[]，shell 拥有 Screen。仅它们使用的全宽 stylize 分支也已消失。
