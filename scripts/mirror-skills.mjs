import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  buildInternalLeakMessage,
  scanInternalLeaks,
} from "./internal-leak-scanner.mjs";

// 把 canonical skills 从 packages/daemon/specs/agents/shared/skills/
// 镜像到 <repo-root>/skills/_canonical/。<repo-root>/skills/ 下手写的文件
// （README、CHANGELOG、LICENSE、plugin manifest）与 _canonical/ 并列，
// 镜像绝不碰它们——严格的所有权划分让我们能新增顶层文件，而不必把脚本和目标形态耦合死。

export const SOURCE_DIR = "packages/daemon/specs/agents/shared/skills/";
export const TARGET_DIR = "skills/_canonical/";

export const EXCLUDES = [
  "feedback.md",
  "evals/",
  ".DS_Store",
  "*.local.md",
];

function rsyncArgs({ dryRun }) {
  // --checksum 用哈希比对文件内容，而不是 mtime+size。在 --check（dry-run）模式下使用，
  // 使漂移检测以内容为准——`git checkout` 或 `cp` 更新了 mtime 时，只要字节一致就不算漂移。
  // 在 apply 模式下我们保留默认（mtime+size）以图快；rsync 的 archive 标志会保留 mtime，
  // 使后续检查保持干净。
  return [
    "-a",
    "--delete",
    "--delete-excluded",
    "--itemize-changes",
    ...(dryRun ? ["-n", "--checksum"] : []),
    ...EXCLUDES.map((p) => `--exclude=${p}`),
    SOURCE_DIR,
    TARGET_DIR,
  ];
}

// 解析 rsync --itemize-changes 输出，挑出内容或常规文件模式的变更。
// 首列代码含义见 rsync(1)：
//   `<` / `>` —— 文件被传输（内容变更）
//   `c`        —— 新建条目（文件/目录/软链/设备）
//   `h`        —— 硬链接重定向
//   `.`        —— 条目无更新，或仅元数据更新；只保留 `.f...p.....` 这种权限变更
//   `*`        —— 消息行；我们只关心 `*deleting `
// 在 --check 模式下脚本以 `--checksum` 调 rsync，所以以 `.` 开头的行意味着即使 mtime 漂移
// （例如 `git checkout` 或 `cp` 之后）字节也是一致的；权限是公开镜像唯一必须保留的元数据字段，
// 而仅 mtime 的漂移继续被忽略。
export function parseChanges(output) {
  const lines = output.split("\n").filter(Boolean);
  return [
    ...new Set(
      lines.filter(
        (line) =>
          /^[<>ch][fdLDS]/.test(line.slice(0, 2)) ||
          (line.startsWith(".f") && line[5] === "p") ||
          line.startsWith("*deleting "),
      ),
    ),
  ];
}

export function buildStaleMessage(changes) {
  return [
    "skills 镜像在 skills/_canonical/ 已过期。请运行：npm run mirror-skills",
    "将落地的变更：",
    ...changes.map((c) => `  ${c}`),
  ].join("\n");
}

function runRsync({ dryRun }, exec = execFileSync) {
  return exec("rsync", rsyncArgs({ dryRun }), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function ensureTargetExists() {
  if (!existsSync(TARGET_DIR)) {
    mkdirSync(TARGET_DIR, { recursive: true });
  }
}

export function checkMode(exec = execFileSync) {
  ensureTargetExists();
  const output = runRsync({ dryRun: true }, exec);
  const changes = parseChanges(output);
  return { stale: changes.length > 0, changes, output };
}

export function checkModeAbsolute(sourceDir, targetDir, exec = execFileSync) {
  const output = exec(
    "rsync",
    rsyncAbsoluteArgs({ sourceDir, targetDir, dryRun: true }),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const changes = parseChanges(output);
  return { stale: changes.length > 0, changes, output };
}

// 镜像 ship 集合所消费的 product_public 类别。导出它，使 refs→membership 链闸门（第 2 腿）
// 能证明每个 oracle 类别都被消费——一个出现在 oracle 里、却不在此处的类别会被静默接受后丢弃
// （0.4.8/864cea6b 那次搁浅：PM 的 `restored_role_pm_selected` 重新加入落进了 oracle，
// 但这份列表从没读到它，于是那 10 个 pod/pm skill 虽被成员集选中，却始终没被重新发货）。
export const SHIP_CATEGORIES = [
  "clean",
  "ship_after_fix",
  "ship_misses_add",
  "sanitize_borderlines_ship",
  "restored_role_pm_selected",
];

export function shipSetFromMembership(membership) {
  const productPublic = membership?.product_public ?? {};
  const excluded = new Set([
    ...Object.values(membership?.not_public ?? {}).flat(),
    ...(membership?.pending_author_public ?? []),
  ]);
  return [
    ...SHIP_CATEGORIES.flatMap((category) => productPublic[category] ?? []),
    ...(membership?.vendored_ship_with_provenance ?? []),
  ]
    .filter((skill) => !excluded.has(skill))
    .filter((skill, index, all) => all.indexOf(skill) === index)
    .sort();
}

export async function stagePublicSkills({
  canonRoot,
  stagingRoot,
  membership,
  rules,
}) {
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  for (const skill of shipSetFromMembership(membership)) {
    const sourceRoot = join(canonRoot, skill);
    if (!existsSync(sourceRoot) || isInternalPath(skill, rules)) continue;

    for (const sourcePath of walkFiles(sourceRoot)) {
      const skillRelative = relative(sourceRoot, sourcePath).replaceAll("\\", "/");
      const publicPath = `${skill}/${skillRelative}`;
      if (isExcludedPath(skillRelative)) continue;
      if (isInternalPath(publicPath, rules)) continue;

      let bytes = readFileSync(sourcePath);
      if (basename(sourcePath) === "SKILL.md") {
        const transformed = stripPublicSkill(
          bytes.toString("utf8"),
          publicPath,
          rules,
        );
        bytes = Buffer.from(transformed);
      } else if (/\.mdx?$/i.test(sourcePath)) {
        bytes = Buffer.from(
          stripInternalFences(
            bytes.toString("utf8"),
            publicPath,
            rules.section_fence,
          ),
        );
      }

      const findings = scanInternalLeaks({ path: publicPath, bytes, rules });
      if (findings.length > 0) {
        throw new Error(buildInternalLeakMessage(findings));
      }

      const targetPath = join(stagingRoot, skillRelative === "." ? skill : publicPath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bytes, {
        mode: lstatSync(sourcePath).mode & 0o777,
      });
    }
  }
}

// external-canon-pending 的 skill：写在外部 skill canon 里、也列在 layout 的 ship 集合中，
// 但尚未镜像进本仓库（它们的 SKILL.md 还不在 git 里；裁剪清单上的 canon mirror-apply——
// 用显式 canon-root 路径运行——会把它们落进来）。它们“layout 要求却缺失”在这里被容忍——
// 但只容忍这寥寥几个具名者，且只在它们确实不在磁盘上时。任何其他“layout 要求却缺失”的文件仍响亮失败
// （未来一次误删绝不被默默放过）；而一个名字重新出现在磁盘上时会被标记 `external-canon-allowlist-stale`，
// 使这份清单自我销毁。与 P6(A) 链闸门同一套自我约束形态。layout = 权威，磁盘 = 现实；
// digest 重算只触及现实。
// （当前为空：oversight-team 与 retiring-and-inheriting-a-seat 已通过 2026-08-24 的 mirror-apply 落地，
// 于是它们的豁免自我销毁了。）
const EXTERNAL_CANON_PENDING = new Set([]);

export async function checkGeneratedEdges({
  repoRoot = process.cwd(),
  layout,
  digests,
  externalCanonPending = EXTERNAL_CANON_PENDING,
}) {
  validateGeneratedControls(layout, digests);
  const changes = [];
  const onDiskSkills = new Set();

  for (const [edge, edgeConfig] of Object.entries(layout.edges).sort()) {
    const edgeRoot = join(repoRoot, edgeConfig.path);
    const expected = digests?.edges?.[edge] ?? {};
    const edgeFiles = walkFiles(edgeRoot);
    const actual = Object.fromEntries(
      edgeFiles.map((path) => [
        relative(edgeRoot, path).replaceAll("\\", "/"),
        sha256(readFileSync(path)),
      ]),
    );

    for (const path of Object.keys(expected).sort()) {
      if (!(path in actual)) {
        changes.push({ edge, path, reason: "missing" });
      } else if (actual[path] !== expected[path]) {
        changes.push({ edge, path, reason: "digest" });
      }
    }
    for (const path of Object.keys(actual).sort()) {
      if (!(path in expected)) {
        changes.push({ edge, path, reason: "unexpected" });
      }
    }

    const actualSkills = new Map(
      edgeFiles
        .filter((path) => basename(path) === "SKILL.md")
        .map((path) => {
          const rel = relative(edgeRoot, path).replaceAll("\\", "/");
          const parts = rel.split("/");
          const flat = edgeConfig.layout === "flat";
          return [
            flat ? parts[0] : parts.at(-2),
            { path: rel, category: flat ? null : parts[0] },
          ];
        }),
    );
    for (const [skill, actualEntry] of actualSkills) {
      const expectedEntry = layout.skills?.[skill];
      if (!expectedEntry?.edges?.includes(edge)) {
        changes.push({
          edge,
          path: actualEntry.path,
          reason: "layout-unexpected",
        });
      } else if (
        actualEntry.category !== null &&
        expectedEntry.category !== actualEntry.category
      ) {
        changes.push({
          edge,
          path: actualEntry.path,
          reason: "layout-category",
        });
      }
    }
    for (const skill of actualSkills.keys()) onDiskSkills.add(skill);
    for (const [skill, expectedEntry] of Object.entries(
      layout.skills ?? {},
    ).sort()) {
      if (expectedEntry.edges.includes(edge) && !actualSkills.has(skill)) {
        // 只容忍具名的 external-canon-pending skill；任何其他“layout 要求却缺失”的文件仍响亮报错。
        if (externalCanonPending.has(skill)) continue;
        changes.push({
          edge,
          path: skill,
          reason: "layout-missing",
        });
      }
    }
  }

  // 自我销毁守卫：一个重新出现在磁盘上的名字必须离开白名单。若某个 external-canon-pending skill
  // 如今已存在磁盘上，它的豁免就是过期的——响亮标记它，使这份清单永远不能默默活得比它所补的缺口更久。
  for (const skill of externalCanonPending) {
    if (onDiskSkills.has(skill)) {
      changes.push({ edge: "-", path: skill, reason: "external-canon-allowlist-stale" });
    }
  }

  return { stale: changes.length > 0, changes };
}

export async function regeneratePublicSkills({
  canonRoot,
  repoRoot,
  membership,
  rules,
  layout,
  exec = execFileSync,
}) {
  validateAuthoringLayout(layout);
  const shipping = shipSetFromMembership(membership);
  for (const skill of shipping) {
    if (!existsSync(join(canonRoot, skill))) {
      throw new Error(`canon 中缺少待发货 skill：${skill}`);
    }
    if (!layout.skills[skill]?.edges?.length) {
      throw new Error(`边布局中缺少待发货 skill：${skill}`);
    }
  }

  const temporaryRoot = mkdtempSync(join(tmpdir(), "openrig-public-skills-"));
  try {
    const stagingRoot = join(temporaryRoot, "staging");
    await stagePublicSkills({
      canonRoot,
      stagingRoot,
      membership,
      rules,
    });

    const changes = [];
    for (const [edge, edgeConfig] of Object.entries(layout.edges).sort()) {
      const projectedRoot = join(temporaryRoot, `edge-${edge}`);
      mkdirSync(projectedRoot, { recursive: true });

      for (const skill of shipping) {
        const skillLayout = layout.skills[skill];
        if (!skillLayout.edges.includes(edge)) continue;
        const category =
          edgeConfig.layout === "flat" ? null : skillLayout.category;
        if (edgeConfig.layout !== "flat" && !category) {
          throw new Error(`待发货 skill ${skill} 在 ${edge} 上缺少 category`);
        }
        const destination = category
          ? join(projectedRoot, category, skill)
          : join(projectedRoot, skill);
        copyTree(join(stagingRoot, skill), destination);
      }

      const edgeRoot = join(repoRoot, edgeConfig.path);
      mkdirSync(edgeRoot, { recursive: true });
      const output = runRsyncAbsolute(projectedRoot, edgeRoot, exec);
      for (const line of parseChanges(output)) {
        changes.push({
          edge,
          path: rsyncChangePath(line),
          reason: line.startsWith("*deleting ")
            ? "delete"
            : line.startsWith(".f") && line[5] === "p"
              ? "mode"
              : "write",
        });
      }
    }
    return { changes };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function authoringApplyMode({
  generateControlPlaneJson = defaultGenerateControlPlaneJson,
  readAuthoringInputs = defaultReadAuthoringInputs,
  regeneratePublicSkills: regenerate = regeneratePublicSkills,
} = {}) {
  await generateControlPlaneJson();
  const inputs = readAuthoringInputs();
  const result = await regenerate(inputs);
  if (result.changes.length > 0) {
    await generateControlPlaneJson();
  }
  return result;
}

export function applyMode(exec = execFileSync) {
  ensureTargetExists();
  return runRsync({ dryRun: false }, exec);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const isCheck = argv.includes("--check");

  if (isCheck) {
    const verify = dependencies.checkGeneratedEdges ?? checkGeneratedEdges;
    const inputs =
      dependencies.checkInputs ??
      (dependencies.checkGeneratedEdges ? {} : readGeneratedCheckInputs());
    const { stale, changes } = await verify(inputs);
    if (stale) {
      console.error(buildGeneratedStaleMessage(changes));
      process.exitCode = 1;
    }
    return;
  }

  const apply = dependencies.authoringApplyMode ?? authoringApplyMode;
  const log = dependencies.log ?? console.log;
  const { changes } = await apply();
  if (changes.length === 0) {
    log("公开 skill 边已同步，无变更。");
  } else {
    log(`公开 skill 边重新生成共测得 ${changes.length} 处变更：`);
    for (const { edge, path, reason } of changes) {
      log(`  ${edge}: ${path} (${reason})`);
    }
  }
}

if (import.meta.url === `file://${resolve(process.argv[1])}`) {
  await main();
}

function readGeneratedCheckInputs() {
  const repoRoot = process.cwd();
  return {
    repoRoot,
    layout: readJson(join(repoRoot, "scripts/skill-edge-layout.generated.json")),
    digests: readJson(join(repoRoot, "scripts/skill-edge-digests.generated.json")),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function defaultGenerateControlPlaneJson() {
  const repoRoot = process.cwd();
  const required = {
    membership: process.env.OPENRIG_PRODUCT_PUBLIC_SKILLS_YAML,
    denylist: process.env.OPENRIG_INTERNAL_TOKENS_YAML,
    layout: process.env.OPENRIG_SKILL_EDGE_LAYOUT_YAML,
  };
  for (const [name, path] of Object.entries(required)) {
    if (!path) {
      throw new Error(
        `authoring apply 需要 ${name} 权威路径环境变量`,
      );
    }
  }
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "packages/daemon/scripts/gen-control-plane-json.mjs"),
      "--repo-root",
      repoRoot,
      "--membership",
      required.membership,
      "--denylist",
      required.denylist,
      "--layout",
      required.layout,
      "--output",
      join(repoRoot, "scripts"),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
}

function defaultReadAuthoringInputs() {
  const repoRoot = process.cwd();
  const canonRoot = process.env.OPENRIG_SKILL_CANON_ROOT;
  if (!canonRoot) {
    throw new Error(
      "mirror apply 需要 OPENRIG_SKILL_CANON_ROOT——把它设为 skill-canon 根再运行真正的 apply。这是一条显式路径 authoring 守卫（apply 从该路径读取 canon），不是授权闸门。",
    );
  }
  return {
    repoRoot,
    canonRoot: resolve(canonRoot),
    membership: readJson(
      join(repoRoot, "scripts/product-public-skills.generated.json"),
    ),
    rules: readJson(join(repoRoot, "scripts/internal-tokens.generated.json")),
    layout: readJson(
      join(repoRoot, "scripts/skill-edge-layout.generated.json"),
    ),
  };
}

function buildGeneratedStaleMessage(changes) {
  return [
    "生成的 skill 边已过期。请重新生成 control-plane manifest。",
    ...changes.map(
      ({ edge, path, reason }) => `  ${edge}: ${path} (${reason})`,
    ),
  ].join("\n");
}

function stripPublicSkill(content, path, rules) {
  const withoutFences = stripInternalFences(content, path, rules.section_fence);
  const lines = withoutFences.split("\n");
  if (lines[0] !== "---") return withoutFences;

  const end = lines.indexOf("---", 1);
  if (end === -1) return withoutFences;

  const frontmatter = lines.slice(1, end);
  const kept = sanitizeFrontmatterEntries(frontmatter, 0, rules);

  return ["---", ...kept, "---", ...lines.slice(end + 1)].join("\n");
}

function sanitizeFrontmatterEntries(lines, indent, rules) {
  const kept = [];
  for (let index = 0; index < lines.length; ) {
    const match = frontmatterEntry(lines[index]);
    if (!match || match.indent !== indent) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }

    let next = index + 1;
    while (next < lines.length) {
      const candidate = frontmatterEntry(lines[next]);
      if (candidate && candidate.indent <= indent) break;
      next += 1;
    }
    const children = lines.slice(index + 1, next);
    const configured =
      match.key === "distribution_scope" ||
      (rules.frontmatter_drop_keys ?? []).includes(match.key);
    if (configured) {
      index = next;
      continue;
    }

    const childIndent = firstEntryIndent(children);
    if (match.value === "" && childIndent !== null) {
      const sanitized = sanitizeFrontmatterEntries(children, childIndent, rules);
      if (sanitized.some((line) => line.trim() !== "")) {
        kept.push(lines[index], ...sanitized);
      }
    } else {
      const entry = [lines[index], ...children];
      if (!containsInternalValue(entry.join("\n"), rules)) kept.push(...entry);
    }
    index = next;
  }
  return kept;
}

function frontmatterEntry(line) {
  const match = /^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
  return match
    ? { indent: match[1].length, key: match[2], value: match[3] ?? "" }
    : null;
}

function firstEntryIndent(lines) {
  for (const line of lines) {
    const entry = frontmatterEntry(line);
    if (entry) return entry.indent;
  }
  return null;
}

function stripInternalFences(content, path, fence) {
  if (!fence?.begin || !fence?.end) return content;

  const lines = content.split("\n");
  const kept = [];
  let openedAt = null;
  for (const [index, line] of lines.entries()) {
    if (line.includes(fence.begin)) {
      if (openedAt !== null) {
        throw new Error(`${path}：第 ${index + 1} 行有未配对的内部围栏`);
      }
      openedAt = index + 1;
      continue;
    }
    if (line.includes(fence.end)) {
      if (openedAt === null) {
        throw new Error(`${path}：第 ${index + 1} 行有未配对的内部围栏`);
      }
      openedAt = null;
      continue;
    }
    if (openedAt === null) kept.push(line);
  }
  if (openedAt !== null) {
    throw new Error(`${path}：第 ${openedAt} 行有未闭合的内部围栏`);
  }
  return kept.join("\n");
}

function containsInternalValue(value, rules) {
  const lower = value.toLowerCase();
  return [
    ...(rules.path_prefixes ?? []),
    ...(rules.seat_and_rig_patterns ?? []),
    ...(rules.host_patterns ?? []),
    ...(rules.charged_terms ?? []),
  ].some((token) => lower.includes(token.toLowerCase()));
}

function isInternalPath(path, rules) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  return (rules.internal_path_globs ?? []).some((glob) => {
    if (glob === "*.internal.*") {
      return parts.some((part) => part.includes(".internal."));
    }
    if (glob === "**/internal/**") {
      return parts.includes("internal");
    }
    if (glob === "*-internal/**") {
      return parts.some((part) => part.endsWith("-internal"));
    }
    return false;
  });
}

function isExcludedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const file = parts.at(-1);
  return EXCLUDES.some((pattern) => {
    if (pattern === "feedback.md") return file === pattern;
    if (pattern === "evals/") return parts.includes("evals");
    if (pattern === ".DS_Store") return file === pattern;
    if (pattern === "*.local.md") return file.endsWith(".local.md");
    return false;
  });
}

function walkFiles(root) {
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink()) {
    throw new Error(`${root}：不允许软链接条目`);
  }
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) {
    throw new Error(`${root}：不支持的文件系统条目`);
  }
  return readdirSync(root)
    .sort()
    .flatMap((entry) => walkFiles(join(root, entry)));
}

function copyTree(sourceRoot, targetRoot) {
  for (const sourcePath of walkFiles(sourceRoot)) {
    const targetPath = join(targetRoot, relative(sourceRoot, sourcePath));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function runRsyncAbsolute(sourceRoot, targetRoot, exec) {
  return exec(
    "rsync",
    rsyncAbsoluteArgs({
      sourceDir: sourceRoot,
      targetDir: targetRoot,
      dryRun: false,
    }),
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
}

function rsyncAbsoluteArgs({ sourceDir, targetDir, dryRun }) {
  return [
    "-a",
    "--delete",
    "--delete-excluded",
    "--itemize-changes",
    ...(dryRun ? ["-n"] : []),
    "--checksum",
    ...EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    sourceDir.endsWith("/") ? sourceDir : sourceDir + "/",
    targetDir.endsWith("/") ? targetDir : targetDir + "/",
  ];
}

function rsyncChangePath(line) {
  if (line.startsWith("*deleting ")) return line.slice("*deleting ".length);
  const separator = line.indexOf(" ");
  return separator === -1 ? line : line.slice(separator + 1).trim();
}

function validateGeneratedControls(layout, digests) {
  validateAuthoringLayout(layout);
  if (!isRecord(digests?.edges) || Object.keys(digests.edges).length === 0) {
    throw new Error("Digest 控制必须包含边清单");
  }
  for (const edge of Object.keys(layout.edges)) {
    if (!isRecord(digests.edges[edge])) {
      throw new Error(`Digest 控制缺少边 ${edge}`);
    }
  }
}

function validateAuthoringLayout(layout) {
  if (!isRecord(layout?.edges) || Object.keys(layout.edges).length === 0) {
    throw new Error("Layout 控制必须包含 edges");
  }
  const edgeNames = Object.keys(layout.edges).sort();
  const requiredEdges = ["canonical", "plugin", "spec"];
  if (
    edgeNames.length !== requiredEdges.length ||
    edgeNames.some((edge, index) => edge !== requiredEdges[index])
  ) {
    throw new Error(
      "Layout 控制必须恰好包含 canonical、plugin、spec 三条边",
    );
  }
  if (!isRecord(layout.skills) || Object.keys(layout.skills).length === 0) {
    throw new Error("Layout 控制必须包含 skills");
  }
  for (const [edge, config] of Object.entries(layout.edges)) {
    if (
      !isRecord(config) ||
      typeof config.path !== "string" ||
      config.path.length === 0 ||
      !["categorized", "mirror-of-spec", "flat"].includes(config.layout)
    ) {
      throw new Error(`Layout 控制中有非法边 ${edge}`);
    }
  }
  for (const [skill, config] of Object.entries(layout.skills)) {
    if (
      !isRecord(config) ||
      !Array.isArray(config.edges) ||
      config.edges.length === 0 ||
      config.edges.some((edge) => !Object.hasOwn(layout.edges, edge))
    ) {
      throw new Error(`Layout 控制中有非法 skill ${skill}`);
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
