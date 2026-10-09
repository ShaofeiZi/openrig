// 席位交接启动摘要——共享的 provider JSONL role/content 读取器。它读取已知的 provider
// 会话 transcript 路径（claude sidecar 的 `transcript_path` / codex 的 `rollout_path`），
// 提取最后 N 条 {role, content} 交互供继任者生成启动摘要。按契约防御性且诚实降级：metadata 行、
// 只有 thinking/tool_use 的消息以及不可解析行都不含用户文本，会被静默跳过；文件缺失或损坏时
// 返回 []，绝不抛错，因为启动摘要不能拖垮继任者。归属说明：dev-planner 已裁定这是共享 parser
//（其 rig-ask L2 只 grep 原始行）；若 L2 将来升级为结构化摘要，可复用本模块。
//
// 以真实 claude-projects 行形状为依据：
//   {type:"user"|"assistant", message:{role, content}}，其中 content 是字符串或以下 block 数组：
//   {type:"text"|"thinking"|"tool_use", text?} block（只有 "text" 携带用户可见内容）。
// Codex rollout 行使用 {payload:{type:"message", role, content}}，由同一读取器处理。
import { existsSync, readFileSync } from "node:fs";

export interface JsonlExchange {
  role: string;
  content: string;
}

/** 从消息 `content` 字段提取用户可见文本。字段可为字符串或 block 数组；只拼接 `text` block，
 * 跳过 thinking/tool_use。没有文本时返回 ""。 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** 把一个已解析 JSONL 对象解释为一次交互；若没有用户可见消息（metadata、只有
 * thinking/tool_use 或形状无法识别）则返回 null。 */
function toExchange(obj: unknown): JsonlExchange | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  // claude-projects：{type:"user"|"assistant", message:{role, content}}
  const msg = o.message as { role?: unknown; content?: unknown } | undefined;
  if (msg && typeof msg.role === "string") {
    const content = extractText(msg.content);
    return content.length > 0 ? { role: msg.role, content } : null;
  }
  // codex rollout：{payload:{type:"message", role, content}}
  const payload = o.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
  if (payload && payload.type === "message" && typeof payload.role === "string") {
    const content = extractText(payload.content);
    return content.length > 0 ? { role: payload.role, content } : null;
  }
  return null;
}

/**
 * 把 `path` 处的 provider 会话 JSONL 解析为最后 `n` 条 {role, content} 交互（有界摘要）。
 * 诚实降级：文件缺失/不可读时返回 []；不可解析、metadata 或无文本的行会被跳过。
 */
export function parseJsonlExchanges(path: string, n: number): JsonlExchange[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const exchanges: JsonlExchange[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 损坏行直接跳过，绝不抛错。
    }
    const ex = toExchange(obj);
    if (ex) exchanges.push(ex);
  }
  return n >= exchanges.length ? exchanges : exchanges.slice(exchanges.length - n);
}
