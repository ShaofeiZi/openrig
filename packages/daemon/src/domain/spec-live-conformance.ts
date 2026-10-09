import type { RigSpec } from "./types.js";

/**
 * Build B——spec 与实时拓扑的一致性。
 *
 * 任何重建或描述工作组的功能（实例化、`zrig validate`、bundle export、pod-bundle vendoring）
 * 都把工作组 spec 当作权威来源，但修改工作组的路径没有一个会维护它。`zrig expand` 通过后台服务
 * 向运行中的工作组添加 pod，却没有代码路径回写 rigRoot spec。因此 drift 并非此处要预防的偶发情况；
 * 在没有 writer 时它必然发生，本模块不试图阻止。
 *
 * 本模块让 drift 在两个会造成损害的时刻可被明确表达：bundle export 会逐字复制 spec，否则会静默
 * 发布一个小于实际运行拓扑的工作组；显式一致性检查则让后续 spec 回写真正得到验证，而不是靠目测。
 *
 * 仅报告。本模块不修改 spec，也不阻止 export。
 */

export interface Topology {
  /** Pod id，例如 `orch`。 */
  pods: string[];
  /** 完全限定的席位 id，例如 `orch.lead`。 */
  seats: string[];
}

export interface ConformanceResult {
  conforms: boolean;
  spec: { pods: number; seats: number };
  live: { pods: number; seats: number };
  /** 正在运行但未声明；bundle export 会静默丢弃的内容。 */
  podsMissingFromSpec: string[];
  seatsMissingFromSpec: string[];
  /** 已声明但未运行；重新实例化会尝试启动的内容。 */
  podsMissingFromLive: string[];
  seatsMissingFromLive: string[];
  /**
   * 一条点明真实差异的可操作说明；拓扑一致时为 null。
   *
   * 一致时返回 null 是契约，不是实现细节。每次都警告会让读者养成略读习惯，真正重要的那次 export
   * 就会和前 96 次一样被忽略。调用方可在非 null 时打印，null 时不输出任何内容。
   */
  message: string | null;
}

/** 排序、去重并移除空白，使顺序本身绝不会制造差异。 */
function normalize(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((v) => typeof v === "string" && v.trim() !== ""))).sort();
}

function missing(from: readonly string[], against: readonly string[]): string[] {
  const present = new Set(against);
  return from.filter((v) => !present.has(v));
}

export function compareSpecToLive(spec: Topology, live: Topology): ConformanceResult {
  const specPods = normalize(spec.pods);
  const specSeats = normalize(spec.seats);
  const livePods = normalize(live.pods);
  const liveSeats = normalize(live.seats);

  const podsMissingFromSpec = missing(livePods, specPods);
  const seatsMissingFromSpec = missing(liveSeats, specSeats);
  const podsMissingFromLive = missing(specPods, livePods);
  const seatsMissingFromLive = missing(specSeats, liveSeats);

  const conforms =
    podsMissingFromSpec.length === 0 &&
    seatsMissingFromSpec.length === 0 &&
    podsMissingFromLive.length === 0 &&
    seatsMissingFromLive.length === 0;

  const result: ConformanceResult = {
    conforms,
    spec: { pods: specPods.length, seats: specSeats.length },
    live: { pods: livePods.length, seats: liveSeats.length },
    podsMissingFromSpec,
    seatsMissingFromSpec,
    podsMissingFromLive,
    seatsMissingFromLive,
    message: null,
  };
  if (conforms) return result;

  // 点明真实差异；笼统的“拓扑可能不同”只会成为读者习惯跳过的提示。
  const parts = [
    `spec declares ${result.spec.pods} pods/${result.spec.seats} seats; live rig has ${result.live.pods}/${result.live.seats}`,
  ];
  if (podsMissingFromSpec.length) parts.push(`pods running but ABSENT FROM THE SPEC: ${podsMissingFromSpec.join(", ")}`);
  if (seatsMissingFromSpec.length) parts.push(`seats absent from the spec: ${seatsMissingFromSpec.join(", ")}`);
  if (podsMissingFromLive.length) parts.push(`pods declared but NOT RUNNING: ${podsMissingFromLive.join(", ")}`);
  if (seatsMissingFromLive.length) parts.push(`seats declared but not running: ${seatsMissingFromLive.join(", ")}`);
  result.message = parts.join("; ");
  return result;
}

/** SPEC 声明的 pod 与席位。 */
export function topologyFromRigSpec(spec: Pick<RigSpec, "pods">): Topology {
  const pods: string[] = [];
  const seats: string[] = [];
  for (const pod of spec.pods ?? []) {
    if (!pod?.id) continue;
    pods.push(pod.id);
    for (const member of pod.members ?? []) {
      if (member?.id) seats.push(`${pod.id}.${member.id}`);
    }
  }
  return { pods, seats };
}

/**
 * 后台服务实际运行的 pod 与席位，由节点逻辑 id（`<pod>.<member>`）派生。格式错误或空 id
 * 会被跳过而非猜测；无法解析的 id 不能作为 pod 存在的证据。
 */
export function topologyFromLiveLogicalIds(logicalIds: readonly (string | null | undefined)[]): Topology {
  const pods: string[] = [];
  const seats: string[] = [];
  for (const id of logicalIds) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    const dot = trimmed.indexOf(".");
    if (dot <= 0 || dot === trimmed.length - 1) continue;
    const pod = trimmed.slice(0, dot);
    if (!pods.includes(pod)) pods.push(pod);
    seats.push(trimmed);
  }
  return { pods, seats };
}

/**
 * 旧版（v1）spec 声明的席位：没有 pod 的扁平 `nodes:` 列表。
 *
 * v1 spec 通过同一 create 端点导出，也会生成同样自信却错误的 artifact，因此需要相同比较。
 * 无需第二个 comparator：旧版工作组只是没有 pod 层级的拓扑，`compareSpecToLive` 已能处理空 pod 列表。
 */
export function topologyFromLegacyRigSpec(spec: { nodes?: ReadonlyArray<{ id?: unknown }> }): Topology {
  const seats: string[] = [];
  for (const node of spec.nodes ?? []) {
    if (typeof node?.id === "string" && node.id.trim() !== "") seats.push(node.id.trim());
  }
  return { pods: [], seats };
}

/**
 * 后台服务实际运行的席位，以扁平方式读取；这是 `topologyFromLiveLogicalIds` 的旧版对应实现。
 *
 * 对旧版工作组，节点 `logical_id` 就是 spec 的 `node.id`，不存在可拆分的 `<pod>.<member>`。
 * 若在此复用 pod-aware reader，会把每个扁平 id 都判成格式错误并报告空的实时工作组，等同于
 * “没有任何内容运行”的虚假缺失；对职责正是发现将被丢弃内容的守卫而言，这是最危险的答案。
 */
export function topologyFromLiveNodeIds(logicalIds: readonly (string | null | undefined)[]): Topology {
  const seats: string[] = [];
  for (const id of logicalIds) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (trimmed !== "") seats.push(trimmed);
  }
  return { pods: [], seats };
}

/** 单行 export 提示；没有需要说明的内容时为 null。 */
export function bundleExportWarning(result: ConformanceResult): string | null {
  if (result.message === null) return null;
  return `警告：此包描述的是规格，而非实时工作组——${result.message}。该包将实例化 ${result.spec.pods} 个 Pod、${result.spec.seats} 个席位。`;
}
