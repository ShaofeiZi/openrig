// Stylize 传递——专业开发工具处理（创建者指令，k9s 类）在
// 布局后应用：renderScreen 保持测试过的纯层（布局 + hitMap）；
// 此传递仅注入零宽 SGR 序列。不变量（测试固定）：
// stripAnsi(styled[i]) === plain[i] 对每一行——样式绝不移动
// 命中目标或剪切帧。分段绘制（无嵌套包装），因此重置
// 绝不溢出。
import type { Screen } from "./types.js";
import type { Style } from "./theme.js";
import { reducedMotion } from "./motion.js";
import { strWidth } from "./text-width.js";

// 状态词匹配英文数据值（来自后台服务 JSON 的枚举，保持英文）
const STATUS_TOKENS: Array<[RegExp, "ok" | "warn" | "error" | "dim"]> = [
  [/\b(running|active|ready|verified|working)\b/g, "ok"],
  [/(工作中|活跃|就绪|已验证)/g, "ok"],
  [/\b(needs-attention|attention_required|needs you|recoverable|detached|blocked|parked|degraded|stalled|stalled-after-claim|INDETERMINATE|undetermined)\b/g, "warn"],
  [/(需要你|需要关注|可恢复|被阻塞|已暂停|降级|停滞|不确定)/g, "warn"],
  [/\b(failed|down|unreachable|crashed|rejected)\b/g, "error"],
  [/(失败|不可达|已崩溃|已拒绝)/g, "error"],
  [/\b(unknown|idle|stopped|pending)\b/g, "dim"],
  [/(未知|空闲|已停止|待处理)/g, "dim"],
];

// 链接/标签匹配——"打开 ▸" 是 detail.ts 中 OPEN 的中文形式
const LINK_RE = /(run ▸|term ▸|运行 ▸|终端 ▸|打开 ▸|\(open: [^)]+\)|\[ (?:TABLE|RECENT|OVERVIEW|GRAPH|TOPOLOGY|CONFIGURATION|YAML|表格|近期|概览|图|健康|拓扑|配置) \])/g;

function paintInline(text: string, s: Style): string {
  let out = text;
  for (const [re, token] of STATUS_TOKENS) out = out.replace(re, (m) => s.paint(token, m));
  out = out.replace(LINK_RE, (m) => s.paint("accent", m, { bold: true }));
  return out;
}

function paintExplorer(text: string, s: Style, focused: boolean): string {
  // pm 批准：未聚焦窗格的选择条置灰（k9s/编辑器标准）
  if (text.startsWith("▶") || text.startsWith("◆")) {
    const token = focused ? "accent" : "dim";
    return s.paint(token, text, { bg: "selection", bold: focused });
  }
  if (/^[ ▶◆≈]*(TOPOLOGY|SPECS|SCOPES|NEEDS-YOU|拓扑|规范|项目|终端|待关注|系统)\s*$/.test(text)) return s.paint("bright", text, { bold: true });
  // Slice-17 重皮肤：分支引导线绘制为淡色（chrome），行主体保持
  // 自己的规则——树轨读作结构，绝非内容。
  const tree = text.match(/^( *(?:[┃ ] )*(?:┣━|┗━) )(.*)$/);
  if (tree) return s.paint("chrome", tree[1]!) + paintExplorerBody(tree[2]!, s);
  return paintExplorerBody(text, s);
}

/** 行主体处理（视觉目标：工作组青色 · 席位置灰 · 元数据淡色 ·
 *  名称默认墨色）；右对齐元数据列始终置灰 */
function paintExplorerBody(text: string, s: Style): string {
  const meta = text.match(/^(.*?\S)( +)((?:\S+ · )?(?:[0-9]+%|—)|[0-9]+)$/);
  if (meta) return paintExplorerBody(meta[1]!, s) + meta[2]! + s.paint("dim", meta[3]!);
  if (text.includes("⚑")) return s.paint("warn", text);
  if (/\((?:unreachable|不可达)\)/.test(text)) {
    const value = text.includes("(不可达)") ? "(不可达)" : "(unreachable)";
    const at = text.indexOf(value);
    return text.slice(0, at) + s.paint("error", value) + text.slice(at + value.length);
  }
  if (/\((recoverable|degraded|stopped|attention_required|可恢复|降级|已停止|需要关注)\)/.test(text)) {
    return text.replace(/\((recoverable|degraded|stopped|attention_required|可恢复|降级|已停止|需要关注)\)/, (m) => s.paint("warn", m));
  }
  // ROUND-3：资源管理器图标单色——颜色仅用于状态
  if (text.startsWith("▦ ")) return s.paint("dim", "▦ ") + text.slice(2);
  if (text.startsWith("⊕ ")) return s.paint("dim", "⊕ ") + text.slice(2);
  if (/^[⌄›] /.test(text)) return s.paint("chrome", text.slice(0, 2)) + s.paint("dim", text.slice(2));
  return text;
}

/** 告警行带行内层级：字形+类型调色，主机置灰，目标
 *  亮色，详情置灰，链接强调——相同事实，相同位置，相同颜色。 */
function paintAlertLine(text: string, token: "warn" | "error", s: Style): string {
  const openAt = text.indexOf("(打开 ▸)");
  const body = openAt >= 0 ? text.slice(0, openAt) : text;
  const suffix = openAt >= 0 ? s.paint("accent", "(打开 ▸)", { bold: true }) + text.slice(openAt + "(打开 ▸)".length) : "";
  const cols = body.match(/^(\s*[⚑☐✖] )(\S+\s+)(\[[^\]]*\]\s+)?(\S+\s+)(.*)$/);
  // ROUND-3 mr7：待关注 ⚑ 携带慢速注意力脉冲——其区域中唯一的
  // 持续动效；减弱动效下稳定渲染
  const pulse = !reducedMotion();
  const paintFlag = (seg: string): string => {
    const at = seg.indexOf("⚑");
    if (at < 0 || !pulse) return s.paint(token, seg);
    return s.paint(token, seg.slice(0, at)) + s.paint(token, "⚑", { blink: true }) + s.paint(token, seg.slice(at + 1));
  };
  if (!cols)
    return paintFlag(body) + suffix;
  return (
    paintFlag(cols[1]! + cols[2]!) +
    (cols[3] ? s.paint("dim", cols[3]) : "") +
    s.paint("bright", cols[4]!) +
    s.paint("dim", cols[5] ?? "") +
    suffix
  );
}

function paintContent(text: string, s: Style): string {
  if (text.trim() === "") return text;
  if (/\bPOD\b.*\bSEAT\b.*\bSTATE\b/.test(text)) return s.paint("accentBright", text, { bold: true });
  if (/\bNODE\b.*\bLABEL\b.*\bRUNTIME\b/.test(text)) return s.paint("accentBright", text, { bold: true });
  // 详情词汇：分区规则 "  ── 标题 ────"
  const rule = text.match(/^( {2})── (.+?) (─+)$/);
  if (rule) return `${rule[1]}${s.paint("chrome", "──")} ${s.paint("bright", rule[2]!, { bold: true })} ${s.paint("chrome", rule[3]!)}`;
  // 详情词汇：字段行 "  标签:      值" → 置灰标签，行内绘制值
  const field = text.match(/^( {2})([a-z][a-z0-9 -]{0,14}:)( +)(\S.*)$/);
  if (field) return `${field[1]}${s.paint("dim", field[2]!)}${field[3]}${paintInline(field[4]!, s)}`;
  if (/^(SPEC LIBRARY|NEEDS-YOU|agent spec |rig spec |agent |seats running spec )/.test(text.trimStart()) && !text.includes("│"))
    return paintTitleLine(text, s);
  if (/^\s*\/ filter/.test(text)) return s.paint("dim", text);
  if (/^\s*─+$/.test(text)) return s.paint("chrome", text);
  if (text.includes("⚑")) return paintAlertLine(text, "warn", s);
  if (text.includes("✖")) return paintAlertLine(text, "error", s);
  if (/hosts\/rigs down:/.test(text)) return s.paint("warn", text, { bold: true });
  if (/human-queue:|honest-empty|read pending|proven empty|not in the current snapshot|library read pending/.test(text))
    return s.paint("dim", text);
  if (/^\s*(source|attach):/.test(text)) return s.paint("dim", text);
  if (/^\s*content ↑\/↓/.test(text)) return s.paint("dim", text);
  return paintInline(text, s);
}

function paintTitleLine(text: string, s: Style): string {
  // 标题：标题 token 亮粗，其余交给行内绘制
  const m = text.match(/^(\s*)(SPEC LIBRARY|NEEDS-YOU|agent spec \S+|rig spec \S+|agent \S+|seats running spec "[^"]*")(.*)$/);
  if (!m) return paintInline(text, s);
  return `${m[1]}${s.paint("bright", m[2]!, { bold: true })}${paintInline(m[3] ?? "", s)}`;
}

function paintRule(line: string, s: Style): string {
  // 窗格标题嵌入在规则行中：规则置灰，标题词提亮
  return line
    .split(/([─━]+|[┌┐└┘├┤┬┴┼╋┃])/)
    .map((part) => (part === "" ? part : /^[─━┌┐└┘├┤┬┴┼╋┃]+$/.test(part) ? s.paint("chrome", part) : s.paint("accentBright", part, { bold: true })))
    .join("");
}

export function stylizeLines(screen: Screen, s: Style): string[] {
  if (s.mode === "none") return screen.lines;
  // 焦点从铬本身读取（带括号的窗格标题）——无
  // 第二个真源可漂移
  const explorerFocused = /\{ (?:EXPLORER|资源管理器) \}/.test(screen.lines.find((line) => line.includes("╋")) ?? "");

  const rigRows = new Set(screen.explorerRows.filter(row => row.key?.startsWith("rig:")).map(row => row.y));

  return screen.lines.map((line, index) => {
    if (index === 0) {
      const m = line.match(/^cmd ▸ (.*)(▊)(.*)$/);
      if (m)
        return `${s.paint("accent", "cmd ▸", { bold: true })} ${s.paint("bright", m[1] ?? "")}${m[2] ? s.paint("accent", "▊") : ""}${s.paint("dim", m[3] ?? "")}`;
      if (line.startsWith("cmd ▸ ")) return s.paint("accent", "cmd ▸", { bold: true }) + s.paint("dim", line.slice(5));
      if (line.startsWith("help ▸ ")) return s.paint("accent", line, { bold: true });
      return line;
    }
    if (screen.explorerWidth === 0 && screen.segRows?.[index + 1]) {
      const segs = screen.segRows[index + 1]!;
      const text = segs.map(seg => s.paint(seg.token ?? "bright", seg.text, { bold: seg.bold, bg: seg.bg })).join("");
      return text + line.slice(segs.reduce((length, seg) => length + seg.text.length, 0));
    }
    if (/^[─━┌┐└┘├┤┬┴┼╋]/.test(line) && /[─━]{4}/.test(line)) return paintRule(line, s);
    if (/\bq quit\b|q 退出/.test(line)) {
      // 键绑定提示栏：键强调，标签置灰，分隔符 chrome
      return line
        .split(/( · )/)
        .map((part) =>
          part === " · "
            ? s.paint("chrome", " · ")
            : part.replace(/^(\S+)( .*)$/, (_, key: string, label: string) => s.paint("accent", key, { bold: true }) + s.paint("dim", label)),
        )
        .join("");
    }
    if (line.startsWith("≋")) {
      // round-5（防护）：环境工作组流滚动条不是窗格输出
      // 事件源——它从不闪烁；活动闪烁在
      // 闪烁智能体的资源管理器行（flashRows）上
      const m = line.match(/^≋ (\S+) (\S+) (.*)$/);
      if (m) return `${s.paint("accent", "≋")} ${s.paint("dim", m[1]!)} ${s.paint("accentBright", m[2]!)} ${s.paint("dim", m[3]!)}`;
      return s.paint("dim", line);
    }
    if (/^\[[^\]]+\] /.test(line)) {
      const closeAt = line.indexOf("]");
      let rest = line.slice(closeAt + 1);
      const errAt = rest.indexOf("✗");
      const noticeAt = rest.indexOf("▸");
      const warnAt = rest.indexOf("⚠");
      const cut = Math.min(...[errAt, noticeAt, warnAt].filter((n) => n >= 0), rest.length);
      const path = rest.slice(0, cut);
      let tail = rest.slice(cut);
      if (tail.startsWith("✗")) tail = s.paint("error", tail);
      else if (tail.startsWith("▸")) tail = s.paint("accentBright", tail);
      else if (tail.startsWith("⚠")) tail = s.paint("warn", tail);
      return `${s.paint("accent", line.slice(0, closeAt + 1), { bold: true })}${s.paint("bright", path)}${tail}`;
    }
    // S19 round-5（防护）：tmux 风格新鲜窗格输出一次性闪烁——
    // 在窗口打开时对闪烁智能体的资源管理器行全行反色
    // （renderScreen 拥有事件/窗口/减弱动效真值；
    // 这是零宽 SGR，剥离不变量保持）
    if (screen.flashRows?.includes(index + 1)) return s.paint("bright", line, { inverse: true });
    // 窗格边框位于渲染的 L2 边界——位置定位，
    // 绝不通过扫描：导航器的 │ 轨会遮蔽
    // 首索引搜索（slice-17 锁定轨分辨率）。
    const explW = screen.explorerWidth;
    let border = 0;
    let columns = 0;
    for (const char of line) {
      if (columns >= explW) break;
      columns += strWidth(char);
      border += char.length;
    }
    if (columns === explW && line.startsWith("┃", border)) {
      const left = line.slice(0, border);
      const marker = line.slice(border + "┃".length, border + "┃".length + 1);
      const right = line.slice(border + "┃".length + 1);
      const em = screen.explorerMeta?.[index + 1];
      const selected = left.startsWith("▶") || left.startsWith("◆");
      let paintedLeft = paintExplorer(left, s, explorerFocused);
      // 存在性在工作组选择条上保持可读；其他行选择保持其处理。
      if (em?.length && (!selected || rigRows.has(index + 1))) {
        paintedLeft = "";
        let pos = 0;
        const selection = selected ? { bg: "selection" as const, bold: explorerFocused } : {};
        for (const [k, run] of em.entries()) {
          const chunk = left.slice(pos, run.start);
          paintedLeft += selected ? s.paint(explorerFocused ? "accent" : "dim", chunk, selection)
            : k === 0 ? paintExplorer(chunk, s, explorerFocused) : paintExplorerBody(chunk, s);
          paintedLeft += run.segs.map(g => s.paint(g.token ?? "bright", g.text,
            { bold: g.bold, bg: g.bg, inverse: g.inverse, ...selection })).join("");
          pos = run.start + run.segs.reduce((n, g) => n + g.text.length, 0);
        }
        paintedLeft += selected ? s.paint(explorerFocused ? "accent" : "dim", left.slice(pos), selection)
          : paintExplorerBody(left.slice(pos), s);
      }
      if (marker === "›") {
        return `${paintedLeft}${s.paint("chrome", "┃")}${s.paint("accent", `›${right}`, { bg: "selection", bold: true })}`;
      }
      // slice-17：画布渲染行（图形视图）携带 token 段——
      // 用此 Style 绘制；plain(segs) === 内容文本，
      // 因此剥离不变量在结构上成立
      const segs = screen.segRows?.[index + 1];
      if (segs) {
        const segText = segs.map((seg) => seg.text).join("");
        const painted = segs
          .map((seg) =>
            seg.token || seg.bg || seg.inverse
              ? s.paint(seg.token ?? "bright", seg.text, { ...(seg.bold ? { bold: true } : {}), ...(seg.bg ? { bg: seg.bg } : {}), ...(seg.inverse ? { inverse: true } : {}) })
              : seg.text)
          .join("");
        return `${paintedLeft}${s.paint("chrome", "┃")}${marker}${painted}${right.slice(segText.length)}`;
      }
      return `${paintedLeft}${s.paint("chrome", "┃")}${marker}${paintContent(right, s)}`;
    }
    // （全宽 segRows 分支随故障诊断 shell 布局重做移除——其唯一
    // 调用者全宽座舱 Screen 现在通过上面的分割窗格 │ 路径在窗格内渲染。）
    return paintContent(line, s);
  });
}
