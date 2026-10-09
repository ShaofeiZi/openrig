// release-0.3.2 slice 12 —— scope CLI 原语类型。
//
// 与 `openrig-work/conventions/scope-and-versioning/README.md` 中的底层约定对齐
// （stage：provisional，撰写于 2026-05-15）。CLI 按该约定 §1
// 为新建的 mission/slice frontmatter 生成稳定的 dot-ID。

/** 范围层级。v0 提供 `mission` + `slice`；`project` 与 `sub-slice`
 *  已存在于语法中，但暂无 CLI 动词。 */
export type ScopeTier = "project" | "mission" | "slice" | "sub-slice";

/** 稳定引用 ID 的组成部分。`OPR.0.3.2.12` → project="OPR"、
 *  version="0.3.2"、n=12。逃逸带的非发布任务形如
 *  `OPR.99.0.1` → version="99.0.1"、n=undefined。 */
export interface DotId {
  project: string;       // 2-3 个字母的项目前缀
  version: string;      // semver 形态（发布）或逃逸带（99.x.y）
  n?: number;           // slice 序号
  m?: number;           // sub-slice 序号
}

export interface MissionInfo {
  /** 任务目录名（例如 "release-0.3.2"、"backlog"）。 */
  name: string;
  /** 任务目录的绝对路径。 */
  absPath: string;
  /** 任务 README.md 的路径（若存在）。 */
  readmePath: string | null;
  /** 从 README 解析出的 frontmatter。 */
  frontmatter: Record<string, unknown>;
  /** 为本任务生成的 dot-ID（若 frontmatter 中有则读取，
   *  否则按目录名模式推断）。 */
  id: string | null;
  activeSliceCount: number;
  closedSliceCount: number;
}

export interface SliceInfo {
  name: string;          // 形如 "12-rig-slice-cli-primitive" 的目录名
  absPath: string;
  readmePath: string | null;
  frontmatter: Record<string, unknown>;
  /** "NN-slug" → NN。 */
  nn: number | null;
  /** "NN-slug" → slug。 */
  slug: string | null;
  missionName: string;
  /** 生成的 dot-ID，parent.NN 形式。 */
  id: string | null;
  /** frontmatter 的 `status` 字段，已转小写。 */
  status: string | null;
}

/** 按 `building-agent-software` 技能 §3.6 的三段式错误结构。 */
export class ScopeCliError extends Error {
  readonly fact: string;
  readonly consequence: string;
  readonly action: string;
  constructor(opts: { fact: string; consequence: string; action: string }) {
    super(`${opts.fact}\n${opts.consequence}\n${opts.action}`);
    this.name = "ScopeCliError";
    this.fact = opts.fact;
    this.consequence = opts.consequence;
    this.action = opts.action;
  }
}

export type SliceState = "active" | "closed" | "shipped" | "all";
export type SliceTemplateKind =
  | "placeholder"
  | "bug-fix"
  | "backlog-deprecation"
  | "backlog-tech-debt"
  | "release-feature"
  | "research";
export const SLICE_TEMPLATE_KINDS: ReadonlyArray<SliceTemplateKind> = [
  "placeholder",
  "bug-fix",
  "backlog-deprecation",
  "backlog-tech-debt",
  "release-feature",
  "research",
];

export type MissionTemplateKind = "placeholder" | "release";
export const MISSION_TEMPLATE_KINDS: ReadonlyArray<MissionTemplateKind> = [
  "placeholder",
  "release",
];

export type CloseReason = "wontfix" | "deferred" | "superseded" | "stale";
export const CLOSE_REASONS: ReadonlyArray<CloseReason> = [
  "wontfix",
  "deferred",
  "superseded",
  "stale",
];

/** OPR.0.4.1.6 —— scope-and-versioning §2 认知成熟度 `stage` 枚举
 *  （4 个等级 + 2 个出口）。这是唯一合法的 stage 取值；
 *  杜撰值（shape/shaped/draft）会被拒绝。`superseded` 必须指名其后继；
 *  `retired` 表示“勿用”。 */
export type Stage =
  | "wip"
  | "provisional"
  | "established"
  | "canonical"
  | "superseded"
  | "retired";
export const STAGE_VALUES: ReadonlyArray<Stage> = [
  "wip",
  "provisional",
  "established",
  "canonical",
  "superseded",
  "retired",
];
