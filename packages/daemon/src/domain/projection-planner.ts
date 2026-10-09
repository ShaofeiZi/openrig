import nodePath from "node:path";
import * as os from "node:os";
import type { StartupBlock } from "./types.js";
import { classifyResourceProjection } from "./conflict-detector.js";
import type { ResolvedNodeConfig, QualifiedResource, ResolvedResources } from "./profile-resolver.js";
import type { ResourceCollision } from "./agent-resolver.js";
import type { ResolvedStartupFile } from "./runtime-adapter.js";
import { DEFAULT_CLAUDE_MANAGED_BLOCK_FILE, type ClaudeManagedBlockFile } from "./managed-blocks.js";

// ——类型——

export type ProjectionClassification =
  | "safe_projection"
  | "managed_merge"
  | "hash_conflict"
  | "no_op"
  // P20——根据 manifest 区分旧版“target ≠ source”冲突：
  | "stale_overwrite" // target == 我们上次写入的内容；source 已前进 → 可安全覆盖。
  | "operator_conflict"; // target 同时偏离上次写入和 source → 保护。

export interface ProjectionEntry {
  category: "skill" | "guidance" | "subagent" | "plugin" | "runtime_resource";
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resourcePath: string;
  absolutePath: string;
  resourceType?: string;
  classification: ProjectionClassification;
  conflictDetail?: { reason: string; existingHash?: string; sourceHash?: string };
  mergeStrategy?: "managed_block" | "append";
  target?: string;
  /** Plugin runtime 适用性提示。仅对 category=plugin 有意义。
   *  - "claude" / "codex"：操作员显式覆盖；仅具名 runtime adapter 执行投影
   *  - "auto" 或 undefined：adapter 检测 manifest 目录（.claude-plugin/ 与 .codex-plugin/），
   *    仅在对应 runtime manifest 存在时投影
   */
  pluginType?: "claude" | "codex" | "auto";
}

export interface ProjectionPlan {
  runtime: string;
  cwd: string;
  entries: ProjectionEntry[];
  startup: StartupBlock;
  conflicts: ProjectionEntry[];
  noOps: ProjectionEntry[];
  diagnostics: string[];
}

export interface ProjectionFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
}

export interface ProjectionInput {
  config: ResolvedNodeConfig;
  collisions: ResourceCollision[];
  fsOps: ProjectionFsOps;
  /** 可选：解析用于冲突检测的 target path。缺席时所有 entry 都是 safe_projection。
   *  P17：source absolutePath 作为第 4 个参数传递，以便派生 file-shaped target（subagent
   *  basename）；现有 3 参数调用方不受影响。 */
  resolveTargetPath?: (category: string, effectiveId: string, cwd: string, sourcePath?: string) => string | null;
  /** P20——projector 对 target 上次写入的 hash（来自 projection manifest），或 null。缺席时
   * classify 回退到 P17（hash_conflict）。在 classify 内以 fail-closed 方式查询（抛错 → 无 manifest
   * fallback）。 */
  lastHashLookup?: (targetPath: string) => string | null;
}

export type PlanResult =
  | { ok: true; plan: ProjectionPlan }
  | { ok: false; errors: string[] };

// ——类别映射——

const CATEGORY_MAP: Record<string, ProjectionEntry["category"]> = {
  skills: "skill",
  guidance: "guidance",
  subagents: "subagent",
  plugins: "plugin",
  runtimeResources: "runtime_resource",
};

// ——公共 API——

/**
 * 为一个已解析 node 规划有效 runtime 投影。
 * @param input - 已解析 config、冲突诊断和文件系统操作
 * @returns 投影计划或错误
 */
export function planProjection(input: ProjectionInput): PlanResult {
  const { config, collisions, fsOps } = input;
  const errors: string[] = [];
  const diagnostics: string[] = [];
  const entries: ProjectionEntry[] = [];

  // 检查所选资源的 import/import 歧义。
  const ambiguityErrors = checkAmbiguity(config.selectedResources, collisions);
  if (ambiguityErrors.length > 0) {
    return { ok: false, errors: ambiguityErrors };
  }

  // 记录冲突诊断。
  for (const col of collisions) {
    if (col.sources.length >= 2) {
      diagnostics.push(`${col.category} 中存在冲突："${col.resourceId}" 由 ${col.sources.map((s) => s.specName).join(", ")} 声明`);
    }
  }

  // 规划每个资源类别。
  for (const [catKey, catSingular] of Object.entries(CATEGORY_MAP)) {
    const resources = config.selectedResources[catKey as keyof ResolvedResources] as QualifiedResource[];
    for (const qr of resources) {
      // Runtime 资源过滤。
      if (catKey === "runtimeResources") {
        const rr = qr.resource as { runtime: string; type?: string };
        if (rr.runtime !== config.runtime) continue;
      }

      // Plugin 使用不同结构：{ id, source: { kind, path } }——从 source 提取 path。
      // 按 DESIGN.md §5.2，plugin path 支持三种形式：
      //   1. 绝对系统路径 → 精确保留
      //   2. 以 home 波浪号开头（~/... 或单独 ~）→ 展开为 os.homedir()
      //   3. 相对于 spec 目录 → 基于 qr.sourcePath 解析
      // 不展开带用户名的 ~user，而是按 Node 的 nodePath 约定视为字面相对 segment，避免隐式
      // username 查询给操作员带来意外。
      let resourcePath: string;
      let absolutePath: string;
      if (catKey === "plugins") {
        const pluginSource = (qr.resource as { source: { kind: string; path: string } }).source;
        resourcePath = pluginSource.path;
        absolutePath = resolvePluginPath(resourcePath, qr.sourcePath);
      } else {
        resourcePath = (qr.resource as { path: string }).path;
        absolutePath = nodePath.resolve(qr.sourcePath, resourcePath);
      }

      const entry: ProjectionEntry = {
        category: catSingular,
        effectiveId: qr.effectiveId,
        sourceSpec: qr.sourceSpec,
        sourcePath: qr.sourcePath,
        resourcePath,
        absolutePath,
        classification: "safe_projection",
      };

      if (catKey === "runtimeResources") {
        entry.resourceType = (qr.resource as { type?: string }).type;
      }

      if (catKey === "plugins") {
        const pluginRes = qr.resource as { pluginType?: "claude" | "codex" | "auto" };
        entry.pluginType = pluginRes.pluginType ?? "auto";
      }

      // Guidance 专用字段。
      if (catKey === "guidance") {
        const g = qr.resource as { target?: string; merge?: string };
        entry.target = g.target;
        entry.mergeStrategy = g.merge as "managed_block" | "append" | undefined;
      }

      // 使用基于 hash 的冲突检测进行分类。
      if (input.resolveTargetPath) {
        const targetPath = input.resolveTargetPath(catSingular, qr.effectiveId, config.cwd, entry.absolutePath);
        if (targetPath) {
          // P17 目录结构真实性：skill source 是目录，应比较代表文件 SKILL.md（对目录 readFile 会让
          // classifier 误判为 hash_conflict）。file-shaped source 则直接比较。
          const skillRep = `${entry.absolutePath}/SKILL.md`;
          const compareSource =
            catSingular === "skill" && fsOps.exists(skillRep) ? skillRep : entry.absolutePath;
          entry.classification = classifyResourceProjection(
            compareSource,
            targetPath,
            catSingular,
            entry.mergeStrategy,
            fsOps,
            input.lastHashLookup,
          );
          if (entry.classification === "hash_conflict") {
            entry.conflictDetail = {
              reason: `${catSingular} "${qr.effectiveId}" 已存在于 target，且内容不同`,
            };
          } else if (entry.classification === "operator_conflict") {
            // P20——target 同时偏离上次投影和新 source → 操作员编辑。保护它（冲突，而非覆盖）。
            entry.conflictDetail = {
              reason: `${catSingular} "${qr.effectiveId}" 在 zrig 上次投影后被修改（操作员编辑？）——不会覆盖；请将其移开或合并进 spec，然后重新投影`,
            };
          }
        }
      }
      // 缺少 resolveTargetPath 时，分类保持 safe_projection（推迟到 adapter）。

      entries.push(entry);
    }
  }

  // 确定性排序：先按 category，再按 effectiveId。
  entries.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    return catCmp !== 0 ? catCmp : a.effectiveId.localeCompare(b.effectiveId);
  });

  // P20——operator_conflict 受保护（真实冲突）；stale_overwrite 安全（静默进入 applied，因为只是刷新
  // 我们自己的旧输出）。
  const conflicts = entries.filter(
    (e) => e.classification === "hash_conflict" || e.classification === "operator_conflict",
  );
  const noOps = entries.filter((e) => e.classification === "no_op");

  return {
    ok: true,
    plan: {
      runtime: config.runtime,
      cwd: config.cwd,
      entries,
      startup: config.startup,
      conflicts,
      noOps,
      diagnostics,
    },
  };
}

// ——歧义守卫——

function checkAmbiguity(selected: ResolvedResources, collisions: ResourceCollision[]): string[] {
  const errors: string[] = [];

  // 分别检查每个类别——冲突以 category 为范围。
  const categoryEntries: Array<{ category: string; resources: QualifiedResource[] }> = [
    { category: "skills", resources: selected.skills },
    { category: "guidance", resources: selected.guidance },
    { category: "subagents", resources: selected.subagents },
    { category: "plugins", resources: selected.plugins },
    { category: "runtimeResources", resources: selected.runtimeResources },
  ];

  for (const { category, resources } of categoryEntries) {
    for (const qr of resources) {
      // 只检查不带限定符的 id（无冒号）。
      if (qr.effectiveId.includes(":")) continue;

      // 在同一类别中查找匹配冲突。
      const collision = collisions.find((c) => c.category === category && c.resourceId === qr.effectiveId);
      if (!collision || collision.sources.length < 2) continue;

      // 检查 base 是否拥有不带限定符的 id。
      const baseOwner = collision.sources.find((s) => s.qualifiedId === collision.resourceId);
      if (baseOwner) continue; // base 拥有它，因此没有歧义。

      // 无 base owner——import/import 歧义。
      errors.push(
        `所选资源中的 "${qr.effectiveId}" 存在歧义：由 ${collision.sources.map((s) => s.specName).join(", ")} 声明。请使用类似 "${collision.sources[0]!.qualifiedId}" 的限定 id`
      );
    }
  }

  return errors;
}

// 提供 resolveTargetPath 时，分类由 conflict-detector.ts 的 classifyResourceProjection 处理；
// 否则 entry 默认为 safe_projection。

/**
 * 将 plugin source.path 解析为具体绝对路径。支持三种形式：
 *   - 绝对路径（`/abs/...`）        → 精确保留
 *   - home 波浪号（`~/...` 或 `~`） → 展开为 os.homedir()
 *   - 相对路径（`plugins/...`）      → 基于 specSourcePath 解析
 * 不展开带显式用户名的 `~user/...`；按 Node 的 nodePath 约定视为字面相对 segment。
 */
function resolvePluginPath(rawPath: string, specSourcePath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/")) return nodePath.join(os.homedir(), rawPath.slice(2));
  if (nodePath.isAbsolute(rawPath)) return rawPath;
  return nodePath.resolve(specSourcePath, rawPath);
}

// ── P17（发现 A2）：生产 conflict-target resolver + 显著展示 ──

/** 将 projection entry 映射到 claude adapter 将写入的具体文件，用于 hash 冲突检测。与
 * claude-code-adapter.resolveTargetDir 对应：写入方式为 merge 或整个目录的类别返回 null，其分类
 * 与此前一样推迟到 adapter。 */
export function claudeConflictTargetPath(
  category: string,
  effectiveId: string,
  cwd: string,
  sourcePath?: string,
  managedBlockFile: ClaudeManagedBlockFile = DEFAULT_CLAUDE_MANAGED_BLOCK_FILE,
): string | null {
  switch (category) {
    case "skill":
      return nodePath.join(cwd, ".claude", "skills", effectiveId, "SKILL.md");
    case "subagent":
      return sourcePath ? nodePath.join(cwd, ".claude", "agents", nodePath.basename(sourcePath)) : null;
    case "guidance":
      return nodePath.join(cwd, managedBlockFile);
    default:
      return null; // plugin / runtime_resource：merge 或 dir-shaped——推迟处理。
  }
}

/** 将计划冲突渲染为显著的 instantiate 警告，直白说明文件、原因和后果。恢复 4.8 restack 丢失的
 * warnings-site 串接——偏离的 target 不再被静默覆盖（会在明确警告下覆盖；基于 manifest 区分
 * operator 与 stale 是已规划的后续项）。 */
export function projectionConflictWarnings(plan: Pick<ProjectionPlan, "conflicts">): string[] {
  return plan.conflicts.map((c) => {
    const reason = c.conflictDetail?.reason ?? `${c.category} "${c.effectiveId}" 与投影 source 不一致`;
    if (c.classification === "operator_conflict") {
      // P20 保护：manifest 表明 target 同时偏离上次写入和 source，即操作员编辑过它。
      // filterProtectedProjections 会阻止该文件投递，因此“不会覆盖”确实成立，而不只是一条警告。
      return `投影冲突：${reason}——已保护：不会覆盖 target；如需覆盖，请使用 --force 重新运行投影，或将操作员编辑合并进 spec source`;
    }
    // hash_conflict——P17 fallback：target 尚无 projection manifest，无法区分操作员编辑与陈旧投影。
    // 在警告下覆盖（缓和的过渡行为）：本次写入记录 manifest，之后的偏离会分类为
    // operator_conflict 并可受保护。
    return `投影冲突：${reason}——此 target 尚无 projection manifest，无法区分操作员编辑与陈旧投影；重新投影会覆盖 target（本次写入会记录 manifest，使未来编辑可受保护）。若这是操作员编辑，请将其移开或合并进 spec source`;
  });
}

/** P20 atom-4——保护。operator_conflict 表示 target 同时偏离上次记录的写入与当前 source，即操作员
 * 编辑过投影文件。阻止这些文件进入投递，使 adapter 永不覆盖编辑，除非操作员显式强制重新投影。
 * hash_conflict（尚无 manifest）不受保护：继续采用 P17 的“警告后覆盖”fallback，因为没有记录的
 * 上次 hash 就无法区分 operator 与 stale。返回待投递文件和被阻止文件（用于报告）。 */
export function filterProtectedProjections(
  files: ResolvedStartupFile[],
  plan: Pick<ProjectionPlan, "conflicts">,
  opts?: { force?: boolean },
): { delivered: ResolvedStartupFile[]; protected: ResolvedStartupFile[] } {
  if (opts?.force) return { delivered: [...files], protected: [] };
  const protectedRoots = new Set(
    plan.conflicts
      .filter((c) => c.classification === "operator_conflict")
      .map((c) => c.absolutePath),
  );
  if (protectedRoots.size === 0) return { delivered: [...files], protected: [] };
  const delivered: ResolvedStartupFile[] = [];
  const held: ResolvedStartupFile[] = [];
  for (const f of files) {
    // skill target 位于 <entry.absolutePath>/SKILL.md；file-shaped target 直接匹配 entry path。
    // 同时匹配两种结构，使被阻止 skill 的 SKILL.md 能由其父目录 entry 捕获。
    const matches = protectedRoots.has(f.absolutePath) || protectedRoots.has(nodePath.dirname(f.absolutePath));
    (matches ? held : delivered).push(f);
  }
  return { delivered, protected: held };
}
