// 已连接和所选本地读取的一个被动文本/导航契约。
import { posix as path } from "node:path";
import { fieldLine, listItem, wrapDetailLines, type ContentLine } from "./detail.js";
import type { Action } from "./types.js";

export interface FileTarget { root: string; path: string; anchor?: string }
export interface FileRoot { name: string; path: string }
export interface FileRead {
  root: string; path: string; absolutePath: string; resolvedPath?: string;
  content: string; mtime: string; contentHash: string; size: number;
  truncated: boolean; truncatedAtBytes: number | null; totalBytes: number;
  binary?: boolean;
}
export type FileReadResult = FileRead | { error: string; message?: string };

/** 仅对照显式服务的根目录映射，绝不搜索其他安装。 */
export function fileTargetForPath(source: string, roots: FileRoot[]): FileTarget | null {
  const root = [...roots].sort((a, b) => b.path.length - a.path.length)
    .find((r) => source.startsWith(r.path.replace(/\/$/, "") + "/"));
  return root ? { root: root.name, path: source.slice(root.path.replace(/\/$/, "").length + 1) } : null;
}

export function referenceAction(origin: FileTarget, href: string): Action {
  if (/^https?:\/\//i.test(href)) return { type: "external-open", url: href };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return { type: "error", message: "不支持的引用方案；未打开外部程序" };
  try {
    const hash = href.indexOf("#");
    const name = decodeURIComponent(hash < 0 ? href : href.slice(0, hash));
    const anchor = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1));
    // 相对于此实际源解析。逃逸仍为 ../，被
    // 现有读取器拒绝；符号链接包含仍由服务器拥有。
    const resolved = name ? (name.startsWith("/") ? name : path.normalize(path.join(path.dirname(origin.path), name))) : origin.path;
    return { type: "file-open", target: { root: origin.root, path: resolved, ...(anchor ? { anchor } : {}) } };
  } catch { return { type: "error", message: "引用中的无效百分号编码" }; }
}

export function referenceLines(text: string, origin: FileTarget): ContentLine[] {
  const links: ContentLine[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\[([^\]\n]+)\]\(<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\)/g)) {
    const href = match[2]!;
    if (seen.has(href)) continue;
    seen.add(href);
    links.push(listItem(`${match[1]} · ${/^https?:/i.test(href) ? "外部 URL" : href}`, referenceAction(origin, href)));
  }
  return links;
}

function headingSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
}

export function fileLines(result: FileReadResult | null | undefined, target: FileTarget, width = 80): ContentLine[] {
  const lines: ContentLine[] = [
    { text: `读取 · ${target.root || "未映射来源"} / ${target.path}${target.anchor ? `#${target.anchor}` : ""}` },
    listItem("返回 · Esc", { type: "back" }),
  ];
  if (!result) return wrapDetailLines([...lines, { text: "当前文件读取待处理；无先前字节显示。" }], width);
  if ("error" in result) return wrapDetailLines([...lines, { text: `无法读取：${result.error}` }, { text: result.message ?? "读取器不可用" }], width);
  lines.push(fieldLine({ label: "来源", value: result.absolutePath }),
    { text: `从磁盘读取 · 修改于 ${result.mtime}` },
    { text: `${result.totalBytes} 字节 · SHA-256 ${result.contentHash}` },
    { text: result.truncated ? `在 ${result.truncatedAtBytes} / ${result.totalBytes} 字节处截断；内容不完整。` : "完整文件读取 · 重读再次读取磁盘" });
  if (result.binary || /\x00/.test(result.content)) return wrapDetailLines([...lines, { text: "二进制 / 非 UTF-8 文件；不显示文本。" }], width);
  const sourceRows = result.content.split(/\r\n|\r|\n/);
  let start = 0;
  if (target.anchor) {
    const slugs = new Map<string, number>();
    let fence = false;
    const found = sourceRows.findIndex((row) => {
      if (/^\s*(```|~~~)/.test(row)) fence = !fence;
      const heading = !fence && row.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
      if (!heading) return false;
      const slug = headingSlug(heading[1]!);
      const n = slugs.get(slug) ?? 0; slugs.set(slug, n + 1);
      return (n ? `${slug}-${n}` : slug) === target.anchor;
    });
    if (found < 0) lines.push({ text: `未找到标题：#${target.anchor}${result.truncated ? " 在返回的前缀中" : ""}；从头显示。` });
    else { start = found; lines.push({ text: `从 #${target.anchor} 显示 · 源行 ${start + 1}` }); }
    lines.push(listItem("从头读取", { type: "file-open", target: { root: target.root, path: target.path } }));
  }
  const origin = { ...target, path: result.resolvedPath ?? result.path };
  lines.push({ text: "" });
  for (const row of sourceRows.slice(start)) {
    lines.push({ text: row }, ...referenceLines(row, origin));
  }
  return wrapDetailLines(lines, width);
}

export function externalLines(url: string, width: number): ContentLine[] {
  return wrapDetailLines([{ text: "外部 URL" }, { text: "未打开浏览器。使用 v 选择/复制此目标。" }, { text: url }, listItem("返回 · Esc", { type: "back" })], width);
}
