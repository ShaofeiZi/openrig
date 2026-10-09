import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { resolveCrossHostTarget } from "../cross-host-target.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";

export interface CaptureDeps extends StatusDeps {
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

export function captureCommand(depsOverride?: CaptureDeps): Command {
  const cmd = new Command("capture").description("抓取智能体会话的终端输出");
  const getDeps = (): CaptureDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("[session]", "会话名（多目标时配合 --rig/--pod 省略）")
    .option("--rig <name>", "抓取一个工作组内的所有会话")
    .option("--pod <name>", "抓取一个 pod 内的所有会话")
    .option("--lines <n>", "抓取行数（默认：20）", "20")
    .option("--host <id>", "在 ~/.openrig/hosts.yaml 中声明的远程主机上抓取（ssh 主机会 shell out；http 主机由 CLI 直连远程后台服务）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  zrig capture dev-impl@my-rig
  zrig capture dev-impl@my-rig --lines 50
  zrig capture --rig my-rig
  zrig capture --pod dev --rig my-rig
  zrig capture --rig my-rig --json
  zrig capture --host remote-dev dev-impl@my-rig --lines 50

说明：
  - 多目标抓取会把不支持的 external_cli 节点明确报为逐目标失败。
  - 对仅出站的 external_cli 节点，请改用 zrig whoami/zrig ps，不要用 zrig capture。
  - --host 在 ~/.openrig/hosts.yaml 中声明的远程主机上抓取。主机条目所声明的
    传输方式决定路径：ssh 主机经单跳 ssh；http 主机（如 pair 注册的）由 CLI
    直连远程后台服务的 capture 路由。无论哪种方式，远端对自己能抓什么说了算。
    形如 agent@rig@host 的会话写法是 --host 的糖（后缀是已注册主机 id 时）
    （显式 --host > 糖写法 > 已保存选择）。`)
    .action(async (session: string | undefined, opts: { rig?: string; pod?: string; lines?: string; host?: string; json?: boolean }) => {
      // OPR.0.4.6.MH1 FR-2：选定主机路由——显式 --host 优先；
      // 否则把已保存的选择喂给已交付的 --host 路径；没有选择则与今日行为完全一致。
      // OPR.0.4.6.MH4 §4：保留原始标志，让目标糖写法位于显式与已保存选择之间。
      const explicitHost = opts.host;
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();

      // OPR.0.4.6.MH4 §4——`agent@rig@host` 目标糖（仅会话操作数；
      // --rig/--pod 的值是名称，绝不做糖解析）。后缀必须匹配已注册主机 id，
      // 否则透传并给出醒目的失败提示。
      let crossHostHint: string | undefined;
      if (session !== undefined) {
        const targetResolution = resolveCrossHostTarget(session, explicitHost, deps.hostRegistryLoader);
        if (!targetResolution.ok) {
          console.error(targetResolution.error);
          process.exitCode = 1;
          return;
        }
        session = targetResolution.target;
        crossHostHint = targetResolution.hint;
        if (targetResolution.warning) console.error(targetResolution.warning);
        opts.host = explicitHost ?? targetResolution.sugarHost ?? opts.host;
      }

      // --- 跨主机短路（CLI 侧；ssh shell-out 或 MH-4 http 分支；不动后台服务） ---
      if (opts.host) {
        await runCrossHostCapture(opts.host, session, opts, deps, crossHostHint);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const lines = parseInt(opts.lines ?? "20", 10);

      const body: Record<string, unknown> = { lines: isNaN(lines) ? 20 : lines };
      if (opts.rig) body.rig = opts.rig;
      if (opts.pod) body.pod = opts.pod;
      if (session) body.session = session;

      const res = await client.post<Record<string, unknown>>("/api/transport/capture", body, { headers: terminalAuthHeaders() });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `抓取失败（HTTP ${res.status}）`);
        // MH-4 §4 醒目失败提示：三段式目标，后缀未注册。
        if (crossHostHint) console.error(`提示：${crossHostHint}`);
        process.exitCode = 1;
        return;
      }

      // 多目标结果
      const results = (res.data as Record<string, unknown>)["results"] as Array<{ sessionName: string; content?: string; ok: boolean; error?: string }> | undefined;
      if (results) {
        for (const r of results) {
          console.log(`--- ${r.sessionName} ---`);
          if (r.ok && r.content) {
            console.log(r.content);
          } else {
            console.log(`  （错误：${r.error ?? "无内容"}）`);
          }
        }
        return;
      }

      // 单目标结果
      const content = (res.data as Record<string, unknown>)["content"] as string | undefined;
      if (content) {
        console.log(content);
      }
    });

  return cmd;
}

async function runCrossHostCapture(
  hostId: string,
  session: string | undefined,
  opts: { rig?: string; pod?: string; lines?: string; json?: boolean },
  deps: CaptureDeps,
  hint?: string,
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

  // OPR.0.4.6.MH4——http 传输分支：CLI 直连 POST 到远程后台服务已交付的
  // /api/transport/capture，请求体与本地路径一致。ssh 主机原样走 shell-out。
  if (host.transport === "http") {
    await runHttpHostCapture(host, session, opts, deps, hint);
    return;
  }

  // 重建 argv。顺序：位置参数在前，然后是标志。
  const argv: string[] = ["rig", "capture"];
  if (session) argv.push(session);
  if (opts.rig) argv.push("--rig", opts.rig);
  if (opts.pod) argv.push("--pod", opts.pod);
  if (opts.lines !== undefined) argv.push("--lines", opts.lines);
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

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
 * OPR.0.4.6.MH4 C1——经 http 的跨主机抓取，CLI 直连远程后台服务已交付的
 * POST /api/transport/capture（后台服务侧零改动）。请求体与本地路径一致
 *（lines/rig/pod/session）；远端的单/多目标结果按本地抓取的方式渲染，
 * 顶部带 `[经由主机 …]` 横幅。读类截止时间（客户端默认）。
 */
async function runHttpHostCapture(
  host: HttpHostEntry,
  session: string | undefined,
  opts: { rig?: string; pod?: string; lines?: string; json?: boolean },
  deps: CaptureDeps,
  hint?: string,
): Promise<void> {
  const lines = parseInt(opts.lines ?? "20", 10);
  const body: Record<string, unknown> = { lines: isNaN(lines) ? 20 : lines };
  if (opts.rig) body.rig = opts.rig;
  if (opts.pod) body.pod = opts.pod;
  if (session) body.session = session;

  const result = await runRemoteHttpOp(host.id, "POST", "/api/transport/capture", body, deps, {});

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host), transport: "http" },
      result,
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

  // 多目标结果——按本地路径的方式原样渲染。
  const results = data["results"] as Array<{ sessionName: string; content?: string; ok: boolean; error?: string }> | undefined;
  if (results) {
    for (const r of results) {
      console.log(`--- ${r.sessionName} ---`);
      if (r.ok && r.content) {
        console.log(r.content);
      } else {
        console.log(`  （错误：${r.error ?? "无内容"}）`);
      }
    }
    return;
  }

  // 单目标结果
  const content = data["content"] as string | undefined;
  if (content) {
    console.log(content);
  }
}

