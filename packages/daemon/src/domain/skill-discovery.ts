// V0.3.0 daemon-skill-discovery——文件系统技能扫描与结构校验。它补齐了 profile-resolver
// 只能看到 `agent.yaml` 的 `resources.skills` 和 imports、却看不到用户库或工作组随附路径中
// 技能的缺口。
//
// Validator 现在判断的是“Claude Code 或 Codex 看到这个目录时是否会实际加载”，即是否存在
// 含 name、description 和正文的 SKILL.md。后台服务硬编码的共享 bundle 不再充当门禁。
//
// SC-29 例外 #7 已在 slice ACK §5 声明。

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillResource } from "./types.js";

export type SkillRuntime = "claude-code" | "codex";

export interface SkillDiscoveryPaths {
  runtime: SkillRuntime;
  /** 操作者主目录；由后台服务启动时解析，不在此通过 os.homedir() 读取，便于测试注入 fixture 根。 */
  homedir: string;
  /** 智能体已解析的工作目录；工作组随附技能位于 <cwd>/.claude/skills/ 或 <cwd>/.agents/skills/。 */
  cwd: string;
  /** 工作组 spec 安装目录；随附领域技能位于 <specInstallDir>/skills/<name>/。可选：
   * undefined 表示工作组原地安装，不适用独立安装目录。 */
  specInstallDir?: string;
  /** 配置解析出的受管 catalog 根目录。为兼容旧版，省略时默认为 <homedir>/.openrig/skills。 */
  skillsRoot?: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** 运行时可能消费的其他字段（allowed-tools、model 等）不经校验直接透传；
   * 它们不承载后台服务资源校验。 */
  [key: string]: unknown;
}

export type ParseResult =
  | { ok: true; frontmatter: SkillFrontmatter; body: string }
  | { ok: false; reason: string };

export interface SkillRejection {
  path: string;
  reason: string;
}

export interface SkillDiscoveryResult {
  skills: SkillResource[];
  rejected: SkillRejection[];
}

export type SourceKind = "rig_bundled" | "spec_install" | "runtime_user" | "shared_user";

export interface SkillProvenanceEntry {
  id: string;
  path: string;
  sourceRoot: string;
  sourceKind: SourceKind;
  frontmatter: SkillFrontmatter;
  body: string;
  shadowed: boolean;
}

export interface SkillProvenanceResult {
  skills: SkillProvenanceEntry[];
  rejected: SkillRejection[];
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/** 将 SKILL.md 解析为 frontmatter + 正文，并校验 Claude Code 与 Codex 共同要求的形状：
 * 由 `---` 行定界的 YAML frontmatter，至少包含 `name` 与 `description`，且正文非空。 */
export function parseSkillFrontmatter(content: string): ParseResult {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { ok: false, reason: "缺少由 --- 行定界的 YAML frontmatter" };
  }
  const [, fmText, body] = match;

  let parsed: unknown;
  try {
    parsed = parseYaml(fmText!);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `frontmatter YAML 解析错误：${msg}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "frontmatter 不是 YAML mapping" };
  }
  const fm = parsed as Record<string, unknown>;

  if (typeof fm.name !== "string" || fm.name.trim().length === 0) {
    return { ok: false, reason: "frontmatter 缺少必填 `name` 字段" };
  }
  if (typeof fm.description !== "string" || fm.description.trim().length === 0) {
    return { ok: false, reason: "frontmatter 缺少必填 `description` 字段" };
  }

  if (!body || body.trim().length === 0) {
    return { ok: false, reason: "SKILL.md 正文为空（运行时将无内容可加载）" };
  }

  return {
    ok: true,
    frontmatter: { ...fm, name: fm.name as string, description: fm.description as string } as SkillFrontmatter,
    body,
  };
}

/** 通过扫描规范文件系统路径并逐个做结构校验，发现指定运行时的技能。返回已接受技能的
 * SkillResource 记录（id 来自 frontmatter，path 指向技能目录）以及拒绝列表，使调用方能在
 * 校验失败时显示明确错误。 */
export function discoverSkillsForRuntime(paths: SkillDiscoveryPaths): SkillDiscoveryResult {
  const scanRoots = listScanRoots(paths);
  const skills: SkillResource[] = [];
  const rejected: SkillRejection[] = [];
  const seenIds = new Set<string>();

  for (const root of scanRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      // 权限/I/O 错误时静默跳过；本扫描为尽力而为。
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(root, entry);
      let stat;
      try { stat = statSync(skillDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) {
        // 不是技能时静默跳过；不含 SKILL.md 的目录可能是无关内容，也可能是操作者尚未完成的技能。
        continue;
      }

      let content: string;
      try {
        content = readFileSync(skillFile, "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rejected.push({ path: skillDir, reason: `SKILL.md 读取错误：${msg}` });
        continue;
      }

      const parsed = parseSkillFrontmatter(content);
      if (!parsed.ok) {
        rejected.push({ path: skillDir, reason: parsed.reason });
        continue;
      }

      const id = parsed.frontmatter.name;
      if (seenIds.has(id)) {
        // 优先级列表中更早的根已经提供该 id；后续同名项会被 listScanRoots 顺序编码的
        // “最具体者优先”规则遮蔽。
        continue;
      }
      seenIds.add(id);
      skills.push({ id, path: skillDir });
    }
  }

  return { skills, rejected };
}

/** 构建指定运行时按优先级排序的扫描根列表。冲突时前项胜出（最具体者优先）：cwd 中工作组随附
 * > spec-install-dir > 用户库。用户库内部，运行时专属目录优先于共享 ~/.openrig/skills/ 池，
 * 使操作者显式安装的 Claude-only 或 Codex-only 版本优先于跨运行时版本。 */
function listScanRoots(paths: SkillDiscoveryPaths): string[] {
  const { runtime, homedir, cwd, specInstallDir } = paths;
  const runtimeDir = runtime === "claude-code" ? ".claude" : ".agents";
  const roots: string[] = [];

  // 1. cwd 中工作组随附的技能（最具体，与工作组源码一起提供）。
  roots.push(join(cwd, runtimeDir, "skills"));

  // 2. spec-install-dir 随附技能（随工作组打包但安装在独立路径，例如从 `zrig up <bundle>` 解压）。
  if (specInstallDir) roots.push(join(specInstallDir, "skills"));

  // 3. 运行时专属用户库（操作者安装的 Claude-only 或 Codex-only 技能）。
  roots.push(join(homedir, runtimeDir, "skills"));

  // 4. 共享用户 spec 库（通过 `zrig specs add` 安装的跨运行时技能）。
  roots.push(paths.skillsRoot ?? join(homedir, ".openrig", "skills"));

  return roots;
}

function rootToSourceKind(root: string, paths: SkillDiscoveryPaths): SourceKind {
  const runtimeDir = paths.runtime === "claude-code" ? ".claude" : ".agents";
  const rigBundled = join(paths.cwd, runtimeDir, "skills");
  if (root === rigBundled) return "rig_bundled";
  if (paths.specInstallDir && root === join(paths.specInstallDir, "skills")) return "spec_install";
  const runtimeUser = join(paths.homedir, runtimeDir, "skills");
  if (root === runtimeUser) return "runtime_user";
  return "shared_user";
}

export function discoverSkillsWithProvenance(paths: SkillDiscoveryPaths): SkillProvenanceResult {
  const scanRoots = listScanRoots(paths);
  const skills: SkillProvenanceEntry[] = [];
  const rejected: SkillRejection[] = [];
  const seenIds = new Set<string>();

  for (const root of scanRoots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }

    for (const entry of entries) {
      const skillDir = join(root, entry);
      let stat;
      try { stat = statSync(skillDir); } catch { continue; }
      if (!stat.isDirectory()) continue;

      const skillFile = join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      let content: string;
      try { content = readFileSync(skillFile, "utf-8"); } catch (err) {
        rejected.push({ path: skillDir, reason: `SKILL.md 读取错误：${err instanceof Error ? err.message : String(err)}` });
        continue;
      }

      const parsed = parseSkillFrontmatter(content);
      if (!parsed.ok) {
        rejected.push({ path: skillDir, reason: parsed.reason });
        continue;
      }

      const id = parsed.frontmatter.name;
      const sourceKind = rootToSourceKind(root, paths);
      skills.push({
        id,
        path: skillDir,
        sourceRoot: root,
        sourceKind,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        shadowed: seenIds.has(id),
      });
      seenIds.add(id);
    }
  }

  return { skills, rejected };
}
