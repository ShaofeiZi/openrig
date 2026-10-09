// OPR.0.4.6.MH5——后台服务侧的 FLEET composer（唯一新增 core）。
//
// Arch Q1（已裁定）：每台主机自己的 composer 对其按时间派生的 ▲/● 集合拥有权威。此模块 fan-out
// 每台已注册主机已经组合好的工作组根（`GET /api/review/rig`，无参数的主机级 altitude root），
// 只执行 UNION + HOST-DIMENSIONS + COUNTS。它绝不重新计算 exception truth；此处没有时钟、阈值
// 或随机值，因此跨主机时钟偏差绝不会扭曲 ▲。
//
// Arch Q2/Q3（已裁定）：FLEET 是同级 aggregate，本地 composer 文件保持纯净；本模块是 review
// domain 中唯一导入 hosts/transport 的位置（C1 边界，由 C5 import-audit 测试机械锁定）。
// 后台服务侧只有一个 composer；所有 consumer（当前 UI，以及后续 TUI/CLI）读取同一份结果。
//
// Arch Q4（已裁定）：以 `${hostId}|${identity}` 为 key 的 one-count Set 只存在于这里。单主机内
// N-altitude 重复项折叠为一条 fleet 行（seenFrom 记录实际读取的 altitude）；两台主机上形状相同的
// identity 仍保留为两行。经 MH-3 转发的 qitem 只存在于其 ORIGIN 主机数据库中
//（handoff 时 source 已关闭），因此从结构上不会重复计数。
//
// D-7：并发 remote read 共享同一个已经开始计时的 composition budget；慢主机会降级为诚实的
// per-host 状态。LOCAL 主机通过进程内 composer 直接加入（D-1：一个 fleet member，零自 transport）。

import type {
  AgentRow,
  ComposedFleet,
  ComposedFleetRollup,
  ComposedRigAgents,
  FleetHostRollup,
  FleetNeedsYouItem,
  FleetSettledRow,
  NeedsYouItem,
  SettledRow,
} from "./types.js";
import type { PerHostStatus } from "../hosts/fanout-contract.js";
import { LOCAL_HOST_ID } from "../hosts/fanout-contract.js";
import type { HostRegistryLoadResult } from "../hosts/hosts-registry-reader.js";
import { resolveHost } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest } from "../hosts/remote-daemon-http.js";

/** 普通 TUI/CLI 调用方给 GET 五秒预算。预留一秒（20%）供 fan-out 后的 union/serialization、
 *  transport 和 scheduling 使用；remote wait 共享剩余四秒，其中包含已消耗的本地工作时间。
 *  发生同步阻塞或事件循环停滞时，此余量并非保证。 */
export const FLEET_READ_TIMEOUT_MS = 5_000 - 1_000;

/** 固定 fan-out 上限，用于轮询少量主机；这是已交付 aggregator 的 v1 姿态，
 *  自适应节流不在范围内。 */
export const FLEET_FANOUT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// 纯 union core（为 C5 vector 导出）。无时钟、无随机值、无 I/O；相同输入产生逐字节相同输出，
// 且不受输入顺序影响。
// ---------------------------------------------------------------------------

/** 一次读取主机某个 altitude 上已组合的 needs-you 行。production（D-1）为每台可达主机恰好
 *  提供一个 entry，即其工作组根，因此 seenFrom 显示 `rig`；union 机制也适用于任意 scoped set
 *  （C5 三 altitude vector 会传入 slice+mission+rig）。 */
export interface ScopedNeedsYou {
  scope: string;
  items: NeedsYouItem[];
}

/** 一台可达 fleet member 对 union 的贡献。 */
export interface FleetHostInput {
  hostId: string;
  kind: "local" | "remote";
  scopedNeedsYou: ScopedNeedsYou[];
  agents: AgentRow[];
  settled: SettledRow[];
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** 对去重后 fleet 行定义全序：先按 priority rank，再按 age，最后按 fleet key。最后一级是完整
 *  tiebreak，因此置换输入永远不会改变输出顺序（C5 permutation-stability vector）。 */
function compareFleetRows(a: FleetNeedsYouItem, b: FleetNeedsYouItem): number {
  const ra = PRIORITY_RANK[a.priority ?? "normal"] ?? 2;
  const rb = PRIORITY_RANK[b.priority ?? "normal"] ?? 2;
  if (ra !== rb) return ra - rb;
  const aa = a.ageIso ?? "9999";
  const ba = b.ageIso ?? "9999";
  if (aa !== ba) return aa < ba ? -1 : 1;
  return a.fleetKey < b.fleetKey ? -1 : a.fleetKey > b.fleetKey ? 1 : 0;
}

/** BR-1 会话语法为 member@rig，会话字符串中不存在 @host 形式。统计一台主机智能体行中的不同
 *  工作组名称，是对该语法的结构化解析，绝非 prose 解析。 */
function distinctRigCount(agents: AgentRow[]): number {
  const rigs = new Set<string>();
  for (const a of agents) {
    const at = a.sessionName.lastIndexOf("@");
    if (at > 0 && at < a.sessionName.length - 1) rigs.add(a.sessionName.slice(at + 1));
  }
  return rigs.size;
}

/** 主机的最严重一行，供直接朗读；从该主机已去重且按全序排列的行中确定性派生，第 0 行最严重。 */
function hostTopLine(rows: FleetNeedsYouItem[]): string {
  if (rows.length === 0) return "安静";
  const worst = rows[0]!;
  return worst.derived ? `▲ ${worst.derived.kind} — ${worst.summary}` : `● ${worst.summary}`;
}

/** Union + host dimension + count，这是 fleet root 仅有的职责。`statuses` 必须携带每个 fleet
 *  member，以防遗漏；`inputs` 只携带实际读到 composed set 的 member。 */
export function unionFleet(
  inputs: FleetHostInput[],
  statuses: PerHostStatus[],
  composedAt: string,
  registryError?: string,
): ComposedFleet {
  // Q4 one-count Set 的唯一归属。Key = `${hostId}|${identity}`。
  const seen = new Map<string, FleetNeedsYouItem>();
  const perHostRows = new Map<string, FleetNeedsYouItem[]>();
  for (const host of inputs) {
    for (const scoped of host.scopedNeedsYou) {
      for (const item of scoped.items) {
        const fleetKey = `${host.hostId}|${item.identity}`;
        const existing = seen.get(fleetKey);
        if (existing) {
          if (!existing.seenFrom.includes(scoped.scope)) existing.seenFrom.push(scoped.scope);
          continue;
        }
        const row: FleetNeedsYouItem = { ...item, hostId: host.hostId, fleetKey, seenFrom: [scoped.scope] };
        seen.set(fleetKey, row);
        if (!perHostRows.has(host.hostId)) perHostRows.set(host.hostId, []);
        perHostRows.get(host.hostId)!.push(row);
      }
    }
  }
  const rows = [...seen.values()].sort(compareFleetRows);
  for (const hostRows of perHostRows.values()) hostRows.sort(compareFleetRows);

  // rollup 数学从去重后的行计算，可对照 header 检查。
  const byKind = new Map<string, number>();
  let needsYouCount = 0;
  let exceptionCount = 0;
  for (const r of rows) {
    if (r.derived) {
      exceptionCount += 1;
      byKind.set(r.derived.kind, (byKind.get(r.derived.kind) ?? 0) + 1);
    } else {
      needsYouCount += 1;
    }
  }
  const rollup: ComposedFleetRollup = {
    needsYouCount,
    exceptionCount,
    exceptionsByKind: [...byKind.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([kind, count]) => ({ kind, count })),
    hostCount: statuses.length,
    unreachableCount: statuses.filter((s) => s.status !== "ok").length,
  };

  // HOSTS band 行按 statuses 顺序排列：local 优先，其后为 registry 顺序。count 只存在于已读取 member；
  // 失败时为 absent，而不是零。
  const inputByHost = new Map(inputs.map((h) => [h.hostId, h]));
  const hosts: FleetHostRollup[] = statuses.map((status) => {
    const input = inputByHost.get(status.hostId);
    const base: FleetHostRollup = {
      hostId: status.hostId,
      kind: status.hostId === LOCAL_HOST_ID ? "local" : "remote",
      status,
    };
    if (!input || status.status !== "ok") return base;
    const hostRows = perHostRows.get(status.hostId) ?? [];
    const hostKinds = new Map<string, number>();
    let hostNeedsYou = 0;
    for (const r of hostRows) {
      if (r.derived) hostKinds.set(r.derived.kind, (hostKinds.get(r.derived.kind) ?? 0) + 1);
      else hostNeedsYou += 1;
    }
    return {
      ...base,
      needsYouCount: hostNeedsYou,
      exceptionsByKind: [...hostKinds.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([kind, count]) => ({ kind, count })),
      seatCount: input.agents.length,
      rigCount: distinctRigCount(input.agents),
      topLine: hostTopLine(hostRows),
    };
  });

  // 最小 SETTLED（D-5），带 host chip，按确定性顺序排列：先按 closed-at 降序，再按 qitem ID
  // 完整打破平局。
  const settled: FleetSettledRow[] = inputs
    .flatMap((h) => h.settled.map((s) => ({ ...s, hostId: h.hostId })))
    .sort((a, b) => (a.closedAtIso !== b.closedAtIso ? (a.closedAtIso > b.closedAtIso ? -1 : 1) : a.qitemId < b.qitemId ? -1 : 1));

  const composingCount = statuses.filter((s) => s.status === "ok").length;
  return {
    rollup,
    needsYou: {
      items: rows,
      provenance: `fleet 对每台主机自己的 composed set 求 union · 每个 identity+host 只计一次 · ${composingCount}/${statuses.length} 台主机完成组合${rollup.unreachableCount > 0 ? "（失败主机的 item 为缺失，而不是零）" : ""}`,
    },
    hosts,
    settled,
    settledProvenance: settled.length === 0 ? `${composingCount} 台已组合主机中有 0 个 settled handoff` : `${composingCount} 台已组合主机今天关闭的 handoff`,
    ...(registryError !== undefined ? { registryError } : {}),
    composedAt,
  };
}

// ---------------------------------------------------------------------------
// fan-out shell（接触 transport 的部分；镜像已交付 attention-aggregator 的 per-host outcome 纪律，G9）。
// ---------------------------------------------------------------------------

export interface FleetComposeDeps {
  /** D-1：LOCAL 主机在进程内加入，零自 transport。 */
  composeLocalRig: () => ComposedRigAgents;
  /** S11 共享 reader；fleet 枚举每台已注册主机。 */
  loadRegistry: () => HostRegistryLoadResult;
  /** Registry 存在性 probe。registry 缺失表示单主机操作员，即干净的 local-only fleet；
   *  registry 不可读时如实呈现。 */
  registryExists: () => boolean;
  /** 由调用方传入的 view-time fact；union 绝不派生时间状态。 */
  nowIso: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  /** 测试用于覆盖总 elapsed budget；绝不是 per-host/per-wave 预算。 */
  timeoutMs?: number;
  concurrency?: number;
}

interface PerHostOutcome {
  status: PerHostStatus;
  input: FleetHostInput | null;
}

/** 对 remote composed payload 执行最小结构检查。携带错误 shape 的 200 会降级为诚实的 per-host
 *  状态，绝不崩溃，也绝不成为静默空白的 `ok` 数据。 */
function parseComposedRig(payload: unknown): ComposedRigAgents | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const needsYou = p["needsYou"] as Record<string, unknown> | undefined;
  const agents = p["agents"] as Record<string, unknown> | undefined;
  if (!needsYou || !Array.isArray(needsYou["items"])) return null;
  if (!agents || !Array.isArray(agents["rows"])) return null;
  if (!Array.isArray(p["settled"])) return null;
  return payload as ComposedRigAgents;
}

async function readHostComposedRig(hostId: string, reg: HostRegistryLoadResult, deps: FleetComposeDeps, deadline: number): Promise<PerHostOutcome> {
  if (!reg.ok) {
    return { status: { hostId, status: "unreachable", error: reg.error }, input: null };
  }
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) {
    return { status: { hostId, status: "unreachable", error: resolved.error }, input: null };
  }
  if (resolved.host.transport !== "http") {
    return {
      status: { hostId, status: "unsupported-transport", error: `主机 '${hostId}' 声明为 SSH；fleet composed read 需要 http-transport registry entry（url 必填，bearer 可选）` },
      input: null,
    };
  }
  const remainingMs = Math.floor(deadline - performance.now());
  if (remainingMs <= 0) {
    return {
      status: { hostId, status: "unreachable", error: "fleet read 预算已耗尽，未尝试 remote request" },
      input: null,
    };
  }
  const res = await remoteJsonRequest(resolved.host, "/api/review/rig", {
    method: "GET",
    // request 与 body 共享 transport 的 abort。后续 worker wave 只能获得同一 deadline 的剩余时间，
    // 绝不重置预算。
    timeoutMs: remainingMs,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) {
    const composed = parseComposedRig(res.payload);
    if (!composed) {
      return { status: { hostId, status: "unreachable", error: "remote /api/review/rig 返回了格式错误的 composed payload", failedStep: "remote-command-failed" }, input: null };
    }
    return {
      status: { hostId, status: "ok" },
      input: {
        hostId,
        kind: "remote",
        scopedNeedsYou: [{ scope: "rig", items: composed.needsYou.items }],
        agents: composed.agents.rows,
        settled: composed.settled,
      },
    };
  }
  switch (res.kind) {
    case "bearer":
      return { status: { hostId, status: "auth-failed", error: res.detail, failedStep: "permission-gate" }, input: null };
    case "http":
      if (res.status === 401 || res.status === 403) {
        return { status: { hostId, status: "auth-failed", error: `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`, failedStep: "permission-gate" }, input: null };
      }
      return { status: { hostId, status: "unreachable", error: `HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`, failedStep: "remote-command-failed" }, input: null };
    case "timeout":
      return {
        status: {
          hostId,
          status: "unreachable",
          error: res.phase === "body"
            ? `fleet read 预算已耗尽：已收到 response header（HTTP ${res.status}），但 body 始终未完成`
            : "在收到 response header 前，fleet read 预算已耗尽",
          failedStep: "remote-daemon-unreachable",
        },
        input: null,
      };
    case "network":
      return { status: { hostId, status: "unreachable", error: res.detail, failedStep: "remote-daemon-unreachable" }, input: null };
  }
}

/** 唯一的 composed fleet：始终包含 local（进程内，D-1）；在具名 deadline 下并发 fan-out 每台
 *  已注册主机（D-7）；per-host 状态按构造完整；union 按 Q4 key 去重。 */
export async function composeFleet(deps: FleetComposeDeps): Promise<ComposedFleet> {
  // 在同步本地工作和 registry 读取之前启动计时。timer 无法抢占这些工作；如果它们耗尽预算，
  // 就不再增加任何 remote wait。
  const deadline = performance.now() + (deps.timeoutMs ?? FLEET_READ_TIMEOUT_MS);
  const local = deps.composeLocalRig();
  const localInput: FleetHostInput = {
    hostId: LOCAL_HOST_ID,
    kind: "local",
    scopedNeedsYou: [{ scope: "rig", items: local.needsYou.items }],
    agents: local.agents.rows,
    settled: local.settled,
  };
  const statuses: PerHostStatus[] = [{ hostId: LOCAL_HOST_ID, status: "ok" }];
  const inputs: FleetHostInput[] = [localInput];

  if (!deps.registryExists()) {
    // 无 registry 文件表示单主机操作员：得到干净的 local-only fleet；C4 band 在此状态不渲染新内容。
    return unionFleet(inputs, statuses, deps.nowIso);
  }

  const reg = deps.loadRegistry();
  if (!reg.ok) {
    // registry 存在但无法读取/解析时，没有主机列表可用于归属 per-host 状态；应在 payload 层
    // 如实呈现错误，绝不能静默退化成 local-only fleet。
    return unionFleet(inputs, statuses, deps.nowIso, reg.error);
  }

  const hostIds = reg.registry.hosts.map((h) => h.id);
  const outcomes = new Array<PerHostOutcome>(hostIds.length);
  let next = 0;
  const cap = Math.max(1, Math.min(deps.concurrency ?? FLEET_FANOUT_CONCURRENCY, Math.max(hostIds.length, 1)));
  const workers = Array.from({ length: cap }, async () => {
    while (true) {
      const i = next;
      if (i >= hostIds.length) return;
      next += 1;
      outcomes[i] = await readHostComposedRig(hostIds[i]!, reg, deps, deadline);
    }
  });
  await Promise.all(workers);

  // 保留 registry 顺序，确保 payload 确定。
  for (const outcome of outcomes) {
    statuses.push(outcome.status);
    if (outcome.input) inputs.push(outcome.input);
  }
  return unionFleet(inputs, statuses, deps.nowIso);
}
