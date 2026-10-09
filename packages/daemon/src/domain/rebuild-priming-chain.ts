import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { listRecapChain, RECAP_FILENAME } from "./context-packs/seat-recap-store.js";
import { parseSessionName } from "./session-name.js";

/**
 * OPR.0.5.5.5（修复轮次 B3）——production rebuild priming chain。从席位路由的内联实现中抽取，
 * 使路由与测试共用唯一实现。信任优先级已显式锁定：
 *
 *   1. 当前编写的 `RECAP.md`（信任级别最高）；
 *   2. `LEARNED.md`（席位 lineage 经验）；
 *   3. compaction seam 的 seat-keyed restore-pending marker 指明的最新 restore packet；
 *   4. 已取代的 recap chain，最新项优先。
 *
 * builder 只声明地址；handover service 会根据是否存在进行过滤。已声明但缺失的地址会记录为具名 GAP，
 * 绝不静默丢弃。无法解析的 seat ref 会产生具名空 chain，绝不猜测。
 */
export function buildRebuildPrimingChain(
  seatRef: string,
  opts: { topologyRoot: string; openrigHome: string },
): { artifacts: Array<{ address: string; label: string }> } | { emptyReason: string } {
  const parsed = parseSessionName(seatRef);
  if (parsed.kind !== "canonical") {
    return { emptyReason: `seat ref '${seatRef}' 无法解析为 canonical <seat>@<rig>；未解析出持久 chain，也绝不猜测` };
  }
  const seatDir = join(opts.topologyRoot, "rigs", parsed.rig, "seats", parsed.member);
  const artifacts = [
    { address: join(seatDir, RECAP_FILENAME), label: "编写的席位 recap（信任级别最高）" },
    { address: join(seatDir, "LEARNED.md"), label: "席位 lineage 经验" },
    ...restorePacketLeg(seatRef, opts.openrigHome),
    ...listRecapChain(seatDir).reverse().map((entry, index) => ({
      address: entry.path,
      label: `已取代的 recap（向前 ${index + 1} 个 generation）`,
    })),
  ];
  return { artifacts };
}

/**
 * 从压缩接缝中以席位定键的 restore-pending 标记
 *（`$OPENRIG_HOME/compaction/restore-pending/<sanitized-session>.json`）读取最新恢复包。
 * 该标记由已交付的压缩前 hook 写入。标记的 `outputDir` 就是生产写入器记录的包地址；
 * 此处不虚构格式，也不猜测路径。
 *
 * - 合法 marker（可解析且 `outputDir` 非空）→ 声明 packet 目录；目录已消失时，会在 service
 *   existence filter 处成为具名 gap；
 * - marker 存在但无法解析/无效 → 声明 marker 文件本身，并附带诚实的 invalid label；具名记录，
 *   绝不虚构；
 * - 无 marker → 不添加 packet leg，chain 的其余部分独立成立。
 */
function restorePacketLeg(seatRef: string, openrigHome: string): Array<{ address: string; label: string }> {
  // 使用 precompact hook 写入 marker key 时的同一 sanitization。
  const key = seatRef.replace(/[^a-zA-Z0-9_.@-]/g, "_");
  const markerPath = join(openrigHome, "compaction", "restore-pending", `${key}.json`);
  if (!existsSync(markerPath)) return [];
  let marker: { outputDir?: unknown; createdAt?: unknown };
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return [{ address: markerPath, label: "restore-pending marker 存在但无效（无法解析）；packet 地址不可用，请检查 marker 本身" }];
  }
  const outputDir = typeof marker.outputDir === "string" ? marker.outputDir.trim() : "";
  if (!outputDir) {
    return [{ address: markerPath, label: "restore-pending marker 存在但无效（无 packet 地址）；请检查 marker 本身" }];
  }
  const createdAt = typeof marker.createdAt === "string" ? `（marker 创建于 ${marker.createdAt}）` : "";
  return [{ address: outputDir, label: `来自 compaction seam 的最新 restore packet${createdAt}` }];
}
