// D12 基础健康 + 写入泄漏遏制（broadcast 泄漏原子）。
//
// CLI 测试套件绝不能继承席位的 live-daemon 连接。两个漏洞：
//
// 1. 连接重定向 env（OPENRIG_URL / OPENRIG_PORT / OPENRIG_HOST + RIGGED_*
//    别名）——在生产中作为真实操作者覆盖被采纳，但在席位内是环境变量，
//    它会绕过每个测试注入的 mock daemon（up.test.ts：环境下 29 失败 vs
//    封闭下 1 失败）。在下方清除。生产行为不受影响。
//
// 2. 默认 STATE_FILE 发现——`OPENRIG_HOME/daemon.json`（daemon-lifecycle
//    `OPENRIG_DIR = OPENRIG_HOME`）。仅清除 env 不够：URL/PORT 未设置时，
//    CLI 会回落 live daemon 的状态文件。这正是 `broadcast.test.ts` 向 14 个席位
//    发出真实 'System maintenance' broadcast 的方式。读方向（结果污染）已知；
//    写方向（向 live topology 发出）严格更糟。
//
// FORCE + ASSERT（按缺失不可写——保证存在于无法被跳过之处，使新测试文件
// 从先运行的 setup 继承安全，而非从 runner 或 145/164 文件已省略的按文件约定）：
//   FORCE  ——在任何 daemon 解析模块加载并捕获 eager `OPENRIG_HOME` 常量之前，
//            建立 fixture 作用域的 OPENRIG_HOME（一个带 `.openrig-fixture` 标记的
//            全新临时目录），使默认发现找不到 live daemon。
//   ASSERT ——`assertFixtureScopedHome` 在家非 fixture 作用域时响亮抛错
//            （mkdtemp 失败，或 OPENRIG_HOME 经 import 顺序回归在本 setup 运行前
//            被捕获）。仅 FORCE 是静默修复、什么都不证明；ASSERT 使其成为证据。
//            其已知负例位于 live-daemon-guard.test.ts。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// (1) 清除连接重定向变量（desk 权威集合）。
for (const key of ["OPENRIG_URL", "OPENRIG_PORT", "RIGGED_URL", "RIGGED_PORT", "OPENRIG_HOST_SELECTED", "OPENRIG_HOST", "OPENRIG_BIND_HOST"]) {
  delete process.env[key];
}

// (2) FORCE 一个 fixture 作用域 home——在 import openrig-compat（其
// OPENRIG_HOME 常量是 eager 的）之前。上方 Node 内建不加载它；下方动态
// import 只在此赋值后运行，故常量捕获的是 fixture。
// 每个 worker 一个稳定 fixture home。setupFiles 按测试文件运行，但
// openrig-compat 的 OPENRIG_HOME 常量每个 worker 只捕获一次——按文件新建的
// home 会与该捕获常量分叉（env 说 home N，常量持有 home 1），使任何在套件
// 顺序下读两者之一的测试 flake。故复用本 worker 中已建立的 fixture home。
// 命名为现实的 `.openrig` 风格 home（仍经 marker 为 fixture 作用域），使路径形状
// 断言对其成立。
const existingHome = process.env["OPENRIG_HOME"];
const fixtureHome =
  existingHome && fs.existsSync(path.join(existingHome, ".openrig-fixture"))
    ? existingHome
    : (() => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), ".openrig-cli-fixture-home-"));
        fs.writeFileSync(path.join(h, ".openrig-fixture"), "");
        return h;
      })();
process.env["OPENRIG_HOME"] = fixtureHome;
delete process.env["RIGGED_HOME"];

// (3) ASSERT — capture the resolved home + fail loud if it is not fixture-scoped.
const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
const { assertFixtureScopedHome } = await import("./live-daemon-guard.js");
assertFixtureScopedHome(OPENRIG_HOME);

// (4) P37 REQUEST-LAYER GUARD — the universal outbound-request chokepoint. The two
// guards above close the DISCOVERY paths (connection env, state-file home); this closes
// the REQUEST layer, where a hardcoded :7433 literal, a mocked URL getter with an
// un-mocked client, or a production default constant still issues a real request that
// no env-scrub or fixture-home can catch. Fail-closed on any unregistered target; an
// in-process fixture registers its origin (allowFetchTarget) when it binds.
const { installFetchGuard } = await import("./fetch-guard.js");
installFetchGuard();
