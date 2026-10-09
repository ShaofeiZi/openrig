import nodePath from "node:path";

// 发布前约束：写入用户管理文件（CLAUDE.md / AGENTS.md）的投影标记采用规范产品名。
// 新写入使用 OpenRig 形式；下方 stripManagedBlocks 仍识别旧版安装留下的 "RIGGED" 标记，
// 以便干净卸载。
export const MANAGED_BLOCK_START = (id: string) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${id} -->`;
export const MANAGED_BLOCK_END = (id: string) => `<!-- END OpenRig MANAGED BLOCK: ${id} -->`;
const LEGACY_BLOCK_START = (id: string) => `<!-- BEGIN RIGGED MANAGED BLOCK: ${id} -->`;

// #25——工作组的 Claude Code 席位接收托管块的文件
//（`managed_blocks: { claude-code: <file> }`）。这是当前版本支持的集合，
// 并非 Claude Code 能加载的所有文件。
export const CLAUDE_MANAGED_BLOCK_FILES = ["CLAUDE.md", "CLAUDE.local.md"] as const;
export type ClaudeManagedBlockFile = (typeof CLAUDE_MANAGED_BLOCK_FILES)[number];
export const DEFAULT_CLAUDE_MANAGED_BLOCK_FILE: ClaudeManagedBlockFile = "CLAUDE.md";
const LEGACY_BLOCK_END = (id: string) => `<!-- END RIGGED MANAGED BLOCK: ${id} -->`;

export interface ManagedBlockMergeFsOps {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdirp?(path: string): void;
}

export interface ManagedBlockCleanupFsOps extends ManagedBlockMergeFsOps {
  deleteFile(path: string): void;
}

export interface MergeManagedBlockOptions {
  replaceBlockIds?: string[];
}

export function mergeManagedBlock(
  fs: ManagedBlockMergeFsOps,
  targetPath: string,
  blockId: string,
  content: string,
  options?: MergeManagedBlockOptions,
): void {
  const begin = MANAGED_BLOCK_START(blockId);
  const end = MANAGED_BLOCK_END(blockId);
  const block = `${begin}\n${content}\n${end}`;

  if (!fs.exists(targetPath)) {
    fs.mkdirp?.(nodePath.dirname(targetPath));
    fs.writeFile(targetPath, block);
    return;
  }

  const existing = fs.readFile(targetPath);
  const allReplaceIds = Array.from(new Set([blockId, ...(options?.replaceBlockIds ?? [])]));
  const replaceableIds = allReplaceIds.filter((id) => {
    const candidateBegin = MANAGED_BLOCK_START(id);
    const candidateEnd = MANAGED_BLOCK_END(id);
    const legacyBegin = LEGACY_BLOCK_START(id);
    const legacyEnd = LEGACY_BLOCK_END(id);
    return (
      (existing.includes(candidateBegin) && existing.includes(candidateEnd)) ||
      (existing.includes(legacyBegin) && existing.includes(legacyEnd))
    );
  });

  if (replaceableIds.length > 0) {
    let updated = existing;
    for (const id of replaceableIds) {
      const candidateBegin = MANAGED_BLOCK_START(id);
      const candidateEnd = MANAGED_BLOCK_END(id);
      const regex = new RegExp(`${escapeRegex(candidateBegin)}[\\s\\S]*?${escapeRegex(candidateEnd)}`, "g");
      updated = updated.replace(regex, id === blockId ? block : "");
      // 旧版安装留下的标记变体：替换为 OpenRig 形式；若不是活跃块 id，则移除。
      const legacyBegin = LEGACY_BLOCK_START(id);
      const legacyEnd = LEGACY_BLOCK_END(id);
      const legacyRegex = new RegExp(`${escapeRegex(legacyBegin)}[\\s\\S]*?${escapeRegex(legacyEnd)}`, "g");
      updated = updated.replace(legacyRegex, id === blockId ? block : "");
    }
    if (!updated.includes(begin) || !updated.includes(end)) {
      updated = `${updated.trim()}\n\n${block}`.trim();
    }
    fs.writeFile(targetPath, `${updated}\n`);
    return;
  }

  fs.writeFile(targetPath, `${existing}\n\n${block}`);
}

export function removeManagedBlocksFromFile(fs: ManagedBlockCleanupFsOps, targetPath: string): boolean {
  if (!fs.exists(targetPath)) {
    return false;
  }

  const original = fs.readFile(targetPath);
  const cleaned = stripManagedBlocks(original);
  if (cleaned.length === 0) {
    fs.deleteFile(targetPath);
    return true;
  }

  if (cleaned !== original.trim()) {
    fs.writeFile(targetPath, `${cleaned}\n`);
    return true;
  }

  return false;
}

export function stripManagedBlocks(content: string): string {
  // 同时识别当前写入的 OpenRig 形式与旧版安装写入现有用户文件的 RIGGED 形式，
  // 使卸载与清理路径都能处理这两种过渡状态。
  return content
    .replace(/(?:\n|^)\s*<!-- BEGIN OpenRig MANAGED BLOCK: [\s\S]*?<!-- END OpenRig MANAGED BLOCK: [^>]+ -->\s*(?=\n|$)/g, "\n")
    .replace(/(?:\n|^)\s*<!-- BEGIN RIGGED MANAGED BLOCK: [\s\S]*?<!-- END RIGGED MANAGED BLOCK: [^>]+ -->\s*(?=\n|$)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
