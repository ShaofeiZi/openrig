// 故障诊断 C3 后续——座舱动作键解析器（纯逻辑）。仅在后台服务停止
// 屏幕显示时激活；main.ts 执行解析出的动作（exec `rig daemon start` / 重新探测等）。
// RESTORE（⏎）路由到 C1 批量控制器（本轮排除 → main.ts 显示带标签的接缝，
// 绝不静默 no-op）。按键因模式而异：恢复座舱提供恢复/检查；首次运行
// （无先前生命）仅提供引导 + 启动后台服务（绝不恢复空内容）。
import type { CrashCartRenderOpts } from "./from-emit.js";
import { evaluateOneClickGate } from "./one-click-gate.js";

// `restore` = 零代一键（每个席位恢复原始）；`restore-confirm` =
// 当某些工作组有不可恢复席位时的带门禁路径（main.ts 在继续前列出差异——绝不静默恢复→全新降级）。
// 创建者的一键规则对 ⏎ 具有约束力。
export type CrashCartKeyAction = "start-daemon" | "retry" | "details" | "inspect" | "onboarding" | "restore" | "restore-confirm";

/** 将按键（"s"/"i"/"n"/"r"/"enter"）映射到活动后台服务停止屏幕的故障诊断动作，
 *  或 null（此处不是故障诊断键 → 落入正常 TUI 处理）。 */
export function resolveCrashCartKey(key: string, opts: CrashCartRenderOpts): CrashCartKeyAction | null {
  if (opts.unavailable) return key === "r" ? "retry" : key === "d" ? "details" : null;
  if (opts.daemonState === "down") {
    const firstRun = opts.crashCart?.mode === "first-run";
    if (key === "s") return "start-daemon";
    if (key === "n") return "onboarding";
    if (!firstRun && key === "i") return "inspect";
    if (!firstRun && key === "enter") {
      // H2 —— 查询一键门禁：⏎ 仅在恢复计划为零代时是单次按键。
      // 任何有不可恢复席位的工作组路由到确认路径（列出差异）。
      const gate = evaluateOneClickGate({
        foundOnHost: (opts.crashCart?.foundOnHost ?? []).map((r) => ({
          rigName: r.name,
          seatCount: r.seatCount,
          resumableCount: r.resumableCount,
        })),
      });
      return gate.zeroGeneration ? "restore" : "restore-confirm";
    }
    return null;
  }
  if (opts.daemonState === "unverified") {
    return key === "r" ? "retry" : null;
  }
  return null;
}
