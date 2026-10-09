// types.ts — restore-packet 生成器的共享 TypeScript 类型。
//
// 两个运行时适配器（codex-jsonl-parser、claude-transcript-parser）
// 都输出相同的 StructuredTranscript 形状。下游模块
// （redaction、omitted-records、packet-writer）消费此形状，
// 不关心源运行时。

/** 从转录中提取的单条用户可见消息。 */
export interface ExtractedMessage {
  /** ISO-8601 时间戳（如果源提供）；否则为 null。 */
  timestamp: string | null;
  /** 发言者角色。限于用户可见角色（developer/user/assistant）。 */
  role: "developer" | "user" | "assistant";
  /** 已脱敏的消息文本。 */
  text: string;
  /** 文本的第一行非空行，截断到约 180 字符。用于摘要。 */
  preview: string;
}

/** M1 契约 § 5 的规范记录类枚举。 */
export type OmittedRecordClass =
  | "reasoning_records"
  | "raw_tool_outputs"
  | "function_call_output"
  | "redacted_secrets";

/**
 * 路径提取的路径频率条目。按计数降序、路径升序排列；
 * 用于填充 `touched_files.top_paths`。
 */
export interface PathCount {
  path: string;
  count: number;
}

/**
 * 每个运行时、每种记录类型的计数器。灵活的字符串键，因为
 * Codex JSONL 使用 `record.type` 字符串，Claude 转录也使用
 * `record.type` 字符串；两者都是运行时定义的。
 */
export type TypeCounts = Record<string, number>;

/**
 * 每个省略类的计数器。记录在解析/脱敏期间，
 * 4 个契约枚举各过滤了多少条记录。
 */
export type OmittedCounts = Record<OmittedRecordClass, number>;

/**
 * 从源中提取的可选会话元数据。Codex 在 JSONL 顶部发出
 * `session_meta` 记录；Claude 转录携带每条记录的 `cwd` 等。
 */
export interface SessionMeta {
  cwd: string | null;
  sessionId: string | null;
  /** 运行时发出的自由格式附加字段；不承重。 */
  raw?: Record<string, unknown>;
}

/**
 * 两个解析器产生的结构化表示。packet-writer（M2c）
 * 消费此结构来组装 v0 恢复包。
 */
export interface StructuredTranscript {
  /** 顶层会话元数据（cwd、sessionId）。 */
  sessionMeta: SessionMeta | null;
  /** 处理的源总行数（原始 JSONL 行数，包括格式错误/跳过的行）。 */
  lineCount: number;
  /** 提取到 `messages` 中的用户可见消息数。 */
  messageCount: number;
  /**
   * 看到的"压缩"记录数。Codex 显式发出这些
   * （`type: "compacted"`）；Claude 不发。此字段是解析器特定的，
   * 但始终存在（不适用时为零）。
   */
  compactedCount: number;
  /** 按记录类型的频率映射；用于人工报告/调试。 */
  typeCounts: TypeCounts;
  /** 按省略类的计数器；在解析器过滤记录时填充。 */
  omittedCounts: OmittedCounts;
  /** 按时间顺序排列的提取消息；已应用脱敏。 */
  messages: ExtractedMessage[];
  /**
   * 路径频率清单；按计数降序、路径升序排列。
   * 上限 200 条。
   */
  paths: PathCount[];
}

/** 源运行时类型。v0 支持 codex + claude-code 转录形状。 */
export type SourceRuntime = "codex" | "claude-code";

export function emptyOmittedCounts(): OmittedCounts {
  return {
    reasoning_records: 0,
    raw_tool_outputs: 0,
    function_call_output: 0,
    redacted_secrets: 0,
  };
}
