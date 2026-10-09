// OPR.0.4.4.15 FR-1——后台服务侧待关注聚合（SEE 架构，调用 A）：本地后台服务通过已注册的
// HTTP+bearer transport，在服务端向每个已订阅主机的正式 GET /api/queue/list?attention=1
// 扇出，合并后返回一份 AggregatedPayload。Bearer token 绝不到达浏览器；feed 只在本模块
// 联系远端主机。
//
// 复用而非重写：本地分支调用现有路由使用的同一个 QueueRepository.listAttention 查询
//（在路由接线处注入）；registry 通过 S11 共享 hosts-registry-reader 读取，绝不重复解析；
// 远端跳转复用 remote-daemon-http 核心，并在本调用点显式指定 READ deadline 类别。架构约束
// 为 5 秒，因为这是轮询而非 bootstrap；up-leaf 的 120 秒预算留在它自己的调用点。
//
// FR-1/R15-2 真实性：每次调用的 hosts[] 都必须包含每个已订阅主机，并明确标为 ok、
// unreachable、auth-failed 或 unsupported-transport；绝不全有全无，也绝不静默缩减 feed。
// 只有启用至少一个远端订阅时才读取 registry；零配置时绝不触碰它。

import type { AggregatedPayload, PerHostStatus } from "../hosts/fanout-contract.js";
import { LOCAL_HOST_ID } from "../hosts/fanout-contract.js";
import type { HostRegistryLoadResult } from "../hosts/hosts-registry-reader.js";
import { resolveHost } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest } from "../hosts/remote-daemon-http.js";

/** 聚合 READ deadline 类别（逐主机上限）。它按设计不同于 up-leaf 的长任务预算，因此在这里
 *  命名并显式传入。 */
export const ATTENTION_READ_TIMEOUT_MS = 5_000;

/** 固定扇出上限：这里只轮询少量主机；自适应节流不在范围内，与 topology walker 的 v1
 *  策略相同。 */
export const ATTENTION_FANOUT_CONCURRENCY = 4;

export type AttentionItem = Record<string, unknown>;

export interface AttentionAggregatorDeps {
  /** 正式 /api/queue/list?attention=1 路由运行的同一个查询。 */
  listLocalAttention: () => AttentionItem[];
  /** settings-store.listFeedHostSubscriptions（G15-P1 动态类别）。 */
  listSubscriptions: () => Array<{ hostId: string; enabled: boolean }>;
  /** S11 共享 reader；仅存在远端订阅时延迟调用。 */
  loadRegistry: () => HostRegistryLoadResult;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  /** 测试覆盖值；生产使用 ATTENTION_READ_TIMEOUT_MS。 */
  timeoutMs?: number;
  concurrency?: number;
}

interface PerHostOutcome {
  status: PerHostStatus;
  items: AttentionItem[];
}

async function readHostAttention(hostId: string, reg: HostRegistryLoadResult, deps: AttentionAggregatorDeps): Promise<PerHostOutcome> {
  if (!reg.ok) {
    // Registry 不可读时，每个已订阅主机都如实报告；操作员在每个主机行看到一条可执行错误，
    // 本地 item 不受影响。
    return { status: { hostId, status: "unreachable", error: reg.error }, items: [] };
  }
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) {
    return { status: { hostId, status: "unreachable", error: resolved.error }, items: [] };
  }
  if (resolved.host.transport !== "http") {
    // R15-2（沿用 whoami --all-hosts）：SSH 声明的主机要显示结构化逐主机状态，绝不能
    // 静默缩减 feed。
    return {
      status: { hostId, status: "unsupported-transport", error: `主机 '${hostId}' 声明为 SSH；聚合 feed 读取需要 http transport registry entry（url 必填，bearer 可选）` },
      items: [],
    };
  }
  const res = await remoteJsonRequest(resolved.host, "/api/queue/list?attention=1", {
    method: "GET",
    timeoutMs: deps.timeoutMs ?? ATTENTION_READ_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) {
    const arr = Array.isArray(res.payload) ? (res.payload as AttentionItem[]) : [];
    return { status: { hostId, status: "ok" }, items: arr.map((i) => ({ ...i, hostId })) };
  }
  switch (res.kind) {
    case "bearer":
      return { status: { hostId, status: "auth-failed", error: res.detail, failedStep: "permission-gate" }, items: [] };
    case "http":
      if (res.status === 401 || res.status === 403) {
        return { status: { hostId, status: "auth-failed", error: `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`, failedStep: "permission-gate" }, items: [] };
      }
      // 读取远端时收到 4xx/5xx，feed 无法显示该主机的 item。最接近的封闭枚举事实是
      // unreachable；把远端自身 status/text 作为真实 detail，并附加正式 FailedStep 词汇。
      return { status: { hostId, status: "unreachable", error: `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`, failedStep: "remote-command-failed" }, items: [] };
    case "timeout":
      return {
        status: {
          hostId,
          status: "unreachable",
          error: res.phase === "body" ? `读取超时：响应头已到达（HTTP ${res.status}），但响应体始终未完成` : `读取在 ${deps.timeoutMs ?? ATTENTION_READ_TIMEOUT_MS}ms 后超时`,
          failedStep: "remote-daemon-unreachable",
        },
        items: [],
      };
    case "network":
      return { status: { hostId, status: "unreachable", error: res.detail, failedStep: "remote-daemon-unreachable" }, items: [] };
  }
}

/** 合并后的单一待关注 payload：始终包含本地 item（标记契约 LOCAL_HOST_ID）；每个启用的远端
 *  主机都在 read deadline 与固定并发上限内扇出，逐主机状态从构造上完整。 */
export async function aggregateAttention(deps: AttentionAggregatorDeps): Promise<AggregatedPayload<AttentionItem>> {
  const localItems = deps.listLocalAttention().map((i) => ({ ...i, hostId: LOCAL_HOST_ID }));
  const hosts: PerHostStatus[] = [{ hostId: LOCAL_HOST_ID, status: "ok" }];
  const items: AttentionItem[] = [...localItems];

  const subs = deps.listSubscriptions().filter((s) => s.enabled);
  if (subs.length === 0) {
    // 没有远端订阅时绝不读取 registry；payload 只包含当前本地 feed 与本地状态行。
    return { items, hosts };
  }

  const reg = deps.loadRegistry();
  const outcomes = new Array<PerHostOutcome>(subs.length);
  let next = 0;
  const cap = Math.max(1, Math.min(deps.concurrency ?? ATTENTION_FANOUT_CONCURRENCY, subs.length));
  const workers = Array.from({ length: cap }, async () => {
    while (true) {
      const i = next;
      if (i >= subs.length) return;
      next += 1;
      outcomes[i] = await readHostAttention(subs[i]!.hostId, reg, deps);
    }
  });
  await Promise.all(workers);

  // 两个数组都保留订阅顺序，使 payload 保持确定。
  for (const outcome of outcomes) {
    hosts.push(outcome.status);
    items.push(...outcome.items);
  }
  return { items, hosts };
}
