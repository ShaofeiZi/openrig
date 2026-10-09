// Living Notes Packet 2——MISSION_BRIEF status spine 收敛（OPR.0.4.4.20 FR-8）。
//
// 唯一计算路径：spine section（Building / Progress / Proven / Needs you）在此从已组合 mission review
// 渲染；tab 始终以 fresh 方式提供（纯 projection、零写入），完全相同的字符串只会在有意 freeze 时刻
// 写入 MISSION_BRIEF.md——绝不使用 watcher 或 continuous writer。Generation 以 section 为 scope：
// 非 spine section（"What & why"、"Pointers"）中的手写 prose 字节不变，并且按构造保留 scope
// audit 强制的准确顺序 H2 schema（header list 从 audit import，而非重新声明）。

import { MISSION_BRIEF_HEADERS } from "../scope/scope-audit.js";
import type { ComposedMissionReview } from "./types.js";

export interface BriefSpine {
  building: string;
  progress: string;
  proven: string;
  needsYou: string;
}

/** 四个生成的 section body——从 FR-7 渲染所用的相同 composer query 派生（无第二条计算路径）。 */
export function renderBriefSpine(m: ComposedMissionReview): BriefSpine {
  const byLane = (lane: string) => m.board.filter((b) => b.laneLabel === lane);
  const buildingRows = [...byLane("BUILD"), ...byLane("PLAN")];
  const building =
    buildingRows.length === 0
      ? "_没有正在进行的工作。_"
      : buildingRows.map((b) => `- ${b.slice} — ${b.laneLabel} · ${b.stageCell}`).join("\n");

  const progress =
    m.board.length === 0
      ? "_尚无 slice。_"
      : ["INTENT", "PLAN", "BUILD", "REVIEW", "LOCKED"]
          .map((lane) => `- ${lane}: ${byLane(lane).length}`)
          .join("\n");

  const greenRows = m.ledger.filter((r) => r.green);
  const proven =
    greenRows.length === 0
      ? "_尚无已证明内容。_"
      : greenRows
          .map((r) => `- ${r.slice} — 在 ${r.candidateSha ?? "unknown"} 证明 · 已合并 ${r.mergeSha ?? "UNMERGED"}`)
          .join("\n") + `\n\nCut gate：${m.cutComplete ? "COMPLETE" : "incomplete"}——${m.cutCompleteBasis}`;

  const needsYou =
    m.needsYou.items.length === 0
      ? `_${m.needsYou.provenance}_`
      : m.needsYou.items.map((i) => `- ${i.source === "derived" ? "▲" : "●"} ${i.summary} (${i.leg})`).join("\n");

  return { building, progress, proven, needsYou };
}

const SPINE_BY_HEADER: Record<string, keyof BriefSpine> = {
  Building: "building",
  Progress: "progress",
  Proven: "proven",
  "Needs you": "needsYou",
};

/**
 * section-scoped 应用：只替换已有 MISSION_BRIEF.md 中四个 spine section body，保留其他每个字节
 *（手写 "What & why"/"Pointers"、H1、frontmatter、顺序）。brief 不含已 pin schema 时返回 null
 *（绝不猜测并重写 malformed brief——该 finding 归 audit 所有）。
 */
export function applyBriefSpine(briefContent: string, spine: BriefSpine): string | null {
  const lines = briefContent.split("\n");
  // 定位每个已 pin H2（准确顺序 schema）。
  const headerIdx: number[] = [];
  const headerName: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^##\s+(.+?)\s*$/);
    if (m) {
      headerIdx.push(i);
      headerName.push(m[1]!);
    }
  }
  // brief 必须携带准确的已 pin sequence，才能保证 generation 安全。
  if (headerName.length !== MISSION_BRIEF_HEADERS.length) return null;
  for (let i = 0; i < MISSION_BRIEF_HEADERS.length; i++) {
    if (headerName[i] !== MISSION_BRIEF_HEADERS[i]) return null;
  }

  const out: string[] = [];
  out.push(...lines.slice(0, headerIdx[0]!));
  for (let h = 0; h < headerIdx.length; h++) {
    const start = headerIdx[h]!;
    const end = h + 1 < headerIdx.length ? headerIdx[h + 1]! : lines.length;
    const name = headerName[h]!;
    const spineKey = SPINE_BY_HEADER[name];
    out.push(lines[start]!);
    if (spineKey) {
      out.push("", spine[spineKey], "");
    } else {
      out.push(...lines.slice(start + 1, end));
    }
  }
  return out.join("\n");
}
