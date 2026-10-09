// Slice 15（OPR.0.4.7.15）—— 唯一共享的 CLI 错误/退出路径。
//
// Commander 默认会把纯文本用法/校验错误打印到 stderr 后退出——这样一来，
// 一个用 `--json`（或 `-o json`）解析 stdout 的调用方既拿不到可解析内容，
// 也无法区分成功与失败。这里对 parse 做了包装：
//   - 校验/用法错误（缺少必填选项、未知选项、自定义选项解析器抛出的
//     InvalidArgumentError——例如非法的 --limit / -o）在请求了 JSON 时，
//     变成 stdout 上的机器可读 JSON 错误对象，并以非零码退出；
//     未请求 JSON 时则保留熟悉的纯文本 stderr 行为；
//   - `--help`/`--version`（Commander 的“干净”退出，exitCode 0）直接放行。
// 在入口一次性修复，而不是逐个命令打补丁。
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { DaemonConnectionError, DaemonResponseError, DaemonTimeoutError } from "./client.js";

/**
 * Commander 选项解析器——要求正整数（>= 1）。拒绝负数、零和非数字值（finding 4）。
 * 抛出 InvalidArgumentError，下方的共享错误路径会在 `--json` 下把它渲染成 JSON 错误。
 */
export function positiveIntArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError(`必须是正整数（>= 1），实际为 '${value}'`);
  }
  return n;
}

/** Commander 选项解析器工厂——取值必须落在 `allowed` 之中（finding 3）。 */
export function enumArg(allowed: readonly string[]): (value: string) => string {
  return (value: string): string => {
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`必须取以下值之一：${allowed.join(", ")}，实际为 '${value}'`);
    }
    return value;
  };
}

/** 当调用方请求机器可读输出时为真（`--json` 或 `-o/--output/--format json`）。 */
export function wantsJsonOutput(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") return true;
    if ((a === "-o" || a === "--output" || a === "--format") && argv[i + 1] === "json") return true;
    if (/^(?:-o|--output|--format)=json$/.test(a)) return true;
  }
  return false;
}

interface CommanderLikeError {
  code?: string;
  exitCode?: number;
  message?: string;
}

/** Commander 的非错误性退出（帮助/版本）——干净退出，不产生错误对象。 */
export function isCleanCommanderExit(err: unknown): boolean {
  const e = err as CommanderLikeError;
  return (
    e?.code === "commander.helpDisplayed" ||
    e?.code === "commander.version" ||
    e?.code === "commander.help" ||
    (typeof e?.exitCode === "number" && e.exitCode === 0)
  );
}

/**
 * 把 Commander “Did you mean …” 建议片段本地化为中文。
 * 仅在匹配 Commander 固定括号文案时替换，其余原样返回。
 */
function localizeSuggestion(suggestion: string): string {
  if (!suggestion) return "";
  let m = suggestion.match(/^\s*\(Did you mean one of ([^?]*)\?\)\s*$/);
  if (m) return `\n（您是否想输入：${m[1]}？）`;
  m = suggestion.match(/^\s*\(Did you mean ([^?]*)\?\)\s*$/);
  if (m) return `\n（您是否想输入 ${m[1]}？）`;
  return suggestion;
}

/**
 * Commander 内置错误文案的白名单本地化。
 *
 * 只匹配 Commander 自身产生的固定模板（未知命令/未知选项/缺参数/参数过多/
 * 选项冲突等），不做不区分来源的全局替换——因此不会改动守护进程返回的
 * 用户数据、JSON 业务字段或协议 code。入参可能带 `error: ` 前缀；
 * 返回中文展示文案（不含 `error: ` 前缀）；若不是已知模板则返回 null，
 * 由调用方保留原始文本。
 */
export function localizeCommanderMessage(raw: string): string | null {
  const m = raw.replace(/^error:\s*/i, "").trim();

  // unknown command 'x'  (+ 可选建议)
  let mm = m.match(/^unknown command '([^']*)'([\s\S]*)$/);
  if (mm) return `未知命令“${mm[1]!}”${localizeSuggestion(mm[2]!)}`;

  // unknown option '--flag'  (+ 可选建议)
  mm = m.match(/^unknown option '([^']*)'([\s\S]*)$/);
  if (mm) return `未知选项“${mm[1]!}”${localizeSuggestion(mm[2]!)}`;

  // 示例：缺少必填参数 'name'。
  mm = m.match(/^missing required argument '([^']*)'$/);
  if (mm) return `缺少必填参数“${mm[1]!}”`;

  // 示例：选项 '--flag' 缺少参数。
  mm = m.match(/^option '([^']*)' argument missing$/);
  if (mm) return `选项“${mm[1]}”缺少参数`;

  // 示例：未指定必填选项 '--flag'。
  mm = m.match(/^required option '([^']*)' not specified$/);
  if (mm) return `未指定必填选项“${mm[1]!}”`;

  // 示例：'sub' 的参数过多；预期 N 个，实际 M 个。
  mm = m.match(/^too many arguments( for '([^']*)')?\. Expected (\d+) argument(s)? but got (\d+)\.$/);
  if (mm) {
    const where = mm[2] ? `（位于子命令 ${mm[2]}）` : "";
    return `参数过多${where}：期望 ${mm[3]} 个参数，实际收到 ${mm[5]} 个。`;
  }

  // 示例：选项 '--a' 不能与选项 '--b' 同时使用。
  // 示例：环境变量 'X' 不能与选项 '--b' 同时使用。
  mm = m.match(/^(option '[^']*'|environment variable '[^']*') cannot be used with (option '[^']*'|environment variable '[^']*')$/);
  if (mm) return `${mm[1]} 不能与 ${mm[2]} 同时使用`;

  return null;
}

export function formatCliError(err: unknown): { ok: false; error: { code: string; message: string } } {
  const e = err as CommanderLikeError;
  const raw = (e?.message ?? String(err)).replace(/^error:\s*/i, "").trim();
  // 已知 Commander 模板走中文展示；其余（守护进程/业务错误）保持原文，
  // 以免改动机器或用户数据。code 字段始终保持英文原值。
  const message = localizeCommanderMessage(raw) ?? raw;
  return { ok: false, error: { code: e?.code ?? "cli_error", message } };
}

/** 递归地给每个命令设置 exitOverride，使解析错误抛出而不是直接退出进程。 */
export function applyExitOverride(program: Command): void {
  const walk = (cmd: Command) => {
    cmd.exitOverride();
    for (const sub of cmd.commands) walk(sub);
  };
  walk(program);
}

export interface RunProgramIo {
  out?: (line: string) => void; // stdout（JSON 错误对象）
  err?: (line: string) => void; // stderr（纯文本错误）
  exit?: (code: number) => void; // 进程退出
}

/**
 * 响应完整性渲染：守护进程传输失败（响应异常/响应超时/无法连接）在 JSON 与
 * 人类两种模式下都渲染成本仓库约定的“事实/后果/行动”三段式错误。
 * （Commander 的 writeErr 不会为 action 内部抛出的错误触发，否则人类运行时会
 * 完全静默。）返回 true 表示已处理 `e`。响应异常/超时绝不套用“后台服务未运行”
 * 的措辞——请求已经送达，结果未知。
 */
export function renderDaemonTransportError(
  e: unknown,
  io: { out: (l: string) => void; err: (l: string) => void; json: boolean },
): boolean {
  let parts: { fact: string; consequence: string; action: string } | undefined;
  // DaemonTimeoutError 是 DaemonConnectionError 的子类——必须先判断它。
  if (e instanceof DaemonResponseError) {
    parts = {
      fact: e.message,
      consequence: "命令结果未知——可能已生效，也可能未生效。",
      action:
        "请重新核对当前状态（例如 'zrig queue show <id>'）；若反复出现，用 'zrig daemon status' 检查后台服务健康状态并查看日志。这是响应异常，不是后台服务已停止。",
    };
  } else if (e instanceof DaemonTimeoutError) {
    parts = {
      fact: e.message,
      consequence: "命令结果未知——后台服务未能在规定时间内响应。",
      action:
        "重试前先确认命令的实际效果；若持续缓慢，用 'zrig status' 查看后台服务负载并检查日志。这是响应缓慢，不是后台服务已停止。",
    };
  } else if (e instanceof DaemonConnectionError) {
    parts = {
      fact: e.message,
      consequence: "命令未送达。",
      action: "用 'zrig daemon status' 确认后台服务可达；若已停止，用 'zrig up' 或 'zrig daemon start' 启动。",
    };
  }
  if (!parts) return false;
  if (io.json) {
    io.out(JSON.stringify({ error: parts }));
  } else {
    io.err(parts.fact);
    io.err(`  ${parts.consequence}`);
    io.err(`  ${parts.action}`);
  }
  return true;
}

/**
 * 通过共享错误路径解析并运行程序。IO 可注入，便于测试。
 * 返回进程退出码（成功/干净的帮助或版本退出为 0）。
 */
export async function runProgram(program: Command, argv: string[], io: RunProgramIo = {}): Promise<number> {
  const out = io.out ?? ((l: string) => process.stdout.write(l + "\n"));
  const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
  const exit = io.exit ?? ((c: number) => process.exit(c));
  const json = wantsJsonOutput(argv.slice(2));

  applyExitOverride(program);
  // 请求了 JSON 时抑制 Commander 自己的纯文本 stderr 输出，使 `--json` 失败
  // 只吐出（下方的）JSON 错误对象；非 JSON 模式保留熟悉的 stderr 文本。
  // 作用于整条命令树。
  const suppressErr = (cmd: Command) => {
    cmd.configureOutput({
      writeErr: (str: string) => {
        if (json) return;
        const trimmed = str.replace(/\n$/, "");
        // 仅把 Commander 已知模板本地化为中文；其余消息原样输出，
        // 避免误改守护进程/用户数据。
        err(localizeCommanderMessage(trimmed) ?? trimmed);
      },
    });
    for (const sub of cmd.commands) suppressErr(sub);
  };
  suppressErr(program);

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (e) {
    if (isCleanCommanderExit(e)) return 0;
    // 响应完整性：在通用路径之前如实渲染守护进程传输失败（三段式、两种模式、
    // 诚实的非零退出）——否则抛出的响应异常/超时在 --json 下晦涩难懂，
    // 人类运行时更会完全静默。
    if (renderDaemonTransportError(e, { out, err, json })) {
      exit(1);
      return 1;
    }
    const code = (e as CommanderLikeError)?.exitCode ?? 1;
    if (json) {
      out(JSON.stringify(formatCliError(e)));
    }
    //（非 JSON 纯文本已在上方 configureOutput.writeErr 中输出）
    exit(code || 1);
    return code || 1;
  }
}
