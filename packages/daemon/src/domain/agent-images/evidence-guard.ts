// 分叉原语 + Starter 智能体镜像 v0（PL-016）——`zrig agent-image prune` / DELETE
// 的 evidence-preservation guard
// /api/agent-images/library/:id.
//
// PRD 第 6 项——若遗漏会造成灾难性反弹。满足以下任一条件时，image 受删除保护：
//
//   - 已 pin（用户通过 `zrig agent-image pin` 放置 `.pinned` sentinel）
//   - 被 active agent.yaml 引用（session_source: mode: agent_image，ref.value: <name>）——
//     跨 discovery root 扫描 spec library file
//   - 被 spec library 中的 rig spec 引用（members[].session_source）
//   - 是另一个受保护 image 的 lineage descendant（沿 chain 传递保护）
//
// guard 会 fail closed。用户可传入 --force 覆盖。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentImageEntry } from "./agent-image-types.js";

export type ProtectionReason =
  | "pinned"
  | "referenced_by_agent_spec"
  | "referenced_by_rig_spec"
  | "lineage_descendant_of_protected";

export interface ImageProtectionStatus {
  imageId: string;
  imageName: string;
  imageVersion: string;
  protected: boolean;
  reasons: ProtectionReason[];
  /** 持有保护性 reference 的具体 filesystem path。 */
  references: string[];
}

export interface EvidenceGuardOpts {
  /** library 中的全部 image（使基于 lineage 的保护无需重新遍历 discovery root 即可遍历 chain）。 */
  images: readonly AgentImageEntry[];
  /** 为查找 active reference 而遍历的 spec-library directory。每个目录都会递归遍历
   *  `*.yaml` / `*.yml` 文件。 */
  specRoots: readonly string[];
}

/**
 * 计算每个 image 的 protection status。结果顺序与 input array 一致；除非提供 --force，
 * `prune` 必须跳过受保护 image set。
 */
export function evaluateProtection(opts: EvidenceGuardOpts): ImageProtectionStatus[] {
  const referencedNames = scanSpecRootsForReferences(opts.specRoots);

  // 第 1 遍：计算直接保护（pinned + referenced）。
  const statuses = new Map<string, ImageProtectionStatus>();
  const protectedNameSet = new Set<string>();
  for (const img of opts.images) {
    const refs = referencedNames.get(img.name) ?? [];
    const reasons: ProtectionReason[] = [];
    if (img.pinned) reasons.push("pinned");
    // 两种 reference 同时出现时，区分 agent.yaml shape 与 rig.yaml shape；scanner 返回 path，
    // 同时存储基于 path 的 tag。v0 简化规则：basename 为 `agent.yaml` 的文件视为 agent-spec，
    // 其他文件视为 rig-spec。
    const seenReason = new Set<ProtectionReason>();
    for (const ref of refs) {
      const reason: ProtectionReason = ref.endsWith("/agent.yaml")
        ? "referenced_by_agent_spec"
        : "referenced_by_rig_spec";
      if (!seenReason.has(reason)) {
        reasons.push(reason);
        seenReason.add(reason);
      }
    }
    const status: ImageProtectionStatus = {
      imageId: img.id,
      imageName: img.name,
      imageVersion: img.version,
      protected: reasons.length > 0,
      reasons,
      references: refs,
    };
    statuses.set(img.name, status);
    if (status.protected) protectedNameSet.add(img.name);
  }

  // 第 2 遍：传递 lineage protection。lineage 中包含受保护 image 的 image 也会受保护。
  // 迭代至 fixed point，使 multi-hop chain 收敛。
  let changed = true;
  while (changed) {
    changed = false;
    for (const img of opts.images) {
      const status = statuses.get(img.name)!;
      if (status.protected) continue;
      // img lineage 列出 ancestor。我们保护受保护 image 的 descendant——也就是说，
      // 若 `img` 的任意 ancestor 受保护，`img` 自身也会通过传递关系受到保护。
      for (const ancestor of img.lineage) {
        if (protectedNameSet.has(ancestor)) {
          status.protected = true;
          status.reasons.push("lineage_descendant_of_protected");
          status.references.push(`lineage-of:${ancestor}`);
          protectedNameSet.add(img.name);
          changed = true;
          break;
        }
      }
    }
  }

  return opts.images.map((img) => statuses.get(img.name)!);
}

/** 遍历 spec-library root 中的 YAML 文件，收集按名称引用任意 agent_image 的文件 path。
 *  匹配是保守的：任何同时包含 `mode: agent_image` directive 与 `value: <name>` field 的 YAML
 *  都视为 reference。允许 false positive（过度保护）；false negative 会导致灾难性数据丢失。 */
function scanSpecRootsForReferences(roots: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walkYaml(root, (absPath) => {
      let raw: string;
      try { raw = readFileSync(absPath, "utf-8"); } catch { return; }
      if (!raw.includes("agent_image")) return;
      let parsed: unknown;
      try { parsed = parseYaml(raw); } catch { return; }
      const refs = collectImageRefs(parsed);
      for (const name of refs) {
        const existing = out.get(name) ?? [];
        existing.push(absPath);
        out.set(name, existing);
      }
    });
  }
  return out;
}

function walkYaml(root: string, visit: (absPath: string) => void): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        try {
          if (statSync(abs).size > 5_000_000) continue; // 跳过可疑的大型 YAML 文件
        } catch {
          continue;
        }
        visit(abs);
      }
    }
  }
}

/** 递归遍历已解析 YAML tree，收集所有
 *  `session_source: { mode: agent_image, ref: { kind: image_name, value: <name> } }` 的 `value`。 */
function collectImageRefs(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectImageRefs(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  // 匹配 shape：session_source: { mode: agent_image, ref: { value: <name> } }
  const ss = obj["session_source"] ?? obj["sessionSource"];
  if (ss && typeof ss === "object" && !Array.isArray(ss)) {
    const ssObj = ss as Record<string, unknown>;
    if (ssObj["mode"] === "agent_image") {
      const ref = ssObj["ref"];
      if (ref && typeof ref === "object" && !Array.isArray(ref)) {
        const value = (ref as Record<string, unknown>)["value"];
        if (typeof value === "string" && value.length > 0) acc.add(value);
      }
    }
  }
  // 无条件递归所有 value——rig.yaml 的 session_source 嵌套于 members[]。
  for (const v of Object.values(obj)) collectImageRefs(v, acc);
  return acc;
}
