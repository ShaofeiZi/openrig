// OPR.0.5.0.18 —— 把 CANONICAL 证明谱系推导同步进 daemon 的生成镜像
// （本仓库 mirror/codegen 约定：禁止 CLI→daemon 的直接导入，函数体靠生成跨越包边界）。
//
//   node scripts/sync-scope-lineage.mjs           #（重）写生成镜像
//   node scripts/sync-scope-lineage.mjs --check   # 漂移时退出 1，不写任何文件
//
// 权威源：packages/cli/src/lib/scope/attestation-lineage.ts   （改这个）
// 生成物：packages/daemon/src/domain/scope/attestation-lineage.generated.ts
//
// vitest 层的 scope-lineage-parity 固定在每次测试运行时强制同一不变量；
// 本脚本是“写路径”（以及 CI 式 --check）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.env.SYNC_LINEAGE_ROOT
  ? resolve(process.env.SYNC_LINEAGE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CANONICAL = "packages/cli/src/lib/scope/attestation-lineage.ts";
export const GENERATED = "packages/daemon/src/domain/scope/attestation-lineage.generated.ts";

const HEADER = `// 生成文件——请勿手改。
// 由 scripts/sync-scope-lineage.mjs 从权威源发出：
//   ${CANONICAL}
// 请修改权威源，再运行：node scripts/sync-scope-lineage.mjs
// 若此镜像漂移，scope-lineage-parity vitest 固定用例将失败。

`;

export function renderGenerated(canonicalContent) {
  return HEADER + canonicalContent;
}

function main() {
  const check = process.argv.includes("--check");
  const canonicalPath = join(REPO_ROOT, CANONICAL);
  const generatedPath = join(REPO_ROOT, GENERATED);

  const canonical = readFileSync(canonicalPath, "utf8");
  const expected = renderGenerated(canonical);

  if (check) {
    const actual = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null;
    if (actual !== expected) {
      console.error(
        `漂移：${GENERATED} 与权威推导不一致。\n` +
          `请重跑：node scripts/sync-scope-lineage.mjs`,
      );
      process.exit(1);
    }
    console.log("sync-scope-lineage：已同步。");
    return;
  }

  mkdirSync(dirname(generatedPath), { recursive: true });
  writeFileSync(generatedPath, expected, "utf8");
  console.log(`sync-scope-lineage：已写入 ${GENERATED}`);
}

main();
