// OPR.0.5.1.1——pane 承载的 stub-runner（A5/ContextMonitor 收口）。
//
// Pi 形 node 脚本 runner：stub adapter 将 `node <thisEntry> …` 输入席位 tmux pane；此进程
// 持久化后台服务轮询的 readiness sidecar，输出 READY 标记，然后作为 pane 的实时前台进程空闲
//（使 adapter 的 hasSession/atShell 活性交叉检查看到运行中的席位）。自调用守卫保证模块可安全
// 导入：除非本文件是进程入口，否则不会运行任何内容。
//
// 第 4 步范围：启动 + 持久化 readiness + 如实退出。四个 seed 行为
// {compaction, slow_output, mid_turn_death, restore} 与 ctx% context sidecar 是后续增量
//（A5 第 5–8 项），此处有意不模拟。

import nodeFs from "node:fs";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import {
  stubSeatSidecarPath,
  stubSeatScriptPath,
  STUB_RUNNER_READY_MARKER,
  STUB_RUNNER_EXIT_MARKER,
  STUB_RUNNER_ERROR_MARKER,
  type StubRunnerState,
} from "./stub-runner-protocol.js";
import { parseStubScript, DEFAULT_STUB_SCRIPT, type StubScript } from "./stub-script.js";
import { fireCompaction, type CompactionResult } from "./stub-compaction.js";
import { fireRestore, type RestoreResult } from "./stub-restore.js";

export interface StubRunnerArgs {
  sessionName: string;
  cwd: string;
  launchId: string;
  posture: "floor" | "full_bypass";
  resumeToken?: string;
}

/** 解析 runner argv（buildStubRunnerCommand 生成的标志）。纯函数。 */
export function parseStubRunnerArgs(argv: string[]): StubRunnerArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const sessionName = get("--session-name");
  const cwd = get("--cwd");
  const launchId = get("--launch-id");
  const postureRaw = get("--posture");
  if (!sessionName) throw new Error("stub-runner：必须提供 --session-name");
  if (!cwd) throw new Error("stub-runner：必须提供 --cwd");
  if (!launchId) throw new Error("stub-runner：必须提供 --launch-id");
  const posture = postureRaw === "full_bypass" ? "full_bypass" : "floor";
  return { sessionName, cwd, launchId, posture, resumeToken: get("--session") };
}

function writeSidecar(cwd: string, state: StubRunnerState): void {
  const sidecarPath = stubSeatSidecarPath(cwd);
  nodeFs.mkdirSync(nodePath.dirname(sidecarPath), { recursive: true });
  // 原子替换：先写入同级临时文件再重命名，避免轮询方读到只写了一半的 sidecar
  //（撕裂读取会误报 readiness）。
  const tmp = `${sidecarPath}.${process.pid}.tmp`;
  nodeFs.writeFileSync(tmp, JSON.stringify(state), "utf-8");
  nodeFs.renameSync(tmp, sidecarPath);
}

// ── 脚本执行接缝（镜像 pi-runner 的 RunnerIo）────────────────────────────────
// runner 针对注入的 effect 驱动脚本，使分发循环可隔离进行单元测试。R1 接入 compaction 行为；
// postActivity（事件 POST）是后续增量（R2）。now() 遵循同一注入时钟（PRD §5）。

export interface StubRunnerIO {
  /** 向席位 pane 输出一行。 */
  mirrorLine(line: string): void;
  /** 触发真实 precompact 接缝（架构 R3：触发，绝不伪造），并返回其写入的按席位定键
   * restore-pending 标记。 */
  fireCompaction(): CompactionResult;
  /** 触发真实 restore 读取器（compaction-restore-bridge.cjs）——架构 R3：触发，绝不伪造——
   * 并返回其投递的注入恢复指令；没有待处理标记可投递时返回 delivered=false 的空操作。 */
  fireRestore(): RestoreResult;
  /** 向 /api/activity/hooks 发出无需等待响应的 canonical activity 事件 POST。 */
  postActivity(payload: Record<string, unknown>): void;
  /** 在轮次中途终止席位（mid_turn_death）：记录 exited sidecar + EXIT 标记，再终止进程。
   * 真实 runner 从此不会返回。 */
  die(code: number): void;
  /** 可注入时钟（设置时用 OPENRIG_TEST_CLOCK_NOW，否则用真实墙上时钟）。 */
  now(): string;
}

/** mid_turn_death 的退出码——128+SIGKILL(9)，惯用的“进程被终止”代码，表示席位在轮次中途
 * 被终止。确定性且不同于错误路径。 */
export const STUB_MID_TURN_DEATH_EXIT_CODE = 137;

/** 席位的 activity 身份（镜像 pi-runner）。runtime 始终为 "stub"。 */
export interface StubActivityIdentity {
  sessionName: string;
  nodeId?: string;
}

/** 构建 canonical /api/activity/hooks payload——与真实 runtime POST 使用相同字段结构
 *（{runtime, sessionName, nodeId, hookEvent, subtype?, occurredAt}），使 stub 事件以相同方式
 * 驱动 agent-activity-store 状态。 */
export function stubActivityPayload(
  identity: StubActivityIdentity,
  hookEvent: string,
  subtype: string | null,
  occurredAt: string,
): Record<string, unknown> {
  return {
    sessionName: identity.sessionName,
    nodeId: identity.nodeId ?? null,
    runtime: "stub",
    hookEvent,
    subtype,
    occurredAt,
  };
}

/** slow_output 的固定分块数——把“脚本化速率”实现为确定性的多段 pane 序列
 *（不使用墙上时钟，也不增加可泄漏的 pacer 变量）。 */
export const SLOW_OUTPUT_CHUNKS = 3;

/** 针对注入的 IO 接缝逐步执行 stub 行为脚本。这里只做纯分发，不自带文件系统/时钟，因此可由
 * 假 IO 隔离驱动。一个脚本就是一个轮次：以 UserPromptSubmit activity（running）开始，以 Stop
 *（idle）结束——这是 51-02 场景 harness 读取的可观察状态转换。`say` 镜像其文本；
 * `emit compaction` 触发真实接缝；尚未接入的行为会如实显示延后，绝不静默空操作。 */
export function executeStubScript(script: StubScript, io: StubRunnerIO, identity: StubActivityIdentity): void {
  io.postActivity(stubActivityPayload(identity, "UserPromptSubmit", null, io.now()));
  for (const step of script.steps) {
    if (step.kind === "say") {
      io.mirrorLine(step.text);
      continue;
    }
    // step.kind === "emit"
    if (step.behavior === "compaction") {
      const { markerPath } = io.fireCompaction();
      io.mirrorLine(`[stub] 已触发 compaction——restore-pending 标记 ${markerPath}`);
      continue;
    }
    if (step.behavior === "slow_output") {
      // “按脚本速率输出”（PRD §4.2）以固定多段分块序列确定性实现——不使用墙上时钟/真实延迟
      //（§5），也不增加可泄漏的 pacer 变量。场景动词集（match/contains/equals）没有时间断言，
      // 因此分块多段 pane 输出就是可断言的“paced”观察（编排裁定 2026-08-06）。真实时间节奏只会
      // 作为未来语法扩展回归。
      for (let i = 1; i <= SLOW_OUTPUT_CHUNKS; i++) {
        io.mirrorLine(`[stub] slow_output 分块 ${i}/${SLOW_OUTPUT_CHUNKS}`);
      }
      continue;
    }
    if (step.behavior === "mid_turn_death") {
      // 席位在轮次中途终止：先输出部分轮次行，再结束。`return` 在尾部 Stop 前停止循环，因此钩子
      // 终止（已触发 UserPromptSubmit，没有 Stop）；这与生产环境中未完成轮次的特征一致。真实
      // runner 的 die() 会在此退出进程，因此之后的内容无论如何都不会运行。
      io.mirrorLine("[stub] mid_turn_death——正在轮次中途终止；钩子停止");
      io.die(STUB_MID_TURN_DEATH_EXIT_CODE);
      return;
    }
    if (step.behavior === "restore") {
      // 触发真实 restore 读取器（compaction-restore-bridge.cjs）：读取当前席位由先前
      // `emit compaction` 写入的键控 restore-pending 标记，注入一条 additionalContext 恢复
      // 指令，并在标记上盖 deliveredAt/deliveryCount（一次性）。runner 原样镜像已投递指令
      //（可观察且诚实——是真实注入上下文，绝不伪造）。没有待处理标记时，restore 合法空操作；
      // runner 会明确说明，而不是静默丢弃。
      const { additionalContext, delivered } = io.fireRestore();
      if (delivered && additionalContext) {
        io.mirrorLine("[stub] restore 已投递——注入的恢复指令：");
        io.mirrorLine(additionalContext);
      } else {
        io.mirrorLine("[stub] 已触发 restore——没有待投递的恢复标记");
      }
      continue;
    }
    // 四个 seed 行为均已在上方接入；此处 step.behavior 为 `never`。封闭 STUB_BEHAVIORS 并集之外
    // 的值只能绕过 parseStubScript 才能进入执行器，这是编程错误。必须明确失败，绝不静默空操作。
    throw new Error(
      `[stub] 未知行为 '${(step as { behavior: string }).behavior}'——不在 stub 行为集合中`,
    );
  }
  io.postActivity(stubActivityPayload(identity, "Stop", null, io.now()));
}

/** 解析席位行为脚本：存在时使用 <cwd>/.openrig/stub/script.json 中由场景解析的脚本，否则使用
 * 内置默认值。格式错误的场景脚本会明确失败（parseStubScript 抛错），绝不静默回退到默认值
 * 而掩盖损坏场景。 */
export function resolveStubScript(
  cwd: string,
  fsLike: { readFile(p: string): string; exists(p: string): boolean },
): StubScript {
  const scriptPath = stubSeatScriptPath(cwd);
  if (!fsLike.exists(scriptPath)) return DEFAULT_STUB_SCRIPT;
  return parseStubScript(fsLike.readFile(scriptPath));
}

/** 从脚本构建 stub 席位自身的 session transcript（真实 JSONL）。compaction 接缝必须压缩它，
 * 绝不能压缩外来 transcript：restore-from-jsonl 的 findLatestJsonl 会回退到
 * ~/.claude/projects，因此若不显式提供自身 transcript，stub 会不确定地压缩机器上最新的其他
 * transcript。创建并传入此文件，才能让 compaction 诚实（stub 压缩自身脚本化会话）且确定。 */
export function buildStubTranscript(
  script: StubScript,
  ctx: { sessionName: string; cwd: string; sessionId: string },
): string {
  const lines: string[] = [];
  const push = (role: "user" | "assistant", content: string) =>
    lines.push(JSON.stringify({
      sessionId: ctx.sessionId, sessionName: ctx.sessionName, cwd: ctx.cwd, message: { role, content },
    }));
  push("user", `[stub] scenario prompt for ${ctx.sessionName}`);
  for (const step of script.steps) {
    if (step.kind === "say") push("assistant", step.text);
  }
  // 即使脚本只含 emit，也保证至少有一个 assistant 轮次（analyze 需要内容）。
  if (lines.length <= 1) push("assistant", "[stub] scripted reply");
  return `${lines.join("\n")}\n`;
}

/** 解析 compaction 行为触发的已发布 precompact-hook.mjs。隔离测试中环境覆盖项
 * OPENRIG_STUB_PRECOMPACT_HOOK 优先；否则使用相对于此入口的打包资产——从 src/adapters
 *（tsx）与 dist/adapters（已编译）出发的相对路径相同，符合后台服务资产解析惯例。 */
export function resolveStubHookScriptPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENRIG_STUB_PRECOMPACT_HOOK;
  if (typeof override === "string" && override.trim().length > 0) return override;
  return nodePath.resolve(
    import.meta.dirname,
    "../../assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/precompact-hook.mjs",
  );
}

/** 解析 restore 行为触发的已发布 compaction-restore-bridge.cjs。隔离测试中环境覆盖项
 * OPENRIG_STUB_RESTORE_BRIDGE 优先；否则使用相对于此入口的打包资产——从 src/adapters
 *（tsx）与 dist/adapters（已编译）出发的相对路径相同，符合后台服务资产解析惯例。 */
export function resolveStubRestoreBridgePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENRIG_STUB_RESTORE_BRIDGE;
  if (typeof override === "string" && override.trim().length > 0) return override;
  return nodePath.resolve(
    import.meta.dirname,
    "../../assets/plugins/openrig-core/hooks/scripts/compaction-restore-bridge.cjs",
  );
}

/** 解析后台服务 activity endpoint（镜像 pi-runner）：优先环境变量（OPENRIG_URL +
 * OPENRIG_ACTIVITY_HOOK_TOKEN，或 OPENRIG_HOST:OPENRIG_PORT），再回退到
 * <OPENRIG_HOME>/activity-endpoint.json。二者都不可用时返回 null；activity POST 随后为空操作，
 * sidecar + pane 仍可工作。 */
export function resolveStubActivityEndpoint(env: NodeJS.ProcessEnv): { baseUrl: string; token: string } | null {
  let baseUrl = env.OPENRIG_URL?.trim() || null;
  let token = env.OPENRIG_ACTIVITY_HOOK_TOKEN?.trim() || null;
  if (!baseUrl && env.OPENRIG_PORT) {
    baseUrl = `http://${env.OPENRIG_HOST?.trim() || "127.0.0.1"}:${env.OPENRIG_PORT.trim()}`;
  }
  if (!baseUrl || !token) {
    try {
      const home = env.OPENRIG_HOME?.trim() || nodePath.join(env.HOME ?? "", ".openrig");
      const parsed = JSON.parse(nodeFs.readFileSync(nodePath.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string") baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string") token = parsed.token;
    } catch {
      // 缺失/格式错误——activity POST 为空操作；sidecar + mirror 仍可工作。
    }
  }
  return baseUrl && token ? { baseUrl, token } : null;
}

/** OPENRIG_TEST_CLOCK_NOW 启用时，stub runner 与已发布 precompact 钩子都会向 stderr 输出的
 * 明确提示。泄漏的测试时钟变量会静默冻结生产时间戳；此提示使任何泄漏在席位日志中可见
 *（安全措施，来自 review-r1 升级）。必须与 precompact-hook.mjs 中的字面量逐字节一致。 */
export const STUB_CLOCK_ANNOUNCEMENT = "OPENRIG_TEST_CLOCK_NOW active — timestamps are injected";

export async function runStubRunner(args: StubRunnerArgs): Promise<void> {
  // PRD §5（stub 自身行为不使用墙上时钟）：runner 自身 stamp 遵循 compaction 资产使用的同一
  // A3-R3 可注入时钟；设置时用 OPENRIG_TEST_CLOCK_NOW（ISO 时刻），否则用真实墙上时钟
  //（缺失 = 生产环境）。
  const injectedClock = process.env.OPENRIG_TEST_CLOCK_NOW;
  if (typeof injectedClock === "string" && injectedClock.trim().length > 0) {
    // eslint-disable-next-line no-console
    console.error(STUB_CLOCK_ANNOUNCEMENT); // 启用时明确提示；缺失时静默（生产环境）。
  }
  const nowIso = () => {
    const injected = process.env.OPENRIG_TEST_CLOCK_NOW;
    return typeof injected === "string" && injected.trim().length > 0 ? injected : new Date().toISOString();
  };
  try {
    writeSidecar(args.cwd, { ready: true, launchId: args.launchId, updatedAt: nowIso() });
    // eslint-disable-next-line no-console
    console.log(`${STUB_RUNNER_READY_MARKER} session=${args.sessionName} posture=${args.posture}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`${STUB_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // R1：加载席位行为脚本（cwd 中的场景解析版本，否则使用内置默认值），并针对真实 IO 接缝执行
  // 其步骤。`emit compaction` 触发准确的已发布 precompact 接缝（架构 R3：触发，绝不伪造）。
  // 损坏的场景脚本会在 pane 中明确失败，而不是静默空操作。
  const openrigHome = process.env.OPENRIG_HOME?.trim() || nodePath.join(process.env.HOME ?? "", ".openrig");
  // stub 压缩自身创建的 transcript，绝不使用在 ~/.claude/projects 下发现的外来 transcript；
  // 下方根据已解析脚本创建该文件。
  const transcriptPath = nodePath.join(args.cwd, ".openrig", "stub", "transcript.jsonl");
  const identity: StubActivityIdentity = { sessionName: args.sessionName, nodeId: process.env.OPENRIG_NODE_ID };
  const endpoint = resolveStubActivityEndpoint(process.env);
  const io: StubRunnerIO = {
    // eslint-disable-next-line no-console
    mirrorLine: (line) => console.log(line),
    fireCompaction: () => fireCompaction({
      hookScriptPath: resolveStubHookScriptPath(),
      sessionName: args.sessionName,
      openrigHome,
      cwd: args.cwd,
      transcriptPath,
      injectClockNow: process.env.OPENRIG_TEST_CLOCK_NOW,
    }),
    fireRestore: () => fireRestore({
      bridgeScriptPath: resolveStubRestoreBridgePath(),
      sessionName: args.sessionName,
      // 与 compaction 接缝记录在标记上的人工 transcript 相同——bridge 的 R5 前提门禁用此身份
      // 匹配并投递（让它贯穿全程，绝不削弱门禁）。
      transcriptPath,
      openrigHome,
      cwd: args.cwd,
      injectClockNow: process.env.OPENRIG_TEST_CLOCK_NOW,
    }),
    postActivity: (payload) => {
      if (!endpoint || typeof fetch !== "function") return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      fetch(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => { /* 尽力而为——绝不阻塞循环。 */ }).finally(() => clearTimeout(timeout));
    },
    die: (code) => {
      // 记录真实 exited sidecar，使后台服务看到席位终止（绝不是陈旧 ready）；输出 EXIT 标记后
      // 终止——没有优雅空闲，也没有 Stop。
      try {
        writeSidecar(args.cwd, { ready: false, launchId: args.launchId, exited: { code, at: nowIso() }, updatedAt: nowIso() });
      } catch { /* 退出途中尽力而为。 */ }
      // eslint-disable-next-line no-console
      console.log(STUB_RUNNER_EXIT_MARKER);
      process.exit(code);
    },
    now: nowIso,
  };
  // SessionStart 表示席位已启动（running）；它先于轮次事件。
  io.postActivity(stubActivityPayload(identity, "SessionStart", null, nowIso()));
  try {
    const script = resolveStubScript(args.cwd, {
      readFile: (p) => nodeFs.readFileSync(p, "utf-8"),
      exists: (p) => nodeFs.existsSync(p),
    });
    // 执行前创建席位自身 transcript，使 `emit compaction` 对 stub 的脚本化会话触发真实接缝，
    // 而不是处理外来会话。
    nodeFs.mkdirSync(nodePath.dirname(transcriptPath), { recursive: true });
    nodeFs.writeFileSync(
      transcriptPath,
      buildStubTranscript(script, { sessionName: args.sessionName, cwd: args.cwd, sessionId: args.launchId }),
      "utf-8",
    );
    executeStubScript(script, io, identity);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`${STUB_RUNNER_ERROR_MARKER} 脚本执行失败：${(err as Error).message}`);
  }

  // 保持 Node 事件循环存活，使进程作为 pane 的实时前台进程空闲。下方
  // `await new Promise(()=>{})` 永不解析，但未解析 promise 与信号监听器都不会引用事件循环；
  // 若无被引用的 handle，循环会耗尽，runner 在 READY 后立即退出，后台服务随后看到 pane 回到
  // shell，readiness 失败（F1）。此定时器永不触发（回调为空操作），仅用于引用事件循环。
  const keepAlive = setInterval(() => { /* 在终止前持续引用事件循环。 */ }, 1 << 30);

  // 终止时记录真实退出，避免后台服务 readiness 因陈旧 ready sidecar 把已停止席位误判为绿色。
  const recordExit = (code: number | null) => {
    clearInterval(keepAlive);
    try {
      writeSidecar(args.cwd, { ready: false, launchId: args.launchId, exited: { code, at: nowIso() }, updatedAt: nowIso() });
    } catch { /* 退出途中尽力而为。 */ }
    // eslint-disable-next-line no-console
    console.log(STUB_RUNNER_EXIT_MARKER);
  };
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => { recordExit(0); process.exit(0); });
  }

  // 作为 pane 的实时前台进程空闲（由上方 `keepAlive` 保持）；只在终止时结束。
  await new Promise<void>(() => { /* 保持打开，直到信号触发。 */ });
}

// ── 自调用守卫（Pi 先例）——仅作为进程入口时运行。──────────────────────────
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runStubRunner(parseStubRunnerArgs(process.argv.slice(2))).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`${STUB_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exit(1);
  });
}
