// OPR.0.6.0.5 F1——交出一个长值（Slack 创建应用链接）以供精确复制。TUI
// 网格包装和框住长文本，因此在 TUI 内选择它会拾取边框和换行。
// 这离开备用屏幕，在正常屏幕上将值打印为一行不间断文本，
// 并在回车时返回 TUI。给定终端的选择从软换行行复制什么
// 是终端的行为；此模块仅控制它打印的字节。
// 它不写入剪贴板，不打开任何内容，除了返回的回车外不读取输入。
import { ALT_SCREEN_OFF, ALT_SCREEN_ON, MOUSE_DISABLE, MOUSE_ENABLE, PASTE_DISABLE, PASTE_ENABLE } from "./input.js";

export const PRINT_FOR_COPY_RETURN_HINT = "选择上方行以复制。按回车返回 zrig。";
const LEAVE = PASTE_DISABLE + MOUSE_DISABLE + ALT_SCREEN_OFF;
const RESTORE = ALT_SCREEN_ON + MOUSE_ENABLE + PASTE_ENABLE;

/** 在正常屏幕上打印的确切文本：标题、值在自己的不间断行上、提示。 */
export function printForCopyText(label: string, value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, "");
  return `\r\n${label}\r\n\r\n${oneLine}\r\n\r\n${PRINT_FOR_COPY_RETURN_HINT}\r\n`;
}

/** 等待如何结束：用户按回车，或终端输入结束、关闭或失败。 */
export type CopyWaitEnd = "enter" | "end" | "close" | "error";

export interface CopyTerminal {
  write(text: string): void;
  setRawMode(on: boolean): void;
  /** 在下次回车时 settle，或输入结束、关闭或错误时。绝不拒绝。 */
  waitForEnter(): Promise<CopyWaitEnd>;
}

/** 打印 `value` 以供复制并等待。第一步后的任何失败仍尝试恢复
 *  原始模式和备用屏幕，除非 `mayRestore()` 说 TUI 正在关闭。 */
export async function printForCopy(term: CopyTerminal, label: string, value: string, mayRestore: () => boolean = () => true): Promise<CopyWaitEnd> {
  try {
    term.setRawMode(false);
    term.write(LEAVE);
    term.write(printForCopyText(label, value));
    return await term.waitForEnter();
  } finally {
    if (mayRestore()) {
      try { term.setRawMode(true); } catch { /* 输入可能已消失 */ }
      try { term.write(RESTORE); } catch { /* 输出可能已消失 */ }
    }
  }
}

type InputStream = Pick<NodeJS.EventEmitter, "on" | "off">;

/** 给定流上的终端。仅回车（CR 或 LF）计为输入；其他输入被忽略。
 *  结束、关闭和错误也 settle 等待。每个 listener 在 settle 时移除。 */
export function streamCopyTerminal(stdin: InputStream, stdout: { write(text: string): unknown }, setRaw: (on: boolean) => void): CopyTerminal {
  return {
    write: (text) => { stdout.write(text); },
    setRawMode: setRaw,
    waitForEnter: () => new Promise<CopyWaitEnd>((resolve) => {
      const done = (how: CopyWaitEnd) => {
        stdin.off("data", onData); stdin.off("end", onEnd); stdin.off("close", onClose); stdin.off("error", onError);
        resolve(how);
      };
      const onData = (chunk: Buffer | string) => { if (/[\r\n]/.test(String(chunk))) done("enter"); };
      const onEnd = () => done("end");
      const onClose = () => done("close");
      const onError = () => done("error");
      stdin.on("data", onData); stdin.on("end", onEnd); stdin.on("close", onClose); stdin.on("error", onError);
    }),
  };
}

export function processCopyTerminal(): CopyTerminal {
  return streamCopyTerminal(process.stdin, process.stdout, (on) => { if (process.stdin.isTTY) process.stdin.setRawMode(on); });
}

export interface CopySessionDeps {
  terminal: CopyTerminal;
  label: string;
  value: string;
  /** 暂停或恢复 TUI 自己的输入处理和绘制。 */
  setSuspended(on: boolean): void;
  isShuttingDown(): boolean;
  notice(message: string): void;
  draw(): void;
}

/** TUI 运行的整个复制会话。绝不拒绝：每个结果都以 TUI
 *  恢复结束（除非正在关闭），并为非正常回车以外的任何结果发出通知。 */
export async function runCopySession(d: CopySessionDeps): Promise<CopyWaitEnd | "failed"> {
  d.setSuspended(true);
  let outcome: CopyWaitEnd | "failed";
  try {
    outcome = await printForCopy(d.terminal, d.label, d.value, () => !d.isShuttingDown());
    if (outcome !== "enter") d.notice(`从打印链接返回：终端输入${outcome === "error" ? "失败" : "结束"}。`);
  } catch (err) {
    outcome = "failed";
    d.notice(`无法打印链接（${err instanceof Error ? err.message : String(err)}）。运行：zrig slack manifest --url`);
  }
  d.setSuspended(false);
  if (!d.isShuttingDown()) { try { d.draw(); } catch { /* 下次输入或调整大小重绘 */ } }
  return outcome;
}
