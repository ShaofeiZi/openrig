// 生成文件——请勿手改。
// 由 scripts/sync-scope-lineage.mjs 从权威源发出：
//   packages/cli/src/lib/scope/attestation-lineage.ts
// 请修改权威源，再运行：node scripts/sync-scope-lineage.mjs
// 若此镜像漂移，scope-lineage-parity vitest 固定用例将失败。

// OPR.0.5.0.18——canonical amendment-lineage 推导（唯一真相源）。
//
// re-stamp 操作（`zrig scope … approve --re-approve`）在当前 stamp 旁以原子方式写入
// `approved-spec-priors` / `approved-priors`，使 filesystem-local audit 无需访问 DB 即可显示
// lineage。对从未修订的 scope 返回 undefined（first-approve output 保持不变）。
//
// 通过生成机制跨 package 共享：daemon audit route 使用由 `node scripts/sync-scope-lineage.mjs`
// 生成的 packages/daemon/src/domain/scope/attestation-lineage.generated.ts，消费逐字节一致的
// body（CLI→daemon 的 import 方向被禁止，因此由 repo 的 mirror/codegen 约定承载）。只编辑此文件，
// 随后运行同步；两者一旦分叉，scope-lineage-parity pin 就会失败。

export interface AttestationLineage {
  spec?: { by: string; at: string; priors: number };
  delivery?: { by: string; at: string; priors: number };
}

export function attestationLineage(frontmatterRaw: string | null): AttestationLineage | undefined {
  if (!frontmatterRaw) return undefined;
  const read = (key: string): string | null => {
    const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(frontmatterRaw);
    return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : null;
  };
  const lineage: AttestationLineage = {};
  for (const [scope, fields] of [
    ["spec", { by: "approved-spec-by", at: "approved-spec-at", priors: "approved-spec-priors" }],
    ["delivery", { by: "approved-by", at: "approved-at", priors: "approved-priors" }],
  ] as const) {
    const priorsRaw = read(fields.priors);
    const priors = priorsRaw !== null ? Number(priorsRaw) : NaN;
    if (Number.isFinite(priors) && priors > 0) {
      lineage[scope] = { by: read(fields.by) ?? "?", at: read(fields.at) ?? "?", priors };
    }
  }
  return Object.keys(lineage).length > 0 ? lineage : undefined;
}
