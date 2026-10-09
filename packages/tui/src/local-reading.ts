import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { Action } from "./types.js";

export interface LocalRequest { op: "roots" | "list" | "read"; root?: string; path?: string }
interface LocalEntry { label: string; root: string; path: string; source: string; kind: string; error?: string }
export interface LocalResult {
  entries?: LocalEntry[]; source?: string; readAt?: string; error?: string; message?: string;
  absolutePath?: string; content?: string; mtime?: string; contentHash?: string;
  binary?: boolean; truncated?: boolean; truncatedAtBytes?: number | null; totalBytes?: number;
}
export interface LocalReadingState {
  request: LocalRequest; busy: boolean; selected: number; scroll: number; result: LocalResult;
}

export function readLocal(cliEntry: string | undefined, request: LocalRequest): Promise<LocalResult> {
  if (!cliEntry) return Promise.resolve({ error: "本地读取器在此启动器中不可用；请通过已安装的 zrig CLI 打开。" });
  return new Promise((resolve) => {
    execFile(process.execPath, [join(dirname(cliEntry), "local-reading.js"), JSON.stringify(request)],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve({ error: "本地读取器未完成", message: error.message });
        try { resolve(JSON.parse(stdout)); }
        catch { resolve({ error: "本地读取器返回了无效数据" }); }
      });
  });
}

export class LocalReadingController {
  readonly state: LocalReadingState = { request: { op: "roots" }, busy: false, selected: 0, scroll: 0, result: {} };
  private history: Array<{ request: LocalRequest; selected: number; scroll: number }> = [];
  private generation = 0;
  constructor(private read: (request: LocalRequest) => Promise<LocalResult>, private changed: () => void) {}
  async load(request = this.state.request) {
    const generation = ++this.generation;
    Object.assign(this.state, { request, busy: true, result: {} }); this.changed();
    let result: LocalResult;
    try { result = await this.read(request); }
    catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
    if (generation !== this.generation) return;
    Object.assign(this.state, { busy: false, result }); this.changed();
  }
  close() { this.generation++; }
  async key(key: string): Promise<boolean> {
    const s = this.state;
    if (key === "escape") {
      const previous = this.history.pop();
      if (!previous) { this.close(); return false; }
      Object.assign(s, previous); await this.load(); return true;
    }
    if (key === "r") { await this.load(); return true; }
    if (["up", "down", "pageup", "pagedown"].includes(key) || key.startsWith("select:")) {
      const delta = key.includes("up") ? -1 : 1;
      if (s.result.entries) s.selected = Math.max(0, Math.min(s.result.entries.length - 1,
        key.startsWith("select:") ? Number(key.slice(7)) : s.selected + delta));
      else s.scroll = Math.max(0, s.scroll + delta * (key.startsWith("page") ? 10 : 1));
      this.changed(); return true;
    }
    if (key === "enter" && !s.busy) {
      const entry = s.result.entries?.[s.selected];
      if (entry) {
        this.history.push({ request: s.request, selected: s.selected, scroll: s.scroll });
        s.selected = 0; s.scroll = 0;
        const request: LocalRequest = { op: entry.kind === "directory" ? "list" : "read", root: entry.root, path: entry.path };
        if (entry.error) { this.generation++; s.request = request; s.result = { error: entry.error, source: entry.source }; this.changed(); }
        else await this.load(request);
      }
    }
    return true;
  }
}

export function localLines(s: LocalReadingState): Array<{ text: string; action?: Action }> {
  const r = s.result;
  const lines: Array<{ text: string; action?: Action }> = [
    { text: "本地读取 · 此机器的已配置来源" },
    { text: "仅磁盘快照。实时队列、执行和拓扑在此不可用。" },
    { text: "r 重读磁盘 · Esc 返回 · ↑↓ 选择/滚动 · 回车 读取" },
    { text: `来源：${r.absolutePath ?? r.source ?? (s.request.root ? `${s.request.root}/${s.request.path}` : "已配置工作区根目录")}` },
  ];
  if (s.busy) return [...lines, { text: "正在读取所选来源…帮助和返回仍可用。" }];
  if (r.error) return [...lines, { text: `不可用：${r.error}` }, { text: r.message ?? "" }];
  if (r.entries) {
    lines.push({ text: `读取于 ${r.readAt}` }, { text: "" });
    for (const [i, entry] of r.entries.entries()) lines.push({
      text: `${i === s.selected ? "▶" : " "} ${entry.label}${entry.kind === "directory" ? "/" : ""}${entry.error ? ` · ${entry.error}` : ""}`,
      action: { type: "startup", key: `select:${i}` },
    });
    if (!r.entries.length) lines.push({ text: "此所选目录中无可见条目。" });
  } else {
    lines.push({ text: `修改于 ${r.mtime} · ${r.totalBytes} 字节` }, { text: `SHA-256 ${r.contentHash}` },
      { text: r.truncated ? `在 ${r.truncatedAtBytes} / ${r.totalBytes} 字节处截断。` : "完整磁盘读取。此读取后可能变化；非后台服务状态。" });
    if (r.binary) lines.push({ text: "二进制 / 非 UTF-8 文件；不显示文本。" });
    else lines.push({ text: "" }, ...(r.content ?? "").split(/\r\n|\r|\n/).map((text) => ({ text })));
  }
  return lines;
}
