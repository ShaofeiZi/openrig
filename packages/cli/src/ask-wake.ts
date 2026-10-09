import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WakeRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** 运行一个有界超时的无头一次性命令。可注入，用于测试。 */
export type WakeRunner = (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<WakeRunResult>;

export interface WakeDeps {
  runner: WakeRunner;
  /** 定位会话文件以给出大小建议（pin 5）。可选。 */
  fileLocator?: (token: string) => { path: string; sizeBytes: number } | null;
}

export interface WakeArgs {
  question: string;
  token: string;
  runtime: "claude" | "codex";
  timeoutMs?: number;
}

export interface WakeOutcome {
  ran: boolean;
  answer?: string;
  timedOut?: boolean;
  /** 当 wake 进程以非零退出码退出时为 true（token 无效 / 缺少二进制 /
   *  认证失败）——这是诚实的失败，不是成功的空答案。 */
  failed?: boolean;
  code?: number;
  message?: string;
  advisory?: string;
}

/** 默认有界 wake 超时——足够长以完成真实回忆，又足够短
 *  使得挂起能暴露出来而不是永远阻塞（创始人数据点：635 MB 会话文件约数分钟）。 */
export const DEFAULT_WAKE_TIMEOUT_MS = 180_000;
const WAKE_LARGE_FILE_BYTES = 200 * 1024 * 1024; // 200 MB
/** wake 提示词默认无开场白——直接给答案，不写小作文（pin 5）。 */
const NO_PREAMBLE = "Answer directly and concisely, with no preamble. Question: ";

/**
 * 构建无头一次性恢复命令。`claude -p --resume <token>`
 * 打印答案后退出——wake 目标是会话文件，因此进程回到冷态，
 * 不留残余进程（pin 2/3，mini-PRD A）。
 * codex 使用 `codex exec resume`（适配器诚实；会话文件大小滞后于主机）。
 */
export function buildWakeCommand(runtime: "claude" | "codex", token: string, question: string): { cmd: string; args: string[] } {
  const prompt = `${NO_PREAMBLE}${question}`;
  if (runtime === "codex") {
    return { cmd: "codex", args: ["exec", "resume", token, prompt] };
  }
  return { cmd: "claude", args: ["-p", "--resume", token, prompt] };
}

/** 默认运行器：execFile 加硬超时。resolve 意味着子进程已退出（回到冷态）——
 *  我们从不保留句柄。 */
export const defaultWakeRunner: WakeRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
      const timedOut = !!(e && e.killed && e.signal === "SIGTERM");
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        timedOut,
      });
    });
  });

/** 大小建议的默认文件定位器：扫描 ~/.claude/projects/<cwd>/<token>.jsonl。 */
export function defaultWakeFileLocator(token: string): { path: string; sizeBytes: number } | null {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(root, d.name, `${token}.jsonl`);
      if (existsSync(p)) return { path: p, sizeBytes: statSync(p).size };
    }
  } catch {
    /* 仅尽力而为的建议 */
  }
  return null;
}

/**
 * L3 — 通过恢复 token 唤醒会话，问一个（可能批量的）问题，
 * 捕获快照答案，然后让进程回到冷态。会执行——
 * 这是唯一有运行时成本/副作用的层级；它只在显式调用时运行
 * （绝不从失败的 L1/L2 搜索隐式升级）。有界超时 + 大文件建议——绝不静默挂起。
 */
export async function runWake(deps: WakeDeps, args: WakeArgs): Promise<WakeOutcome> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;

  let advisory: string | undefined;
  const located = deps.fileLocator?.(args.token);
  if (located && located.sizeBytes > WAKE_LARGE_FILE_BYTES) {
    advisory = `会话文件较大（${(located.sizeBytes / 1024 / 1024).toFixed(0)} MB）；唤醒可能需要数分钟——大会话文件滞后于主机。如果挂起，请用更长的超时重试或后台唤醒。`;
  }

  const { cmd, args: cmdArgs } = buildWakeCommand(args.runtime, args.token, args.question);
  const res = await deps.runner(cmd, cmdArgs, { timeoutMs });

  if (res.timedOut) {
    return {
      ran: true,
      timedOut: true,
      advisory,
      message: `wake 在 ${Math.round(timeoutMs / 1000)}s 内未返回。会话可能很大或很慢——请用更长的 --wake-timeout 重试或后台唤醒。这是有界超时，不是静默挂起。`,
    };
  }

  // 非零退出是失败，不是成功的空答案——诚实暴露
  // （与 L1/L2 诚实降级相同的原则）。只有退出 0 才是答案。
  if (res.code !== 0) {
    const detail = res.stderr.trim();
    return {
      ran: true,
      failed: true,
      code: res.code ?? undefined,
      advisory,
      message: `wake 失败（退出码 ${res.code ?? "未知"}）${detail ? `：${detail}` : ""}。token 可能无效/已过期、运行时二进制缺失或需要认证。`,
    };
  }

  return { ran: true, answer: res.stdout.trim(), advisory };
}
