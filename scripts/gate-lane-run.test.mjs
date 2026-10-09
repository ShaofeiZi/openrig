import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRefusal, runLegs, buildVerdict, runGate, observeForeignLoad, cleanStaleVendoredBundle } from "./gate-lane-run.mjs";

// F1 gate-lane runner 逻辑（arch d6a6c1db，5 条约束）。腿：typecheck 与 vitest（repo + 受支持工作区）。
// web-UI 这条腿被裁决排除（创始人，2026-08-21）——见下面的“缺席”测试。
// P5：拒绝时告知端口常量，点名闸门持锁者或诚实标注未知，始终硬拒绝。

test("P5 refusal — gate holder is NAMED (pid/started-at) + teaches the port constant, always refuses", () => {
  const t = renderRefusal({ reason: "gate-holder", holder: { pid: 4242, startedAt: "2026-08-07T09:00:00Z" } }, 40404);
  assert.match(t, /40404/);            // teaches the port constant
  assert.match(t, /4242/);             // names the holder pid
  assert.match(t, /2026-08-07T09:00:00Z/); // + started-at
  assert.match(t, /拒绝执行/);         // hard-refuse
});

test("P5 refusal — foreign squatter is HONEST-UNKNOWN + still teaches the port constant + refuses", () => {
  const t = renderRefusal({ reason: "foreign-holder" }, 40404);
  assert.match(t, /40404/);
  assert.match(t, /外来进程.*未知/);    // honest-unknown, not a fabricated holder
  assert.doesNotMatch(t, /pid \d/i);   // no fabricated pid
  assert.match(t, /拒绝执行/);
});

test("runLegs runs the two supported legs — and the web-UI leg is ruled OUT, never present", async () => {
  const ran = [];
  const exec = async (cmd) => { ran.push(cmd); return { ok: true, code: 0 }; };
  const legs = await runLegs(exec);
  const names = legs.map((l) => l.name);
  assert.ok(names.includes("typecheck"), "typecheck leg");
  assert.ok(names.includes("vitest"), "vitest leg (repo + supported workspaces)");
  // 创始人裁决 2026-08-21：自 0.5.0 TUI 转向以来，web UI 是尽力而为的实验性项目——
  // 闸门不得运行或阻塞 packages/ui。此缺席是有意的；不要重新添加。
  assert.ok(!names.includes("vitest:ui"), "no web-UI leg — ruled out, not forgotten");
  assert.ok(ran.every((c) => !/test:ui/.test(c)), "gate never invokes test:ui");
  assert.ok(legs.every((l) => l.ok));
});

test("green = typecheck AND vitest BOTH — one failed leg fails the gate", async () => {
  const exec = async (cmd) => ({ ok: !/lint/.test(cmd), code: /lint/.test(cmd) ? 1 : 0 }); // typecheck fails
  const legs = await runLegs(exec);
  const v = buildVerdict({ legs, foreignLoad: { advisory: [] }, startedAt: "t0", endedAt: "t1" });
  assert.equal(v.gate, "fail");
  assert.equal(v.legs.find((l) => l.name === "typecheck").ok, false);
});

test("advisory foreign-load — counts foreign node/vitest/tsc processes + loadavg (never the gate's own pid)", () => {
  const fl = observeForeignLoad({
    loadavg: [4.1, 3.2, 2.0],
    processes: [
      { pid: process.pid, command: "node scripts/gate-lane.mjs" }, // self — excluded
      { pid: 111, command: "node …/vitest" },
      { pid: 222, command: "tsc --noEmit" },
      { pid: 333, command: "Finder" }, // non-toolchain — not counted
    ],
  });
  assert.equal(fl.foreignProcessCount, 2);
  assert.deepEqual(fl.loadavg, [4.1, 3.2, 2.0]);
  assert.ok(fl.advisory.some((a) => /2 个外来/.test(a)));
  assert.ok(fl.advisory.some((a) => /loadavg/.test(a)));
});

test("C2 verdict — a GREEN carries the foreign-load context it ran under (recorded, not just printed)", () => {
  const v = buildVerdict({
    legs: [{ name: "typecheck", ok: true }, { name: "vitest", ok: true }, { name: "vitest:ui", ok: true }],
    foreignLoad: { advisory: ["3 foreign node processes, loadavg 4.10"] },
    startedAt: "t0", endedAt: "t1",
  });
  assert.equal(v.gate, "pass");
  assert.deepEqual(v.foreignLoad.advisory, ["3 foreign node processes, loadavg 4.10"]);
  assert.equal(v.startedAt, "t0");
});

test("exclusion-ledger — empty seed stays STRICT; an active resident covering a failed leg → PASS + named", () => {
  const legs = [{ name: "typecheck", ok: true }, { name: "vitest", ok: false }, { name: "vitest:ui", ok: true }];
  // 空种子（发布的现实）：失败的 vitest 腿未被覆盖 → 闸门 FAIL（严格）。
  const strict = buildVerdict({ legs, foreignLoad: { advisory: [] }, startedAt: "t0", endedAt: "2025-08-10", ledger: [] });
  assert.equal(strict.gate, "fail");
  assert.equal(strict.ledger.activeExclusions.length, 0);
  assert.match(strict.ledgerState, /0 项排除/);
  // 有一个 ACTIVE 常驻者覆盖失败的腿 → 闸门 PASS，排除在裁决中被命名。
  const excl = [{ suite: "vitest", reason: "known-flaky", receipt: "A/B abc", owner: "dev-driver", expiry: "2025-08-20" }];
  const covered = buildVerdict({ legs, foreignLoad: { advisory: [] }, startedAt: "t0", endedAt: "2025-08-10", ledger: excl, cutCeiling: "2025-09-01" });
  assert.equal(covered.gate, "pass");
  assert.equal(covered.ledger.activeExclusions.length, 1);
  assert.match(covered.ledgerState, /vitest/);
});

// 闸门测的是源码真实性。packages/cli/daemon 处一个过期的桌面残留（早先 `npm run build:package`
// 留下的、被 gitignore 的构建产物）会污染 test:repo 的新鲜度守卫——守卫会正确地标出一个已组装但已过期的包，
// 但闸门不是打包语境。runner 在闸门启动时删掉它，使残留永远不可能污染一次运行；真实打包时的组装仍受守护，
// 而全新 clone（没有包）是 no-op。
test("gate cleans a stale vendored daemon bundle at start so a desk leftover can't poison test:repo", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-vendored-"));
  const bundleDist = join(root, "packages", "cli", "daemon", "dist");
  mkdirSync(bundleDist, { recursive: true });
  writeFileSync(join(bundleDist, "index.js"), "// stale leftover from an old build:package assembly");
  assert.ok(existsSync(bundleDist), "planted stale bundle exists");

  const removed = cleanStaleVendoredBundle(root);
  assert.equal(existsSync(join(root, "packages", "cli", "daemon")), false, "the whole vendored daemon tree is removed");
  assert.match(removed, /packages[\\/]cli[\\/]daemon$/);

  // 幂等：没有包的全新 clone 是干净 no-op（force:true），绝不抛错。
  assert.doesNotThrow(() => cleanStaleVendoredBundle(root));
});

// 自描述裁决（gate-lane.mjs:56 冒烟不可区分性修复）。一次 SMOKE 运行跳过每条腿，
// 却被封成一个普通 PASS——对 JSON 做哈希校验只能证明文件真实，完全证明不了闸门到底跑没跑。
// 裁决现在必须自带它的模式 + 每条腿的证据。
test("SELF-DESCRIBING (pm GATE CONDITION): verdict.smoke tracks WHAT RAN via runGate — the SHIPPED wiring, not a mirror", async () => {
  // 调用 gate-lane.mjs 所调用的同一个 runGate（唯一定线点——不是一个仿冒品，否则生产漂移时它照样能过）。
  // realExec 是个 spy，于是我们不 spawn 真 npm 就能观测“效果”：冒烟运行时 runGate 选跳过分支、
  // realExec 绝不被碰；真跑时 runGate 把每条腿都路由过 realExec。该字段必须与 spy 所见一致——
  // 一个从环境读/硬编码的字段不可能同时满足两个方向、以及两组效果断言。
  const gateWith = async (smoke) => {
    const ran = [];
    const realExec = async (cmd) => { ran.push(cmd); return { ok: true, code: 0 }; };
    const verdict = await runGate({ smoke, realExec, foreignLoad: { advisory: [] }, startedAt: "t0", ledger: [] });
    return { verdict, ran };
  };
  // 负对照 A——SMOKE 运行封 smoke:true 且不跑任何东西（硬编码 smoke:false 会让第一个失败；
  // 与接线解耦的字段会让第二个失败）。
  const smoked = await gateWith(true);
  assert.equal(smoked.verdict.smoke, true, "the smoking run seals smoke:true");
  assert.equal(smoked.ran.length, 0, "smoke:true coincides with ZERO real executions (the effect)");
  // 负对照 B——真实运行封 smoke:false 且把每条腿路由过 realExec（硬编码 smoke:true 失败）。
  // 两个方向 + 两组效果断言合在一起，禁止一个说谎的常量。
  const real = await gateWith(false);
  assert.equal(real.verdict.smoke, false, "the real run seals smoke:false");
  assert.equal(real.ran.length, 2, "smoke:false coincides with both legs routed through realExec (the effect)");
  // 故障安全——buildVerdict 不带 smoke 参数时默认 false，绝不静默 true。
  assert.equal(buildVerdict({ legs: [], foreignLoad: { advisory: [] }, startedAt: "t0", endedAt: "t1" }).smoke, false);
});

test("SELF-DESCRIBING: per-leg durationMs recorded (the mixed-mode discriminator a whole-run total hides)", async () => {
  const exec = async () => ({ ok: true, code: 0 });
  const legs = await runLegs(exec);
  for (const l of legs) {
    assert.equal(typeof l.durationMs, "number", `${l.name} carries a numeric durationMs`);
    assert.ok(l.durationMs >= 0, `${l.name} durationMs is non-negative`);
  }
  // 且 buildVerdict 按每条腿携带它们（不只是整次运行的 startedAt/endedAt）。
  const v = buildVerdict({ legs, foreignLoad: { advisory: [] }, startedAt: "t0", endedAt: "t1" });
  assert.ok(v.legs.every((l) => typeof l.durationMs === "number"), "verdict.legs carry per-leg durationMs");
});
