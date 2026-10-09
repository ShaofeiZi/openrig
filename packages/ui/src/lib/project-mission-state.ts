import type { MissionStatus } from "../components/MissionStatusBadge.js";
import type { SliceListEntry, ProofReadiness } from "../hooks/useSlices.js";

export type ProjectSliceRow = {
  readiness?: ProofReadiness;
  name: string;
  displayName: string;
  status: string;
  rawStatus: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
  missionId?: string | null;
  railItem?: string | null;
};

export type ProjectMissionBucket = "current" | "archive";

export type ProjectMissionGroup = {
  id: string;
  label: string;
  status: MissionStatus;
  /** VM-005：实际渲染的文字——作者撰写的任务按作者原文逐字渲染；派生任务渲染枚举词。
   *  通过 reconcileMissionStatus 建组的消费方会从 `label` 写入此值。 */
  statusLabel?: string;
  /** VM-005：`status` 来自作者撰写的 frontmatter 还是派生汇总——
   *  projectMissionBucket 的 FR-4 shipped-family 测试会读取它。 */
  statusSource?: MissionStatusSource;
  slices: ProjectSliceRow[];
};

export const PROJECT_CURRENT_ACTIVITY_WINDOW_MS = 36 * 60 * 60 * 1000;

/** proof readiness 机器枚举的展示映射；未知扩展值原样保留。 */
export function proofReadinessLabel(state: string): string {
  switch (state) {
    case "ready": return "已就绪";
    case "not-ready": return "未就绪";
    case "unknown": return "未知";
    case "legacy": return "旧版";
    default: return state;
  }
}

export function projectSliceFromListEntry(slice: SliceListEntry): ProjectSliceRow {
  return {
    name: slice.name,
    displayName: slice.displayName,
    readiness: slice.readiness,
    status: slice.readiness?.configured ? `校验 ${proofReadinessLabel(slice.readiness.state)}` : slice.status,
    rawStatus: slice.rawStatus,
    qitemCount: slice.qitemCount,
    hasProofPacket: slice.hasProofPacket,
    lastActivityAt: slice.lastActivityAt,
    missionId: slice.missionId,
    railItem: slice.railItem,
  };
}

export function isRecentProjectActivity(
  lastActivityAt: string | null,
  now = Date.now(),
): boolean {
  if (!lastActivityAt) return false;
  const ts = Date.parse(lastActivityAt);
  if (Number.isNaN(ts)) return false;
  return now - ts <= PROJECT_CURRENT_ACTIVITY_WINDOW_MS;
}

export function isCurrentProjectSlice(slice: ProjectSliceRow, now = Date.now()): boolean {
  if (slice.readiness?.configured) return true;
  if (slice.qitemCount > 0) return true;
  if (slice.status === "blocked") return true;
  if (slice.status === "active" || slice.status === "draft") {
    return !slice.lastActivityAt || isRecentProjectActivity(slice.lastActivityAt, now);
  }
  return false;
}

// VM-005（release-0.4.7）——统一的任务状态收口处。
// 此前任务状态有四种互不相干的回答方式（作者撰写的 README frontmatter · 本文件的汇总 ·
// bucket 测试 · PROGRESS.md 的实时覆盖），且没有优先级规则；汇总还把它的分类空缺标记为
// UNKNOWN——一个会随墙上时钟衰减的状态。reconcileMissionStatus 是所有 chip 界面共同
// 消费的唯一答案：作者撰写存在时以其为准（且绝不参考 slices 或时钟——结构上杜绝衰减）；
// 派生阶梯只服务于没有作者状态的任务，且每条路径都给出一个已知状态。

export type MissionStatusSource = "authored" | "derived";

export interface ReconciledMissionStatus {
  state: MissionStatus;
  /** 实际渲染的文字。有作者撰写 → 逐字采用作者原文（chip 色调见 AUTHORED_WORD_TONES）；
   *  派生 → 枚举词。 */
  label: string;
  source: MissionStatusSource;
}

const DERIVED_MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  shipped: "已发布",
  blocked: "已阻塞",
  idle: "空闲",
  empty: "空",
  draft: "草稿",
};

/** PIN Q3-P1（架构，VM-005）：作者词→色调的归一器是唯一导出的封闭常量——
 *  新增一个词只需加一条映射，绝不新增逻辑。未识别的词给中性色调（"idle"，仅作色调载体），
 *  且作者原文仍优先并逐字渲染。 */
export const AUTHORED_WORD_TONES: Record<string, MissionStatus> = {
  complete: "shipped",
  completed: "shipped",
  done: "shipped",
  shipped: "shipped",
  active: "active",
  "in-progress": "active",
  in_progress: "active",
  "in-flight": "active",
  wip: "active",
  paused: "paused",
  "on-hold": "paused",
  on_hold: "paused",
  blocked: "blocked",
  stalled: "blocked",
  draft: "draft",
  idle: "idle",
};

function normalizeAuthored(authored: string): { state: MissionStatus; label: string } {
  const word = authored.trim();
  const state = AUTHORED_WORD_TONES[word.toLowerCase()] ?? "idle";
  return { state, label: word };
}

/** 收口后的任务状态。`now` 由外部注入（内部绝不自行读取），
 *  使派生的“近期”窗口可测，且作者路径在结构上与时钟无关。 */
export function reconcileMissionStatus(
  authored: string | null,
  slices: ProjectSliceRow[],
  now = Date.now(),
  readiness?: ProofReadiness,
): ReconciledMissionStatus {
  if (readiness && slices.some(s => s.readiness?.configured)) {
    const declared = readiness.historicalStatus ?? authored;
    return { state: declared ? normalizeAuthored(declared).state : "active", label: `${declared ? `声明 ${declared} · ` : ""}校验 ${proofReadinessLabel(readiness.state)}`, source: declared ? "authored" : "derived" };
  }
  if (authored !== null && authored.trim().length > 0) {
    const { state, label } = normalizeAuthored(authored);
    return { state, label, source: "authored" };
  }
  const state = deriveMissionStatusFromSlices(slices, now);
  return { state, label: DERIVED_MISSION_STATUS_LABEL[state], source: "derived" };
}

/** 派生阶梯（仅作兜底；pm 认可的词汇：empty · blocked · draft · active · shipped · idle
 *  ——没有任何路径返回已废弃的 UNKNOWN 词：这里的每个输入都是完全已知的）。内部使用；
 *  chip 消费方一律走 reconcileMissionStatus。 */
function deriveMissionStatusFromSlices(slices: ProjectSliceRow[], now: number): MissionStatus {
  if (slices.length === 0) return "empty";
  if (slices.some((s) => s.status === "blocked" && isCurrentProjectSlice(s, now))) {
    return "blocked";
  }
  // Q2（VM-005）：一个全是草稿的任务诚实地应标为 "draft"，而非 "active"——
  // 新建脚手架 mtime 很新，否则会被读成“进行中”。顺序排在 blocked 之后、
  // “有当前 slice”判断之前。
  if (slices.every((s) => s.status === "draft")) return "draft";
  if (slices.some((s) => isCurrentProjectSlice(s, now))) return "active";
  if (slices.every((s) => s.status === "done")) return "shipped";
  return "idle";
}

export function projectMissionBucket(
  mission: ProjectMissionGroup,
  now = Date.now(),
): ProjectMissionBucket {
  // VM-005 FR-4：作者撰写的 shipped 家族状态一律归入 archive，不看 slice 的近期性
  // （normalizeAuthored 把 complete/completed/done/shipped → "shipped"，
  // 所以 source+state 恰好就是 shipped-family 的判定）。
  if (mission.statusSource === "authored" && mission.status === "shipped") return "archive";
  // `now` 一路透传给 isCurrentProjectSlice（不使用它 Date.now() 的默认值），
  // 使“近期”分组在注入时钟下是确定性的——固定时间戳的夹具不应随墙上时钟越过 36 小时
  // 活动窗口而变质到另一个分组。
  if (mission.slices.some((s) => isCurrentProjectSlice(s, now))) return "current";
  if (mission.slices.length === 0 && mission.status !== "shipped") return "current";
  return "archive";
}

export function latestProjectMissionActivity(mission: ProjectMissionGroup): number {
  return mission.slices.reduce((latest, slice) => {
    if (!slice.lastActivityAt) return latest;
    const ts = Date.parse(slice.lastActivityAt);
    if (Number.isNaN(ts)) return latest;
    return Math.max(latest, ts);
  }, 0);
}

export function sortProjectMissions(
  a: ProjectMissionGroup,
  b: ProjectMissionGroup,
): number {
  const activityDelta = latestProjectMissionActivity(b) - latestProjectMissionActivity(a);
  if (activityDelta !== 0) return activityDelta;
  return a.label.localeCompare(b.label);
}

export function partitionProjectMissions<T extends ProjectMissionGroup>(
  missions: T[],
  now = Date.now(),
): { current: T[]; archive: T[] } {
  const current: T[] = [];
  const archive: T[] = [];
  for (const mission of missions) {
    if (projectMissionBucket(mission, now) === "current") current.push(mission);
    else archive.push(mission);
  }
  return {
    current: current.sort(sortProjectMissions),
    archive: archive.sort(sortProjectMissions),
  };
}

export function projectSliceMeta(slice: ProjectSliceRow): string {
  const parts: string[] = [];
  if (slice.qitemCount > 0) {
    parts.push(`${slice.qitemCount} 个队列项`);
  }
  const visibleStatus = ({
    active: "进行中",
    done: "已完成",
    blocked: "已阻塞",
    draft: "草稿",
  } as Record<string, string>)[slice.status] ?? slice.status;
  const visibleRawStatus = ({
    active: "进行中",
    building: "构建中",
    done: "已完成",
    merged: "已合并",
    review: "评审中",
    scoped: "已框定",
  } as Record<string, string>)[slice.rawStatus ?? ""] ?? slice.rawStatus;
  const staticStatus =
    (slice.status === "active" || slice.status === "draft") && !isCurrentProjectSlice(slice)
      ? `已停滞 · ${visibleStatus}`
      : visibleStatus;
  if (slice.rawStatus && slice.rawStatus !== slice.status) {
    parts.push(`${staticStatus}（来自 ${visibleRawStatus}）`);
  } else {
    parts.push(staticStatus);
  }
  if (slice.hasProofPacket) parts.push("校验包");
  return parts.join(" · ");
}
