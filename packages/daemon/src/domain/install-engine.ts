import path from "node:path";
import { createHash } from "node:crypto";
import type { InstallPlanEntry } from "./install-planner.js";
import type { PolicyResult } from "./install-policy.js";
import type { RefinedInstallPlan } from "./conflict-detector.js";
import { InstallRepository, type JournalEntry } from "./install-repository.js";

export interface EngineFsOps {
  readFile: (filePath: string) => string;
  writeFile: (filePath: string, content: string) => void;
  exists: (filePath: string) => boolean;
  mkdirp: (dirPath: string) => void;
  copyFile: (src: string, dest: string) => void;
  deleteFile: (filePath: string) => void;
}

export interface InstallResult {
  installId: string;
  applied: JournalEntry[];
  deferred: InstallPlanEntry[];
  conflicts: InstallPlanEntry[];
}

export interface RollbackResult {
  installId: string;
  restored: string[];
  deleted: string[];
}

const BLOCK_START = (name: string) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${name} -->`;
const BLOCK_END = (name: string) => `<!-- END OpenRig MANAGED BLOCK: ${name} -->`;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class InstallEngine {
  private installRepo: InstallRepository;
  private fs: EngineFsOps;

  constructor(installRepo: InstallRepository, fs: EngineFsOps) {
    this.installRepo = installRepo;
    this.fs = fs;
  }

  apply(
    policyResult: PolicyResult,
    plan: RefinedInstallPlan,
    packageId: string,
    targetRoot: string,
    bootstrapId?: string,
  ): InstallResult {
    const install = this.installRepo.createInstall(packageId, targetRoot, "project_shared", bootstrapId);
    const applied: JournalEntry[] = [];
    const backupRoot = path.join(targetRoot, ".rigged-backups", install.id);

    try {
      for (const entry of policyResult.approved) {
        // 确保 target 目录存在。
        this.fs.mkdirp(path.dirname(entry.targetPath));

        // 若现有文件存在则备份。
        let backupPath: string | undefined;
        let beforeHash: string | undefined;
        if (this.fs.exists(entry.targetPath)) {
          const relativePath = path.relative(targetRoot, entry.targetPath);
          backupPath = path.join(backupRoot, relativePath);
          this.fs.mkdirp(path.dirname(backupPath));
          this.fs.copyFile(entry.targetPath, backupPath);
          beforeHash = hashContent(this.fs.readFile(entry.targetPath));
        }

        // 应用——guidance 始终使用 managed-block merge（新文件也如此）。
        if (entry.exportType === "guidance") {
          this.applyGuidanceMerge(entry, plan.packageName);
        } else if (entry.sourcePath) {
          // 将 source 复制到 target（skills、agents）。
          this.fs.copyFile(entry.sourcePath, entry.targetPath);
        }

        const afterHash = this.fs.exists(entry.targetPath)
          ? hashContent(this.fs.readFile(entry.targetPath))
          : undefined;

        try {
          const journal = this.installRepo.createJournalEntry({
            installId: install.id,
            action: entry.classification === "managed_merge" ? "merge_block" : "copy",
            exportType: entry.exportType,
            classification: entry.classification,
            targetPath: entry.targetPath,
            backupPath,
            beforeHash,
            afterHash,
            status: "applied",
          });
          applied.push(journal);
        } catch (journalErr) {
          // 撤销此 entry 的文件变更，因为它不会进入 rollback 列表。
          try {
            if (backupPath && this.fs.exists(backupPath)) {
              this.fs.copyFile(backupPath, entry.targetPath);
            } else if (this.fs.exists(entry.targetPath)) {
              this.fs.deleteFile(entry.targetPath);
            }
          } catch { /* best-effort 撤销。 */ }
          throw journalErr;
        }
      }

      this.installRepo.updateInstallStatus(install.id, "applied");
    } catch (err) {
      // 失败时执行补偿性 rollback。
      this.rollbackEntries(install.id, applied);
      this.installRepo.updateInstallStatus(install.id, "failed");
      throw err;
    }

    return {
      installId: install.id,
      applied,
      deferred: plan.deferred,
      conflicts: plan.conflicts,
    };
  }

  rollback(installId: string): RollbackResult {
    const entries = this.installRepo.getJournalEntries(installId);
    const applyEntries = entries.filter((e) => e.action !== "rollback");
    const { restored, deleted } = this.rollbackEntries(installId, applyEntries);
    this.installRepo.updateInstallStatus(installId, "rolled_back");
    return { installId, restored, deleted };
  }

  private rollbackEntries(
    installId: string,
    entries: JournalEntry[],
  ): { restored: string[]; deleted: string[] } {
    const restored: string[] = [];
    const deleted: string[] = [];

    // 按相反顺序 rollback。
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.backupPath && this.fs.exists(entry.backupPath)) {
          // 从备份恢复。
          this.fs.mkdirp(path.dirname(entry.targetPath));
          this.fs.copyFile(entry.backupPath, entry.targetPath);
          restored.push(entry.targetPath);
        } else if (this.fs.exists(entry.targetPath)) {
          // 无备份 = 新文件，删除它。
          this.fs.deleteFile(entry.targetPath);
          deleted.push(entry.targetPath);
        }

        // 记录 rollback action。
        this.installRepo.createJournalEntry({
          installId,
          action: "rollback",
          exportType: entry.exportType,
          classification: entry.classification,
          targetPath: entry.targetPath,
          status: "rolled_back",
        });
      } catch {
        // Best-effort rollback——继续处理剩余 entry。
      }
    }

    return { restored, deleted };
  }

  private applyGuidanceMerge(entry: InstallPlanEntry, packageName: string): void {
    if (!entry.sourcePath) return;

    const content = this.fs.readFile(entry.sourcePath);
    const block = `${BLOCK_START(packageName)}\n${content}\n${BLOCK_END(packageName)}`;

    if (this.fs.exists(entry.targetPath)) {
      const existing = this.fs.readFile(entry.targetPath);
      const startMarker = BLOCK_START(packageName);
      const endMarker = BLOCK_END(packageName);
      const legacyStart = `<!-- BEGIN RIGGED MANAGED BLOCK: ${packageName} -->`;
      const legacyEnd = `<!-- END RIGGED MANAGED BLOCK: ${packageName} -->`;
      // 优先使用 OpenRig 形式；回退识别此前安装留下的旧 marker，使 guidance package 重新应用到
      // 重命名前的文件时替换旧 block，而不是追加重复项。
      let startIdx = existing.indexOf(startMarker);
      let endIdx = existing.indexOf(endMarker);
      let matchedEndLength = endMarker.length;
      if (startIdx === -1 || endIdx === -1) {
        const legacyStartIdx = existing.indexOf(legacyStart);
        const legacyEndIdx = existing.indexOf(legacyEnd);
        if (legacyStartIdx !== -1 && legacyEndIdx !== -1) {
          startIdx = legacyStartIdx;
          endIdx = legacyEndIdx;
          matchedEndLength = legacyEnd.length;
        }
      }

      if (startIdx !== -1 && endIdx !== -1) {
        // 更新现有 block（将旧 marker 重写为 OpenRig 形式）。
        const updated = existing.slice(0, startIdx) + block + existing.slice(endIdx + matchedEndLength);
        this.fs.writeFile(entry.targetPath, updated);
      } else {
        // 在末尾插入新 block。
        this.fs.writeFile(entry.targetPath, existing + "\n\n" + block + "\n");
      }
    } else {
      // 新文件。
      this.fs.writeFile(entry.targetPath, block + "\n");
    }
  }
}
