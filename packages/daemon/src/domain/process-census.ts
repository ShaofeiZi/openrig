// OPR.0.5.3.10——唯一 process census。
//
// 实测崩塌（父事故 qitem-20260823031444-cec9cafb；现场慢 span 样本：171 次
// resume_metadata.list_processes 调用，平均 9.39s、最大 40.31s）：每个需要进程表的消费者都派生
// 自己的 `ps -Ao`；model-divergence poll 每席位一次，snapshot refresher 每个 Codex 席位最多八次。
// 高负载下派生调用变慢并堆积，最终拖垮 control plane。进程枚举是全局读取：每个周期一次 census
// 服务所有消费者。
//
// 契约（mini-req 3）：
//   - COALESCE：并发调用方共享一次进行中的枚举。
//   - FRESHNESS：复用 freshnessMs 内最近一次成功 census。
//   - HONEST FAILURE：失败枚举拒绝每个合并调用方，不缓存任何内容，下一次调用重试；失败绝不成为
//     缓存成功。
import type { ProcessRow } from "./model-divergence/current-generation-record.js";

export interface ProcessCensusOpts {
  /** 底层枚举（默认：共享的 `ps -Ao` lister）。 */
  list?: () => Promise<ProcessRow[]>;
  /** 成功 census 的复用窗口，默认 2000ms。 */
  freshnessMs?: number;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
}

export class ProcessCensus {
  private readonly listFn: () => Promise<ProcessRow[]>;
  private readonly freshnessMs: number;
  private readonly now: () => number;
  private inFlight: Promise<ProcessRow[]> | null = null;
  private lastRows: ProcessRow[] | null = null;
  private lastAt = -Infinity;

  constructor(opts: ProcessCensusOpts = {}) {
    this.listFn = opts.list ?? defaultCensusList;
    this.freshnessMs = opts.freshnessMs ?? 2_000;
    this.now = opts.now ?? Date.now;
  }

  async list(): Promise<ProcessRow[]> {
    if (this.lastRows && this.now() - this.lastAt <= this.freshnessMs) {
      return this.lastRows;
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.listFn().then(
      (rows) => {
        this.lastRows = rows;
        this.lastAt = this.now();
        this.inFlight = null;
        return rows;
      },
      (err) => {
        // 真实失败：不缓存任何内容，下一次调用重试。
        this.inFlight = null;
        throw err;
      },
    );
    return this.inFlight;
  }

  /** 周期定界 lister：closure 生命周期内最多执行一次底层 census，并按需获取（没有内容可读的周期
   * 不派生任何调用）。这是“每次 poll/tick 最多一次”的保证（mini-req 1–2），比慢周期可能超出的
   * freshness 窗口更强。 */
  cycleLister(): () => Promise<ProcessRow[]> {
    let cycle: Promise<ProcessRow[]> | null = null;
    return () => (cycle ??= this.list());
  }
}

async function defaultCensusList(): Promise<ProcessRow[]> {
  // r2-B2：严格 lister——失败的 `ps` 必须在此拒绝，使 census 的真实失败路径可在生产中触达
  //（宽松版本的 [] 会在 freshness 窗口内被缓存为空成功）。
  const { defaultListProcessesStrict } = await import("./resume-metadata-refresher.js");
  return defaultListProcessesStrict();
}
