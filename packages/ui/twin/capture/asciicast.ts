// OPR.0.4.1.11.2（FR-3）——CLI 媒介捕获，零依赖 asciicast v2。
// 主机不保证安装 asciinema（本机即未安装），因此不伪造捕获，而是直接输出文档规定的
// asciicast v2 格式：一行 JSON 头，随后是 [time, "o", data] 输出事件行
//（https://docs.asciinema.org/manual/asciicast/v2/）。纯构建器具有确定性；除非显式传入
// 时间戳，否则不读取墙上时钟。captureCommandCast 可在各环境中把非交互命令输出包装为
// 有效 cast。已安装二进制的环境仍可使用真实交互式 `asciinema rec`；路径见 FR-5 约定文档。
import { spawnSync } from "node:child_process";

export interface AsciicastEvent {
  /** 自 cast 开始后的秒数。 */
  time: number;
  /** 输出片段。 */
  data: string;
}

export interface AsciicastInput {
  width: number;
  height: number;
  events: AsciicastEvent[];
  /** 可选 Unix 时间戳；缺失时不写入头部，以保持输出确定性。 */
  timestamp?: number;
}

/** 构建有效的 asciicast v2 文档（头行 + 输出事件行）；纯函数且具确定性。 */
export function buildAsciicast(input: AsciicastInput): string {
  const header: Record<string, unknown> = { version: 2, width: input.width, height: input.height };
  if (input.timestamp !== undefined) header.timestamp = input.timestamp;
  const lines = [JSON.stringify(header)];
  for (const ev of input.events) lines.push(JSON.stringify([ev.time, "o", ev.data]));
  return lines.join("\n") + "\n";
}

export interface CommandCastInput {
  command: string;
  args?: string[];
  width?: number;
  height?: number;
}

/**
 * 零依赖 CLI 捕获：运行非交互命令，并把合并输出包装为有效 asciicast 中的单个输出事件。
 * 只要命令输出确定，结果就确定。若需交互式/计时录制，请安装 asciinema 并使用
 * `asciinema rec`；cast 格式相同。
 */
export function captureCommandCast(input: CommandCastInput): string {
  const r = spawnSync(input.command, input.args ?? [], { encoding: "utf8" });
  const data = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return buildAsciicast({
    width: input.width ?? 80,
    height: input.height ?? 24,
    events: data ? [{ time: 0, data }] : [],
  });
}
