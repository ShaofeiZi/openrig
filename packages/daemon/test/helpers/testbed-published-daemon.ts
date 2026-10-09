// PUBLISHED-DAEMON 流程——所有使用方的唯一事实来源。
//
// A/B testbed 通过 PUBLISHED PORTS 访问容器化 daemon。以下三项机制相互耦合，
// 每处使用都必须完全一致，否则 runbook 与 container adapter 会发生漂移，
// 各自“证明”不同的事情：
//
//   1. EXPLICIT BIND。`packages/daemon/src/index.ts:148` 读取 OPENRIG_HOST；
//      未设置时默认为 127.0.0.1（:167）——loopback 无法通过 published port 访问，
//      这正是首次 A/B 两组均失败的原因。
//   2. BEARER，因为 bind 要求如此。`assertBindAuthInvariant`
//     （middleware/auth-bearer-token.ts:240-264）拒绝在缺少 OPENRIG_AUTH_BEARER_TOKEN 时
//      启动 non-loopback bind。此流程满足该门禁；绝不削弱、绕过或特殊处理它。
//   3. EXPLICIT HOST PORT。Apple `container` 1.2.0 会拒绝 Docker 所接受的临时 publish 形式
//     （`invalid publish host port range: 0`）；使用带 loopback 的形式（`127.0.0.1:P:C`）时会 RESET，
//      而不带限定的形式可以工作。因此两组都显式发布 `P:C`。
//
// PROBE SPLIT（不得合并，否则会制造虚假 green）：
//   • /healthz 未经认证（直接注册于 server.ts:574；不存在全局 auth middleware）——
//     它只证明 REACHABILITY。用它评判 auth 会得到通过，却什么也证明不了。
//   • GUARDED 路由用于证明 AUTH 路径：/api/transport/* 保护其整个 router
//     （routes/transport.ts:9）。任何非 401 响应都证明 bearer 已获接受；为此，应用层 404 也算 PASS。
//   • NEGATIVE CONTROL（同一调用，不带 header）必须返回 401，否则 guard 并未生效，probe 2 也毫无证明力。
//
// 使用方：docker/testbed/runbooks/L3-daemon-in-container.md（文字镜像，由
// testbed-published-daemon.test.ts 固定一致性）和 container adapter
//（helpers/scenario-container.ts）。在此处修改值后，一致性测试会使未同步的 runbook 失败。

/** 容器内部的 daemon 端口。 */
export const CONTAINER_PORT = 7433;

/** L3 单容器阶段发布的主机端口。必须显式指定，绝不为 0。 */
export const L3_HOST_PORT = 19433;

/** 强制显式 bind 的环境变量（index.ts:148）。 */
export const BIND_ENV = "OPENRIG_HOST";
export const BIND_VALUE = "0.0.0.0";

/** 携带 bind 门禁所需 bearer 的环境变量（auth-bearer-token.ts:240）。 */
export const BEARER_ENV = "OPENRIG_AUTH_BEARER_TOKEN";

/**
 * 主机侧 `zrig` READ 访问 guarded 路由所需的环境变量（client.ts 的 terminal-token 解析）。
 * 它与 `BEARER_ENV` 不同——这一差异至关重要：
 *
 * guarded router 由 TERMINAL token 把关，而不是 auth token
 *（`server.ts:632` 将 `deps.terminalBearerToken` 传入 `transportRoutes`）。一般情况下二者值不同。
 * 它们只在此处一致，因为 bind 不受信任（未走 loopback/tailscale 短路）时，`index.ts:160` 会将
 * auth 复制到 terminal——恰好就是此流程要求的 `0.0.0.0` bind。因此该流程使用同一个 token 值，且：
 *   • 携带 `Authorization: Bearer <token>` 的直接 curl 可按原样工作；
 *   • 主机侧 `zrig` read 需要在此环境变量名下提供 token。
 *
 * NEGATIVE CONTROL 不能省略的原因：terminal token 为 null 时，middleware 会放行所有请求
 *（`auth-bearer-token.ts:98-101`），此时路由不受保护。如果 bind 日后被放宽为 loopback 而仍保留 bearer，
 * `terminalBearerToken` 将保持 null，guarded probe 无需 auth 即可响应；只做 auth probe 的 runbook
 * 会报告毫无证明力的 green。negative control（同一调用，不带 header，必须返回 401）正是用于检测此状态——
 * 它断言 guard 确实已启用。
 */
export const TERMINAL_BEARER_ENV = "OPENRIG_TERMINAL_BEARER_TOKEN";

/** 无需认证的可达性 probe。 */
export const HEALTH_PATH = "/healthz";

/** 用于 AUTH probe 及其 negative control 的 guarded 路由。 */
export const GUARDED_PROBE_PATH = "/api/transport/send";

/**
 * publish 参数。按设计不带限定：Apple 1.2.0 遇到带 loopback 的形式会重置连接，
 * 因此两组使用同一个不带限定的字符串——输入完全一致，并非仅针对 Apple 的让步。
 */
export function publishArg(hostPort: number, containerPort: number = CONTAINER_PORT): string {
  if (!Number.isInteger(hostPort) || hostPort <= 0) {
    throw new Error(
      `testbed publish: host port must be an explicit positive integer (got ${hostPort}). ` +
        `Ephemeral port 0 is rejected by Apple container 1.2.0 — allocate explicitly.`,
    );
  }
  return `${hostPort}:${containerPort}`;
}

/** 每个 published-daemon 容器都需要的 daemon 环境变量。 */
export function publishedDaemonEnv(bearerToken: string): Record<string, string> {
  if (!bearerToken) {
    throw new Error(
      "testbed bearer: a non-empty token is required — the daemon REFUSES a non-loopback bind " +
        "without one (assertBindAuthInvariant). Satisfy the guard; never weaken it.",
    );
  }
  return { [BIND_ENV]: BIND_VALUE, [BEARER_ENV]: bearerToken };
}

/** 上述环境变量对应的 Docker/Apple `run` flag（扁平的 -e 参数对，便于 adapter 使用）。 */
export function publishedDaemonEnvFlags(bearerToken: string): string[] {
  return Object.entries(publishedDaemonEnv(bearerToken)).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

/**
 * 主机侧 `zrig` read 访问已发布 daemon 时所需的环境变量：terminal token
 *（参见 TERMINAL_BEARER_ENV）以及 read 应访问的 daemon URL。
 * 应使用此函数，不要在各使用方中手工拼装环境变量。
 */
export function rigReadEnv(bearerToken: string, baseUrl: string): Record<string, string> {
  if (!bearerToken) {
    throw new Error(
      "testbed rig-read: a non-empty token is required — a guarded route answers 401 without it, " +
        "and a NULL terminal token would leave the route unguarded entirely (see TERMINAL_BEARER_ENV).",
    );
  }
  return { [TERMINAL_BEARER_ENV]: bearerToken, OPENRIG_URL: baseUrl };
}

// ── STAGING：将 fixture 正确放入容器（一个方法，两个使用方）──
//
// 这里修复了两个确实存在的缺陷：(1) 在 /root 下暂存会使 `USER openrig` 无法读取该目录树；
// (Dockerfile:61)；(2) `docker cp` 会保留 ROOT 所有权，因此即使 stage 可读也不可写——
// 而 `zrig up` 的 launch 前投递会写入其中（AGENTS.md），导致 instantiate 时出现 EACCES。
//
// 从结构上同时规避两者的修复：在 openrig 用户自己的 home 下暂存，并通过 TAR-PIPE 投递到默认的
// `docker exec`，由 `openrig` 身份解压。无需 chown，也不以 root 执行——产品以谁运行，就由谁完成工作。

/** exec 用户的 home——所有暂存内容都位于其中。 */
export const CONTAINER_STAGE_ROOT = "/home/openrig";

/** 容器内 stage 路径。使用方应将此路径传给 daemon，绝不能传主机路径：
 *  daemon 在容器内读取 topology。 */
export function containerStagePath(name: string): string {
  if (!name || name.startsWith("/") || name.includes("..")) {
    throw new Error(`testbed stage: expected a simple relative name, got ${JSON.stringify(name)}`);
  }
  return `${CONTAINER_STAGE_ROOT}/${name}`;
}

/** tar 侧 argv：流式传输源目录内容（注意末尾的 "."）。 */
export function stageTarSourceArgv(hostDir: string): string[] {
  return ["-C", hostDir, "-cf", "-", "."];
}

/** docker 侧 argv：以默认 exec 用户（openrig）解压——不使用 `-u`，也不 chown。
 *  将 stageTarSourceArgv 的 stdout 通过管道接入此进程的 stdin。 */
export function stageExtractArgv(container: string, stagePath: string): string[] {
  return ["exec", "-i", container, "tar", "-C", stagePath, "-xf", "-"];
}

/** stage 在被任何内容依赖前必须通过的预检：以 exec 用户身份可读且可写。通过实际执行 touch/rm 探测，
 *  而不是读取 mode bit——在所有权、ACL 和只读挂载条件下，bit 可能会误导。 */
export function stageFenceArgv(container: string, stagePath: string, expectFile?: string): string[] {
  // 断言内容已经到达，而不只是目录存在——`mkdir -p` 会创建目录，因此投递零内容时（tar 失败的非零
  // 退出码被管道掩盖，因为 shell pipeline 只报告最后一个命令的状态），会留下一个空但完全可读写的 stage。
  // 只检查目录会错误通过，并将真实症状推迟到下游 `zrig up` 的文件未找到错误。
  const target = expectFile ? `${stagePath}/${expectFile}` : stagePath;
  return [
    "exec", container, "sh", "-c",
    `test -r '${target}' && touch '${stagePath}/.fence-write' && rm -f '${stagePath}/.fence-write'`,
  ];
}

/**
 * 唯一正确顺序的 staging 流程，组合后可避免使用方错误重建：mkdir -> 以 exec 用户身份 extract ->
 * FENCE -> 然后且只有此时，才把容器内路径交给 daemon。
 *
 * 顺序至关重要：fence 必须在解压后执行（空 stage 也能通过朴素读取检查），并先于任何依赖 stage 的操作；
 * 否则首个症状会变成下游三步之后 `zrig up` 抛出的 EACCES，而不是在此处明确失败。
 *
 * 返回供使用方自身 docker seam 使用的 docker argv 数组；`tarSource` 是 tar 侧 argv，
 * 其 stdout 通过管道连接到 `extract` 的 stdin。
 */
export function stageTopologyPlan(opts: { container: string; hostDir: string; name?: string; expectFile?: string }): {
  stagePath: string;
  steps: Array<{ label: string; argv: string[]; stdinFrom?: string[] }>;
} {
  const stagePath = containerStagePath(opts.name ?? "topologies");
  return {
    stagePath,
    steps: [
      { label: "mkdir", argv: ["exec", opts.container, "mkdir", "-p", stagePath] },
      {
        label: "extract",
        argv: stageExtractArgv(opts.container, stagePath),
        stdinFrom: stageTarSourceArgv(opts.hostDir),
      },
      { label: "fence", argv: stageFenceArgv(opts.container, stagePath, opts.expectFile) },
    ],
  };
}
