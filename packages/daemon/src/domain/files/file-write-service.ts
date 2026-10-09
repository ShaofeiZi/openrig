// UI Enhancement Pack v0——原子文件写入 + JSONL 审计。
//
// 条目 4：操作者可执行的 STEERING.md / PROGRESS.md / spec YAML / 任意白名单文件写入面。
// 遵循 dashboard 先例中的 mtime + content-hash 不变量（引用已退役但仍有指导意义的
// `services/dashboard/bin/server.py:1269-1289`），并按当前 zrig 约定用 TypeScript 重新实现。
//
// 原子写入语义：
//   1. 在白名单根目录下解析目标路径（路径安全规则来自 file-allowlist.ts）。
//   2. 重新 stat 并计算哈希：若 mtime != expectedMtime 或 contentHash !=
//      expectedContentHash，则抛出 WriteConflictError，并携带当前 mtime + contentHash
//      供 UI 展示。
//   3. 将内容写入同目录临时文件。
//   4. 对临时文件执行 fsync，确保重命名前写入已持久化。
//   5. 原子重命名覆盖目标路径。在 POSIX 上这是一次 inode 交换，其他读取者只会看到旧文件
//      或新文件，绝不会看到部分写入。
//   6. 从重命名后的目标重新计算 mtime + contentHash。
//   7. 向审计文件追加一行 JSONL。
//
// 审计文件默认为 `~/.openrig/file-edit-audit.jsonl`，操作者可通过环境变量覆盖。按照
// PRD § 条目 4，v0 只追加且不轮转；轮转留待后续处理。

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAllowedPath, type AllowlistRoot } from "./path-safety.js";

export interface FileWriteRequest {
  rootName: string;
  /** 白名单根目录下的相对路径；结构与条目 3 的路由一致。 */
  path: string;
  content: string;
  /** 调用方上次读取时已知的 mtime（ISO 字符串）。 */
  expectedMtime: string;
  /** 调用方上次读取时已知的 SHA-256 内容哈希（十六进制）。 */
  expectedContentHash: string;
  /** 发起写入的操作者会话，用于审计记录。 */
  actor: string;
  /** 审计记录的 P21 §4 时代标记：操作者来自传输 header 汇聚点时为 `transport:v1`；
   * null 表示 claimed-era（UI/MCP 命名延后路径）。 */
  identityProvenance?: string | null;
}

export interface FileWriteResult {
  /** 实际写入的已解析规范绝对路径。 */
  absolutePath: string;
  /** 写入后的新 mtime（ISO 字符串）。 */
  newMtime: string;
  /** 写入后的新 SHA-256 内容哈希（十六进制）。 */
  newContentHash: string;
  /** 字节数差值（新值 - 旧值）。 */
  byteCountDelta: number;
}

export class WriteConflictError extends Error {
  constructor(
    public readonly currentMtime: string,
    public readonly currentContentHash: string,
    public readonly details: Record<string, unknown>,
  ) {
    super("文件已被外部修改；写入前必须刷新");
    this.name = "WriteConflictError";
  }
}

export class FileWriteError extends Error {
  constructor(
    public readonly code: "stat_failed" | "tmp_write_failed" | "rename_failed" | "audit_write_failed" | "target_exists",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FileWriteError";
  }
}

export interface FileWriteServiceOpts {
  /** 启动时从环境变量解析的白名单根目录；每次请求重新解析也可以，开销很小。 */
  allowlist: AllowlistRoot[];
  /** 测试时覆盖默认审计文件位置。 */
  auditFilePath?: string;
  /** 测试时覆盖 Date.now()，返回 ISO 时间戳。 */
  now?: () => Date;
}

const DEFAULT_AUDIT_FILE = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".openrig",
  "file-edit-audit.jsonl",
);

export class FileWriteService {
  private readonly allowlist: AllowlistRoot[];
  private readonly auditFilePath: string;
  private readonly now: () => Date;

  constructor(opts: FileWriteServiceOpts) {
    this.allowlist = opts.allowlist;
    this.auditFilePath = opts.auditFilePath ?? DEFAULT_AUDIT_FILE;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * 将内容原子写入白名单文件。mtime/contentHash 不匹配时抛出 WriteConflictError；
   * stat、临时写入、重命名或审计失败时抛出 FileWriteError。成功时返回包含新 mtime +
   * contentHash 的 FileWriteResult。
   */
  writeAtomic(req: FileWriteRequest): FileWriteResult {
    const target = resolveAllowedPath(this.allowlist, req.rootName, req.path);

    // 写入前重新 stat 并计算哈希，以检测冲突。
    let prevStat: fs.Stats;
    let prevContent: Buffer;
    try {
      prevStat = fs.statSync(target);
      prevContent = fs.readFileSync(target);
    } catch (err) {
      throw new FileWriteError(
        "stat_failed",
        `为检测冲突读取 '${target}' 失败：${err instanceof Error ? err.message : String(err)}`,
        { target },
      );
    }
    const prevMtime = prevStat.mtime.toISOString();
    const prevContentHash = sha256Hex(prevContent);
    if (prevMtime !== req.expectedMtime || prevContentHash !== req.expectedContentHash) {
      throw new WriteConflictError(prevMtime, prevContentHash, {
        target,
        expectedMtime: req.expectedMtime,
        expectedContentHash: req.expectedContentHash,
      });
    }

    // 写入同一目录下的临时文件，使原子重命名发生在同一文件系统内。文件名附加 PID 和
    // 随机值，避免并发写入冲突。
    const tmpName = `.openrig-write-${process.pid}-${Math.random().toString(36).slice(2, 10)}-${path.basename(target)}`;
    const tmpPath = path.join(path.dirname(target), tmpName);
    let tmpFd: number | null = null;
    try {
      tmpFd = fs.openSync(tmpPath, "w");
      fs.writeFileSync(tmpFd, req.content);
      fs.fsyncSync(tmpFd);
    } catch (err) {
      // 如果临时文件已部分创建，则尽力清理。
      try { if (tmpFd !== null) fs.closeSync(tmpFd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new FileWriteError(
        "tmp_write_failed",
        `写入并 fsync 临时文件 '${tmpPath}' 失败：${err instanceof Error ? err.message : String(err)}`,
        { target, tmpPath },
      );
    } finally {
      try { if (tmpFd !== null) fs.closeSync(tmpFd); } catch { /* ignore */ }
    }

    try {
      fs.renameSync(tmpPath, target);
    } catch (err) {
      // 尽力清理孤立的临时文件。由于原子重命名失败时目标从未被修改，因此无需恢复旧内容。
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new FileWriteError(
        "rename_failed",
        `将 '${tmpPath}' 原子重命名覆盖 '${target}' 失败：${err instanceof Error ? err.message : String(err)}`,
        { target, tmpPath },
      );
    }

    // 重新 stat 以取得新的 mtime 和内容哈希。
    const newStat = fs.statSync(target);
    const newContent = fs.readFileSync(target);
    const newMtime = newStat.mtime.toISOString();
    const newContentHash = sha256Hex(newContent);
    const byteCountDelta = newContent.byteLength - prevContent.byteLength;

    // 追加审计 JSONL 记录。此处失败会报错，但不会撤销写入：用户编辑已落盘，不能因为
    // 审计系统偶发故障而回滚规范内容。
    const auditRow = {
      ts: this.now().toISOString(),
      actor: req.actor,
      identity_provenance: req.identityProvenance ?? null, // P21 §4 era-stamp (null = claimed-era / UI deferral)
      root: req.rootName,
      path: req.path,
      absolutePath: target,
      prevMtime,
      newMtime,
      prevContentHash,
      newContentHash,
      byteCountDelta,
    };
    try {
      this.appendAuditRow(auditRow);
    } catch (err) {
      throw new FileWriteError(
        "audit_write_failed",
        `写入已成功，但追加审计记录失败：${err instanceof Error ? err.message : String(err)}`,
        { target, auditFilePath: this.auditFilePath, ...auditRow },
      );
    }

    return {
      absolutePath: target,
      newMtime,
      newContentHash,
      byteCountDelta,
    };
  }

  /**
   * 原子创建新的白名单文件（OPR.0.4.4.20 FR-6——冻结评审导出）。采用独占创建：文件已
   * 存在时抛出 `target_exists`。冻结导出是时点快照，永不改写；对同一审批重复冻结由调用方
   * 视为幂等无操作。与 writeAtomic 共用临时写入、fsync 和审计记录机制，只有一个写入器族。
   */
  createAtomic(req: Omit<FileWriteRequest, "expectedMtime" | "expectedContentHash">): FileWriteResult {
    const target = resolveAllowedPath(this.allowlist, req.rootName, req.path);
    if (fs.existsSync(target)) {
      throw new FileWriteError("target_exists", `拒绝覆盖现有文件 '${target}'`, { target });
    }

    const tmpName = `.openrig-write-${process.pid}-${Math.random().toString(36).slice(2, 10)}-${path.basename(target)}`;
    const tmpPath = path.join(path.dirname(target), tmpName);
    let tmpFd: number | null = null;
    try {
      tmpFd = fs.openSync(tmpPath, "w");
      fs.writeFileSync(tmpFd, req.content);
      fs.fsyncSync(tmpFd);
    } catch (err) {
      try { if (tmpFd !== null) fs.closeSync(tmpFd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new FileWriteError(
        "tmp_write_failed",
        `failed to write+fsync temp file at '${tmpPath}': ${err instanceof Error ? err.message : String(err)}`,
        { target, tmpPath },
      );
    } finally {
      try { if (tmpFd !== null) fs.closeSync(tmpFd); } catch { /* ignore */ }
    }

    try {
      // 若目标在此期间出现，linkSync 会失败，从而实现真正的独占创建。
      fs.linkSync(tmpPath, target);
      fs.unlinkSync(tmpPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      const code = (err as NodeJS.ErrnoException).code === "EEXIST" ? "target_exists" : "rename_failed";
      throw new FileWriteError(
        code,
        `原子创建 '${target}' 失败：${err instanceof Error ? err.message : String(err)}`,
        { target, tmpPath },
      );
    }

    const newStat = fs.statSync(target);
    const newContent = fs.readFileSync(target);
    const newMtime = newStat.mtime.toISOString();
    const newContentHash = sha256Hex(newContent);

    const auditRow = {
      ts: this.now().toISOString(),
      actor: req.actor,
      identity_provenance: req.identityProvenance ?? null, // P21 §4 era-stamp (null = claimed-era / UI deferral)
      root: req.rootName,
      path: req.path,
      absolutePath: target,
      prevMtime: null,
      newMtime,
      prevContentHash: null,
      newContentHash,
      byteCountDelta: newContent.byteLength,
    };
    try {
      this.appendAuditRow(auditRow);
    } catch (err) {
      throw new FileWriteError(
        "audit_write_failed",
        `创建已成功，但追加审计记录失败：${err instanceof Error ? err.message : String(err)}`,
        { target, auditFilePath: this.auditFilePath, ...auditRow },
      );
    }

    return { absolutePath: target, newMtime, newContentHash, byteCountDelta: newContent.byteLength };
  }

  private appendAuditRow(row: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.auditFilePath), { recursive: true });
    fs.appendFileSync(this.auditFilePath, `${JSON.stringify(row)}\n`);
  }

  /** 测试/调试辅助函数：返回配置的审计文件路径。 */
  getAuditFilePath(): string {
    return this.auditFilePath;
  }
}

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
