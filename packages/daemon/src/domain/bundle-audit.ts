/**
 * Bundle 安装审计轨迹（条目 4 / slice-05 检查点 5.1）。
 *
 * 以仅追加 JSONL 日志记录 bundle 安装事件。沿用 Transcript / Log Cleanup v0 和
 * UI Enhancement Pack v0 的 JSONL 审计轨迹约定，无需新增 SQLite schema 或迁移。
 *
 * 默认位置是 ~/.openrig/bundle-audit.jsonl。写入器是纯数据接收端：调用方
 *（/api/bundles/install 路由处理器）在安装生命周期的正确时机组装记录，并交给
 * BundleAuditWriter.append。读取器为 /api/bundles/history 端点和
 * `zrig bundle history` CLI 子命令提供小型过滤 API（工作组名称 + 起始时间戳）；
 * 两者均在检查点 5.2 落地。
 *
 * FsOps 注入沿用代码库的可测试模式：真实实现读写 node:fs，测试则替换为内存 mock。
 */

import nodePath from "node:path";

/** 一条 bundle 安装审计记录。 */
export interface BundleAuditRecord {
  /** 记录安装事件时的 ISO 时间戳。 */
  installedAt: string;
  /** 安装操作所使用的源 bundle 路径。 */
  bundlePath: string;
  /** 归档的 SHA-256 哈希（可从 bundle 同级摘要取得时）。 */
  archiveHash?: string;
  /** 安装目标工作组的 ULID（适用时）。 */
  targetRigId?: string;
  /** 安装目标工作组的名称（适用时）。 */
  targetRigName?: string;
  /** bundle 来源信息中记录的主机名（条目 1；存在时）。 */
  sourceHost?: string;
  /** 安装时的后台服务版本。 */
  daemonVersion?: string;
  /** 安装时的 CLI 版本（CLI 提供时；条目 1 + 条目 2 路径）。 */
  cliVersion?: string;
  /** 安装结果——必须如实记录（partial 表示部分阶段成功、部分失败）。 */
  outcome: "success" | "failed" | "partial";
}

/** 文件系统注入点——真实实现包装 node:fs，测试替换为内存实现。 */
export interface BundleAuditFsOps {
  appendFile: (path: string, content: string) => void;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  mkdirp: (path: string) => void;
}

/** 审计写入器和读取器的配置。 */
export interface BundleAuditOpts {
  /** JSONL 文件的绝对路径（默认位置：~/.openrig/bundle-audit.jsonl）。 */
  auditPath: string;
}

/** bundle 安装审计记录的仅追加写入器。 */
export class BundleAuditWriter {
  private opts: BundleAuditOpts;
  private fs: BundleAuditFsOps;

  constructor(deps: { opts: BundleAuditOpts; fsOps: BundleAuditFsOps }) {
    this.opts = deps.opts;
    this.fs = deps.fsOps;
  }

  /**
   * 向 JSONL 文件追加一条记录；父目录缺失时创建。每条记录都是独占一行的 JSON 对象
   *（操作者可用 tail -f 实时监控）。文件系统错误通过 fsOps 抛出。
   */
  append(record: BundleAuditRecord): void {
    this.fs.mkdirp(nodePath.dirname(this.opts.auditPath));
    const line = `${JSON.stringify(record)}\n`;
    this.fs.appendFile(this.opts.auditPath, line);
  }
}

/** 审计读取器支持的过滤条件（/api/bundles/history 的子集）。 */
export interface BundleAuditFilters {
  /** 设置后，只返回 targetRigName 等于该值的记录。 */
  rig?: string;
  /** 设置后，只返回 installedAt 大于等于该 ISO 时间戳的记录。 */
  since?: string;
}

/** bundle 安装审计 JSONL 文件读取器。 */
export class BundleAuditReader {
  private opts: BundleAuditOpts;
  private fs: BundleAuditFsOps;

  constructor(deps: { opts: BundleAuditOpts; fsOps: BundleAuditFsOps }) {
    this.opts = deps.opts;
    this.fs = deps.fsOps;
  }

  /**
   * 返回全部审计记录，可选过滤。格式错误的行会被静默跳过，以便向前兼容当前结构无法
   * 解析的未来记录形态；其他可读行仍会返回。记录按追加顺序返回（最早的在前）。
   */
  list(filters?: BundleAuditFilters): BundleAuditRecord[] {
    if (!this.fs.exists(this.opts.auditPath)) return [];
    const content = this.fs.readFile(this.opts.auditPath);
    const lines = content.split("\n").filter((l) => l.length > 0);
    const records: BundleAuditRecord[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          records.push(parsed as BundleAuditRecord);
        }
      } catch {
        // 格式错误的行——静默跳过。
      }
    }
    return applyFilters(records, filters);
  }
}

/** 对内存记录数组应用受支持的过滤条件。 */
function applyFilters(records: BundleAuditRecord[], filters?: BundleAuditFilters): BundleAuditRecord[] {
  if (!filters) return records;
  let out = records;
  if (filters.rig !== undefined && filters.rig.length > 0) {
    const rigName = filters.rig;
    out = out.filter((r) => r.targetRigName === rigName);
  }
  if (filters.since !== undefined && filters.since.length > 0) {
    const since = filters.since;
    out = out.filter((r) => r.installedAt >= since);
  }
  return out;
}
