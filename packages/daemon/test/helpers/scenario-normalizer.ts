/**
 * Slice 51-03——声明式跨 surface 归一化器（`equals` mapping）。
 *
 * A-N1 固定了其结构：声明式 mapping 是面向 scenario 的唯一形式，它会降低到 runner 内部接缝
 *（`normalizer?: (surface, value) => unknown`），而不是取代该接缝。因此此模块完全是增量式的——
 * 它从 YAML 构建该回调；接缝签名不变，runner 的 equals 分支也不变。
 *
 * 它解决的问题：已发布 surface 的响应结构不同，因此原始比较总是不相等。`rig ps --json` 是 rig
 * 记录数组；`rig queue list --json` 是 qitem 数组，其 destinationSession 为
 * `<pod>-<member>@<rig>`。比较二者需要声明每边哪个字段承载共享事实——此声明就是 normalizer。
 *
 *   equals:
 *     ps:    { pluck: name }                          # -> ["scn-baton"]
 *     queue: { pluck: destinationSession, rig: true } # -> ["scn-baton"]
 *
 * 投影刻意保持小而完备：从数组 surface 的每个元素提取字段，可选地把 session 名缩减为 rig，随后
 * 去重并排序，使比较不受顺序影响（两个 surface 对同一集合达成一致时，不应因枚举顺序不同而失败）。
 */

import type { ExpectSurface } from "./scenario-schema.js";

/**
 * 当声明的投影从非空 surface 中未提取任何内容时抛出。
 *
 * a7b6b7c85 的守卫发现：两个 surface 都提取自身不存在的字段时会归一化为 []，`[] === []` 让空洞
 * 比较变成 GREEN。播种真实 qitem 无法防止此问题，因为清空集合的是投影。空输入得到空结果合法
 *（surface 确实可能没有内容）；非空输入得到空结果表示声明与 surface 不匹配，必须明确失败，不能
 * 成为相等证据。
 */
export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

/** 单个 surface 到共享比较形式的声明式投影。 */
export interface SurfaceProjection {
  /** 从数组 surface 每个元素中提取的字段（如 `name`）。 */
  pluck?: string;
  /** 将 canonical session 名（`<pod>-<member>@<rig>`）缩减为 rig 部分。 */
  rig?: boolean;
  /** 投影前从对象 surface 读取嵌套字段（点路径）。 */
  path?: string;
}

/** 声明式 `equals` mapping：surface -> projection。 */
export type EqualsMapping = Partial<Record<ExpectSurface, SurfaceProjection>>;

/** `equals` payload 为声明式 mapping 形式（而非旧 list）时返回 true。 */
export function isEqualsMapping(payload: unknown): payload is EqualsMapping {
  return !!payload && typeof payload === "object" && !Array.isArray(payload);
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

/** `dev-worker@scn-baton` -> `scn-baton`；没有 `@` 时保持不变。 */
export function rigOf(session: string): string {
  const at = session.lastIndexOf("@");
  return at < 0 ? session : session.slice(at + 1);
}

/** 应用单个 surface 的声明式投影。该函数完备：遇到非预期结构也不会抛出。 */
export function projectSurface(
  value: unknown,
  spec: SurfaceProjection,
  surface = "surface",
): unknown {
  const base = spec.path ? readPath(value, spec.path) : value;
  if (!spec.pluck) return base;
  const items = Array.isArray(base) ? base : [base];
  const nonEmptyInput = items.some((i) => i !== undefined && i !== null);
  const plucked = items
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[spec.pluck!] : undefined))
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => (spec.rig ? rigOf(v) : v));
  // 对含数据 surface 一无所获的声明是损坏的声明，不是达成一致的证据。必须明确失败，此处绝不返回 []。
  if (plucked.length === 0 && nonEmptyInput) {
    throw new ProjectionError(
      `${surface}：投影 { pluck: "${spec.pluck}"${spec.path ? `, path: "${spec.path}"` : ""} } ` +
        `未从非空 surface（${items.length} 项）提取任何内容。真实数据产生的空投影不能作为相等证据——` +
        `两个 surface 都一无所获时比较结果相等，却什么也证明不了。请对照 surface 的实际结构检查声明字段。`,
    );
  }
  // 集合语义：去重并排序，因此对集合的一致不会因顺序或某一 surface 重复列出同一 rig
  //（N 个 qitem、一个 rig）而失败。
  return [...new Set(plucked)].sort();
}

/**
 * 将声明式 mapping 降低到 runner 内部接缝（A-N1）。mapping 未提及的 surface 原样传递，因此
 * 部分声明的比较仍有可预测行为，而不会被静默清空。
 */
export function buildDeclarativeNormalizer(
  mapping: EqualsMapping,
): (surface: ExpectSurface, value: unknown) => unknown {
  return (surface, value) => {
    const spec = mapping[surface];
    return spec ? projectSurface(value, spec, surface) : value;
  };
}
