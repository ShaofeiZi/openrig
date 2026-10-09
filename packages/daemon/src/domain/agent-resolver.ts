import nodePath from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "./agent-manifest.js";
import type { AgentSpec, AgentResources } from "./types.js";

// -- 类型 --

export interface AgentResolverFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
}

export interface ResolvedAgentSpec {
  spec: AgentSpec;
  sourcePath: string;
  hash: string;
}

export interface ResourceCollision {
  category: string;
  resourceId: string;
  sources: Array<{ specName: string; qualifiedId: string }>;
}

export interface ShippableSubstanceSource {
  path: string;
  bytes: string | Uint8Array;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedAgentSpec; imports: ResolvedAgentSpec[]; collisions: ResourceCollision[] }
  | { ok: false; code: "not_found"; error: string }
  | { ok: false; code: "parse_error"; error: string }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "version_mismatch"; error: string }
  | { ok: false; code: "import_error"; error: string; importRef: string }
  | { ok: false; code: "cycle_detected"; error: string };

// -- 资源类别键 --

const RESOURCE_CATEGORIES: (keyof AgentResources)[] = [
  "skills", "guidance", "subagents", "plugins", "runtimeResources",
];

// -- 公共 API --

/**
 * 将 agent_ref 解析为具体 AgentSpec，包括扁平导入。
 * @param ref agent_ref 字符串（例如 "local:agents/impl" 或 "path:/abs/agents/impl"）
 * @param rigRoot 工作组根目录的绝对路径
 * @param fsOps 可注入的文件系统操作
 * @returns 结构化解析结果
 */
export function resolveAgentRef(
  ref: string,
  rigRoot: string,
  fsOps: AgentResolverFsOps,
): ResolveResult {
  const dirPath = resolveRefToAbsPath(ref, rigRoot);
  if (!dirPath) {
    return { ok: false, code: "not_found", error: `无法解析 agent_ref "${ref}"` };
  }

  const baseResult = loadSpec(dirPath, fsOps);
  if (!baseResult.ok) return baseResult;

  // 解析扁平导入——local: 引用相对于基础 spec 目录解析。
  return resolveWithImports(baseResult.resolved, baseResult.resolved.sourcePath, fsOps, new Set([baseResult.resolved.sourcePath]));
}

/**
 * 为已加载的 AgentSpec 解析导入。local: 引用相对于该 spec 自身目录解析。
 * @param resolved 已解析的基础 spec
 * @param fsOps 可注入的文件系统操作
 * @returns 包含导入和冲突的结构化解析结果
 */
export function resolveImports(
  resolved: ResolvedAgentSpec,
  fsOps: AgentResolverFsOps,
): ResolveResult {
  return resolveWithImports(resolved, resolved.sourcePath, fsOps, new Set([resolved.sourcePath]));
}

/**
 * 内容跨越公共产物边界时的确定性拒绝底线。更宽泛的通用内容与实例内容判断仍由人类完成，
 * 并记录在 substance-gate 回执中；此辅助函数只执行两类结构上可确定的规则：私有
 * shared-docs 路径和 taxonomy: lore。
 */
export function assertShippableSubstance(sources: readonly ShippableSubstanceSource[]): void {
  const findings: Array<{ path: string; kind: "internal-path" | "lore-class"; detail: string }> = [];
  for (const source of sources) {
    const normalizedPath = source.path.replaceAll("\\", "/");
    const text = Buffer.from(source.bytes).toString("utf8");
    if (text.toLowerCase().includes("substrate/shared-docs/")) {
      findings.push({
        path: normalizedPath,
        kind: "internal-path",
        detail: "包含 substrate/shared-docs/",
      });
    }
    if (declaresLoreTaxonomy(normalizedPath, text)) {
      findings.push({
        path: normalizedPath,
        kind: "lore-class",
        detail: "声明 taxonomy: lore",
      });
    }
  }
  if (findings.length === 0) return;

  throw new Error([
    "拒绝公开产物内容：",
    ...findings.map(({ path, kind, detail }) => `  ${kind}: ${path} ${detail}`),
    "修复方法：将内容通用化、引用其公开来源，或将其移到内部内容包根目录。",
  ].join("\n"));
}

function declaresLoreTaxonomy(path: string, text: string): boolean {
  let yamlText: string | undefined;
  if (/\.ya?ml$/i.test(path)) {
    yamlText = text;
  } else if (/\.(?:md|markdown)$/i.test(path)) {
    const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    yamlText = frontmatter?.[1];
  }
  if (yamlText === undefined) return false;
  try {
    const parsed = parseYaml(yamlText);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>)["taxonomy"] === "lore";
  } catch {
    return false;
  }
}

/**
 * 解析单个 agent_ref，但不继续跟随导入；用于导入目标。
 * @param ref 导入引用字符串
 * @param basePath 解析 local: 引用时使用的基准目录
 * @param fsOps 文件系统操作
 * @returns 已解析 spec 或错误
 */
function loadSpec(
  dirPath: string,
  fsOps: AgentResolverFsOps,
): { ok: true; resolved: ResolvedAgentSpec } | { ok: false; code: "not_found"; error: string } | { ok: false; code: "parse_error"; error: string } | { ok: false; code: "validation_failed"; errors: string[] } {
  const manifestPath = nodePath.join(dirPath, "agent.yaml");

  if (!fsOps.exists(manifestPath)) {
    return { ok: false, code: "not_found", error: `在 ${manifestPath} 未找到 agent.yaml` };
  }

  let rawYaml: string;
  try {
    rawYaml = fsOps.readFile(manifestPath);
  } catch (err) {
    return { ok: false, code: "parse_error", error: `无法读取 ${manifestPath}：${(err as Error).message}` };
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseAgentSpec(rawYaml);
  } catch (err) {
    return { ok: false, code: "parse_error", error: `无法解析 ${manifestPath}：${(err as Error).message}` };
  }

  const validation = validateAgentSpec(raw);
  if (!validation.valid) {
    return { ok: false, code: "validation_failed", errors: validation.errors };
  }

  const spec = normalizeAgentSpec(raw);
  const hash = createHash("sha256").update(rawYaml).digest("hex");

  return {
    ok: true,
    resolved: { spec, sourcePath: dirPath, hash },
  };
}

/**
 * 解析基础 spec 和扁平导入，检测冲突并执行 v1 约束。
 */
/**
 * 解析基础 spec 和扁平导入。local: 引用相对于 specDir（发起导入的 spec 自身目录）解析，
 * 而不是相对于工作组根目录。
 */
function resolveWithImports(
  base: ResolvedAgentSpec,
  specDir: string,
  fsOps: AgentResolverFsOps,
  visitedPaths: Set<string>,
): ResolveResult {
  const resolvedImports: ResolvedAgentSpec[] = [];
  const importNames = new Set<string>();

  for (const imp of base.spec.imports) {
    // AS-T01 校验已拒绝远程源；解析阶段再次防御性检查。
    if (!imp.ref.startsWith("local:") && !imp.ref.startsWith("path:")) {
      return { ok: false, code: "import_error", error: `v1 不支持远程导入源："${imp.ref}"`, importRef: imp.ref };
    }

    const importDir = resolveRefToAbsPath(imp.ref, specDir);
    if (!importDir) {
      return { ok: false, code: "import_error", error: `无法解析导入引用 "${imp.ref}"`, importRef: imp.ref };
    }

    // 循环检测。
    if (visitedPaths.has(importDir)) {
      return { ok: false, code: "cycle_detected", error: `检测到导入循环："${imp.ref}" 解析到已访问路径 ${importDir}` };
    }

    const importResult = loadSpec(importDir, fsOps);
    if (!importResult.ok) {
      if (importResult.code === "not_found") {
        return { ok: false, code: "import_error", error: importResult.error, importRef: imp.ref };
      }
      if (importResult.code === "validation_failed") {
        return { ok: false, code: "import_error", error: `导入引用 "${imp.ref}" 的 spec 存在校验错误：${importResult.errors.join("; ")}`, importRef: imp.ref };
      }
      return { ok: false, code: "import_error", error: importResult.error, importRef: imp.ref };
    }

    const importedSpec = importResult.resolved;

    // 版本检查。
    if (imp.version && importedSpec.spec.version !== imp.version) {
      return {
        ok: false, code: "version_mismatch",
        error: `导入 "${imp.ref}" 要求版本 "${imp.version}"，但 spec 声明的是 "${importedSpec.spec.version}"`,
      };
    }

    // v1：被导入 spec 不能再声明自己的导入，即不支持传递导入。
    if (importedSpec.spec.imports.length > 0) {
      return {
        ok: false, code: "import_error",
        error: `被导入 spec "${importedSpec.spec.name}" 声明了嵌套导入，v1 不支持`,
        importRef: imp.ref,
      };
    }

    // 被导入 spec 名称不能包含冒号，否则会与限定引用语法冲突。
    if (importedSpec.spec.name.includes(":")) {
      return {
        ok: false, code: "import_error",
        error: `被导入 spec 名称 "${importedSpec.spec.name}" 包含冒号，与限定引用语法（namespace:id）冲突`,
        importRef: imp.ref,
      };
    }

    // 重复导入名称。
    if (importNames.has(importedSpec.spec.name)) {
      return {
        ok: false, code: "import_error",
        error: `导入名称重复：两个导入都解析到名为 "${importedSpec.spec.name}" 的 spec`,
        importRef: imp.ref,
      };
    }
    importNames.add(importedSpec.spec.name);

    resolvedImports.push(importedSpec);
  }

  // 检测资源冲突。
  const collisions = detectCollisions(base, resolvedImports);

  return { ok: true, resolved: base, imports: resolvedImports, collisions };
}

// -- 冲突检测 --

function detectCollisions(base: ResolvedAgentSpec, imports: ResolvedAgentSpec[]): ResourceCollision[] {
  const collisions: ResourceCollision[] = [];

  for (const category of RESOURCE_CATEGORIES) {
    // 构建 resourceId → 来源映射。
    const idSources = new Map<string, Array<{ specName: string; qualifiedId: string }>>();

    // 基础 spec 资源（非限定 ID）。
    const baseResources = base.spec.resources[category] as Array<{ id: string }>;
    for (const r of baseResources) {
      const sources = idSources.get(r.id) ?? [];
      sources.push({ specName: base.spec.name, qualifiedId: r.id });
      idSources.set(r.id, sources);
    }

    // 被导入 spec 资源（限定 ID）。
    for (const imp of imports) {
      const importResources = imp.spec.resources[category] as Array<{ id: string }>;
      for (const r of importResources) {
        const sources = idSources.get(r.id) ?? [];
        sources.push({ specName: imp.spec.name, qualifiedId: `${imp.spec.name}:${r.id}` });
        idSources.set(r.id, sources);
      }
    }

    // 记录冲突（任何拥有两个及以上来源的 ID）。
    for (const [resourceId, sources] of idSources) {
      if (sources.length >= 2) {
        collisions.push({ category, resourceId, sources });
      }
    }
  }

  return collisions;
}

// -- 路径解析 --

function resolveRefToAbsPath(ref: string, baseDir: string): string | null {
  if (ref.startsWith("local:")) {
    const relPath = ref.slice("local:".length);
    if (!relPath) return null;
    return nodePath.resolve(baseDir, relPath);
  }
  if (ref.startsWith("path:")) {
    const absPath = ref.slice("path:".length);
    if (!absPath) return null;
    return absPath;
  }
  return null;
}
