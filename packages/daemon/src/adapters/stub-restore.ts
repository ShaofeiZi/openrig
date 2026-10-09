// OPR.0.5.1.1——stub RESTORE 行为执行器（A5 第 6–8 项）。
//
// PRD §4.3/§4.4（架构 R3，绑定）：stub 触发准确的已发布 restore 接缝，绝不捏造输出。
// 在 `emit restore` 脚本步骤中，runner 调用 fireRestore，后者启动真实的
// compaction-restore-bridge.cjs——即真实 Claude 席位在 SessionStart(matcher=compact)/
// UserPromptSubmit 时运行的同一产品资产——从而读取当前席位的键控 restore-pending 标记
//（由 precompact 接缝写入），注入一条 hookSpecificOutput.additionalContext 恢复指令，并在标记上
// 盖上 deliveredAt/deliveryCount（一次性）。可观察结果（真实注入指令 + 已盖章标记）与生产环境
// 一致，并在共享可注入时钟 OPENRIG_TEST_CLOCK_NOW 下保持确定性。
//
// 没有待处理标记时，restore 合法地执行空操作（无内容可投递）；这不是错误（不同于触发
// compaction 后未生成标记）：bridge 保持静默，fireRestore 报告 delivered=false，runner 如实镜像。
//
// 本质上有副作用（会启动子进程）；与纯 stub-script 模型分离，使后者保持隔离。与
// stub-compaction.ts 对称。

import nodeFs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";

export interface FireRestoreOpts {
  /** 已发布 compaction-restore-bridge.cjs 的绝对路径（调用方从已安装插件布局解析；缺失时
   * fireRestore 快速失败）。 */
  bridgeScriptPath: string;
  /** 席位的 canonical session 名称——标记键（身份）。 */
  sessionName: string;
  /** 席位自身创建的 transcript 路径——与 compaction 接缝在标记上记录的身份
   *（marker.transcriptPath）相同。只有投递事件的 transcript_path 与标记中记录的 compaction
   * 匹配时，bridge 的 R5 前提门禁才投递；真实 SessionStart/UserPromptSubmit 事件会携带它。
   * 省略它会使门禁正确拒绝无身份事件，因而不会投递任何内容。 */
  transcriptPath: string;
  /** 接缝读取 restore-pending 标记所用的 OPENRIG_HOME。 */
  openrigHome: string;
  /** 席位的托管 cwd（钩子 payload 的一部分）。 */
  cwd: string;
  /** 执行投递的钩子事件（SessionStart/UserPromptSubmit）。默认为 UserPromptSubmit——
   * bridge 自身的默认值，也是实际投递触发器。 */
  hookEventName?: string;
  /** 转发给接缝 stamp 的确定性时钟注入（ISO 时刻）。 */
  injectClockNow?: string;
}

export interface RestoreResult {
  /** 注入的恢复指令（hookSpecificOutput.additionalContext）；未投递任何内容时为 null
   *（没有待处理标记，或标记已投递）。 */
  additionalContext: string | null;
  /** 接缝读取/盖章的按席位定键 restore-pending 标记绝对路径。 */
  markerPath: string;
  /** 当且仅当 bridge 在本次调用确实注入恢复指令时为 true。 */
  delivered: boolean;
}

/** 明确的类型化失败——bridge 缺失或以非零状态退出时必须失败，绝不能静默跳过并让席位看起来
 * 已恢复，实际却没有。 */
export class StubRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubRestoreError";
  }
}

/** 标记键清理器——必须与 compaction-restore-bridge.cjs/precompact-hook.mjs 匹配
 *（字符类相同），确保接缝定键的标记就是我们解析的标记。 */
function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

/** 为 stub 席位触发真实 restore bridge，并返回其注入的指令。 */
export function fireRestore(opts: FireRestoreOpts): RestoreResult {
  // HIGH-6 存在性契约：绝不调用不存在的 bridge；快速、明确地失败。
  if (!nodeFs.existsSync(opts.bridgeScriptPath)) {
    throw new StubRestoreError(`未找到 restore bridge 脚本：${opts.bridgeScriptPath}`);
  }

  const hookInput: Record<string, unknown> = {
    hook_event_name: opts.hookEventName ?? "UserPromptSubmit",
    cwd: opts.cwd,
    session_name: opts.sessionName,
    // 通过 bridge 前提门禁传入标记的真实 compaction 身份（真实事件结构），绝不削弱门禁。
    // 缺少它时，门禁会拒绝投递。
    transcript_path: opts.transcriptPath,
  };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENRIG_HOME: opts.openrigHome,
    OPENRIG_SESSION_NAME: opts.sessionName,
    // 不允许游离的 RIGGED_HOME 覆盖隔离的 OPENRIG_HOME。
    RIGGED_HOME: undefined,
    OPENRIG_TEST_CLOCK_NOW: opts.injectClockNow,
  } as NodeJS.ProcessEnv;

  const result = spawnSync(process.execPath, [opts.bridgeScriptPath], {
    input: JSON.stringify(hookInput),
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new StubRestoreError(
      `restore bridge 退出，退出码 ${result.status}：${(result.stderr || result.stdout || "未知错误").trim()}`,
    );
  }

  const markerPath = nodePath.join(
    opts.openrigHome, "compaction", "restore-pending", `${sanitizeKey(opts.sessionName)}.json`,
  );

  // 只有实际投递当前席位标记时，bridge 才向 stdout 写入 hookSpecificOutput.additionalContext
  // 指令；空输出或非 JSON 输出表示未投递任何内容（没有待处理标记或标记已投递），这是诚实的
  // 空操作，不是失败。
  let additionalContext: string | null = null;
  const out = (result.stdout || "").trim();
  if (out.length > 0) {
    try {
      const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: unknown } };
      const ctx = parsed?.hookSpecificOutput?.additionalContext;
      if (typeof ctx === "string" && ctx.length > 0) additionalContext = ctx;
    } catch {
      // 非 JSON stdout = 未投递内容；additionalContext 保持 null。
    }
  }
  return { additionalContext, markerPath, delivered: additionalContext !== null };
}
