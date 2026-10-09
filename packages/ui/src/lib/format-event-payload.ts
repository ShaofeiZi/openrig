// V1 attempt-3 Phase 3 反弹修复 —— A3 修复。
//
// 面向活动 feed 事件负载的更聪明的格式化器。早期 Phase 3 的 LogPanel 与
// RecentActivity 只看 `payload.summary`，对不带该字段的事件一律渲染 "—"——
// 而大多数事件并不带这个字段。
//
// 策略：
//   1. 先尝试常见的 message 风格键（summary、body、detail、message、title）。
//   2. 从最多 4 个顶层负载键构建紧凑的 key=value 预览
//      （跳过时间戳、ULID 这类噪声键）。
//   3. 最终兜底：JSON.stringify(payload).slice(0, 200)。

// 候选 message 键名，均为协议字段，保持原值。
const MESSAGE_KEYS = ["summary", "body", "detail", "message", "title", "text", "description"] as const;

// 紧凑预览中要跳过的噪声键（时间戳、排序键等机器字段）。
const NOISE_KEYS = new Set([
  "ts",
  "ts_created",
  "ts_updated",
  "ts_emitted",
  "created_at",
  "updated_at",
  "received_at",
  "stream_sort_key",
  "audit_pointer",
]);

function shorten(s: string, max = 40): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function valuePreview(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? shorten(trimmed) : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null; // 紧凑预览中跳过嵌套对象/数组
}

export function formatEventPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "—";
  const obj = payload as Record<string, unknown>;

  // 第一遍：显式的 message 键。
  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return shorten(v.trim(), 200);
    }
  }

  // 第二遍：顶层标量字段的紧凑 key=value 预览。
  const previewParts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (NOISE_KEYS.has(k)) continue;
    const preview = valuePreview(v);
    if (preview === null) continue;
    previewParts.push(`${k}=${preview}`);
    if (previewParts.length >= 4) break;
  }
  if (previewParts.length > 0) return previewParts.join(" · ");

  // 第三遍：JSON 兜底（截断）。
  try {
    const json = JSON.stringify(obj);
    return shorten(json, 200);
  } catch {
    return "—";
  }
}
