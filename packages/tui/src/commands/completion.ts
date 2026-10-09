import { COMMAND_REGISTRY, evaluateAvailability, VERB_TABLE, type CompletionContext } from "./registry.js";

/** 补全提议文本；执行仍走 parseCommand 和 dispatch。 */
export function completeCommand(line: string, ctx: CompletionContext, context = "standard") {
  let head = "";
  let prefix = line;
  let choices: string[];
  if (line.startsWith(":")) {
    head = ":";
    prefix = line.slice(1);
    choices = ctx.state.sections.map((s) => s.name);
  } else {
    const match = /^(\S+)(\s+)(.*)$/.exec(line);
    if (match) {
      const entry = VERB_TABLE.get(match[1]!);
      head = match[1]! + match[2]!;
      prefix = match[3]!;
      choices = [...(entry && evaluateAvailability(entry, context).available ? entry.complete?.(ctx) ?? [] : [])];
    } else {
      choices = COMMAND_REGISTRY.filter((e) => evaluateAvailability(e, context).available)
        .flatMap((e) => [e.name, ...e.aliases]);
    }
  }
  const candidates = [...new Set(choices)].filter((c) => c.startsWith(prefix)).sort();
  if (!candidates.length) return { line, candidates, message: "无补全匹配；请编辑文本或按 ? 获取帮助" };
  let common = candidates[0]!;
  for (const candidate of candidates) while (!candidate.startsWith(common)) common = common.slice(0, -1);
  let completed = head + common;
  if (!head && candidates.length === 1 && VERB_TABLE.get(common)?.args) completed += " ";
  return { line: completed, candidates, message: candidates.length === 1 ? "已补全 · 回车运行 · Esc 清除" : `${candidates.length} 个匹配 · 继续输入，然后按 Tab` };
}
