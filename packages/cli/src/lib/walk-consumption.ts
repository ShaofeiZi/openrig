/** 仅作为回执证据：完整输入及其闭合的原生轮次，绝不涉及理解。 */
export function analyzeWalkSuffix(suffix: string, content: string): { consumed: boolean; turnClosed: boolean } {
  // CRLF 和首尾空白是唯一允许的传输归一化。
  // 内部空白（包括代码缩进）属于内容。
  const canonical = (text: string) => text.replace(/\r\n/g, "\n").trim();
  const expected = canonical(content);
  const textOf = (value: unknown): string => typeof value === "string" ? value
    : Array.isArray(value) ? value.map(b => (b?.type === "text" || b?.type === "input_text") && typeof b.text === "string" ? b.text : "").join("") : "";
  let consumed = false;
  type Record = {
    type?: string; subtype?: string; uuid?: string; parentUuid?: string; isSidechain?: boolean; isMeta?: boolean;
    message?: { role?: string; content?: unknown };
    payload?: { type?: string; role?: string; content?: unknown; turn_id?: string };
  };
  const claudeRecords = new Map<string, Record>();
  const matchedInputs = new Set<string>();
  const isPrompt = (rec: Record) => rec.type === "user" && rec.message?.role === "user" && !rec.isMeta
    && !(Array.isArray(rec.message.content) && rec.message.content.some(b => b?.type === "tool_result"));
  let activeTurn: string | undefined;
  let matchedTurn: string | undefined;
  for (const line of suffix.split("\n").slice(0, -1)) { // 未完成的追加不是证据
    let rec: Record;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.isSidechain) continue;
    if (rec.type === "compacted") return { consumed, turnClosed: false };
    const p = rec.payload;
    if (rec.type === "event_msg" && p?.type === "task_started") {
      activeTurn = typeof p.turn_id === "string" ? p.turn_id : undefined;
    }
    if (rec.type === "turn_context" && activeTurn !== p?.turn_id) activeTurn = undefined;
    if (rec.type === "response_item" && p?.type === "message" && p.role === "user"
      && expected && canonical(textOf(p.content)) === expected) {
      consumed = true;
      matchedTurn = activeTurn;
    }
    if (rec.type === "event_msg" && p?.type === "task_complete") {
      if (matchedTurn && activeTurn === matchedTurn && p.turn_id === matchedTurn) return { consumed: true, turnClosed: true };
      if (p.turn_id === activeTurn) activeTurn = undefined;
    }
    if (typeof rec.uuid === "string") claudeRecords.set(rec.uuid, rec);
    if (isPrompt(rec) && expected && canonical(textOf(rec.message?.content)) === expected) {
      consumed = true;
      if (typeof rec.uuid === "string") matchedInputs.add(rec.uuid);
    }
  }
  // 原生 Claude 可能在用户记录之前冲刷助手和闭合。
  // 在收集后缀后沿 UUID 祖先链追溯；追加顺序不是轮次顺序。
  for (const closure of claudeRecords.values()) {
    if (closure.type !== "system" || closure.subtype !== "turn_duration") continue;
    const visited = new Set<string>();
    let parent = closure.parentUuid;
    let sawAssistant = false;
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      const rec = claudeRecords.get(parent);
      if (!rec) break;
      if (isPrompt(rec)) {
        if (sawAssistant && matchedInputs.has(parent)) return { consumed: true, turnClosed: true };
        break; // 另一个输入的完成不能证明本条。
      }
      if (rec.type === "assistant" && rec.message?.role === "assistant") sawAssistant = true;
      parent = rec.parentUuid;
    }
  }
  return { consumed, turnClosed: false };
}
