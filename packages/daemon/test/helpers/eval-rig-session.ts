/**
 * Test-A preflight blocker 3（行 testa-provider）——`run-evals.mjs --provider rig` 背后的 live
 * RigSeatSession 接线。只通过受支持的 rig CLI surface 驱动一个持久真实 seat：
 *
 *   spawn   ——附加到具名 seat（--seat），或对 scratch spec 执行 `rig up`（--seat-spec）并接管其
 *             唯一启动 seat；seat GENERATION 来自 `rig whoami --session <seat> --json`。
 *   send    ——`rig send <seat> <prompt>`（argv 数组，绝非 shell 字符串）。每个 case 恰好提交一个
 *             input，即自然 prompt。第 5 轮（custody 修复）：不发送 eval-sync marker。第 4 轮在 prompt
 *             前以第二次 `rig send` 发送唯一 nonce，以区分 pane 边界；对 `claude-code` seat 而言这是
 *             额外 user turn，违反 Test-A 的 no-intervening-input custody 契约，现已删除。
 *   capture ——边界是 seat 当前 generation 的仅追加 conversation record（Claude generation JSONL），
 *             通过注入的 readGenerationRecord 带外读取（读取不会向 seat 提交任何内容）。第 6 轮
 *             （desk 裁定方案 B）：r2 HIGH-1 否证第 5 轮的 `rig transcript` 边界；该 CLI 读取的是有界
 *             覆盖 pane snapshot，而非仅追加文件，因此重复命令可能擦除当前 turn evidence。
 *             sendPrompt 显式绑定当前 generation identity（绝不猜路径）并记录其内容；captureSince
 *             轮询记录直至稳定，返回发送前内容之后的 suffix（精确切片；同一 generation 内仅追加可
 *             保证 prefix）。GENERATION-CHANGE TRIPWIRE：观测中 generation 若滚动（re-prime 启动
 *             新 JSONL），captureSince 会显著失败，而不是跨 swap 读取。不支持 runtime 或无 record
 *             时显著拒绝（不静默降级，也不回退到有界 pane）。leading-echo 剥离仍属于 PROVIDER
 *             契约（eval-rig-provider.ts）；本模块只限定“prompt 之后”。
 *   retire  ——仅当当前 session 启动了 rig 时执行 `rig down <rig>`；attach 绝不销毁他人的 seat。
 *
 * 每次 rig CLI 调用都经过可注入 exec，generation-record 读取经过可注入 reader，因此无需后台服务
 * 即可在单元测试中锁定机制；live entry 注入真实 CLI 与 contextUsageStore 支撑的 reader。
 */

import { execFile } from "node:child_process";
import type { RigSeatSession } from "./eval-rig-provider.js";

export type RigExec = (args: string[]) => Promise<string>;

export interface RigCliSessionOptions {
  /** 附加到现有 session（与 spec 互斥）。 */
  seat?: string;
  /** 对此 spec 执行 `rig up`，并接管其唯一启动 seat。 */
  spec?: string;
  rigBin?: string;
  exec?: RigExec;
  /** 等待 pane 稳定时的轮询间隔。 */
  pollMs?: number;
  /** 判定“seat 已完成”所需的连续相同 capture 次数。 */
  stablePolls?: number;
  /** 每个 prompt 的硬上限；超时是错误，绝不静默返回部分结果。 */
  timeoutMs?: number;
  /**
   * 第 6 轮边界（desk 裁定 qitem-...-1117052f，方案 B）：读取 seat 当前 generation 的仅追加
   * conversation record——唯一单调、无输入的边界来源。r2 HIGH-1 已否证 `rig transcript`（有界覆盖
   * pane snapshot）；Claude generation JSONL 才是测得的仅追加记录。返回 { generationId, content }：
   *   - generationId：记录的 generation identity（Claude session id / rollout id）。re-prime 会滚动
   *     该值，这就是 generation-change tripwire 信号。
   *   - content：仅追加记录内容（同一 generation 内每次后续读取都以其为 prefix）。
   * 遇到不支持的 runtime（例如没有 Claude generation JSONL 的 Codex seat）或没有可解析 generation
   * record 的 seat 时必须抛错（显著拒绝，绝不静默降级或回退到有界 pane）。第 6 轮必需；live entry
   * 注入 contextUsageStore 支撑的 reader（显式解析 identity，绝不猜路径）。
   */
  readGenerationRecord?: (seat: string) => Promise<{ generationId: string; content: string }>;
  sleep?: (ms: number) => Promise<void>;
}

function defaultExec(rigBin: string): RigExec {
  return (args: string[]) =>
    new Promise((resolvePromise, reject) => {
      execFile(rigBin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${rigBin} ${args[0]} 执行失败：${err.message}${stderr ? ` — ${stderr.slice(0, 400)}` : ""}`));
        else resolvePromise(stdout);
      });
    });
}

/** 空白规范化后的 haystack，并携带 normalized index → raw index 映射。 */
function normalized(raw: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (/\s/.test(c)) continue;
    chars.push(c);
    map.push(i);
  }
  return { text: chars.join(""), map };
}

/** `post` 中不属于其与 `pre` 最长公共子序列的行，即终端在发送前 snapshot 之后产生的内容。
 * Line-LCS 是合适的边界，因为它可稳健处理三种真实终端结构：APPEND（新行位于末尾）、SCROLL
 *（共享行上移，顶部消失）和 REDRAW（input/status footer 在底部重现；它为两份 snapshot 共有，
 * 因而被 LCS 匹配且不计为新增）。仅重复的 footer 或 prompt 永远不会成为边界。 */
function newLinesSince(pre: string, post: string): string[] {
  const a = pre.split("\n");
  const b = post.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS 长度 DP。
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  // 回溯：标记 `b`（post）中哪些行已匹配进 LCS。
  const matched = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matched[j] = true;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  const out: string[] = [];
  for (let k = 0; k < m; k++) if (!matched[k]) out.push(b[k]!);
  return out;
}

/** 当前 prompt 发送后 seat 输出的切片，以仅追加 transcript 为边界（第 5 轮 custody 修复）。
 *
 * 边界：transcript suffix，即 `post` 中不属于其与发送前 transcript `preSendCapture` 最长公共子序列
 * 的行。因为 transcript 只追加（不会像 pane 那样滚动或重绘），旧的相同命令行会位于匹配的公共
 * prefix 中，绝不会被误认作当前 turn 的重新输出，因此无需向 seat 提交带内 marker（第 4 轮
 * eval-sync marker 是 prompt 前第二次 `rig send`，属于禁止的中间输入；第 5 轮将其完全移除）。
 * suffix 内跳过 prompt echo（包装或 TUI 截断），使 grading 从响应开始；保留后续真实引用
 *（它位于 echo 后的 suffix 中）。 */
export function sliceAfterPrompt(rawCapture: string, prompt: string, preSendCapture: string): string {
  const region = preSendCapture.length > 0 ? newLinesSince(preSendCapture, rawCapture).join("\n") : rawCapture;

  const hay = normalized(region);
  const fullNeedle = normalized(prompt).text;
  for (const needle of [fullNeedle, fullNeedle.slice(0, 16)]) {
    if (needle.length === 0) continue;
    const at = hay.text.indexOf(needle);
    if (at >= 0) {
      const endNorm = at + needle.length - 1;
      let rawEnd = hay.map[endNorm]! + 1;
      // 部分（truncated-echo）匹配时，跳过 echo 行余下内容。
      if (needle !== fullNeedle) {
        const nl = region.indexOf("\n", rawEnd);
        rawEnd = nl >= 0 ? nl + 1 : region.length;
      }
      return region.slice(rawEnd).replace(/^\n/, "");
    }
  }
  // Echo 已完全截断/滚出：该 region 就是发送后输出。
  return region.replace(/^\n/, "");
}

/** Claude generation JSONL 中的一条已解析行（effective-model-readers.readClaudeEffectiveModel
 * 跟踪的结构）：每行是 {type, message:{role, model, content:[blocks], stop_reason}}。无法解析的行
 *（末尾部分写入、非 message record）会被跳过；capture 评估 MESSAGE，损坏行绝不被静默评分。 */
interface GenerationRecordLine {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  sourceToolUseID?: string;
  message?: {
    role?: string;
    stop_reason?: string | null;
    content?: Array<{ type?: string; text?: string; input?: unknown; command?: unknown }> | string;
  };
}

function parseRecordLines(suffix: string): GenerationRecordLine[] {
  const out: GenerationRecordLine[] = [];
  for (const line of suffix.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as GenerationRecordLine;
      if (parsed !== null && typeof parsed === "object") out.push(parsed);
    } catch {
      // 部分/损坏行——不是 message，跳过且绝不评分。
    }
  }
  return out;
}

function contentBlocks(rec: GenerationRecordLine): Array<{ type?: string; text?: string; input?: unknown }> {
  const c = rec.message?.content;
  return Array.isArray(c) ? c : [];
}

/** 外部来源输入的 user-role record，按原生 CAUSAL FIELD 而非 role + content type 分类
 *（r2 R10 HIGH-1，经样本追踪）：runtime 在 assistant 自身 tool cycle 内写入三种 user-role record：
 * tool_result record，以及 Skill 加载时携带顶层 isMeta:true + sourceToolUseID 和已加载 body 的独立
 * text record。三者都属于进行中的 assistant turn。PIN 4 fail-closed 的对象是携带 input 文本但无这些
 * causal marker 的 record，即进入 generation 的真实 prompt。 */
function isExternalUserInput(rec: GenerationRecordLine): boolean {
  if (rec.message?.role !== "user") return false;
  if (rec.isMeta === true) return false;                                 // runtime 注入内容（例如已加载 skill body）。
  if (typeof rec.sourceToolUseID === "string" && rec.sourceToolUseID.length > 0) return false; // 由 assistant 自身 tool use 导致。
  const blocks = contentBlocks(rec);
  if (typeof rec.message?.content === "string") return true;             // 原生 prompt 结构（字符串 content）。
  if (blocks.some((b) => b.type === "tool_result")) return false;        // tool cycle 的结果 record。
  return blocks.some((b) => b.type === "text");
}

/** 只取 Assistant 输出文本：text block 原样保留，tool_use block 使用 grader 可匹配的 command
 *（DOOR grader 对 command 字符串做 pattern match）；绝不包含 JSON message envelope 或 user record。 */
function assistantText(records: GenerationRecordLine[]): string {
  const parts: string[] = [];
  for (const rec of records) {
    if (rec.message?.role !== "assistant") continue;
    for (const block of contentBlocks(rec)) {
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "tool_use") {
        const input = block.input as Record<string, unknown> | undefined;
        const command = input?.["command"];
        parts.push(typeof command === "string" ? command : JSON.stringify(input ?? {}));
      }
    }
  }
  return parts.join("\n");
}

interface UpNodeDetail {
  stages?: Array<{ detail?: { nodes?: Array<{ logicalId?: string; status?: string }> } }>;
  attachCommand?: string;
  rigId?: string;
  status?: string;
}

export function createRigCliSession(options: RigCliSessionOptions): { spawn: () => Promise<RigSeatSession> } {
  const {
    seat,
    spec,
    rigBin = "rig",
    exec = defaultExec(rigBin),
    pollMs = 5_000,
    stablePolls = 2,
    timeoutMs = 300_000,
    readGenerationRecord,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = options;
  if ((seat === undefined) === (spec === undefined)) {
    throw new Error("createRigCliSession：必须且只能提供 seat（附加）或 spec（启动）之一");
  }

  return {
    async spawn(): Promise<RigSeatSession> {
      let sessionName: string;
      let spawnedRig: string | undefined;
      // live daemon 在负载下可能短暂无响应（其 CLI 探测会在 5 秒后放弃并尝试启动第二个 daemon，
      // 导致端口冲突）——采用退避重试，避免反复创建 rig。
      const withRetry = async (fn: () => Promise<string>, attempts = 6, backoffMs = 10_000): Promise<string> => {
        let lastErr: unknown;
        for (let i = 0; i < attempts; i++) {
          try {
            return await fn();
          } catch (err) {
            lastErr = err;
            if (i < attempts - 1) await sleep(backoffMs);
          }
        }
        throw lastErr;
      };
      // `rig up` 返回时可能已经创建了 rig——立即按 rigId 记录归属（即使无法解析 attach 行，rigId
      // 依然存在），确保后续每条失败路径都能将其拆除（review50-r2 QA finding 2）。附加模式不记录
      // 任何归属，也不拆除任何内容。只要 up 后任一步骤失败，就退役由本会话创建的 rig。
      const cleanupOnFailure = async (err: unknown): Promise<never> => {
        if (spawnedRig !== undefined) {
          await withRetry(() => exec(["down", spawnedRig!])).catch(() => {});
        }
        throw err;
      };

      if (spec !== undefined) {
        const up = JSON.parse(await withRetry(() => exec(["up", spec, "--json"]))) as UpNodeDetail;
        spawnedRig = up.rigId ?? undefined; // 在任何校验可能抛错前取得其归属。
        const attach = up.attachCommand ?? "";
        const m = attach.match(/-t\s+(\S+)/);
        if (up.status !== "completed" || !m) {
          await cleanupOnFailure(new Error(`rig up 未启动 seat（status=${up.status ?? "?"}，attach=${JSON.stringify(attach)}）`));
        }
        sessionName = m![1]!;
        spawnedRig = spawnedRig ?? sessionName.split("@").pop();
      } else {
        sessionName = seat!;
      }

      // 所有 identity 校验都处于 cleanupOnFailure 的保护范围内：即使 whoami 成功但 identity 为空或
      // 格式错误，也必须退役已启动的 rig。
      let generation: string | undefined;
      try {
        const who = JSON.parse(
          await withRetry(() => exec(["whoami", "--session", sessionName, "--json"])),
        ) as Record<string, unknown>;
        // live 数据把 identity 嵌套为：{ resolvedBy, identity: { nodeId, ... }, ... }。
        const identity = (who["identity"] ?? who) as Record<string, unknown>;
        generation =
          (identity["occupantGeneration"] as string | undefined) ??
          (identity["occupant_generation"] as string | undefined) ??
          (identity["generation"] as string | undefined) ??
          (identity["nodeId"] as string | undefined) ??
          (identity["node_id"] as string | undefined);
        if (typeof generation !== "string" || generation.length === 0) {
          throw new Error(`无法从 rig whoami 为 '${sessionName}' 推导稳定的 seat generation——取得的 identity keys：${Object.keys(identity).join(",")}`);
        }
      } catch (err) {
        await cleanupOnFailure(err);
      }

      // 第 6 轮边界（desk 裁定方案 B）：带外读取 seat 当前 generation 的仅追加 conversation record
      //（读取不会向 seat 提交任何内容）。reader 是必需的——首次观测时缺失 reader 必须显著拒绝
      //（绝不静默回退到有界覆盖 pane，r2 HIGH-1）。采用惰性检查，因此从未观测的启动后退役路径
      // 不需要 reader。
      const readRecord = (seat: string): Promise<{ generationId: string; content: string }> => {
        if (!readGenerationRecord) {
          throw new Error("第 6 轮要求注入 readGenerationRecord（当前 generation 的仅追加记录读取器）；当前未注入——拒绝执行，不回退到有界覆盖的 pane transcript");
        }
        return readGenerationRecord(seat);
      };
      // 短暂读取失败（daemon 延迟）可在限额内容忍；持续失败意味着 daemon 已失联，必须显著报错。
      // record 读取失败并不等于 generation 变化——不得因此触发 tripwire。
      const maxConsecutiveReadFailures = 8;
      const tolerantRead = async (failures: { n: number }): Promise<{ generationId: string; content: string } | null> => {
        try {
          const out = await readRecord(sessionName);
          failures.n = 0;
          return out;
        } catch (err) {
          failures.n += 1;
          if (failures.n >= maxConsecutiveReadFailures) {
            throw new Error(`captureSince：连续 ${failures.n} 次读取 '${sessionName}' 的 generation record 失败——daemon 无响应：${(err as Error).message}`);
          }
          return null;
        }
      };
      // 在 session 整个生命周期内只绑定一次（r2 round-7 HIGH-1）：Test-A 在同一个 seat/session/
      // generation 上观测每个用例（baseline -> WALK -> GET -> post）。首个用例绑定前为 null。
      let boundGenerationId: string | null = null;
      let preSendRecord = "";

      return {
        generation,
        async sendPrompt(prompt: string): Promise<void> {
          // 显式解析当前 generation record（约束 1：identity 来自 reader，绝不猜测路径）。不支持的
          // runtime 或缺失 record 会在此抛错（约束 2：显著拒绝）。首个用例绑定 session generation；
          // 后续每个用例都与该生命周期绑定比较，若发生变化，则在发送前显著失败（用例之间的 re-prime
          // 跨越了单 generation 运行）——绑定永不覆盖，因此运行中的 generation 切换绝不会被静默接受
          //（r2 round-7 HIGH-1）。随后只提交一个输入——自然 prompt（冻结的单次发送 custody 契约，
          // 无 marker）。send 是承重动作，因此会重试。
          const rec = await withRetry(() => readRecord(sessionName));
          if (boundGenerationId === null) {
            boundGenerationId = rec.generationId;
          } else if (rec.generationId !== boundGenerationId) {
            throw new Error(`sendPrompt：seat '${sessionName}' 的 generation 在用例之间发生变化（session 绑定 '${boundGenerationId}'，当前 '${rec.generationId}'）——re-prime 跨越了 Test-A 的单 generation 运行；拒绝发送另一条 prompt`);
          }
          preSendRecord = rec.content;
          // PIN 5（envelope 中和，desk 裁定 6fa281f1）：探针以 RAW 方式发送——文本完全不变，
          // 没有 From/To envelope，也没有回复提示。冻结标准中的探针在原地作答；标准 envelope 发送会
          // 给空白 seat 一条可执行的传输邀请，造成 harness 泄漏（作废运行正是以这种方式受到污染）。
          await withRetry(() => exec(["send", "--raw", sessionName, prompt]));
        },
        async captureSince(_prompt: string): Promise<string> {
          const deadline = Date.now() + timeoutMs;
          const failures = { n: 0 };
          // 感知 JSONL schema 的 capture（harness 修正；RED pins b4d8d1797 + desk pins 4-5）：轮询
          // 仅追加 record，并将发送前内容之后的 suffix 解析为 message 行。完成信号是原生 turn 完成——
          // suffix 的最后一条 assistant message 带有终止 stop_reason——绝不是内容稳定（80-byte-footer
          // 缺陷）。评分值仅含 assistant/tool 输出文本——绝不包含 user prompt 或 JSON envelope。每个
          // 用例单独强制 custody：出现中间 user input 时以 fail-closed 方式使该用例失败。
          for (;;) {
            if (Date.now() > deadline) {
              throw new Error(`captureSince：seat '${sessionName}' 未在 ${timeoutMs}ms 内完成原生 turn（未观测到终止 stop_reason；不再以内容稳定作为完成信号）`);
            }
            await sleep(pollMs);
            const rec = await tolerantRead(failures);
            if (rec === null) continue;
            // GENERATION-CHANGE TRIPWIRE（约束 3）：re-prime 会滚动 record id，并启动一个新仅追加
            // 文件，其 offset 与发送前文件无关。能跨 generation 切换继续使用的 cursor 是虚假的——
            // 必须显著拒绝，而不是切割新文件。
            if (rec.generationId !== boundGenerationId) {
              throw new Error(`captureSince：seat '${sessionName}' 的 generation 在观测期间发生变化（绑定 '${boundGenerationId}'，当前 '${rec.generationId}'）——观测窗口无效；拒绝跨切换读取`);
            }
            const content = rec.content;
            // 同一 generation 内的 record 是仅追加的，因此发送前内容必须为前缀；若不是前缀，说明
            // 该来源违反“仅追加”契约——必须显著拒绝，而不是生成边界错误的切片。
            if (!content.startsWith(preSendRecord)) {
              throw new Error(`captureSince：generation '${boundGenerationId}' 的 record 对 '${sessionName}' 并非仅追加（发送前内容不是前缀）——边界不可靠，拒绝执行`);
            }
            const records = parseRecordLines(content.slice(preSendRecord.length));
            // PIN 4——中间输入 FAIL-CLOSED（desk 裁定 6fa281f1）：第一条外部 user input 是 prompt
            // 自身的投递；turn 完成前，任何后续外部来源输入进入 generation 都会显著使该用例作废。
            // 这里负责检测而非预防——终端按设计接受输入；harness 拒绝为受污染用例评分，因此重试只
            // 损失一个用例，而不是整次运行。按原生 CAUSAL FIELDS 分类（r2 R10 HIGH-1）：tool_result
            // record 以及 isMeta/sourceToolUseID text record（已加载的 skill body）都是 assistant 自身的
            // tool cycle，绝不是中间输入。
            const userInputs = records.filter(isExternalUserInput);
            if (userInputs.length > 1) {
              throw new Error(`captureSince：用例无效——从 prompt 投递到原生 turn 完成之间，有 ${userInputs.length - 1} 条中间 user input record 进入 '${sessionName}' 的 generation '${boundGenerationId}'；冻结的“无中间输入”custody 规则以 fail-closed 方式拒绝此用例`);
            }
            // 原生 turn 完成（r2 R10 HIGH-2）：最新 assistant record 上的终止 stop_reason 并不是 turn
            // 边界——runtime 每个 turn 会发出多条终止 assistant record（样本：thinking end_turn，92ms
            // 后才是可见文本 end_turn）。来源证明的闭合边界是 runtime 在 turn 最后一条 assistant record
            // 之后写入的 system/turn_duration record；只有它出现且前面至少有一条 assistant record 时
            // 才返回，否则一直轮询到 deadline。
            let closureAt = -1;
            for (let i = records.length - 1; i >= 0; i--) {
              if (records[i]!.type === "system" && records[i]!.subtype === "turn_duration") { closureAt = i; break; }
            }
            if (closureAt >= 0) {
              const turn = records.slice(0, closureAt);
              if (turn.some((r) => r.message?.role === "assistant")) {
                // 仅输出：assistant text + tool_use command block——即 DOOR grader 进行 pattern match
                // 的内容。通过 role 过滤和 block 提取，从结构上排除 thinking block、user prompt 以及
                // JSON envelope 的每个字节；leading-echo 剥离仍是 PROVIDER 在自身边界上的契约。
                return assistantText(turn);
              }
            }
          }
        },
        async retire(): Promise<void> {
          if (spawnedRig !== undefined) {
            await withRetry(() => exec(["down", spawnedRig!]));
          }
        },
      };
    },
  };
}
