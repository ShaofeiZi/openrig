// 主题层——锁定 mockup 的视觉处理（基线 tarball
// d3f3bf9c，artifact e99e3b32 .tui CSS）映射到终端颜色，带有合理
// 降级：真彩色渲染精确 mockup 调色板，256 色最近
// xterm 立方体，16 色经典 SGR 集，none（NO_COLOR /
// --no-color / dumb term）渲染纯文本。仅展示——
// 此处不触及布局、状态或解析器。

export type ColorMode = "truecolor" | "256" | "16" | "none";

export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env["NO_COLOR"] != null && env["NO_COLOR"] !== "") return "none";
  const term = env["TERM"] ?? "";
  if (term === "dumb" || term === "") return "none";
  const colorterm = env["COLORTERM"] ?? "";
  if (/truecolor|24bit/i.test(colorterm)) return "truecolor";
  if (/256color/.test(term)) return "256";
  return "16";
}

/** 语义 token——按意义命名而非颜色，使视图保持诚实。 */
export type Token =
  | "accent" // G2 选择/链接/激活蓝色
  | "accentBright" // G2 树/链接强调
  | "warn" // 阻塞/待关注/警报（mockup 琥珀色 #e6b56e）
  | "error" // 失败/错误状态
  | "ok" // 健康/运行中状态
  | "info" // 信息/阻塞类强调（51-09 pulse mock #8fb8d8 —— 信息类，可复用）
  | "dim" // 次要文本（mockup #6d7480）
  | "bright" // 主要强调
  | "chrome" // 边框/规则线
  | "selection" // G2 选中行洗涤
  // S19 MR2——web 相同的运行时标记颜色（RuntimeMark.tsx 值）；
  // 16 色值是已发布降级集，在
  // round-7 封印时通过 QA 验证（根据 QA LOCKED-SCOPE-CLEAR 在
  // 5348bb66 INFO 的废弃注释清理——行为和引脚已在这些锁定值上）
  // S19 MR3——活动角色（值 = 占位符，等待创建者
  // 调色板选择；角色是契约，引脚与值无关）
  | "actActive"
  | "actIdle"
  | "actDetached"
  | "actAttention"
  | "clawd" // clawd 主体 #ad6755
  | "clawdEye" // clawd 眼睛 #181818
  | "markInk" // codex `>_` 墨色（浅色）
  | "markBg" // 终端标记暗色单元格
  | "codexBlue"; // 官方采样 #6867aa（记录选择的来源）

// [truecolor rgb, 256 索引, 16 色 SGR]
const PALETTE: Record<Token, [[number, number, number], number, number]> = {
  accent: [[111, 168, 255], 111, 94],
  accentBright: [[154, 194, 255], 153, 96],
  warn: [[244, 190, 92], 221, 33],
  error: [[224, 108, 117], 167, 31],
  ok: [[152, 195, 121], 108, 32],
  info: [[143, 184, 216], 110, 94], // #8fb8d8 精确；xterm256 110, 16 色亮蓝
  dim: [[109, 116, 128], 243, 90],
  bright: [[232, 234, 240], 254, 97],
  // S19 MR5b：一步对比度提升（创建者：'更显眼一点'）
  chrome: [[78, 105, 145], 60, 90],
  selection: [[34, 52, 82], 236, 40],
  actActive: [[152, 195, 121], 108, 32],
  actIdle: [[110, 142, 170], 109, 34],
  actDetached: [[109, 116, 128], 243, 90],
  actAttention: [[230, 181, 110], 179, 33],
  clawd: [[173, 103, 85], 131, 31],
  clawdEye: [[24, 24, 24], 234, 30],
  markInk: [[250, 250, 249], 255, 97],
  markBg: [[12, 10, 9], 233, 30],
  codexBlue: [[104, 103, 170], 61, 34],
};

export interface Style {
  /** 用 token 的 SGR 包装文本（加粗/反色）；"none" 模式下为恒等 */
  paint(token: Token, text: string, opts?: { bold?: boolean; inverse?: boolean; bg?: Token; blink?: boolean }): string;
  readonly mode: ColorMode;
}

export function createStyle(mode: ColorMode = detectColorMode()): Style {
  function open(token: Token, opts?: { bold?: boolean; inverse?: boolean; bg?: Token; blink?: boolean }): string {
    if (mode === "none") return "";
    const parts: string[] = [];
    if (opts?.bold) parts.push("1");
    if (opts?.blink) parts.push("5");
    if (opts?.inverse) parts.push("7");
    const [rgb, x256, basic] = PALETTE[token];
    if (mode === "truecolor") parts.push(`38;2;${rgb[0]};${rgb[1]};${rgb[2]}`);
    else if (mode === "256") parts.push(`38;5;${x256}`);
    else parts.push(String(basic));
    if (opts?.bg) {
      const [brgb, b256, bBasic] = PALETTE[opts.bg];
      if (mode === "truecolor") parts.push(`48;2;${brgb[0]};${brgb[1]};${brgb[2]}`);
      else if (mode === "256") parts.push(`48;5;${b256}`);
      // 16 色：fg 代码 + 10 = 匹配的 bg 代码（30-37→40-47, 90-97→100-107）
      else parts.push(String(bBasic + 10));
    }
    return `\x1b[${parts.join(";")}m`;
  }
  return {
    mode,
    paint(token, text, opts) {
      if (mode === "none" || text === "") return text;
      return `${open(token, opts)}${text}\x1b[0m`;
    },
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** stylize 不变量：剥离样式行返回纯行——
 *  样式绝不改变布局、宽度或命中坐标。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
