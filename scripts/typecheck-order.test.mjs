import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// P9——仓库构建顺序的编码。cli 的 tsc 通过 daemon 已构建的 dist .d.ts 解析
// `@openrig/daemon/crash-cart`（打包裁决 A + paths 映射）。因此 typecheck-all 这条路径必须先构建
// daemon dist，再跑 cli tsc——否则全新检出会在 cli tsc 处以 TS2307 失败。这个守卫把该顺序钉在仓库里
// （自携带，而不只在桌面侧）。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("lint builds the daemon dist BEFORE the cli tsc", () => {
  const lint = pkg.scripts.lint;
  const prepAt = lint.indexOf("typecheck:prep");
  const cliTscAt = lint.indexOf("packages/cli/tsconfig");
  assert.ok(prepAt >= 0, "lint must build the daemon dist (typecheck:prep) first");
  assert.ok(cliTscAt >= 0, "lint must typecheck the cli");
  assert.ok(prepAt < cliTscAt, "the daemon-dist build must precede the cli tsc (clean-checkout safety)");
});

test("typecheck:prep builds the daemon (emitting the dist the cli tsc consumes)", () => {
  assert.match(pkg.scripts["typecheck:prep"], /build\b.*packages\/daemon|build -w packages\/daemon/);
});
