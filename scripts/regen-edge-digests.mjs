#!/usr/bin/env node
// 依据磁盘真实状态重新生成 scripts/skill-edge-digests.generated.json。
//
// 用仓库内（本就正确的）scripts/skill-edge-layout.generated.json 确定要遍历哪些边，
// 从磁盘上的文件重新计算每条边的文件完整性哈希。不需要任何外部 canon YAML——
// 摘要纯粹来自磁盘 + layout。若要做“同时从外部 skill canon 重新推导成员/拒绝名单/layout”的
// 完整 mirror APPLY，则需显式提供 canon-root 路径（OPENRIG_SKILL_CANON_ROOT）；
// 本 regen 只刷新“现实侧”（现存文件的哈希），使其与已合入的 main 对齐。
//
// 不变量（layout = 权威，disk = 现实，regen 只动现实）：buildEdgeDigests 只对“现存文件”做哈希。
// layout 要求但磁盘缺失的文件绝不会在这里被补上摘要，因此 `mirror-skills.mjs --check`
// 仍会就此大声告警（经它的 layout-missing 检查 + 那条命名精确、自我约束的
// external-canon-pending 白名单）——未来一次误删永远不可能被 regen 悄悄洗白。
//
// 用法：node scripts/regen-edge-digests.mjs   （原地写回；当已合入的 skill 边发生漂移时运行）

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdgeDigests } from "../packages/daemon/scripts/gen-control-plane-json.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const layoutPath = join(repoRoot, "scripts/skill-edge-layout.generated.json");
const outPath = join(repoRoot, "scripts/skill-edge-digests.generated.json");

const layout = JSON.parse(readFileSync(layoutPath, "utf8"));
const digests = buildEdgeDigests({ repoRoot, layout });
writeFileSync(outPath, `${JSON.stringify(digests, null, 2)}\n`);

const fileCount = Object.values(digests.edges).reduce((n, files) => n + Object.keys(files).length, 0);
console.log(
  `已从磁盘重新生成 ${outPath}：${Object.keys(digests.edges).length} 条边，${fileCount} 个文件。`,
);
