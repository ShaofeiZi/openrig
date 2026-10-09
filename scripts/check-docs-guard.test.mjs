import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDocsGuardMessage, findBlockedDocsPaths } from "./check-docs-guard.mjs";

test("findBlockedDocsPaths allows durable docs folders and rejects other docs paths", () => {
  const blocked = findBlockedDocsPaths([
    "docs/as-built/architecture.md",
    "docs/reference/rig-spec.md",
    "docs/releases/v0.1.12.md",
    "docs/plans/2026-04-10-thing.md",
    "docs/local/notes.md",
    "README.md",
    "docs/plans/2026-04-10-thing.md",
  ]);

  assert.deepEqual(blocked, [
    "docs/local/notes.md",
    "docs/plans/2026-04-10-thing.md",
  ]);
});

test("buildDocsGuardMessage explains the policy and offending files", () => {
  const message = buildDocsGuardMessage([
    "docs/plans/example.md",
  ]);

  assert.match(message, /Blocked tracked docs paths/);
  assert.match(message, /docs\/plans\/example\.md/);
  assert.match(message, /docs\/as-built\/, docs\/reference\/, and docs\/releases\//);
});

// 572bc477——docs/DESIGN.md 是已批准的准则，而守卫没把它编码进去。
//
// `docs/as-built/ui/library-specs-and-design-system.md` §4 直说了：“canonical 的 OpenRig
// 视觉/设计系统就是 `docs/DESIGN.md`（在仓库 `docs/` 根下，不在 `docs/as-built/` 下）。
// Q1 已批准：DESIGN.md 留在根，字节一致。”
//
// 因此放在根是一个刻意、有记录的决定——不是待收拾的漂移。它也无法通过挪进任何允许的根来满足：
//   docs/as-built/  ——那里 24 个文件都带 `last-verified-against-source`；DESIGN.md 并非源自源码，
//                     况且 Q1 本就明确排除这条
//   docs/reference/ ——那个目录是要发货的（build-package.sh 把它暂存进包，daemon 把它物化为
//                     $OPENRIG_HOME/reference/），挪过去就会开始把品牌分发给每个操作者
//   docs/releases/  ——不是发行说明
// 所以这一个文件被显式点名，而不是挪走，目录白名单保持不动。今天的后果：根目录的
// `npm run test:repo` 在干净树上过不了，这会训练人们去忽视一个本来在干实事的闸门。
test("findBlockedDocsPaths allows the ratified docs/DESIGN.md root placement", () => {
  assert.deepEqual(findBlockedDocsPaths(["docs/DESIGN.md"]), []);
});

// 守卫的守卫：例外必须是精确路径，绝不能变成 docs/ 根下的一个洞。若这条哪天对一个根下的兄弟文件
// 也变绿，说明修复已被放宽成了目录级放行，守卫本要强制的“临时文件”政策也就没了。
// 刻意不在输入里包含 docs/DESIGN.md：这个钉在修复前后必须完全一样地成立。把它和新放行耦合在一起，
// 会让它变成第三个 RED，毁掉它的价值——一个只有在你改了代码之后才开始通过的“不变量”，不是不变量，
// 而是对该功能的复述。
test("the DESIGN.md exception is exact-path — sibling root docs and plan/note folders stay blocked", () => {
  assert.deepEqual(
    findBlockedDocsPaths([
      "docs/OTHER.md",
      "docs/plans/example.md",
      "docs/notes/scratch.md",
    ]),
    ["docs/OTHER.md", "docs/notes/scratch.md", "docs/plans/example.md"],
  );
});

// 集成：如果真实脚本在真实树上仍然失败，上面的单元契约就毫无价值。
// 本测试断言操作者可见的实际结果——`npm run test:repo` 可以变绿并因此重新可信。
test("the real check-docs-guard.mjs exits 0 against the actual repository", () => {
  // process.execPath，而不是环境里的 "node"：把子进程钉到执行本测试的同一个运行时，
  // 而不是 PATH 碰巧解析到的那个。
  // 用 fileURLToPath，而不是 URL.pathname：pathname 保留百分号转义，所以一个放在含空格路径下的
  // 检出会默默解析到错误的 cwd——本仓库没有空格，朴素写法在“这里”能过、在别处却失败，
  // 这是最糟糕的那种绿。
  const result = execFileSync(process.execPath, ["scripts/check-docs-guard.mjs"], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.trim(), "");
});
