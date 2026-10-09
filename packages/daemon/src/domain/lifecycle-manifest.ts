import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";

type Mapping = Record<string, unknown>;

export interface LifecycleMissionMember {
  ref: string;
  normalizedRef: string;
  order: number;
  active: boolean;
  path: string;
}

export class LifecycleManifestValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LifecycleManifestValidationError";
  }
}

/**
 * mission composition membership 的唯一严格 reader。读取 surface 和 scope 修改计划共用此精确
 * parser，因此 manifest 不会在一条路径中可执行、在另一条路径中格式错误。
 */
export function validateMissionComposition(
  mission: unknown,
  missionPath: string,
): LifecycleMissionMember[] {
  if (!isMapping(mission) || mission.kind !== "mission") {
    throw issue("lifecycle_manifest_kind_mismatch", `${missionPath}：预期 kind 为 mission`, { missionPath, actual: isMapping(mission) ? mission.kind : null });
  }
  if (!isMapping(mission.composition) || !Array.isArray(mission.composition.slices)) {
    throw issue("lifecycle_membership_missing", `${missionPath}：composition.slices 必须是列表`, { missionPath });
  }
  const missionDir = resolve(missionPath, "..");
  const missionReal = realpathSync(missionDir);
  const refs = new Set<string>();
  const orders = new Set<number>();
  let priorOrder = Number.NEGATIVE_INFINITY;
  return mission.composition.slices.map((raw, index) => {
    if (!isMapping(raw)) {
      throw issue("lifecycle_membership_invalid", `${missionPath}：composition.slices[${index}] 必须是 mapping`, { missionPath, index });
    }
    if (typeof raw.ref !== "string" || raw.ref.length === 0) {
      throw issue("lifecycle_field_missing", `${missionPath}：composition.slices[${index}].ref 必须是非空字符串`, { missionPath, index });
    }
    const normalizedRef = normalize(raw.ref);
    if (isAbsolute(raw.ref) || normalizedRef.split(sep).includes("..")) {
      throw issue("lifecycle_path_escape", `${missionPath}：composition.slices[${index}].ref 必须是不含 '..' 的安全相对路径`, { missionPath, index, ref: raw.ref });
    }
    if (refs.has(normalizedRef)) {
      throw issue("lifecycle_membership_duplicate", `${missionPath}：slice ref ${raw.ref} 重复`, { missionPath, ref: raw.ref });
    }
    if (typeof raw.order !== "number" || !Number.isInteger(raw.order)) {
      throw issue("lifecycle_order_invalid", `${missionPath}：${raw.ref} 需要整数 order`, { missionPath, ref: raw.ref, value: raw.order });
    }
    if (orders.has(raw.order) || raw.order <= priorOrder) {
      throw issue("lifecycle_order_invalid", `${missionPath}：slice order 必须唯一且严格递增；${raw.ref} 在 ${priorOrder} 后为 ${raw.order}`, { missionPath, ref: raw.ref, order: raw.order, priorOrder });
    }
    const target = resolve(missionDir, normalizedRef);
    if (!existsSync(target)) {
      throw issue("lifecycle_member_missing", `${missionPath}：${raw.ref} 在 ${target} 不存在`, { missionPath, ref: raw.ref, target });
    }
    if (lstatSync(target).isSymbolicLink()) {
      throw issue("lifecycle_member_symlink", `${missionPath}：${raw.ref} 不能是 symlink`, { missionPath, ref: raw.ref, target });
    }
    const targetReal = realpathSync(target);
    if (targetReal !== missionReal && !targetReal.startsWith(`${missionReal}${sep}`)) {
      throw issue("lifecycle_path_escape", `${missionPath}：${raw.ref} 逃逸 mission 根目录`, { missionPath, ref: raw.ref, target: targetReal });
    }
    refs.add(normalizedRef);
    orders.add(raw.order);
    priorOrder = raw.order;
    return { ref: raw.ref, normalizedRef, order: raw.order, active: raw.active !== false, path: targetReal };
  });
}

function isMapping(value: unknown): value is Mapping {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function issue(code: string, message: string, details?: Record<string, unknown>): LifecycleManifestValidationError {
  return new LifecycleManifestValidationError(code, message, details);
}
