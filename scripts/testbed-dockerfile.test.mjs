import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 51-04 testbed 镜像——Dockerfile 就是交付物（计划 §1）。`docker build` 在宿主机侧运行
// （locus 裁决：VM seat 没有容器运行时）；本契约测试是“VM 可编写”的证明，证明 Dockerfile 把
// 计划 §1 的栅栏编码成了可执行守卫，使日后某次编辑——让 base tag 浮动、从 npm registry 拉 openrig、
// 或去掉非 root 用户——都在这里破坏构建，而不是默默留在一个没人复审的宿主机侧镜像里。
//
// 它钉的栅栏（计划 §1 + FENCES 行）：base 参数化以便 digest 钉死（绝不把浮动 tag 烤进去）；
// tmux + git 就位（PTY/tmux 底座）；node 钉在 engines 区间内的版本；OpenRig 从 COPY 进来的本地
// tarball 安装，绝不走 npm registry（0.5.1 未发布——从源码树构建）；一个非 root 的 `openrig` 用户；
// 一个 tini/dumb-init 入口。

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const DOCKERFILE = join(REPO_ROOT, "docker", "testbed", "Dockerfile");

const ENGINES_LTS_MAJORS = new Set([20, 22, 24]); // mirrors scripts/check-engines LTS constraint

function readDockerfile() {
  return readFileSync(DOCKERFILE, "utf8");
}

/** Non-comment, non-blank instruction lines. */
function instructions(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

test("Dockerfile exists at docker/testbed/Dockerfile", () => {
  assert.match(readDockerfile(), /\S/);
});

test("base is parameterized via ARG BASE_IMAGE + FROM ${BASE_IMAGE} — no floating tag baked in", () => {
  const text = readDockerfile();
  assert.match(text, /^ARG\s+BASE_IMAGE\b/m, "must declare ARG BASE_IMAGE (digest supplied by the build verb)");
  assert.match(text, /^FROM\s+\$\{BASE_IMAGE\}/m, "FROM must consume ${BASE_IMAGE}, not a hardcoded image");
  // 不得内置具体 floating tag 的 FROM（例如 FROM node:22-slim / debian:bookworm-slim）。
  for (const line of instructions(text)) {
    if (/^FROM\s/i.test(line)) {
      assert.match(line, /\$\{BASE_IMAGE\}/, `FROM must be parameterized, got: ${line}`);
    }
  }
});

test("installs the PTY/tmux substrate: tmux AND git", () => {
  const text = readDockerfile();
  assert.match(text, /\btmux\b/, "must install tmux");
  assert.match(text, /\bgit\b/, "must install git");
});

test("node is pinned via ARG NODE_VERSION to an in-range (even LTS) engines version", () => {
  const text = readDockerfile();
  const m = text.match(/^ARG\s+NODE_VERSION=(\d+)\.(\d+)\.(\d+)\b/m);
  assert.ok(m, "must declare ARG NODE_VERSION=<x.y.z> with a concrete default");
  const major = Number(m[1]);
  assert.ok(ENGINES_LTS_MAJORS.has(major), `NODE_VERSION major ${major} must be in {20,22,24} (engines LTS)`);
});

test("OpenRig is installed from a COPY'd local tarball, NEVER the npm registry", () => {
  const text = readDockerfile();
  // 正面：tarball 有一个 build ARG，它被 COPY 进来，并从该路径安装。
  assert.match(text, /^ARG\s+OPENRIG_TARBALL\b/m, "must declare ARG OPENRIG_TARBALL");
  assert.match(text, /^COPY\s+.*\$\{OPENRIG_TARBALL\}/m, "must COPY the tarball into the image");
  assert.match(text, /npm\s+install[^\n]*\.tgz/, "must install openrig from the local .tgz");
  // 反面栅栏：绝不按裸名从 registry 安装 openrig 包。
  assert.doesNotMatch(
    text,
    /npm\s+(?:install|i|add)\s+(?:-g\s+)?openrig(?:@|\s|$)/m,
    "must NOT install openrig from the npm registry (build from the tree)",
  );
});

test("runs as a non-root `openrig` user (creates it + a trailing USER openrig)", () => {
  const text = readDockerfile();
  assert.match(text, /\bopenrig\b/, "must reference an openrig user");
  assert.match(text, /(useradd|adduser)[^\n]*openrig/, "must create the openrig user");
  const userLines = instructions(text).filter((l) => /^USER\s/i.test(l));
  assert.ok(userLines.length > 0, "must set a USER");
  assert.match(userLines[userLines.length - 1], /^USER\s+openrig\b/i, "the final USER must be openrig (non-root)");
});

test("entrypoint execs under tini/dumb-init (PID1 reaping)", () => {
  const text = readDockerfile();
  const entry = instructions(text).find((l) => /^ENTRYPOINT\s/i.test(l));
  assert.ok(entry, "must declare an ENTRYPOINT");
  assert.match(entry, /tini|dumb-init/, "ENTRYPOINT must exec under tini or dumb-init");
});

test("stages the stub runtime assets into the image (layer 4)", () => {
  const text = readDockerfile();
  assert.match(text, /^COPY\s+.*stub-assets/m, "must COPY the staged stub-assets set");
});
