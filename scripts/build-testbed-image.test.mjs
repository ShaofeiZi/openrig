import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 51-04 testbed 镜像——构建命令（scripts/build-testbed-image.sh）在宿主机侧执行（它需要 docker；
// locus 裁决把容器运行时放在宿主机侧）。它真正的逻辑在已被测试的 node 助手
// （testbed-emit-manifest / build-inputs / manifest）里；这个守卫是“VM 可编写”的证明，
// 证明 shell 包装器遵守计划 §1 + FENCES 契约，使日后某次编辑——推送镜像、让构建浮动、
// 或从 registry 拉 openrig——都在这里破坏构建。

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "build-testbed-image.sh");
const DOCKERFILE = join(HERE, "..", "docker", "testbed", "Dockerfile");

function readScript() {
  return readFileSync(SCRIPT, "utf8");
}

function readDockerfile() {
  return readFileSync(DOCKERFILE, "utf8");
}

test("is a strict bash script (shebang + set -euo pipefail)", () => {
  const text = readScript();
  assert.match(text, /^#!.*\b(bash|sh)\b/, "must have a shell shebang");
  assert.match(text, /set -euo pipefail/, "must fail-fast (set -euo pipefail)");
});

test("derives the image tag from the git sha (openrig-testbed:<git-sha>)", () => {
  const text = readScript();
  assert.match(text, /git\s+(?:-C\s+\S+\s+)?rev-parse/, "must resolve the git sha via git rev-parse");
  assert.match(text, /openrig-testbed:/, "must tag openrig-testbed:<git-sha>");
});

test("builds OpenRig from the tree via npm pack — never npm publish, never the registry", () => {
  const text = readScript();
  assert.match(text, /npm pack/, "must build the tarball from the tree via npm pack");
  assert.doesNotMatch(text, /npm\s+publish/, "must NOT npm publish");
  assert.doesNotMatch(
    text,
    /npm\s+(?:install|i|add)\s+(?:-g\s+)?openrig(?:@|\s|$)/m,
    "must NOT install openrig from the npm registry",
  );
});

test("runs docker build with the digest-pinned base + tarball build-args", () => {
  const text = readScript();
  assert.match(text, /docker build/, "must docker build");
  assert.match(text, /--build-arg\s+BASE_IMAGE=/, "must pass BASE_IMAGE (the digest-pinned base)");
  assert.match(text, /--build-arg\s+OPENRIG_TARBALL=/, "must pass OPENRIG_TARBALL (the local pack)");
});

test("Q2 fix A: packs the ASSEMBLED @openrig/cli (has the `rig` bin), NEVER the private monorepo root", () => {
  const text = readScript();
  // 必须先组装可发布的 CLI（打包 daemon/ui/tui + bin）……
  assert.match(text, /build-package\.sh/, "must run scripts/build-package.sh to assemble @openrig/cli");
  // ……且打包的是 packages/cli，不是仓库根（根 = openrig@0.5.0，没有 bin -> rig --version 退出 127）
  assert.match(text, /packages\/cli["'}\s]*&&\s*npm pack|cd\s+"?\$\{REPO_ROOT\}\/packages\/cli/, "npm pack must run with cwd packages/cli");
  assert.doesNotMatch(text, /cd\s+"?\$\{REPO_ROOT\}"?\s*&&\s*npm pack/, "must NOT pack the monorepo root");
});

test("Q2 fix B: resolves the target arch HOST-side + passes it explicitly, fail-CLOSED (never a silent amd64 default -> exit 133)", () => {
  const text = readScript();
  assert.match(text, /uname -m/, "must resolve the host arch (uname -m) so the legacy builder gets a real TARGETARCH");
  assert.match(text, /--build-arg\s+TARGETARCH=/, "must pass TARGETARCH explicitly (builder-agnostic)");
  assert.match(text, /uname -m[\s\S]*?exit\s+[1-9]/, "must fail-closed (non-zero exit) on an unresolvable arch");
});

test("Q2 fix B: the Dockerfile fails CLOSED on an empty TARGETARCH (no silent amd64 default)", () => {
  const dockerfile = readFileSync(join(HERE, "..", "docker", "testbed", "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /TARGETARCH:-amd64/, "must NOT default TARGETARCH to amd64 (that installs wrong-arch Node)");
  assert.match(dockerfile, /"".*exit\s+[1-9]/, "an empty TARGETARCH must exit non-zero (fail closed)");
});

test("NEVER pushes the image (the never-push fence)", () => {
  const text = readScript();
  assert.doesNotMatch(text, /docker\s+push/, "must NOT docker push");
});

test("consumes the committed base-image slot + the stub-assets list (census scope)", () => {
  const text = readScript();
  assert.match(text, /base-image/, "must read the docker/testbed/base-image pin slot");
  assert.match(text, /stub-assets\.list/, "must read the explicit stub-assets census list");
});

test("emits the manifest via the tested node orchestrator", () => {
  const text = readScript();
  assert.match(text, /testbed-emit-manifest\.mjs/, "must emit the manifest via testbed-emit-manifest.mjs");
});

test("Q2 fix (break #4): the image installs the better-sqlite3 native-build toolchain (builds fresh on target)", () => {
  // 已封印的 Q2 打包裁决要求在目标机上从源码构建 better-sqlite3（绝不用预编译/嵌套二进制）。
  // 它的安装是 `prebuild-install || node-gyp rebuild`；node-gyp 需要 python3+make+g++。
  // 缺了它们，第 3 层的 `npm install -g` 会挂（'prebuild-install: not found' → 没有 Python）。
  // 这条静态栅栏是“VM 可编写”的那一半；行为上的 RED→GREEN docker 构建在宿主机侧跑。
  const df = readDockerfile();
  assert.match(df, /python3 make g\+\+/, "layer 1 must install python3 make g++ (node-gyp toolchain)");
});

test("Q2 rider (effect proof): the build verb LOADS the daemon inside the container, not just `rig --version`", () => {
  // 断言“效果”而非“命令”：一个在破损原生安装上却变绿的构建，正是 break-#4 那一类。
  // 只有容器内加载才能抓住它（宿主机有工具链，镜像则不该需要）。构建命令必须跑刚构建好的镜像、
  // 并启动 daemon（打开 DB → better-sqlite3 必须已绑定），做不到就让构建失败。
  // 单跑 `rig --version` 永远不会打开 DB。
  const text = readScript();
  assert.match(text, /docker run\b[\s\S]*\$\{IMAGE_TAG\}/, "must run the freshly-built image (effect proof)");
  assert.match(text, /rig daemon start --no-kernel/, "must LOAD the daemon (better-sqlite3 binds) via the operator-corrected start, not merely check rig exists");
  assert.match(text, /\/healthz/, "must confirm readiness deterministically via /healthz (operator correction — no fixed sleep)");
});
