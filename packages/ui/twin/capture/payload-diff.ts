// OPR.0.4.1.11.2（FR-4）——数据介质截图：确定性的 before/after 产物。
// 对非视觉/数据形状类 slice，带宽最高的 intent+proof 产物就是数据本身：
// 规范 before + 规范 after + 变更路径集合。纯且确定性（键排序、变更路径排序），
// 使产物可复现、可并排评审，是 intent.png 的数据介质对等物。

/** 递归排序对象键，使 JSON 序列化与插入顺序无关。 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 稳定的缩进 JSON，键递归排序。确定性。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2);
}

/**
 * 两份负载的深度 diff → 排序后的叶子路径条目：`added (+)`、`removed (-)`、`changed (~)`。
 * 数组与标量作为叶子比较（按规范 JSON）；纯对象递归。
 */
export function diffPaths(before: unknown, after: unknown, prefix = ""): string[] {
  const results: string[] = [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const p = prefix ? `${prefix}.${key}` : key;
      const inB = key in before;
      const inA = key in after;
      if (inB && !inA) results.push(`removed (-): ${p}`);
      else if (!inB && inA) results.push(`added (+): ${p}`);
      else results.push(...diffPaths(before[key], after[key], p));
    }
  } else if (canonicalJson(before) !== canonicalJson(after)) {
    results.push(`changed (~): ${prefix}`);
  }
  return results.sort();
}

/** 组装持久的数据介质产物：规范 before/after + 变更路径摘要。 */
export function buildPayloadDiff(input: { before: unknown; after: unknown }): string {
  const changed = diffPaths(input.before, input.after);
  return [
    "# 之前",
    canonicalJson(input.before),
    "",
    "# 之后",
    canonicalJson(input.after),
    "",
    "# 变更",
    changed.length ? changed.join("\n") : "（无变更）",
    "",
  ].join("\n");
}
