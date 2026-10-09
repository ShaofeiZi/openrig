#!/usr/bin/env node
// zrig 入口兼容测试（entry 分区新增，仅本分区所有）。
//
// 目的：在不启动后台服务、不连接实时 daemon 的前提下，只读地校验
//   1) 仓库根的 ./zrig 可执行包装器能跑通 --version / --help；
//   2) npm 发布面的 bin 同时提供 zrig / rig / openrig，且都指向同一包装器；
//   3) 已构建的 CLI 包装器在隔离 HOME 下 --version / --help 正常退出。
//
// 安全边界：只调用带 --version / --help 参数的只读子命令（这些参数会被 front-door
// 识别为普通参数并直接走 Commander，绝不打开 TUI、绝不连 daemon）。HOME 与
// OPENRIG_HOME 一律指向临时目录，并清理连接相关环境变量。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliPkgPath = path.join(repoRoot, "packages/cli/package.json");
const lockPath = path.join(repoRoot, "package-lock.json");
const rootWrapper = path.join(repoRoot, "zrig");
const builtWrapper = path.join(repoRoot, "packages/cli/dist/bin-wrapper.js");

// 构造一个与真实用户环境隔离的 HOME，并清掉所有指向实时 daemon 的连接变量。
function isolatedEnv() {
  const home = mkdtempSync(path.join(tmpdir(), "zrig-entry-home-"));
  const env = { ...process.env, HOME: home, OPENRIG_HOME: path.join(home, ".openrig") };
  for (const k of ["OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_HOST", "RIGGED_URL", "RIGGED_PORT", "RIGGED_HOME"]) {
    delete env[k];
  }
  return env;
}

// 以“管道”方式运行（stdin/stdout 非 TTY），保证 front-door 不会误判为终端而打开 TUI。
function run(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("仓库根 ./zrig 包装器存在且可执行", () => {
  assert.ok(existsSync(rootWrapper), "缺少根 zrig 包装器");
  assert.ok(statSync(rootWrapper).mode & 0o111, "zrig 包装器缺少可执行权限");
});

test("npm bin 同时提供 zrig / rig / openrig，均指向同一包装器", () => {
  const pkg = JSON.parse(readFileSync(cliPkgPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  assert.equal(pkg.bin.rig, "dist/bin-wrapper.js");
  assert.equal(pkg.bin.zrig, "dist/bin-wrapper.js");
  assert.equal(pkg.bin.openrig, "dist/bin-wrapper.js");
  assert.deepEqual(lock.packages["packages/cli"].bin, pkg.bin);
  // openrig-tui 是历史 TUI 入口，必须保留，不被本次改动影响。
  assert.ok(pkg.bin["openrig-tui"], "历史 openrig-tui 入口应保留");
});

test("./zrig --version 退出 0 且输出语义化版本", () => {
  const env = isolatedEnv();
  const r = spawnSync(rootWrapper, ["--version"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("./zrig --help 退出 0，使用中文标题并以 zrig 为品牌名", () => {
  const env = isolatedEnv();
  const r = spawnSync(rootWrapper, ["--help"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /用法[：:]/);
  assert.match(r.stdout, /zrig/);
});

test("已构建包装器 --version / --help 在隔离 HOME 下均退出 0", () => {
  const env = isolatedEnv();
  const v = run([builtWrapper, "--version"], env);
  assert.equal(v.status, 0, `--version stderr=${v.stderr}`);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+/);

  const h = run([builtWrapper, "--help"], env);
  assert.equal(h.status, 0, `--help stderr=${h.stderr}`);
  assert.match(h.stdout, /用法[：:]/);
});
