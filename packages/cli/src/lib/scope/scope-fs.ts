// release-0.3.2 slice 12——跨 `rig scope` 动词共享的文件系统 + git 辅助。
// 任务目标/slice 发现、frontmatter 解析/写入、自动编号、git mv 包装。
// 保持 slice/mission 命令文件轻薄。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ConfigStore } from "../../config-store.js";

import type {
  MissionInfo,
  SliceInfo,
  SliceState,
} from "./types.js";
import { ScopeCliError } from "./types.js";
import {
  DEFAULT_PROJECT_PREFIX,
  inferMissionDotId,
  nextEscapeBandOrdinal,
} from "./dot-id.js";
import { deriveMissionDependencyGraph, type MissionDependencyGraph } from "./scope-audit.js";

const FRONTMATTER_DELIM = "---\n";
const SLICE_DIRNAME_RE = /^(\d+)-(.+)$/;

// ---------------------------------------------------------------------
// Frontmatter 解析与写入
// ---------------------------------------------------------------------

/** 将 markdown 文件拆分为 [frontmatter, body]。没有 frontmatter
 *  分隔符时返回 `[{}, content]`。 */
export function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith(FRONTMATTER_DELIM)) {
    return { frontmatter: {}, body: content };
  }
  const rest = content.slice(FRONTMATTER_DELIM.length);
  const endIdx = rest.indexOf(`\n${FRONTMATTER_DELIM.trim()}\n`);
  if (endIdx === -1) {
    // 允许末尾 `---` 无最终换行（文件最后一个字符）。
    const endIdx2 = rest.indexOf(`\n---`);
    if (endIdx2 === -1) return { frontmatter: {}, body: content };
    const raw = rest.slice(0, endIdx2);
    return { frontmatter: parseYamlSafely(raw), body: rest.slice(endIdx2 + 4).replace(/^\n/, "") };
  }
  const raw = rest.slice(0, endIdx);
  const body = rest.slice(endIdx + `\n${FRONTMATTER_DELIM.trim()}\n`.length);
  return { frontmatter: parseYamlSafely(raw), body };
}

function parseYamlSafely(raw: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 将 frontmatter + body 重新拼接为单个 markdown 字符串。 */
export function joinFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 }).trim();
  const trailing = body.startsWith("\n") ? "" : "\n";
  return `---\n${yaml}\n---\n${trailing}${body}`;
}

/** 从 markdown 文件读取 + 解析 frontmatter。文件缺失
 *  或没有 frontmatter 时返回 `{}`（对于早于约定的占位
 *  任务目标优雅处理）。 */
export function readFrontmatter(absPath: string): Record<string, unknown> {
  try {
    return splitFrontmatter(fs.readFileSync(absPath, "utf8")).frontmatter;
  } catch {
    return {};
  }
}

/** 更新 markdown 文件 frontmatter 中的特定键。写入器只拥有
 *  这些键：已有块中的其他每个字节保持不变。这是刻意作为
 *  后台服务批准拼接器的 CLI 孪生；解析并重新序列化整个块会
 *  破坏作者引号、折叠标量、顺序，以及因此修复前派生的任何哈希。 */
export function updateFrontmatter(
  absPath: string,
  updates: Record<string, unknown>,
): void {
  const original = fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : "";
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(original);
  if (!match) {
    const yaml = YAML.stringify(updates, { lineWidth: 0 }).trimEnd();
    const separator = original.startsWith("\n") ? "" : "\n";
    fs.writeFileSync(absPath, `---\n${yaml}\n---\n${separator}${original}`, "utf8");
    return;
  }

  let block = match[1]!;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const rendered = YAML.stringify({ [key]: value }, { lineWidth: 0 }).trimEnd();
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const keyRe = new RegExp(
      `^${escaped}:[^\\n]*(?:\\n[ \\t]+[^\\n]*|\\n(?=(?:\\n)*[ \\t]+))*`,
      "m",
    );
    const existing = keyRe.exec(block);
    if (existing) {
      block = block.slice(0, existing.index) + rendered + block.slice(existing.index + existing[0].length);
    } else {
      block = block.length > 0 ? `${block}\n${rendered}` : rendered;
    }
  }
  const updated = original.slice(0, match.index) + `---\n${block}\n---` + original.slice(match.index + match[0].length);
  fs.writeFileSync(absPath, updated, "utf8");
}

// ---------------------------------------------------------------------
// 任务发现
// ---------------------------------------------------------------------

/** 从显式工作区覆盖或类型化的
 * `workspace.slices_root` 设置定位任务目标根目录。不做 cwd 遍历：
 * 发现可以枚举候选，但选择来自配置。 */
export function resolveMissionsRoot(opts: {
  override?: string | null;
  cwd?: string;
  configPath?: string;
} = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const fromOverride = opts.override ?? process.env.OPENRIG_WORK_ROOT;
  if (fromOverride) {
    const candidate = path.isAbsolute(fromOverride) ? fromOverride : path.resolve(cwd, fromOverride);
    const missions = path.join(candidate, "missions");
    if (fs.existsSync(missions) && fs.statSync(missions).isDirectory()) return missions;
    if (path.basename(candidate) === "missions" && fs.existsSync(candidate)) return candidate;
  }
  const configured = new ConfigStore(opts.configPath).get("workspace.slices_root") as string;
  if (configured && fs.existsSync(configured) && fs.statSync(configured).isDirectory()) return configured;
  throw new ScopeCliError({
    fact: `配置的 workspace.slices_root 不是可读目录：${configured || "(未设置)"}。`,
    consequence: "没有可操作的任务目标树。",
    action: "用 `zrig config set` 设置 workspace.slices_root，或传递 --workspace /path/to/your/workspace。",
  });
}

/**
 * 工作节点处的编写契约文件，最优先在前。
 *
 * `SPEC.md` 是当前名称；`README.md` 是遗留名称并无限期保持有效。没有迁移：
 * 休眠任务目标和历史证明收据以 README 为后盾，必须保持原样解析。
 * 同时携带两者的节点在这里不是错误——SPEC.md 优先，`scope audit`
 * 会建议第二个文件。
 */
export const NODE_FILE_PRECEDENCE = ["SPEC.md", "README.md"] as const;

/** 当前任务目标笔记名称，后接无限期可读的遗留名称。 */
export const NOTES_FILE_PRECEDENCE = ["NOTES.md", "MISSION_NOTES.md"] as const;

export interface NotesFileResolution {
  path: string;
  name: (typeof NOTES_FILE_PRECEDENCE)[number];
}

/** 解析第一个可读的任务目标笔记文件，优先使用当前名称。 */
export function resolveNotesFile(absPath: string): NotesFileResolution | null {
  for (const name of NOTES_FILE_PRECEDENCE) {
    const candidate = path.join(absPath, name);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.R_OK);
      return { path: candidate, name };
    } catch {
      // 缺失、不可读和非文件候选全部落到下一个名称。
    }
  }
  return null;
}

/**
 * 解析工作节点的编写契约文件，或当目录未声明节点时返回 null。
 *
 * Null 是每个调用方已经依赖的"不是已声明任务目标/slice"信号——这改变
 * 哪些文件名算数，绝不改变缺失的含义。
 */
export function resolveNodeFile(absPath: string): string | null {
  for (const name of NODE_FILE_PRECEDENCE) {
    const candidate = path.join(absPath, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 列出任务目标根目录下的任务目标文件夹。任务目标是任何
 *  包含编写节点文件（SPEC.md 或遗留 README.md）的顶层文件夹。
 *  两者都没有的目录被跳过——它们代表临时/垃圾，不是已声明任务目标。 */
export function listMissions(missionsRoot: string): MissionInfo[] {
  if (!fs.existsSync(missionsRoot)) return [];
  const entries = fs.readdirSync(missionsRoot, { withFileTypes: true });
  const out: MissionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absPath = path.join(missionsRoot, entry.name);
    const readmePath = resolveNodeFile(absPath);
    const hasReadme = readmePath !== null;
    if (!hasReadme) continue;
    const frontmatter = readFrontmatter(readmePath);
    const slicesDir = path.join(absPath, "slices");
    const closedDir = path.join(absPath, "closed");
    const activeSliceCount = countSliceDirs(slicesDir);
    const closedSliceCount = countSliceDirs(closedDir);
    const id = pickIdFromFrontmatter(frontmatter);
    out.push({
      name: entry.name,
      absPath,
      readmePath: hasReadme ? readmePath : null,
      frontmatter,
      id,
      activeSliceCount,
      closedSliceCount,
    });
  }
  // 稳定顺序：按任务目标名称。
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function countSliceDirs(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SLICE_DIRNAME_RE.test(e.name))
    .length;
}

function pickIdFromFrontmatter(fm: Record<string, unknown>): string | null {
  const candidate = fm.id ?? fm.dotId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/** 按名称或相对于任务目标根目录的路径解析任务目标。
 *  未找到或目录存在但缺少编写节点文件时抛出 ScopeCliError。
 *  无节点目录是临时/垃圾，不是已声明任务目标，
 *  因此变更命令绝不能静默定位它们。 */
export function findMission(missionsRoot: string, identifier: string): MissionInfo {
  const candidates = [
    path.join(missionsRoot, identifier),
    path.isAbsolute(identifier) ? identifier : path.resolve(missionsRoot, identifier),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      if (resolveNodeFile(candidate) === null) {
        throw new ScopeCliError({
          fact: `目录 "${identifier}" 存在于 ${candidate} 但不包含 ${NODE_FILE_PRECEDENCE.join(" 或 ")}。`,
          consequence: "它不是已声明的任务目标。命令未运行。",
          action: "用以下命令将其创建为任务目标：zrig scope mission create " + identifier + "。或者如果文件夹旨在作为任务目标，请添加 SPEC.md。",
        });
      }
      return buildMissionInfo(missionsRoot, candidate);
    }
  }
  throw new ScopeCliError({
    fact: `在 ${missionsRoot} 下未找到任务目标 "${identifier}"。`,
    consequence: "命令未运行。",
    action: "列出可用任务目标：zrig scope mission ls",
  });
}

function buildMissionInfo(missionsRoot: string, absPath: string): MissionInfo {
  const readmePath = resolveNodeFile(absPath);
  const frontmatter = readmePath ? readFrontmatter(readmePath) : {};
  return {
    name: path.basename(absPath),
    absPath,
    readmePath,
    frontmatter,
    id: pickIdFromFrontmatter(frontmatter),
    activeSliceCount: countSliceDirs(path.join(absPath, "slices")),
    closedSliceCount: countSliceDirs(path.join(absPath, "closed")),
  };
}

// ---------------------------------------------------------------------
// 切片发现
// ---------------------------------------------------------------------

export function listSlices(
  mission: MissionInfo,
  state: SliceState,
): SliceInfo[] {
  const dirs: Array<{ root: string; bucket: "active" | "closed" }> = [];
  if (state === "active" || state === "shipped" || state === "all") {
    dirs.push({ root: path.join(mission.absPath, "slices"), bucket: "active" });
  }
  if (state === "closed" || state === "all") {
    dirs.push({ root: path.join(mission.absPath, "closed"), bucket: "closed" });
  }
  const out: SliceInfo[] = [];
  for (const { root } of dirs) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = SLICE_DIRNAME_RE.exec(entry.name);
      if (!m) continue;
      const sliceInfo = buildSliceInfo(mission, root, entry.name);
      out.push(sliceInfo);
    }
  }
  out.sort((a, b) => (a.nn ?? Number.MAX_SAFE_INTEGER) - (b.nn ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));
  if (state === "active") {
    // active = 不在 closed/ 中，且尚未就地交付。
    return out.filter((s) => {
      const st = (s.status ?? "").toLowerCase();
      return st !== "done" && !st.startsWith("closed") && !st.startsWith("shipped");
    });
  }
  if (state === "shipped") {
    return out.filter((s) => (s.status ?? "").toLowerCase().startsWith("shipped"));
  }
  return out;
}

/** 读取一个任务目标的建议兄弟排序图。未知、陈旧、
 *  格式错误或跨父边被报告并忽略：图是排序提示，
 *  绝不是门禁或遍历指针。 */
export function buildMissionDependencyGraph(mission: MissionInfo): MissionDependencyGraph {
  const all = listSlices(mission, "all");
  const activePaths = new Set(listSlices(mission, "active").map((slice) => slice.absPath));
  return deriveMissionDependencyGraph({
    mission: { id: mission.id, name: mission.name, dependsOn: mission.frontmatter.depends_on },
    slices: all.map((slice) => ({
      id: slice.id,
      name: slice.name,
      dependsOn: slice.frontmatter.depends_on,
      active: activePaths.has(slice.absPath),
    })),
  });
}

function buildSliceInfo(mission: MissionInfo, sliceRoot: string, dirName: string): SliceInfo {
  const m = SLICE_DIRNAME_RE.exec(dirName);
  const nn = m ? Number(m[1]) : null;
  const slug = m ? m[2]! : null;
  const absPath = path.join(sliceRoot, dirName);
  const readmePath = resolveNodeFile(absPath);
  const frontmatter = readmePath ? readFrontmatter(readmePath) : {};
  const id = pickIdFromFrontmatter(frontmatter);
  const status = typeof frontmatter.status === "string" ? (frontmatter.status as string).toLowerCase() : null;
  return {
    name: dirName,
    absPath,
    readmePath,
    frontmatter,
    nn,
    slug,
    missionName: mission.name,
    id,
    status,
  };
}

/** 将 slice 路径（绝对、相对于基底或
 *  相对于任务目标）解析为 SliceInfo。 */
export function findSlice(
  missionsRoot: string,
  slicePath: string,
  hintMission?: string | null,
): SliceInfo {
  const candidates: string[] = [];
  if (path.isAbsolute(slicePath)) {
    candidates.push(slicePath);
  } else {
    candidates.push(path.resolve(missionsRoot, "..", slicePath));
    candidates.push(path.resolve(missionsRoot, slicePath));
    if (hintMission) {
      candidates.push(path.join(missionsRoot, hintMission, "slices", slicePath));
      candidates.push(path.join(missionsRoot, hintMission, "closed", slicePath));
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      // 向上查找所属任务目标。
      const owningMissionPath = findOwningMission(missionsRoot, candidate);
      if (!owningMissionPath) {
        throw new ScopeCliError({
          fact: `slice 路径 "${slicePath}" 解析到 ${candidate} 但未找到父任务目标。`,
          consequence: "无法确定此 slice 的任务目标上下文。",
          action: "确保 slice 位于 <missionsRoot>/<mission>/{slices,closed}/ 下。",
        });
      }
      const mission = buildMissionInfo(missionsRoot, owningMissionPath);
      const sliceRoot = path.dirname(candidate);
      return buildSliceInfo(mission, sliceRoot, path.basename(candidate));
    }
  }
  throw new ScopeCliError({
    fact: `未找到 slice "${slicePath}"。`,
    consequence: "命令未运行。",
    action: "检查路径。列出任务目标中的 slice：zrig scope slice ls --mission <name>",
  });
}

function findOwningMission(missionsRoot: string, slicePath: string): string | null {
  let dir = path.dirname(slicePath);
  while (dir.startsWith(missionsRoot) && dir !== missionsRoot) {
    if (path.dirname(dir) === missionsRoot) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

// ---------------------------------------------------------------------
// Auto-numbering
// ---------------------------------------------------------------------

/** 查找任务目标 slices/ 文件夹的下一个可用 NN。扫描
 *  slices/ 和 closed/ 两者，使编号绝不重用（§3.2）。 */
export function nextSliceNN(missionAbsPath: string): number {
  let max = 0;
  for (const subdir of ["slices", "closed"]) {
    const root = path.join(missionAbsPath, subdir);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = SLICE_DIRNAME_RE.exec(entry.name);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

/** 铸造或读取任务目标的 dot-ID。如果任务目标的 README 有
 *  `id:` 字段，返回它。否则从文件夹名称推断
 *  （release-X.Y.Z → OPR.X.Y.Z；否则转义带）。 */
export function ensureMissionId(
  mission: MissionInfo,
  missionsRoot: string,
): string {
  if (mission.id) return mission.id;
  // 先尝试 release 模式；如果匹配，无需 peer 扫描。
  try {
    const id = inferMissionDotId(mission.name, null);
    return id;
  } catch {
    // 落到转义带路径。
  }
  const peers = listMissions(missionsRoot).filter((m) => m.name !== mission.name);
  const ordinal = nextEscapeBandOrdinal(peers.map((p) => p.id));
  return inferMissionDotId(mission.name, ordinal);
}

/** 与 ensureMissionId 相同，但当推断的 id 缺失时也将其写回
 *  任务目标的 README frontmatter。在每个铸造子 id 的位置使用
 *  （slice create / ship / move target）——按约定的延迟采用规则：
 *  当在没有 id 的已有父节点下创建子节点时，同时按需分配父节点的
 *  id。狭窄、单父、创建触发；绝不批量迁移。 */
export function ensureMissionIdPersisted(
  mission: MissionInfo,
  missionsRoot: string,
): string {
  const id = ensureMissionId(mission, missionsRoot);
  if (!mission.id && mission.readmePath) {
    updateFrontmatter(mission.readmePath, { id });
    // 在内存中的 MissionInfo 上反映写入，使同一命令中的后续
    // 调用方不会重新铸造不同的序号。
    mission.id = id;
  }
  return id;
}

// ---------------------------------------------------------------------
// Git 移动
// ---------------------------------------------------------------------

/** 返回路径的 git 顶层，或如果不在仓库内则返回 null。 */
export function gitTopLevel(absPath: string): string | null {
  const dir = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() ? absPath : path.dirname(absPath);
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 拒绝移动有未提交本地更改的路径。捕获
 *  §11.1 / §3.4 中的"脏工作树"风险——`git mv` 会静默
 *  带走用户进行中的编辑。 */
export function assertCleanWorkingTree(repoRoot: string, relPath: string): void {
  let status: string;
  try {
    status = execFileSync(
      "git",
      ["-C", repoRoot, "status", "--porcelain", "--", relPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    throw new ScopeCliError({
      fact: `在 ${repoRoot} 中对 ${relPath} 执行 git status 失败：${(err as Error).message}`,
      consequence: "无法验证 slice 的工作树状态。移动已中止。",
      action: "检查 " + repoRoot + " 处的仓库并重试。",
    });
  }
  if (status.trim().length > 0) {
    throw new ScopeCliError({
      fact: `${relPath} 下的工作树有未提交的更改：\n${status.trimEnd()}`,
      consequence: "拒绝 git mv——你的本地编辑会随 slice 静默移动。",
      action: "提交（git commit -m '...'）或暂存（git stash）后重试。",
    });
  }
}

/** 在仓库内时使用 `git mv` 移动目录；不在时回退到
 *  `fs.renameSync` 并发出警告。使用了 git 时返回 true。 */
export function moveSlice(srcAbs: string, destAbs: string, opts: {
  /** 暂存移动（默认 true）。git mv 默认暂存；我们
   *  保留该语义。 */
  commit?: boolean;
} = {}): { usedGit: boolean; repoRoot: string | null } {
  if (!fs.existsSync(srcAbs)) {
    throw new ScopeCliError({
      fact: `源路径 ${srcAbs} 不存在。`,
      consequence: "移动未运行。",
      action: "验证 slice 路径并重试。",
    });
  }
  if (fs.existsSync(destAbs)) {
    throw new ScopeCliError({
      fact: `目标路径 ${destAbs} 已存在。`,
      consequence: "拒绝覆盖已有 slice。",
      action: "选择不同的目标，或先移除已有文件夹。",
    });
  }
  const destParent = path.dirname(destAbs);
  const destParentExisted = fs.existsSync(destParent);
  const removeEmptyCreatedParent = (): void => {
    if (!destParentExisted && fs.existsSync(destParent) && fs.readdirSync(destParent).length === 0) {
      fs.rmdirSync(destParent);
    }
  };
  const repoRoot = gitTopLevel(srcAbs);
  if (!repoRoot) {
    fs.mkdirSync(destParent, { recursive: true });
    try {
      fs.renameSync(srcAbs, destAbs);
    } catch (error) {
      removeEmptyCreatedParent();
      throw error;
    }
    return { usedGit: false, repoRoot: null };
  }
  // 规范化符号链接（macOS /var/folders → /private/var/folders）使
  // path.relative 产生仓库内路径，而不是 ../../escape。
  const realSrcAbs = fs.realpathSync(srcAbs);
  const srcRel = path.relative(repoRoot, realSrcAbs);
  assertCleanWorkingTree(repoRoot, srcRel);
  fs.mkdirSync(destParent, { recursive: true });
  const realDestParent = fs.realpathSync(destParent);
  const realDestAbs = path.join(realDestParent, path.basename(destAbs));
  const destRel = path.relative(repoRoot, realDestAbs);
  try {
    execFileSync("git", ["-C", repoRoot, "mv", srcRel, destRel], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    removeEmptyCreatedParent();
    throw new ScopeCliError({
      fact: `git mv ${srcRel} ${destRel} 失败：${(err as Error).message}`,
      consequence: "移动已中止；源未变。",
      action: "检查仓库状态并重试。",
    });
  }
  if (opts.commit) {
    // 未来钩子；v0 不自动提交。
  }
  return { usedGit: true, repoRoot };
}

/** 仅在失败的 scope 组合命令内使用的尽力逆操作。 */
export function rollbackMovedSlice(
  srcAbs: string,
  destAbs: string,
  move: { usedGit: boolean; repoRoot: string | null },
): void {
  if (!fs.existsSync(destAbs) || fs.existsSync(srcAbs)) return;
  if (!move.usedGit || !move.repoRoot) {
    fs.renameSync(destAbs, srcAbs);
    return;
  }
  const srcRel = path.relative(move.repoRoot, fs.realpathSync(path.dirname(srcAbs)) + path.sep + path.basename(srcAbs));
  const destRel = path.relative(move.repoRoot, fs.realpathSync(destAbs));
  execFileSync("git", ["-C", move.repoRoot, "mv", destRel, srcRel], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------

export function todayDateISO(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export { DEFAULT_PROJECT_PREFIX };
