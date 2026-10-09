// OPR.0.5.1.1——stub COMPACTION 行为执行器（A5 第 6–8 项）。
//
// PRD §4.3/§4.4（架构 R3，绑定）：stub 触发准确的已发布 compaction 接缝，绝不捏造输出。
// 在 `emit compaction` 脚本步骤中，runner 调用 fireCompaction，后者启动真实的
// precompact-hook.mjs——即真实 Claude 席位在 PreCompact 时运行的同一产品资产——从而写入按席位
// 定键的 restore-pending 标记，供真实 compaction-restore-bridge 稍后投递。可观察结果（真实键控
// 标记 + 生成的包）与生产环境一致，并在共享可注入时钟 OPENRIG_TEST_CLOCK_NOW 下保持确定性。
//
// 本质上有副作用（会启动子进程）；与纯 stub-script 模型分离，使后者保持隔离。

import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";

export interface FireCompactionOpts {
  /** 已发布 precompact-hook.mjs 的绝对路径（调用方从已安装插件布局解析；缺失时
   * fireCompaction 快速失败）。 */
  hookScriptPath: string;
  /** 席位的 canonical session 名称——标记键（身份）。 */
  sessionName: string;
  /** 接缝读写 restore-pending 标记所用的 OPENRIG_HOME。 */
  openrigHome: string;
  /** 席位的托管 cwd（用于生成包与发现 transcript）。 */
  cwd: string;
  /** 用于确定性生成包的显式 JSONL transcript（可选；缺失时回退到钩子自身的最新 transcript
   * 发现逻辑）。 */
  transcriptPath?: string;
  /** 转发给接缝 stamp 的确定性时钟注入（ISO 时刻）。 */
  injectClockNow?: string;
}

export interface CompactionResult {
  /** 真实接缝写入的按席位定键 restore-pending 标记绝对路径。 */
  markerPath: string;
}

/** 明确的类型化失败——钩子缺失或接缝未生成标记时必须失败，绝不能静默跳过并让席位看起来
 * 已干净完成 compaction。 */
export class StubCompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubCompactionError";
  }
}

/** 标记键清理器——必须与 precompact-hook.mjs/compaction-restore-bridge.cjs 匹配
 *（字符类相同），确保接缝写入的标记就是我们解析的标记。 */
function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

/** 为 stub 席位触发真实 precompact 接缝，并返回其写入的标记。 */
export function fireCompaction(opts: FireCompactionOpts): CompactionResult {
  // HIGH-6 存在性契约：绝不调用不存在的钩子；快速、明确地失败。
  if (!nodeFs.existsSync(opts.hookScriptPath)) {
    throw new StubCompactionError(`未找到 precompact 钩子脚本：${opts.hookScriptPath}`);
  }

  const hookInput: Record<string, unknown> = { cwd: opts.cwd };
  if (opts.transcriptPath) hookInput.transcript_path = opts.transcriptPath;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENRIG_HOME: opts.openrigHome,
    OPENRIG_SESSION_NAME: opts.sessionName,
    // 不允许游离的 RIGGED_HOME 覆盖隔离的 OPENRIG_HOME。
    RIGGED_HOME: undefined,
    OPENRIG_TEST_CLOCK_NOW: opts.injectClockNow,
  } as NodeJS.ProcessEnv;

  const result = spawnSync(process.execPath, [opts.hookScriptPath], {
    input: JSON.stringify(hookInput),
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new StubCompactionError(
      `precompact 钩子退出，退出码 ${result.status}：${(result.stderr || result.stdout || "未知错误").trim()}`,
    );
  }

  const markerPath = nodePath.join(
    opts.openrigHome, "compaction", "restore-pending", `${sanitizeKey(opts.sessionName)}.json`,
  );
  if (!nodeFs.existsSync(markerPath)) {
    // 接缝已运行但未生成标记（例如生成包失败）——stub 必须暴露该事实，不能报告虚假的 compaction。
    throw new StubCompactionError(
      `precompact 钩子未在 ${markerPath} 生成 restore-pending 标记`,
    );
  }
  return { markerPath };
}
