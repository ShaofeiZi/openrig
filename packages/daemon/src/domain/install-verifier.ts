import { createHash } from "node:crypto";
import type { InstallRepository, JournalEntry } from "./install-repository.js";
import type { PackageRepository } from "./package-repository.js";

export interface Check {
  name: string;
  passed: boolean;
  expected?: string;
  actual?: string;
}

export interface EntryVerification {
  journalId: string;
  targetPath: string;
  checks: Check[];
}

export interface VerificationResult {
  passed: boolean;
  installId: string;
  entries: EntryVerification[];
  statusCheck: Check;
}

export interface VerifierFsOps {
  readFile: (filePath: string) => string;
  exists: (filePath: string) => boolean;
}

const BLOCK_START = (name: string) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${name} -->`;
const BLOCK_END = (name: string) => `<!-- END OpenRig MANAGED BLOCK: ${name} -->`;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class InstallVerifier {
  private installRepo: InstallRepository;
  private packageRepo: PackageRepository;
  private fs: VerifierFsOps;

  constructor(installRepo: InstallRepository, packageRepo: PackageRepository, fs: VerifierFsOps) {
    this.installRepo = installRepo;
    this.packageRepo = packageRepo;
    this.fs = fs;
  }

  verify(installId: string): VerificationResult {
    const install = this.installRepo.getInstall(installId);
    if (!install) {
      return {
        passed: false,
        installId,
        entries: [],
        statusCheck: { name: "install_exists", passed: false, expected: "存在", actual: "未找到" },
      };
    }

    // 状态检查。
    const statusCheck: Check = {
      name: "install_status",
      passed: install.status === "applied",
      expected: "applied",
      actual: install.status,
    };

    if (!statusCheck.passed) {
      return { passed: false, installId, entries: [], statusCheck };
    }

    // 获取 package name，供 guidance marker 检查使用。
    const pkg = this.packageRepo.getPackage(install.packageId);
    const packageName = pkg?.name ?? "unknown";

    // 获取 apply journal entry，排除 rollback entry。
    const journal = this.installRepo.getJournalEntries(installId);
    const applyEntries = journal.filter((e) => e.action !== "rollback");

    // 状态为 applied 却没有 journal entry，应判定验证失败。
    if (applyEntries.length === 0) {
      return {
        passed: false,
        installId,
        entries: [],
        statusCheck: { ...statusCheck, name: "journal_not_empty", passed: false, expected: "至少 1 条 applied entry", actual: "0 条 entry" },
      };
    }

    const entries: EntryVerification[] = [];
    let allPassed = true;

    for (const entry of applyEntries) {
      const checks: Check[] = [];

      // 检查 1：目标文件存在。
      const exists = this.fs.exists(entry.targetPath);
      checks.push({
        name: "target_exists",
        passed: exists,
        expected: "存在",
        actual: exists ? "存在" : "缺失",
      });

      if (exists) {
        if (!entry.afterHash) {
          // 缺少 after_hash，无法验证完整性。
          checks.push({
            name: "content_hash",
            passed: false,
            expected: "已记录 hash",
            actual: "journal 中缺少 after_hash",
          });
        }

        // 检查 2：内容 hash 匹配；仅在记录了 after_hash 时执行。
        const content = this.fs.readFile(entry.targetPath);
        const currentHash = hashContent(content);

        if (entry.afterHash) {
          checks.push({
            name: "content_hash",
            passed: currentHash === entry.afterHash,
            expected: entry.afterHash,
            actual: currentHash,
          });
        }

        // 检查 3：guidance managed block marker。同时识别当前写入的 OpenRig 形式和旧安装
        // 使用的 RIGGED 形式，避免验证品牌重命名前的安装时误报 marker 缺失。
        if (entry.exportType === "guidance") {
          const legacyStart = `<!-- BEGIN RIGGED MANAGED BLOCK: ${packageName} -->`;
          const legacyEnd = `<!-- END RIGGED MANAGED BLOCK: ${packageName} -->`;
          const hasStart = content.includes(BLOCK_START(packageName)) || content.includes(legacyStart);
          const hasEnd = content.includes(BLOCK_END(packageName)) || content.includes(legacyEnd);
          checks.push({
            name: "managed_block_markers",
            passed: hasStart && hasEnd,
            expected: "BEGIN + END marker 均存在",
            actual: hasStart && hasEnd ? "存在" : `BEGIN: ${hasStart}, END: ${hasEnd}`,
          });
        }
      }

      // 检查 4–5：备份完整性。
      if (entry.backupPath) {
        const backupExists = this.fs.exists(entry.backupPath);
        checks.push({
          name: "backup_exists",
          passed: backupExists,
          expected: "存在",
          actual: backupExists ? "存在" : "缺失",
        });

        if (backupExists && !entry.beforeHash) {
          checks.push({
            name: "backup_hash",
            passed: false,
            expected: "已记录 hash",
            actual: "journal 中缺少 before_hash",
          });
        } else if (backupExists && entry.beforeHash) {
          const backupContent = this.fs.readFile(entry.backupPath);
          const backupHash = hashContent(backupContent);
          checks.push({
            name: "backup_hash",
            passed: backupHash === entry.beforeHash,
            expected: entry.beforeHash,
            actual: backupHash,
          });
        }
      }

      const entryPassed = checks.every((c) => c.passed);
      if (!entryPassed) allPassed = false;

      entries.push({
        journalId: entry.id,
        targetPath: entry.targetPath,
        checks,
      });
    }

    return {
      passed: allPassed && statusCheck.passed,
      installId,
      entries,
      statusCheck,
    };
  }
}
