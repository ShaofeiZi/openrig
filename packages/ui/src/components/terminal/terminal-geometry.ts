// OPR.0.4.0.39 —— 静态预览终端与实时交互终端之间几何镜像的唯一权威来源。
//
// 创始者规格（spec-dev2-authored-2026-06-22）：静态（轮询预览）终端与
// 实时（交互式 xterm）终端保持相同的形状——即 Claude/Codex CLI 的最佳几何尺寸，
// 也就是实时 xterm 固定的 90 列 × 27 行，字号 12 / 行高 1。
// 静态面板以完全相同的字号 + 90 列宽度渲染，从而与实时终端镜像一致；
// ScaleToFitTerminal 按列宽对两者做相同缩放。仅玻璃态（静态）与不透明（实时）外观不同。
//
// 保持无外部依赖（不导入 xterm），以便轻量静态预览路径共享此常量，
// 而不会把 xterm 打包体积拖入静态渲染路径。

export const LIVE_TERMINAL_RENDER_BACKGROUND = "#0c0a09";
// OPR.0.0.39（创始者指定）：90 列。Claude Code（Ink）与 Codex CLI 会自适应任意宽度
//（80 列是过窄的遗留回退值）；90 列高于该下限，同时在网格单元格中比 120 列
// 渲染出更大、更易读的静态/实时镜像。必须与后台服务 broker 的 CANONICAL_COLS
//（TerminalSessionBroker.ts）保持一致——客户端 xterm 网格必须等于窗格几何尺寸。
export const LIVE_TERMINAL_COLS = 90;
export const LIVE_TERMINAL_ROWS = 27;
export const LIVE_TERMINAL_FONT_SIZE = 12;
export const LIVE_TERMINAL_LINE_HEIGHT = 1;
export const LIVE_TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
