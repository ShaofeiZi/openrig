import { DaemonClient, remoteDaemonClient } from "./client.js";
import { loadHostRegistry, resolveHost, resolveRemoteBearer, bearerAuthHeaders, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "./host-registry.js";
import { resolveOriginSelfHostId, type LifecycleDeps } from "./daemon-lifecycle.js";
import type { FailedStep } from "./cross-host-types.js";

export interface RemoteHostDeps {
  clientFactory: (url: string) => DaemonClient;
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  /**
   * A4：存在 ⇒ `runRemoteHttpOp` 解析【本机】的 `selfHostId`（fail-open），并在远程请求上
   * 盖上来源三元组，使远程后台服务渲染出【来源】主机。缺省（某些测试 mock）⇒
   * 两段式头部盖章，fail-open——不引入新的失败模式。调用本函数的 8 个命令模块会传入它们的
   * 命令依赖（其中携带 `lifecycleDeps`），因此生产远程路径会盖上三元组。
   */
  lifecycleDeps?: LifecycleDeps;
}

export interface RemoteOpResult {
  ok: boolean;
  failedStep: FailedStep;
  data?: unknown;
  error?: string;
}

export async function runRemoteHttpOp(
  hostId: string,
  method: "GET" | "POST",
  apiPath: string,
  body: unknown | undefined,
  deps: RemoteHostDeps,
  // OPR.0.4.6.MH4 —— 可选的单次调用截止时间（附加项；缺省 = DaemonClient 默认值）。
  // 每个远程调用点自行指定预算。
  opts: { json?: boolean; timeoutMs?: number },
): Promise<RemoteOpResult> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    return { ok: false, failedStep: "remote-daemon-unreachable", error: registry.error };
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    return { ok: false, failedStep: "remote-daemon-unreachable", error: resolved.error };
  }
  const host = resolved.host;

  if (host.transport === "ssh") {
    return { ok: false, failedStep: "remote-command-failed", error: `主机 ${hostId} 使用 SSH 传输；HTTP --host 不可用` };
  }

  const httpHost = host as HttpHostEntry;
  const bearerResult = resolveRemoteBearer(httpHost);
  if (!bearerResult.ok) {
    return { ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
  }

  // A4：8 个走这个咽喉点的模块共用的【唯一】远程来源构造——盖上来源三元组
  //（本机 selfHostId 不可用 / 无 lifecycleDeps 时 fail-open 退化为两段式）。
  const originSelfHostId = deps.lifecycleDeps ? await resolveOriginSelfHostId(deps.lifecycleDeps) : undefined;
  const client = remoteDaemonClient(deps.clientFactory, httpHost.url, originSelfHostId);
  const headers = bearerAuthHeaders(bearerResult.token);
  const requestOptions = opts.timeoutMs !== undefined ? { headers, timeoutMs: opts.timeoutMs } : { headers };

  try {
    const res = method === "POST"
      ? await client.post<unknown>(apiPath, body, requestOptions)
      : await client.get<unknown>(apiPath, requestOptions);

    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      // 失败时也带上来源响应体（附加项）：远程路由自身的错误文本是
      // 调用方在步骤类别旁应当如实展示的细节。
      return { ok: false, failedStep, error: `HTTP ${res.status}`, data: res.data };
    }
    return { ok: true, failedStep: "none", data: res.data };
  } catch (err) {
    return { ok: false, failedStep: classifyHttpError(err), error: (err as Error).message };
  }
}

export async function resolveRemoteRigId(
  hostId: string,
  handle: string,
  deps: RemoteHostDeps,
): Promise<{ ok: true; rigId: string } | { ok: false; error: string }> {
  const psResult = await runRemoteHttpOp(hostId, "GET", "/api/ps?includeArchived=true", undefined, deps, {});
  if (!psResult.ok) return { ok: false, error: `无法在主机 ${hostId} 上解析工作组：${psResult.error}` };

  const rigs = psResult.data as Array<{ rigId: string; name: string; archivedAt?: string | null }>;

  const exactId = rigs.find((r) => r.rigId === handle);
  if (exactId) return { ok: true, rigId: exactId.rigId };

  const byName = rigs.filter((r) => r.name === handle && !r.archivedAt);
  if (byName.length === 1) return { ok: true, rigId: byName[0]!.rigId };
  if (byName.length > 1) {
    return { ok: false, error: `主机 ${hostId} 上的工作组名 "${handle}" 有歧义：有 ${byName.length} 个活动工作组共用该名。请改用工作组 id。` };
  }
  return { ok: false, error: `主机 ${hostId} 上未找到工作组 "${handle}"` };
}
