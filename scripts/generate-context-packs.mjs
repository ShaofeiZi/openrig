#!/usr/bin/env node
// OPR.0.5.3.7 R2——内容随 CLI 一起发货（干掉过期漂移）。
//
// 把公开的 skill 内容，从其声明的 spec/plugin 源，投影为 packages/daemon/context-packs/ 下的
// context-pack 条目。daemon 已把该目录登记为一个 `builtin` 发现根，且按相对二进制位置解析
// （startup.ts：`import.meta.dirname/../context-packs`），`rig context get` 也已能服务任何
// builtin 根下的 pack——因此一旦这份投影被生成并随包发货，所服务的字节在构造上就与 `rig --version`
// 一致，并与同一包所发的源一致。
//
// 已裁决形态（dev-planner 入口形态裁决 2026-08-23，打包时生成 manifest）：投影在打包时推导，
// 绝不原地编辑。输出目录被 gitignore，每次构建都重新生成，因此没有“已提交的投影”会漂移；
// 唯一的风险窗口是构建步骤，而本脚本通过 daemon 自己的解析器校验每一份生成的 manifest——唯一权威，
// 绝不搞第二份解析器——使畸形投影直接让构建失败。
//
// 用法：
//   node scripts/generate-context-packs.mjs            # 清空 + 写入 + 校验
//   node scripts/generate-context-packs.mjs --check    # 只校验、不写入（构建/CI 闸门）
//   node scripts/generate-context-packs.mjs --version=0.5.3
// 供测试覆盖：OPENRIG_SKILLS_SOURCE、OPENRIG_PACKS_OUT、OPENRIG_PACKAGE_VERSION。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
// 投影的成员集合与 canonical mirror 完全一致——这样 import 过来，两者永不漂移
// （r1/r2 HIGH-1：一条更窄的规则曾漏掉被引用的辅助资产）。
import { EXCLUDES as MIRROR_EXCLUDES, shipSetFromMembership } from "./mirror-skills.mjs";
import { scanInternalLeaks, buildInternalLeakMessage } from "./internal-leak-scanner.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const SOURCE = process.env.OPENRIG_SKILLS_SOURCE
  ? path.resolve(process.env.OPENRIG_SKILLS_SOURCE)
  : path.join(REPO, "packages/daemon/specs/agents/shared/skills");
const OUT = process.env.OPENRIG_PACKS_OUT
  ? path.resolve(process.env.OPENRIG_PACKS_OUT)
  : path.join(REPO, "packages/daemon/context-packs");

// STATIC pack（Test-A 预检修复，row 0ac358a9）：已提交的 pack 源——manifest.yaml + 内容文件，
// 例如 world/install 原子图——逐字投影进同一个 builtin 根，并通过同一个 daemon 解析器校验。
// 投影会把包版本盖到已提交的 `version: "0"` 占位符上（单行、保留注释）。
const STATIC_SOURCE = process.env.OPENRIG_STATIC_PACKS_SOURCE
  ? path.resolve(process.env.OPENRIG_STATIC_PACKS_SOURCE)
  : path.join(REPO, "packages/daemon/context-packs-src");

// 静态 pack 内容用完整的、已提交的泄漏权威规则扫描——scripts/internal-tokens.generated.json，
// 即公开 mirror 流程所消费的同一份生成策略（带电词、内部路径前缀、seat/rig 与 host 身份、
// 内部路径 glob、允许上下文的例外）。一份权威，绝不搞本地子集：收窄的本地清单会恰恰在它漏掉的内部
// 路径上假绿（review50-r2 BLOCKING-2）。
const STATIC_LEAK_RULES = JSON.parse(
  fs.readFileSync(path.join(REPO, "scripts/internal-tokens.generated.json"), "utf8"),
);

// 复用 daemon 的 manifest 解析器（唯一权威；入口形态裁决禁止搞第二份解析器）。它在编译后的 dist 里，
// 包构建会在本脚本运行前产出。按相对本脚本的位置解析，使它在任何 cwd 下都能用。
const PARSER_URL = pathToFileURL(
  path.join(REPO, "packages/daemon/dist/domain/context-packs/manifest-parser.js"),
).href;

// 成员集合取自身 canonical mirror，从它的 EXCLUDES 推导，使两者严格同步：包含除 mirror 排除项之外的所有文件。
// 这里我们不再按后缀收窄——R2 发的是“mirror-skills 的 canonical 输出”，而一个 skill 被引用的辅助资产
// （find-polluter.sh、condition-based-waiting-example.ts）也是该输出的一部分。daemon 解析器无法服务的后缀
// 绝不静默丢弃：它会进入 manifest，并在校验时让构建响亮失败，按已裁决的“canon 与投影之间漂移即构建失败”执行。
//   EXCLUDES 条目：裸名（"feedback.md"、".DS_Store"）、目录（"evals/"）、glob（"*.local.md"）。
const EXCLUDE_NAMES = new Set(MIRROR_EXCLUDES.filter((p) => !p.includes("/") && !p.includes("*")));
const EXCLUDE_DIRS = new Set(MIRROR_EXCLUDES.filter((p) => p.endsWith("/")).map((p) => p.replace(/\/+$/, "")));
const EXCLUDE_GLOB_SUFFIXES = MIRROR_EXCLUDES.filter((p) => p.startsWith("*.")).map((p) => p.slice(1));
const isExcludedFile = (name) =>
  EXCLUDE_NAMES.has(name) || EXCLUDE_GLOB_SUFFIXES.some((s) => name.endsWith(s));

function resolveVersion() {
  const arg = process.argv.find((a) => a.startsWith("--version="));
  const raw = arg ? arg.slice("--version=".length) : process.env.OPENRIG_PACKAGE_VERSION;
  const fromPkg = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(REPO, "packages/cli/package.json"), "utf8")).version;
    } catch {
      return "0.0.0-dev";
    }
  };
  return sanitizeVersion(raw || fromPkg());
}

// 与 daemon 里的 isSafePackVersion 对齐：/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/。
function sanitizeVersion(v) {
  let s = String(v).replace(/[^A-Za-z0-9._+-]/g, "-").slice(0, 32);
  if (!/^[A-Za-z0-9]/.test(s)) s = ("v" + s).slice(0, 32);
  return s;
}

// 发现 skill pack：一个 pack 就是含 SKILL.md 的目录。pack 是叶子——我们不在其下继续递归
// （与库的 discoverPackDirs 一致）。
function findSkillDirs(dir, rel = "") {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || EXCLUDE_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (fs.existsSync(path.join(abs, "SKILL.md"))) {
      found.push({ abs, rel: childRel });
    } else {
      found.push(...findSkillDirs(abs, childRel));
    }
  }
  return found;
}

function findPluginOnlyPublicSkillDirs() {
  if (process.env.OPENRIG_SKILLS_SOURCE) return { skills: [], errors: [] };

  const membership = JSON.parse(
    fs.readFileSync(path.join(REPO, "scripts/product-public-skills.generated.json"), "utf8"),
  );
  const layout = JSON.parse(
    fs.readFileSync(path.join(REPO, "scripts/skill-edge-layout.generated.json"), "utf8"),
  );
  const pluginEdge = layout.edges?.plugin;
  if (!pluginEdge || pluginEdge.layout !== "flat" || typeof pluginEdge.path !== "string") {
    return { skills: [], errors: ["skill 边布局必须声明一个扁平的 plugin 源"] };
  }

  const pluginRoot = path.resolve(REPO, pluginEdge.path);
  const skills = [];
  const errors = [];
  for (const name of shipSetFromMembership(membership)) {
    const edges = layout.skills?.[name]?.edges ?? [];
    if (!edges.includes("plugin") || edges.includes("canonical") || edges.includes("spec")) continue;
    const abs = path.join(pluginRoot, name);
    const skillFile = path.join(abs, "SKILL.md");
    if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) {
      errors.push(`公开的 plugin-only skill '${name}' 在 ${skillFile} 缺少声明的 plugin 内容`);
      continue;
    }
    skills.push({ abs, rel: name });
  }
  return { skills, errors };
}

// 收集 skill 目录内可服务的内容文件，返回 posix 相对路径。
function collectContentFiles(skillDir, rel = "") {
  const files = [];
  for (const e of fs.readdirSync(skillDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      files.push(...collectContentFiles(path.join(skillDir, e.name), rel ? `${rel}/${e.name}` : e.name));
    } else if (e.isFile() && !isExcludedFile(e.name)) {
      files.push(rel ? `${rel}/${e.name}` : e.name);
    }
  }
  return files;
}

function readFrontmatter(skillDir) {
  try {
    const raw = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const fm = parseYaml(m[1]);
    return fm && typeof fm === "object" ? fm : {};
  } catch {
    return {};
  }
}

function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

// 确定性的 YAML 输出——JSON 编码的标量就是合法的 YAML flow 标量，因此键序与转义完全受控
// （不依赖任何序列化器）。SKILL.md 是 pack 的指令；其余兄弟文件是引用。
function renderManifest({ name, version, purpose, files }) {
  const lines = [
    "# 由 scripts/generate-context-packs.mjs 生成——请勿手改。",
    "# 某个 canonical skill 在打包时的投影；每次构建重新生成。",
    `name: ${JSON.stringify(name)}`,
    `version: ${JSON.stringify(version)}`,
    // OPR.0.5.6.10 mini-req 3——投影把它的 pack 标记为 "skills"：
    // skill pack 在构造上就是过程性能力。
    'taxonomy: "skills"',
  ];
  if (purpose) lines.push(`purpose: ${JSON.stringify(purpose)}`);
  lines.push("files:");
  for (const f of files) {
    const role = f === "SKILL.md" ? "instruction" : "reference";
    lines.push(`  - path: ${JSON.stringify(f)}`);
    lines.push(`    role: ${JSON.stringify(role)}`);
    if (f === "SKILL.md" && purpose) lines.push(`    summary: ${JSON.stringify(purpose)}`);
  }
  return lines.join("\n") + "\n";
}

// 发现静态 pack：STATIC_SOURCE 下任何含 manifest.yaml 的嵌套目录（与库自己的发现一致；pack 是叶子）。
function findStaticPackDirs(dir, rel = "") {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const abs = path.join(dir, e.name);
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (fs.existsSync(path.join(abs, "manifest.yaml"))) {
      found.push({ abs, rel: childRel });
    } else {
      found.push(...findStaticPackDirs(abs, childRel));
    }
  }
  return found;
}

// 静态 pack 逐字投影：已提交的 manifest 是权威（含 atoms 图）；只把 version 占位符那一行盖掉。
// 在写任何投影之前，会按完整的静态源码树扫描，不看后缀、不看 pack 成员。
function buildStaticPack(pack, version) {
  const rawManifest = fs.readFileSync(path.join(pack.abs, "manifest.yaml"), "utf8");
  const parsedManifest = parseYaml(rawManifest);
  if (parsedManifest?.taxonomy === "lore") {
    throw new Error(
      "lore 类拒绝：taxonomy: lore 在结构上不可发货。" +
      "请泛化内容、标注其公开出处，或把它迁回内部 pack 根。",
    );
  }
  const stamped = rawManifest.replace(/^version:\s*"0"\s*$/m, `version: ${JSON.stringify(version)}`);
  if (stamped === rawManifest && !new RegExp(`^version: ${JSON.stringify(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(rawManifest)) {
    throw new Error(`静态 pack ${pack.rel}：manifest 必须带 'version: "0"' 占位符，供投影盖戳`);
  }
  const contentFiles = [];
  const walk = (dir, rel = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && e.name !== "manifest.yaml") contentFiles.push(childRel);
    }
  };
  walk(pack.abs);
  return { ref: pack.rel, files: contentFiles, manifestYaml: stamped, srcDir: pack.abs };
}

// 源码边界比“被投影的 pack 文件集合”更宽：一个改了名的来源 sidecar 可以待在 pack 旁边，
// 否则会同时躲过发现与拷贝。在校验或写入任何投影之前，按每个源文件扫描，不看后缀、不看 pack 成员。
function scanStaticSource() {
  const files = [];
  const walk = (dir, rel = "") => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child, childRel);
      else if (entry.isFile()) files.push({ path: childRel, bytes: fs.readFileSync(child) });
    }
  };
  walk(STATIC_SOURCE);
  return files.flatMap((file) => scanInternalLeaks({ ...file, rules: STATIC_LEAK_RULES }));
}

function buildPack(skill, version) {
  const files = collectContentFiles(skill.abs);
  if (!files.includes("SKILL.md")) {
    throw new Error(`位于 ${skill.rel} 的 skill 没有可服务的 SKILL.md`);
  }
  // SKILL.md 在前，其余在后（确定性，指令打头）。
  const ordered = ["SKILL.md", ...files.filter((f) => f !== "SKILL.md")];
  const fm = readFrontmatter(skill.abs);
  const name = typeof fm.name === "string" && fm.name.length ? fm.name : skill.rel.split("/").pop();
  const purpose = typeof fm.description === "string" && fm.description.length
    ? oneLine(fm.description).slice(0, 500)
    : undefined;
  const manifestYaml = renderManifest({ name, version, purpose, files: ordered });
  return { ref: `skills/${skill.rel}`, files: ordered, manifestYaml, srcDir: skill.abs };
}

async function main() {
  const check = process.argv.includes("--check");
  const version = resolveVersion();

  let parseManifest;
  try {
    ({ parseManifest } = await import(PARSER_URL));
  } catch (err) {
    console.error(
      `[generate-context-packs] 无法在\n  ${PARSER_URL}\n加载 daemon manifest 解析器。` +
      `请先构建 daemon（npm --prefix packages/daemon run build）。原因：${err.message}`,
    );
    process.exit(2);
  }

  const sharedSkills = findSkillDirs(SOURCE);
  if (sharedSkills.length === 0) {
    console.error(`[generate-context-packs] 在 ${SOURCE} 下未找到任何 skill`);
    process.exit(2);
  }

  const packs = [];
  const pluginOnly = findPluginOnlyPublicSkillDirs();
  const skills = [...sharedSkills, ...pluginOnly.skills];
  const errors = [...pluginOnly.errors];
  for (const skill of skills) {
    let pack;
    try {
      pack = buildPack(skill, version);
    } catch (err) {
      errors.push(`${skill.rel}: ${err.message}`);
      continue;
    }
    // 打包时经由 daemon 自己的解析器校验——畸形投影在这里就让构建失败，绝不拖到服务时才暴露。
    try {
      parseManifest(pack.manifestYaml, `${pack.ref}/manifest.yaml`);
    } catch (err) {
      errors.push(`${pack.ref}：manifest 非法——${err.message}`);
      continue;
    }
    packs.push(pack);
  }

  const staticLeaks = scanStaticSource();
  if (staticLeaks.length > 0) errors.push(buildInternalLeakMessage(staticLeaks));

  // 静态 pack 在 skills 之后投影；同一校验权威、同一份“失败即构建失败”契约。
  // 静态源为空是合法的（没有 pack）。
  for (const staticPack of findStaticPackDirs(STATIC_SOURCE)) {
    let pack;
    try {
      pack = buildStaticPack(staticPack, version);
    } catch (err) {
      errors.push(`${staticPack.rel}: ${err.message}`);
      continue;
    }
    try {
      parseManifest(pack.manifestYaml, `${pack.ref}/manifest.yaml`);
    } catch (err) {
      errors.push(`${pack.ref}：manifest 非法——${err.message}`);
      continue;
    }
    packs.push(pack);
  }

  // pack ref 在两个发现来源之间必须唯一：写入循环以 ref 作为输出目录的键，
  // 因此一旦冲突就会用另一个静默覆盖掉已校验的 pack（review50-r2 BLOCKING-3）。
  // 在任何 check-success 或输出改动之前就响亮失败。
  const seenRefs = new Map();
  for (const pack of packs) {
    if (seenRefs.has(pack.ref)) {
      errors.push(`pack ref 重复 '${pack.ref}'——一个 skill 投影与一个静态 pack（或两个 pack）相撞；写入会用一个已校验 pack 静默覆盖另一个`);
    }
    seenRefs.set(pack.ref, pack);
  }

  if (errors.length > 0) {
    console.error(`[generate-context-packs] 共 ${errors.length} 个非法 pack——构建失败：`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  if (check) {
    console.log(`[generate-context-packs] --check 通过：${packs.length} 个 pack 投影与校验均干净（version ${version}）。`);
    return;
  }

  // 写入模式：清空输出根并从零重新生成（投影绝不原地编辑；过期条目无法残留）。
  fs.rmSync(OUT, { recursive: true, force: true });
  for (const pack of packs) {
    const packDir = path.join(OUT, pack.ref);
    fs.mkdirSync(packDir, { recursive: true });
    for (const rel of pack.files) {
      const srcAbs = pack.srcDir
        ? path.join(pack.srcDir, rel)
        : path.join(SOURCE, pack.ref.replace(/^skills\//, ""), rel);
      const dstAbs = path.join(packDir, rel);
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      fs.copyFileSync(srcAbs, dstAbs);
    }
    fs.writeFileSync(path.join(packDir, "manifest.yaml"), pack.manifestYaml);
  }
  console.log(`[generate-context-packs] 已写入 ${packs.length} 个 pack 到 ${OUT}（version ${version}）。`);
}

main().catch((err) => {
  console.error(`[generate-context-packs] 意外失败：${err.stack || err.message}`);
  process.exit(2);
});
