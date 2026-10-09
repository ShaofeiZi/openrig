// 已提交的真实 StagingDocker 调用器（创始人于 2026-08-21 裁定，是 container-runner
// 范围界定中与引擎无关的部分——workspace/artifacts/qitem-20260821183159-9b5b5117/）。
//
// 为何以代码而非 runbook 文字存在：L6 runbook 的内联调用器
//（`const docker = (args) => execFile("docker", args, …)`）写于 08-06，并未包含 08-07
// 新增的 stdinFrom tar 管道契约（scenario-container-stage.ts:20-28）——execFile 为子进程
// 留下持续打开却没有数据输入的管道 stdin，导致容器内 `tar -xf -` 永久阻塞在 read(stdin)
//（第 42576855 行：子进程卡住 7 分钟以上，父进程存活且无输出）。内联在文档中的调用器
// 会落后于代码契约且没有测试失败信号；runbook 导入的已提交辅助模块则受契约自身测试覆盖。
//
// 实施的契约（StagingDocker，scenario-container-stage.ts）：
// - 没有 stdinFrom → 普通 spawn，忽略 stdin（生成时关闭）：读取 stdin 的子进程遇到 EOF
//   后终止，而不是阻塞——即使步骤误用，也可消除此类卡死。
// - 有 stdinFrom → 两个进程：`tar <stdinFrom>` 管道接入 `docker <argv>` 的 stdin，
//   producer 退出时传播 EOF。检查两个进程的退出状态——shell 管道只报告最后一个命令的
//   状态，因此 tar 失败而 exec 成功会掩盖空 stage（防护在后期要捕获的假绿类型；此处
//   在步骤发生时立即捕获）。
// - 每一步均受超时限制；超时会终止两个进程并返回具名失败——08-12 的卡死没有边界，
//   直到七分钟时由操作者判断才结束。
// - 从不 reject（与 runRig 一致）：每个结果都是 DockerResult，失败时 code 非零，
//   stderr 中包含原因。
//
// 范围：本文件以隔离方式证明调用器，不对真实容器隔离作任何声明——真实引擎证明
//（docker 与 Apple container；后者对该管道的 exec-stdin 语义尚未测试）明确等待 5.3
// 引擎底座裁定。

import { spawn } from "node:child_process";
import type { StagingDocker } from "./scenario-container-stage.js";

export interface RealStagingDockerOptions {
  /** 引擎二进制文件（默认 "docker"）。测试以 "sh" 替代，以保持隔离。 */
  command?: string;
  /** stdinFrom 步骤的 tar 侧二进制文件（默认 "tar"）。 */
  tarCommand?: string;
  /** 每步时限。默认 120 秒——按拓扑目录解压规模设置，而非构建规模。超过时限的步骤会
   *  被终止并报告具名超时，绝不会继续卡住。 */
  stepTimeoutMs?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 120_000;

interface ProcExit {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/** 构建满足 StagingDocker 契约的真实双进程调用器。 */
export function makeRealStagingDocker(opts: RealStagingDockerOptions = {}): StagingDocker {
  const command = opts.command ?? "docker";
  const tarCommand = opts.tarCommand ?? "tar";
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  return async (args: string[], stdinFrom?: string[]) => {
    const kills: Array<() => void> = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      for (const kill of kills) kill();
    }, stepTimeoutMs);

    try {
      // consumer 侧。没有 producer 时忽略 stdin（生成时关闭）：读取 stdin 的子进程立即看到
      // EOF——这正是内联调用器留下的缺口。
      const consumer = spawn(command, args, {
        stdio: [stdinFrom ? "pipe" : "ignore", "pipe", "pipe"],
      });
      kills.push(() => consumer.kill("SIGKILL"));

      let producerDone: Promise<ProcExit> | null = null;
      let producerClosed = false;
      let producerKilledEarly = false;
      let killProducer: (() => void) | null = null;
      if (stdinFrom) {
        const producer = spawn(tarCommand, stdinFrom, { stdio: ["ignore", "pipe", "pipe"] });
        killProducer = () => producer.kill("SIGKILL");
        kills.push(killProducer);
        // 接线上的 EPIPE（consumer 提前退出）不得使调用器崩溃——producer 自身因 SIGPIPE
        // 终止才是明确信号，并通过下方的双退出检查报告。
        consumer.stdin!.on("error", () => {});
        producer.stdout!.pipe(consumer.stdin!); // producer 退出时 pipe() 转发 EOF。
        producerDone = waitExit(producer).then((exit) => { producerClosed = true; return exit; });
      }

      const consumerExit = await waitExit(consumer);
      // consumer 已退出但 producer 仍在运行：producer 的 stdout 此时积压在无人读取的
      // 管道中，会永久阻塞（已实测——此调用器的第一版就在此卡住）。终止 producer 并报告
      // 异常：无论退出码如何，在输入完成前退出的 consumer 都未暂存输入携带的全部内容。
      if (producerDone && !producerClosed) {
        producerKilledEarly = true;
        killProducer!();
      }
      const producerExit = producerDone ? await producerDone : null;
      clearTimeout(timer);

      if (timedOut) {
        return {
          stdout: consumerExit.stdout,
          stderr:
            `step timeout: killed after ${stepTimeoutMs}ms (${command} ${args[0] ?? ""}` +
            `${stdinFrom ? ` fed by ${tarCommand}` : ""}) — a stalled step is a NAMED failure, never a hang`,
          code: 124,
        };
      }

      // 双退出：consumer 失败时以其 code 为准；否则 producer 失败（包括被信号终止——
      // consumer 提前退出引发 SIGPIPE，意味着内容未到达）会使步骤失败并指明 tar 侧，
      // 不受 consumer 退出结果影响。
      if (consumerExit.code !== 0 || consumerExit.spawnError) {
        return {
          stdout: consumerExit.stdout,
          stderr: consumerExit.spawnError ?? consumerExit.stderr,
          code: consumerExit.code,
        };
      }
      if (producerKilledEarly) {
        return {
          stdout: consumerExit.stdout,
          stderr:
            `tar-side (stdinFrom) was still producing when the consumer exited (${command} exited ` +
            `${consumerExit.code} early) — producer killed; the stage did not receive the full feed`,
          code: 1,
        };
      }
      if (producerExit && (producerExit.code !== 0 || producerExit.spawnError)) {
        const cause = producerExit.spawnError
          ?? `exit ${producerExit.code}${producerExit.signal ? ` (signal ${producerExit.signal})` : ""}`;
        return {
          stdout: consumerExit.stdout,
          stderr:
            `tar-side (stdinFrom) failed: ${cause}${producerExit.stderr ? ` — ${producerExit.stderr.trim()}` : ""}` +
            ` — the consumer exited 0 but the stage cannot be trusted (masked-empty-stage class)`,
          code: producerExit.code !== 0 ? producerExit.code : 1,
        };
      }
      return { stdout: consumerExit.stdout, stderr: consumerExit.stderr, code: 0 };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 将子进程归结为 ProcExit——spawn 错误和信号终止均映射为非零 code，因此调用器从不
 *  reject，也绝不会把被信号终止的子进程报告为成功。 */
function waitExit(child: ReturnType<typeof spawn>): Promise<ProcExit> {
  return new Promise((resolveExit) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => {
      resolveExit({ code: 127, signal: null, stdout, stderr, spawnError: `spawn failed: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      resolveExit({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}
