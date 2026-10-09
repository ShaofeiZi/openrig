// PL-004 阶段 C R1：共享 artifact-pool 辅助函数（POC
// `lib/policies/artifact-pool.js` 的 TypeScript 移植版）。
//
// R1 修复（guard blocker 3）：扫描器完整对齐 POC。artifact-pool-ready 与
// edge-artifact-required 策略依赖以下行为：
//   - 默认忽略：始终排除 README.md 与 .DS_Store。
//   - 配置的 ignore_names：每个池可追加排除项。
//   - pool.recursive=true 时递归扫描。
//   - 除非设置 pool.include_malformed_frontmatter，否则排除 frontmatter 畸形项。
//   - 每个 artifact 都保留原始内容（供 edge-artifact-required 判断正文引用目标是否满足）。
//   - 池路径不存在时返回空结果（容忍 ENOENT）。
//
// 纯文件系统扫描器，不使用 event-bus、数据库或 Hono。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

const DEFAULT_EXTENSIONS = [".md"];
const DEFAULT_IGNORE_NAMES = ["README.md", ".DS_Store"];

export interface ArtifactPoolSpec {
  /** 池目录的绝对路径。POC 契约规定每个池只有一个路径。 */
  path?: string;
  /** 便捷数组形式；每条路径展开为一个池。 */
  paths?: string[];
  /** 要包含的文件扩展名（默认 ['.md']）。 */
  extensions?: string[];
  /** 按 frontmatter 的 `status:` 字段过滤；为空或缺失时包含全部。 */
  include_statuses?: string[];
  /** 用作 artifact key 的 frontmatter 字段（默认 'entry'）。 */
  key_field?: string;
  /** 每个池追加的忽略名称（与默认项合并）。 */
  ignore_names?: string[];
  /** 为 true 时进入子目录；默认为 false。 */
  recursive?: boolean;
  /**
   * 为 true 时，frontmatter 无法解析的 artifact 仍会以空 frontmatter 纳入。
   * 默认为 false：畸形 frontmatter 会使 artifact 被排除；这与 POC 行为一致，
   * 避免智能体因未写完的草稿而被唤醒。
   */
  include_malformed_frontmatter?: boolean;
}

export interface ScannedArtifact {
  /** artifact 文件的绝对路径。 */
  path: string;
  /** 产出此 artifact 的池路径。 */
  pool_path: string;
  /** 完整文件内容（供 edge-artifact-required 匹配正文）。 */
  raw: string;
  /**
   * 已解析的 YAML frontmatter（顶层 key）。值保留为 `unknown`，因为 YAML 标量类型各异：
   * 时间戳解析为 Date、URL 解析为 string、数字解析为 number 等。策略层的 frontmatter
   * 消费方（状态过滤、key_field 查询）会转换为 string。
   */
  frontmatter: Record<string, unknown>;
  /** include_malformed_frontmatter=true 时的解析错误消息，否则为 null。 */
  frontmatter_parse_error: string | null;
  /** frontmatter.status 的便捷访问值；缺失时为 null。 */
  status: string | null;
}

const FRONTMATTER_OPEN = "---\n";

/**
 * 从 Markdown 风格文档解析顶层 YAML frontmatter。
 * 返回 { raw, frontmatter, parseError }，由调用方决定是否纳入畸形 artifact。
 *
 * R2 修复（guard blocker 2）：使用已有后台服务依赖 `yaml` 包，而非本地 key/value 解析器。
 * 这对应 POC 的 `lib/policies/artifact-pool.js:21-30`，后者委托共享 YAML 加载器。
 * 包含冒号的合法 YAML 标量（ISO 时间戳、URL）可正确解析。仅真正的 YAML 解析失败
 *（例如确实非法的 `broken: value: still broken`）会在未设置
 * `include_malformed_frontmatter` 时导致排除。
 */
function readFrontmatter(filePath: string): {
  raw: string;
  frontmatter: Record<string, unknown>;
  frontmatter_parse_error: string | null;
} {
  const raw = readFileSync(filePath, "utf-8");
  if (!raw.startsWith(FRONTMATTER_OPEN)) {
    return { raw, frontmatter: {}, frontmatter_parse_error: null };
  }
  const endIdx = raw.indexOf("\n---\n", FRONTMATTER_OPEN.length);
  if (endIdx === -1) {
    return { raw, frontmatter: {}, frontmatter_parse_error: null };
  }
  const block = raw.slice(FRONTMATTER_OPEN.length, endIdx);
  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch (err) {
    return {
      raw,
      frontmatter: {},
      frontmatter_parse_error: err instanceof Error ? err.message : "frontmatter parse error",
    };
  }
  // YAML 已解析但根节点不是对象（string、array、null）：按空 frontmatter 处理，
  // 不视为解析错误。这与 POC 行为一致（lib/policies/artifact-pool.js:35-38）：
  // 非对象根节点生成 {}。
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { raw, frontmatter: {}, frontmatter_parse_error: null };
  }
  return {
    raw,
    frontmatter: parsed as Record<string, unknown>,
    frontmatter_parse_error: null,
  };
}

function listFiles(rootDir: string, recursive: boolean): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...listFiles(full, recursive));
      continue;
    }
    if (entry.isFile()) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function shouldIncludeFile(filePath: string, pool: ArtifactPoolSpec): boolean {
  const name = basename(filePath);
  const ignoreNames = new Set([
    ...DEFAULT_IGNORE_NAMES,
    ...(Array.isArray(pool.ignore_names) ? pool.ignore_names : []),
  ]);
  if (ignoreNames.has(name)) return false;
  const exts = Array.isArray(pool.extensions) ? pool.extensions : DEFAULT_EXTENSIONS;
  return exts.some((e) => name.endsWith(e));
}

function statusAllowed(status: string | null, pool: ArtifactPoolSpec): boolean {
  const include = pool.include_statuses;
  if (!Array.isArray(include) || include.length === 0) return true;
  return status !== null && include.includes(status);
}

/**
 * 把 YAML 解析后的 frontmatter status 字段转换为可比较字符串。
 * YAML 加载器可能把未引用状态解析为标识符（string），但 `2026-05-03` 这样的状态会解析为 Date。
 * 非字符串标量统一转换为 ISO，使 include_statuses 比较保持稳定。
 */
function statusFromFrontmatter(fm: Record<string, unknown>): string | null {
  const v = fm.status;
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * 按一个或多个 spec 扫描 artifact 池，对应 POC 的 `scanArtifactPools(pools)`。
 * 返回所有池匹配项的扁平并集，按绝对路径排序；池不存在时返回空结果。
 *
 * 若 `pools` 为 undefined、空值或没有有效结构则抛错。POC 契约要求 policy spec
 * 必须声明至少一个池。
 */
export async function scanArtifactPools(
  pools: ArtifactPoolSpec | ArtifactPoolSpec[] | undefined,
): Promise<ScannedArtifact[]> {
  const expanded = expandPools(pools);
  if (expanded.length === 0) {
    throw new Error("产物池策略：必须提供上下文池列表");
  }
  const out: ScannedArtifact[] = [];
  for (const pool of expanded) {
    if (!pool.path) {
      throw new Error("产物池策略：每个池都必须提供路径");
    }
    const files = listFiles(pool.path, Boolean(pool.recursive));
    for (const filePath of files) {
      if (!shouldIncludeFile(filePath, pool)) continue;
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let parsed;
      try {
        parsed = readFrontmatter(filePath);
      } catch {
        continue;
      }
      if (parsed.frontmatter_parse_error && !pool.include_malformed_frontmatter) {
        continue;
      }
      const status = statusFromFrontmatter(parsed.frontmatter);
      if (!statusAllowed(status, pool)) continue;
      out.push({
        path: filePath,
        pool_path: pool.path,
        raw: parsed.raw,
        frontmatter: parsed.frontmatter,
        frontmatter_parse_error: parsed.frontmatter_parse_error,
        status,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 把便捷输入结构（单个对象、对象数组或 `paths: [...]` 简写）
 * 展开为单路径池的扁平数组。
 */
function expandPools(
  pools: ArtifactPoolSpec | ArtifactPoolSpec[] | undefined,
): ArtifactPoolSpec[] {
  if (!pools) return [];
  const list = Array.isArray(pools) ? pools : [pools];
  const out: ArtifactPoolSpec[] = [];
  for (const spec of list) {
    if (spec.path) {
      out.push(spec);
    } else if (Array.isArray(spec.paths)) {
      for (const p of spec.paths) out.push({ ...spec, path: p, paths: undefined });
    }
  }
  return out;
}

/**
 * 把 artifact 列表格式化为项目符号行，对应 POC formatArtifactList：
 * `- /full/absolute/path`。POC 优先使用完整路径，使接收方无需额外查询即可直接
 * cd / open / cat 产物。
 */
export function formatArtifactList(artifacts: ScannedArtifact[], maxItems: number): string {
  return artifacts
    .slice(0, maxItems)
    .map((a) => `- ${a.path}`)
    .join("\n");
}

/**
 * 计算 artifact 的 source-key，对应 POC sourceKeyFor：优先使用 frontmatter[keyField]，
 * 否则使用去掉 .md 扩展名的 basename。非字符串标量（Date、number）转换为 string 以便比较。
 */
export function sourceKeyFor(artifact: ScannedArtifact, keyField: string): string {
  const value = artifact.frontmatter[keyField];
  if (value === undefined || value === null || value === "") {
    return basename(artifact.path).replace(/\.md$/, "");
  }
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
