#!/usr/bin/env -S node --import tsx
/*
 * Slice 51-02 - the STANDALONE scenario runner entry (config-wrapper-code; NOT a
 * rig-test verb). Runs one or more scenario YAML files against a forced-local,
 * hermetic scenario-local daemon and prints a PASS/FAIL results ledger.
 *
 * Usage (the tsx loader is needed for the TS pipeline import; the shebang wires it
 * when the file is executed directly, otherwise invoke via node --import tsx):
 *   packages/daemon/scripts/run-scenarios.mjs [scenario.yaml ...]
 *   node --import tsx packages/daemon/scripts/run-scenarios.mjs [scenario.yaml ...]
 *
 * With no args it runs the committed evidence scenarios under
 * test/fixtures/scenarios/. Prerequisite: the built rig bin (npm run build -w
 * packages/cli and -w packages/daemon). The up step stands up real tmux seats on a
 * server the hermetic scaffold OWNS (it sets TMUX_TMPDIR itself and refuses to run
 * from inside a tmux attachment), so a run cannot reach the operator/fleet server.
 *
 * The equals mode uses the runner-internal normalizer seam (lock amendment A-N1)
 * with an IDENTITY placeholder here; the DECLARATIVE mapping is the scenario-facing
 * form, its shape rides 51-03, and it lowers to this seam when it lands. So a
 * cross-surface scenario exercises the equals path but is not expected green until
 * 51-03 supplies the real mapping.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenarioFile } from "../test/helpers/scenario-pipeline.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = resolve(HERE, "..");
const RIG_BIN = resolve(DAEMON_ROOT, "..", "cli", "dist", "bin-wrapper.js");
const FIXTURES = join(DAEMON_ROOT, "test", "fixtures", "scenarios");

const argv = process.argv.slice(2);

// B12-S 安全拒绝（已裁定）。此 runner 只接受场景 YAML 路径。加入此守卫前，以短横线开头的
// 参数会被 resolve() 为无效路径，在循环中途抛错并计为一个失败“场景”，同时其余文件仍以
// 主机模式运行；因此 `run-scenarios.mjs --container x.yaml` 会打印一条 [ERROR] 和部分成功摘要，
// 容易让读者误以为容器模式已运行。现在在执行任何内容前拒绝未知标志，使其运行零个场景
//（无 PASS/FAIL 行，也无部分摘要）。不带标志的调用保持逐字节一致。
const flagArg = argv.find((a) => a.startsWith("-"));
if (flagArg) {
  console.error(`[已拒绝] 未知标志 '${flagArg}'——此 runner 只接受场景 YAML 路径；容器模式不是标志（见 slice 15）。`);
  process.exit(2);
}

const files = argv.length > 0
  ? argv.map((a) => resolve(a))
  : readdirSync(FIXTURES).filter((f) => /^scenario-.*\.ya?ml$/.test(f)).sort().map((f) => join(FIXTURES, f));

const baseEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };
const deps = { normalizer: (_surface, value) => value }; // v1 identity placeholder (rides 51-03)

let failures = 0;
for (const file of files) {
  try {
    const result = await runScenarioFile(file, { rigBin: RIG_BIN, baseEnv, deps });
    const tag = result.verdict === "PASS" ? "PASS" : "FAIL";
    let line = `[${tag}] ${result.scenario}`;
    if (result.verdict === "FAIL") line += `\n  step ${result.failedStep}: ${result.diff}`;
    console.log(line);
    if (result.verdict !== "PASS") failures++;
  } catch (err) {
    failures++;
    console.log(`[错误] ${file}\n  ${(err && err.message) || err}`);
  }
}
console.log(`\n${files.length - failures}/${files.length} 个场景通过`);
process.exit(failures > 0 ? 1 : 0);
