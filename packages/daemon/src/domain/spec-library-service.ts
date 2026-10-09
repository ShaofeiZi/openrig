import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, dirname, extname } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SpecReviewService } from "./spec-review-service.js";

export interface SpecLibraryEntry {
  id: string;
  kind: "rig" | "agent" | "workflow";
  name: string;
  version: string;
  sourceType: "builtin" | "user_file";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
  hasServices?: boolean;
  /** Spec Library v0 中工作流专属的元数据（kind === `workflow`）。 */
  isBuiltIn?: boolean;
  rolesCount?: number;
  stepsCount?: number;
  terminalTurnRule?: string;
  targetRig?: string | null;
  /** Slice 11（workflow-spec-folder-discovery）——目录扫描得到的工作流 entry 诊断状态。
   *  `error` 行来自格式错误的 YAML，并在 errorMessage 中携带解析/校验原因，
   *  供 Library UI 渲染诊断行。 */
  status?: "valid" | "error";
  errorMessage?: string | null;
}

export interface SpecLibraryOpts {
  roots: Array<{ path: string; sourceType: "builtin" | "user_file" }>;
  specReviewService: SpecReviewService;
}

export type SpecLibraryMutationResult =
  | { ok: true; entry: SpecLibraryEntry }
  | { ok: false; code: "not_found" | "read_only" | "conflict" | "invalid_spec"; error: string };

function makeId(sourceType: string, relativePath: string): string {
  return createHash("sha256")
    .update(`${sourceType}:${relativePath}`)
    .digest("hex")
    .slice(0, 16);
}

function isYamlFile(filename: string): boolean {
  return filename.endsWith(".yaml") || filename.endsWith(".yml");
}

// OPR.0.3.2.22 Bug 4——绝不能进入 spec library 遍历的噪声目录。此集合与
// progress-indexer.ts:81 完全一致。frontmatter-validator.ts:103 是相关 scanner，使用更窄的子集
//（node_modules / .git / .worktrees / dist / build）；若此列表与 progress-indexer 列表出现分歧，
// 应先在那里统一。`.worktrees` entry 关闭了一类 stale-row：worktree 中的 conveyor.yaml 曾会滑入
// library cache，导致 `zrig specs show conveyor` 出现歧义匹配。
const SKIP_DIRS = new Set([
  ".worktrees",
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".next",
]);

function walkYamlFiles(rootPath: string): string[] {
  const files: string[] = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(absPath);
        continue;
      }
      if (entry.isFile() && isYamlFile(entry.name)) {
        files.push(absPath);
      }
    }
  }

  files.sort();
  return files;
}

function shouldIndexRelativePath(sourceType: "builtin" | "user_file", relPath: string): boolean {
  if (sourceType !== "builtin") {
    return true;
  }

  const normalized = relPath.replaceAll("\\", "/");
  return normalized.startsWith("rigs/") ? normalized.endsWith("/rig.yaml") : normalized.endsWith("/agent.yaml");
}

export class SpecLibraryService {
  private entries = new Map<string, SpecLibraryEntry>();
  /** Workflow entry 由 route 层通过 setWorkflowEntries() 写入。它们与工作组/智能体扫描分开保存，
   *  因为其真源是 workflow_specs SQLite cache，而不是磁盘上的 YAML 文件。 */
  private workflowEntries = new Map<string, SpecLibraryEntry>();
  private readonly roots: SpecLibraryOpts["roots"];
  private readonly specReviewService: SpecReviewService;

  constructor(opts: SpecLibraryOpts) {
    this.roots = opts.roots;
    this.specReviewService = opts.specReviewService;
  }

  scan(): void {
    const newEntries = new Map<string, SpecLibraryEntry>();

    for (const root of this.roots) {
      const files = walkYamlFiles(root.path);
      if (files.length === 0) {
        continue;
      }

      for (const absPath of files) {
        const relPath = relative(root.path, absPath);
        if (!shouldIndexRelativePath(root.sourceType, relPath)) {
          continue;
        }

        let yaml: string;
        try {
          yaml = readFileSync(absPath, "utf-8");
        } catch {
          continue; // 无法读取时跳过。
        }

        let stat: { mtimeMs: number };
        try {
          stat = statSync(absPath);
        } catch {
          continue;
        }

        const entry = this.classifySpec(yaml, root.sourceType, absPath, relPath, stat.mtimeMs);
        if (entry) {
          newEntries.set(entry.id, entry);
        }
      }
    }

    this.entries = newEntries;
  }

  list(filter?: { kind?: "rig" | "agent" | "workflow" }): SpecLibraryEntry[] {
    const entries = [
      ...Array.from(this.entries.values()),
      ...Array.from(this.workflowEntries.values()),
    ];
    if (filter?.kind) {
      return entries.filter((e) => e.kind === filter.kind);
    }
    return entries;
  }

  /** Spec Library v0 中的工作流：一次性替换 workflow-entry projection。route 层针对
   *  workflow_specs SQLite cache 运行 scanWorkflowSpecs() 后调用。 */
  setWorkflowEntries(entries: SpecLibraryEntry[]): void {
    const next = new Map<string, SpecLibraryEntry>();
    for (const entry of entries) {
      if (entry.kind !== "workflow") continue;
      next.set(entry.id, entry);
    }
    this.workflowEntries = next;
  }

  get(id: string): { entry: SpecLibraryEntry; yaml: string } | null {
    // Workflow entry 的 YAML 按需从 source path 读取。
    const wfEntry = this.workflowEntries.get(id);
    if (wfEntry) {
      let yaml = "";
      try { yaml = readFileSync(wfEntry.sourcePath, "utf-8"); } catch { /* 容忍读取失败。 */ }
      return { entry: wfEntry, yaml };
    }
    const entry = this.entries.get(id);
    if (!entry) return null;

    try {
      const yaml = readFileSync(entry.sourcePath, "utf-8");
      return { entry, yaml };
    } catch {
      return null;
    }
  }

  remove(id: string): SpecLibraryMutationResult {
    const entry = this.entries.get(id);
    if (!entry) {
      return { ok: false, code: "not_found", error: `library 中未找到 Spec '${id}'` };
    }
    if (entry.sourceType !== "user_file") {
      return { ok: false, code: "read_only", error: `Spec '${entry.name}' 为内置项，无法移除。` };
    }

    unlinkSync(entry.sourcePath);
    this.scan();
    return { ok: true, entry };
  }

  rename(id: string, newName: string): SpecLibraryMutationResult {
    const entry = this.entries.get(id);
    if (!entry) {
      return { ok: false, code: "not_found", error: `library 中未找到 Spec '${id}'` };
    }
    if (entry.sourceType !== "user_file") {
      return { ok: false, code: "read_only", error: `Spec '${entry.name}' 为内置项，无法重命名。` };
    }

    const trimmedName = newName.trim();
    if (!trimmedName) {
      return { ok: false, code: "invalid_spec", error: "name 为必填项" };
    }
    if (Array.from(this.entries.values()).some((candidate) => candidate.id !== id && candidate.name === trimmedName)) {
      return { ok: false, code: "conflict", error: `library 中已存在 Spec 名称 '${trimmedName}'。` };
    }

    const yaml = readFileSync(entry.sourcePath, "utf-8");
    const raw = parseYaml(yaml) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      return { ok: false, code: "invalid_spec", error: `无法解析 Spec '${entry.name}' 以执行重命名。` };
    }
    raw["name"] = trimmedName;

    const extension = extname(entry.sourcePath) || ".yaml";
    const fileSafeName = trimmedName.replace(/[^A-Za-z0-9._-]+/g, "-");
    const nextPath = join(dirname(entry.sourcePath), `${fileSafeName}${extension}`);
    if (nextPath !== entry.sourcePath) {
      try {
        statSync(nextPath);
        return { ok: false, code: "conflict", error: `${nextPath} 已存在 spec 文件。` };
      } catch {
        // target path 可用。
      }
    }

    const nextYaml = stringifyYaml(raw);
    if (nextPath === entry.sourcePath) {
      writeFileSync(entry.sourcePath, nextYaml, "utf-8");
    } else {
      writeFileSync(nextPath, nextYaml, "utf-8");
      unlinkSync(entry.sourcePath);
    }

    this.scan();
    const renamed = Array.from(this.entries.values()).find((candidate) => candidate.sourcePath === nextPath);
    return renamed
      ? { ok: true, entry: renamed }
      : { ok: false, code: "invalid_spec", error: `重命名后的 spec '${trimmedName}' 无法重新加载。` };
  }

  private classifySpec(
    yaml: string,
    sourceType: "builtin" | "user_file",
    absPath: string,
    relPath: string,
    mtimeMs: number,
  ): SpecLibraryEntry | null {
    // 先尝试按工作组 spec 解析。
    try {
      const review = this.specReviewService.reviewRigSpec(yaml, "library_item");
      let hasServices = false;
      try {
        const raw = parseYaml(yaml) as Record<string, unknown>;
        hasServices = !!(raw["services"] && typeof raw["services"] === "object");
      } catch { /* 使用安全默认值。 */ }
      return {
        id: makeId(sourceType, relPath),
        kind: "rig",
        name: review.name,
        version: review.version,
        sourceType,
        sourcePath: absPath,
        relativePath: relPath,
        updatedAt: new Date(mtimeMs).toISOString(),
        summary: review.summary,
        ...(hasServices ? { hasServices } : {}),
      };
    } catch {
      // 不是合法的工作组 spec。
    }

    // 再尝试按智能体 spec 解析。
    try {
      const review = this.specReviewService.reviewAgentSpec(yaml, "library_item");
      return {
        id: makeId(sourceType, relPath),
        kind: "agent",
        name: review.name,
        version: review.version,
        sourceType,
        sourcePath: absPath,
        relativePath: relPath,
        updatedAt: new Date(mtimeMs).toISOString(),
        summary: review.description,
      };
    } catch {
      // 也不是合法的智能体 spec，跳过。
    }

    return null;
  }
}
