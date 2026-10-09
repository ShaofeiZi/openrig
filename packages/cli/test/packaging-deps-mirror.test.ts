// OPR.0.4.1.30——静态打包门（static-gate-mirrors-runtime 原则）。
//
// 发布的 @openrig/cli 内置构建好的 daemon：packages/cli `files` 含 `daemon`，
// scripts/build-package.sh 把 packages/daemon/dist 拷到 packages/cli/daemon。
// cli 不依赖 @openrig/daemon，且 cli/src 不 import hono——故内置 daemon 从全局安装的
// node_modules 解析运行时依赖。因此发布的 cli 必须声明 daemon 声明的每个运行时
// 依赖；daemon 需要而 cli 省略的任何东西，在全新 `npm install -g @openrig/cli`
// 上都会缺失（它只在仓内经 monorepo hoisting “能跑”）。
//
// 0.4.0 shipped with @hono/node-ws declared by the daemon (it statically imports createNodeWebSocket
// at packages/daemon/src/server.ts) but NOT by the cli — so a fresh global install could not start
// the daemon (the worst-audience first-run break). This gate makes that whole class un-shippable.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

function runtimeDeps(pkgRelToTest: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, pkgRelToTest), "utf8"));
  return pkg.dependencies ?? {};
}

describe("packaging: cli mirrors the vendored daemon's runtime deps (OPR.0.4.1.30)", () => {
  const daemonDeps = runtimeDeps("../../daemon/package.json");
  const cliDeps = runtimeDeps("../package.json");

  it("declares EVERY runtime dependency the vendored daemon requires", () => {
    // cli vendors the daemon, so cli.dependencies must be a superset of daemon.dependencies.
    const missing = Object.keys(daemonDeps).filter((dep) => !(dep in cliDeps));
    expect(missing).toEqual([]);
  });

  it("declares @hono/node-ws at the daemon's range (the 0.4.0 fresh-install break)", () => {
    // The exact regression: node-ws present in daemon, absent in cli.
    expect(cliDeps["@hono/node-ws"]).toBeDefined();
    expect(cliDeps["@hono/node-ws"]).toBe(daemonDeps["@hono/node-ws"]);
  });

  it("keeps mirrored shared deps at matching ranges (no drift between cli + daemon)", () => {
    // For every dep both declare, the ranges must match so the global install can't resolve a
    // different version than the daemon was built/tested against.
    const drifted = Object.keys(daemonDeps)
      .filter((dep) => dep in cliDeps && cliDeps[dep] !== daemonDeps[dep])
      .map((dep) => `${dep}: cli ${cliDeps[dep]} vs daemon ${daemonDeps[dep]}`);
    expect(drifted).toEqual([]);
  });
});
