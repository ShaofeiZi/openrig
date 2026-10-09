// Slice 28 Checkpoint C-3——SkillLibraryDiscoveryService。
//
// SC-29 EXCEPTION #11（slice 28 library-explorer-finishing）——累计 scope。C-1（plugin endpoint）
// 在 routes/plugins.ts header 逐字声明 #11。此文件用 skill-library discovery 扩展 slice 28
// surface，以关闭 founder-walk VM 上的 HG-5 / HG-7 / HG-8 / HG-9 cascade（QA verdict
// qitem-20260513045711-39ccfdf3）：用户 allowlist 不包含 daemon source tree，因此此前基于
// /api/files 的 useLibrarySkills 三路径 probe 无法到达 `packages/daemon/specs/agents/shared/skills`。
//
// daemon-owned discovery：通过 daemon 安装位置（import.meta.url + ../specs/agents/shared/skills）
// 解析 shared-skills directory，并从可选 workspace allowlist root 的 `.openrig/skills/` 解析
// 用户定义 skill。UI 直接消费 /api/skills/library（一次 fetch 替代 N 次 fetch probe）。
// 与 C-1 的 plugin pattern 对称。

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { AllowlistRoot } from "./files/path-safety.js";

export type LibrarySkillSource = "workspace" | "openrig-managed";

export interface LibrarySkillFile {
  /** 仅 filename（无 directory prefix）。 */
  name: string;
  /** 相对于 skill folder root 的 path（例如 "SKILL.md" 或 "examples/basic.md"）。 */
  path: string;
  /** 文件大小，单位 byte。 */
  size: number;
  /** 最后修改的 ISO timestamp。 */
  mtime: string;
}

export interface LibrarySkill {
  /**
   * 包含 source + source tree 内相对路径的 stable id。示例：
   *   "openrig-managed:claude-compact-in-place"（shared root 下的扁平 skill）
   *   "openrig-managed:core/openrig-user"（category 内的嵌套 skill）
   *   "workspace:.openrig/skills/operator-skill"（工作区技能）
   * 只要磁盘布局不变，它就在 daemon 重启间保持稳定。
   */
  id: string;
  /** leaf skill folder name（例如 "openrig-user"）。 */
  name: string;
  source: LibrarySkillSource;
  /** skill folder 中的顶层 markdown 文件（若有 SKILL.md，则排在首位）。 */
  files: LibrarySkillFile[];
  /** skill folder 的绝对 filesystem path。Slice 29 HG-4：在 public response 中呈现，使用户
   *  能看到 daemon 从何处读取每个 skill。routes layer 也将其用于
   *  /api/skills/:id/files/{list,read} endpoint。 */
  absolutePath: string;
}

/** public response shape——保留 absolutePath 供用户查看（slice 29 HG-4 file-path discoverability）。 */
export type LibrarySkillPublic = LibrarySkill;

export interface SkillLibraryDiscoveryOpts {
  /**
   * daemon 安装的 shared-skills directory 绝对路径
   *（通常为 `<daemon-install>/specs/agents/shared/skills`）。由 startup.ts 通过
   * import.meta.url + relative resolve 解析。
   */
  sharedSkillsDir: string;
  /**
   * Workspace allowlist root（用户通过 OPENRIG_FILES_ALLOWLIST 声明）。workspace skill 位于
   * `<allowlist-root>/.openrig/skills/<skill-name>/`。空 array → 不发现 workspace-source skill
   *（仅受管模式）。
   */
  filesAllowlist: AllowlistRoot[];
}

const MAX_NESTING_DEPTH = 1;

function isDir(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(absolutePath: string): string[] {
  try {
    return readdirSync(absolutePath);
  } catch {
    return [];
  }
}

function collectMarkdownFiles(absoluteDir: string): LibrarySkillFile[] {
  const entries: LibrarySkillFile[] = [];
  for (const name of safeReaddir(absoluteDir)) {
    if (!/\.(md|mdx)$/i.test(name)) continue;
    const fullPath = join(absoluteDir, name);
    try {
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;
      entries.push({
        name,
        path: name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }
  return entries.sort((a, b) => {
    if (a.name.toLowerCase() === "skill.md") return -1;
    if (b.name.toLowerCase() === "skill.md") return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 递归发现 skill：遍历 base directory，为每个包含 markdown 文件的 subdirectory 发出
 * LibrarySkill。category（不含 markdown 但含更多 subdir）递归一层，直到 MAX_NESTING_DEPTH
 *（匹配 shared-skills tree 的磁盘 shape：扁平 skill folder + 一层 category 嵌套，如
 * core/、pm/、pods/、process/）。
 *
 * `idPrefix` 添加到每个已发出 skill id 前（例如 "openrig-managed:"）；`relativeId` 累积
 * source 内 path，用于构造 stable id。
 */
function collectSkillsRecursive(
  absoluteDir: string,
  source: LibrarySkillSource,
  idPrefix: string,
  relativeId: string,
  depth: number,
): LibrarySkill[] {
  const out: LibrarySkill[] = [];
  for (const childName of safeReaddir(absoluteDir)) {
    const childAbsolute = join(absoluteDir, childName);
    if (!isDir(childAbsolute)) continue;
    const childRelativeId = relativeId ? `${relativeId}/${childName}` : childName;
    const files = collectMarkdownFiles(childAbsolute);
    if (files.length > 0) {
      // leaf——此目录是 skill folder。
      out.push({
        id: `${idPrefix}${childRelativeId}`,
        name: childName,
        source,
        files,
        absolutePath: childAbsolute,
      });
    } else if (depth < MAX_NESTING_DEPTH) {
      // category——向下递归一层。
      out.push(...collectSkillsRecursive(childAbsolute, source, idPrefix, childRelativeId, depth + 1));
    }
    // 其他情况：空 leaf（无 markdown，无法继续递归）——跳过。
  }
  return out;
}

export class SkillLibraryDiscoveryService {
  constructor(private readonly opts: SkillLibraryDiscoveryOpts) {}

  /**
   * 返回 zrig-managed + workspace skill 的合并列表。扫描 source：
   *   - opts.sharedSkillsDir（daemon 已知的绝对路径；openrig-managed）
   *   - 每个 root 下的 <opts.filesAllowlist root>/.openrig/skills/（workspace）
   * 去重规则：发生 source-key collision 时 managed 优先于 workspace。v0 collision shape
   * 并不常见，此规则仅用于防御。
   */
  listLibrarySkills(): LibrarySkill[] {
    const all: LibrarySkill[] = [];

    if (existsSync(this.opts.sharedSkillsDir)) {
      all.push(
        ...collectSkillsRecursive(
          this.opts.sharedSkillsDir,
          "openrig-managed",
          "openrig-managed:",
          "",
          0,
        ),
      );
    }

    for (const root of this.opts.filesAllowlist) {
      const workspaceSkillsDir = join(root.canonicalPath, ".openrig", "skills");
      if (!existsSync(workspaceSkillsDir)) continue;
      // Workspace skill 通过 .openrig/skills/<name>/ path 识别。workspace allowlist root 下的
      // skill 从 depth-0 开始扫描（workspace skill folder 历来为扁平结构，无 category structure；
      // 但为保持一致仍会递归）。
      all.push(
        ...collectSkillsRecursive(
          workspaceSkillsDir,
          "workspace",
          `workspace:${root.name}:`,
          "",
          0,
        ),
      );
    }

    return all.sort((a, b) => {
      if (a.source !== b.source) return a.source === "workspace" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /** 按 stable id 查找单个 skill。 */
  getSkill(id: string): LibrarySkill | null {
    return this.listLibrarySkills().find((s) => s.id === id) ?? null;
  }

  /** public-facing list（保留每个 entry 的 absolutePath 以供用户查看）。 */
  listLibrarySkillsPublic(): LibrarySkillPublic[] {
    return this.listLibrarySkills();
  }
}
