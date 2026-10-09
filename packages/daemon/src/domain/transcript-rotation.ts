// V1 预发布 CLI/后台服务第 1 项——有界尾部 transcript 轮转。
//
// 用周期执行的 `tmux capture-pane -t <session> -p -S -<lines>` 替代旧版 `tmux pipe-pane`
// 机制（文件无限增长），并原子覆盖 transcript 文件。文件大小由尾部行数和单行字节上限约束，
// 而非由会话持续时间决定。
//
// 可调项（环境变量 OPENRIG_TRANSCRIPTS_LINES / OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS；
// allowlist key 为 transcripts.lines / transcripts.poll_interval_seconds）：
//   - lines：          每个 tick 捕获的尾部行数（默认 1000）
//   - pollIntervalMs： tick 间隔毫秒数（默认 2000）
//
// SC-29 例外 #4 已在预发布 CLI/后台服务 ACK §5 声明。

import * as fs from "node:fs";
import * as path from "node:path";
import { readOpenRigEnv } from "../openrig-compat.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

export interface TranscriptRotationOptions {
  /** 每个 tick 捕获的尾部行数。 */
  lines: number;
  /** 轮询间隔，单位毫秒。 */
  pollIntervalMs: number;
}

export const DEFAULT_TRANSCRIPT_LINES = 1000;
export const DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS = 2000;

/** 从环境变量解析轮转选项，并在缺失时回退默认值。文件存储配置
 *（zrig config set transcripts.lines …）由后台服务在启动时通过 settings-store 加载；
 * 需要文件存储值的消费者也可显式传入 options 对象。 */
export function getTranscriptRotationOptionsFromEnv(): TranscriptRotationOptions {
  const linesRaw = readOpenRigEnv("OPENRIG_TRANSCRIPTS_LINES");
  const pollRaw = readOpenRigEnv("OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS");
  const lines = parsePositiveInt(linesRaw, DEFAULT_TRANSCRIPT_LINES);
  const pollSeconds = parsePositiveInt(pollRaw, DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS / 1000);
  return { lines, pollIntervalMs: pollSeconds * 1000 };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

const activeTimers = new Map<string, NodeJS.Timeout>();

// 存活性与文件 mtime 解耦。只有完整健康的 tick 才在此记录时间戳：内容未变化而提前返回
//（文件已有当前字节）或原子 rename 成功之后。单纯 capture 成功并不够；若随后必需的持久化失败，
// 绝不能拿陈旧磁盘字节宣称新鲜。getIngestHealth 读取此记录，并以 mtime 回退。
// 以全局唯一的 sessionName（{pod}-{member}@{rig}）为 key。
const lastCaptureAtBySession = new Map<string, number>();

// 每次 start 都有 generation token。stop() 或替代性的 start() 会使会话条目失效，
// 因而异步 capture 后恢复执行的在途 tick 无法为已停止/替换的会话复活存活状态或写文件。
let rotationGeneration = 0;
const activeGeneration = new Map<string, number>();

/** 会话最近一次成功 capture 的时间（epoch ms）；本进程尚未为其 capture 时为 undefined。
 * getIngestHealth 读取此值，使 ingest 存活性与因抑制写入而不变的文件 mtime 解耦。 */
export function getLastCaptureAt(sessionName: string): number | undefined {
  return lastCaptureAtBySession.get(sessionName);
}

/** 启动逐会话 capture-pane 轮转定时器。操作幂等：同一会话再次 start 会替换首个定时器。
 * 第一个 tick 立即执行，使 transcript 文件在首个轮询间隔结束前就有内容。 */
export function startTranscriptRotation(
  tmuxAdapter: TmuxAdapter,
  sessionName: string,
  outputPath: string,
  opts: TranscriptRotationOptions,
): void {
  stopTranscriptRotation(sessionName);

  const myGeneration = ++rotationGeneration;
  activeGeneration.set(sessionName, myGeneration);
  // 仅当本次 start 仍是该会话当前轮转时为 true；stop() 或替代 start() 执行后变为 false。
  // 它保护异步间隙，使陈旧在途 tick 不写文件也不记录存活性。
  const isCurrent = (): boolean => activeGeneration.get(sessionName) === myGeneration;

  const tick = async (): Promise<void> => {
    try {
      if (!isCurrent()) return;
      const content = await tmuxAdapter.capturePaneContent(sessionName, opts.lines);
      // 异步 capture 后重新检查；等待期间可能已执行 stop()/替换。死亡会话（null）刻意不记录，
      // 使 getIngestHealth 对它回退到陈旧 mtime。
      if (content === null || !isCurrent()) return;

      // 保留恢复 orchestrator 在启动前写入 transcript 文件的 SESSION BOUNDARY 行，否则
      // capture-pane 在第一个 tick 覆盖时会将其清除。该 marker 是 transcript 文件跨轮转
      // 唯一应保留的结构化 header；其他内容都是 capture-pane 的 terminal scrollback。
      let header = "";
      let prevContent: string | null = null;
      try {
        if (fs.existsSync(outputPath)) {
          const prev = fs.readFileSync(outputPath, "utf8");
          prevContent = prev;
          const boundaryLines = prev
            .split("\n")
            .filter((line) => line.startsWith("--- SESSION BOUNDARY:"));
          if (boundaryLines.length > 0) header = boundaryLines.join("\n") + "\n";
        }
      } catch {
        // 尽力读取 header；文件缺失或读取错误表示没有 header，也没有 prevContent，
        // 因此下方守卫不会抑制真实写入。
      }

      // 内容未变化守卫：若 transcript 文件已有完全相同的字节，则跳过临时写入与 rename。
      // 否则每 2 秒的 tick 会无条件重写所有 transcript 文件，macOS 经 fseventsd 放大后，
      // 会在数百席位规模造成主机 CPU/RSS 风暴。`prevContent` 复用 boundary 提取时的同一次读取，
      // 不增加 I/O。
      const payload = header + content;
      if (prevContent !== null && prevContent === payload) {
        // 文件已持有完全相同的字节（已持久化且为当前值），因此本次 tick 完整健康：
        // 记录存活性并跳过重写。
        lastCaptureAtBySession.set(sessionName, Date.now());
        return;
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const tmpPath = `${outputPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, payload);
      fs.renameSync(tmpPath, outputPath);
      // 持久化已成功，此刻 tick 才算健康，可以记录存活性。上方抛错会直接进入 catch，
      // 不会到达此处，因此必需写入失败时存活性不会前进，getIngestHealth 读取正确的陈旧 mtime。
      lastCaptureAtBySession.set(sessionName, Date.now());
    } catch {
      // 尽力 capture：目标会话可能已退出，输出路径可能不可写。下一 tick 会重试；
      // 此处失败不会冒泡到后台服务的启动/生命周期路径。
    }
  };

  void tick();
  const timer = setInterval(tick, opts.pollIntervalMs);
  // 不要仅因 transcript 定时器而阻止后台服务进程退出。
  if (typeof timer.unref === "function") timer.unref();
  activeTimers.set(sessionName, timer);
}

/** 清除会话的轮转定时器；没有已登记定时器时调用也安全。 */
export function stopTranscriptRotation(sessionName: string): void {
  const timer = activeTimers.get(sessionName);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(sessionName);
  }
  // 删除存活记录：轮转停止后 capture 确实已停止，getIngestHealth 应回退到 mtime，
  // 从而正确读出陈旧状态。
  lastCaptureAtBySession.delete(sessionName);
  // 使 generation 失效，确保本次 start 的在途 tick 在异步 capture 后退出，
  // 不会复活存活性或继续写入。
  activeGeneration.delete(sessionName);
}

/** 仅供测试：活动 rotator 数量。生产代码不应依赖此值。 */
export function getActiveRotationCount(): number {
  return activeTimers.size;
}

/** 仅供测试：清除所有活动 rotator。生产代码不应调用；单个会话请用 stopTranscriptRotation。 */
export function clearAllTranscriptRotationsForTest(): void {
  for (const timer of activeTimers.values()) clearInterval(timer);
  activeTimers.clear();
  lastCaptureAtBySession.clear();
  activeGeneration.clear();
}
