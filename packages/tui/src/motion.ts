// ROUND-3 mr7 —— 动效设计语言机制（创建者指导；该集合的签署 = 搭乘验证捕获的开放项）。
// 内置纪律：所有内容都有减弱动效回退，诚实回退（旋转器绝不编造进度；
// 进度条仅渲染真实分数），每个区域最多一个持续动画（在调用点固定）。
import type { ColorMode } from "./theme.js";

/** 环境 killswitch —— 任一已接受的标志禁用所有动效 */
export function reducedMotion(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["OPENRIG_REDUCED_MOTION"] === "1" || env["REDUCED_MOTION"] === "1" || env["NO_MOTION"] === "1";
}

/** 安静的命令焦点：可见两秒，熄灭一秒；输入保持稳定。 */
export function commandFocusVisible(nowMs: number, editing: boolean, reduced: boolean): boolean {
  return editing || reduced || nowMs % 3000 < 2000;
}

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const LINE_FRAMES = ["|", "/", "-", "\\"];

/** 加载旋转器：盲文字符帧（真彩色/256色），16色时用线条帧，
 *  减弱动效下用静态点——状态仍然诚实展示 */
export function spinnerFrame(tick: number, mode: ColorMode, reduced: boolean): string {
  if (reduced) return "·";
  const frames = mode === "16" || mode === "none" ? LINE_FRAMES : BRAILLE_FRAMES;
  return frames[((tick % frames.length) + frames.length) % frames.length]!;
}

/** tmux 风格的一次性行闪烁：仅在窗口内激活；减弱动效下绝不闪烁 */
export function flashActive(sinceMs: number, nowMs: number, durationMs = 600, reduced = false): boolean {
  if (reduced) return false;
  return nowMs >= sinceMs && nowMs - sinceMs < durationMs;
}

/** 安静的确定性块进度条——仅真实分数；null/NaN 不渲染任何内容
 * （进度条是对已测量进度的声明，绝不编造） */
export function barCells(fraction: number | null, width: number): string {
  if (fraction == null || Number.isNaN(fraction)) return "";
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
