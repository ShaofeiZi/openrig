/**
 * OPR.0.5.8.14——根据席位持有的队列行推导其当前工作节点。
 *
 * 目前唯一消费者是 `queue whoami`，它会重新聚焦读取，使返回的智能体获得自己实际负责的
 * 任务目标与 slice 意图。推导过程有意坚持“拒绝优先”：只有席位的类型化行恰好指向一个
 * 工作节点时才给出答案。其他情况都返回 null 并附具名依据，因为猜测工作节点比诚实暴露
 * 缺口更糟——它会把整个重新聚焦静默指向错误结果。
 *
 * 两项性质是承重约束，且都无法仅从标签本身看出：
 *
 * 1. 规范队列标签是 `mission:<directory>` + `slice:<dot-id>`，例如
 *    `mission:release-0.5.8` + `slice:OPR.0.5.8.14`。所有新移交都使用这一对。
 *    部分历史行改用 SPEC frontmatter ID 标记任务目标，因此任务目标关联也仅为兼容而接受
 *    这种旧形式；拒绝既有行会让“拒绝猜测”错误作用于有效数据。旧形式绝不是应继续采用的
 *    约定，任何展示位置都会标注为兼容形式。（orch-lead 裁定转达于 2026-09-01 09:43Z。）
 *
 * 2. 存在两层歧义检查，并按有意设计的顺序执行。
 *
 *    在单行内部，格式错误的接力棒会在任何解析前先被拒绝：一行携带两个不同 mission 值
 *    （或两个不同 slice 值）根本不是结构良好的接力棒，而拒绝畸形输入正是本模块职责。
 *    这些行绝不会进入解析阶段。
 *
 *    跨行时先解析再计数，并以失败优先。若每个类型化行都解析成功，就按解析后的节点而非
 *    原始标签字符串判断歧义，因此用不同形式命名同一 slice 的两行会折叠为一项工作，
 *    而不是被误判为冲突。但任何类型化行解析失败时都必须拒绝回答——未解析接力棒代表未知，
 *    而非无关；让碰巧解析成功的行决定答案，正是本模块要阻止的猜测。仅在依据字符串中披露
 *    失败也不够，因为消费者读取 workNodePath，而不是旁边的说明文字。
 *
 *    注意，下方“先解析再比较”机制本可判断两种写法指向同一目录。单行检查有意不用它；
 *    这是对有效接力棒定义的选择，而不是能力限制。
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "./slices/slice-indexer.js";

const MISSION_TAG = "mission:";
const SLICE_TAG = "slice:";

type MatchForm = "directory name" | "frontmatter id";

/**
 * 如何向读者描述匹配方式。规范标签对是 `mission:<directory>` + `slice:<dot-id>`；
 * 此处解析的其他形式都只是对已有队列行的兼容，并会明确标注，避免有人把依据字符串误当成
 * 应复制的新约定。
 */
function describeMatch(level: "mission" | "slice", form: MatchForm): string {
  if (level === "mission") {
    return form === "directory name"
      ? "规范目录名标签"
      : "旧版 ID 形式标签（兼容）";
  }
  return form === "frontmatter id"
    ? "规范 ID 标签"
    : "目录名标签（兼容）";
}

export interface CurrentWork {
  mission: string;
  slice: string;
  workNodePath: string;
  basis: string;
}

export interface CurrentWorkDerivation {
  currentWork: CurrentWork | null;
  /** 始终存在，说明答案的依据，包括每一种拒绝原因。 */
  currentWorkBasis: string;
}

interface TaggedRow {
  state?: string | null;
  tags?: string[] | null;
  /** 可选；生产调用点传入完整队列项，因此会填充。拒绝消息若指出出错行，操作员只需一条命令
   *  即可行动；若只列出值，还得自行查找这些值来自哪一行。 */
  qitemId?: string | null;
}

/** 拒绝消息中如何引用队列行；未提供 ID 时使用清晰回退。 */
function rowLabel(qitemId?: string | null): string {
  return qitemId ? `行 ${qitemId}` : "某一行";
}

/**
 * 只考虑 in-progress 行——这是明确裁定，不是疏漏。但拒绝消息必须说明这一点：
 * 若席位唯一的类型化接力棒处于 BLOCKED，它仍持有真实工作；“没有类型化工作”虽符合查询，
 * 却不符合现实。“你未持有任何工作”与“你的工作已停放”需要不同后续动作，因此文案要说明
 * 查询范围，而不能暗示席位空闲。
 */
const NO_TYPED_IN_PROGRESS =
  "没有类型化的 in-progress 工作（只考虑 in-progress 行；处于 pending 或 blocked 的类型化行不算当前工作）";

interface Match {
  dir: string;
  form: MatchForm;
}

/**
 * 单行中 `prefix` 下携带的每个不同非空值。
 *
 * tags 列逐字持久化，上游没有强制每个前缀只能有一个值，因此数组位置没有语义。
 * 取首个匹配会让答案依赖插入顺序；反转数组就会选中不同 slice。改为返回集合后，调用方可
 * 拒绝真正冲突的行。完全重复的字符串会折叠，因为它们只是同一值被写了两次。
 */
function tagValues(tags: string[], prefix: string): string[] {
  const values = tags
    .filter((t) => t.startsWith(prefix))
    .map((t) => t.slice(prefix.length).trim())
    .filter((v) => v.length > 0);
  return [...new Set(values)];
}

/**
 * `root` 直属目录中由 `wanted` 寻址的目录——目录名本身匹配，或其 SPEC.md frontmatter
 * `id` 匹配。一个目录只能匹配一次，因此目录名命中后会短路该目录的 frontmatter 读取。
 */
export function resolveWorkNodeDirs(root: string, wanted: string): Match[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: Match[] = [];
  for (const dir of entries.sort()) {
    if (dir === wanted) {
      out.push({ dir, form: "directory name" });
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, dir, "SPEC.md"), "utf8");
    } catch {
      continue;
    }
    if (parseFrontmatter(raw)["id"] === wanted) out.push({ dir, form: "frontmatter id" });
  }
  return out;
}

interface Candidate {
  mission: string;
  slice: string;
  workNodePath: string;
  basis: string;
}

/** 将一个类型化行解析为工作节点，或返回无法解析的原因。 */
function resolveRow(
  missionsRoot: string,
  mission: string,
  slice: string,
): { ok: true; value: Candidate } | { ok: false; reason: string } {
  const missionMatches = resolveWorkNodeDirs(missionsRoot, mission);
  if (missionMatches.length !== 1) {
    return {
      ok: false,
      reason: `任务目标 ${mission} 解析到 ${missionMatches.length} 个目录`,
    };
  }
  const missionMatch = missionMatches[0]!;

  const slicesRoot = path.join(missionsRoot, missionMatch.dir, "slices");
  const sliceMatches = resolveWorkNodeDirs(slicesRoot, slice);
  if (sliceMatches.length !== 1) {
    return { ok: false, reason: `slice ${slice} 解析到 ${sliceMatches.length} 个目录` };
  }
  const sliceMatch = sliceMatches[0]!;

  return {
    ok: true,
    value: {
      mission,
      slice,
      workNodePath: path.join(slicesRoot, sliceMatch.dir),
      basis:
        `唯一类型化 in-progress 工作节点；任务目标通过${describeMatch("mission", missionMatch.form)}匹配，` +
        `slice 通过${describeMatch("slice", sliceMatch.form)}匹配`,
    },
  };
}

export function deriveCurrentWork(
  rows: TaggedRow[],
  missionsRoot: string | null,
): CurrentWorkDerivation {
  const refuse = (currentWorkBasis: string): CurrentWorkDerivation => ({
    currentWork: null,
    currentWorkBasis,
  });

  if (!missionsRoot) return refuse("未配置任务目标根目录");

  const typed: { mission: string; slice: string; qitemId?: string | null }[] = [];
  const conflicts: string[] = [];
  for (const r of rows) {
    if (r.state !== "in-progress") continue;
    const tags = r.tags ?? [];
    const missions = tagValues(tags, MISSION_TAG);
    const slices = tagValues(tags, SLICE_TAG);
    // 缺少任一前缀的行根本不是类型化接力棒，因此不属于本推导职责，也不会贡献冲突。
    if (missions.length === 0 || slices.length === 0) continue;
    // 消息中的值不仅去重，还会排序：若顺序无关的拒绝使用顺序相关说明，仍会泄漏数组位置。
    if (missions.length > 1) {
      conflicts.push(
        `${rowLabel(r.qitemId)} 携带 ${missions.length} 个不同 mission 标签（${[...missions].sort().join(", ")}）`,
      );
      continue;
    }
    if (slices.length > 1) {
      conflicts.push(
        `${rowLabel(r.qitemId)} 携带 ${slices.length} 个不同 slice 标签（${[...slices].sort().join(", ")}）`,
      );
      continue;
    }
    typed.push({ mission: missions[0]!, slice: slices[0]!, qitemId: r.qitemId });
  }

  // 冲突优先于可用兄弟行，原因与未解析行相同：席位的类型化工作不明确，而明确性是回答的
  // 完整前提。即使两个值最终解析到同一目录也会拒绝。不是模块无法检查——resolveRow 与下方
  // byPath 去重会跨行完成这件事——而是单行以不同方式两次命名其任务目标属于畸形输入，
  // 拒绝畸形输入正是本模块职责。若替它解析，就等于代调用方修复错误行并把修复结果当答案。
  if (conflicts.length > 0) {
    return refuse(`类型化标签冲突：${[...new Set(conflicts)].sort().join("; ")}`);
  }
  if (typed.length === 0) return refuse(NO_TYPED_IN_PROGRESS);

  // 先解析再计数：同一节点的不同标签形式必须折叠为一个节点。
  const byPath = new Map<string, Candidate>();
  const failures: string[] = [];
  for (const { mission, slice, qitemId } of typed) {
    const resolved = resolveRow(missionsRoot, mission, slice);
    if (resolved.ok) {
      if (!byPath.has(resolved.value.workNodePath)) {
        byPath.set(resolved.value.workNodePath, resolved.value);
      }
    } else {
      const reason = `${rowLabel(qitemId)} — ${resolved.reason}`;
      if (!failures.includes(reason)) failures.push(reason);
    }
  }

  // 未解析的类型化行代表未知，绝不是无关。若根据碰巧解析成功的行回答，就等于把
  // “无法判断它是什么”当成“它不计数”——这正是本推导要拒绝的猜测。只在依据中披露仍不够，
  // 因为消费者读取 workNodePath，而不读取旁边说明。因此任一解析失败都直接拒绝；
  // 只有每个类型化行都解析成功时，才会到达下方跨形式去重。
  if (failures.length > 0) {
    return refuse(`类型化工作未能解析：${failures.join("; ")}`);
  }
  if (byPath.size > 1) {
    return refuse(`存在 ${byPath.size} 个不同的类型化工作节点——拒绝猜测`);
  }

  const only = [...byPath.values()][0];
  if (!only) return refuse("没有类型化 in-progress 工作解析到工作节点");
  return { currentWork: only, currentWorkBasis: only.basis };
}
