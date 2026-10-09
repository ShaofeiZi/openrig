// OPR.0.4.4.13——主机注册表动词（add / list / doctor——架构
// R13-2a：无 edit/remove/tunnel/bootstrap 动词；对特殊情况仍手编 hosts.yaml；
// bootstrap 以脚本 + runbook 形式交付）。
// OPR.0.4.6.MH1 FR-1 用 `select` 扩展了这个动词族——持久化的
// 主机选择指针（kubectl current-context 形态）。指针存放在配置孪生中
// 的 `host.selected`；本动词是后台服务配置写入的薄客户端
// （CLI+UI 收敛到同一条写入路径，架构裁定）；读取从本地 ConfigStore
// 解析（env > file > default——读取路径上零新增后台服务查询）。
//
// 密钥卫生（FR-1）：每次渲染只携带 bearer 指针（环境变量名 / 文件名）——
// 本文件中没有任何代码路径为展示而解析 bearer 值。

import { Command } from "commander";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostname as osHostname, userInfo } from "node:os";
import { connect } from "node:net";
import { getOpenRigHome } from "../openrig-compat.js";
import { addHostEntry, defaultHostRegistryPath, loadHostRegistry, validateHostRegistry, hostDisplayTarget, resolveHost, resolveRemoteBearer, bearerAuthHeaders, type HostEntry, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type CrossHostResult } from "../cross-host-executor.js";
import { recordHostObservation, loadHostBindings, describeBindingConflict, defaultHostBindingsPath, type HostObservationOutcome } from "../host-bindings.js";
import { DaemonClient } from "../client.js";
import { readOwnHostName, readSelectedHost } from "../host-selection.js";

// ---------------------------------------------------------------------------
// rig host doctor——逐步、诚实、三值（FR-1 + FR-2）。
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "unknown";

export interface CheckRow {
  step: string;
  status: CheckStatus;
  detail: string;
  /** 可操作的下一步；fail 必填，unknown 建议填。 */
  fix?: string;
}

export interface DoctorDeps {
  run: (host: HostEntry, argv: readonly string[]) => Promise<CrossHostResult>;
  httpGet: (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string }>;
  /** OPR.0.4.6.MH1 FR-6：配对握手的有界 JSON POST。
   *  设为可选，使既有 DoctorDeps fixture 继续编译；pair 动词在缺省时
   *  回退到普通 fetch。 */
  httpPost?: (url: string, body: unknown) => Promise<{ status: number; body: string }>;
  /** TCP connect 探测："open"（已连接）| "closed"（被拒/被过滤/超时）| "unknown"（探测本身失败）。 */
  tcpProbe: (target: string, port: number, timeoutMs: number) => Promise<"open" | "closed" | "unknown">;
  /** Slice 14 Source-1：在 learned sidecar 中为一个注册表别名记录观察到的
   *  `/healthz` selfHostId（TOFU + 大声冲突）。设为可选，使既有 fixture 继续编译，
   *  且单元运行绝不写真实 sidecar——缺省表示跳过学习，即 fail-open 契约。 */
  learnHostBinding?: (alias: string, observedHostId: string) => HostObservationOutcome;
}

function nestedBoolean(obj: unknown, path: readonly string[]): boolean | undefined {
  let cur: unknown = obj;
  for (const part of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "boolean" ? cur : undefined;
}

function tailscaleRunSshFromPrefs(text: string): boolean | undefined {
  if (!text.trim().startsWith("{")) return undefined;
  const parsed = JSON.parse(text) as unknown;
  return nestedBoolean(parsed, ["RunSSH"])
    ?? nestedBoolean(parsed, ["Prefs", "RunSSH"])
    ?? nestedBoolean(parsed, ["CurrentProfile", "RunSSH"]);
}

function defaultDoctorDeps(): DoctorDeps {
  return {
    run: (host, argv) => runCrossHostCommand(host, argv),
    httpGet: async (url, headers) => {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      return { status: res.status, body: await res.text() };
    },
    httpPost: async (url, body) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, body: await res.text() };
    },
    tcpProbe: (target, port, timeoutMs) =>
      new Promise((resolve) => {
        const sock = connect({ host: target, port, timeout: timeoutMs });
        sock.on("connect", () => { sock.destroy(); resolve("open"); });
        sock.on("timeout", () => { sock.destroy(); resolve("closed"); });
        sock.on("error", () => { sock.destroy(); resolve("closed"); });
      }),
    learnHostBinding: (alias, observedHostId) => recordHostObservation({ alias, observedHostId }),
  };
}

/** FR-1 doctor 各段——每个失败步骤映射到一个不同的可操作错误：
 *  "SSH 通但后台服务宕" ≠ "后台服务通但注册表错" ≠ "远程 rig 二进制缺失/过旧"。 */
/** OPR.0.4.6.MH1 FR-3——粗粒度 ls 状态词：对主机传输端点做一次有界 TCP 拨号
 *  （ssh: target:22；http: URL 的 host:port）。刻意粗（参照 kubectl STATUS /
 *  docker context ls）：reachable | unreachable | unknown——绝不挂起
 *  （硬超时），绝不猜（拨号失败 = unreachable，探测错误/端点不可解析 = unknown）。 */
export async function probeHostStatus(
  host: HostEntry,
  tcpProbe: DoctorDeps["tcpProbe"],
  timeoutMs = 1500,
): Promise<"reachable" | "unreachable" | "unknown"> {
  try {
    let target: string;
    let port: number;
    if (host.transport === "ssh") {
      target = host.target;
      port = 22;
    } else {
      const u = new URL(host.url);
      target = u.hostname;
      port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    }
    const r = await tcpProbe(target, port, timeoutMs);
    return r === "open" ? "reachable" : r === "closed" ? "unreachable" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function doctorLegs(host: HostEntry, deps: DoctorDeps): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];

  if (host.transport === "ssh") {
    const reach = await deps.run(host, ["true"]);
    if (!reach.ok && (reach.failedStep === "ssh-unreachable" || reach.failedStep === "permission-gate")) {
      rows.push({
        step: "transport-reachability",
        status: "fail",
        detail: `ssh 到 ${host.target} 失败（${reach.failedStep}）：${reach.sshStderr.trim()}`,
        fix: reach.failedStep === "permission-gate"
          ? "SSH 认证/权限闸门——检查密钥、agent 与远程 authorized_keys"
          : "核对 ssh 目标/别名、tailnet 连通性，并确认 sshd 在运行",
      });
      return rows; // 没有 shell，后续各段无意义
    }
    rows.push({ step: "transport-reachability", status: "pass", detail: `ssh 到 ${host.target} 正常` });

    const version = await deps.run(host, ["rig", "--version"]);
    if (!version.ok) {
      rows.push({
        step: "remote-rig-binary",
        status: "fail",
        detail: "连到了远程 shell，但 `rig --version` 失败——远程 rig 二进制缺失或损坏",
        fix: "在主机上安装已发布产物：npm install -g @openrig/cli（见 product-factory runbook）",
      });
      return rows;
    }
    rows.push({ step: "remote-rig-binary", status: "pass", detail: `远程 rig ${version.stdout.trim() || "（版本号读不出）"}` });

    const daemon = await deps.run(host, ["rig", "daemon", "status"]);
    const daemonUp = daemon.ok && /running/i.test(daemon.stdout);
    if (daemonUp) {
      rows.push({ step: "remote-daemon-health", status: "pass", detail: "远程后台服务报告 running" });
    } else if (!daemon.ok) {
      rows.push({
        step: "remote-daemon-health",
        status: "unknown",
        detail: "远程后台服务状态无法确认健康；仅凭 SSH 可达无法判定后台服务健康",
        fix: "在主机上：用 `zrig daemon status` 以及一个真实依赖后台服务的操作（如 `zrig ps --json`）核对",
      });
      return rows;
    } else {
      rows.push({
          step: "remote-daemon-health",
          status: "fail",
          detail: "SSH 通、rig 已装，但远程后台服务未运行",
          fix: "在主机上：zrig daemon start（然后重跑 doctor）",
      });
    }
    if (!daemonUp) return rows;

    const whoami = await deps.run(host, ["rig", "ps", "--json", "--limit", "5"]);
    let identityOk = false;
    if (whoami.ok) {
      try { identityOk = typeof JSON.parse(whoami.stdout) === "object"; } catch { identityOk = false; }
    }
    rows.push(identityOk
      ? { step: "remote-identity", status: "pass", detail: "远程后台服务身份/列表可解析（zrig ps --json 可解析）" }
      : {
          step: "remote-identity",
          status: "fail",
          detail: "后台服务已起，但远程身份/列表未能解析",
          fix: "在主机上：直接看 `zrig ps --json`；即使 status 说 running，后台服务 API 也可能不健康",
        });
    return rows;
  }

  // http 传输
  const bearer = resolveRemoteBearer(host as HttpHostEntry);
  if (!bearer.ok) {
    rows.push({ step: "transport-reachability", status: "fail", detail: bearer.error, fix: "设置注册表项所指向的 bearer 环境变量 / 文件（指针名见 zrig host list）" });
    return rows;
  }
  try {
    const health = await deps.httpGet(`${(host as HttpHostEntry).url}/healthz`, bearerAuthHeaders(bearer.token));
    if (health.status === 401 || health.status === 403) {
      rows.push(bearer.token
        ? { step: "transport-reachability", status: "fail", detail: `后台服务可达但拒绝了 bearer（HTTP ${health.status}）`, fix: "注册表可达但 token 不对——轮换/设置该注册表项指向的 bearer" }
        : { step: "transport-reachability", status: "fail", detail: `后台服务可达但要求 Authorization（HTTP ${health.status}）；本主机项是匿名的（未配置 bearer）`, fix: "远程后台服务强制 bearer——在 ~/.openrig/hosts.yaml 中为本主机项加一个 bearer_env 或 bearer_file 指针，再设置该环境变量 / 文件" });
      return rows;
    }
    if (health.status < 200 || health.status >= 300) {
      rows.push({ step: "transport-reachability", status: "fail", detail: `healthz 返回 HTTP ${health.status}`, fix: "后台服务应答异常——查看远程后台服务日志" });
      return rows;
    }
    rows.push({ step: "transport-reachability", status: "pass", detail: `healthz 正常，位于 ${(host as HttpHostEntry).url}` });
    rows.push({ step: "remote-daemon-health", status: "pass", detail: "在 http 传输上，healthz 本身就是后台服务健康检查" });
    // Slice 14 Source-1：我们已握有的 healthz 负载就带了对端的 selfHostId——
    // 把它记到 learned sidecar（TOFU 首次接触；冲突会大声暴露、绝不覆盖）。
    // 精确关联：我们问的是本项的 URL，所以这个 id 就是本项的。
    // 缺省（未接 learner、负载不可解析、老后台服务无 selfHostId）为 fail-open：不产出行。
    if (deps.learnHostBinding) {
      try {
        const parsed = JSON.parse(health.body) as { selfHostId?: unknown };
        if (typeof parsed.selfHostId === "string" && parsed.selfHostId.length > 0) {
          const obs = deps.learnHostBinding(host.id, parsed.selfHostId);
          rows.push(obs.outcome === "conflict"
            ? {
                step: "host-identity-binding",
                status: "fail",
                detail: describeBindingConflict(host.id, obs.binding),
                fix: `若重新换密钥是合法的，删除 ${defaultHostBindingsPath()} 中的 '${host.id}' 项并重跑 doctor 重新学习`,
              }
            : {
                step: "host-identity-binding",
                status: "pass",
                detail: obs.outcome === "bound"
                  ? `已学习主机身份 '${obs.binding.hostId}'（首次接触）——以 @${obs.binding.hostId} 结尾的回复提示现在解析到 '${host.id}'`
                  : `主机身份 '${obs.binding.hostId}' 已确认`,
              });
        }
      } catch {
        // 负载不是 JSON——老的或非后台服务端点；跳过学习，不会坏任何东西。
      }
    }
  } catch (err) {
    rows.push({ step: "transport-reachability", status: "fail", detail: `后台服务在 ${(host as HttpHostEntry).url} 不可达：${(err as Error).message}`, fix: "检查 tailnet 连通性并确认远程后台服务在运行（主机上 zrig daemon start）" });
    return rows;
  }
  rows.push({
    step: "remote-rig-binary",
    status: "unknown",
    detail: "http 传输上无法判定（无 shell）",
    fix: "为本主机登记一个 ssh 传输项来核对，或在主机上直接：rig --version",
  });
  try {
    const ps = await deps.httpGet(`${(host as HttpHostEntry).url}/api/ps`, bearerAuthHeaders(bearer.token));
    rows.push(ps.status >= 200 && ps.status < 300
      ? { step: "remote-identity", status: "pass", detail: bearer.token ? "已认证的后台服务 API 应答（/api/ps）" : "后台服务 API 应答（/api/ps；匿名——未配置 bearer）" }
      : { step: "remote-identity", status: "fail", detail: `/api/ps 返回 HTTP ${ps.status}`, fix: "后台服务 healthz 正常但 API 不健康——查看远程后台服务日志" });
  } catch (err) {
    rows.push({ step: "remote-identity", status: "fail", detail: `/api/ps 不可达：${(err as Error).message}`, fix: "查看远程后台服务日志" });
  }
  return rows;
}

/** FR-2——唯一内置的 posture 档案（架构 R13-2b：一张命名常量表，无框架）。
 *  每一项都是三值；UNKNOWN 绝不被抹平成 pass，每个非 pass 都带它的 fix。 */
export const POSTURE_PROFILE_ID = "product-factory-vps";

export async function postureCheck(
  host: HostEntry,
  deps: DoctorDeps,
  opts: { publicAddr?: string } = {},
): Promise<CheckRow[]> {
  if (host.transport !== "ssh") {
    // Posture 需要 shell。把每一项都报为 unknown——诚实地。
    return POSTURE_ITEM_IDS.map((id) => ({
      step: id,
      status: "unknown" as const,
      detail: "posture 检查需要 shell 访问；本主机以 http 传输登记",
      fix: "为本主机登记一个 ssh 传输项（或按 runbook 在主机上自行运行这些检查）",
    }));
  }

  const rows: CheckRow[] = [];
  const sh = async (cmd: string) => deps.run(host, ["sh", "-c", cmd]);

  // 1. 非 root 的 openrig 用户
  const idOut = await sh("id -u openrig 2>/dev/null");
  if (idOut.ok && idOut.stdout.trim() !== "") {
    rows.push(idOut.stdout.trim() === "0"
      ? { step: "nonroot-openrig-user", status: "fail", detail: "用户 'openrig' 解析到 uid 0", fix: "按 runbook 创建一个非 root 的 openrig 用户" }
      : { step: "nonroot-openrig-user", status: "pass", detail: `用户 'openrig' uid ${idOut.stdout.trim()}` });
  } else {
    rows.push({ step: "nonroot-openrig-user", status: "fail", detail: "用户 'openrig' 不存在", fix: "按 runbook 执行 adduser openrig + 仅密钥 SSH" });
  }

  // 2+3. sshd 生效配置（禁止 root SSH、禁止密码认证）
  const sshd = await sh("sudo -n sshd -T 2>/dev/null || sshd -T 2>/dev/null || true");
  const sshdOut = sshd.ok ? sshd.stdout.toLowerCase() : "";
  const sshdItem = (step: string, key: string, want: string): CheckRow => {
    if (!sshdOut.includes(key)) {
      return { step, status: "unknown", detail: "从这里读不到 sshd 生效配置（sshd -T 需要 root）", fix: "在主机上：sudo sshd -T | grep " + key };
    }
    return sshdOut.includes(`${key} ${want}`)
      ? { step, status: "pass", detail: `${key} ${want}` }
      : { step, status: "fail", detail: `sshd -T 报告 ${key} != ${want}`, fix: `在 /etc/ssh/sshd_config.d/99-openrig-hardening.conf 中设置 ${key} ${want} 并重载 sshd` };
  };
  rows.push(sshdItem("root-ssh-disabled", "permitrootlogin", "no"));
  rows.push(sshdItem("key-only-ssh", "passwordauthentication", "no"));

  // 4+5. UFW 默认拒绝 + tailnet 准入
  const ufw = await sh("sudo -n ufw status verbose 2>/dev/null || true");
  const ufwOut = ufw.ok ? ufw.stdout.toLowerCase() : "";
  if (ufwOut.trim() === "") {
    const unknownUfw = (step: string): CheckRow => ({ step, status: "unknown", detail: "从这里读不到 ufw status（需要 sudo）", fix: "在主机上：sudo ufw status verbose" });
    rows.push(unknownUfw("ufw-default-deny-incoming"));
    rows.push(unknownUfw("tailnet-ingress-allowed"));
  } else {
    rows.push(/default:\s*deny\s*\(incoming/.test(ufwOut)
      ? { step: "ufw-default-deny-incoming", status: "pass", detail: "ufw 默认拒绝（incoming）" }
      : { step: "ufw-default-deny-incoming", status: "fail", detail: "ufw 入站默认不是 deny", fix: "sudo ufw default deny incoming" });
    // R2-B1：只提到 tailscale0 不够——tailscale0 上的 DENY 绝不能算 pass。
    // pass 要求接口上有一条 ALLOW IN 规则。
    const tailnetAllowIn = ufwOut.split("\n").some((line) => line.includes("tailscale0") && /allow\s+in/.test(line));
    if (tailnetAllowIn) {
      rows.push({ step: "tailnet-ingress-allowed", status: "pass", detail: "ufw 在 tailscale0 上有一条 ALLOW IN 规则" });
    } else if (ufwOut.includes("tailscale0")) {
      rows.push({ step: "tailnet-ingress-allowed", status: "fail", detail: "tailscale0 出现在 ufw 规则中，但没有 ALLOW IN 规则（仅 deny/其他）", fix: "sudo ufw allow in on tailscale0" });
    } else {
      rows.push({ step: "tailnet-ingress-allowed", status: "fail", detail: "未找到 tailscale0 allow 规则", fix: "sudo ufw allow in on tailscale0" });
    }
  }

  // 6. tailscale 标志（无子网路由 / 无 exit node / 无 ts-SSH）
  const ts = await sh("tailscale status --json 2>/dev/null || true");
  const prefs = await sh("tailscale debug prefs --json 2>/dev/null || true");
  let routes: number | undefined;
  let exitNode: boolean | undefined;
  let runSsh: boolean | undefined;
  const unknownReasons: string[] = [];
  try {
    if (ts.ok && ts.stdout.trim().startsWith("{")) {
      const parsed = JSON.parse(ts.stdout) as { Self?: { PrimaryRoutes?: unknown[]; ExitNodeOption?: boolean }; ExitNodeStatus?: unknown };
      routes = parsed.Self?.PrimaryRoutes?.length ?? 0;
      exitNode = (parsed.ExitNodeStatus !== undefined && parsed.ExitNodeStatus !== null) || parsed.Self?.ExitNodeOption === true;
    } else {
      unknownReasons.push("tailscale status 读不出");
    }
  } catch {
    unknownReasons.push("tailscale status 解析失败");
  }
  try {
    runSsh = prefs.ok ? tailscaleRunSshFromPrefs(prefs.stdout) : undefined;
    if (runSsh === undefined) unknownReasons.push("tailscale debug prefs 读不出");
  } catch {
    unknownReasons.push("tailscale debug prefs 解析失败");
  }
  if ((routes ?? 0) > 0 || exitNode === true || runSsh === true) {
    rows.push({
      step: "tailscale-minimal-trust",
      status: "fail",
      detail: `子网路由：${routes ?? "未知"}；正在使用 exit node：${exitNode ?? "未知"}；Tailscale SSH 已启用：${runSsh ?? "未知"}`,
      fix: "移除已宣告的路由 / exit-node 使用（tailscale set）并关闭 Tailscale SSH：tailscale set --ssh=false",
    });
  } else if (routes === 0 && exitNode === false && runSsh === false) {
    rows.push({ step: "tailscale-minimal-trust", status: "pass", detail: "无已宣告子网路由；无 exit-node 使用；Tailscale SSH 已关闭" });
  } else {
    rows.push({
      step: "tailscale-minimal-trust",
      status: "unknown",
      detail: `tailscale posture 未能完全确定（${unknownReasons.join("；")}）`,
      fix: "在主机上：tailscale status --json && tailscale debug prefs --json；用 tailscale set --ssh=false 关闭 Tailscale SSH",
    });
  }

  // 7. 后台服务绑定 loopback/tailnet——绝不暴露公网。R2-B1：一个具体的
  // 公网 IP 绑定必须和 wildcard 一样 fail——pass 是一个白名单
  // （loopback 或 tailnet CGNAT 段 100.64.0.0/10），绝不是"不是 wildcard"。
  const ss = await sh("ss -tln 2>/dev/null | grep ':7433' || true");
  const ssOut = ss.ok ? ss.stdout : "";
  const listenAddrs = ssOut
    .split("\n")
    .map((line) => line.match(/(\S+):7433\b/)?.[1])
    .filter((a): a is string => a !== undefined);
  if (listenAddrs.length === 0) {
    rows.push({ step: "daemon-bind-not-public", status: "unknown", detail: "未观察到 :7433 监听（后台服务可能未起）", fix: "启动后台服务后复查：ss -tln | grep 7433" });
  } else {
    const isLoopbackOrTailnet = (addr: string): boolean => {
      const a = addr.replace(/^\[|\]$/g, "");
      if (a.startsWith("127.") || a === "::1") return true;
      const m = a.match(/^100\.(\d+)\./);
      return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
    };
    const offending = listenAddrs.filter((a) => !isLoopbackOrTailnet(a));
    rows.push(offending.length === 0
      ? { step: "daemon-bind-not-public", status: "pass", detail: `监听仅绑定 loopback/tailnet：${listenAddrs.join(", ")}` }
      : { step: "daemon-bind-not-public", status: "fail", detail: `后台服务监听在一个非 loopback/非 tailnet 地址上：${offending.join(", ")}`, fix: "把后台服务仅绑定 loopback/tailnet（OPENRIG 后台服务 host 配置）；绝不把 :7433 暴露到公网" });
  }

  // 8+9. 公网可达性探测——只有在已知公网地址时才有意义。
  if (opts.publicAddr) {
    for (const [step, port] of [["public-daemon-port-unreachable", 7433], ["public-ssh-unreachable-or-accepted", 22]] as const) {
      const probe = await deps.tcpProbe(opts.publicAddr, port, 5000);
      rows.push(probe === "open"
        ? { step, status: "fail", detail: `${opts.publicAddr}:${port} 公网可达`, fix: "移除公网放行规则 / 防火墙封掉该端口（冒烟测试加固门槛：公网 :22/:7433 应超时）" }
        : { step, status: "pass", detail: `${opts.publicAddr}:${port} 不可达（${probe}）` });
    }
  } else {
    const unknownProbe = (step: string, port: number): CheckRow => ({
      step, status: "unknown",
      detail: `未探测 :${port} 的公网可达性（未知公网地址——注册表 target 可能是 tailnet 别名）`,
      fix: `加 --public-addr <ip> 重跑，从本观测点探测`,
    });
    rows.push(unknownProbe("public-daemon-port-unreachable", 7433));
    rows.push(unknownProbe("public-ssh-unreachable-or-accepted", 22));
  }

  return rows;
}

export const POSTURE_ITEM_IDS = [
  "nonroot-openrig-user",
  "root-ssh-disabled",
  "key-only-ssh",
  "ufw-default-deny-incoming",
  "tailnet-ingress-allowed",
  "tailscale-minimal-trust",
  "daemon-bind-not-public",
  "public-daemon-port-unreachable",
  "public-ssh-unreachable-or-accepted",
] as const;

function renderRows(rows: CheckRow[], json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(rows));
    return;
  }
  const glyph = { pass: "✓", fail: "✗", unknown: "?" } as const;
  for (const r of rows) {
    console.log(`${glyph[r.status]} ${r.step}: ${r.detail}${r.fix ? `\n    修复：${r.fix}` : ""}`);
  }
}

function authPointer(h: HostEntry): string {
  if (h.transport === "ssh") return "ssh-key";
  return h.bearer_env ? `env:${h.bearer_env}` : h.bearer_file ? `file:${h.bearer_file}` : "—";
}

export function hostCommand(doctorDepsOverride?: DoctorDeps): Command {
  const cmd = new Command("host").description("管理多主机注册表（~/.openrig/hosts.yaml）");

  cmd
    .command("add")
    .description("新增一个主机项（用注册表加载器自身的规则校验）")
    .requiredOption("--id <id>", "唯一主机 id")
    .requiredOption("--transport <transport>", "ssh 或 http")
    .option("--target <target>", "SSH 目标（DNS 名、ssh-config 别名或 IP）——ssh 传输")
    .option("--user <user>", "SSH 用户——ssh 传输")
    .option("--url <url>", "远程后台服务 base URL——http 传输")
    .option("--bearer-env <name>", "持有 bearer token 的环境变量名——http 传输（可选指针，绝不是值；两个 bearer 标志都省略即表示无 token 后台服务）")
    .option("--bearer-file <path>", "持有 bearer token 的文件路径——http 传输（可选指针，绝不是值；bearer 标志至多一个）")
    .option("--notes <text>", "自由格式的操作者备注")
    .option("--json", "JSON 输出")
    .action((opts: { id: string; transport: string; target?: string; user?: string; url?: string; bearerEnv?: string; bearerFile?: string; notes?: string; json?: boolean }) => {
      const rawEntry: Record<string, unknown> = { id: opts.id, transport: opts.transport };
      if (opts.target !== undefined) rawEntry["target"] = opts.target;
      if (opts.user !== undefined) rawEntry["user"] = opts.user;
      if (opts.url !== undefined) rawEntry["url"] = opts.url;
      if (opts.bearerEnv !== undefined) rawEntry["bearer_env"] = opts.bearerEnv;
      if (opts.bearerFile !== undefined) rawEntry["bearer_file"] = opts.bearerFile;
      if (opts.notes !== undefined) rawEntry["notes"] = opts.notes;

      const res = addHostEntry(rawEntry);
      if (!res.ok) {
        console.error(res.error);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, path: res.path, entry: res.entry }));
        return;
      }
      console.log(`已添加主机 '${res.entry.id}'（${res.entry.transport}）到 ${res.path}`);
      console.log(`验证它：zrig host doctor ${res.entry.id}`);
    });

  cmd
    .command("select")
    .description("选择你正在查看/操作的主机（持久化；'local' 回到本机）")
    .argument("<id>", "已登记的主机 id，或 'local'")
    .option("--json", "JSON 输出")
    .action(async (id: string, opts: { json?: boolean }) => {
      // 持久化前先校验：'local' 永远合法；其余必须是已登记的主机 id。
      if (id !== "local") {
        const registryPath = defaultHostRegistryPath();
        const loaded = existsSync(registryPath) ? loadHostRegistry(registryPath) : null;
        if (!loaded || !loaded.ok) {
          console.error(
            loaded && !loaded.ok
              ? loaded.error
              : `无法选择 '${id}'：没有已登记主机（${registryPath} 处无注册表）。先添加一个：zrig host add --id <id> --transport <ssh|http> ...`,
          );
          process.exitCode = 1;
          return;
        }
        const ids = loaded.registry.hosts.map((h) => h.id);
        if (!ids.includes(id)) {
          console.error(
            `无法选择 '${id}'：不是已登记的主机 id。已登记：${ids.length > 0 ? ids.join(", ") : "（无）"}。先添加它：zrig host add --id ${id} --transport <ssh|http> ...（或选 'local'）。`,
          );
          process.exitCode = 1;
          return;
        }
      }
      // 唯一写入路径：后台服务配置写入（CLI 是薄客户端——架构 FR-1 裁定）。
      // 后台服务宕机时暴露既有的结构化连接错误（PRD 中已命名的取舍）。
      const client = new DaemonClient();
      let res: { status: number; data: { ok?: boolean; error?: string } };
      try {
        res = await client.post<{ ok?: boolean; error?: string }>(
          `/api/config/${encodeURIComponent("host.selected")}`,
          { value: id },
        );
      } catch (err) {
        // 后台服务宕机：既有结构化连接错误，PRD 中命名的取舍
        // （选择写入需要本地后台服务在线）。
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
      if (res.status !== 200 || res.data?.error) {
        console.error(res.data?.error ?? `后台服务配置写入失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, selected: id }));
        return;
      }
      console.log(id === "local" ? "已选主机：local（本机）" : `已选主机：${id}`);
      console.log(id === "local" ? "命令将作用于本机。" : `支持 --host 的无标志命令现在作用于 '${id}'。返回：zrig host select local`);
    });

  cmd
    .command("rename")
    .description("重命名本机显示名（呈现在 dashboard、explorer、ls、whoami 中）")
    .argument("<name>", '新的显示名，例如 "Mac mini 2"')
    .option("--json", "JSON 输出")
    .action(async (name: string, opts: { json?: boolean }) => {
      // OPR.0.4.6.MH1 FR-4——一个存储名（settings 孪生，架构裁定 1），
      // 一条写入路径（后台服务配置写入，与 select 相同）。名称是自由文本；
      // 只拒绝空。
      const trimmed = name.trim();
      if (!trimmed) {
        console.error("主机名不能为空");
        process.exitCode = 1;
        return;
      }
      const client = new DaemonClient();
      let res: { status: number; data: { ok?: boolean; error?: string } };
      try {
        res = await client.post<{ ok?: boolean; error?: string }>(
          `/api/config/${encodeURIComponent("host.name")}`,
          { value: trimmed },
        );
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
      if (res.status !== 200 || res.data?.error) {
        console.error(res.data?.error ?? `后台服务配置写入失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, name: trimmed }));
        return;
      }
      console.log(`本机现在命名为：${trimmed}`);
    });

  cmd
    .command("pair")
    .description("从一个粘贴的地址与远程主机配对——在目标上批准一次即可完成（FR-6）")
    .argument("<url>", "目标后台服务的地址（http[s]://host:port，或 host:port）")
    .option("--id <id>", "新主机的注册表 id（默认：从主机名推导）")
    .option("--timeout <seconds>", "等待目标侧批准的时长", "600")
    .option("--human <address>", "目标上已登记的 @external 批准接收人（存在多个时必填）")
    .option("--json", "JSON 输出")
    .action(async (rawUrl: string, opts: { id?: string; timeout?: string; json?: boolean; human?: string }) => {
      // OPR.0.4.6.MH1 FR-6——创始人最简添加路径：粘贴一个地址，在目标上
      // 批准一次，完成。带一堆标志的 `rig host add` 保持为不变的高级路径。
      // B1：CLI 保留它的直连 fs 写入（addHostEntry）；浏览器界面经其本地后台服务
      // 配对——二者收敛到同一条写入契约。
      let target: URL;
      try {
        target = new URL(/^https?:\/\//.test(rawUrl.trim()) ? rawUrl.trim() : `http://${rawUrl.trim()}`);
      } catch {
        console.error(`'${rawUrl}' 不是可用地址。粘贴目标后台服务的 URL，例如 http://vps-a:7433`);
        process.exitCode = 1;
        return;
      }
      const targetBase = target.origin;
      const deps = doctorDepsOverride ?? defaultDoctorDeps();

      // B1 回补（护栏 code-review 2026-07-07）：在任何网络调用或凭证变更
      // 之前先 PREFLIGHT。候选项跑与 add 将用的同一套校验契约
      // （重复 id、保留 id、既有注册表非法都在这里失败——在请求目标批准之前），
      // 而已存在的 token 文件是已存在的凭证状态：拒绝，绝不覆盖，
      // 也绝不被本次请求的清理删除。
      const id = (opts.id ?? "").trim() || target.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/\./g, "-").replace(/^-+|-+$/g, "") || "paired-host";
      const secretsDir = join(getOpenRigHome(), "secrets");
      const tokenPath = join(secretsDir, `host-${id}.token`);
      {
        const registryPath = defaultHostRegistryPath();
        let existing: HostEntry[] = [];
        if (existsSync(registryPath)) {
          const loaded = loadHostRegistry(registryPath);
          if (!loaded.ok) {
            console.error(`无法配对：${loaded.error}`);
            process.exitCode = 1;
            return;
          }
          existing = loaded.registry.hosts;
        }
        const preflight = validateHostRegistry(
          { hosts: [...existing, { id, transport: "http", url: targetBase, bearer_file: tokenPath }] },
          registryPath,
        );
        if (!preflight.ok) {
          console.error(`无法以 '${id}' 配对：${preflight.error}`);
          process.exitCode = 1;
          return;
        }
        if (existsSync(tokenPath)) {
          console.error(`凭证文件已存在于 ${tokenPath}——已存在的凭证状态绝不覆盖。请传 --id <不同的 id>，或在确认它已过期后自行删除该文件。`);
          process.exitCode = 1;
          return;
        }
      }

      const httpPost = deps.httpPost ?? (async (url: string, payload: unknown) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        return { status: res.status, body: await res.text() };
      });
      const parseJson = (s: string): Record<string, unknown> => {
        try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
      };

      let issued: { pairId?: string; code?: string; approvalQitemId?: string; error?: string; message?: string };
      try {
        const res = await httpPost(`${targetBase}/api/hosts/pair-request`, {
          requester: `${userInfo().username}@${osHostname()}`,
          ...(opts.human ? { human: opts.human } : {}),
        });
        issued = parseJson(res.body) as typeof issued;
        if (res.status !== 200 || !issued.pairId || !issued.code) {
          console.error(issued.message ?? `配对被拒绝：目标返回 HTTP ${res.status}${issued.error ? `（${issued.error}）` : ""}`);
          process.exitCode = 1;
          return;
        }
      } catch (err) {
        console.error(`无法连到 ${targetBase}：${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      if (!opts.json) {
        console.log(`配对码：${issued.code}`);
        console.log(`等待目标上的批准（它的注意力队列里有项 ${issued.approvalQitemId ?? "?"}）。`);
        console.log(`在目标上：zrig queue update ${issued.approvalQitemId ?? "<qitem-id>"} --state done --closure-reason no-follow-on`);
      }

      const timeoutMs = Math.max(1, Number(opts.timeout ?? "600") || 600) * 1000;
      const deadline = Date.now() + timeoutMs;
      let outcome: { status?: string; token?: string } = {};
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await deps.httpGet(`${targetBase}/api/hosts/pair-request/${issued.pairId}`);
          outcome = parseJson(res.body) as typeof outcome;
        } catch {
          continue; // 临时轮询失败：继续等到 deadline
        }
        if (outcome.status && outcome.status !== "pending") break;
      }

      if (outcome.status !== "approved" || !outcome.token) {
        const why = outcome.status === "denied" ? "目标拒绝了配对"
          : outcome.status === "expired" ? "配对在目标上已过期"
          : "超时前未等到批准";
        console.error(`配对失败：${why}。未持久化任何东西（无注册表项、无 token 文件）。`);
        process.exitCode = 1;
        return;
      }

      // 已批准：token → 独占创建 0600 文件（open 标志 "wx"——
      // rev1-r2 B3：先检查再改名曾有一个窗口，并发的同 id 配对可能覆盖赢家的文件、
      // 再在自己 add 失败时把它删掉；"wx" 在文件系统层是原子的，
      // 所以创建成功就是清理所依赖的所有权证明），然后经唯一交付写入路径
      // 写注册表项。addHostEntry 会权威地重新校验
      // （注册表可能自 preflight 后已变化）。
      try {
        mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
        writeFileSync(tokenPath, `${outcome.token}\n`, { mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          console.error(`配对期间在 ${tokenPath} 出现了一个凭证文件——拒绝覆盖它。本次请求未持久化任何东西。`);
        } else {
          console.error(`保存配对 token 失败：${(err as Error).message}`);
        }
        process.exitCode = 1;
        return;
      }
      const added = addHostEntry({
        id,
        transport: "http",
        url: targetBase,
        bearer_file: tokenPath,
        notes: `paired ${new Date().toISOString().slice(0, 10)}`,
      });
      if (!added.ok) {
        rmSync(tokenPath, { force: true });
        console.error(`配对已批准，但注册表写入失败：${added.error}。（本次请求创建的）token 文件已移除——未持久化任何东西。`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, entry: added.entry }));
        return;
      }
      console.log(`已配对。主机 '${id}' 已登记（${targetBase}，bearer_file ${tokenPath}）。`);
      console.log(`验证它：zrig host doctor ${id}`);
    });

  cmd
    .command("list")
    // OPR.0.4.6.MH1 QA 回补：PRD/证明契约写的是动词 `rig host ls`（FR-3）；
    // `list` 仍是规范名，`ls` 是契约要求的别名（同动作、同 --json）。
    .alias("ls")
    .description("列出已登记主机，含状态 + 选中标记（仅配置指针——绝不含密钥值）")
    .option("--json", "JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const registryPath = defaultHostRegistryPath();
      if (!existsSync(registryPath)) {
        if (opts.json) {
          console.log(JSON.stringify([]));
          return;
        }
        console.log(`在 ${registryPath} 中没有已登记主机。用单个地址配对：zrig host pair <url>（高级/手动路径：zrig host add --id <id> --transport <ssh|http> ...）`);
        return;
      }
      const loaded = loadHostRegistry(registryPath);
      if (!loaded.ok) {
        console.error(loaded.error);
        process.exitCode = 1;
        return;
      }
      // OPR.0.4.6.MH1 FR-1/FR-3：选中标记（本地 ConfigStore 读——
      // env > file > default；零后台服务依赖）+ 每台主机一次有界状态探测
      // （并行；每台硬超时——绝不挂起）。
      const selected = readSelectedHost();
      const probeDeps: DoctorDeps = doctorDepsOverride ?? defaultDoctorDeps();
      const statuses = await Promise.all(
        loaded.registry.hosts.map((h) => probeHostStatus(h, probeDeps.tcpProbe)),
      );
      if (opts.json) {
        // 条目按校验结果携带：bearer 字段按构造是名字。
        // 仅追加（交付的裸数组形状是契约——MH1 之前的消费者继续工作）：
        // 每行新增 `selected` + `status`；可脚本化的选择指针才是真正的行
        // （或 `rig config get host.selected`）。
        // Slice 14：`hostId` 有值时随展开带过来，但"缺键即缺失"会让
        // "从未学过这个对端身份"和"消费者忘了看"无法区分。显式输出为 null，
        // 让 unbound 成为一个值而非缺失。`learnedHostId`（Source-1 sidecar 绑定）
        // 与 `idChanged`（记录到的冲突）是追加键。
        const jsonBindings = loadHostBindings().bindings;
        console.log(JSON.stringify(loaded.registry.hosts.map((h, i) => ({
          ...h,
          hostId: h.hostId ?? null,
          learnedHostId: jsonBindings[h.id]?.hostId ?? null,
          idChanged: Boolean(jsonBindings[h.id]?.conflict),
          selected: h.id === selected,
          status: statuses[i],
        }))));
        return;
      }
      if (loaded.registry.hosts.length === 0) {
        console.log(`在 ${registryPath} 中没有已登记主机。用单个地址配对：zrig host pair <url>（高级/手动路径：zrig host add --id <id> --transport <ssh|http> ...）`);
        return;
      }
      // OPR.0.4.6.MH1 FR-4：本机名被重命名后在这里渲染；
      // 未命名（默认 "localhost"）保持今天的输出逐字节不变
      // （FR-4 零回归 AC）。可脚本化读取：rig config get host.name——
      // --json 数组只含注册表行（交付的裸数组契约）。
      const ownName = readOwnHostName();
      if (ownName !== "localhost") {
        console.log(`本机：${ownName}\n`);
      }
      const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
      const bindings = loadHostBindings().bindings;
      console.log(`${pad("", 2)}${pad("ID", 20)} ${pad("HOST-ID", 18)} ${pad("TRANSPORT", 10)} ${pad("TARGET", 30)} ${pad("STATUS", 12)} ${pad("AUTH", 24)} NOTES`);
      for (let i = 0; i < loaded.registry.hosts.length; i++) {
        const h = loaded.registry.hosts[i]!;
        const marker = h.id === selected ? "* " : "  ";
        // "unbound" 正是这一列的意义：操作者能看出哪些条目从未学到对端自 id，
        // 而不是等到跨机消息失败才发现。注册表声明的 hostId 优先于 sidecar 学到的绑定；
        // 记录到的冲突会标记该单元格并在表下打印完整故事（大声，绝不静默）。
        const binding = bindings[h.id];
        const effectiveId = h.hostId ?? binding?.hostId ?? "unbound";
        const cell = binding?.conflict ? `${effectiveId} id-changed!` : effectiveId;
        console.log(`${marker}${pad(h.id, 20)} ${pad(cell, 18)} ${pad(h.transport, 10)} ${pad(hostDisplayTarget(h), 30)} ${pad(statuses[i]!, 12)} ${pad(authPointer(h), 24)} ${h.notes ?? "—"}`);
      }
      for (const h of loaded.registry.hosts) {
        const binding = bindings[h.id];
        if (binding?.conflict) console.log(`\n! ${describeBindingConflict(h.id, binding)}`);
      }
      if (selected !== "local") {
        console.log(`\n已选主机：${selected}（返回：zrig host select local）`);
      }
    });

  cmd
    .command("doctor")
    .description("逐步主机核验（加 --posture 跑 product-factory-vps 基线）")
    .argument("<id>", "已登记主机 id")
    .option("--posture <profile>", `运行 posture 基线（唯一内置档案：${POSTURE_PROFILE_ID}）`)
    .option("--public-addr <ip>", "外部观测点可达性探测用的公网地址（posture 第 8-9 项）")
    .option("--json", "JSON 输出")
    .action(async (id: string, opts: { posture?: string; publicAddr?: string; json?: boolean }) => {
      const deps: DoctorDeps = doctorDepsOverride ?? defaultDoctorDeps();
      const loaded = loadHostRegistry();
      if (!loaded.ok) {
        console.error(loaded.error);
        process.exitCode = 1;
        return;
      }
      const resolved = resolveHost(loaded.registry, id);
      if (!resolved.ok) {
        // 那一类不同的"注册表错"错误。
        console.error(`注册表：${resolved.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.posture !== undefined && opts.posture !== POSTURE_PROFILE_ID) {
        console.error(`未知 posture 档案 '${opts.posture}'。唯一内置档案是：${POSTURE_PROFILE_ID}`);
        process.exitCode = 1;
        return;
      }

      const rows = await doctorLegs(resolved.host, deps);
      if (opts.posture) {
        rows.push(...await postureCheck(resolved.host, deps, { publicAddr: opts.publicAddr }));
      }
      renderRows(rows, opts.json);
      if (rows.some((r) => r.status === "fail")) process.exitCode = 1;
      const unknowns = rows.filter((r) => r.status === "unknown").length;
      if (!opts.json && unknowns > 0) {
        console.log(`${unknowns} 项 UNKNOWN——unknown 不是 pass；见各 fix 行核对。`);
      }
    });

  return cmd;
}
