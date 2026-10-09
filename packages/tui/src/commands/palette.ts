// REGISTRY I3（裁决 64f1dbdf）——模糊命令面板的 MODEL（纯逻辑；渲染覆盖层和输入接线消费它）。已确认的 PM 要点：
//   - 别名在模糊匹配中是一等公民（pin 5）；
//   - 上下文不可用的条目渲染为"置灰+原因"，绝不隐藏；
//   - 执行与直接键入完全一致：面板发出一条命令行，走 parseCommand -> dispatch（BR-9 单解析器路径）——
//     无参数条目逐字执行该命令行，有参数条目预填充命令栏。
import { evaluateAvailability } from "./registry.js";
import type { CommandEntry } from "./registry.js";

export interface PaletteRow {
  entry: CommandEntry;
  /** 当条目的上下文在当前上下文中满足时为 true。 */
  available: boolean;
  /** 不可用时：诚实说明所需上下文的原因。 */
  reason?: string;
  score: number;
}

/** 子序列模糊评分：精确前缀 > 词前缀 > 子序列；别名命中取规范名+别名中最高分（一等公民，pin 5）。0 = 无匹配。 */
function scoreOne(query: string, candidate: string): number {
  if (query === "") return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c === q) return 1000 - c.length;
  if (c.startsWith(q)) return 800 - c.length;
  // 子序列匹配
  let qi = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] === q[qi]) qi += 1;
  }
  return qi === q.length ? 400 - c.length : 0;
}

function scoreEntry(query: string, entry: CommandEntry): number {
  return Math.max(scoreOne(query, entry.name), ...entry.aliases.map((a) => scoreOne(query, a)));
}

export function filterPalette(
  query: string,
  registry: readonly CommandEntry[],
  currentContext: string,
): PaletteRow[] {
  const rows: PaletteRow[] = [];
  for (const entry of registry) {
    const score = scoreEntry(query, entry);
    if (score === 0) continue;
    const availability = evaluateAvailability(entry, currentContext);
    rows.push({ entry, ...availability, score });
  }
  // 稳定排序：分数降序，然后注册表顺序（并列时保持插入顺序）。
  return rows.sort((a, b) => b.score - a.score);
}

/** 执行契约：无参数条目逐字执行其规范命令行（与键入字节级一致）；有参数条目预填充命令栏供补全——
 *  面板绝不编造参数。 */
export function paletteExecuteLine(entry: CommandEntry): { mode: "execute" | "prefill"; line: string } {
  if (entry.prefix) return { mode: "prefill", line: entry.name };
  return entry.args ? { mode: "prefill", line: `${entry.name} ` } : { mode: "execute", line: entry.name };
}
