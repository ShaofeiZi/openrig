// redaction.ts — 应用 v0 脱敏策略。
//
// 根据 M1 契约 § 4：v0 定义了两个命名策略：
// - `velocity-v1`：镜像 Velocity 生成器的 token 模式，位于
//   field-notes/2026-04-27-velocity-claude-from-codex-restore/tools/
//   codex-jsonl-to-restore-packet.mjs:34-48（sk-*、gh[pousr]_*、
//   github_pat_*、Bearer *、≥40 字符的 base64）。
// - `openrig-v0`：产品化的 v0 策略，模式与 `velocity-v1` 完全相同，
//   但使用规范名称。v0 生成器输出 `redaction_policy_id: "openrig-v0"`。
//
// 脱敏应用于：
// - transcript-latest.md 和 transcript.md 中的转录内容。
// - restore-instructions.md 中引用转录材料的正文内容。
// - top_paths / touched-files 条目不脱敏（路径不是凭据材料）。
//
// 验证器不扫描内容中残留的凭据模式
// （根据 § 4 + § 8：强制执行在写入时由生成器端完成）。

/**
 * v0 密钥模式列表。完全镜像 Velocity 先例 `:34-48`：
 *
 * 1. /\bsk-[A-Za-z0-9_-]{16,}\b/g — OpenAI 风格的密钥 token。
 * 2. /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g — GitHub 个人/OAuth token。
 * 3. /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g — GitHub 细粒度 PAT。
 * 4. /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g — 通用 Bearer token。
 * 5. /\b[A-Za-z0-9+/]{40,}={0,2}\b/g — ≥40 字符的 base64 形状字符串。
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/**
 * 对字符串应用 openrig-v0 脱敏策略。返回输入中每个匹配密钥模式的位置
 * 替换为字面量 `[REDACTED]`。纯函数；无副作用。
 *
 * 脱敏在结构层面是非破坏性的——只替换匹配的子串。
 * 周围字符保持不变。
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * 如果至少一个密钥模式匹配输入则返回 true。
 * 被省略记录计数器使用，以追踪有多少记录的内容被脱敏
 * （用于摘要中 `redacted_secrets` 省略类计数）。
 *
 * 注意：单条记录可能匹配多个模式；为效率起见在首次匹配后即返回 true。
 */
export function hasSecretPattern(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    // 非全局测试：不能复用全局 `g` 正则而不重置 lastIndex，
    // 因此从 source 构建一个新的非全局 RegExp。
    const probe = new RegExp(pattern.source);
    if (probe.test(text)) return true;
  }
  return false;
}
