import { createHash } from "node:crypto";
import type { ProjectionClassification } from "./projection-planner.js";
import type { FsOps } from "./package-resolver.js";
import type { InstallPlan, InstallPlanEntry, ConflictInfo } from "./install-planner.js";

export interface RefinedInstallPlan extends InstallPlan {
  noOps: InstallPlanEntry[];
}

export interface GuidanceConflictMeta {
  hasExistingBlock: boolean;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MANAGED_BLOCK_START = (packageName: string) =>
  `<!-- BEGIN OpenRig MANAGED BLOCK: ${packageName} -->`;
const MANAGED_BLOCK_END = (packageName: string) =>
  `<!-- END OpenRig MANAGED BLOCK: ${packageName} -->`;

/**
 * 用内容感知冲突检测细化 InstallPlan。
 * - skill/agent：内容相同为 no-op，内容不同为带哈希的冲突
 * - guidance：检测此特定包已有的受管块
 * - 延迟条目（hooks/mcp/requirements）原样透传
 */
export function detectConflicts(
  plan: InstallPlan,
  fs: FsOps,
): RefinedInstallPlan {
  const actionable: InstallPlanEntry[] = [];
  const conflicts: InstallPlanEntry[] = [];
  const deferred: InstallPlanEntry[] = [];
  const noOps: InstallPlanEntry[] = [];
  const allEntries: InstallPlanEntry[] = [];

  for (const entry of plan.entries) {
    // 延迟条目原样透传。
    if (entry.deferred) {
      deferred.push(entry);
      allEntries.push(entry);
      continue;
    }

    // 没有 sourcePath（例如 requirements 已延迟；此处仍做兜底）。
    if (!entry.sourcePath) {
      actionable.push(entry);
      allEntries.push(entry);
      continue;
    }

    if (entry.exportType === "skill" || entry.exportType === "agent") {
      if (!entry.conflict) {
        // 目标不存在——safe_projection。
        actionable.push(entry);
        allEntries.push(entry);
        continue;
      }

      // 目标存在——比较内容。
      try {
        const sourceContent = fs.readFile(entry.sourcePath);
        const targetContent = fs.readFile(entry.targetPath);
        const sourceHash = hashContent(sourceContent);
        const existingHash = hashContent(targetContent);

        if (sourceHash === existingHash) {
          // 内容相同——no-op。
          noOps.push({ ...entry, conflict: undefined });
          allEntries.push({ ...entry, conflict: undefined });
        } else {
          // 内容不同——补充冲突信息。
          const enriched: InstallPlanEntry = {
            ...entry,
            conflict: {
              existingPath: entry.targetPath,
              existingHash,
              sourceHash,
              reason: `${entry.exportType} '${entry.exportName}' 已存在但内容不同`,
            } as ConflictInfo & { existingHash: string; sourceHash: string },
          };
          conflicts.push(enriched);
          allEntries.push(enriched);
        }
      } catch {
        // 文件不可读——按冲突处理。
        conflicts.push(entry);
        allEntries.push(entry);
      }
    } else if (entry.exportType === "guidance") {
      // 检查已有受管块。
      if (entry.classification === "managed_merge" && fs.exists(entry.targetPath)) {
        const targetContent = fs.readFile(entry.targetPath);
        const beginMarker = MANAGED_BLOCK_START(plan.packageName);
        const endMarker = MANAGED_BLOCK_END(plan.packageName);
        const legacyBegin = `<!-- BEGIN RIGGED MANAGED BLOCK: ${plan.packageName} -->`;
        const legacyEnd = `<!-- END RIGGED MANAGED BLOCK: ${plan.packageName} -->`;
        const hasExistingBlock =
          (targetContent.includes(beginMarker) && targetContent.includes(endMarker)) ||
          (targetContent.includes(legacyBegin) && targetContent.includes(legacyEnd));

        const refined: InstallPlanEntry & { guidanceMeta?: GuidanceConflictMeta } = {
          ...entry,
          guidanceMeta: { hasExistingBlock },
        } as InstallPlanEntry & { guidanceMeta: GuidanceConflictMeta };

        actionable.push(refined);
        allEntries.push(refined);
      } else {
        actionable.push(entry);
        allEntries.push(entry);
      }
    } else {
      actionable.push(entry);
      allEntries.push(entry);
    }
  }

  return {
    ...plan,
    entries: allEntries,
    actionable,
    deferred,
    conflicts,
    noOps,
  };
}

// ——投影专用冲突分类（AgentSpec 重启）——

interface ProjectionFsOps {
  readFile(path: string): string;
  exists(path: string): boolean;
}

/**
 * 使用基于哈希的比较对资源投影分类。返回投影专用分类状态，
 * 而不是旧版 ActionClassification。
 * @param sourcePath - 源资源绝对路径
 * @param targetPath - 目标位置绝对路径
 * @param category - 资源类别
 * @param mergeStrategy - 适用时的 guidance 合并策略
 * @param fsOps - 文件系统操作
 * @returns 投影分类结果
 */
export function classifyResourceProjection(
  sourcePath: string,
  targetPath: string,
  category: string,
  mergeStrategy: string | undefined,
  fsOps: ProjectionFsOps,
  /** P20——projector 上次写入 targetPath 的哈希（manifest），或 null。
   *  此参数可选，使旧版五参数调用方保持 P17 行为（无 manifest → hash_conflict）。
   *  查询采用失败关闭，BROKEN≠ABSENT：返回 null（无条目）→ hash_conflict（P17 回退）；
   *  抛错（读取损坏）→ operator_conflict（保护——读取错误绝不能覆盖可能由操作人员编辑的内容）。 */
  lastHashLookup?: (targetPath: string) => string | null,
): ProjectionClassification {
  // 带 managed_block 的 guidance 始终为 managed_merge。
  if (category === "guidance" && mergeStrategy === "managed_block") {
    return "managed_merge";
  }

  // 目标不存在：安全投影。
  if (!fsOps.exists(targetPath)) {
    return "safe_projection";
  }

  // 目标存在：比较哈希。
  try {
    const sourceContent = fsOps.readFile(sourcePath);
    const targetContent = fsOps.readFile(targetPath);
    const sourceHash = hashContent(sourceContent);
    const targetHash = hashContent(targetContent);

    if (sourceHash === targetHash) {
      return "no_op";
    }

    // P20——target ≠ source。查询 manifest 以区分：
    //  - target == 我们上次写入的内容 → 陈旧投影（source 已前进）→ 可安全覆盖
    //  - target ≠ 我们上次写入的内容（且 ≠ source）→ 操作人员已修改 → 保护
    //  - 读取 manifest 抛错 → 损坏而非缺失 → operator_conflict（保护）
    //  - 无 manifest 条目（null）→ 缺失 → P17 回退（hash_conflict，带警告覆盖）
    let lastHash: string | null = null;
    if (lastHashLookup) {
      try {
        lastHash = lastHashLookup(targetPath);
      } catch {
        // 损坏与缺失不同：抛错的读取属于损坏——无法排除操作人员编辑，而 hash_conflict
        // 会覆盖它。真正的失败关闭应当保护（operator_conflict）；这与返回 null（无条目）
        // 后采用下方良性 P17 hash_conflict 回退不同。
        return "operator_conflict";
      }
    }
    if (lastHash !== null) {
      return targetHash === lastHash ? "stale_overwrite" : "operator_conflict";
    }
    return "hash_conflict";
  } catch {
    return "hash_conflict";
  }
}
