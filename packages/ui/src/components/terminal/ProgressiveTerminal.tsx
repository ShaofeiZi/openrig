// OPR.0.4.0.1 —— 唯一可复用的渐进实时终端（AC-3）。
//
// 默认静态 → 点击内部转实时（创始者指令）：打开时显示廉价的静态轮询预览
//（SessionPreviewPane）；点击内部任意位置将该终端升级为实时、可输入的
// FocusedTerminal。转实时查询全局 LiveTerminalProvider 上限：超过
// MAX_LIVE_TERMINALS 时最旧的实时终端被驱逐回静态（其回退回调运行，
// 关闭其 WS）。静态预览无上限（廉价轮询）。被三个表面共同使用。

import { useCallback, useEffect, useRef, useState } from "react";
import { FocusedTerminal } from "./FocusedTerminal.js";
import { StaticTerminalPlate } from "./StaticTerminalPlate.js";
import { ScaleToFitTerminal } from "./ScaleToFitTerminal.js";
import { useLiveTerminal } from "./LiveTerminalProvider.js";

// OPR.0.4.0.39：静态获取比可见横向窗口更深的历史，
// 以便你可以回滚查看（紧凑 <pre> 用 max-h + overflow-y 限制可见高度）；
// 实时 xterm 滚动自己的缓冲区。
const STATIC_HISTORY_LINES = 100;

// OPR.0.4.0.39 FR-1：共享静态终端板现在拥有 SMOKED_STATIC_PLATE_CLASS；
// 在此重新导出供已有导入者使用。
export { SMOKED_STATIC_PLATE_CLASS } from "./StaticTerminalPlate.js";

interface ProgressiveTerminalProps {
  sessionName: string;
  /** 上限注册表的稳定全局键（例如 `${rigId}:${logicalId}`）。 */
  terminalKey: string;
  lines?: number;
  testIdPrefix?: string;
  className?: string;
  /** OPR.0.4.0.1：此终端静态↔实时翻转时通知宿主，
   *  使宿主（例如弹出层）可在实时时将其外壳缩放到宽实时板，静态时保持紧凑。 */
  onLiveChange?: (isLive: boolean) => void;
  /** OPR.0.4.0.39：缩放适应模式。"width"（默认）适应列宽且从不上放大
   *（网格/图/表格单元格）。"contain" 在两个轴上填充大型专用容器
   *（限制放大、居中）——节点详情面板。 */
  fit?: "width" | "contain";
  /** OPR.0.4.4.20 delta-C：此终端转实时时转发给 FocusedTerminal
   * —— 一个预填充文本框，无需回车（见 FocusedTerminal）。 */
  initialText?: string;
}

export function ProgressiveTerminal({
  sessionName,
  terminalKey,
  // OPR.0.4.0.39：获取更深历史，使静态横向窗口可回滚。
  lines = STATIC_HISTORY_LINES,
  testIdPrefix = "progressive-terminal",
  className,
  onLiveChange,
  fit = "width",
  initialText,
}: ProgressiveTerminalProps) {
  const [mode, setMode] = useState<"static" | "live">("static");
  const live = useLiveTerminal();
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const goStatic = useCallback(() => setMode("static"), []);

  // OPR.0.4.0.1：将实时/静态模式暴露给宿主，使弹出层在实时时可将其外壳
  // 拓宽到完整实时板，静态时保持紧凑。
  useEffect(() => {
    onLiveChange?.(mode === "live");
  }, [mode, onLiveChange]);

  const goLive = useCallback(() => {
    if (modeRef.current === "live") return;
    // requestLive 可能驱逐最旧的实时终端（将其回退到静态）。
    live.requestLive(terminalKey, goStatic);
    setMode("live");
  }, [live, terminalKey, goStatic]);

  // 离开实时模式时释放注册表槽位（卸载或回退到静态）。
  // release() 幂等，因此驱逐（已移除键）是安全的。
  useEffect(() => {
    if (mode !== "live") return undefined;
    return () => live.release(terminalKey);
  }, [mode, live, terminalKey]);

  // OPR.0.4.0.39（创始者规格）：静态和实时是相同 90x27 几何，都包装在共享
  // ScaleToFitTerminal 中，使它们缩放到列宽相同（fit-width，不裁剪）。
  // 点击时玻璃→不透明翻转是唯一变化——实时 xterm 出现在相同位置的相同大小
  //（镜像）。
  if (mode === "live") {
    // OPR.0.4.0.39（选择修复）：LIVE xterm 通过 fontSize 缩放（FocusedTerminal
    // 自己的 fit），而非 CSS transform。CSS transform:scale 祖先会破坏 xterm
    // 的鼠标/选择命中测试（它将变换后偏移除以变换前单元格大小——#6023），
    // 因此拖动会选错单元格。FocusedTerminal 填充此容器并 fontSize-fit 90x27
    // 到它，像素匹配静态板（静态板保留其 transform——原生 DOM 选择能很好跟随
    // transform）。相同的签核外观，原生正确的选择。
    return (
      <div
        data-testid={`${testIdPrefix}-live`}
        className={[fit === "contain" ? "h-full w-full" : "w-full", className].filter(Boolean).join(" ")}
      >
        <FocusedTerminal sessionName={sessionName} fit={fit} initialText={initialText} />
      </div>
    );
  }

  // 静态默认：整个预览是点击转实时的目标。共享 StaticTerminalPlate
  // 携带半透明烟熏玻璃板 + 90 列几何的紧凑内容（FR-1/FR-2）；
  // 点击将其就地翻转为不透明 #0c0a09 实时 xterm——玻璃→不透明激活控件。
  return (
    <ScaleToFitTerminal testId={`${testIdPrefix}-fit`} className={className} fit={fit}>
      <StaticTerminalPlate
        sessionName={sessionName}
        lines={lines}
        plateTestId={`${testIdPrefix}-static`}
        previewTestIdPrefix={`${testIdPrefix}-preview`}
        onClick={goLive}
        ariaLabel={`将 ${sessionName} 终端设为实时（可输入）`}
        title="点击设为实时（可输入）"
      />
    </ScaleToFitTerminal>
  );
}
