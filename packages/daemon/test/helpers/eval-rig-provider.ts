import type { EvalProvider, EvalRunResult } from "./eval-provider.js";

/** 支撑持久 provider 模式（Test-A）的 live seat session。实现由非作者负责 live 接线（通过 rig CLI
 *  spawn、通过 transport capture）；此 interface 是 orchestration 的证明接缝。 */
export interface RigSeatSession {
  /** 支撑此 session 的 live seat generation 稳定 identity——persistence proof 会跨 phase 比较它。 */
  generation: string;
  sendPrompt(prompt: string): Promise<void>;
  /** 捕获发送 `prompt` 后产生的 pane/transcript 内容。实现返回 raw capture；provider 负责
   *  input-echo contamination control。 */
  captureSince(prompt: string): Promise<string>;
  retire(): Promise<void>;
}

export interface RigSeatProviderOptions {
  /**
   * 修复 2：已启动 seat 用于解析 ref 的准确生产 package（packaged builtin library）——不是手工
   * seed 的 fixture root——使 fixture-vs-production drift 从结构上失败。seat 通过生产
   * `rig context get skills/<ns>/<name>` 拉取。
   */
  productionPackage: string;
  /** 非作者接入 live 时，供 eval fork 的 seat spec / model。 */
  seatSpec?: string;
  /** Test-A（row 782b467a）：SESSION-PERSISTENT 模式——baseline -> WALK -> GET -> post 全程使用
   *  同一 seat/generation。惰性调用 spawn 一次；dispose() 前每次 run() 都复用同一 session。 */
  session?: { spawn: () => Promise<RigSeatSession> };
}

/**
 * slice-07 R6——LIVE-SEAT provider：proof-contract PULL-WORKS / AGENT-DRIVEN 门。
 *
 * 唯一 EvalProvider 接缝背后的两种模式（Test-A 完成延后的 live 环节，不重新设计 harness）：
 *
 * - SESSION-PERSISTENT（Test-A）：`session.spawn` 提供 live RigSeatSession；provider 惰性启动一次，
 *   每次 run() 都复用同一 seat/generation（baseline -> WALK -> GET -> post phase 是 driver 连续的
 *   run() 调用），并负责 INPUT-ECHO contamination control：从返回 transcript 中剥离 prompt 的
 *   leading echo（pane 回显输入），使确定性 door 绝不能只匹配 prompt 自身文本而通过；seat 稍后的
 *   真实引用会保留（剥离每次出现会伪造真实输出）。dispose() 只退役 seat 一次；dispose 后 run()
 *   会显著拒绝。
 *
 * - LEGACY（无 session 依赖）：抛错——而不是返回貌似合理的空 transcript——使 live 接线存在前，
 *   live run 绝不会显示为 false green。改用 `--provider fake` 运行 harness。
 */
export class RigSeatProvider implements EvalProvider {
  readonly name = "rig-seat";
  private session: RigSeatSession | null = null;
  private disposed = false;
  private spawnError: string | null = null;

  constructor(private readonly opts: RigSeatProviderOptions) {}

  async run(prompt: string): Promise<EvalRunResult> {
    if (!this.opts.session) {
      throw new Error(
        "RigSeatProvider 是 live proof-contract 门，目前尚未驱动。非作者负责接入 seat spawn——针对生产 " +
          "package 解析 canonical ref（skills/<ns>/<name>），而不是使用 fixture override，使 " +
          "fixture-vs-production drift 从结构上失败——随后在此执行 natural-prompt send 与 transcript " +
          "capture，并进行 live 验证。在此之前，请使用 --provider fake。参见 " +
          "packages/test-system/evals/README.md.",
      );
    }
    if (this.disposed) {
      throw new Error("RigSeatProvider session 已 retired/disposed——后续运行需要新的 provider（及 seat）。");
    }
    if (this.spawnError !== null) {
      // spawn 失败会使本次运行失效：按用例重新 spawn 会为每个剩余用例反复创建一个 scratch rig
      //（live 实测：泄漏六个 rig）。
      throw new Error(`RigSeatProvider：本次运行中的 seat spawn 已失败——${this.spawnError}`);
    }
    if (!this.session) {
      try {
        this.session = await this.opts.session.spawn();
      } catch (err) {
        this.spawnError = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }
    const started = Date.now();
    await this.session.sendPrompt(prompt);
    const raw = await this.session.captureSince(prompt);
    return { transcript: stripLeadingEcho(raw, prompt), durationMs: Date.now() - started };
  }

  /** 退役 persistent seat。幂等；只有首次调用会执行退役。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.session) {
      await this.session.retire();
      this.session = null;
    }
  }
}

/** input-echo contamination control：从 raw capture 中删除 prompt 的 leading occurrence
 *（pane 回显的输入行）。只删除 leading echo——seat 稍后引用 prompt 时，该文本由 seat 自身产生；
 * 删除它会伪造真实输出。 */
function stripLeadingEcho(raw: string, prompt: string): string {
  let out = raw;
  if (out.startsWith(prompt)) {
    out = out.slice(prompt.length);
    if (out.startsWith("\n")) out = out.slice(1);
  }
  return out;
}
