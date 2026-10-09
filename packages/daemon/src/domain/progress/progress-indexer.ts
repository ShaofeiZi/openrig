// UI Enhancement Pack v0——workspace PROGRESS.md 索引器。
//
// 遍历操作员 allowlist 中的扫描根目录，查找 PROGRESS.md，将每个文件解析为 checkbox 层次树，
// 并生成以下位置消费的规范化 payload：
//   - GET /api/progress/tree（新的顶层进度浏览 view）
//   - 新的 ProgressTree React 组件
//
// 扫描策略（第 1B 项）：
//   - 操作员通过环境变量配置 progress 扫描根目录
//     OPENRIG_PROGRESS_SCAN_ROOTS=root1:/abs/path,root2:/abs/path
//     （与 OPENRIG_FILES_ALLOWLIST 使用相同的分隔 pair 结构）。
//   - 对每个已配置根目录，递归查找 PROGRESS.md，最大深度较小（默认 6），足以捕获
//     mission/lane/slice 嵌套，同时避免进入 node_modules 或其他深层目录树。
//   - 每个 PROGRESS.md 成为一个 mission/lane/slice 节点；从 `[ ]` / `[x]` / `[~]` checkbox
//     行与 Markdown 标题（## / ###）解析各行，形成层次结构。
//
// MVP 单 host：每次请求在内存中遍历；v0 不缓存（文件数受操作员 allowlist 范围约束，典型
// workspace 在一秒内完成）。

import * as fs from "node:fs";
import * as path from "node:path";

export type CheckboxStatus = "active" | "done" | "blocked" | "unknown";

export interface ProgressRow {
  /** 从 1 开始的源代码行号。 */
  line: number;
  /** 缩进深度（0 = 顶层；按 2 空格缩进或 Markdown 标题深度嵌套）。 */
  depth: number;
  /** 从 `[x]` / `[ ]` / `[~]` 语法解析出的状态。 */
  status: CheckboxStatus;
  /** checkbox 后的文本（若该行为标题，则为标题文本）。 */
  text: string;
  /** `[ ]` 行为 "checkbox"；`##` / `###` 行为 "heading"。 */
  kind: "checkbox" | "heading";
}

export interface ProgressFileNode {
  /** 操作员提供的扫描根目录显示名称。 */
  rootName: string;
  /** 相对于扫描根目录的路径（例如 "missions/foo/PROGRESS.md"）。 */
  relPath: string;
  /** 磁盘上的 canonical 绝对路径（便于 UI 提供“在编辑器中打开”操作）。 */
  absolutePath: string;
  mtime: string;
  rows: ProgressRow[];
  /** 顶层标题（来自 frontmatter 或第一个 H1）。 */
  title: string | null;
  /** 从行（kind === "checkbox"）派生的聚合计数。 */
  counts: { total: number; done: number; blocked: number; active: number };
}

export interface ProgressScanRoot {
  name: string;
  canonicalPath: string;
}

export interface ProgressTreeResult {
  files: ProgressFileNode[];
  /** 所有文件的聚合结果。 */
  aggregate: { totalFiles: number; totalRows: number; totalDone: number; totalBlocked: number; totalActive: number };
  /** 已扫描的根目录（供 UI 渲染“已扫描 N 个根目录”）。 */
  scannedRoots: ProgressScanRoot[];
}

const DEFAULT_MAX_DEPTH = 6;
const PROGRESS_FILENAME = "PROGRESS.md";
// OSR v0 第 2 项将 STEERING.md 锚定为 Priority Rail Rule 树顶部的 constraint-frame 节点。
// classifier 已将 STEERING basename 映射到 `steering` level；索引器也必须实际收录它。遍历这两个
// 文件名；行计数机制与文件名无关，对待 STEERING.md 内容与其他 Markdown rail 相同。
const STEERING_FILENAME = "STEERING.md";
const TREE_FILENAMES = new Set([PROGRESS_FILENAME, STEERING_FILENAME]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist", "build", ".turbo", ".next"]);

const ENV_VAR = "OPENRIG_PROGRESS_SCAN_ROOTS";
const LEGACY_ENV_VAR = "RIGGED_PROGRESS_SCAN_ROOTS";

/**
 * 将原始 `name:/abs/path,...` progress-roots 字符串解码为 ProgressScanRoot[]。语义与
 * path-safety 中的 decodeAllowlist 相同，应保持并行。供仅 env 的旧路径和经 settings 解析的
 * 路径（env > file > empty）共同使用。
 */
export function decodeProgressScanRoots(raw: string): ProgressScanRoot[] {
  if (!raw.trim()) return [];
  const out = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const rawPath = trimmed.slice(colon + 1).trim();
    if (!name || !rawPath || !path.isAbsolute(rawPath)) continue;
    let canonical: string;
    try { canonical = fs.realpathSync(rawPath); } catch { canonical = path.resolve(rawPath); }
    out.set(name, canonical);
  }
  return Array.from(out.entries()).map(([name, canonicalPath]) => ({ name, canonicalPath }));
}

export function readProgressRootsFromEnv(env: NodeJS.ProcessEnv = process.env): ProgressScanRoot[] {
  const raw = env[ENV_VAR] ?? env[LEGACY_ENV_VAR] ?? "";
  return decodeProgressScanRoots(raw);
}

export interface ProgressIndexerOpts {
  roots: ProgressScanRoot[];
  /** 为测试覆盖最大递归深度。 */
  maxDepth?: number;
}

export class ProgressIndexer {
  private readonly roots: ProgressScanRoot[];
  private readonly maxDepth: number;

  constructor(opts: ProgressIndexerOpts) {
    this.roots = opts.roots;
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  isReady(): boolean {
    return this.roots.length > 0;
  }

  scan(): ProgressTreeResult {
    const files: ProgressFileNode[] = [];
    for (const root of this.roots) {
      this.walkRoot(root, files);
    }
    files.sort((a, b) => a.relPath.localeCompare(b.relPath));
    const aggregate = files.reduce(
      (acc, f) => ({
        totalFiles: acc.totalFiles + 1,
        totalRows: acc.totalRows + f.counts.total,
        totalDone: acc.totalDone + f.counts.done,
        totalBlocked: acc.totalBlocked + f.counts.blocked,
        totalActive: acc.totalActive + f.counts.active,
      }),
      { totalFiles: 0, totalRows: 0, totalDone: 0, totalBlocked: 0, totalActive: 0 },
    );
    return { files, aggregate, scannedRoots: this.roots };
  }

  private walkRoot(root: ProgressScanRoot, out: ProgressFileNode[]): void {
    this.walkDir(root, root.canonicalPath, "", 0, out);
  }

  private walkDir(root: ProgressScanRoot, abs: string, rel: string, depth: number, out: ProgressFileNode[]): void {
    if (depth > this.maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        this.walkDir(root, childAbs, childRel, depth + 1, out);
      } else if (entry.isFile() && TREE_FILENAMES.has(entry.name)) {
        const node = this.parseProgressFile(root, childAbs, childRel);
        if (node) out.push(node);
      }
    }
  }

  private parseProgressFile(root: ProgressScanRoot, absolutePath: string, relPath: string): ProgressFileNode | null {
    let content: string;
    let mtime: Date;
    try {
      content = fs.readFileSync(absolutePath, "utf-8");
      mtime = fs.statSync(absolutePath).mtime;
    } catch { return null; }

    const rows: ProgressRow[] = [];
    const lines = content.split("\n");
    let title: string | null = null;
    let inFrontmatter = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNumber = i + 1;

      // 跳过 YAML frontmatter。
      if (lineNumber === 1 && line.trim() === "---") { inFrontmatter = true; continue; }
      if (inFrontmatter) {
        if (line.trim() === "---") inFrontmatter = false;
        continue;
      }

      // 第一个 H1 → title（若 frontmatter 未提供）。
      if (!title) {
        const h1 = line.match(/^#\s+(.+?)$/);
        if (h1) title = h1[1]!.trim();
      }

      // 标题行（## / ###）。
      const h = line.match(/^(#{2,4})\s+(.+?)$/);
      if (h) {
        rows.push({
          line: lineNumber,
          depth: h[1]!.length - 2, // ## → 0，### → 1，#### → 2。
          status: "unknown",
          text: h[2]!.trim(),
          kind: "heading",
        });
        continue;
      }

      // Checkbox 行。匹配裸 `[ ]`（无列表 bullet）或 `- [ ]` / `* [ ]`。bullet 的前导缩进
      // 决定深度。
      const cb = line.match(/^(\s*)(?:[-*]\s+)?\[([ xX~])\]\s+(.+)$/);
      if (cb) {
        const indentSpaces = cb[1]!.length;
        const indicator = cb[2]!.toLowerCase();
        const text = cb[3]!.trim();
        const status: CheckboxStatus =
          indicator === "x" ? "done"
          : indicator === "~" ? "blocked"
          : "active";
        rows.push({
          line: lineNumber,
          depth: Math.floor(indentSpaces / 2),
          status,
          text,
          kind: "checkbox",
        });
      }
    }

    const checkboxes = rows.filter((r) => r.kind === "checkbox");
    const counts = {
      total: checkboxes.length,
      done: checkboxes.filter((r) => r.status === "done").length,
      blocked: checkboxes.filter((r) => r.status === "blocked").length,
      active: checkboxes.filter((r) => r.status === "active").length,
    };

    return {
      rootName: root.name,
      relPath,
      absolutePath,
      mtime: mtime.toISOString(),
      rows,
      title,
      counts,
    };
  }
}
