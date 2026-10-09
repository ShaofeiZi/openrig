// OPR.0.3.3.13.2 - Skill <-> CLI 表面绑定索引查找（slice 13 的组件 2）。
//
// 给定一个发布 surface-diff（13.1 的确定性输出，surface-diff.ts）和
// 一组携带 `metadata.cli_surfaces_referenced` 的 skill，返回哪些 skill
// 受发布影响。完全确定性 + 离线（AC-4）：匹配是对 diff + 提供的 skill
// 索引的纯集合/字符串操作；语料库加载器是普通文件系统读取。
// 无网络、无智能体/LLM——与 13.1 的确定性半部分组合。
// 13.3（写入 skill 更新的调度器）决定调用；这保持调用无关。
//
// 连接语法——顾问批准（qitem-20260608235706-64ba9ef2；见 slice
// governance-watch.md SHARP WATCH #1）：
//  - Skill token 不带 `rig ` 前缀存储，使用 13.1 的命令路径语法
//    （`scope slice create`、`queue create`）。我们防御性地剥离前导
//    `rig `，使得两种写法的 skill 都能匹配。
//  - 已更改表面集：每个 `added_commands`，`{name}` 加上 `{name + " " +
//    每个子命令}`；每个 `added_flags`，`{command}` 加上 `{command + " " +
//    每个子命令}`。（13.1 输出 `added_commands[].name` 作为裸顶层名称，
//    深度路径在单独的 `subcommands` 列表中，因此集合必须展开——
//    朴素的仅名称交集会漏匹配 `scope slice create`。）
//  - 匹配 = 逐组件（路径段）前缀，任一方向（不是原始字符串前缀——
//    因此 `up` 不匹配 `update`）。偏见刻意保守：双向前缀过度包含，
// 绝不不足包含，这正是 AC-3 硬性无假阴性 floor 所需要的。
//    过度包含是 AC-3 允许的"解释性额外项"。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { SurfaceDiff } from "./surface-diff.js";

/**
 * 将命令 token 拆为路径段，剥离前导 `rig ` 并折叠内部空白。
 * `"rig scope slice create"` -> `["scope", "slice", "create"]`；
 * `"queue create"` -> `["queue", "create"]`。
 */
export function toSegments(token: string): string[] {
  const stripped = token.trim().replace(/^rig\s+/, "");
  return stripped.split(/\s+/).filter((segment) => segment.length > 0);
}

/**
 * 第 3 节已更改表面集：发布触及的每个命令路径字符串，
 * 从 diff 的裸顶层 + 子命令列表语法展开。这是 AC-3a 目标
 * （针对 13.1 发布的示例 diff + fixture 验证）。
 */
export function expandChangedSurface(diff: SurfaceDiff): Set<string> {
  const set = new Set<string>();
  for (const cmd of diff.added_commands ?? []) {
    if (cmd.name) set.add(cmd.name);
    for (const sub of cmd.subcommands ?? []) {
      if (sub) set.add(`${cmd.name} ${sub}`);
    }
  }
  for (const entry of diff.added_flags ?? []) {
    if (entry.command) set.add(entry.command);
    for (const sub of entry.subcommands ?? []) {
      if (sub) set.add(`${entry.command} ${sub}`);
    }
  }
  return set;
}

/**
 * 任一方向的逐组件前缀匹配：当一个段列表等于或是另一个的
 * 路径段前缀时为 true。逐段比较到较短长度——因此
 * `["scope"]` 匹配 `["scope","slice","create"]`（反之亦然），
 * 但 `["up"]` 不匹配 `["update"]`（第一个段不同）。
 * 这是顾问对原始字符串前缀的锐化。
 */
export function pathsMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const shorter = Math.min(a.length, b.length);
  for (let i = 0; i < shorter; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** skill token 是否匹配已更改表面集中的任何路径？ */
export function skillTokenMatches(skillToken: string, changedSurface: Set<string>): boolean {
  const tokenSegments = toSegments(skillToken);
  if (tokenSegments.length === 0) return false;
  for (const changed of changedSurface) {
    if (pathsMatch(tokenSegments, toSegments(changed))) return true;
  }
  return false;
}

export interface SkillIndexEntry {
  /** Skill 目录名（规范 skill id）。 */
  name: string;
  /** skill 的 `metadata.cli_surfaces_referenced` token（13.1 语法）。 */
  cliSurfacesReferenced: string[];
}

/**
 * AC-3b：受影响 skill 输出。当 skill 的任何
 * `cli_surfaces_referenced` token 匹配已更改表面集时，它受影响。
 * 返回排序、去重的 skill 名列表——对给定的
 * (diff, skills) 对确定性（AC-4）。
 */
export function computeAffectedSkills(diff: SurfaceDiff, skills: SkillIndexEntry[]): string[] {
  const changed = expandChangedSurface(diff);
  const affected = new Set<string>();
  for (const skill of skills) {
    const hit = (skill.cliSurfacesReferenced ?? []).some((token) =>
      skillTokenMatches(token, changed),
    );
    if (hit) affected.add(skill.name);
  }
  return [...affected].sort();
}

/**
 * 从 SKILL.md frontmatter 块解析 `metadata.cli_surfaces_referenced`。
 * 当没有 frontmatter、没有 metadata 块或字段缺失/格式错误时返回 []
 * （没有 CLI 表面的 skill 根本不在索引中）。
 */
export function parseCliSurfaces(skillMarkdown: string): string[] {
  const match = skillMarkdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  let meta: unknown;
  try {
    meta = parse(match[1]!);
  } catch {
    return [];
  }
  const field = (meta as { metadata?: { cli_surfaces_referenced?: unknown } })
    ?.metadata?.cli_surfaces_referenced;
  if (!Array.isArray(field)) return [];
  return field.filter((value): value is string => typeof value === "string");
}

/**
 * 从 skills-root 目录加载 skill 索引（离线 fs 读取）。
 * 每个直接子目录包含一个 SKILL.md 且有非空
 * `cli_surfaces_referenced`，成为一个索引条目。按名称排序。
 */
export function loadSkillIndex(skillsRoot: string): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];
  for (const dirent of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    let text: string;
    try {
      text = readFileSync(join(skillsRoot, dirent.name, "SKILL.md"), "utf8");
    } catch {
      continue; // 此目录中没有 SKILL.md
    }
    const tokens = parseCliSurfaces(text);
    if (tokens.length > 0) {
      entries.push({ name: dirent.name, cliSurfacesReferenced: tokens });
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
