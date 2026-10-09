import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget } from "../host-registry.js";
import { emitCrossHostError, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { resolveCrossHostTarget } from "../cross-host-target.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";

export interface TranscriptDeps extends StatusDeps {
  /** 测试接缝：注入一个注册表加载器，避免触碰真实的 ~/.openrig。 */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
}

export function transcriptCommand(depsOverride?: TranscriptDeps): Command {
  const cmd = new Command("transcript").description("读取智能体 transcript 输出");
  const getDeps = (): TranscriptDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<session>", "会话名（例如 dev-impl@my-rig）")
    .option("--tail <lines>", "显示末尾 N 行（默认：50）", "50")
    .option("--grep <pattern>", "搜索匹配该模式的行（正则）")
    .option("--host <id>", "从 ~/.openrig/hosts.yaml 中声明的远程主机读取（仅 http 主机——CLI 直连远程后台服务的 transcript 路由）")
    .option("--json", "供智能体使用的 JSON 输出")
    .addHelpText("after", `
示例：
  zrig transcript dev-impl@my-rig --tail 100
  zrig transcript dev-impl@my-rig --grep "decision|architecture"
  zrig transcript dev-impl@my-rig --json
  zrig transcript --host vps-b dev-impl@my-rig --tail 100
  zrig transcript dev-impl@my-rig@vps-b --grep "handoff"

--host 从 ~/.openrig/hosts.yaml 中声明的远程主机读取 transcript，
CLI 直连该后台服务随附的 transcript 路由（http 注册的主机，例如配对注册；
ssh 注册的主机将返回结构化的传输要求错误）。输出形状与源端逐字一致。
形如 agent@rig@host 的会话，当后缀是已注册主机 id 时，等价于 --host
（显式 --host > 简写 > 已持久化的选择）。`)
    .addHelpText("after", `
CLAUDE 席位的 transcript 几乎总是很单薄，通常意味着该席位运行着 Claude Code 的
全屏渲染器，它绘制到终端备用屏幕且不产生回滚缓冲——因此 tmux capture-pane
（以及本命令）几乎看不到内容。zrig 默认以
CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 启动 Claude 席位（经典渲染器、原生回滚）。
单薄的 transcript 说明该席位早于该默认设置，或在启动时设了
OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0——请重新启动它以恢复回滚。`)
    .action(async (session: string, opts: { tail?: string; grep?: string; host?: string; json?: boolean }) => {
      // OPR.0.4.6.MH4 C2 —— 跨主机观察：显式 --host >
      // `agent@rig@host` 目标简写 > 已持久化的主机选择
      // （resolveEffectiveHost）。下面的本地路径逐字节不动。
      const explicitHost = opts.host;
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();

      const targetResolution = resolveCrossHostTarget(session, explicitHost, deps.hostRegistryLoader);
      if (!targetResolution.ok) {
        console.error(targetResolution.error);
        process.exitCode = 1;
        return;
      }
      session = targetResolution.target;
      const crossHostHint = targetResolution.hint;
      if (targetResolution.warning) console.error(targetResolution.warning);
      opts.host = explicitHost ?? targetResolution.sugarHost ?? opts.host;

      // 同时给出 --grep 与 --tail 时，--grep 优先
      const useGrep = !!opts.grep;
      const tailLines = parseInt(opts.tail ?? "50", 10);
      const apiPath = useGrep
        ? `/api/transcripts/${encodeURIComponent(session)}/grep?pattern=${encodeURIComponent(opts.grep!)}`
        : `/api/transcripts/${encodeURIComponent(session)}/tail?lines=${isNaN(tailLines) ? 50 : tailLines}`;

      // --- 跨主机路径（CLI 直连 GET 远程后台服务随附的
      // transcript 路由——与本地路径构建相同的路径，源端形状逐字一致；
      // 读类截止；后台服务不动）。---
      if (opts.host) {
        await runCrossHostTranscript(opts.host, apiPath, useGrep, opts, deps, crossHostHint);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.get<Record<string, unknown>>(apiPath);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `transcript 请求失败（HTTP ${res.status}）`);
        // MH-4 §4 响亮失败提示：三段式形状目标、未注册后缀。
        if (crossHostHint) console.error(`提示：${crossHostHint}`);
        process.exitCode = 1;
        return;
      }

      renderTranscript(res.data, useGrep);
    });

  return cmd;
}

/**
 * OPR.0.4.6.MH4 C2 —— 经 http 的跨主机 transcript，CLI 直连远程后台服务随附的
 * GET /api/transcripts/:session/tail | /grep
 * （零后台服务端改动；MH-2 读透模式，距带 bearer 的 CLI 一跳）。
 * ssh 注册的主机会呈现 runRemoteHttpOp 的结构化传输错误——绝不静默地用错传输方式。
 */
async function runCrossHostTranscript(
  hostId: string,
  apiPath: string,
  useGrep: boolean,
  opts: { json?: boolean },
  deps: TranscriptDeps,
  hint?: string,
): Promise<void> {
  // 在调用方解析主机（send/capture 模式），使未知主机在四个动词中都呈现
  // 为同一个 `unknown-host` 步骤类，且横幅统一携带展示目标。
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
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

  const result = await runRemoteHttpOp(hostId, "GET", apiPath, undefined, deps, {});

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
  renderTranscript((result.data ?? {}) as Record<string, unknown>, useGrep);
}

/** 一个渲染器、两个调用方——远程输出形状与源端一致，
 *  因此本地与跨主机读取的渲染完全相同。 */
function renderTranscript(data: Record<string, unknown>, useGrep: boolean): void {
  if (useGrep) {
    const matches = data["matches"] as string[] | undefined;
    if (matches && matches.length > 0) {
      for (const line of matches) {
        console.log(line);
      }
    } else {
      console.log("未找到匹配行。");
    }
  } else {
    const content = data["content"] as string | undefined;
    let printed = 0;
    if (content) {
      // 逐行用 console.log 打印，便于在测试与终端中一致捕获
      const lines = content.split("\n");
      for (const line of lines) {
        if (line) {
          console.log(line);
          printed++;
        }
      }
    }
    // OPR.0.5.3.1 第 4 项——使用点提示：Claude 席位近乎为空的 transcript
    // 几乎总是意味着全屏渲染器（备用屏幕 → 无回滚）。打到 stderr，
    // 以免污染 stdout 上的内容。
    if (printed <= THIN_TRANSCRIPT_LINES) emitThinTranscriptHint(printed);
  }
}

/** transcript 行数小于等于此值即被视为可疑地单薄。 */
const THIN_TRANSCRIPT_LINES = 5;

function emitThinTranscriptHint(printed: number): void {
  console.error(
    `注意：仅捕获到 ${printed} 行。对 CLAUDE 席位而言，这通常意味着使用了全屏渲染器` +
      `（备用屏幕不产生回滚）。zrig 默认以 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 启动 Claude 席位；` +
      `单薄的 transcript 说明该席位早于此设置，或设了 OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0——请重新启动它。`,
  );
}
