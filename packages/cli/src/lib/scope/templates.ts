// release-0.3.2 slice 12 — 模板加载器。模板以 Markdown 文件形式与源码
// 放在一起，便于像普通文档一样编辑。构建时通过 tsconfig 的
// rootDir/files 行为把它们复制到 dist/——但 .md 不是 .ts 文件，
// 因此我们通过 fileURLToPath 直接读取，以保证本地开发和发布包布局下都能工作。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MissionTemplateKind, SliceTemplateKind } from "./types.js";
import { ScopeCliError } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 候选模板根目录，按顺序排列：源码树（开发）、dist（构建后）。
 *  在调用时解析，第一个存在的目录胜出。 */
function candidateRoots(): string[] {
  return [
    // 开发环境：packages/cli/src/lib/scope/ → ../scope-templates
    path.resolve(here, "..", "scope-templates"),
    // 构建后：dist/lib/scope/ → ../../lib/scope-templates
    // （若 dist 落在 packages/cli/dist/lib/scope，则再向上一级）。
    path.resolve(here, "..", "..", "lib", "scope-templates"),
    // 兜底：编译后 dist 相对源码树的位置（当源码随包发布时）。
    path.resolve(here, "..", "..", "..", "src", "lib", "scope-templates"),
  ];
}

/** 把文件名拆成基名和扩展名，例如 notes.md → { base: "notes", ext: ".md" }。 */
function splitTemplateName(filename: string): { base: string; ext: string } {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return { base: filename, ext: "" };
  return { base: filename.slice(0, idx), ext: filename.slice(idx) };
}

/** 解析模板文件路径。
 *
 * 中文化策略：优先查找 `*.zh-CN.<ext>` 伴随版（面向用户的默认模板），
 * 若不存在则安全回落英文原版。Markdown 伴随版由 docs-packages-a 负责提供；
 * 在伴随版尚未创建时，本函数始终回落到英文模板，行为与之前完全一致。
 * 模板中的机读占位符（{{id}} 等）和固定标题在伴随版中保持兼容，
 * 不影响 scope parser。 */
function resolveTemplate(filename: string): string {
  const { base, ext } = splitTemplateName(filename);
  const zhName = `${base}.zh-CN${ext}`;
  for (const root of candidateRoots()) {
    // 优先中文伴随版
    const zhCandidate = path.join(root, zhName);
    if (fs.existsSync(zhCandidate)) return zhCandidate;
  }
  for (const root of candidateRoots()) {
    const candidate = path.join(root, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new ScopeCliError({
    fact: `找不到模板文件 ${filename}。`,
    consequence: "无法脚手架化新建的产物。",
    action: "请重新安装 @openrig/cli，或在包含 packages/cli/src/lib/scope-templates/ 的检出目录中运行。",
  });
}

export interface RenderOpts {
  id: string;
  slice_number?: string;     // 零填充；仅用于 slice 模板
  slug: string;
  mission: string;
  title: string;
  created_date: string;
  /** 编写用途。为向后兼容调用方默认取 title。 */
  intent?: string;
  /** 指向兄弟工作节点 dot-ID 的建议构建顺序边。 */
  depends_on?: string[];
  release_version?: string;
  intent_visual_image_path?: string;
  intent_visual_diff_path?: string;
  intent_visual_build_command?: string;
}

function applyPlaceholders(content: string, opts: RenderOpts): string {
  return content
    .replace(/\{\{id\}\}/g, opts.id)
    .replace(/\{\{slice_number\}\}/g, opts.slice_number ?? "")
    .replace(/\{\{slug\}\}/g, opts.slug)
    .replace(/\{\{mission\}\}/g, opts.mission)
    .replace(/\{\{title\}\}/g, opts.title)
    .replace(/\{\{created_date\}\}/g, opts.created_date)
    .replace(/\{\{intent_yaml\}\}/g, JSON.stringify(opts.intent ?? opts.title))
    .replace(/\{\{intent\}\}/g, opts.intent ?? opts.title)
    .replace(/\{\{depends_on\}\}/g, JSON.stringify(opts.depends_on ?? []))
    .replace(/\{\{release_version\}\}/g, opts.release_version ?? "")
    .replace(/\{\{intent_visual_image_path\}\}/g, opts.intent_visual_image_path ?? "./intent.png")
    .replace(/\{\{intent_visual_diff_path\}\}/g, opts.intent_visual_diff_path ?? "./change.diff")
    .replace(/\{\{intent_visual_build_command\}\}/g, opts.intent_visual_build_command ?? "TWIN_ROUTE=<route> npm run twin:build");
}

export function renderSliceTemplate(kind: SliceTemplateKind, opts: RenderOpts): string {
  const filename = `${kind}.md`;
  const raw = fs.readFileSync(resolveTemplate(filename), "utf8");
  return applyPlaceholders(raw, opts);
}

/** 旧渲染器，为读取或修复旧约定树的调用方保留。
 *  新的 scope 脚手架不再调用它。 */
export function renderImplementationPrdTemplate(opts: RenderOpts): string {
  const raw = fs.readFileSync(resolveTemplate("implementation-prd.md"), "utf8");
  return applyPlaceholders(raw, opts);
}

export function renderMissionTemplate(kind: MissionTemplateKind, opts: RenderOpts): string {
  const filename = kind === "release" ? "mission-release.md" : "mission-placeholder.md";
  const raw = fs.readFileSync(resolveTemplate(filename), "utf8");
  return applyPlaceholders(raw, opts);
}

export function renderCapabilityDeltaTemplate(opts: RenderOpts): string {
  const raw = fs.readFileSync(resolveTemplate("capability-delta.md"), "utf8");
  return applyPlaceholders(raw, opts);
}

export interface NotesRenderOpts {
  mission_id: string;
  mission_name: string;
  created_date: string;
}

function applyNotesPlaceholders(content: string, opts: NotesRenderOpts): string {
  return content
    .replace(/\{\{mission_id\}\}/g, opts.mission_id)
    .replace(/\{\{mission_name\}\}/g, opts.mission_name)
    .replace(/\{\{created_date\}\}/g, opts.created_date);
}

export type NotesTemplateSource = "env" | "legacy-env" | "built-in";

/** 解析当前 NOTES.md 模板。已弃用的环境变量名仍可作为回退，
 *  并以 `legacy-env` 暴露给调用方。 */
export function resolveNotesTemplatePath(envValue?: string): { absPath: string; resolvedFrom: NotesTemplateSource } {
  const current = envValue ?? process.env.OPENRIG_NOTES_TEMPLATE_PATH;
  const legacy = envValue === undefined ? process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH : undefined;
  const selected = current?.trim() ? current : legacy?.trim() ? legacy : null;
  const resolvedFrom: NotesTemplateSource = current?.trim()
    ? "env"
    : legacy?.trim()
      ? "legacy-env"
      : "built-in";
  if (selected) {
    const absPath = path.resolve(selected);
    if (!fs.existsSync(absPath)) {
      const variable = resolvedFrom === "legacy-env"
        ? "OPENRIG_MISSION_NOTES_TEMPLATE_PATH"
        : "OPENRIG_NOTES_TEMPLATE_PATH";
      throw new ScopeCliError({
        fact: `${variable} 指向 "${selected}"，但该路径不存在。`,
        consequence: "未脚手架化 NOTES.md。",
        action: `请将 OPENRIG_NOTES_TEMPLATE_PATH 设为一个可读的绝对模板路径，或取消设置 ${variable} 以使用内置回退。`,
      });
    }
    return { absPath, resolvedFrom };
  }
  return { absPath: resolveTemplate("notes.md"), resolvedFrom };
}

export function renderNotesTemplate(
  opts: NotesRenderOpts,
  envValue?: string,
): { rendered: string; resolvedFrom: NotesTemplateSource; absPath: string } {
  const resolved = resolveNotesTemplatePath(envValue);
  return {
    rendered: applyNotesPlaceholders(fs.readFileSync(resolved.absPath, "utf8"), opts),
    ...resolved,
  };
}

export function renderMissionProgressTemplate(missionName: string): string {
  const raw = fs.readFileSync(resolveTemplate("mission-progress.md"), "utf8");
  return raw.replace(/\{\{missionName\}\}/g, missionName);
}

export function renderSliceProgressTemplate(sliceName: string): string {
  const raw = fs.readFileSync(resolveTemplate("slice-progress.md"), "utf8");
  return raw.replace(/\{\{sliceName\}\}/g, sliceName);
}

export interface SliceProofRenderOpts {
  id: string;
  title: string;
}

export function renderSliceProofTemplate(opts: SliceProofRenderOpts): string {
  const raw = fs.readFileSync(resolveTemplate("proof.md"), "utf8");
  return raw
    .replace(/\{\{id\}\}/g, opts.id)
    .replace(/\{\{title\}\}/g, opts.title);
}

/** 将文件夹 slug 转换为首字母大写的展示名称。 */
export function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
