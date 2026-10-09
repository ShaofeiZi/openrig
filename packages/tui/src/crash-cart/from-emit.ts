// 故障诊断 C3 单元 C——将解析后的 `rig crash-cart --json` 判决映射到 renderScreen
// 后台服务停止选项。拒绝和不可用前提保持可见，不将
// 失败的发现变为恢复或铸造身份的许可。
import type { DaemonState, DaemonUnverifiedEvidence } from "./contract.js";
import { buildCrashCartModel, type CrashCartDiscoveryInput, type CrashCartModel } from "./crash-cart-model.js";
import type { RestoreLifecycleVM } from "./restore-lifecycle.js";

/** `rig crash-cart --json` 载荷（镜像后台服务动词的输出——文档化的 JSON 契约）。 */
export interface CrashCartEmit {
  state: DaemonState;
  evidence?: DaemonUnverifiedEvidence;
  discovery?: CrashCartDiscoveryInput;
  refusal?: string;
}

/** TUI 喂给 renderScreen 的 RenderOptions 中后台服务停止子集（空 ⇒ 正常舰队视图）。 */
export interface CrashCartRenderOpts {
  unavailable?: string;
  unavailableExpanded?: boolean;
  starting?: string;
  daemonState?: DaemonState;
  crashCart?: CrashCartModel;
  daemonEvidence?: DaemonUnverifiedEvidence;
  /** B1 ROUND 2——实时舰队恢复生命周期表面（运行中显示进度，完成时显示汇总+诊断列表）。
   *  由 main.ts 设置为操作者拥有的生命周期轮询；存在时优先于座舱，
   *  使操作者看到进度和诊断列表而非裸刷新。 */
  restore?: RestoreLifecycleVM;
  /** B1 ROUND 10——⏎ 确认横幅（非零代恢复）。渲染在座舱内操作者看的位置；
   *  ViewState.notice 不在后台服务停止座舱中渲染，因此确认曾不可见
   *  （第一次 ⏎ 看起来什么都没做）。存在 ⇔ pendingRestoreConfirm。 */
  confirm?: string;
}

/** 拒绝是不可用读取，绝非空实例。 */
export function crashCartRenderOpts(emit: CrashCartEmit): CrashCartRenderOpts {
  if (emit.refusal) return { unavailable: emit.refusal };
  if (emit.state === "down" && emit.discovery) {
    return { daemonState: "down", crashCart: buildCrashCartModel(emit.discovery) };
  }
  if (emit.state === "unverified" && emit.evidence) {
    return { daemonState: "unverified", daemonEvidence: emit.evidence };
  }
  return {};
}

/**
 * 运行公共读取。失败可见，不授权恢复效果。
 */
export async function probeCrashCart(runVerb: () => Promise<string>): Promise<CrashCartRenderOpts> {
  try {
    const emit = JSON.parse(await runVerb()) as CrashCartEmit;
    if (!emit || !["up", "down", "unverified"].includes(emit.state)) {
      const error = emit as unknown as { error?: { message?: string } | string };
      const detail = typeof error?.error === "string" ? error.error : error?.error?.message;
      return { unavailable: detail ?? "故障诊断未返回后台服务判决。" };
    }
    if (emit.state === "down" && !emit.discovery && !emit.refusal) return { unavailable: "后台服务已停止；无法读取其保存状态。" };
    if (emit.state === "unverified" && !emit.evidence) return { unavailable: "无法验证后台服务状态；探测证据不可用。" };
    return crashCartRenderOpts(emit);
  } catch (error) {
    return { unavailable: `启动前提不可用：${error instanceof Error ? error.message : String(error)}` };
  }
}
