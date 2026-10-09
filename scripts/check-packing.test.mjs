import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("npm pack of @openrig/cli includes scripts/check-abi.mjs in tarball", () => {
  const output = execSync("npm pack --dry-run --json 2>/dev/null", {
    cwd: "packages/cli",
    encoding: "utf-8",
  });
  const entries = JSON.parse(output);
  const files = entries[0]?.files?.map((f) => f.path) ?? [];

  assert.ok(
    files.some((f) => f.includes("scripts/check-abi.mjs")),
    `scripts/check-abi.mjs missing from npm pack output. Published tarball will fail postinstall.\nFiles found: ${files.filter((f) => f.includes("scripts")).join(", ") || "(none under scripts/)"}`
  );
});

test("product-team topology defaults have a clean-checkout source and package path", () => {
  const expectedDefaults = [
    "instance/CRAFT.md",
    "rig/CRAFT.md",
    "rig/ORCHESTRATION-CRAFT.md",
    "seats/orch1-lead/CRAFT.md",
    "seats/rev1-r1/CRAFT.md",
    "seats/rev1-r2/CRAFT.md",
    "seats/dev1-qa/CRAFT.md",
  ];
  const sourceRoot = "packages/daemon/specs/rigs/preview/product-team/topology";
  for (const rel of expectedDefaults) {
    const source = `${sourceRoot}/${rel}`;
    assert.ok(existsSync(source), `shipped product-team topology default missing from source: ${source}`);
    assert.ok(readFileSync(source).length > 0, `shipped product-team topology default is empty: ${source}`);
  }

  const buildScript = readFileSync("scripts/build-package.sh", "utf-8");
  assert.match(
    buildScript,
    /cp -r "\$DAEMON_DIR\/specs" "\$CLI_DIR\/daemon\/specs"/,
    "build-package no longer stages the complete daemon specs tree; product-team topology defaults would be absent from the published CLI package",
  );
  const pkg = JSON.parse(readFileSync("packages/cli/package.json", "utf-8"));
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("daemon"),
    `packages/cli must publish the staged daemon tree. Found files: ${JSON.stringify(pkg.files)}`,
  );
});

test("build-package scans the complete daemon specs tree before LP-7 copies it", () => {
  const buildScript = readFileSync("scripts/build-package.sh", "utf8");
  const scan = buildScript.indexOf("check-internal-leak-guard.mjs");
  const specsTree = buildScript.indexOf('"$DAEMON_DIR/specs"', scan);
  const copy = buildScript.indexOf('cp -r "$DAEMON_DIR/specs" "$CLI_DIR/daemon/specs"');

  assert.ok(scan >= 0, "build-package must run the internal leak guard at the tarball trust boundary");
  assert.ok(specsTree > scan, "the package-boundary guard must explicitly scan the complete daemon specs tree");
  assert.ok(copy > specsTree, "the specs scan must finish before the wholesale LP-7 copy");
});

test("build-package emits the substance roots from the staging branches that actually ran", () => {
  const buildScript = readFileSync("scripts/build-package.sh", "utf8");
  assert.match(buildScript, /SUBSTANCE_SURFACE_ROOTS=\(\)/);
  assert.match(buildScript, /cp -r "\$DAEMON_DIR\/assets"[\s\S]*SUBSTANCE_SURFACE_ROOTS\+=\("daemon\/assets"\)/);
  assert.match(buildScript, /cp -r "\$DAEMON_DIR\/specs"[\s\S]*SUBSTANCE_SURFACE_ROOTS\+=\("daemon\/specs"\)/);
  assert.match(buildScript, /cp -r "\$DAEMON_DIR\/context-packs"[\s\S]*SUBSTANCE_SURFACE_ROOTS\+=\("daemon\/context-packs"\)/);
  assert.match(buildScript, /substance-surfaces\.json/);
});

test("the private product-factory VPS runbook and its pointers do not ship", () => {
  const privateRunbook = "docs/reference/product-factory-vps-runbook.md";
  assert.equal(
    existsSync(privateRunbook),
    false,
    `${privateRunbook} is private operator canon and must not ship in the public repo or package`,
  );

  const publicPointerSources = [
    "CHANGELOG.md",
    "scripts/bootstrap-product-factory-vps.sh",
    "docs/as-built/cli-reference.md",
    "packages/daemon/assets/plugins/openrig-core/skills/openrig-user/SKILL.md",
  ];
  for (const source of publicPointerSources) {
    assert.doesNotMatch(
      readFileSync(source, "utf8"),
      /product-factory-vps-runbook/,
      `${source} still points public readers at the private VPS runbook`,
    );
  }
});

// aa922842——conventions 文档经一个三路模型到达 agent：
//   仓库源码        docs/reference/sdlc-conventions.md            （仓库读者所引用的）
//   打包后内部      daemon/docs/reference/sdlc-conventions.md     （仅组装输入——
//                                                                   绝不作为用户路径传授）
//   安装后稳定版    $OPENRIG_HOME/reference/sdlc-conventions.md   （默认 ~/.openrig/…）
// daemon 启动时通过相对其 dist 目录读 `../docs/reference`
// （packages/daemon/src/startup.ts）来物化这个稳定路径，这正是 scripts/build-package.sh
// 把文档暂存到 daemon/docs/reference/ 的原因。这个内部输入因此是承重的、而今天完全无人守护：
// 若拷贝这一步退化，稳定路径会默默停止物化，所有传授指针都会过期，却没有任何测试失败。本测试把它钉住。
// 构造上自包含：packages/cli/daemon 是被 gitignore 的构建产物，因此任何读它（或对着它跑 `npm pack`）
// 的断言，都会在一台带过期组装包的开发机上通过、却在干净检出里、任何东西还没构建时失败。本测试因此
// 只用 git 跟踪的输入，断言使稳定路径成立的那三条契约，绝不运行或改动真实的包构建。
test("build-package stages the conventions doc as the daemon's stable-path input, and the package allowlist ships it", () => {
  const buildScript = readFileSync("scripts/build-package.sh", "utf-8");

  // (a) 暂存契约——build-package 必须把仓库的 docs/reference 暂存到
  //     daemon/docs/reference。daemon 启动时从其 dist 目录解析
  //     `../docs/reference` 以物化 $OPENRIG_HOME/reference/；如果此暂存被
  //     丢弃或重定向，稳定的 agent 面向路径会静默消失。
  assert.match(
    buildScript,
    /mkdir -p "\$CLI_DIR\/daemon\/docs\/reference"/,
    "scripts/build-package.sh no longer creates daemon/docs/reference — the daemon's startup resolver (../docs/reference) would find nothing and $OPENRIG_HOME/reference/ would never materialize."
  );
  assert.match(
    buildScript,
    /cp -r "\$REPO_ROOT\/docs\/reference\/"\* "\$CLI_DIR\/daemon\/docs\/reference\/"/,
    "scripts/build-package.sh no longer copies docs/reference verbatim into the staged package. Byte preservation is what makes the shipped conventions doc trustworthy — a transforming copy (sed/awk/envsubst) would let installed agents read something the repo never said."
  );

  // (b) 收录契约——npm 只发布 files 白名单里命名的内容。如果 "daemon"
  //     不在白名单，暂存到 daemon/ 毫无用处。
  const pkg = JSON.parse(readFileSync("packages/cli/package.json", "utf-8"));
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes("daemon"),
    `packages/cli package.json "files" must include "daemon" or nothing staged there is published. Found: ${JSON.stringify(pkg.files)}`
  );

  // (c) 源契约——被暂存的文档必须在仓库中真实存在且非平凡。
  //     这是 git 跟踪的输入；上面一切都是围绕它的管道。
  const repoDoc = readFileSync("docs/reference/sdlc-conventions.md");
  assert.ok(
    repoDoc.length > 1000,
    `docs/reference/sdlc-conventions.md is ${repoDoc.length}B — implausibly small for the conventions SSOT; staging would ship a truncated doc.`
  );
});

// 机会性检查，绝不强制：当已组装的包恰好存在时，验证暂存副本确实逐字节相同。
// 在干净 checkout 中跳过（而非失败），因此本检查不会让 `npm run test:repo`
// 依赖构建状态——上面的契约是密封保证；这是对实际产物的双保险检查。
test("staged conventions doc is byte-identical to the repo source (skipped when no assembled package present)", (t) => {
  const staged = "packages/cli/daemon/docs/reference/sdlc-conventions.md";
  if (!existsSync(staged)) {
    t.skip("no assembled package at packages/cli/daemon — run scripts/build-package.sh to exercise this check");
    return;
  }
  const repoDoc = readFileSync("docs/reference/sdlc-conventions.md");
  const stagedDoc = readFileSync(staged);
  assert.ok(
    repoDoc.equals(stagedDoc),
    `${staged} is not byte-identical to docs/reference/sdlc-conventions.md (repo ${repoDoc.length}B vs staged ${stagedDoc.length}B). Re-run scripts/build-package.sh; a drifted staged copy teaches installed agents stale conventions.`
  );
});
