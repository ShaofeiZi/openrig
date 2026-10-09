// PL-007 工作区原语 v0——frontmatter 校验器（建议性）。
//
// 遍历工作区根目录，解析每个 .md 文件开头由 `---` 行包围的 YAML frontmatter，
// 并按种类校验必填字段。输出结构化缺口报告：
//
//   - missing-required-field（缺少必填字段）
//   - unrecognized-status-value（无法识别的状态值）
//   - parse-error（frontmatter 存在但畸形）
//   - missing-frontmatter（未找到 frontmatter 分隔符）
//
// 仅提供建议，绝不修改文件。curate-steward 将缺口报告用作卫生检查输入。
// 按 PL-007 PRD，v0 校验器刻意保持最小范围；broken-cross-reference 和
// non-conforming-structure 规则推迟到 v1+。

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkspaceKind } from "../types.js";
import { WORKSPACE_KINDS } from "../types.js";

export type FrontmatterGapKind =
  | "missing-required-field"
  | "unrecognized-status-value"
  | "parse-error"
  | "missing-frontmatter";

export interface FrontmatterGap {
  filePath: string;
  /** 相对校验根目录的路径，用于生成跨机器稳定的输出。 */
  relativePath: string;
  kind: FrontmatterGapKind;
  /** kind 为 "missing-required-field" 或 "unrecognized-status-value" 时的字段名；
   *  其他情况为 null。 */
  field: string | null;
  message: string;
  /** 校验文件时采用的工作区种类，例如 "knowledge"。 */
  workspaceKind: WorkspaceKind | null;
}

export interface FrontmatterValidationReport {
  root: string;
  /** 应用于此根目录下所有文件的工作区种类。v0 中调用方每次选择一个根和一种种类。 */
  workspaceKind: WorkspaceKind | null;
  totalFiles: number;
  filesWithFrontmatter: number;
  gapCount: number;
  gaps: FrontmatterGap[];
}

const VALID_STATUS_VALUES = new Set(["active", "draft", "archived", "superseded"]);

/** 各种类的 frontmatter 必填字段。v0 最低基线，仅提供建议。 */
const REQUIRED_FIELDS_BY_KIND: Record<WorkspaceKind, readonly string[]> = {
  user: ["doc"],
  project: ["doc"],
  knowledge: ["doc", "status", "created", "owner"],
  lab: ["doc", "status", "created", "owner"],
  delivery: ["doc", "status", "created", "owner"],
};

export interface ValidateOpts {
  root: string;
  workspaceKind?: WorkspaceKind;
  /** 为 true 时递归进入子目录，默认为 true。 */
  recursive?: boolean;
  /** 为 true 时，即使缺少 frontmatter 也校验每个 .md 文件，并记录
   *  `missing-frontmatter` 缺口。默认为 false——没有 `---` 的文件会被静默跳过，
   *  视为非正式笔记。 */
  requireFrontmatter?: boolean;
  /** 遍历文件数硬上限，默认 10000，防止失控调用意外遍历数 GB 数据。 */
  maxFiles?: number;
}

/** 运行 frontmatter 校验器。 */
export function validateWorkspaceFrontmatter(opts: ValidateOpts): FrontmatterValidationReport {
  const root = path.resolve(opts.root);
  const recursive = opts.recursive ?? true;
  const requireFrontmatter = opts.requireFrontmatter ?? false;
  const maxFiles = opts.maxFiles ?? 10000;
  const kind = isValidKind(opts.workspaceKind) ? opts.workspaceKind! : null;

  const gaps: FrontmatterGap[] = [];
  let totalFiles = 0;
  let filesWithFrontmatter = 0;

  const walk = (dir: string): void => {
    if (totalFiles >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (totalFiles >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        // 跳过不属于权威内容的噪声目录：node_modules、.git、.worktrees 以及 dist/build 产物。
        // 编写权威内容的作者不会把内容放在这些目录中。
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === ".worktrees" ||
          entry.name === "dist" ||
          entry.name === "build"
        ) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      totalFiles++;
      const result = validateFile(full, root, kind, requireFrontmatter);
      if (result.hasFrontmatter) filesWithFrontmatter++;
      gaps.push(...result.gaps);
    }
  };
  walk(root);

  return {
    root,
    workspaceKind: kind,
    totalFiles,
    filesWithFrontmatter,
    gapCount: gaps.length,
    gaps,
  };
}

function isValidKind(k: WorkspaceKind | undefined): k is WorkspaceKind {
  return typeof k === "string" && (WORKSPACE_KINDS as readonly string[]).includes(k);
}

interface FileValidation {
  hasFrontmatter: boolean;
  gaps: FrontmatterGap[];
}

function validateFile(
  filePath: string,
  root: string,
  kind: WorkspaceKind | null,
  requireFrontmatter: boolean,
): FileValidation {
  const relativePath = path.relative(root, filePath);
  const out: FileValidation = { hasFrontmatter: false, gaps: [] };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return out;
  }

  const fm = extractFrontmatter(raw);
  if (!fm.found) {
    if (requireFrontmatter) {
      out.gaps.push({
        filePath,
        relativePath,
        kind: "missing-frontmatter",
        field: null,
        message: "文件开头未找到 frontmatter 分隔符（---）",
        workspaceKind: kind,
      });
    }
    return out;
  }
  out.hasFrontmatter = true;

  let parsed: Record<string, unknown> | null;
  try {
    parsed = parseYaml(fm.body) as Record<string, unknown> | null;
  } catch (err) {
    out.gaps.push({
      filePath,
      relativePath,
      kind: "parse-error",
      field: null,
      message: err instanceof Error ? err.message : "YAML 解析错误",
      workspaceKind: kind,
    });
    return out;
  }
  if (!parsed || typeof parsed !== "object") {
    out.gaps.push({
      filePath,
      relativePath,
      kind: "parse-error",
      field: null,
      message: "frontmatter 不是 YAML 对象",
      workspaceKind: kind,
    });
    return out;
  }

  if (kind) {
    const required = REQUIRED_FIELDS_BY_KIND[kind];
    for (const field of required) {
      if (!(field in parsed) || parsed[field] === null || parsed[field] === undefined || parsed[field] === "") {
        out.gaps.push({
          filePath,
          relativePath,
          kind: "missing-required-field",
          field,
          message: `${kind} 权威内容需要 frontmatter 字段 "${field}"`,
          workspaceKind: kind,
        });
      }
    }
    // status 枚举检查：仅在 status 已存在且为字符串时执行。
    if (typeof parsed["status"] === "string" && !VALID_STATUS_VALUES.has(parsed["status"] as string)) {
      out.gaps.push({
        filePath,
        relativePath,
        kind: "unrecognized-status-value",
        field: "status",
        message: `status "${parsed["status"]}" 不在允许值中：${[...VALID_STATUS_VALUES].join(", ")}`,
        workspaceKind: kind,
      });
    }
  }
  return out;
}

interface FrontmatterExtraction {
  found: boolean;
  body: string;
}

/** 提取由 `---` 行包围的 YAML frontmatter。开头的 `---` 必须位于第一行；
 *  找到时返回两个分隔符之间的 frontmatter 正文。 */
function extractFrontmatter(raw: string): FrontmatterExtraction {
  if (!raw.startsWith("---")) return { found: false, body: "" };
  // 查找结束分隔符，同时允许 LF 与 CRLF 换行。
  const lines = raw.split(/\r?\n/);
  if (lines[0]!.trim() !== "---") return { found: false, body: "" };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      return { found: true, body: lines.slice(1, i).join("\n") };
    }
  }
  return { found: false, body: "" };
}
