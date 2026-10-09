// 键盘 + 鼠标字节解码。鼠标使用 xterm SGR（1006）报告：
// ESC [ < b ; x ; y M/m —— 标准 tmux/iTerm/Terminal.app 鼠标编码。
// 鼠标事件由调用方对照渲染器的命中图解析，
// 然后通过与命令和按键相同的 dispatch 派发（PIN 1）。
import type { Action, InputEvent, Screen, ViewState } from "./types.js";
import { specDetailArrowsScroll } from "./state.js";
import { StringDecoder } from "node:string_decoder";

function parseText(text: string, final: boolean): { events: InputEvent[]; remainder: string } {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\x1b") {
      const tail = text.slice(i);
      if (!final && "\x1b[200~".startsWith(tail)) break;
      if (tail.startsWith("\x1b[200~")) {
        const end = text.indexOf("\x1b[201~", i + 6);
        if (end < 0 && !final) break;
        events.push({ type: "paste", text: text.slice(i + 6, end < 0 ? text.length : end).replace(/[\x00-\x1f\x7f]/g, " ") });
        i = end < 0 ? text.length : end + 6;
        continue;
      }
      if (i + 1 >= text.length && !final) break;
      if (text[i + 1] === "[") {
        if (i + 2 >= text.length && !final) break;
        const code = text[i + 2];
        if (code === "<") {
          const tail = text.slice(i);
          const match = tail.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
          if (match) {
            const button = Number(match[1]);
            if (match[4] === "M" && (button & 3) !== 3 && button < 32)
              events.push({ type: "mouse", button: button & 3, x: Number(match[2]), y: Number(match[3]) });
            // 保留滚轮坐标。渲染器拥有实际窗格边界，
            // 因此在此之前路由会使指针本地滚动不可能。
            else if (match[4] === "M" && (button & 64) !== 0) {
              events.push({ type: "mouse", button, x: Number(match[2]), y: Number(match[3]) });
            }
            i += match[0].length;
            continue;
          }
          if (!final && /^\x1b\[<[0-9;]*$/.test(tail)) break;
        }
        if ((code === "5" || code === "6") && i + 3 >= text.length && !final) break;
        if ((code === "5" || code === "6") && text[i + 3] === "~") {
          const down = code === "6";
          events.push({
            type: "key",
            key: down ? "pagedown" : "pageup",
            action: { type: "content-scroll", delta: down ? 10 : -10 },
          });
          i += 4;
          continue;
        }
        const key = code === "A" ? "up" : code === "B" ? "down" : code === "C" ? "right" : code === "D" ? "left" : null;
        if (key) {
          events.push({
            type: "key",
            key,
            action: { type: "select", delta: key === "down" ? 1 : key === "up" ? -1 : 0 },
          });
          i += 3;
          continue;
        }
        // 完整的不支持终端键（Home/End/Delete、修饰键等）
        // 是一个事件，绝不裸 Escape 后跟命令文本。
        const sequence = tail.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (sequence) { i += sequence[0].length; continue; }
        if (!final && /^\x1b\[[0-?]*[ -/]*$/.test(tail)) break;
      }
      if (!final && tail === "\x1bO") break;
      if (/^\x1bO[@-~]/.test(tail)) { i += 3; continue; }
      events.push({ type: "key", key: "escape" });
      i += 1;
      continue;
    }
    if (ch === "\t") { events.push({ type: "key", key: "tab" }); i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      events.push({ type: "key", key: "enter", action: { type: "activate" } });
      i += 1;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      events.push({ type: "key", key: "backspace" });
      i += 1;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    if (char >= " ") events.push({ type: "char", ch: char });
    i += char.length;
  }
  return { events, remainder: text.slice(i) };
}

export interface InputDecoder {
  write(bytes: string | Buffer): InputEvent[];
  flush(): InputEvent[];
  /** 当拆分转义序列（或单独 Esc）被持有等待更多字节时为 true——
   *  调用方在短安静间隔后 flush，以便裸 Esc 按键被递送。 */
  hasPending(): boolean;
}

/** 有状态终端流解码器：保留拆分转义序列并使用
 *  Node 的 StringDecoder，使 UTF-8 码点在任意 Buffer 块中存活。 */
export function createInputDecoder(): InputDecoder {
  const utf8 = new StringDecoder("utf8");
  let pending = "";
  return {
    write(bytes) {
      pending += typeof bytes === "string" ? bytes : utf8.write(bytes);
      const parsed = parseText(pending, false);
      pending = parsed.remainder;
      return parsed.events;
    },
    flush() {
      const parsed = parseText(pending, true);
      pending = parsed.remainder;
      return parsed.events;
    },
    hasPending() {
      // 括号粘贴可能跨块暂停；仅转义前缀需要短键定时器。
      return pending.length > 0 && !pending.startsWith("\x1b[200~");
    },
  };
}

/** 测试和合成适配器使用的整批便捷函数。 */
export function decodeInput(bytes: string | Buffer): InputEvent[] {
  const decoder = createInputDecoder();
  return [...decoder.write(bytes), ...decoder.flush()];
}

/** 测试/自动化辅助：终端在 (x, y) 左键点击发出的 SGR 字节。 */
export function sgrClick(x: number, y: number): string {
  return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
}

/** 解析 SCOPES 详情页宣传的返回控件。 */
export function resolveEscapeAction(
  event: Extract<InputEvent, { type: "key" }>,
  state: ViewState,
  commandEditing = false,
): Action | null {
  if (event.key !== "escape" || commandEditing) return null;
  if ((state.file || state.externalUrl || (state.section === "specs" && state.drill.length > 0)) && state.history?.length) return { type: "back" };
  if (state.healthOpen) return { type: "health-close" };
  if (state.filter) return { type: "filter", text: "" };
  if (state.history?.length) return { type: "back" };
  if (state.section !== "scopes") return null;
  if (state.executionOpen) return { type: "execution-close" };
  return state.scopesSelected
    ? { type: "scopes-mission-open", mission: state.scopesSelected.mission }
    : null;
}

/** 对照当前渲染窗格解析方向/回车键。 */
export function resolveKeyAction(
  event: Extract<InputEvent, { type: "key" }>,
  state: ViewState,
  screen: Screen,
  explorerCount: number,
): Action | null {
  // PULSE（创建者 Option-B）是正常铬内的内容面板视图，因此
  // 它使用与其他视图相同的输入：←→ 切换窗格（侧边栏是
  // 创建者的操作路径），↑↓ 移动聚焦窗格，回车钻取。无 pulse
  // 特例——泳道单元格是内容面板的选择目标。
  if (event.key === "left") return screen.explorerWidth === 0 ? { type: "back" } : { type: "focus", pane: "explorer" };
  if (event.key === "right") return screen.contentTargets.length > 0 ? { type: "focus", pane: "content" } : null;
  if (event.key === "up" || event.key === "down") {
    const delta = event.key === "down" ? 1 : -1;
    // 创建者修复：在可滚动规格详情上，主体是有意义的
    // 表面——资源管理器聚焦时反射式 ↑↓ 滚动它。右键显式
    // 进入其链接。非滚动规格详情和每个其他视图落入
    // 未改变的资源管理器移动/内容选择行为。
    if (specDetailArrowsScroll(state)) return { type: "content-scroll", delta };
    if (state.focusedPane === "content" || screen.explorerWidth === 0) {
      // k9s 选择驱动自动滚动：在视口边缘且后面有更多内容时，箭头
      // 滚动视口（reveal）而非钳制——因此 ↑↓ 到达每行而无需 PgUp/PgDn
      // （大多数键盘没有——创建者修复）。远离边缘时移动选择。
      const atBottom = state.contentSelection >= screen.contentTargets.length - 1;
      const atTop = state.contentSelection <= 0;
      if (delta === 1 && atBottom && state.contentOffset < state.contentMaxOffset) return { type: "content-scroll", delta: 1 };
      if (delta === -1 && atTop && state.contentOffset > 0) return { type: "content-scroll", delta: -1 };
      return { type: "content-select", delta };
    }
    return { type: "select", delta, rowCount: explorerCount };
  }
  if (event.key === "enter") {
    return state.focusedPane === "content" || screen.explorerWidth === 0
      ? (screen.contentTargets[state.contentSelection]?.action ?? { type: "error", message: "内容中未选择任何项" })
      : { type: "activate" };
  }
  return "action" in event ? event.action : null;
}

/** 使用指针实际下方的窗格路由滚轮 notch。点击保持
 * 使用调用方中的渲染器命中图；此函数仅拥有滚轮。 */
export function resolveMouseAction(
  event: Extract<InputEvent, { type: "mouse" }>,
  state: ViewState,
  screen: Screen,
  explorerCount: number,
): Action | null {
  void state;
  if ((event.button & 64) === 0) return null;
  const delta = (event.button & 1) !== 0 ? 3 : -3;
  return event.x <= screen.explorerWidth
    ? { type: "select", delta, rowCount: explorerCount }
    : { type: "content-scroll", delta };
}

export const PASTE_ENABLE = "\x1b[?2004h";
export const PASTE_DISABLE = "\x1b[?2004l";
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
export const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l";
export const ALT_SCREEN_OFF = "\x1b[?25h\x1b[?1049l";
