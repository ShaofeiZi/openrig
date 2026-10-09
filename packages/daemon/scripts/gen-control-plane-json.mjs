#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const EDGE_NAMES = ["canonical", "plugin", "spec"];
const CATEGORIES = new Set(["core", "pm", "pods", "process", null]);
const REQUIRED_MEMBERSHIP_CATEGORIES = [
  "clean",
  "ship_after_fix",
  "ship_misses_add",
  "sanitize_borderlines_ship",
];
const REQUIRED_DENYLIST_ARRAYS = [
  "path_prefixes",
  "seat_and_rig_patterns",
  "host_patterns",
  "charged_terms",
  "frontmatter_drop_keys",
  "internal_path_globs",
  "allowed_context_substrings",
];

export async function generateControlPlaneJson({
  repoRoot,
  membershipPath,
  denylistPath,
  layoutPath,
  outputDir,
}) {
  const membership = readYaml(membershipPath);
  const denylist = readYaml(denylistPath);
  const layoutConfig = readYaml(layoutPath);

  validateMembership(membership, membershipPath);
  validateDenylist(denylist, denylistPath);
  const layout = await extractSkillEdgeLayout({
    repoRoot,
    sourcePath: layoutPath,
    config: layoutConfig,
  });
  const digests = buildEdgeDigests({ repoRoot, layout });

  mkdirSync(outputDir, { recursive: true });
  writeJson(join(outputDir, "product-public-skills.generated.json"), publicProjection(membership));
  writeJson(join(outputDir, "internal-tokens.generated.json"), denylist);
  writeJson(join(outputDir, "skill-edge-layout.generated.json"), publicProjection(layout));
  writeJson(join(outputDir, "skill-edge-digests.generated.json"), digests);
}

// 所有权属于私有创作源，而不是其公开投影。
export function publicProjection({ owner, ...value }) {
  return value;
}

export async function extractSkillEdgeLayout({
  repoRoot,
  config,
  sourcePath = "skill-edge-layout.yaml",
}) {
  validateLayout(config, sourcePath);
  const skills = new Map();

  for (const [edge, edgeConfig] of Object.entries(config.edges).sort()) {
    const edgeRoot = join(repoRoot, edgeConfig.path);
    for (const skillFile of walkFiles(edgeRoot).filter((path) =>
      path.endsWith("SKILL.md"),
    )) {
      const rel = relative(edgeRoot, skillFile).replaceAll("\\", "/");
      const parts = rel.split("/");
      const skill =
        edgeConfig.layout === "flat" ? parts[0] : parts.at(-2);
      const category =
        edgeConfig.layout === "flat" ? null : parts.length >= 3 ? parts[0] : null;
      const current = skills.get(skill) ?? { edges: [], category };
      if (
        category !== null &&
        current.category !== null &&
        current.category !== category
      ) {
        throw new Error(
          `${sourcePath}：${skill} 的类别冲突：${current.category} 与 ${category}`,
        );
      }
      current.category ??= category;
      current.edges.push(edge);
      skills.set(skill, current);
    }
  }

  for (const [skill, override] of Object.entries(
    config.forward_overrides ?? {},
  ).sort()) {
    validateOverride(skill, override, config.edges, sourcePath);
    if (override.edges.length === 0) {
      skills.delete(skill);
      continue;
    }
    const edges = new Set(override.edges);
    if (edges.has("spec")) {
      for (const [edge, edgeConfig] of Object.entries(config.edges)) {
        if (edgeConfig.layout === "mirror-of-spec") edges.add(edge);
      }
    }
    skills.set(skill, {
      edges: [...edges].sort(),
      category: override.category ?? null,
    });
  }

  return {
    version: config.version,
    owner: config.owner,
    edges: sortObject(config.edges),
    skills: Object.fromEntries(
      [...skills.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([skill, entry]) => [
          skill,
          {
            edges: [...new Set(entry.edges)].sort(),
            category: entry.category ?? null,
          },
        ]),
    ),
  };
}

// 导出供磁盘事实摘要重建器（scripts/regen-edge-digests.mjs）使用：摘要仅来自磁盘上的边文件
// 与仓库中已经正确的 layout，不读取外部 canonical YAML。它会刷新文件完整性哈希，使其与合并后的
// 现实一致，但不会重新推导 membership/denylist/layout（后者需要显式 canon-root 路径）。这里只哈希
// 当前存在的文件；layout 要求但磁盘缺失的文件不会获得摘要，因此过期检查仍会明确报错
//（layout = 权威，磁盘 = 现实）。
export function buildEdgeDigests({ repoRoot, layout }) {
  return {
    version: 1,
    edges: Object.fromEntries(
      Object.entries(layout.edges)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([edge, config]) => {
          const root = join(repoRoot, config.path);
          return [
            edge,
            Object.fromEntries(
              walkFiles(root).map((path) => [
                relative(root, path).replaceAll("\\", "/"),
                sha256(readFileSync(path)),
              ]),
            ),
          ];
        }),
    ),
  };
}

function validateMembership(value, sourcePath) {
  if (!isObject(value?.product_public)) {
    invalid(sourcePath, "product_public 必须是对象");
  }
  for (const category of REQUIRED_MEMBERSHIP_CATEGORIES) {
    if (!isStringArray(value.product_public[category])) {
      invalid(sourcePath, `product_public.${category} 必须是数组`);
    }
  }
  if (!isStringArray(value.vendored_ship_with_provenance)) {
    invalid(sourcePath, "vendored_ship_with_provenance 必须是数组");
  }
  if (!isObject(value.not_public)) {
    invalid(sourcePath, "not_public 必须是对象");
  }
  for (const [category, skills] of Object.entries(value.not_public)) {
    if (!isStringArray(skills)) {
      invalid(sourcePath, `not_public.${category} 必须是数组`);
    }
  }
  if (!isStringArray(value.pending_author_public)) {
    invalid(sourcePath, "pending_author_public 必须是数组");
  }
}

function validateDenylist(value, sourcePath) {
  if (!isObject(value)) invalid(sourcePath, "denylist 必须是对象");
  for (const field of REQUIRED_DENYLIST_ARRAYS) {
    if (Object.hasOwn(value, field) && !isStringArray(value[field])) {
      invalid(sourcePath, `${field} 必须是数组`);
    }
  }
  for (const field of REQUIRED_DENYLIST_ARRAYS) {
    if (!isStringArray(value[field])) {
      invalid(sourcePath, `${field} 必须是数组`);
    }
  }
  if (
    !isObject(value.section_fence) ||
    typeof value.section_fence.begin !== "string" ||
    typeof value.section_fence.end !== "string"
  ) {
    invalid(sourcePath, "必须提供 section_fence.begin 和 section_fence.end");
  }
}

function validateLayout(value, sourcePath) {
  if (!isObject(value?.edges)) invalid(sourcePath, "edges 必须是对象");
  const edgeNames = Object.keys(value.edges).sort();
  if (
    edgeNames.length !== EDGE_NAMES.length ||
    edgeNames.some((edge, index) => edge !== EDGE_NAMES[index])
  ) {
    invalid(sourcePath, "edges 必须且只能包含 canonical、plugin 和 spec");
  }
  for (const edge of EDGE_NAMES) {
    const config = value.edges[edge];
    if (
      !isObject(config) ||
      typeof config.path !== "string" ||
      !["categorized", "mirror-of-spec", "flat"].includes(config.layout)
    ) {
      invalid(sourcePath, `${edge} 边的 path/layout 无效`);
    }
  }
  if (value.extract_from_committed_trees !== true) {
    invalid(sourcePath, "extract_from_committed_trees 必须为 true");
  }
  if (!isObject(value.forward_overrides)) {
    invalid(sourcePath, "forward_overrides 必须是对象");
  }
  for (const [skill, override] of Object.entries(value.forward_overrides)) {
    validateOverride(skill, override, value.edges, sourcePath);
  }
}

function validateOverride(skill, override, edges, sourcePath) {
  if (
    !isObject(override) ||
    !isStringArray(override.edges) ||
    override.edges.some(
      (edge) =>
        !Object.hasOwn(edges, edge) || !["plugin", "spec"].includes(edge),
    )
  ) {
    invalid(sourcePath, `${skill} 的 edges 无效`);
  }
  if (!CATEGORIES.has(override.category ?? null)) {
    invalid(sourcePath, `${skill} 的 category 无效`);
  }
}

function readYaml(path) {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function walkFiles(root) {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) {
    throw new Error(`${root}：不允许 symlink（符号链接）条目`);
  }
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) {
    throw new Error(`${root}：不支持的文件系统条目`);
  }
  return readdirSync(root)
    .sort()
    .flatMap((entry) => walkFiles(join(root, entry)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function invalid(path, reason) {
  throw new Error(`${path}: ${reason}`);
}

function cliOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`${key ?? "<结尾>"} 附近的参数无效`);
    }
    values[key.slice(2)] = resolve(value);
  }
  const required = ["repo-root", "membership", "denylist", "layout", "output"];
  for (const key of required) {
    if (!values[key]) throw new Error(`必须提供 --${key}`);
  }
  return {
    repoRoot: values["repo-root"],
    membershipPath: values.membership,
    denylistPath: values.denylist,
    layoutPath: values.layout,
    outputDir: values.output,
  };
}

const scriptPath = fileURLToPath(import.meta.url);
if (resolve(process.argv[1]) === scriptPath) {
  try {
    await generateControlPlaneJson(cliOptions(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
