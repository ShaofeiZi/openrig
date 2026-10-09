import { execFileSync } from "node:child_process";

/**
 * 三个持久根目录之外、被 git 跟踪的 docs 路径白名单（精确路径）。
 *
 * `docs/DESIGN.md` 是 canonical 的视觉/品牌/设计系统规范，它放在仓库根是经批准的既定准则，
 * 不是漂移：`docs/as-built/ui/library-specs-and-design-system.md` §4 写明
 * “Q1 已批准：DESIGN.md 留在根目录，字节一致”，并明确拒绝放进 `docs/as-built/`。
 * 本护栏此前只是没把这条决策编码进去而已。
 *
 * 它也无法靠“挪进某个允许的根”来满足：
 *   docs/as-built/  —— 那里每个文件都带 `last-verified-against-source`；DESIGN.md 并非源自源码，
 *                     Q1 已点名排除这个落点
 *   docs/reference/ —— 该目录会随包发布（scripts/build-package.sh 把它打进包，
 *                     daemon 再物化到 $OPENRIG_HOME/reference/），挪过去等于把品牌规范分发给每个操作者
 *   docs/releases/  —— 它不是发行说明
 *
 * 因此在这里作为“精确路径”点名允许，而不是挪走或放宽目录白名单。请保持这种精确路径写法：
 * 本护栏强制的政策是“松散的计划与笔记保持未跟踪”，一旦开个目录口子，就会恰恰把这些东西悄悄放回来。
 */
const ALLOWED_DOCS_FILES = new Set(["docs/DESIGN.md"]);

export function findBlockedDocsPaths(paths) {
  return [...new Set(paths)]
    .filter((file) => file.startsWith("docs/"))
    .filter((file) => !file.startsWith("docs/as-built/"))
    .filter((file) => !file.startsWith("docs/reference/"))
    .filter((file) => !file.startsWith("docs/releases/"))
    .filter((file) => !ALLOWED_DOCS_FILES.has(file))
    .sort();
}

export function listTrackedDocsPaths(exec = execFileSync) {
  const output = exec("git", ["ls-files", "docs/**"], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildDocsGuardMessage(blockedPaths) {
  const lines = [
    "Blocked tracked docs paths detected outside docs/as-built/, docs/reference/, and docs/releases/:",
    ...blockedPaths.map((file) => `- ${file}`),
    "",
    "Only docs/as-built/, docs/reference/, and docs/releases/ are allowed to be tracked.",
    "Keep plans and local notes untracked under docs/ or move durable docs into docs/as-built/, docs/reference/, or docs/releases/ if they truly belong in git.",
  ];
  return lines.join("\n");
}

export function main() {
  const blockedPaths = findBlockedDocsPaths(listTrackedDocsPaths());
  if (blockedPaths.length === 0) return;
  console.error(buildDocsGuardMessage(blockedPaths));
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
