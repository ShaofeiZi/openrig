/**
 * slice-07 R6——eval PROVIDER 接缝。runner 通过此接口驱动 case，因此 live-model executor
 * （启动真实席位、发送自然语言 prompt、捕获其执行内容）被限制在单一边界内；按 desk 裁定，其执行
 * 可选且延后，并受 API gate 控制。FakeProvider 无需访问模型即可让 harness 在 CI 和单元测试中
 * 确定地端到端运行。
 */

export interface EvalRunResult {
  /** 智能体产出的内容，即 grader 读取的已捕获 transcript。 */
  transcript: string;
  durationMs?: number;
  /** 传输或执行失败；与评分得到的 FAIL 不同。 */
  error?: string;
}

export interface EvalProvider {
  name: string;
  /** 运行一条自然语言 prompt（可选注入 context），并返回捕获到的 transcript。 */
  run(prompt: string, context?: string): Promise<EvalRunResult>;
}

/** 以 prompt 为 key、预置 transcript 为值的确定性 provider。 */
export class FakeProvider implements EvalProvider {
  readonly name = "fake";
  constructor(private readonly transcripts: Record<string, string>) {}

  async run(prompt: string): Promise<EvalRunResult> {
    const transcript = this.transcripts[prompt];
    if (transcript === undefined) {
      return { transcript: "", error: `FakeProvider：没有为 prompt ${JSON.stringify(prompt)} 配置预置 transcript` };
    }
    return { transcript };
  }
}
