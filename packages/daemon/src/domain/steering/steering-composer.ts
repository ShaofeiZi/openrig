// Operator Surface Reconciliation v0——指导信息组合器。
//
// 条目 1（HEADLINE）：单屏组合指导界面。后台服务侧组合器读取四个文件系统来源，并返回
// 由 UI 在 priority-stack / roadmap-rail / lane-rails 面板中渲染的载荷。
//
// 为什么只做此组合器，而不在后台服务中完整编排 Mission Control、agentActivity 等全部内容：
// 指导 UI 通过各自既有端点获取 PL-005 队列视图（in-motion / loop-state）和健康摘要，
// 因此组合器保持精简且可测试，只负责从文件系统派生的部分：
//   - STEERING.md 优先级栈（上游逐字渲染）
//   - roadmap PROGRESS.md（PL-XXX 检查列表 + 下一个未勾选标记）
//   - delivery-ready/mode-{0..3}/PROGRESS.md（每泳道 Top-N + 健康标记 + 按 Priority Rail
//     Rule 语义确定的 next-pull 标记）
//
// 配置：沿用 UI Enhancement Pack v0 的环境变量转向模式（ConfigStore 严格的 VALID_KEYS
// 难以容纳动态键族），指导组合器从 OPENRIG_STEERING_WORKSPACE 读取单一工作区根目录。
// 其他路径都相对于该根目录派生：STEERING.md、roadmap/PROGRESS.md、
// delivery-ready/mode-*/PROGRESS.md。非标准布局可由操作者通过 OPENRIG_STEERING_PATH /
// OPENRIG_ROADMAP_PATH / OPENRIG_DELIVERY_READY_DIR 覆盖。为空或未设置时，
// composer.isReady() = false，路由返回 503 和结构化配置提示。

import * as fs from "node:fs";
import * as path from "node:path";
import { ProgressIndexer, type ProgressFileNode, type ProgressRow } from "../progress/progress-indexer.js";

export interface SteeringComposerOpts {
  /** 工作区根目录，例如 openrig-work substrate 目录。可选的逐项覆盖（steeringPath /
   * roadmapPath / deliveryReadyDir）优先于从工作区根目录派生的默认路径。 */
  workspaceRoot: string | null;
  steeringPath?: string | null;
  roadmapPath?: string | null;
  deliveryReadyDir?: string | null;
  /** 每个泳道展示的 Top-N 条目数，默认 3（PRD § 条目 1D）。 */
  topNPerLane?: number;
}

export interface PriorityStackPayload {
  /** STEERING.md 原文。UI 通过 v0 MarkdownViewer 渲染，以保持与文件浏览器一致。 */
  content: string;
  absolutePath: string;
  mtime: string;
  byteCount: number;
}

export interface RoadmapRailItem {
  line: number;
  text: string;
  done: boolean;
  /** 检测到的 PL-XXX 轨道条目编码（存在时，例如 "PL-019"）。 */
  railItemCode: string | null;
  /** 对轨道上第一个未勾选条目为 true；UI 会进行视觉标记。 */
  isNextUnchecked: boolean;
}

export interface RoadmapRailPayload {
  absolutePath: string;
  mtime: string;
  items: RoadmapRailItem[];
  /** 供标题显示的复选框总数、已完成数和下一个未勾选行号。 */
  counts: { total: number; done: number; nextUncheckedLine: number | null };
}

export interface LaneRailItem {
  line: number;
  text: string;
  status: "active" | "done" | "blocked" | "unknown";
  /** 按 Priority Rail Rule，当它是泳道的 next pull 时为 true：即第一个非 done、非 blocked
   * 的复选框行。 */
  isNextPull: boolean;
}

export interface LaneRailPayload {
  /** "mode-0" / "mode-1" 等，由文件父目录派生。 */
  laneId: string;
  absolutePath: string;
  mtime: string;
  /** 指导面板显示的 Top-N 条目；active/blocked 优先，done 只用于填充剩余名额。 */
  topItems: LaneRailItem[];
  /** 文件全部行的泳道健康状态汇总计数。 */
  healthBadges: { active: number; blocked: number; done: number; total: number };
  /** 便捷字段：泳道 next-pull 行号；不存在时为 null。 */
  nextPullLine: number | null;
}

export interface SteeringPayload {
  priorityStack: PriorityStackPayload | null;
  roadmapRail: RoadmapRailPayload | null;
  laneRails: LaneRailPayload[];
  /** 界面级诊断信息；单个来源缺失时供 UI 渲染配置提示。每条都会指出可解决问题的环境变量。 */
  unavailableSources: Array<{ section: string; reason: string; envVar?: string }>;
}

const ENV_WORKSPACE = "OPENRIG_STEERING_WORKSPACE";
const ENV_LEGACY_WORKSPACE = "RIGGED_STEERING_WORKSPACE";
const ENV_STEERING_PATH = "OPENRIG_STEERING_PATH";
const ENV_ROADMAP_PATH = "OPENRIG_ROADMAP_PATH";
const ENV_DELIVERY_READY_DIR = "OPENRIG_DELIVERY_READY_DIR";

export function steeringOptsFromEnv(env: NodeJS.ProcessEnv = process.env): SteeringComposerOpts {
  // 使用 || 而不是 ??，使空字符串环境变量继续回退到下一个候选；沿用 UI Enhancement
  // Pack v0 环境变量辅助函数的先例。
  const workspaceRoot = (env[ENV_WORKSPACE] || env[ENV_LEGACY_WORKSPACE] || "").trim() || null;
  return {
    workspaceRoot,
    steeringPath: (env[ENV_STEERING_PATH] || "").trim() || null,
    roadmapPath: (env[ENV_ROADMAP_PATH] || "").trim() || null,
    deliveryReadyDir: (env[ENV_DELIVERY_READY_DIR] || "").trim() || null,
  };
}

export interface SteeringSettingsDefaults {
  workspaceRoot: string;
  workspaceSteeringPath: string;
}

export function steeringOptsFromSettings(
  settings: SteeringSettingsDefaults,
  env: NodeJS.ProcessEnv = process.env,
): SteeringComposerOpts {
  const envOpts = steeringOptsFromEnv(env);
  return {
    workspaceRoot: envOpts.workspaceRoot ?? settings.workspaceRoot,
    steeringPath: envOpts.steeringPath ?? settings.workspaceSteeringPath,
    roadmapPath: envOpts.roadmapPath ?? null,
    deliveryReadyDir: envOpts.deliveryReadyDir ?? null,
  };
}

export class SteeringComposer {
  private readonly opts: Required<Omit<SteeringComposerOpts, "workspaceRoot">> & { workspaceRoot: string | null };

  constructor(opts: SteeringComposerOpts) {
    this.opts = {
      workspaceRoot: opts.workspaceRoot,
      steeringPath: opts.steeringPath ?? null,
      roadmapPath: opts.roadmapPath ?? null,
      deliveryReadyDir: opts.deliveryReadyDir ?? null,
      topNPerLane: opts.topNPerLane ?? 3,
    };
  }

  /** 至少一个来源可解析时为 true。路由据此选择返回 200（unavailableSources 可能非空）
   * 还是 503（完全没有来源）。 */
  isReady(): boolean {
    return Boolean(
      this.resolveSteeringPath() ||
      this.resolveRoadmapPath() ||
      this.resolveDeliveryReadyDir(),
    );
  }

  compose(): SteeringPayload {
    const unavailableSources: SteeringPayload["unavailableSources"] = [];
    const priorityStack = this.composePriorityStack(unavailableSources);
    const roadmapRail = this.composeRoadmapRail(unavailableSources);
    const laneRails = this.composeLaneRails(unavailableSources);
    return { priorityStack, roadmapRail, laneRails, unavailableSources };
  }

  // --- 各分区组合器 ---

  private composePriorityStack(unavailableSources: SteeringPayload["unavailableSources"]): PriorityStackPayload | null {
    const p = this.resolveSteeringPath();
    if (!p) {
      unavailableSources.push({ section: "priorityStack", reason: "未配置 STEERING.md 路径", envVar: ENV_STEERING_PATH });
      return null;
    }
    try {
      const content = fs.readFileSync(p, "utf-8");
      const stat = fs.statSync(p);
      return {
        content,
        absolutePath: p,
        mtime: stat.mtime.toISOString(),
        byteCount: stat.size,
      };
    } catch (err) {
      unavailableSources.push({
        section: "priorityStack",
        reason: `读取 STEERING.md 失败：${err instanceof Error ? err.message : String(err)}`,
        envVar: ENV_STEERING_PATH,
      });
      return null;
    }
  }

  private composeRoadmapRail(unavailableSources: SteeringPayload["unavailableSources"]): RoadmapRailPayload | null {
    const p = this.resolveRoadmapPath();
    if (!p) {
      unavailableSources.push({ section: "roadmapRail", reason: "未配置 roadmap PROGRESS.md 路径", envVar: ENV_ROADMAP_PATH });
      return null;
    }
    let content: string;
    let mtime: Date;
    try {
      content = fs.readFileSync(p, "utf-8");
      mtime = fs.statSync(p).mtime;
    } catch (err) {
      unavailableSources.push({
        section: "roadmapRail",
        reason: `读取 roadmap PROGRESS.md 失败：${err instanceof Error ? err.message : String(err)}`,
        envVar: ENV_ROADMAP_PATH,
      });
      return null;
    }
    const items: RoadmapRailItem[] = [];
    let nextUncheckedSet = false;
    let nextUncheckedLine: number | null = null;
    let total = 0;
    let done = 0;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*(?:[-*]\s+)?\[([ xX])\]\s+(.+)$/);
      if (!m) continue;
      const isDone = m[1]!.toLowerCase() === "x";
      const text = m[2]!.trim();
      total++;
      if (isDone) done++;
      const railCode = matchRailItemCode(text);
      const isNextUnchecked = !isDone && !nextUncheckedSet;
      if (isNextUnchecked) {
        nextUncheckedSet = true;
        nextUncheckedLine = i + 1;
      }
      items.push({
        line: i + 1,
        text,
        done: isDone,
        railItemCode: railCode,
        isNextUnchecked,
      });
    }
    return {
      absolutePath: p,
      mtime: mtime.toISOString(),
      items,
      counts: { total, done, nextUncheckedLine },
    };
  }

  private composeLaneRails(unavailableSources: SteeringPayload["unavailableSources"]): LaneRailPayload[] {
    const dir = this.resolveDeliveryReadyDir();
    if (!dir) {
      unavailableSources.push({
        section: "laneRails",
        reason: "未配置 delivery-ready 目录",
        envVar: ENV_DELIVERY_READY_DIR,
      });
      return [];
    }
    // 使用既有 ProgressIndexer 解析 mode-{0..3}/PROGRESS.md。它与 UI Enhancement Pack v0
    // /progress 视图采用相同复选框状态语义，使指导视图与操作者在 Progress 工作区看到的内容一致。
    const indexer = new ProgressIndexer({
      roots: [{ name: "delivery-ready", canonicalPath: dir }],
      maxDepth: 3,
    });
    const result = indexer.scan();
    const lanes: LaneRailPayload[] = [];
    for (const file of result.files) {
      // 从 "mode-N/PROGRESS.md" 派生 laneId，否则回退到 relPath。
      const m = file.relPath.match(/^(mode-\d+)\/PROGRESS\.md$/);
      const laneId = m ? m[1]! : file.relPath.replace(/\/?PROGRESS\.md$/i, "") || file.relPath;
      lanes.push(this.composeLaneFromFile(laneId, file));
    }
    lanes.sort((a, b) => a.laneId.localeCompare(b.laneId));
    return lanes;
  }

  private composeLaneFromFile(laneId: string, file: ProgressFileNode): LaneRailPayload {
    const checkboxRows = file.rows.filter((r) => r.kind === "checkbox");
    // Priority Rail Rule 的 next pull：泳道上第一个非 done、非 blocked 的复选框行。根据 PRD
    // 引用的 workstream-continuity 约定，shelf/queue 新近程度不能覆盖此规则；首个就绪项优先。
    const nextPullIdx = checkboxRows.findIndex((r) => r.status !== "done" && r.status !== "blocked");
    const nextPullLine = nextPullIdx >= 0 ? (checkboxRows[nextPullIdx]?.line ?? null) : null;
    // Top-N：优先 active + blocked 行；只有非 done 行不足 N 条时才用 done 补齐。健康泳道
    // 很少发生，已关闭泳道较常见。
    const N = this.opts.topNPerLane;
    const nonDoneRows = checkboxRows.filter((r) => r.status !== "done");
    const doneRows = checkboxRows.filter((r) => r.status === "done");
    const orderedSelection = [...nonDoneRows, ...doneRows].slice(0, N);
    const topItems: LaneRailItem[] = orderedSelection.map((r: ProgressRow) => ({
      line: r.line,
      text: r.text,
      status: r.status as LaneRailItem["status"],
      isNextPull: r.line === nextPullLine,
    }));
    return {
      laneId,
      absolutePath: file.absolutePath,
      mtime: file.mtime,
      topItems,
      healthBadges: {
        active: file.counts.active,
        blocked: file.counts.blocked,
        done: file.counts.done,
        total: file.counts.total,
      },
      nextPullLine,
    };
  }

  // --- 路径解析器 ---

  private resolveSteeringPath(): string | null {
    if (this.opts.steeringPath) return this.opts.steeringPath;
    if (!this.opts.workspaceRoot) return null;
    const candidate = path.join(this.opts.workspaceRoot, "STEERING.md");
    return fs.existsSync(candidate) ? candidate : null;
  }

  private resolveRoadmapPath(): string | null {
    if (this.opts.roadmapPath) return this.opts.roadmapPath;
    if (!this.opts.workspaceRoot) return null;
    const candidate = path.join(this.opts.workspaceRoot, "roadmap", "PROGRESS.md");
    return fs.existsSync(candidate) ? candidate : null;
  }

  private resolveDeliveryReadyDir(): string | null {
    if (this.opts.deliveryReadyDir) return this.opts.deliveryReadyDir;
    if (!this.opts.workspaceRoot) return null;
    const candidate = path.join(this.opts.workspaceRoot, "delivery-ready");
    try {
      const st = fs.statSync(candidate);
      if (st.isDirectory()) return candidate;
    } catch { /* 继续回退。 */ }
    return null;
  }
}

const RAIL_CODE_REGEX = /\b(PL-\d{2,4})\b/;

export function matchRailItemCode(text: string): string | null {
  const m = text.match(RAIL_CODE_REGEX);
  return m ? m[1]! : null;
}
