// 故障诊断 C3 C4——运行后聚合诊断列表（计划 c015d9ed §C4）。一个可键盘遍历的
// 列表，绝非每个席位一个阻塞提示：每行 = 一个席位 + 它确切需要什么（失败的
// 恢复检查的补救）。绿色席位省略；红色（需要操作）在黄色（警告）之前。
// 来源于发布的恢复检查 CheckEntry 证据；控制器聚合（C1
// attention_required/resume_failed）、resolve→发布恢复交接和实时恢复检查
// 获取是接缝（C1 本轮排除）。这是模型 + 渲染（无 mock——文本列表）。
import type { Token } from "../theme.js";

export type TriageStatus = "red" | "yellow" | "green";

/** 一个席位的恢复检查证据（后台服务 CheckEntry[] 的 TUI 本地视图——已解析，因此无
 *  @openrig/daemon 依赖；轻量 TUI 围栏）。 */
export interface TriageCheckInput {
  seat: string;
  entries: Array<{
    check: string;
    status: TriageStatus;
    evidence: string;
    remediation: string;
    remediationSafe?: boolean;
  }>;
}

/** 诊断行 = 一个席位 + 它需要解决的失败检查。 */
export interface TriageRow {
  seat: string;
  check: string;
  status: "red" | "yellow";
  /** 席位需要什么（补救）。 */
  need: string;
  evidence: string;
  remediationSafe: boolean;
}

interface Seg {
  text: string;
  token?: Token;
  bold?: boolean;
}
interface Line {
  text: string;
  segs?: Seg[];
}
function line(segs: Seg[]): Line {
  return { text: segs.map((s) => s.text).join(""), segs };
}

/** 将按席位的失败检查扁平化为诊断行（绿色省略）；红色在黄色之前。 */
export function buildTriageModel(input: TriageCheckInput[]): TriageRow[] {
  const rows: TriageRow[] = [];
  for (const s of input) {
    for (const e of s.entries) {
      if (e.status === "green") continue;
      rows.push({
        seat: s.seat,
        check: e.check,
        status: e.status,
        need: e.remediation,
        evidence: e.evidence,
        remediationSafe: e.remediationSafe ?? false,
      });
    }
  }
  // 红色（需要操作）在黄色（警告）之前；JS sort 稳定，因此同状态顺序保持。
  return rows.sort((a, b) => (a.status === b.status ? 0 : a.status === "red" ? -1 : 1));
}

/** 渲染诊断列表：标题 + 每个需要一行（席位 + 补救，检查置灰），
 *  或无待关注时的全清理行。 */
export function renderTriage(rows: TriageRow[]): Line[] {
  if (rows.length === 0) {
    return [line([{ text: " ✓ ", token: "ok" }, { text: "所有席位已干净恢复" }])];
  }
  const out: Line[] = [line([{ text: `待关注 (${rows.length})`, token: "warn", bold: true }])];
  for (const r of rows) {
    const glyph = r.status === "red" ? "●" : "◌";
    const tok: Token = r.status === "red" ? "error" : "warn";
    out.push(
      line([
        { text: ` ${glyph} `, token: tok },
        { text: r.seat, token: "bright", bold: true },
        { text: ` — ${r.need}` },
        { text: ` (${r.check})`, token: "dim" },
      ]),
    );
  }
  return out;
}
