import { mkdirSync, appendFileSync, existsSync, openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getCompatibleOpenRigPath } from "../openrig-compat.js";
import { getLastCaptureAt } from "./transcript-rotation.js";

export interface TranscriptStoreOpts {
  transcriptsRoot?: string;
  enabled?: boolean;
  staleAfterMs?: number;
}

export type TranscriptIngestState = "live" | "degraded" | "unavailable";

export interface TranscriptIngestHealth {
  state: TranscriptIngestState;
  reason: "capture_fresh" | "capture_stale" | "capture_empty" | "capture_missing" | "capture_disabled" | "capture_unreadable";
  lastCapturedAt: string | null;
}

const DEFAULT_ROOT = getCompatibleOpenRigPath("transcripts");
export const DEFAULT_TRANSCRIPT_STALE_AFTER_MS = 10_000;

function applyBackspaces(text: string): string {
  const chars: string[] = [];
  for (const ch of text) {
    if (ch === "\b") {
      chars.pop();
      continue;
    }
    chars.push(ch);
  }
  return chars.join("");
}

function stripShellPromptPrefix(line: string): string {
  return line.replace(/^\s*\S+@\S+ .*? %\s*/, "");
}

function isBareShellPrompt(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "%" || /^\S+@\S+ .*? %$/.test(trimmed);
}

function isPromptRedrawDuplicate(line: string, nextLine?: string): boolean {
  const trimmed = line.trimEnd();
  if (!trimmed.endsWith("%")) return false;
  const withoutPrompt = trimmed.slice(0, -1).trimEnd();
  return withoutPrompt.length > 0 && nextLine?.trim() === withoutPrompt;
}

function isUiChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === "? for shortcuts" || trimmed === "esc to interrupt") return true;
  return /[─━]{8,}/.test(trimmed);
}

function isSpinnerOnlyLine(line: string): boolean {
  return /^[\s✢✳✶✻✽·⏺❯]+$/.test(line);
}

function normalizeTuiFragment(line: string): string {
  return line
    .replace(/[✢✳✶✻✽·⏺❯]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyTuiFragment(line: string): boolean {
  const normalized = normalizeTuiFragment(line);
  if (!normalized) return false;
  if (!(/[✢✳✶✻✽·⏺❯]/.test(line) || /\s{2,}/.test(line))) return false;
  if (/[0-9@:/[\]{}()'"`=.,!?_-]/.test(normalized)) return false;
  if (/[^A-Za-z… ]/.test(normalized)) return false;
  return normalized.length <= 12;
}

function stripOrphanCursorFragments(line: string): string {
  return line.replace(/\[\d{1,3}[A-Za-z](?=\S)/g, " ");
}

function isStartupSplashLine(line: string): boolean {
  const hasBoxChars = /[│╭╰╮╯]/.test(line);
  // 匹配前移除 Codex 风格 banner 的方框绘制字符。
  const stripped = line.replace(/[│╭╰╮╯─━]/g, "").trim();

  if (!stripped) {
    // 移除方框字符后为空，说明这是 startup banner 的边框或空白行。仅在原行包含方框字符时
    // 过滤；真正的空行已由空行 filter 处理。
    return hasBoxChars;
  }

  // Claude Code 版本 header："Claude Code v2.1.101"。
  if (/^Claude Code v[\d.]+/.test(stripped)) return true;
  // Claude model/plan 行："Opus 4.6 (Claude Max)"、"Sonnet 4.6 (1M context)"。
  if (/^(?:Opus|Sonnet|Haiku) \d[\d.]+ /.test(stripped)) return true;
  // Codex 版本 header："OpenAI Codex (v0.120.0)"、">_ OpenAI Codex (v0.120.0)"。
  if (/^>?_?\s*(?:OpenAI )?Codex\b.*v[\d.]+/.test(stripped)) return true;

  // 方框包裹的 startup banner 内部内容（│...│ 内的 model/directory 行）。仅在原行带方框字符
  // 时匹配，以保留普通输出中独立出现的 "model:" 或 "directory:"。
  if (hasBoxChars) {
    if (/^model:\s+/i.test(stripped)) return true;
    if (/^directory:\s+/i.test(stripped)) return true;
  }

  return false;
}

function isStatusOverlayLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === "Checking for updates") return true;
  if (/^(?:[›⏵⏺❯]+\s*)?accept edits on\b.*\/clear to save\b.*tokens?$/i.test(trimmed)) return true;
  if (/^\d+\s+background terminal running\b.*\/ps to view\b.*\/stop to close\b/i.test(trimmed)) return true;
  if (/^gpt-[^\n]+ · Context \[[^\]]+\] · .+$/.test(trimmed)) return true;
  return false;
}

const TAIL_CHUNK_SIZE = 16 * 1024;

/**
 * 从文件尾部按 chunk 反向读取最后 N 行原始文本。通过调整 read offset 处理 chunk 边界处的
 * UTF-8 多字节字符，避免拆断字符。
 */
function readTailChunked(filePath: string, rawLines: number): string | null {
  const stat = statSync(filePath);
  if (stat.size === 0) return null;

  const fd = openSync(filePath, "r");
  try {
    let text = "";
    let offset = stat.size;

    while (offset > 0) {
      const readSize = Math.min(TAIL_CHUNK_SIZE, offset);
      offset -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, offset);

      // 调整被拆开的 UTF-8 多字节字符：首字节若为 continuation byte
      //（10xxxxxx = 0x80-0xBF），说明字符已被截断。把 offset 向前移过 continuation byte，
      // 使字符起始字节落入下一次更早的 chunk 读取。
      let skipBytes = 0;
      while (skipBytes < buf.length && (buf[skipBytes]! & 0xC0) === 0x80) {
        skipBytes++;
      }
      if (skipBytes > 0) {
        offset += skipBytes; // push those bytes back for the next iteration
      }

      const chunk = buf.subarray(skipBytes).toString("utf-8");
      text = chunk + text;

      const newlineCount = countNewlines(text);
      if (newlineCount >= rawLines) break;
    }

    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const tail = lines.slice(-rawLines);
    return tail.join("\n");
  } finally {
    closeSync(fd);
  }
}

function countNewlines(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}

export class TranscriptStore {
  private readonly root: string;
  private readonly _enabled: boolean;
  private readonly staleAfterMs: number;

  constructor(opts?: TranscriptStoreOpts) {
    this.root = opts?.transcriptsRoot ?? DEFAULT_ROOT;
    this._enabled = opts?.enabled ?? true;
    this.staleAfterMs = opts?.staleAfterMs ?? DEFAULT_TRANSCRIPT_STALE_AFTER_MS;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  getTranscriptPath(rigName: string, sessionName: string): string {
    const resolved = join(this.root, rigName, `${sessionName}.log`);
    // 防止工作组/session name 中的 ".." 造成路径穿越。
    if (!resolved.startsWith(this.root + "/") && resolved !== this.root) {
      return join(this.root, "_unsafe", `${sessionName}.log`);
    }
    return resolved;
  }

  getIngestHealth(rigName: string, sessionName: string): TranscriptIngestHealth {
    if (!this._enabled) {
      return { state: "unavailable", reason: "capture_disabled", lastCapturedAt: null };
    }
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      if (!existsSync(filePath)) {
        return { state: "unavailable", reason: "capture_missing", lastCapturedAt: null };
      }
      const stat = statSync(filePath);
      // Liveness 与文件 mtime 解耦：transcript rotation 的内容未变化 guard 会冻结静止 pane 的
      // idle 席位 mtime，即使每个 tick 仍在 capture。优先使用内存中的 last-capture 时间；该
      // session 没有 rotation record 时（adopted session 或本进程首次 tick 前）回退到 mtime。
      const lastCaptureMs = getLastCaptureAt(sessionName) ?? stat.mtimeMs;
      const lastCapturedAt = new Date(lastCaptureMs).toISOString();
      if (stat.size === 0) {
        return { state: "degraded", reason: "capture_empty", lastCapturedAt };
      }
      if (Date.now() - lastCaptureMs > this.staleAfterMs) {
        return { state: "degraded", reason: "capture_stale", lastCapturedAt };
      }
      return { state: "live", reason: "capture_fresh", lastCapturedAt };
    } catch {
      return { state: "degraded", reason: "capture_unreadable", lastCapturedAt: null };
    }
  }

  ensureTranscriptDir(rigName: string): boolean {
    if (!this._enabled) return false;
    try {
      const dir = join(this.root, rigName);
      // 防止路径穿越。
      if (!dir.startsWith(this.root + "/") && dir !== this.root) {
        return false;
      }
      mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  writeBoundaryMarker(rigName: string, sessionName: string, reason: string): boolean {
    if (!this._enabled) return false;
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      // 确保工作组目录存在，使 marker 写入在 launcher.ensureTranscriptDir 之前调用时也能成功。
      // 恢复编排会在 launch 前写 marker，而 launcher 之后才建目录；旧行为会丢失新工作组首次
      // 恢复的 marker。
      mkdirSync(dirname(filePath), { recursive: true });
      const marker = `--- SESSION BOUNDARY: ${reason} at ${new Date().toISOString()} ---\n`;
      appendFileSync(filePath, marker, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  stripAnsi(text: string): string {
    return text
      // 保留 cursor-forward/absolute motion 产生的水平间距。
      .replace(/\x1b\[(\d*)C/g, (_, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
      .replace(/\x1b\[(\d*)G/g, (_, n: string) => " ".repeat(Math.max(1, Number(n || "1"))))
      // 移除 ESC ] 0;title BEL 等 OSC/title update。
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // 移除剩余 CSI 和单字符 escape sequence。
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b[@-_]/g, "")
      // Shell redraw 常在重放整行前发出字符 + backspace。
      .replace(/\r/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[^\n]\x08/g, (match) => applyBackspaces(match))
      .replace(/\x08+/g, "")
      // 把 carriage-return redraw 视为独立 transcript 行。
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  readTail(rigName: string, sessionName: string, lines: number): string | null {
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      if (!existsSync(filePath)) return null;
      const fileSize = statSync(filePath).size;
      if (fileSize === 0) return "";

      // 自适应：先宽裕 oversample；cleanup 过滤过多时再扩大读取量。
      let rawMultiplier = 8;
      const MAX_MULTIPLIER = 64;

      while (rawMultiplier <= MAX_MULTIPLIER) {
        const rawTail = readTailChunked(filePath, lines * rawMultiplier);
        if (rawTail === null) return "";

        const cleanedTail = this.cleanupTailLines(rawTail, lines);
        if (cleanedTail.length >= lines || rawMultiplier >= MAX_MULTIPLIER) {
          const finalTail = cleanedTail.slice(-lines);
          return finalTail.length > 0 ? finalTail.join("\n") + "\n" : "";
        }

        // cleanup 后行数不足，继续读取更多原始行。
        rawMultiplier *= 2;
      }

      return "";
    } catch {
      return null;
    }
  }

  private cleanupTailLines(rawText: string, _requestedLines: number): string[] {
    const normalizedLines = this.stripAnsi(rawText)
      .split("\n")
      .map((line) => stripShellPromptPrefix(line))
      .map((line) => stripOrphanCursorFragments(line))
      .map((line) => line.trimEnd());
    const filtered = normalizedLines
      .filter((line) => line.trim() !== "")
      .filter((line) => !isBareShellPrompt(line));
    return filtered
      .filter((line) => !isStartupSplashLine(line))
      .filter((line) => !isStatusOverlayLine(line))
      .filter((line) => !isUiChromeLine(line))
      .filter((line) => !isSpinnerOnlyLine(line))
      .filter((line) => !isLikelyTuiFragment(line))
      .filter((line, index) => !isPromptRedrawDuplicate(line, filtered[index + 1]));
  }

  /**
   * 把整个 transcript 文件读取为单个字符串。返回原始文件内容，调用方按自身场景处理 ANSI/
   * cleanup。文件缺失或发生任意 I/O 错误时返回 null；文件存在但为空时返回 ""。
   *
   * 供 GET /api/transcripts/:session/full（M2c-Daemon）使用。与 `readTail` 不同，本方法不应用
   * terminal-cleanup heuristic，因为路由调用方（例如 restore-packet generator）需要 runtime
   * 发出的未过滤内容。按 orch 裁定 approved-option-a，路由层在序列化前通过
   * `redactTranscriptContent` 执行 redaction（open-route-with-redaction-as-protective-primitive）。
   */
  readFull(rigName: string, sessionName: string): string | null {
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  grep(rigName: string, sessionName: string, pattern: string): string[] | null {
    try {
      const filePath = this.getTranscriptPath(rigName, sessionName);
      if (!existsSync(filePath)) return null;
      return this.grepSync(filePath, pattern);
    } catch {
      return null;
    }
  }

  private grepSync(filePath: string, pattern: string): string[] {
    const regex = new RegExp(pattern);
    const matches: string[] = [];
    const fd = openSync(filePath, "r");
    const decoder = new StringDecoder("utf-8");
    try {
      const stat = statSync(filePath);
      const CHUNK_SIZE = 64 * 1024;
      let remainder = "";

      for (let offset = 0; offset < stat.size; offset += CHUNK_SIZE) {
        const readSize = Math.min(CHUNK_SIZE, stat.size - offset);
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, offset);
        // StringDecoder 处理 chunk 边界处不完整的多字节序列。
        const chunk = remainder + decoder.write(buf);
        const lines = chunk.split("\n");
        remainder = lines.pop() ?? "";

        for (const rawLine of lines) {
          const stripped = this.stripAnsi(rawLine);
          for (const subLine of stripped.split("\n")) {
            const cleaned = stripShellPromptPrefix(subLine);
            if (cleaned && regex.test(cleaned)) {
              matches.push(cleaned);
            }
          }
        }
      }

      // 刷出 decoder 中剩余的字节。
      const finalChunk = remainder + decoder.end();
      if (finalChunk) {
        const stripped = this.stripAnsi(finalChunk);
        for (const subLine of stripped.split("\n")) {
          const cleaned = stripShellPromptPrefix(subLine);
          if (cleaned && regex.test(cleaned)) {
            matches.push(cleaned);
          }
        }
      }
    } finally {
      closeSync(fd);
    }

    return matches;
  }
}
