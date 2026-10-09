import { Command } from "commander";
import { readOwnHostName, resolveEffectiveHost } from "../host-selection.js";
import { execSync } from "node:child_process";
import { DaemonClient, remoteDaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, resolveOriginSelfHostId, fetchSelfHostIdentity } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, resolveRemoteBearer, bearerAuthHeaders, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";

interface WhoamiCliOptions {
  nodeId?: string;
  session?: string;
  host?: string;
  allHosts?: boolean;
  hosts?: string;
  json?: boolean;
  full?: boolean;
  verbose?: boolean;
}

export interface WhoamiDeps extends StatusDeps {
  /** 跨主机钩子；镜像 PsDeps/SendDeps 形状。测试注入 mock。 */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

interface WhoamiIdentity {
  rigName: string;
  logicalId: string;
  attachmentType: string | null;
  podId: string | null;
  podNamespace?: string | null;
  memberId: string;
  sessionName: string | null;
  runtime: string;
}

interface WhoamiPeer {
  logicalId: string;
  sessionName: string | null;
  runtime: string;
  podNamespace?: string | null;
}

interface WhoamiEdge {
  kind: string;
  to?: { logicalId: string; sessionName: string | null };
  from?: { logicalId: string; sessionName: string | null };
}

interface WhoamiResult {
  resolvedBy: string;
  identity: WhoamiIdentity & Record<string, unknown>;
  peers: WhoamiPeer[];
  edges: { outgoing: WhoamiEdge[]; incoming: WhoamiEdge[] };
  transcript: { enabled: boolean; path: string | null; tailCommand: string | null };
  contextUsage?: {
    availability: string;
    usedPercentage?: number | null;
    remainingPercentage?: number | null;
    contextWindowSize?: number | null;
  };
}

/**
 * OPR.0.4.0.27——把完整 whoami payload 投影到身份恢复白名单
 *（不是黑名单：未来的 payload 字段默认归 --full，不能静默让每次启动路径
 * 重新膨胀）。只带启动 + 压缩恢复契约视为事实来源的字段。
 */
function projectCompactWhoami(data: Record<string, unknown>): Record<string, unknown> {
  const id = (data["identity"] ?? {}) as Record<string, unknown>;
  const peers = Array.isArray(data["peers"]) ? (data["peers"] as unknown[]) : [];
  const transcript = (data["transcript"] ?? {}) as Record<string, unknown>;
  return {
    resolvedBy: data["resolvedBy"],
    identity: {
      rigName: id["rigName"],
      nodeId: id["nodeId"],
      logicalId: id["logicalId"],
      podId: id["podId"],
      podNamespace: id["podNamespace"],
      memberId: id["memberId"],
      sessionName: id["sessionName"],
      runtime: id["runtime"],
    },
    peers: peers.map((p) => {
      const peer = (p ?? {}) as Record<string, unknown>;
      return { logicalId: peer["logicalId"], sessionName: peer["sessionName"], runtime: peer["runtime"] };
    }),
    // 保留：openrig-user SKILL.md 把 peersNote 文档化为必需的恢复字段。
    peersNote: data["peersNote"],
    // edges 已经只带 kind + to/from {logicalId, sessionName}。
    edges: data["edges"],
    transcript: { path: transcript["path"], tailCommand: transcript["tailCommand"] },
  };
}

type TmuxExecFn = (cmd: string) => string;

const defaultTmuxExec: TmuxExecFn = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();

function buildPartialWhoamiResult(source: { nodeId?: string; sessionName?: string }): Record<string, unknown> {
  return {
    resolvedBy: source.nodeId ? "node_id" : "session_name",
    partial: true,
    daemonReachable: false,
    identity: {
      rigId: null,
      rigName: null,
      nodeId: source.nodeId ?? null,
      logicalId: null,
      attachmentType: null,
      podId: null,
      podNamespace: null,
      podLabel: null,
      memberId: null,
      memberLabel: null,
      sessionName: source.sessionName ?? null,
      runtime: null,
      cwd: null,
      agentRef: null,
      profile: null,
      resolvedSpecName: null,
      resolvedSpecVersion: null,
    },
    peers: [],
    edges: { outgoing: [], incoming: [] },
    transcript: { enabled: false, path: null, tailCommand: null },
  };
}

/**
 * 用批准的解析链解析当前会话身份：
 * 1. --node-id 标志
 * 2. --session 标志
 * 3. OPENRIG_NODE_ID 环境变量
 * 4. OPENRIG_SESSION_NAME 环境变量
 * 5. TMUX_PANE → @rigged_node_id tmux 元数据
 * 6. TMUX_PANE → @rigged_session_name tmux 元数据
 * 7. TMUX_PANE → tmux display-message（原始会话名）
 * 8. 失败
 */
export function resolveIdentitySource(
  opts: { nodeId?: string; session?: string },
  tmuxExec: TmuxExecFn = defaultTmuxExec,
): { nodeId?: string; sessionName?: string } | null {
  if (opts.nodeId) return { nodeId: opts.nodeId };
  if (opts.session) return { sessionName: opts.session };

  const envNodeId = readOpenRigEnv("OPENRIG_NODE_ID", "RIGGED_NODE_ID");
  const envSessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  if (envNodeId) {
    return {
      nodeId: envNodeId,
      ...(envSessionName ? { sessionName: envSessionName } : {}),
    };
  }
  if (envSessionName) return { sessionName: envSessionName };

  // TMUX_PANE 兜底——先试 OpenRig 元数据，再试原始会话名
  const tmuxPane = process.env["TMUX_PANE"];
  if (tmuxPane) {
    // Step 5：@rigged_node_id 元数据（最强的已认领会话锚点）
    try {
      const nodeId = tmuxExec(`tmux show-option -v -t ${JSON.stringify(tmuxPane)} @rigged_node_id`);
      if (nodeId) return { nodeId };
    } catch { /* 元数据未设置——继续 */ }

    // Step 6：@rigged_session_name 元数据
    try {
      const sessionName = tmuxExec(`tmux show-option -v -t ${JSON.stringify(tmuxPane)} @rigged_session_name`);
      if (sessionName) return { sessionName };
    } catch { /* 元数据未设置——继续 */ }

    // Step 7：原始 tmux 会话名（最弱兜底）
    try {
      const sessionName = tmuxExec(`tmux display-message -p -t ${JSON.stringify(tmuxPane)} "#{session_name}"`);
      if (sessionName) return { sessionName };
    } catch {
      // tmux 不可用或未找到 pane——跳过
    }
  }

  return null;
}

export function whoamiCommand(depsOverride?: WhoamiDeps): Command {
  const cmd = new Command("whoami").description("展示 zrig 拓扑中当前受管身份");
  const getDeps = (): WhoamiDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .option("--node-id <id>", "按节点 ID 解析")
    .option("--session <name>", "按会话名解析")
    .option("--host <id>", "在 ~/.openrig/hosts.yaml 中声明的远程主机上运行")
    .option("--all-hosts", "扇出到所有已注册 HTTP 主机")
    .option("--hosts <ids>", "扇出到特定主机（逗号分隔）")
    .option("--json", "供智能体使用的 JSON 输出（默认紧凑身份恢复投影）")
    .option("--full", "展示完整 whoami payload（contextUsage、命令、runtimeContext、workspace、所有子字段）")
    .option("--verbose", "--full 的别名")
    .addHelpText("after", `
默认情况下 rig whoami 是紧凑的：身份（rig/pod/member/session/runtime）、
peers（带 sessionName 供 'rig send' 用）、edges 和 transcript 路径——
启动 + 压缩恢复的必需品。用 --full / --verbose 看完整 payload
（contextUsage、命令示例、runtime token 详情、workspace 块）。
紧凑形式省略 Context 行；用 'rig context' 或 'rig whoami --full' 看用量。`)
    .action(async (opts: WhoamiCliOptions) => {
      // OPR.0.4.6.MH1 FR-2：选定主机路由——显式 --host 优先；
      // 否则把已保存的选择喂给已交付的 --host 路径；没有选择则与今日一致。
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();
      const full = Boolean(opts.full || opts.verbose);

      if (opts.allHosts || opts.hosts) {
        await runFanOutWhoami(opts, deps);
        return;
      }

      if (opts.host) {
        await runCrossHostWhoami(opts.host, opts, deps);
        return;
      }

      const source = resolveIdentitySource(opts);
      if (!source) {
        console.error("无法确定身份。请在 zrig 受管会话内运行，或使用 --session 或 --node-id。");
        process.exitCode = 1;
        return;
      }
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        const partial = buildPartialWhoamiResult(source);
        if (opts.json) {
          console.log(JSON.stringify(partial, null, 2));
          return;
        }
        const identity = partial.identity as Record<string, string | null>;
        console.log("后台服务不可达——拓扑与 peer 信息不可用。");
        console.log(`节点 ID：  ${identity.nodeId ?? "—"}`);
        console.log(`会话：    ${identity.sessionName ?? "—"}`);
        console.log(`解析方式：部分 via ${String(partial.resolvedBy).replace(/_/g, " ")}`);
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));
      const params = new URLSearchParams();
      if (source.nodeId) params.set("nodeId", source.nodeId);
      else params.set("sessionName", source.sessionName!);
      const targetRepo = readOpenRigEnv("OPENRIG_TARGET_REPO", "RIGGED_TARGET_REPO");
      if (targetRepo) params.set("targetRepo", targetRepo);
      // 默认紧凑（每次启动的恢复调用）；--full 退出，后台服务也会跳过
      // contextUsage/runtimeContext 计算。
      if (!full) params.set("compact", "1");

      const res = await client.get<Record<string, unknown>>(`/api/whoami?${params.toString()}`);

      if (opts.json) {
        if (full || res.status >= 400) {
          // --full：今日完整 payload（对等）。错误：原样透传。
          console.log(JSON.stringify(res.data, null, 2));
        } else {
          // 紧凑默认：身份恢复白名单投影。
          console.log(JSON.stringify(projectCompactWhoami(res.data)));
        }
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status === 404) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? "在任何受管工作组中都找不到该会话。检查：zrig ps --nodes");
        process.exitCode = 1;
        return;
      }

      if (res.status === 409) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? "会话有歧义。请改用 --node-id。");
        process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `whoami 失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      // 人类可读输出
      const data = res.data as unknown as WhoamiResult;
      const id = data.identity;
      // OPR.0.4.6.MH1 FR-4：自己主机名在被改名时在这里渲染；
      // 未命名（默认 "localhost"）保持今日输出逐字节一致。
      const ownHostName = readOwnHostName();
      if (ownHostName !== "localhost") {
        console.log(`主机：      ${ownHostName}`);
      }
      // Slice 14 §2c——本机自己的身份，以及它从哪来。上面的 host.name 是
      // 显示名；self-host id 才是后台服务盖到每个出站信封上、
      // 也是远程注册表必须能解析的东西。它们是两回事，混淆就是缺陷。
      // `generated` id 意味着没有远程能把回复提示路由回这里——
      // 现在就说，不要等跨机器消息失败时才说。
      const selfIdentity = await fetchSelfHostIdentity(deps.lifecycleDeps, getDaemonUrl(status));
      if (selfIdentity) {
        const src = selfIdentity.selfHostIdSource;
        console.log(`自身主机：  ${selfIdentity.selfHostId}${src ? `（${src}）` : ""}`);
      }
      console.log(`工作组：    ${id.rigName}`);
      console.log(`逻辑 ID：   ${id.logicalId}`);
      console.log(`Pod：       ${(id.podNamespace ?? id.podId) ?? "—"} / ${id.memberId}`);
      console.log(`会话：      ${id.sessionName ?? "—"}`);
      console.log(`运行时：    ${id.runtime}`);
      console.log(`传输：      ${id.attachmentType === "external_cli" ? "external_cli（仅出站）" : id.attachmentType}`);
      console.log(`解析方式：  via ${data.resolvedBy.replace(/_/g, " ")}`);

      if (data.peers.length > 0) {
        console.log("");
        // OPR.99.0.6.1：在表头写明契约，免得 peers 被误读成 edge 子集
        // 或主机清单。保留字面 `Peers:` 前缀（已有输出的 grep 依赖它）。
        console.log("Peers：（本工作组名册，不含自身——下方是有向边；`zrig ps --nodes` 看含自身 + 实时状态的清单）");
        for (const peer of data.peers) {
          console.log(`  ${peer.logicalId.padEnd(20)} ${(peer.sessionName ?? "—").padEnd(30)} ${peer.runtime}`);
        }
      }

      if (data.edges.outgoing.length > 0 || data.edges.incoming.length > 0) {
        console.log("");
        console.log("边：");
        for (const edge of data.edges.outgoing) {
          console.log(`  → ${edge.kind}  ${edge.to?.logicalId ?? "?"}`);
        }
        for (const edge of data.edges.incoming) {
          console.log(`  ← ${edge.kind}  ${edge.from?.logicalId ?? "?"}`);
        }
      }

      if (data.transcript.enabled && data.transcript.tailCommand) {
        console.log("");
        console.log(`Transcript：${data.transcript.path ?? "已启用"}`);
        console.log(`  ${data.transcript.tailCommand}`);
      }

      // 上下文用量——OPR.0.4.0.27：仅在 --full 下显示（紧凑完全省略
      // contextUsage payload；用 'rig context' 或 'rig whoami --full'）。
      if (full) {
        const ctx = data.contextUsage;
        if (ctx && ctx.availability === "known") {
          console.log(`上下文：    已用 ${ctx.usedPercentage}%（剩 ${ctx.remainingPercentage}%，窗口 ${ctx.contextWindowSize}）`);
        } else {
          console.log("上下文：    未知");
        }
      }
    });

  return cmd;
}

async function runCrossHostWhoami(
  hostId: string,
  opts: WhoamiCliOptions,
  deps: WhoamiDeps,
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
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  if (host.transport === "http") {
    await runHttpWhoami(host as import("../host-registry.js").HttpHostEntry, opts, deps);
    return;
  }

  // SSH 路径：重建 argv。
  const argv: string[] = ["rig", "whoami"];
  if (opts.nodeId !== undefined) argv.push("--node-id", opts.nodeId);
  if (opts.session !== undefined) argv.push("--session", opts.session);
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    if (result.ok) {
      // 原样透传远程 stdout——远程 `rig whoami --json` 已经产出正确的
      // JSON 信封；我们不双层包装。
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return;
    }
    emitCrossHostFailure(host.id, hostDisplayTarget(host), result, true);
    return;
  }

  console.log(`[经由主机 ${host.id}（${hostDisplayTarget(host)}）]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, false);
}

async function runHttpWhoami(
  host: HttpHostEntry,
  opts: WhoamiCliOptions,
  deps: WhoamiDeps,
): Promise<void> {
  const bearerResult = resolveRemoteBearer(host);
  if (!bearerResult.ok) {
    emitCrossHostError(host.id, bearerResult.failedStep, bearerResult.error, opts.json);
    process.exitCode = 1;
    return;
  }

  const { classifyHttpFailedStep: classifyStatus } = await import("../host-registry.js");
  // A4：在这次远程读上盖 origin 三元组（不可用时 fail-open 到 2 部分）。
  const originSelfHostId = await resolveOriginSelfHostId(deps.lifecycleDeps);
  const client = remoteDaemonClient(deps.clientFactory, host.url, originSelfHostId);
  const headers = bearerAuthHeaders(bearerResult.token);

  try {
    const infoRes = await client.get<{ installRoot?: string }>("/api/info", { headers });
    const infoStep = classifyStatus(infoRes.status);
    if (infoStep !== "none") {
      emitCrossHostError(host.id, infoStep, `远程 /api/info 返回 HTTP ${infoRes.status}`, opts.json);
      process.exitCode = 1;
      return;
    }

    const psRes = await client.get<Array<{ rigId: string; name: string }>>("/api/ps", { headers });
    const psStep = classifyStatus(psRes.status);
    if (psStep !== "none") {
      emitCrossHostError(host.id, psStep, `远程 /api/ps 返回 HTTP ${psRes.status}`, opts.json);
      process.exitCode = 1;
      return;
    }

    const identity = {
      host: host.id,
      url: host.url,
      installRoot: infoRes.data?.installRoot ?? "未知",
      rigs: Array.isArray(psRes.data) ? psRes.data.map((r) => ({ id: r.rigId, name: r.name })) : [],
    };

    if (opts.json) {
      console.log(JSON.stringify(identity));
    } else {
      console.log(`主机：    ${identity.host}（${identity.url}）`);
      console.log(`安装位置：${identity.installRoot}`);
      console.log(`工作组：  ${identity.rigs.length > 0 ? identity.rigs.map((r) => r.name).join(", ") : "（无）"}`);
    }
  } catch (err) {
    const failedStep = classifyHttpError(err);
    emitCrossHostError(host.id, failedStep, (err as Error).message, opts.json);
    process.exitCode = 1;
  }
}

async function runFanOutWhoami(opts: WhoamiCliOptions, deps: WhoamiDeps): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    console.error(`错误：${registry.error}`);
    process.exitCode = 1;
    return;
  }

  const allHosts = registry.registry.hosts;
  let targetIds: string[];
  if (opts.hosts) {
    targetIds = opts.hosts.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = targetIds.filter((id) => !allHosts.some((h) => h.id === id));
    if (unknown.length > 0) {
      console.error(`错误：未知主机 id：${unknown.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  } else {
    targetIds = allHosts.filter((h) => h.transport === "http").map((h) => h.id);
  }

  interface HostIdentityResult {
    host: string;
    ok: boolean;
    failedStep: string;
    identity?: { url: string; installRoot: string; rigs: Array<{ id: string; name: string }> };
    error?: string;
  }

  // A4：origin 三元组只解析一次（本机 id，每条扇出腿都一样），然后盖到每个
  // 远程 client 上——本地 selfHostId 不可用时 fail-open 到 2 部分。
  const originSelfHostId = await resolveOriginSelfHostId(deps.lifecycleDeps);
  const results: HostIdentityResult[] = await Promise.all(
    targetIds.map(async (id): Promise<HostIdentityResult> => {
      const host = allHosts.find((h) => h.id === id);
      if (!host) return { host: id, ok: false, failedStep: "remote-daemon-unreachable", error: `未知主机 ${id}` };
      if (host.transport !== "http") {
        return { host: id, ok: false, failedStep: "remote-command-failed", error: `主机 ${id} 使用传输 ${host.transport}；whoami 扇出要求 http` };
      }
      const httpHost = host as HttpHostEntry;
      const bearerResult = resolveRemoteBearer(httpHost);
      if (!bearerResult.ok) {
        return { host: id, ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
      }
      const client = remoteDaemonClient(deps.clientFactory, httpHost.url, originSelfHostId);
      const headers = bearerAuthHeaders(bearerResult.token);
      try {
        const { classifyHttpFailedStep: classifyStatus } = await import("../host-registry.js");
        const infoRes = await client.get<{ installRoot?: string }>("/api/info", { headers });
        if (classifyStatus(infoRes.status) !== "none") {
          return { host: id, ok: false, failedStep: classifyStatus(infoRes.status), error: `HTTP ${infoRes.status}` };
        }
        const psRes = await client.get<Array<{ rigId: string; name: string }>>("/api/ps", { headers });
        if (classifyStatus(psRes.status) !== "none") {
          return { host: id, ok: false, failedStep: classifyStatus(psRes.status), error: `HTTP ${psRes.status}` };
        }
        return {
          host: id,
          ok: true,
          failedStep: "none",
          identity: {
            url: httpHost.url,
            installRoot: infoRes.data?.installRoot ?? "未知",
            rigs: Array.isArray(psRes.data) ? psRes.data.map((r) => ({ id: r.rigId, name: r.name })) : [],
          },
        };
      } catch (err) {
        return { host: id, ok: false, failedStep: classifyHttpError(err), error: (err as Error).message };
      }
    }),
  );

  const hasFailure = results.some((r) => !r.ok);

  if (opts.json) {
    console.log(JSON.stringify({ hosts: results }));
  } else {
    for (const r of results) {
      if (r.ok && r.identity) {
        console.log(`\n[host=${r.host}] ${r.identity.url}`);
        console.log(`  安装位置：${r.identity.installRoot}`);
        console.log(`  工作组：  ${r.identity.rigs.length > 0 ? r.identity.rigs.map((g) => g.name).join(", ") : "（无）"}`);
      } else {
        console.log(`\n[host=${r.host}] 失败（${r.failedStep}）：${r.error}`);
      }
    }
  }

  if (hasFailure) process.exitCode = 3;
}
