import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { remainingDaemonImports } from "./rewrite-daemon-imports.mjs";

// 51-04 Q2——打包这一步的证明。旧守卫只对 `npm pack` 做字符串匹配，因此在三处叠加的破坏下
// （根包 / 无 bin / 不可独立安装）一直保持绿。分层：
//   1. 快速离线预检——tarball 是 @openrig/cli，附带 `rig` bin，且不依赖未发布的 @openrig/daemon
//      （#66：忽略 bundling 的包管理器会去 registry 试，结果 404）；
//   2. 打包证明（宿主机可跑）——经 build-package.sh 组装 + pack，并证明 tarball 在 daemon/dist 下
//      附带 daemon exports-map 各表面，且没有任何被打包的 JS 仍 import @openrig/daemon；
//   3. 完整 install+LOAD 闸门（可选 RUN_TESTBED_PACK_GATE=1）——桌面裁决的效果证明，在一个干净目标上：
//      安装 + 跑一条会加载 daemon 的命令。它需要目标机构建工具，因为 better-sqlite3 在其随包预编译
//      缺少该平台时会在目标机上源码构建（桌面附注 1）；在没有这些工具的宿主机上它会停在那次原生构建，
//      因此操作者在 Debian Docker 里的重跑，本身就是这个闸门。

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_DIR = join(REPO_ROOT, "packages", "cli");
// 打包后 cli 的运行时值 import 所解析到的 daemon exports-map 表面。
const DAEMON_SURFACES = [
  "daemon/dist/gateway-human-registry-surface.js",
  "daemon/dist/crash-cart-surface.js",
  "daemon/dist/gateway-slack-surface.js",
];

test("pre-check: @openrig/cli, ships the `rig` bin, and does not depend on the unpublished @openrig/daemon", () => {
  const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8"));
  assert.equal(pkg.name, "@openrig/cli", "must pack @openrig/cli, not the root openrig");
  assert.equal(pkg.bin?.rig, "dist/bin-wrapper.js", "@openrig/cli must declare the `rig` bin");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(pkg[field]?.["@openrig/daemon"], undefined, `@openrig/daemon must not be in ${field} (it is unpublished)`);
  }
  for (const field of ["bundledDependencies", "bundleDependencies"]) {
    assert.ok(!(pkg[field] ?? []).includes("@openrig/daemon"), `@openrig/daemon must not be in ${field}`);
  }
});

test("package proof: the tarball ships the daemon surfaces and no packaged JS imports @openrig/daemon", () => {
  // 组装（暂存 daemon/、重写 daemon import）——较重，但不安装、不做原生构建
  execFileSync("bash", [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  assert.ok(!existsSync(join(CLI_DIR, "node_modules", "@openrig", "daemon")),
    "build-package.sh must not leave a bundled <cli>/node_modules/@openrig/daemon copy");

  const tgz = execFileSync("npm", ["pack", "--silent"], { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
  const tgzPath = join(CLI_DIR, tgz);
  const extract = mkdtempSync(join(tmpdir(), "q2-pack-content-"));
  try {
    const listing = execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
    assert.match(listing, /^package\/dist\/bin-wrapper\.js$/m, "the tarball must ship the `rig` bin");
    assert.match(listing, /^package\/tui\/dist\/main\.js$/m, "the tarball must ship the `openrig-tui` bin");
    assert.doesNotMatch(listing, /^package\/node_modules\//m, "the tarball must not bundle node_modules");
    for (const surface of DAEMON_SURFACES) {
      assert.match(listing, new RegExp(`^package/${surface.replace(/[.]/g, "\\.")}$`, "m"),
        `the shipped daemon must include ${surface} (a value-import resolution target)`);
    }
    const packed = JSON.parse(execFileSync("tar", ["-xzOf", tgzPath, "package/package.json"], { encoding: "utf8" }));
    assert.equal(packed.dependencies?.["@openrig/daemon"], undefined, "the packed manifest must not depend on @openrig/daemon");
    assert.equal(packed.bundledDependencies, undefined, "the packed manifest must not bundle dependencies");

    execFileSync("tar", ["-xzf", tgzPath, "-C", extract]);
    const left = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".js")) left.push(...remainingDaemonImports(readFileSync(path, "utf8")).map((m) => `${path}: ${m}`));
      }
    };
    walk(join(extract, "package", "dist"));
    walk(join(extract, "package", "tui", "dist"));
    assert.deepEqual(left, [], "no packaged cli/tui JS may import @openrig/daemon");
  } finally {
    rmSync(tgzPath, { force: true });
    rmSync(extract, { recursive: true, force: true });
  }
});

test("install RED (resident, docker-free): a clean install materializes a COMPLETE better-sqlite3 (binding.gyp present)", () => {
  // Q2 break #5（历史背景：daemon 现已不再随包附带）：随包附带的 @openrig/daemon package.json 声明了它的
  // cli 子集依赖（better-sqlite3 + hono/tar/ulid/yaml/@hono/*），于是 `npm install -g` 把它们当作由
  // @openrig/daemon 底下的 bundle 提供，留下一个空的 <cli>/node_modules/better-sqlite3（没有 binding.gyp →
  // 'prebuild-install: not found' + 'binding.gyp not found'）。上面那条“包内容”断言
  // （daemon 在场 + better-sqlite3 缺席）会对这个假绿——它在破损的包上照样通过。该效果要再往下一层、
  // 在安装时才看得见。--ignore-scripts 会跳过原生构建，所以本检查与工具链无关、且很快（比容器闸门
  // 早一层抓到该效果）。
  execFileSync("bash", [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  const prefix = mkdtempSync(join(tmpdir(), "q2-install-red-"));
  let tgzPath;
  try {
    const tgz = execFileSync("npm", ["pack", "--silent"], { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
    tgzPath = join(CLI_DIR, tgz);
    execFileSync("npm", ["install", "-g", "--prefix", prefix, "--ignore-scripts", tgzPath], { cwd: REPO_ROOT, stdio: "inherit" });
    const bsq3 = join(prefix, "lib", "node_modules", "@openrig", "cli", "node_modules", "better-sqlite3");
    assert.ok(existsSync(bsq3), "a clean install must materialize the cli-level better-sqlite3 dir");
    assert.ok(existsSync(join(bsq3, "binding.gyp")),
      "better-sqlite3 must be COMPLETE (binding.gyp present) — an EMPTY placeholder is the bundled-daemon-deps break #5 the pack-content assertion cannot see");
    assert.ok(existsSync(join(bsq3, "package.json")),
      "better-sqlite3 must be the full registry copy (package.json present), not an npm placeholder dir");
  } finally {
    if (tgzPath) rmSync(tgzPath, { force: true });
    rmSync(prefix, { recursive: true, force: true });
  }
});

const RUN_GATE = process.env.RUN_TESTBED_PACK_GATE === "1";
test("GATE (target-native): install the tarball + a cli command LOADS the daemon subpath", { skip: RUN_GATE ? false : "opt-in RUN_TESTBED_PACK_GATE=1; needs TARGET build tools (better-sqlite3 builds fresh) — the operator's Docker rerun is this gate" }, () => {
  execFileSync("bash", [join(REPO_ROOT, "scripts", "build-package.sh")], { cwd: REPO_ROOT, stdio: "inherit" });
  const prefix = mkdtempSync(join(tmpdir(), "q2-gate-prefix-"));
  const home = mkdtempSync(join(tmpdir(), "q2-gate-home-"));
  let tgzPath;
  try {
    const tgz = execFileSync("npm", ["pack", "--silent"], { cwd: CLI_DIR, encoding: "utf8" }).trim().split("\n").filter(Boolean).pop();
    tgzPath = join(CLI_DIR, tgz);
    execFileSync("npm", ["install", "-g", "--prefix", prefix, tgzPath], { cwd: REPO_ROOT, stdio: "inherit" });
    const rigBin = join(prefix, "bin", "rig");
    const out = execFileSync(rigBin, [
      "gateway", "human", "add", "gateuser",
      "--display-name", "Gate User",
      "--binding", "slack:main:vault://slack/gate:primary:handle=UGATE",
      "--delivery-class", "B",
    ], { encoding: "utf8", env: { ...process.env, OPENRIG_HOME: home } });
    assert.match(out, /"ok":\s*true|gateuser/, "`rig gateway human add` must succeed, proving @openrig/daemon resolved on a clean install");
    assert.ok(existsSync(join(home, "gateway", "humans", "gateuser.yaml")), "the daemon-backed verb must have written the fragment");
  } finally {
    if (tgzPath) rmSync(tgzPath, { force: true });
    rmSync(prefix, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
