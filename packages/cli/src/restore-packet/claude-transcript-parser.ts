// claude-transcript-parser.ts —— 把 Claude 转录 JSONL 解析成与 Codex 解析器
// 相同的 StructuredTranscript 形态。
//
// 这是 Restore-Packet 纵切 M2b 的新工作，无既有参考实现。
// 已检视宿主上 ~/.claude/projects/<project>/<id>.jsonl 的 Claude 转录文件。
//
// Claude JSONL 语义（实测）：
// - 开头几行可能携带元记录：{ type, customTitle, sessionId }
//   或 { type, agentName, sessionId } 或 { type, permissionMode, sessionId }。
// - 消息记录 type 为 "user" | "assistant"，字段：
//   { type, message, cwd, timestamp, parentUuid, sessionId, ... }。
//   `message` 是对象，其形态取决于 provider API：
//   - user: { role: "user", content: string | array }
//   - assistant: { role: "assistant", content: { type: "text", text } 的数组 }
// - 附件记录（{ type: "attachment", attachment, ... }）携带工具输入/输出内容，
//   由 omitted-records 分类器映射为 raw_tool_outputs，并从消息流中跳过。
// - 其他类型（{ type: "summary" }、仅含 sessionId 的元记录等）映射为 reasoning_records。

import { redact, hasSecretPattern } from "./redaction.js";
import { classifyClaudeRecord, OmittedCounter } from "./omitted-records.js";
import type {
  ExtractedMessage,
  PathCount,
  StructuredTranscript,
  TypeCounts,
  SessionMeta,
} from "./types.js";

const PATH_PATTERNS: readonly RegExp[] = [
  /\/(?:Users|home)\/[^/\s]+\/[A-Za-z0-9._~:/@%+=,\- ]+/g,
  /\b(?:packages|docs|scripts|test|tests|src|openrig-work|rigs|control-plane)\/[A-Za-z0-9._~:/@%+=,\-]+/g,
];

function extractPaths(text: string, counts: Map<string, number>): void {
  for (const pattern of PATH_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const cleaned = match[0].replace(/[),.;\]"'`]+$/g, "");
      if (cleaned.length < 6) continue;
      counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1);
    }
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim());
  if (!line) return "";
  return line.trim().slice(0, 180);
}

/**
 * 遍历一条 Claude `message.content` 字段的结果。返回：
 * - `text`：由 `{ type: "text" }` 片段拼接出的用户可见文本。
 * - `toolUseCount`：见到的 `{ type: "tool_use" }` 片段数。
 *   它们是 assistant 一轮内嵌套的函数调用记录；按 M1 契约 § 5 映射为
 *   `function_call_output`。
 * - `toolResultCount`：见到的 `{ type: "tool_result" }` 片段数。
 *   它们是 user 一轮内嵌套的工具输出记录；按契约 § 5 映射为
 *   `raw_tool_outputs`。
 * - `toolPaths`：从被省略的 tool_use 输入与 tool_result 内容中抽取的路径
 *  （对应 `codex-jsonl-parser.ts` 的工具调用路径清点行为；工具记录本身
 *   不在消息文本中，但它引用的文件保留在“触碰文件”清单里）。
 *
 * R2 修复（按 M2b R2 分发 qitem-20260502011841-fb53d7fd）：在丢弃非文本
 * 【之前】先检查嵌套 content 片段。此前会静默丢弃 tool_use / tool_result，
 * 导致在真实 Claude 转录上 omittedCounts 全为 0 的误导结果——那里几乎每个
 * assistant 轮都有 tool_use、多数 user 轮有 tool_result。
 */
interface ContentWalkResult {
  text: string;
  toolUseCount: number;
  toolResultCount: number;
  toolPaths: string[];
}

/**
 * 从 tool_result 的 `content` 字段抽取 `text` 候选。Claude API 允许
 * `tool_result.content` 有两种形态：
 * - string（最常见；例如某命令的 stdout）：直接使用。
 * - 片段对象数组（工具返回结构化内容时）：收集每个片段的 `text` 字段。
 * 返回一个扁平字符串，供路径抽取使用。
 */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        parts.push(p.text);
      }
    }
  }
  return parts.join("\n");
}

function walkClaudeContent(message: unknown): ContentWalkResult {
  const out: ContentWalkResult = { text: "", toolUseCount: 0, toolResultCount: 0, toolPaths: [] };
  if (!message || typeof message !== "object") return out;
  const obj = message as Record<string, unknown>;
  const content = obj.content;
  if (typeof content === "string") {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) return out;

  const textParts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      textParts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const partType = typeof p.type === "string" ? p.type : "";

    if (partType === "text" && typeof p.text === "string") {
      textParts.push(p.text);
      continue;
    }

    if (partType === "tool_use") {
      out.toolUseCount += 1;
      // 从 tool_use 输入抽取路径。对应 Codex 解析器
      // codex-jsonl-parser.ts 里工具调用路径清点的行为。
      const input = p.input;
      const inputStr = typeof input === "string" ? input : JSON.stringify(input ?? {});
      out.toolPaths.push(inputStr);
      continue;
    }

    if (partType === "tool_result") {
      out.toolResultCount += 1;
      // tool_result.content 可能是 string 或 array；两者都抽成扁平文本体以扫描路径。
      const resultText = toolResultText(p.content);
      out.toolPaths.push(resultText);
      continue;
    }

    // 其他片段类型（image 等）不是用户可见文本，也不计入 M1 契约枚举；跳过不计数。
  }
  out.text = textParts.filter((s) => s.length > 0).join("\n");
  return out;
}

interface ClaudeRecord {
  type?: unknown;
  timestamp?: unknown;
  message?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  parentUuid?: unknown;
  attachment?: unknown;
  [key: string]: unknown;
}

/**
 * 把一条 Claude 转录 JSONL 字符串解析为 StructuredTranscript。
 * 纯函数，无 I/O。
 *
 * 按 M2b 分发“输出与 Codex 解析器相同的结构化表示”的要求，输出与 Codex 解析器
 * 形态一致。下游模块（packet-writer、redaction-counter）在运行时感受不到差异。
 */
export function parseClaudeTranscript(content: string): StructuredTranscript {
  const messages: ExtractedMessage[] = [];
  const pathCounts = new Map<string, number>();
  const typeCounts: TypeCounts = {};
  const omittedCounter = new OmittedCounter();
  let sessionMeta: SessionMeta | null = null;
  let lineCount = 0;
  let messageCount = 0;
  // Claude 转录没有 "compacted" 记录；该字段恒为 0。

  for (const rawLine of content.split("\n")) {
    if (!rawLine.trim()) continue;
    lineCount++;

    let record: ClaudeRecord;
    try {
      record = JSON.parse(rawLine) as ClaudeRecord;
    } catch {
      continue;
    }

    const recordType = typeof record.type === "string" ? record.type : "";
    typeCounts[recordType] = (typeCounts[recordType] ?? 0) + 1;

    // 从第一条同时带 cwd + sessionId 的记录捕获 sessionMeta。
    if (
      sessionMeta === null &&
      typeof record.cwd === "string" &&
      typeof record.sessionId === "string"
    ) {
      sessionMeta = {
        cwd: record.cwd,
        sessionId: record.sessionId,
      };
    }

    const classification = classifyClaudeRecord(record);
    if (classification.kind === "omitted") {
      omittedCounter.recordOmission(classification.reason);
      // 对附件记录，遍历附件负载以抽取路径
      //（对应 Codex 解析器的工具调用路径抽取行为）。
      if (recordType === "attachment" && record.attachment) {
        const attachStr = typeof record.attachment === "string"
          ? record.attachment
          : JSON.stringify(record.attachment);
        extractPaths(attachStr, pathCounts);
      }
      continue;
    }

    // 保留的消息。
    const role: "user" | "assistant" = recordType === "user" ? "user" : "assistant";
    const walked = walkClaudeContent(record.message);

    // R2 修复：在决定是否产出一条可见文本消息【之前】就计数嵌套的 tool_use / tool_result。
    // 无论该记录是否向可见转录贡献一条消息，这些计数器都要触发——在这里捕获它们，
    // 正是 M1 契约 § 5 对下游诚实的 `omitted_classes` 字段所要求的。
    for (let i = 0; i < walked.toolUseCount; i++) {
      omittedCounter.recordOmission("function_call_output");
    }
    for (let i = 0; i < walked.toolResultCount; i++) {
      omittedCounter.recordOmission("raw_tool_outputs");
    }
    // 从被省略的工具片段抽取路径（对应 Codex 解析器即使记录本身从消息中省略、
    // 仍遍历工具调用参数/输入做路径清点的行为）。
    for (const toolText of walked.toolPaths) {
      extractPaths(toolText, pathCounts);
    }

    if (hasSecretPattern(walked.text)) {
      omittedCounter.recordRedaction();
    }
    const text = redact(walked.text).trim();
    if (!text) continue;

    messageCount++;
    extractPaths(text, pathCounts);
    messages.push({
      timestamp: typeof record.timestamp === "string" ? record.timestamp : null,
      role,
      text,
      preview: firstLine(text),
    });
  }

  const paths: PathCount[] = [...pathCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 200)
    .map(([path, count]) => ({ path, count }));

  return {
    sessionMeta,
    lineCount,
    messageCount,
    compactedCount: 0,
    typeCounts,
    omittedCounts: omittedCounter.counts,
    messages,
    paths,
  };
}
