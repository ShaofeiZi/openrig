// 来自 QA qitem-20260518054224 的基线狗食守卫。
//
// 抓“源码里合了、但经真实 CLI 看不到”——这一类失败：切片工作落进了
// `packages/daemon/dist` 与 `packages/daemon/specs`，但 `packages/cli/daemon/{dist,specs}`
// 处的 vendored 副本过期了（它只由 `scripts/build-package.sh` 重建）。在
// baseline-fix-packaging 上的修复之前，从 monorepo 检出跑 `rig daemon start` 会启动那个过期的
// vendored daemon，于是 /api/rig-policy/*（slice 09）和 conveyor spec 里的 review-feedback 修复
// （slice 01）都无法经用户面向的 CLI 路径触达，哪怕真相源里已经有它们。
//
// 本守卫只在两条路径都存在时运行（即一个已组装 vendored 包的 monorepo 开发检出）。在那种状态下，
// vendored 副本必须带与源码相同的承重表面——否则就是组装过期，必须重跑 `scripts/build-package.sh`。
//
// 两个收窄的判别信号，都对应 baseline-dogfood 的发现：
//
//   1. slice 09 rig-policy 回归——vendored daemon dist 必须包含 rig-policy 路由模块 +
//      它在 server.js 里的注册。(qitem-20260518054224)
//
//   2. slice 01 conveyor 环回归——vendored conveyor spec 必须把
//      review.reviewer → build.builder 这条边标为 `can_observe`（slice-01 在 f3449baf 的修复），
//      而不是 `delegates_to`（后者会让 `rig up conveyor` 以 cycle_error 拒绝）。
//      (qitem-20260518054046)
//
// 运行时 resolveDaemonPath 的修复意味着：从 monorepo 跑 `rig daemon start` 时，即便 vendored 过期也更倾向
// 源码，所以用户路径不再被过期弄坏——但组装出的包对 `npm publish` 仍然要紧。本守卫仍是组装质量闸门。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SRC_DAEMON_DIST = path.join(REPO_ROOT, "packages/daemon/dist");
const VEND_DAEMON_DIST = path.join(REPO_ROOT, "packages/cli/daemon/dist");
const SRC_SPECS = path.join(REPO_ROOT, "packages/daemon/specs");
const VEND_SPECS = path.join(REPO_ROOT, "packages/cli/daemon/specs");

function vendoredAssembled() {
  return fs.existsSync(path.join(VEND_DAEMON_DIST, "index.js"));
}

test("baseline-fix-packaging guard: vendored daemon dist carries slice-09 rig-mode routes when assembled (qitem-20260518054224)", () => {
  if (!vendoredAssembled()) {
    // 无 vendored 组装（全新 clone 或干净状态）——守卫不适用。
    // 运行时 resolveDaemonPath 修复后，CLI 更倾向使用源码 anyway。
    return;
  }
  assert.ok(
    fs.existsSync(path.join(VEND_DAEMON_DIST, "routes/rig-mode.js")),
    "Vendored daemon at packages/cli/daemon/dist/routes/rig-mode.js is missing. Slice 09 (OPR.0.3.2.9) shipped this route module (renamed from rig-policy in 0.5.3); if vendored bundle exists it MUST carry it. Re-run scripts/build-package.sh to refresh."
  );
  const serverJs = fs.readFileSync(path.join(VEND_DAEMON_DIST, "server.js"), "utf-8");
  assert.ok(
    serverJs.includes("rigModeRoutes") && serverJs.includes("/api/rig-mode"),
    "Vendored daemon server.js does not register /api/rig-mode routes. This is the exact baseline-dogfood failure that masked slice 09. Re-run scripts/build-package.sh."
  );
});

test("baseline-fix-packaging guard: vendored conveyor spec carries slice-01 can_observe edge when assembled (qitem-20260518054046)", () => {
  // 仅当完全没有组装 vendored 包时才跳过（全新 clone / 干净状态）。
  // 按守卫裁决 qitem-20260518055713：已组装的包（dist 存在）但缺
  // conveyor spec 是过期/不完整产物，必须失败本闸门，而非静默跳过。
  if (!vendoredAssembled()) {
    return;
  }
  const vendoredSpecPath = path.join(VEND_SPECS, "rigs/launch/conveyor/rig.yaml");
  assert.ok(
    fs.existsSync(vendoredSpecPath),
    `Vendored daemon dist is assembled but packages/cli/daemon/specs/rigs/launch/conveyor/rig.yaml is missing. scripts/build-package.sh assembles BOTH dist + specs; an assembled bundle without specs is an incomplete artifact that would break \`rig up conveyor\`. Re-run scripts/build-package.sh.`,
  );
  const vendoredSpec = fs.readFileSync(vendoredSpecPath, "utf-8");

  // slice 01 的 review feedback 修复：review.reviewer → build.builder 是
  // can_observe（非 delegates_to）。vendored spec 若此处仍是
  // `delegates_to` 则是 slice-01 之前的过期状态，`rig up conveyor` 会以
  // cycle_error 拒绝。
  //
  // 判别方法：按 from/to 锚点定位该边，确认其 `kind:` 行为 `can_observe`。
  // 匹配 spec 中使用的精确 YAML 块形状。
  const cycleReviewerToBuilder = /from:\s*review\.reviewer\s*\n\s*to:\s*build\.builder/m.test(vendoredSpec);
  if (!cycleReviewerToBuilder) {
    // spec 可能已重构；对照源码验证，让下方第二个守卫测试捕捉同步漂移。
    return;
  }

  // 找到紧接在 `from: review.reviewer / to: build.builder` 块之前的
  // kind 行。不带 global 标志的 .match() 返回第一个匹配，因此倒走需要
  // matchAll + 取最后一个。
  const idx = vendoredSpec.search(/from:\s*review\.reviewer\s*\n\s*to:\s*build\.builder/);
  const before = vendoredSpec.slice(0, idx);
  const kindMatches = [...before.matchAll(/kind:\s*(\w+)/g)];
  const lastKind = kindMatches[kindMatches.length - 1];
  assert.ok(lastKind, "Could not locate kind for review.reviewer→build.builder edge in vendored conveyor spec.");
  assert.strictEqual(
    lastKind[1],
    "can_observe",
    `Vendored conveyor spec has review.reviewer→build.builder as '${lastKind[1]}', expected 'can_observe' (slice 01 fix at f3449baf). 'delegates_to' here triggers cycle_error on \`rig up conveyor --yes\`. Re-run scripts/build-package.sh.`,
  );
});

test("baseline-fix-packaging guard: vendored daemon dist+specs match source when both exist (general staleness)", () => {
  if (!vendoredAssembled()) return;

  // 钉住一组我们知道在 0.3.2 近期发布的文件，逐字节比较。
  // 廉价、确定性、无时间戳游戏。
  const pinned = [
    "server.js",
    "routes/rig-policy.js",
    "domain/rig-policy/rig-policy-types.js",
  ];
  for (const rel of pinned) {
    const srcPath = path.join(SRC_DAEMON_DIST, rel);
    const vendPath = path.join(VEND_DAEMON_DIST, rel);
    if (!fs.existsSync(srcPath)) continue;
    if (!fs.existsSync(vendPath)) {
      assert.fail(`Vendored ${rel} missing while source exists. Vendored bundle is stale; run scripts/build-package.sh.`);
    }
    const srcBytes = fs.readFileSync(srcPath);
    const vendBytes = fs.readFileSync(vendPath);
    assert.deepStrictEqual(
      Array.from(vendBytes),
      Array.from(srcBytes),
      `Vendored daemon ${rel} bytes differ from source. Vendored bundle is stale; run scripts/build-package.sh.`,
    );
  }

  // 对 conveyor spec（slice-01 感知的产物）做同样检查。
  // 按守卫裁决 qitem-20260518055713：当包已组装且源码有 spec 时，
  // vendored 也必须有它——缺失 = 失败，而非跳过。
  const conveyorRel = "rigs/launch/conveyor/rig.yaml";
  const srcConveyor = path.join(SRC_SPECS, conveyorRel);
  const vendConveyor = path.join(VEND_SPECS, conveyorRel);
  if (fs.existsSync(srcConveyor)) {
    assert.ok(
      fs.existsSync(vendConveyor),
      `Source conveyor spec exists but vendored copy at packages/cli/daemon/specs/${conveyorRel} is missing. Assembled bundle is incomplete; run scripts/build-package.sh to assemble both dist + specs.`,
    );
    assert.strictEqual(
      fs.readFileSync(vendConveyor, "utf-8"),
      fs.readFileSync(srcConveyor, "utf-8"),
      `Vendored conveyor spec differs from source. Re-run scripts/build-package.sh to refresh both dist and specs.`,
    );
  }
});
