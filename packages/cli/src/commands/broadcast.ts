import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget } from "../host-registry.js";
import { emitCrossHostError, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";
import { resolveContextRef, walkSizedWarning } from "../context-resolve.js";
import { resolveSenderSession, SENDER_FALLBACK } from "../sender-identity.js";
import { refuseEmptyMessage } from "./send.js";

/**
 * OPR.0.4.6.MH4 C3 —— 跨主机广播的截止时间，在调用处命名
 * （arch 交付通道注 (a)）：远程路由只有在源端后台服务的逐目标扇出循环
 * 完成后才响应，因此多席位工作组需要比 5s 读类默认更长的时间。
 */
const BROADCAST_REMOTE_TIMEOUT_MS = 30_000;

export interface BroadcastDeps extends StatusDeps {
  /** 测试接缝：注入注册表加载器，避免触碰真实的 ~/.openrig。 */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
}

export function broadcastCommand(depsOverride?: BroadcastDeps): Command {
  const cmd = new Command("broadcast").description("向多个智能体会话发送一条消息");
  const getDeps = (): BroadcastDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("[text]", "要广播的消息文本（配合 --context 时可省略）")
    .option("--rig <name>", "向一个工作组中的所有会话广播")
    .option("--pod <name>", "向一个 Pod 中的所有会话广播")
    .option("--force", "即使目标看起来正在执行任务也发送")
    .option("--host <id>", "在 ~/.openrig/hosts.yaml 中声明的远程主机上广播（仅 http 主机——CLI 直连远程后台服务的扇出）")
    .option("--context <ref>", "按路径式引用广播一个上下文包（例如 packs/fleet-update）。解析出的内容被扇出；过大的引用会被标记为 'walk-sized'。")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  zrig broadcast --rig my-rig "检查点评审已完成。继续工作。"
  zrig broadcast --pod dev "新任务规范见 docs/planning/next-task.md"
  zrig broadcast "系统将在 5 分钟后维护。"
  zrig broadcast --rig my-rig "message" --json
  zrig broadcast --host vps-b --rig remote-rig "协调远程工厂"

不带 --rig 或 --pod 时，广播到所有运行中的 tmux 会话，外加跨所有工作组挂载的 external_cli 节点。
不受支持的 external_cli 目标会在结果中作为逐目标的显式失败返回。

--host 在 ~/.openrig/hosts.yaml 中声明的远程主机上广播，
CLI 直连该后台服务随附的广播扇出（http 注册的主机，例如配对注册；
ssh 注册的主机将返回结构化的传输要求错误）。远程后台服务在其自己的
拓扑上解析 --rig/--pod，其逐目标结果逐字打印——部分扇出与本地一样
以非零退出。位置参数是消息文本（绝不解析为目标），因此广播采用
--host 或已持久化的主机选择，而不是 agent@rig@host 简写。`)
    .action(async (text: string | undefined, opts: { rig?: string; pod?: string; force?: boolean; host?: string; context?: string; json?: boolean }) => {
      // OPR.0.4.6.MH4 C3 —— 显式 --host > 已持久化选择。广播
      // 没有会话目标操作数（位置参数是消息文本，绝不能做简写解析），
      // 因此 §4 的简写在这里不适用。
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();

      // 原子 6b：v1 中 --context 是本地广播（跨主机 --context 是后续工作）；
      // 当 --context 提供负载时消息可省略。
      if (opts.context && opts.host) {
        console.error("v1 中 --context 仅支持本地广播（不与 --host 同用）。");
        process.exitCode = 1;
        return;
      }
      if (text === undefined && !opts.context) {
        console.error("请提供要广播的消息（或 --context <ref>）。");
        process.exitCode = 1;
        return;
      }
      if (!opts.context && refuseEmptyMessage(text!, "broadcast", Boolean(opts.json))) return;

      // P18 投递并标注——席位边界不再拒绝。从席位环境解析广播席位；
      // 无法解析时广播仍继续，携带诚实的 `<unknown sender>`
      // 标记（这样反风暴规模头始终存在——不会出现无会话风暴），是投递并标注
      // 而非拒绝。`seatSender` 为 `string | undefined`，贯穿两条派发路径。
      // 对应后台服务那一半，它对缺头写入也是投递并标注（不返回 401）。
      const seatSender = resolveSenderSession();

      // --- 跨主机路径（CLI 直连 POST 远程后台服务随附的
      // /api/transport/broadcast；它自己的扇出引擎在其拓扑上解析
      // TargetSpec；后台服务不动）。---
      if (opts.host) {
        // 此处 text 已被校验非空：--context 与 --host 被拒绝，且上面的
        // （无 text 且无 context）守卫在 host 路径上要求它。
        await runCrossHostBroadcast(opts.host, text!, opts, deps, seatSender);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // 原子 6b：--context 把包引用解析为其全部内容（全有或全无——
      // 缺少任一成员会在任何扇出前中止）并投递。消息 + --context 先扇出
      // 消息，再扇出上下文，中间空一行。
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
        const warn = walkSizedWarning(resolved);
        if (warn && !opts.json) console.log(`提示：${warn}`);
      }
      if (refuseEmptyMessage(payload, "broadcast", Boolean(opts.json))) return;
      const body: Record<string, unknown> = { text: payload, force: opts.force };
      if (opts.rig) body.rig = opts.rig;
      if (opts.pod) body.pod = opts.pod;
      // 发送/广播头（裁决 03c35295）：标识广播席位，使后台服务扇出
      // 用规模头（"broadcast to <rig> (N seats)" / 拓扑）包裹每个接收者，
      // 而不是裸投递——接收者能看出这是广播头单独存在（反风暴的牙齿）。
      // P18：`seatSender` 是广播席位，无法解析时开放为 `<unknown sender>`——
      // 标记始终存在，因此其"存在"仍是包裹每个接收者规模头的反风暴信号。
      // 其"值"在后台服务端被忽略（扇出从传输头派生 From:）。无环境的广播
      // 投递并标注，而非拒绝。
      body.envelopeSender = seatSender ?? SENDER_FALLBACK;

      const res = await client.post<Record<string, unknown>>("/api/transport/broadcast", body);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        const results = ((res.data as Record<string, unknown>)["results"] as Array<{ ok: boolean }> | undefined) ?? [];
        if (res.status >= 400 || results.some((r) => !r.ok)) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `广播失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      renderBroadcastResults(res.data as Record<string, unknown>);
    });

  return cmd;
}

/**
 * OPR.0.4.6.MH4 C3 —— 经 http 的跨主机广播，CLI 直连远程后台服务随附的
 * POST /api/transport/broadcast（零后台服务端改动）。请求体逐字采用本地形状
 * （{text, force, rig?, pod?}）；源端后台服务自己的扇出引擎在其拓扑上解析
 * TargetSpec 并返回逐目标结果，逐字打印——逐目标诚实是透传，绝不汇总；
 * 部分扇出与本地路径一样以非零退出。截止：BROADCAST_REMOTE_TIMEOUT_MS
 * （命名之——完整扇出比读类默认更久）。
 */
async function runCrossHostBroadcast(
  hostId: string,
  text: string,
  opts: { rig?: string; pod?: string; force?: boolean; json?: boolean },
  deps: BroadcastDeps,
  seatSender: string | undefined = undefined,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  const body: Record<string, unknown> = { text, force: opts.force };
  if (opts.rig) body.rig = opts.rig;
  if (opts.pod) body.pod = opts.pod;
  // P21 跨主机广播修复 + P18：补上已封装扇出标记（一次重建曾把它丢掉，
  // 导致远程渲染为裸内容而本地路径有包裹）。`seatSender` 是源端席位，
  // 无法解析时开放为 `<unknown sender>`——标记始终存在。DaemonClient 在此 POST
  // 上自动盖 X-OpenRig-Session=源端环境（client.ts:171，P18  choke point），
  // 因此远程从传输头派生 From:；标记的"值"被忽略。不额外盖头（那会对已盖的头
  // 造成第二个来源）。
  body.envelopeSender = seatSender ?? SENDER_FALLBACK;

  const result = await runRemoteHttpOp(hostId, "POST", "/api/transport/broadcast", body, deps, {
    timeoutMs: BROADCAST_REMOTE_TIMEOUT_MS,
  });

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host), transport: "http" },
      result,
    }));
    const results = ((result.data as Record<string, unknown> | undefined)?.["results"] as Array<{ ok: boolean }> | undefined) ?? [];
    if (!result.ok || results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    emitRemoteHttpFailure(host.id, hostDisplayTarget(host), result, false);
    return;
  }

  console.log(`[经由主机 ${host.id}（${hostDisplayTarget(host)}）]`);
  renderBroadcastResults((result.data ?? {}) as Record<string, unknown>);
}

/** 一个渲染器、两个调用方——远程路由返回与本地路由相同的形状，
 *  因此逐目标诚实打印一致。部分扇出无论哪条路径都以非零退出。 */
function renderBroadcastResults(data: Record<string, unknown>): void {
  const results = (data["results"] as Array<{ sessionName: string; ok: boolean; error?: string }>) ?? [];
  for (const r of results) {
    if (r.ok) {
      console.log(`${r.sessionName}：已发送`);
    } else {
      console.log(`${r.sessionName}：失败 — ${r.error ?? "未知错误"}`);
    }
  }
  console.log(`已投递 ${data["sent"]}/${data["total"]}`);
  // S2 (OPR.0.5.4.3)：呈现附加提示（例如 unknown-sender 的登录提示）——
  // 无环境的操作者必须看到它，而不只是"已发送"行。
  const advisory = data["warning"] as string | undefined;
  if (advisory) {
    console.log(`提示：${advisory}`);
  }

  if ((data["failed"] as number) > 0 || results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}
