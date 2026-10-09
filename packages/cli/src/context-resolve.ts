// Slice-03 Atom 6b —— 交付标志位共用的上下文引用解析器。
// `--context`（rig send / rig broadcast）与 `--body-context`（rig queue create）
// 都把一个类路径引用解析为其【完整】纯文本内容（compose 的输出），
// 并强制采用与 `rig walk` 相同的“全有或全无”缺失成员约定：
// 缺失/不可读的 pack 成员会被提前发现，从而在【任何交付之前】中止——
// 绝不出现部分/静默的上下文。复用 6a 的 pieces 路由
// （现在还会通过密封的 assemblePlainFiles 返回 `text`/`bytes`）。

import type { DaemonClient } from "./client.js";

interface RefPiecesWire {
  ref: string;
  text?: string;
  bytes?: number;
  missingFiles?: Array<{ path: string; role?: string }>;
  error?: string;
  message?: string;
}

export interface ResolvedContext {
  ref: string;
  text: string;
  bytes: number;
}

/** 建议性尺寸阈值：超过该尺寸的已解析上下文视为“walk 量级”——
 *  更适合用 `rig walk` 按节奏喂入，而不是一次性粘贴进窗格（§4）。 */
export const WALK_SIZED_THRESHOLD_BYTES = 8_192;

export async function resolveContextRef(client: DaemonClient, ref: string): Promise<ResolvedContext> {
  const res = await client.get<RefPiecesWire>(
    `/api/context-packs/library/by-ref/pieces?ref=${encodeURIComponent(ref)}`,
  );
  if (res.status === 404) {
    throw new Error(`在上下文库中未找到上下文 pack '${ref}'。请运行 'zrig context list' 查看可用引用。`);
  }
  if (res.status === 400) {
    throw new Error(res.data?.message ?? `不安全的上下文引用 '${ref}'。`);
  }
  if (res.status !== 200) {
    throw new Error(`解析上下文引用 '${ref}' 时后台服务返回 HTTP ${res.status}。`);
  }
  // 全有或全无：缺失/不可读的成员在任何交付之前中止。
  const missing = res.data.missingFiles ?? [];
  if (missing.length > 0) {
    throw new Error(
      `上下文 pack '${ref}' 有 ${missing.length} 个缺失/不可读成员：${missing.map((m) => m.path).join(", ")}。` +
        `请修复该 pack（或其文件）后重试——交付要么携带完整上下文，要么不带。`,
    );
  }
  const text = res.data.text ?? "";
  const bytes = typeof res.data.bytes === "number" ? res.data.bytes : Buffer.byteLength(text, "utf8");
  return { ref, text, bytes };
}

/** §4 尺寸提醒：当解析出的 --context 达到 walk 量级时，建议用 `rig walk`
 *  按节奏喂入，而不是一次性粘贴。这是建议性提醒——绝不阻断发送。 */
export function walkSizedWarning(resolved: ResolvedContext, seat?: string): string | null {
  if (resolved.bytes <= WALK_SIZED_THRESHOLD_BYTES) return null;
  const target = seat ?? "<seat>";
  return `上下文 '${resolved.ref}' 共 ${resolved.bytes} 字节——已达 walk 量级。建议改用 'zrig walk ${target} --through ${resolved.ref}' 按节奏喂入，而非一次性粘贴。`;
}
