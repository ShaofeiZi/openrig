// OPR.0.4.7 slice-04 阶段 3 杠杆 A——plan-lock 快照推导。
//
// 从 slice 当前作者节点与旧版回退内容中纯推导 `locked-artifacts` 计划集合，此处不访问 fs。
// 直接复用已导出的 Review 辅助函数（D1——不做共享抽取），使派生计划与 Review 的
// 来源选择/抽取逻辑保持一致（不声称字节相等）。确定性规则：稳定顺序
//（作者节点 → 选中的 proof-contract plannedRefs → intent visuals）、规范化路径去重、先到来源优先。

import type { LockedArtifact } from "../review/types.js";
import {
  extractProofContractSelected,
  extractSection,
  extractMediaRefs,
  sliceRelativeMediaPath,
} from "../review/compose.js";
import { isScaffoldPlaceholderText } from "./scaffold-placeholder.js";

/**
 * 为 slice plan-lock 推导有序且去重的 `locked-artifacts` 集合。
 * @param nodeContent 当前作者节点内容（SPEC.md 或旧版 README.md）。
 * @param prd 旧版 IMPLEMENTATION-PRD 内容；不存在时为 null。
 * @param nodeFileName 当前节点文件名；新工作使用 SPEC.md。
 */
export function derivePlanLockArtifacts(
  nodeContent: string | null,
  prd: string | null,
  nodeFileName: "SPEC.md" | "README.md" = "SPEC.md",
): LockedArtifact[] {
  const out: LockedArtifact[] = [];
  const seen = new Set<string>(); // 按规范化路径去重；先到来源优先。

  // slice 相对路径 + POSIX 规范化：拒绝绝对 `/…` 与 `../` 越界，并把
  // `mockups/./d.png` 和 `mockups/d.png` 合并为一项（先到者优先）。
  // nameFromPath：D4——intent visual 条目的名称采用实际输出的规范化路径，
  // 因而不会携带规范化前的原始 ref（例如 `mockups/./x.png`）。
  const add = (name: string, ref: string, kind: string, nameFromPath = false): void => {
    // 在规范化前拒绝任何 URI scheme ref（http/https/data/...）：所有 locked-artifact
    // 路径都必须相对于 slice。extractMediaRefs 会过滤 intent ref 的 HTTP 地址，
    // 但 proof-contract plannedRefs 不会，因此在此统一强制。
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return; // RFC-3986 scheme 语法。
    const norm = sliceRelativeMediaPath(ref, "");
    if (norm === null) return; // 绝对路径或越界路径绝不能成为 locked artifact。
    if (seen.has(norm)) return; // 先到来源优先。
    seen.add(norm);
    out.push({ name: nameFromPath ? norm : name, path: norm, kind });
  };

  // 1. 唯一作者节点始终是第一个固定项。新工作使用 SPEC.md；旧版 README 支撑的节点
  // 无需强制迁移，仍可批准。
  add(nodeFileName === "SPEC.md" ? "规格" : "旧版规格", nodeFileName, "spec");

  // 2. 选中的 proof-contract plannedRefs——对于旧节点，作者编写的 README 章节优先于
  //    未改动脚手架中的 PRD 章节。
  const selected = nodeFileName === "SPEC.md"
    ? extractProofContractSelected(prd, null, nodeContent)
    : extractProofContractSelected(prd, nodeContent, null);
  for (const item of selected.items) {
    if (!item.plannedRef) continue;
    add(item.text || item.plannedRef, item.plannedRef, "mockup"); // 名称取条目文本，路径作回退。
  }

  // 3. Intent visual——作者节点 `## Intent visual` 中的媒体 ref；若章节为 N/A，
  //    则按 scope 审计采用的章节抑制语义跳过。
  const visual = extractSection(nodeContent, "Intent visual");
  if (visual !== null && !/\bN\/A\b/i.test(visual)) {
    for (const ref of extractMediaRefs(visual)) {
      add(ref, ref, "mockup", true); // 确定性名称 = 实际输出的规范化路径（D4）。
    }
  }

  return out;
}

/**
 * 当派生 plan-lock 集合不会冻结任何人工编写内容时返回 true：集合只有无条件节点固定项，
 * 且节点文件缺失或仍是已发布模板脚手架（没有作者 intent 散文、mini-req 或
 * proof-contract 行——唯一脚手架语法）。
 *
 * plan-lock 的全部含义是“将构建的就是这一组产物”；若允许默认值固定占位内容，
 * 就会用无人选择的内容写下 SDLC 中最强的结构声明。此检查出现前已有两个真实 lock
 * 这样做过。除非盖章者显式命名集合，否则批准流程会按此谓词拒绝。
 */
export function isContentlessPlanLockSet(nodeContent: string | null, artifacts: LockedArtifact[]): boolean {
  if (artifacts.length > 1) return false; // plannedRefs / intent visuals 表示固定项之外已有选定内容。
  if (nodeContent === null) return true;
  return !prdHasAuthoredContent(nodeContent);
}

/** 去除 frontmatter、HTML 注释、标题及列表/复选框标记后仍存在，且不符合已发布方括号占位语法的
 *  任意行都属于作者内容——自由散文形式的 PRD 也计入；只有未改动脚手架和空内容不计入。 */
function prdHasAuthoredContent(prd: string): boolean {
  const body = prd
    .replace(/^---\n[\s\S]*?\n---\n?/, "") // frontmatter。
    .replace(/<!--[\s\S]*?-->/g, ""); // 脚手架指导注释。
  for (const rawLine of body.split("\n")) {
    let line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^#{1,6}\s/.test(line)) continue; // 标题属于模板结构。
    line = line.replace(/^(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""); // 列表/复选框标记。
    if (line.length === 0) continue;
    if (isScaffoldPlaceholderText(line)) continue;
    return true;
  }
  return false;
}
