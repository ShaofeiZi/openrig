// omitted-records.ts —— 把一条解析后的源记录归类为 4 种省略类别枚举之一
// （按 M1 契约 § 5），或接受它为一条保留的、用户可见的消息。
//
// v0 生成器从 transcript-latest.md 与 transcript.md 中排除以下记录类别：
//
// - reasoning_records：运行时发出的内部推理记录，并非用户可见消息。
// - raw_tool_outputs：工具执行的完整原始输出（通常冗长；可能含瞬时状态）。
// - function_call_output：函数调用结果记录，非用户可见。
// - redacted_secrets：按脱敏策略命中任一凭证模式时归入此类。
//   （本类统计“内容命中密钥模式、因而被脱敏”的记录数。）
//
// summary 里的 `omitted_classes` 枚举出【本 packet 实际排除】的类别
//（不是全部可用类别）；校验器会检查每个名字是否属于 4 个枚举值之一。

import { emptyOmittedCounts, type OmittedCounts, type OmittedRecordClass } from "./types.js";
import { hasSecretPattern } from "./redaction.js";

/** 与源运行时无关的记录分类器输出。 */
export type ClassifyResult =
  | { kind: "kept" }
  | { kind: "omitted"; reason: OmittedRecordClass };

/**
 * 把一条 Codex JSONL 记录（已解析的 JSON 对象）分类为保留 / 省略。
 * 调用方负责只传入 `response_item` 类记录；session_meta 与 compacted 由
 * Codex 解析器单独处理。
 *
 * Codex 语义（参照 Velocity 既有实现）：
 * - response_item 且 payload.type === "function_call" → function_call_output
 * - response_item 且 payload.type === "custom_tool_call" → raw_tool_outputs
 * - response_item 且 payload.type === "reasoning" → reasoning_records
 * - response_item 且 payload.type === "message" 且 role ∈ {developer,user,assistant}
 *   → 保留（经过密钥模式检查后）
 * - 其余 → reasoning_records（非 message 非 tool 负载类型的兜底）
 */
export function classifyCodexRecord(record: { payload?: { type?: unknown; role?: unknown } }): ClassifyResult {
  const payloadType = typeof record.payload?.type === "string" ? record.payload.type : "";
  switch (payloadType) {
    case "function_call":
      return { kind: "omitted", reason: "function_call_output" };
    case "custom_tool_call":
      return { kind: "omitted", reason: "raw_tool_outputs" };
    case "reasoning":
      return { kind: "omitted", reason: "reasoning_records" };
    case "message": {
      const role = typeof record.payload?.role === "string" ? record.payload.role : "";
      if (role !== "developer" && role !== "user" && role !== "assistant") {
        return { kind: "omitted", reason: "reasoning_records" };
      }
      return { kind: "kept" };
    }
    default:
      return { kind: "omitted", reason: "reasoning_records" };
  }
}

/**
 * 分类一条 Claude 转录记录。Claude 形态把 role 直接放在 `record.type`
 * （user / assistant / system / attachment / summary 等）。按 M2b 分发
 * “输出与 Codex 解析器相同的结构化表示”的要求，省略类别映射与 Codex 对齐。
 */
export function classifyClaudeRecord(record: { type?: unknown }): ClassifyResult {
  const type = typeof record.type === "string" ? record.type : "";
  switch (type) {
    case "user":
    case "assistant":
      return { kind: "kept" };
    case "attachment":
      // 附件是工具结果类记录（用户附加的文件内容或工具输出）。映射为 raw_tool_outputs。
      return { kind: "omitted", reason: "raw_tool_outputs" };
    case "summary":
      // system/summary 记录是用户不可见的元信息；映射为 reasoning_records。
      return { kind: "omitted", reason: "reasoning_records" };
    default:
      // 其余（仅 sessionId、agentInfo、permissionMode 等元信息）都是元数据，
      // 不是用户可见消息。
      return { kind: "omitted", reason: "reasoning_records" };
  }
}

/** 解析过程中累计省略类别计数的状态容器。 */
export class OmittedCounter {
  readonly counts: OmittedCounts = emptyOmittedCounts();

  recordOmission(reason: OmittedRecordClass): void {
    this.counts[reason] += 1;
  }

  /**
   * 标记一条保留消息含密钥内容（已被脱敏）。每发生一次就递增
   * `redacted_secrets`。调用方在脱敏【之前】检查 `hasSecretPattern`，
   * 以决定是否记录此项。
   */
  recordRedaction(): void {
    this.counts.redacted_secrets += 1;
  }

  /**
   * 返回至少有一条记录的省略类别列表。按契约 § 5 用于填充
   * `summary.omitted_classes`。顺序稳定（类型定义里的枚举顺序）。
   */
  activeClasses(): OmittedRecordClass[] {
    const order: OmittedRecordClass[] = [
      "reasoning_records",
      "raw_tool_outputs",
      "function_call_output",
      "redacted_secrets",
    ];
    return order.filter((cls) => this.counts[cls] > 0);
  }
}

/** 便于复用的再导出。 */
export { hasSecretPattern };
