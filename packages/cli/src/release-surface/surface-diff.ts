// OPR.0.3.3.13.1 —— CLI 表面 diff（slice 13 的第 1 个组件）。
//
// 给定两个 git ref，用 `git show` 在每个 ref 上读取 `packages/cli/src/commands/*.ts`，
// 抽取 Commander 表面（extract-surface.ts），做 diff，产出确定性的
// `release-surface-diff.yaml`。完全离线且确定：唯一输入是两个 ref + 仓库的 git
// 对象库；不联网、无 agent/LLM 参与（slice 13“枚举靠确定性、措辞靠 agent”分工里
// 的确定性那一半）。

import { execFileSync } from "node:child_process";
import { stringify } from "yaml";

import { extractSurfaceFromSources, FLAG_SEP, type Surface } from "./extract-surface.js";

const COMMANDS_DIR = "packages/cli/src/commands";

export interface AddedCommand {
  name: string;
  subcommands: string[];
}
export interface AddedFlagsEntry {
  command: string;
  flags?: string[];
  subcommands?: string[];
}
export interface SurfaceDiff {
  release_from: string;
  release_to: string;
  added_commands: AddedCommand[];
  added_flags: AddedFlagsEntry[];
  removed_or_renamed: string[];
}

/** 与仓库 CLI 错误形态一致的三段式错误（见 queue.ts:88-111）。 */
export class SurfaceParserError extends Error {
  readonly fact: string;
  readonly consequence: string;
  readonly action: string;
  constructor(parts: { fact: string; consequence: string; action: string }) {
    super(parts.fact);
    this.name = "SurfaceParserError";
    this.fact = parts.fact;
    this.consequence = parts.consequence;
    this.action = parts.action;
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function firstToken(path: string): string {
  return path.split(" ")[0] ?? "";
}

function splitFlagEntry(entry: string): { command: string; flag: string } {
  const i = entry.indexOf(FLAG_SEP);
  return { command: entry.slice(0, i), flag: entry.slice(i + FLAG_SEP.length) };
}

export function resolveRepoRoot(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new SurfaceParserError({
      fact: `不在 git 仓库内（cwd: ${cwd}）。`,
      consequence: "表面解析器要在两个 git ref 上读取 CLI 源码；没有仓库就无法运行。",
      action: "请在 openrig git 仓库内运行，或显式传入 repoRoot。",
    });
  }
}

interface TreeEntry {
  sha: string;
  path: string;
}

function listCommandTree(repoRoot: string, ref: string): TreeEntry[] {
  let out: string;
  try {
    out = git(repoRoot, ["ls-tree", ref, `${COMMANDS_DIR}/`]);
  } catch (err) {
    throw new SurfaceParserError({
      fact: `无法在 ref "${ref}" 下列出 ${COMMANDS_DIR}/：${String((err as Error).message).split("\n")[0]}`,
      consequence: "无法读取该 ref 的 CLI 表面，因此未产出发布面 diff。",
      action: `请确认该 ref 存在（git rev-parse "${ref}"）且该 ref 上存在 ${COMMANDS_DIR}/。`,
    });
  }
  const entries: TreeEntry[] = [];
  for (const line of out.split("\n")) {
    // "<mode> blob <sha>\t<path>"
    const m = line.match(/^\S+\s+blob\s+(\S+)\t(.+)$/);
    if (!m) continue;
    const path = m[2]!;
    if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("/index.ts")) {
      entries.push({ sha: m[1]!, path });
    }
  }
  if (entries.length === 0) {
    throw new SurfaceParserError({
      fact: `在 ref "${ref}" 的 ${COMMANDS_DIR}/ 下未找到 Commander 命令文件。`,
      consequence: "空的命令布局会让 diff 错误地把整个表面都报为新增或移除。",
      action: `请确认 ${COMMANDS_DIR}/ 在 "${ref}" 上存在，且其中存放 CLI 命令注册。`,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

// 一次 `git cat-file --batch` 读取某个 ref 的全部 blob（相比每文件一次 `git show`）。
// 让解析器快到可反复运行（且确定性测试能在超时内完成）。字节精确：cat-file 按请求顺序、
// 对每个 oid 输出 `<oid> blob <size>\n`，接着恰好 <size> 字节内容，再 `\n`。
function readBlobs(repoRoot: string, entries: TreeEntry[]): Map<string, string> {
  const input = entries.map((e) => e.sha).join("\n") + "\n";
  const buf = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input,
    maxBuffer: 128 * 1024 * 1024,
  }) as unknown as Buffer;
  const result = new Map<string, string>();
  let pos = 0;
  for (const entry of entries) {
    const nl = buf.indexOf(0x0a, pos);
    const header = buf.toString("utf8", pos, nl);
    const size = Number.parseInt(header.split(" ")[2] ?? "", 10);
    if (!Number.isFinite(size)) {
      throw new SurfaceParserError({
        fact: `git cat-file 返回了 blob ${entry.sha} 的不可读记录（"${header}"）。`,
        consequence: "命令源码无法读取，表面 diff 会出错。",
        action: "请确认仓库对象库完好（git fsck）且 ref 有效。",
      });
    }
    const contentStart = nl + 1;
    result.set(entry.sha, buf.toString("utf8", contentStart, contentStart + size));
    pos = contentStart + size + 1; // 跳过内容 + 末尾换行
  }
  return result;
}

function readSurfaceAtRef(repoRoot: string, ref: string): Surface {
  const entries = listCommandTree(repoRoot, ref);
  const blobs = readBlobs(repoRoot, entries);
  const sources = entries.map((e) => ({ name: e.path, text: blobs.get(e.sha) ?? "" }));
  return extractSurfaceFromSources(sources);
}

/** 把两个已抽取表面做纯 diff，输出 slice-13 的 YAML 形态。 */
export function computeDiff(
  from: Surface,
  to: Surface,
  releaseFrom: string,
  releaseTo: string,
): SurfaceDiff {
  const addedCmdPaths = [...to.commands].filter((c) => !from.commands.has(c));
  const removedCmdPaths = [...from.commands].filter((c) => !to.commands.has(c));
  const addedFlagEntries = [...to.flags].filter((f) => !from.flags.has(f));
  const removedFlagEntries = [...from.flags].filter((f) => !to.flags.has(f));

  const addedCmdSet = new Set(addedCmdPaths);
  // 当一个单 token 路径被新增时，该顶层命令是全新的。
  const newTopCommands = new Set(addedCmdPaths.filter((p) => !p.includes(" ")));

  // added_commands：每个全新顶层命令 + 其新增的子路径。
  const added_commands: AddedCommand[] = [...newTopCommands].sort().map((name) => ({
    name,
    subcommands: addedCmdPaths
      .filter((p) => p !== name && firstToken(p) === name)
      .map((p) => p.split(" ").slice(1).join(" "))
      .sort(),
  }));

  // added_flags：新增了 flag 的【既有】命令（按完整命令路径为键）和/或
  // 新增子命令（按其所属既有顶层命令为键）。
  const flagsByCommand = new Map<string, Set<string>>();
  for (const entry of addedFlagEntries) {
    const { command, flag } = splitFlagEntry(entry);
    if (newTopCommands.has(firstToken(command))) continue; // 新命令 → flag 已由 added_commands 隐含
    if (addedCmdSet.has(command)) continue; // 全新子命令 → flag 已由其列表隐含
    if (!flagsByCommand.has(command)) flagsByCommand.set(command, new Set());
    flagsByCommand.get(command)!.add(flag);
  }
  const subsByTop = new Map<string, Set<string>>();
  for (const p of addedCmdPaths) {
    if (!p.includes(" ")) continue; // 全新顶层命令（已在 added_commands）
    const top = firstToken(p);
    if (newTopCommands.has(top)) continue; // 属于某个全新顶层命令的子树
    if (!subsByTop.has(top)) subsByTop.set(top, new Set());
    subsByTop.get(top)!.add(p.split(" ").slice(1).join(" "));
  }
  const changedCommands = new Set<string>([...flagsByCommand.keys(), ...subsByTop.keys()]);
  const added_flags: AddedFlagsEntry[] = [...changedCommands].sort().map((command) => {
    const entry: AddedFlagsEntry = { command };
    const fl = flagsByCommand.get(command);
    if (fl && fl.size > 0) entry.flags = [...fl].sort();
    const sub = subsByTop.get(command);
    if (sub && sub.size > 0) entry.subcommands = [...sub].sort();
    return entry;
  });

  const removed_or_renamed = [
    ...removedCmdPaths,
    ...removedFlagEntries.map((e) => {
      const { command, flag } = splitFlagEntry(e);
      return `${command} ${flag}`;
    }),
  ].sort();

  return { release_from: releaseFrom, release_to: releaseTo, added_commands, added_flags, removed_or_renamed };
}

/** `--from` 的默认值：在 `to` 之前可达的最新 `v*` 标签。 */
function defaultFrom(repoRoot: string, to: string): string {
  try {
    return git(repoRoot, ["describe", "--tags", "--abbrev=0", "--match", "v*", `${to}^`]).trim();
  } catch {
    try {
      return git(repoRoot, ["describe", "--tags", "--abbrev=0", "--match", "v*"]).trim();
    } catch {
      throw new SurfaceParserError({
        fact: "无法为默认的 --from ref 解析出任何发布标签。",
        consequence: "没有先前的发布 ref，就无法计算表面 diff。",
        action: "请显式传入 --from <ref>（例如 --from v0.3.1）。",
      });
    }
  }
}

export function generateSurfaceDiff(opts: {
  from?: string;
  to?: string;
  cwd?: string;
  repoRoot?: string;
}): SurfaceDiff {
  const repoRoot = opts.repoRoot ?? resolveRepoRoot(opts.cwd ?? process.cwd());
  const to = opts.to ?? "HEAD";
  const from = opts.from ?? defaultFrom(repoRoot, to);
  const fromSurface = readSurfaceAtRef(repoRoot, from);
  const toSurface = readSurfaceAtRef(repoRoot, to);
  return computeDiff(fromSurface, toSurface, from, to);
}

/** 确定性的 YAML 序列化（key 与元素顺序稳定）。 */
export function diffToYaml(diff: SurfaceDiff): string {
  return stringify(diff, { sortMapEntries: false });
}
