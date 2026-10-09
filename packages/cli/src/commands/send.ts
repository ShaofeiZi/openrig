import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient, DaemonConnectionError, DaemonTimeoutError, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, fetchSelfHostId, resolveOriginSelfHostId } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { resolveCrossHostTarget } from "../cross-host-target.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { resolveSenderSession, SENDER_FALLBACK } from "../sender-identity.js";
import { resolveContextRef, walkSizedWarning } from "../context-resolve.js";

const WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS = 5_000;

/**
 * 用邮件风格信封包裹 `rig send` 正文，让接收方面板同时看到发送方身份和
 * 可粘贴的回复提示。跨主机发送不在本地包裹：远程 rig 跑同一命令时会自己包裹，
 * 双重包裹会嵌套信封。
 *
 * V0.3.1 slice 23 一致性契约：`packages/daemon/src/lib/pane-envelope.ts`
 * 导出 `wrapPaneEnvelope`，相同输入产出逐字节相同输出。
 * P18（删除原子）反转 A1：无 env 的 `rig send`/`broadcast` 不再在席位边界拒绝——
 * 它带着诚实的 `<unknown sender>` 兜底投递（后台服务侧投递并标记 header 缺席的写，
 * 所以标记到达面板而不是下游 401）。所以这个孪生版本重新获得兜底分支，
 * 在整个输入域（已解析和 undefined）上再次与 wrapPaneEnvelope 逐字节相同。
 * 实现分处两个包，因为 cli 和 daemon 今天不互相导入。改这个函数时，
 * 同步更新 wrapPaneEnvelope。
 */
/** Send/broadcast 头部信封元数据（ruling 03c35295）——后台服务 pane-envelope
 *  EnvelopeMeta 的逐字节孪生。Envelope = 机器真相；渲染头部 = 投影。 */
export interface EnvelopeScope {
  kind: "dm" | "multi" | "rig-broadcast" | "topology";
  recipients?: string[];
  rig?: string;
  seats?: number;
}
export interface EnvelopeMeta {
/** ISO-8601 时间戳，只在传输发送时盖章一次；渲染时只读取，绝不重新派生。 */
  stampISO?: string;
  scope?: EnvelopeScope;
/** GHOST-STAGE（g）：发送方 atom-B 占用者 generation-uuid，只在传输层盖章一次。
 *  缺失意味着未知，渲染时省略后缀而绝不伪造。与 pane-envelope 字段孪生。 */
  genUuid?: string;
}

/** To 行投影 + 防风暴规模（仅头部即可区分）。 */
export function renderToLine(recipient: string, scope?: EnvelopeScope): string {
  if (!scope || scope.kind === "dm") return `To: ${recipient}`;
  if (scope.kind === "multi") return `To: ${(scope.recipients ?? [recipient]).join(", ")}`;
  if (scope.kind === "rig-broadcast") return `To: 广播到 ${scope.rig}（${scope.seats} 个席位）`;
  return "To: 广播到 topology";
}

/** 从传输层 ISO 时间生成便于扫读的短戳 MM-DD HH:MMZ。 */
export function renderShortStamp(stampISO: string): string {
  return `${stampISO.slice(5, 7)}-${stampISO.slice(8, 10)} ${stampISO.slice(11, 16)}Z`;
}

export function wrapSendBody(
  sender: string | undefined,
  recipient: string,
  body: string,
  meta?: EnvelopeMeta,
): string {
  // P18 投递并标记：无 env 的分发不再拒绝；CLI 重新获得诚实的
  // `<unknown sender>` 兜底，让无法归因的发送带着真实标记投递（后台服务侧
  // 投递并标记 header 缺席的写——不洗白，不下游 401）。在整个输入域上与
  // 后台服务孪生 wrapPaneEnvelope 逐字节相同。
  //
  // 创始人根不变量（2026-08-27，取代 51-09 incr 3 的总是后缀）：发送方按收到的
  // 原样渲染——本地裸 member@rig（可粘贴回复提示），跨主机调用方在转发边界
  // 构造 origin 三元组后再包裹。
  const senderLabel = sender && sender.trim().length > 0 ? sender : SENDER_FALLBACK;
  const header = [`From: ${senderLabel}`, renderToLine(recipient, meta?.scope)];
  if (meta?.stampISO) {
    // GHOST-STAGE (g)：发送方的原子 B occupant generation uuid 作为短后缀骑在
    // Sent: 行上（uuid 前 8 位——按节点规模区分；账本保留完整 uuid 用于精确 join）。
    // gen 缺席 ⇒ 完全省略后缀——绝不写 "gen unknown"，绝不伪造值。后缀在位置上绑定
    // 到 Sent: 头部行（正文行，总在第一个 "---" 之后，可以含 " · gen …"，但不能注入
    // Sent: 行—— containment）。
    const genSuffix = meta.genUuid && meta.genUuid.length > 0 ? ` · gen ${meta.genUuid.slice(0, 8)}` : "";
    header.push(`Sent: ${renderShortStamp(meta.stampISO)}${genSuffix}`);
  }
  const reply = senderLabel.endsWith("@external")
    ? `↩ 如需回复：zrig queue create --destination ${senderLabel} --body "..." --verify`
    : `↩ 回复：zrig send ${senderLabel} "..."`;
  return [...header, "---", body, "---", reply].join("\n");
}

/**
 * 1b45cf21——在一次真实传输失败后的补救，采用仓库的
 * 事实/后果/动作形状（`daemon-lifecycle.ts:61-73`）。
 *
 * 刻意不用 `daemonNotRunningError()`：那个助手的文本（"Daemon not
 * running." + 重启建议）是探测推出的论断，qitem-c113bd41 已移除。
 * 形状复用；文本不复用。
 *
 * `DaemonConnectionError` 证明解析出的目标不可达——但不证明为什么。后台服务宕、
 * 端口错、主机错、防火墙、事件循环卡死都是活解释，所以动作保持诊断性，
 * 不断言任何后台服务状态。它也拒绝过度推销 `rig status`：设了 env URL 时，
 * 那个命令自己的探测对一次单纯超时也会报 `stopped`
 *（`daemon-lifecycle.ts:575-585`）——正是这个 slice 要移除的假 stopped 类——
 * 所以文案点出这个局限而不是藏起来，并把 `rig daemon start` 放在操作人员确认之后。
 *
 * 两条本地路径共用它，让单席位和扇出补救在构造上逐字节相同，而不是手工维护重复。
 */
function printTransportFailure(err: DaemonConnectionError, opts?: { json?: boolean }): void {
  // 补救值只定义一次；人类路径在渲染时加两空格缩进，让已有的三行输出保持
  // 逐字节相同，而 --json 信封带干净字符串。与 printDaemonNotRunning
  //（daemon-lifecycle.ts）同样的 {error:{fact,consequence,action}} 形状，
  // 让 --json 路径上的智能体拿到可解析记录，而不是空 stdout 加 stderr 上的人类散文。
  const fact = err.message;
  // B8-2（shape 73ee4b25）：超时是投递未确认——后台服务可能已收到并投递
  //（两个席位证明了在"未发送"之后仍投递）。只有硬连接失败才配得上"未发送"后果。
  const timedOut = err instanceof DaemonTimeoutError;
  const consequence = timedOut
    ? "投递未确认——后台服务可能已收到并投递了这条消息。"
    : "消息未发送。";
  const action = timedOut
    ? "重发前先按效果对账：检查面板/目标里有没有这条消息（zrig capture <session>）。" +
      " 不检查就重发有重复风险。然后用 'zrig daemon status' 看探测图景。"
    : "用 'zrig status' 检查配置的目标；健康探测失败不证明后台服务已停。" +
      " 如果目标错了，查 OPENRIG_URL / RIGGED_URL 或 daemon.host + daemon.port。" +
      " 如果确认后台服务已停，跑 'zrig daemon start'.";
  if (opts?.json) {
    console.log(JSON.stringify({ error: { fact, consequence, action } }));
    return;
  }
  console.error(fact);
  console.error(`  ${consequence}`);
  console.error(`  ${action}`);
}

/** 在传输调用前拒绝任何无法传达内容的输入。 */
export function refuseEmptyMessage(body: string, verb: "send" | "broadcast", json = false): boolean {
  if (body.trim().length > 0) return false;
  const fact = `rig ${verb}：消息为空或仅空白。`;
  const consequence = "未运行消息传输，什么都没投递。";
  const action = "检查 shell 反引号或 $() 替换是否把参数吞成了空，或 --body-file/stdin 来源是否解析成 0 字节；请提供非空内容。";
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { fact, consequence, action } }));
  } else {
    console.error(`错误：${fact}\n${consequence}\n${action}`);
  }
  process.exitCode = 1;
  return true;
}

/** qitem-c113bd41——本地发送目标。状态探测只是建议性的，绝不权威：忙碌/卡死的
 *  后台服务会让探测失败，而传输本会成功（假后台服务宕事故）。解析顺序：
 *  配置的 env 别名优先（精确字符串，自定义端口保留；OPENRIG_URL 胜过旧的 RIGGED_URL），
 *  否则探测找到的状态/状态派生 host:port，否则配置文件/默认目标
 * （无参 DaemonClient 解析）。真正的传输调用决定成败——它的 DaemonConnectionError
 *  才是诚实的失败面。
 *
 *  ff13bcdf——探测由这个 resolver 惰性发起，因为显式 env 别名已经决定了目标：
 *  先探测在事故路径上白付约 818ms（秒败探测）到约 2.05s（超时形：5x250ms 边界
 *  + 4x200ms 退避）的纯延迟，然后在第一个分支就把结果丢掉。在这里拥有探测，
 *  也让单席位和扇出调用方不必在两处按相同顺序编排它。 */
async function resolveLocalDaemonUrl(deps: SendDeps): Promise<string> {
  const envUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
  if (envUrl) return envUrl;
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state === "running" && status.port !== undefined) return getDaemonUrl(status);
// 配置目标解析逐字复用无参数 DaemonClient 的规则：环境别名 > ConfigStore 文件 > 默认值。
// 绝不使用硬编码字面量，因此会遵守配置文件中的自定义 daemon.host/port。
  return new DaemonClient().baseUrl;
}

/**
 * OPR.0.4.3.30——`--to` 的 Commander collector：同时接受逗号列表
 * （`--to a,b`）和重复（`--to a --to b`），累积进一个数组。
 * 空白条目被丢掉，所以尾随逗号无害。
 */
function collectSessions(value: string, previous: string[]): string[] {
  const parts = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return previous.concat(parts);
}

export interface SendDeps extends StatusDeps {
  /** 跨主机 hook。两者默认使用生产加载器/执行器；测试注入包内 mock，因此不会接触
   * 真实 ssh、真实 ~/.ssh 或真实网络。 */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

export function sendCommand(depsOverride?: SendDeps): Command {
  const cmd = new Command("send").description("向智能体的终端发送一条消息");
  const getDeps = (): SendDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    // OPR.0.4.3.30——两个位置参数都可选，这样消息可以单独带一个目标标志
    //（`zrig send --pod x "text"`）。action 里消歧：带目标标志时第一个位置参数
    // 就是消息；没有时是 `<session> <text>`。
    .argument("[session]", "单席位发送的目标会话名（例如 dev-impl@my-rig）")
    .argument("[text]", "要发送的消息文本")
    .option("--to <sessions>", "多接收方：逗号列表或重复（--to a,b 或 --to a --to b）", collectSessions, [] as string[])
    .option("--pod <name>", "发送给一个 pod 里的每个席位（扇出，按接收方出结果）")
    .option("--rig <name>", "发送给一个工作组里的每个席位（扇出，按接收方出结果）")
    .option("--verify", "发送后检查内容，验证仅面板投递")
    .option("--force", "向后兼容 no-op：任务中/忙碌面板默认就带提示发送；--force 绝不绕过交互提示/权限守卫")
    .option("--wait-for-idle <seconds>", "等待目标显式空闲后再发送")
    .option("--raw", "发送精确文本/按键，不带 From/To 消息信封（仍受交互提示守卫）")
    .option("--dangerously-interact", "危险：刻意驱动交互提示/权限阻断（隐含 --raw；需要 --reason）。这是提示/权限守卫的唯一覆盖。")
    .option("--reason <text>", "为什么要驱动提示（与 --dangerously-interact 一起用；记入审计日志）")
    .option("--host <id>", "在 ~/.openrig/hosts.yaml 中声明的远程主机上发送（ssh 主机 shell out；http 主机 CLI 直连远程后台服务）")
    .option("--from <session>", "已废弃 + 被忽略（P21 I4）。渲染的 From:/actor 现在从传输身份派生（$OPENRIG_SESSION_NAME，盖成 X-OpenRig-Session）——绝不接受调用方字符串，那是 specimen-5 可伪造的面。跨主机 origin 由中继从其认证上下文重新盖章携带。")
    .option("--context <ref>", "按路径式 ref 投递一个上下文包（例如 packs/compaction-restore）。发送解析出的内容；超大 ref 标记为 'walk-sized'。")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  zrig send dev-impl@my-rig "上下文更新：QA 已批准。继续。"
  zrig send dev-impl@my-rig "消息" --verify
  zrig send --to dev-impl@my-rig,dev-qa@my-rig "发给两个席位的消息"
  zrig send --pod dev "发给整个 dev pod 的消息"
  zrig send --rig my-rig "发给整个工作组的消息"
  zrig send dev-impl@my-rig "安全验证提示" --wait-for-idle 30 --verify
  zrig send dev-impl@my-rig "停下读 spec。" --force
  zrig send dev-impl@my-rig "消息" --json
  zrig send --host remote-dev dev-impl@my-rig "远程消息" --verify
  zrig send dev-impl@my-rig@vps-b "主机限定目标糖（后缀必须是已注册主机 id）"

目标：一个裸席位（单发送），或 --to / --pod / --rig 之一（扇出）。
扇出按接收方出结果 + "N/M 已投递" 汇总；一个接收方的守卫拒绝不阻断其他人。
每个接收方拿到自己的 From/To 信封。

两步发送模式（粘贴文本、等待、回车提交）自动处理。默认只在有正面证据表明目标
正处在交互提示或权限阻断时才拒绝发送（这样消息永远不会选中/批准另一个智能体的提示）。
当目标活动无法确定（未知/缺失/陈旧遥测）时，发送带一条建议性提示继续——遥测是
建议，不是智能体间能否通信的权威。用 --wait-for-idle 只在显式空闲证据后发送。
用 --verify 确认消息出现在面板里；它不是智能体确认。

任务中/忙碌目标现在默认带建议发送（忙碌不是阻断）；--force 是向后兼容 no-op，
绝不绕过交互提示/权限守卫。用 --raw 发送精确文本/按键而不带 From/To 信封
（例如斜杠命令）；它仍受守卫。用 --dangerously-interact --reason "<原因>" 刻意
驱动提示（选一个选项、批准权限、给被阻断面板发 /compact）——这是提示守卫的唯一
覆盖；它隐含 --raw 并记入审计日志。

--host 在 ~/.openrig/hosts.yaml 中声明的远程主机上发送。主机条目的传输决定路径：
ssh 主机通过单跳 ssh 跑同一命令（SSH 成功不等于验证成功：远程 rig 的
'Verified: yes/no' 行才算数并逐字暴露）；http 主机（例如配对注册）CLI 直连远程
后台服务的 send 路由——结果和验证结论是远程的，逐字。形如 agent@rig@host 的目标
在后缀是已注册主机 id 时是 --host 的语法糖
（显式 --host > 目标糖 > 持久选择；--host 与语法糖冲突是错误）。`)
    .action(async (session: string | undefined, text: string | undefined, opts: { to?: string[]; pod?: string; rig?: string; verify?: boolean; force?: boolean; waitForIdle?: string; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; host?: string; from?: string; context?: string; json?: boolean }) => {
    // OPR.0.4.6.MH1 FR-2：所选主机路由——显式 --host 优先；否则持久化选择进入已交付的
    // --host 路径；没有选择时保持现有行为。OPR.0.4.6.MH4 §4：保留原始标志，使单席位
    // 目标语法糖可插在显式指定与持久选择之间（显式 > 语法糖 > 选择）。
      const explicitHost = opts.host;
      opts.host = resolveEffectiveHost(opts.host);
      const waitForIdleMs = parseWaitForIdleMs(opts.waitForIdle);
      if (opts.force && waitForIdleMs !== undefined) {
        console.error("--wait-for-idle 不能与 --force 组合");
        process.exitCode = 1;
        return;
      }
      if (waitForIdleMs === null) {
        console.error("--wait-for-idle 必须是正数秒数");
        process.exitCode = 1;
        return;
      }
      // OPR.0.4.1.10——危险覆盖需要一个 reason（供审计），不能与 wait 模式组合。
      // 在联系后台服务前本地拒绝。
      if (opts.dangerouslyInteract && (!opts.reason || opts.reason.trim().length === 0)) {
        console.error("--dangerously-interact 需要 --reason \"<原因>\"（记入审计日志）");
        process.exitCode = 1;
        return;
      }
      if (opts.dangerouslyInteract && waitForIdleMs !== undefined) {
        console.error("--dangerously-interact 不能与 --wait-for-idle 组合");
        process.exitCode = 1;
        return;
      }

      // OPR.0.4.3.30——目标模式解析。恰好四选一：裸席位、--to、--pod、--rig。
      const toList = opts.to && opts.to.length > 0 ? opts.to : undefined;
      const fanModes = [toList ? "to" : null, opts.pod ? "pod" : null, opts.rig ? "rig" : null].filter(Boolean);
      if (fanModes.length > 1) {
        console.error("请恰好选一个目标：席位、--to、--pod 或 --rig（不要多个）。");
        process.exitCode = 1;
        return;
      }
      const isFanOut = fanModes.length === 1;

      // Slice-03 Atom 6b：v1 中 --context 是单席位本地（扇出和跨主机 --context 是后续）。
      // 大声拒绝，而不是静默丢掉请求的 context。
      if (opts.context && (isFanOut || opts.host)) {
        console.error("v1 中 --context 只支持单席位本地发送（不能与 --to/--pod/--rig 或 --host 一起用）。");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();

      // P18 投递并标记——席位边界不再拒绝。从席位 env 解析发送方
      //（OPENRIG_SESSION_NAME/RIGGED_SESSION_NAME；--from 已废弃 + 被忽略）；
      // 无法解析时分发仍带着诚实的 `<unknown sender>` 标记和 NULL actorSession 继续——
      // 绝不伪造 actor。`seatSender` 因此是 `string | undefined`，贯穿每条分发路径
      //（扇出、跨主机、单席位）。镜像后台服务侧，后者投递并标记 header 缺席的写
      //（不 401）：未验证标记为 unknown，绝不洗白成 verified。
      const seatSender = resolveSenderSession();

      if (isFanOut) {
        // 带目标标志时第一个位置参数就是消息；第二个位置参数（或裸席位名）意味着
        // 调用方混了单席位和扇出目标——拒绝。
        if (text !== undefined) {
          console.error("裸席位名不能与 --to/--pod/--rig 组合。请只提供消息。");
          process.exitCode = 1;
          return;
        }
        const message = session;
        if (message === undefined) {
          console.error("请提供要发送的消息。");
          process.exitCode = 1;
          return;
        }
        if (refuseEmptyMessage(message, "send", Boolean(opts.json))) return;
        if (opts.host) {
          console.error("--host（跨主机）只支持单席位发送；--to/--pod/--rig 是本地。");
          process.exitCode = 1;
          return;
        }
        if (waitForIdleMs !== undefined) {
          console.error("--wait-for-idle 不支持多/pod/rig 目标（累积等待有客户端超时风险）。请单发单席位，或去掉 --wait-for-idle。");
          process.exitCode = 1;
          return;
        }
        await runFanOutSend({ toList, pod: opts.pod, rig: opts.rig, message, opts, deps, seatSender });
        return;
      }

      // --- 单席位路径（与 0.4.3.30 之前逐字节相同）---
      // Atom 6b：--context 提供载荷，所以带它时 <text> 可选。
      if (session === undefined || (text === undefined && !opts.context)) {
        console.error("用法：zrig send <session> <text> （或 zrig send <session> --context <ref>，或 --to/--pod/--rig <message> 做扇出）");
        process.exitCode = 1;
        return;
      }
      if (!opts.context && refuseEmptyMessage(text!, "send", Boolean(opts.json))) return;

      // 端点选投递；本地持久存储标识 origin。
      const localDaemonUrl = await resolveLocalDaemonUrl(deps);
      const selfHostId = await fetchSelfHostId(deps.lifecycleDeps, localDaemonUrl);

      // OPR.0.4.6.MH4 §4——`agent@rig@host` 目标语法糖（仅单席位；扇出位置参数是消息文本）。
      // 后缀必须匹配已注册主机 id，否则目标原样通过，提示骑在之后任何失败上。
      // 优先级：显式 --host > 语法糖 > 持久选择（上面已折进 opts.host）。
      // 51-09 incr 3：后缀 == 本机 self-id 时剥掉并路由回本地。
      const targetResolution = resolveCrossHostTarget(session, explicitHost, deps.hostRegistryLoader, selfHostId);
      if (!targetResolution.ok) {
        console.error(targetResolution.error);
        process.exitCode = 1;
        return;
      }
      session = targetResolution.target;
      const crossHostHint = targetResolution.hint;
      if (targetResolution.warning) console.error(targetResolution.warning);
      opts.host = explicitHost ?? targetResolution.sugarHost ?? opts.host;

      // Atom 6b QA 修复（根因）：在 agent@rig@host 语法糖主机折进 opts.host 之后，
      // 再次在跨主机路径上拒绝 --context。早期守卫跑在 resolveCrossHostTarget 之前，
      // 看不到语法糖主机——这个洞让语法糖形 --context 到达远程 argv
      //（寄出一个没有消息的字面 null，或带消息时静默丢掉 context）。
      // v1 中 --context 是单席位本地；绝不交给远程发送。
      if (opts.context && opts.host) {
        console.error("v1 中 --context 只支持本地发送（不能与 --host 或 agent@rig@host 跨主机目标一起用）。");
        process.exitCode = 1;
        return;
      }

      // --- 跨主机短路（CLI 侧；ssh shell out 或 MH-4 http 分支；后台服务不动）---
      if (opts.host) {
        // text 在此处已校验为有定义：--context 与 --host 一起已被拒（上面，
        // 显式和语法糖两种形），单席位（无 text 且无 context）守卫在这条路径上要求它。
        const originId = await resolveOriginSelfHostId(deps.lifecycleDeps);
        await runCrossHostSend(opts.host, session, text!, opts, deps, waitForIdleMs, crossHostHint, originId, seatSender);
        return;
      }

      // qitem-c113bd41——状态探测只是建议性的（只用于目标发现）；真正的传输才权威。
      // 探测超时或 running/unhealthy 结论不再拒绝发送。ff13bcdf——resolver 惰性发起
      // 探测，显式 env 别名已命名目标时完全跳过它。
      const client = deps.clientFactory(localDaemonUrl);
      // P21 I4：渲染的 From:（specimen-5 可伪造面）从席位 env 派生，绝不从
      // --from。--from 在此已废弃 + 被忽略（它的跨主机 origin 携带已被中继从其认证
      // 上下文重新盖章取代）。Env == DaemonClient 盖的 X-OpenRig-Session，
      // 所以客户端 From: + 正文 actor 与后台服务派生 actor 保持一致。
      const senderSession = seatSender; // P18：席位 env 身份，或 undefined → 投递并标记（unknown 标记，null actor）。
      // --raw（以及隐含它的 --dangerously-interact）发送精确文本，不带消息信封。
      const raw = Boolean(opts.raw || opts.dangerouslyInteract);

      // Atom 6b：--context 把一个包 ref 解析成它的全部内容（全有或全无——
      // 缺成员在任何发送前中止）并投递。消息 + --context 先发消息再发 context，
      // 空行分隔。超大 context 暴露 §4 walk-sized 建议。
      let payload = text ?? "";
      if (opts.context) {
        let resolved;
        try {
          resolved = await resolveContextRef(client, opts.context);
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
          return;
        }
        payload = text && text.length > 0 ? `${text}\n\n${resolved.text}` : resolved.text;
        const warn = walkSizedWarning(resolved, session);
        if (warn && !opts.json) console.log(`建议：${warn}`);
      }
      if (refuseEmptyMessage(payload, "send", Boolean(opts.json))) return;
      // Send/broadcast 头部（ruling 03c35295）：定向 `rig send` 是 DM——在发送时盖章
      //（Sent: MM-DD HH:MMZ）让 transcript 带时间戳；To 行保持单接收方。
      const outboundText = raw ? payload : wrapSendBody(senderSession, session, payload, { stampISO: new Date().toISOString() });
      let res: { status: number; data: Record<string, unknown> };
      try {
        res = await client.post<Record<string, unknown>>("/api/transport/send", {
          session, text: outboundText, deliveryId: randomUUID(), verify: opts.verify, force: opts.force, waitForIdleMs,
          dangerouslyInteract: opts.dangerouslyInteract, reason: opts.reason, actorSession: senderSession ?? null,
        }, transportRequestOptions(waitForIdleMs));
      } catch (err) {
        if (err instanceof DaemonConnectionError) {
        // 如实展示真实传输结果，包括配置目标与底层错误；绝不只显示探针推导的裸重启提示。
        // 1b45cf21 在真实失败后补充可执行的下一步。
          printTransportFailure(err, { json: opts.json });
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      if (res.data["outcome"] === "retained") {
        console.log(opts.json ? JSON.stringify(res.data) : `已保留，未投递给 ${session}。${String(res.data["warning"] ?? "")}`);
        return;
      }

      // S3 wave-1 修复（r2 F2）：效果分类跑在任何输出编码或路由之前，
      // 这样人类和 JSON 编码器渲染同一份效果真相——当 --verify 要求消费确认时，
      // 没有路径可以仅凭传输返回就报 sent/delivered。
      let effect: EffectCheck | undefined;
      if (opts.verify && res.status < 400) {
        effect = await classifyDeliveryEffect(client, session, stagedIdentityFor(payload, outboundText), waitForIdleMs);
      }

      if (opts.json) {
        // Round-2 F1：一个结论——staged-unresolved 信封在 staged effect 旁不带任何
        // delivered 主张。
        const envelope = !effect
          ? res.data
          : effectUnresolved(effect)
            ? { ...res.data, verified: false, outcome: "staged-not-consumed", effectCheck: effect }
            : { ...res.data, effectCheck: effect };
        console.log(JSON.stringify(envelope));
        if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
        if (effectUnresolved(effect)) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = res.data["error"] as string | undefined;
        console.error(error ?? `发送失败（HTTP ${res.status}）`);
        // MH-4 §4 大声失败提示：目标是三段形但后缀没匹配到已注册主机——点名这个近失。
        if (crossHostHint) console.error(`提示：${crossHostHint}`);
        process.exitCode = res.status >= 500 ? 2 : 1;
        return;
      }

      console.log(`已发送给 ${session}`);
      // OPR.0.4.3.28 修正——`unknown` 遥测发送现在带非阻塞建议继续（之前是 fail-closed 拒绝）。
      // 在人类输出上暴露它，不只在 --json 里。
      const advisory = res.data["warning"] as string | undefined;
      if (advisory) {
        console.log(`建议：${advisory}`);
      }
      if (opts.verify && effect) {
        // S3（OPR.0.5.4.6）——"sent" 必须意味着被消费，绝不只是敲进去。
        // 正面 staged 残压过传输的回答；残缺失什么也证明不了（重绘面板读成缺失），
        // 所以那种情况下传输结论原样保留。
        if (effect.checked && effect.state === "staged") {
          console.log("验证：否");
          for (const line of effectHumanLines(effect, session)) console.log(line);
          if (effectUnresolved(effect)) process.exitCode = 1;
        } else {
          // 旧行逐字保留（已有脚本 grep `Verified:`）；下面的 Delivery 行带诚实的
          // 三结论词汇（OPR.99.0.6.3）：单独的 `Verified: no` 会把已落地但重绘竞速的
          // 发送和未命中压成同一行。
          const verified = res.data["verified"] as boolean | undefined;
          console.log(`验证：${verified ? "是" : "否"}`);
          const outcome = res.data["outcome"] as string | undefined;
          if (outcome === "delivered") {
            console.log("投递：delivered（消息已落地；渲染已确认）");
          } else if (outcome === "rendered-unconfirmed") {
            console.log(`投递：rendered-unconfirmed（已落地；面板重绘未确认——用 zrig capture ${session} 确认）`);
          }
          for (const line of effectHumanLines(effect, session)) console.log(line);
        }
      }
    });

  return cmd;
}

/**
 * S3（OPR.0.5.4.6）——投递效果分类，跑在任何输出编码或路由之前（r2 F2），
 * 让每个编码器——人类、JSON、扇出——渲染同一份效果真相。跑 staged 探测器；
 * 正面残压过 ONE guarded submit（什么都不敲，不会重复投递）加一次复查，然后停。
 * 纯分类：这里不打印。
 */
type EffectCheck =
  | { checked: true; state: "staged"; remedy: "submitted-cleared" | "submitted-still-staged" | "submit-refused"; detail?: string }
  | { checked: true; state: "no-staged-residual" }
  | { checked: false; why: string };

/**
 * Round-2 F2——staged 证据和 submit 安全的同一身份源：guarded submit 的 precheck
 * 校验的同样字节决定什么算本次发送的 staged 证据。身份检查跑在任何占位符归因之前
 * （桌面绑定精化）。
 */
interface StagedIdentity {
  /** guarded submit 对照面板残压校验的字节 */
  expectedStagedText: string;
  /** 它们的行数——粘贴文本占位符的绑定 */
  expectedLines: number;
  /** 用户载荷的可识别头部（含在任何 wrap 里），后台服务 precheck 归一化 */
  payloadHead: string;
}

function stagedIdentityFor(payload: string, expectedStagedText: string): StagedIdentity {
  return {
    expectedStagedText,
    expectedLines: expectedStagedText.split("\n").length,
    payloadHead: payload.replace(/\s+/g, "").slice(0, 24),
  };
}

async function classifyDeliveryEffect(
  client: DaemonClient,
  session: string,
  identity: StagedIdentity,
  waitForIdleMs?: number,
): Promise<EffectCheck> {
  const probe = await detectStagedAtPrompt(client, session, identity);
  if (probe.state === "unchecked") return { checked: false, why: probe.why };
  if (probe.state === "not-staged") return { checked: true, state: "no-staged-residual" };
  const enter = await client.post<Record<string, unknown>>("/api/transport/send", {
    session,
    submitOnly: true,
    expectedStagedText: identity.expectedStagedText,
    expectedStagedLineCount: identity.expectedLines,
  }, transportRequestOptions(waitForIdleMs));
  if (enter.status >= 400) {
    return { checked: true, state: "staged", remedy: "submit-refused", detail: (enter.data?.["error"] as string | undefined) ?? `HTTP ${enter.status}` };
  }
  const recheck = await detectStagedAtPrompt(client, session, identity);
  return recheck.state === "staged"
    ? { checked: true, state: "staged", remedy: "submitted-still-staged" }
    : { checked: true, state: "staged", remedy: "submitted-cleared" };
}

/** 在人类界面渲染 EffectCheck；单发与扇出路径共用措辞，使各处报告一致。 */
function effectHumanLines(effect: EffectCheck, session: string): string[] {
  if (!effect.checked) {
    return [`注意：面板效果检查未能运行（${effect.why}）；上面的结论只是传输级。`];
  }
  if (effect.state === "no-staged-residual") return [];
  const out = ["投递：staged，未消费（已检查：发送后面板捕获；观察：发送的文本仍在提示处——敲进去了，从未提交）"];
  if (effect.remedy === "submitted-cleared") {
    out.push("补救：一次 guarded Enter 已提交——staged 文本已离开提示。");
  } else if (effect.remedy === "submitted-still-staged") {
    out.push(`补救：一次 guarded Enter 已提交，但文本仍在提示处——未消费；就此停手（一次提交是约定）。用 zrig capture ${session} 检查`);
  } else {
    out.push(`补救：唯一的 guarded Enter（提交路径）被拒（${effect.detail}）；就此停手——一次提交是约定。用 zrig capture ${session} 检查`);
  }
  return out;
}

/** staged 检测未以 consumed 结束时为 true，表示不可静默的失败。 */
function effectUnresolved(effect: EffectCheck | undefined): boolean {
  return !!effect && effect.checked && effect.state === "staged" && effect.remedy !== "submitted-cleared";
}

/**
 * S3（OPR.0.5.4.6）——提示处已暂存检测器，把 walk 的 staged-evidence 原语推广到
 * 普通发送。只接受正向证据：输入框区域（最后一个提示行之上属于回滚历史，绝不计入）
 * 实际渲染的文本，或 TUI 的粘贴文本占位符。它能证明 STAGED，但绝不能证明已消费；
 * pane 重绘后读不到内容不构成证据。因此调用方把“未检测为 staged”解释为“无覆盖”，
 * 而不是消费证明。
 */
async function detectStagedAtPrompt(
  client: DaemonClient,
  session: string,
  identity: StagedIdentity,
): Promise<{ state: "staged" | "not-staged" } | { state: "unchecked"; why: string }> {
  let cap: { status: number; data: Record<string, unknown> };
  try {
    cap = await client.post<Record<string, unknown>>("/api/transport/capture", { session, lines: 50 }, { headers: terminalAuthHeaders() });
  } catch (err) {
    return { state: "unchecked", why: (err as Error).message };
  }
  const pane = cap.data?.["content"] as string | undefined;
  if (cap.status !== 200 || typeof pane !== "string") {
    return { state: "unchecked", why: (cap.data?.["error"] as string | undefined) ?? `capture HTTP ${cap.status}` };
  }
  // r2 F3：先隔离当前输入区域，即从最后一个提示标记行到 pane 末尾。上方内容都是历史；
  // 回滚区中过期的粘贴文本占位符绝不是 staged 证据，受保护提交也绝不能对历史触发。
  const lines = pane.split("\n");
  let lastPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯›]/.test(lines[i]!)) { lastPrompt = i; break; }
  }
  if (lastPrompt === -1) return { state: "not-staged" };
  const inputRegionRaw = lines.slice(lastPrompt).join("\n").replace(/^\s*[❯›]/, "");
  // 身份优先（第二轮 F2，desk-binding）：字面残留匹配采用后台服务 submit-precheck
  // 自身的规范化方式（移除所有空白后做连续包含），因此检测为阳性在构造上就与受保护
  // 提交的预检兼容。
  const norm = (s: string): string => s.replace(/\s+/g, "");
  if (identity.payloadHead.length > 0 && norm(inputRegionRaw).includes(identity.payloadHead)) {
    return { state: "staged" };
  }
  // 只有确认身份后才归因占位符：当前输入区的粘贴文本占位符，仅在线数绑定到提交守卫
  // 将校验的同一字节时，才算“本次发送已暂存”。无关占位符（他人暂存内容）不可验证，
  // 绝不视为本次发送已暂存，受保护提交也绝不能对它触发。
  const placeholder = inputRegionRaw.match(/\[Pasted text #\d+ \+(\d+) lines\]/);
  if (placeholder) {
    const extra = Number(placeholder[1]);
    const binds = identity.expectedLines > 1 && Math.abs(extra - identity.expectedLines) <= 2;
    if (binds) return { state: "staged" };
    return {
      state: "unchecked",
      why: `a pasted-text placeholder is present in the input region (+${extra} lines) but does not match this send (${identity.expectedLines} line(s)) — unverifiable, not treated as this send; no submit issued`,
    };
  }
  return { state: "not-staged" };
}

async function runCrossHostSend(
  hostId: string,
  session: string,
  text: string,
  opts: { verify?: boolean; force?: boolean; waitForIdle?: string; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; from?: string; json?: boolean },
  deps: SendDeps,
  waitForIdleMs?: number,
  hint?: string,
  selfHostId?: string,
  seatSender: string | undefined = undefined,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const runner = deps.crossHostRun ?? runCrossHostCommand;

  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", hint ? `${resolved.error} (${hint})` : resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

    // OPR.0.4.6.MH4——HTTP 传输分支：通过创建者 `pair` 前门注册的 HTTP 主机，
    // 走 CLI 直连远端后台服务已交付 /api/transport/send 的路径。下方 SSH 路径对 SSH
    // 主机保持逐字节不变；传输方式由主机条目决定，是 SSH 与 HTTP 二选一，绝不是回退。
  if (host.transport === "http") {
    await runHttpHostSend(host, session, text, opts, deps, waitForIdleMs, hint, selfHostId, seatSender);
    return;
  }

    // 为远端 `rig send` 调用重建 argv。位置参数优先排列，使远端 Commander 与本地解析一致。
  const argv: string[] = ["rig", "send", session, text];
  if (opts.verify) argv.push("--verify");
  if (opts.force) argv.push("--force");
  if (opts.waitForIdle !== undefined) argv.push("--wait-for-idle", opts.waitForIdle);
  if (opts.raw) argv.push("--raw");
  if (opts.dangerouslyInteract) argv.push("--dangerously-interact");
  if (opts.reason !== undefined) argv.push("--reason", opts.reason);
    // 发送方来源：SSH 中继会在远端重新运行 `rig send`；若不携带来源，它会解析自身会话，
    // 并把信封发送方降级为 `unknown`。因此传递来源，让远端信封写入原始会话。
    // 这是接线，不是门控。
    // P21 I4 导轨 2：来源是本中继的已认证上下文（$OPENRIG_SESSION_NAME），绝不是调用方
    // 提供的 --from 字符串，后者已弃用且忽略。远端现在从自身 X-OpenRig-Session 头派生
    // From:/actor，因此正确的跨主机重盖章方式是设置远端环境
    // OPENRIG_SESSION_NAME=originTriple，而不是下方 --from argv。在运行器环境接线完成前，
    // 该 argv 对已交付远端是弃用的空操作，已标给 orch。
  const originSender = seatSender; // P18: origin seat env, or undefined → remote renders the unknown-sender marker.
    // 51-09 增量 3：携带来源的完整 <member>@<rig>@<selfHostId> 三元组，使远端信封
    // 标记来源主机而非中继主机。仅当来源尚非三元组时附加本机 self-id；已经携带来源
    // 三元组的 --from 保持原样，绝不重复盖章。
  const originTriple =
    originSender && selfHostId && originSender.split("@").length < 3
      ? `${originSender}@${selfHostId}`
      : originSender;
  if (originTriple) argv.push("--from", originTriple);
  if (opts.json) argv.push("--json");

    // A2（P23）：在远端命令行上以加法方式设置 OPENRIG_SESSION_NAME=<origin triple>，使远端
    // rig 从环境（已交付派生路径）得到来源身份，而非自身席位。上方 argv 仍保留 --from，
    // 因为 I4 前的远端仍从中读取来源；移除该 argv 是另一个受 P23-D1 门控的增量。
    // 两处复用上方只组装一次的同一三元组。
  const result = await runner(host, argv, originTriple ? { originTriple } : {});

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host) },
      result,
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(`[经由主机 ${host.id}（${hostDisplayTarget(host)}）]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, opts.json);
}

/**
 * OPR.0.4.6.MH4 C1——通过 HTTP 跨主机发送，由 CLI 直接访问远端后台服务已交付的
 * POST /api/transport/send，后台服务侧无需改动。构造上保证包装一致：正文与本地路径
 * 使用完全相同的 wrapSendBody 调用和字段，因此远端收到的内容等同于其本地 CLI 所发送。
 * `actorSession` 逐字使用本地发送者，保证来源诚实；远端无法识别时降级为已交付的
 * 非阻塞建议，绝不拒绝。`--verify` 逐字打印远端路由的 verified/outcome，以远端为权威，
 * 绝不在本地合成。截止时间使用读取类客户端默认值；指定 --wait-for-idle 时为
 * waitForIdleMs 加额外开销，与本地路径计算一致。
 *
 * 认证姿态（具名，v0）：配置注册表 bearer 时，runRemoteHttpOp 会携带它；仅 URL 的匿名
 * 主机完全省略 Authorization 头（optional-bearer，a0c17305）。/api/transport/* 由远端
 * TERMINAL bearer 类门控。默认 null 加 tailnet 绑定按设计直接通过；若远端强制另一种
 * terminal bearer，则以结构化权限门控步骤展示，绝不挂起、绝不静默。补救方法记录在
 * cli-reference.md。
 */
async function runHttpHostSend(
  host: HttpHostEntry,
  session: string,
  text: string,
  opts: { verify?: boolean; force?: boolean; waitForIdle?: string; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; from?: string; json?: boolean },
  deps: SendDeps,
  waitForIdleMs?: number,
  hint?: string,
  selfHostId?: string,
  seatSender: string | undefined = undefined,
): Promise<void> {
  // P21 I4：跨主机发送的来源是本地席位环境，即按导轨 2 获得的本后台服务认证上下文；
  // 绝不是调用方 --from 字符串。远端渲染 From: = env；--from 已弃用且忽略。
  const senderSession = seatSender; // P18：席位环境身份；undefined 时仍投递并标注（unknown 标记、null actor）。
  // 根不变量：主机身份只在此跨主机转发边界添加。来源三元组为远端渲染只构造一次；
  // 本地发送绝不携带它。
  const originSender =
    senderSession && selfHostId && senderSession.split("@").length === 2
      ? `${senderSession}@${selfHostId}`
      : senderSession;
  const raw = Boolean(opts.raw || opts.dangerouslyInteract);
  const outboundText = raw ? text : wrapSendBody(originSender, session, text, { stampISO: new Date().toISOString() });

  const result = await runRemoteHttpOp(host.id, "POST", "/api/transport/send", {
    session, text: outboundText, deliveryId: randomUUID(), verify: opts.verify, force: opts.force, waitForIdleMs,
    dangerouslyInteract: opts.dangerouslyInteract, reason: opts.reason, actorSession: senderSession ?? null,
  }, deps, waitForIdleMs !== undefined ? { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS } : {});

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host), transport: "http" },
      result,
      // S3 波次 1 修复（r2 F2）：来源主机无法对远端席位运行 pane 效果检查；
      // 必须明确说明，绝不能暗示已验证效果。
      ...(opts.verify ? { effectCheck: { checked: false, why: "跨主机 http——面板效果检查不在跨主机上跑" } } : {}),
      ...(!result.ok && hint ? { hint } : {}),
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    emitRemoteHttpFailure(host.id, hostDisplayTarget(host), result, false, hint);
    return;
  }

  console.log(`[经由主机 ${host.id}（${hostDisplayTarget(host)}）]`);
  const data = (result.data ?? {}) as Record<string, unknown>;
  if (data["outcome"] === "retained") {
    console.log(`已为 ${session} 保留；未投递。${data["warning"] ?? ""}`);
    return;
  }
  console.log(`已发送给 ${session}`);
  const advisory = data["warning"] as string | undefined;
  if (advisory) {
    console.log(`建议：${advisory}`);
  }
  if (opts.verify) {
    // 远程路由的结论，逐字——镜像本地渲染，让 grep `Verified:` 的脚本跨主机行为一致。
    const verified = data["verified"] as boolean | undefined;
    console.log(`验证：${verified ? "是" : "否"}`);
    const outcome = data["outcome"] as string | undefined;
    if (outcome === "delivered") {
      console.log("投递：delivered（消息已落地；渲染已确认）");
    } else if (outcome === "rendered-unconfirmed") {
      console.log(`投递：rendered-unconfirmed（已落地；面板重绘未确认——用 zrig capture ${session} 确认）`);
    }
    // S3 wave-1 修复（r2 F2）：诚实的跨主机局限——上面的结论是远程传输的；
    // 面板效果检查不在跨主机上跑。
    console.log("效果：未检查——面板效果检查不在跨主机上跑；上面的结论只是传输级。");
  }
}

// OPR.0.4.3.30——扇出发送（`--to` / `--pod` / `--rig`）。通过
// /api/transport/broadcast 复用后台服务的广播机制：解析 → 逐席位发送循环 → 逐接收者结果。
// 消息以裸文本发送；后台服务通过 envelopeSender 为每个接收者包装独立 From/To 信封。
// 裁定 03c35295：后台服务现在在 To 行渲染范围；`--to` 多发送展示完整接收者列表，
// `--rig`/`--pod` 展示广播规模，再加 Sent 时间戳，使接收者只看头部即可区分私信与广播。
// --raw / --dangerously-interact 精确发送原文，不带信封（省略 envelopeSender）。
// 服务端独立守卫每个接收者；单个拒绝绝不中止整个集合。
async function runFanOutSend(params: {
  toList: string[] | undefined;
  pod: string | undefined;
  rig: string | undefined;
  message: string;
  // ba41fea2——此前这里省略 `from`，而调用方运行时已转发它，导致显式 --from 只在
  // 扇出路径被静默丢弃；单席位与两种跨主机路径一直会遵守它。
  opts: { verify?: boolean; force?: boolean; raw?: boolean; dangerouslyInteract?: boolean; reason?: string; from?: string; json?: boolean };
  deps: SendDeps;
  /** P18：从席位环境解析出的席位身份；无法解析时为 undefined。无环境发送仍会投递，
   *  携带 `<unknown sender>` 标记与 null actorSession，不会被拒绝。 */
  seatSender: string | undefined;
}): Promise<void> {
  const { toList, pod, rig, message, opts, deps, seatSender } = params;

  // qitem-c113bd41——与单席位路径使用同一“建议探针、传输权威”契约，包括 ff13bcdf
  // 的惰性探针；见 resolveLocalDaemonUrl。
  const client = deps.clientFactory(await resolveLocalDaemonUrl(deps));
  // P21 I4：扇出 From:（specimen-5 的伪造界面，会渲染到每个接收者终端）由后台服务
  // 从传输头派生；正文 envelopeSender 现在只表示已包装这一标记，关键是是否存在而不是其值。
  // 因此来源是席位环境，绝不是已弃用并忽略的 --from。环境等于盖章后的
  // X-OpenRig-Session，所以正文操作者与派生操作者一致。
  const senderSession = seatSender; // P18：席位环境身份；undefined 时仍投递并标注（unknown 标记、null actor）。
  const raw = Boolean(opts.raw || opts.dangerouslyInteract);

  const body: Record<string, unknown> = {
    text: message,
    verify: opts.verify,
    force: opts.force,
    dangerouslyInteract: opts.dangerouslyInteract,
    reason: opts.reason,
    actorSession: senderSession ?? null,
  };
  if (toList) body.sessions = toList;
  else if (pod) body.pod = pod;
  else if (rig) body.rig = rig;
  // 除 raw/danger 外，服务端为每个接收者单独包装信封。标记是否存在表示这是已包装扇出，
  // 后台服务据此从传输头派生 From:；标记值在服务端忽略（I4）。P18：席位无法解析时
  // 开放失败为 `<unknown sender>` 标记，使标记始终存在。无环境扇出仍携带防风暴的规模头，
  // 避免无会话风暴；它会带标签投递，而不是被拒绝。
  if (!raw) {
    body.envelopeSender = senderSession ?? SENDER_FALLBACK;
  }

  let res: { status: number; data: Record<string, unknown> };
  try {
    res = await client.post<Record<string, unknown>>("/api/transport/broadcast", body, transportRequestOptions());
  } catch (err) {
    if (err instanceof DaemonConnectionError) {
      // 1b45cf21——与单席位路径使用同一辅助函数，因此两条本地路径的补救说明在构造上
      // 逐字节一致，包括以相同方式传递的 --json 信封。
      printTransportFailure(err, { json: opts.json });
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // S3 波次 1 修复（r2 F2）：在输出编码前做逐接收者效果分类。带 --verify 的扇出
  // 通过 pane 效果验证每个已投递接收者；后台服务逐接收者包装，因此受保护提交所期望的
  // 文本是裸负载，而包装后的渲染包含它。
  let effects: Array<{ sessionName: string; effect: EffectCheck }> | undefined;
  if (opts.verify && res.status < 400) {
    effects = [];
    const okRecipients = ((res.data["results"] as Array<{ sessionName: string; ok: boolean; outcome?: string }> | undefined) ?? []).filter((r) => r.ok && r.outcome !== "retained" && r.sessionName);
    for (const r of okRecipients) {
      effects.push({ sessionName: r.sessionName, effect: await classifyDeliveryEffect(client, r.sessionName, stagedIdentityFor(message, message)) });
    }
  }
  const effectBySeat = new Map((effects ?? []).map((e) => [e.sessionName, e.effect]));
  const unresolvedCount = (effects ?? []).filter((e) => effectUnresolved(e.effect)).length;

  if (opts.json) {
    // 第二轮 F1：每个接收者只有一个判定；staged-unresolved 接收者行在任何编码中
    // 都不是送达声明。
    const rawResults = (res.data["results"] as Array<{ sessionName: string; ok: boolean; outcome?: string }> | undefined) ?? [];
    const encodedResults = rawResults.map((r) =>
      effectUnresolved(effectBySeat.get(r.sessionName))
        ? { ...r, ok: false, verified: false, outcome: "staged-not-consumed", error: "staged，未消费（面板效果）；唯一的 guarded submit 没清掉它" }
        : r
    );
    // 第三轮（r2 行 00fb3a68）：机器可读汇总从已分类编码结果派生，绝不取原始传输计数；
    // staged-unresolved 接收者在任何字段中都不算 sent/delivered。
    const encodedSent = encodedResults.filter((r) => r.ok && r.outcome !== "retained").length;
    console.log(JSON.stringify(effects
      ? { ...res.data, results: encodedResults, sent: encodedSent, failed: encodedResults.filter(r => !r.ok).length, retained: encodedResults.filter(r => r.outcome === "retained").length, effectChecks: effects }
      : res.data));
    if (res.status >= 400 || rawResults.some((r) => !r.ok)) process.exitCode = 1;
    if (unresolvedCount > 0) process.exitCode = 1;
    return;
  }

  if (res.status >= 400) {
    const error = res.data["error"] as string | undefined;
    console.error(error ?? `Send failed (HTTP ${res.status})`);
    process.exitCode = res.status >= 500 ? 2 : 1;
    return;
  }

  const data = res.data;
  const results = (data["results"] as Array<{ sessionName: string; ok: boolean; error?: string; outcome?: string }>) ?? [];
  // 第二轮 F1（desk-binding）：每个接收者只有一条判定行。staged-unresolved 接收者
  // 显示其 staged 判定而非 `sent`；虚假的送达声明会完全移除，而不是加限定词。
  for (const r of results) {
    if (r.outcome === "retained") { console.log(`${r.sessionName}：已保留，未投递；用 zrig seat held-messages 查看`); continue; }
    if (!r.ok) {
      console.log(`${r.sessionName}：失败——${r.error ?? "未知错误"}`);
      continue;
    }
    const ec = effectBySeat.get(r.sessionName);
    if (ec && ec.checked && ec.state === "staged") {
      if (ec.remedy === "submitted-cleared") {
        console.log(`${r.sessionName}：已发送——在提示处 staged，由一次 guarded Enter 清掉（已消费）`);
      } else {
        console.log(`${r.sessionName}：staged，未消费——${effectHumanLines(ec, r.sessionName).slice(-1)[0]}`);
      }
    } else if (ec && !ec.checked) {
      console.log(`${r.sessionName}：已发送（效果未检查：${ec.why}——仅传输结论）`);
    } else {
      console.log(`${r.sessionName}：已发送`);
    }
  }
  // 已投递计数绝不包含 staged-unresolved 接收方。
  const deliveredCount = Math.max(0, ((data["sent"] as number) ?? 0) - unresolvedCount);
  console.log(`${deliveredCount}/${data["total"]} 已投递${unresolvedCount > 0 ? `，${unresolvedCount} 个 staged-未消费` : ""}`);
  // S2（OPR.0.5.4.3）：暴露附加建议（例如 unknown-sender 的 sign-it 通知）——
  // 无 env 的操作人员必须看到它，而不只是"已发送"行。
  const fanoutAdvisory = data["warning"] as string | undefined;
  if (fanoutAdvisory) {
    console.log(`建议：${fanoutAdvisory}`);
  }
  if (unresolvedCount > 0) process.exitCode = 1;
  if ((data["failed"] as number) > 0 || results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}

function parseWaitForIdleMs(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000);
}

function waitForIdleRequestOptions(waitForIdleMs: number | undefined): { timeoutMs: number } | undefined {
  if (waitForIdleMs === undefined) return undefined;
  return { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS };
}

function transportRequestOptions(waitForIdleMs?: number): { timeoutMs?: number; headers?: Record<string, string> } | undefined {
  const waitOptions = waitForIdleRequestOptions(waitForIdleMs);
  const headers = terminalAuthHeaders();
  const hasHeaders = Object.keys(headers).length > 0;
  if (!waitOptions && !hasHeaders) return undefined;
  return {
    ...(waitOptions ?? {}),
    ...(hasHeaders ? { headers } : {}),
  };
}

/** B8-2 测试接缝：传输失败渲染器，导出供诚实性钉测试使用。 */
export function printTransportFailureForTest(err: DaemonConnectionError, opts?: { json?: boolean }): void {
  printTransportFailure(err, opts);
}
