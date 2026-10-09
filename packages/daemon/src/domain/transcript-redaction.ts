// transcript-redaction.ts——v0 脱敏策略的后台服务侧镜像。
//
// 镜像 packages/cli/src/restore-packet/redaction.ts 的 SECRET_PATTERNS
//（M1 contract §4 / openrig-v0 policy）。这里复制 pattern 而不是导入，因为 @openrig/cli 不是后台服务
// 依赖，新增依赖会反转 package graph。M2c-Daemon 范围内，此列表必须与 CLI 列表逐字节等价。
// 未来 slice 可以抽取共享 @openrig/redaction package；在此之前，两个数组间的任何漂移都是缺陷，
// reviewer 应在每次修改时对比它们。

/** v0 secret pattern 列表；镜像 packages/cli/src/restore-packet/redaction.ts:31-37。 */
export const TRANSCRIPT_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/**
 * 对 transcript 内容应用 openrig-v0 脱敏策略。返回输入文本，并把每个 secret pattern 匹配项
 * 替换为字面量 `[REDACTED]`。这是无副作用的纯函数。
 *
 * GET /api/transcripts/:session/full 在序列化前使用它脱敏 wire payload，因此即使 transcript
 * 文件中包含 credential pattern，也绝不会进入 response body。
 */
export function redactTranscriptContent(text: string): string {
  let out = text;
  for (const pattern of TRANSCRIPT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
