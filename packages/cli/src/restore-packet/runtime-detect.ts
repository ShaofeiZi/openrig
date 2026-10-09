// runtime-detect.ts — 从 JSONL/转录形状自动检测源运行时。
//
// 根据 M1 契约 § 3.4：`--source-jsonl` 的源运行时解析
// 从 JSONL 形状自动检测（Codex JSONL 有 `payload.type` 标记；
// Claude 转录有不同形状）。如果自动检测有歧义，
// 以明确错误失败并提示 `--source-runtime` flag。
//
// 检测基于内容形状，不是文件扩展名或文件名
// （根据调度器的"不要使用文件扩展名或文件名作为检测键。
// 按内容形状检测。"）。
//
// Codex 形状：每行是带 `type` 字段的 JSON；区分标记为
// `type: "session_meta"`、`type: "response_item"` 或
// `type: "compacted"`。response_item 记录携带一个 `payload`
// 对象，内含 `type` 子字段。
//
// Claude 形状：每行是带 `type` 字段的 JSON；值包括
// `user`、`assistant`、`system`、`attachment`、`summary` 等。
// 没有 `payload` 包装；消息内容直接在 `message` 或 `attachment` 下。

import type { SourceRuntime } from "./types.js";

/**
 * 从 JSONL 行样本检测源运行时。
 *
 * 返回：
 * - "codex" — 至少一行有 `type: "response_item"` 或
 *   `type: "session_meta"` 或 `type: "compacted"`。
 * - "claude-code" — 至少一行有 `type: "user"` 或
 *   `type: "assistant"`，且未看到 Codex 标记。
 * - null — 输入为空 / 非 JSONL / 有歧义（例如两种标记类都未出现）。
 *
 * 检测非贪婪：遍历输入行直到找到确定性标记。
 * 如果两种形状类都出现，偏向 Codex 标记
 * （实践中极不可能；将表示格式错误的混合源）。
 */
export function detectRuntime(content: string): SourceRuntime | null {
  if (typeof content !== "string" || content.length === 0) return null;

  let sawCodexMarker = false;
  let sawClaudeMarker = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let record: { type?: unknown; payload?: { type?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      // 跳过格式错误的 JSON 行；它们不影响检测。
      continue;
    }

    const recordType = typeof record.type === "string" ? record.type : "";

    // Codex 区分符：type 值 + payload 包装存在性。
    if (
      recordType === "response_item" ||
      recordType === "session_meta" ||
      recordType === "compacted"
    ) {
      sawCodexMarker = true;
      // 在最强的 Codex 标记上提前返回；如果 Claude 标记也出现，
      // 歧义偏向 Codex 是有意的（Codex 的 response_item 在结构上
      // 不同于任何 Claude 记录；如果它存在，内容就是 Codex JSONL）。
      return "codex";
    }

    // Claude 区分符：顶层 type 作为 user/assistant 标记。
    if (recordType === "user" || recordType === "assistant") {
      sawClaudeMarker = true;
      // 不要仅凭 Claude 提前返回——继续寻找任何 Codex 标记
      // （防御不太可能的混合形状情况）。
    }
  }

  if (sawCodexMarker) return "codex";
  if (sawClaudeMarker) return "claude-code";
  return null;
}
