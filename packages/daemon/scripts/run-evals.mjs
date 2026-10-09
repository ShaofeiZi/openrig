#!/usr/bin/env -S node --import tsx
/*
 * slice-07 R6——评测运行器 CLI（与 run-scenarios.mjs 同级；这是评测闸门，不是确定性闸门）。
 * 加载人工编写的用例，经 provider 运行，在确定性的 DOOR 处为每份捕获转录评分，写入评分记录，
 * 任何 fail/error 都以非零状态退出。
 *
 *   运行方式（TS 辅助代码需要 tsx loader，因此请使用会提供它的包命令）：
 *     npm run eval -w packages/daemon -- [--provider fake|rig] [--transcripts <json>] [--out <json>]
 *   或直接运行：node --import tsx packages/daemon/scripts/run-evals.mjs [args]
 *   （文件以可执行形式发布；支持 `env -S` 的环境可使用 ./run-evals.mjs。）
 *
 * --provider fake（默认）：确定性 provider，转录来自 --transcripts（prompt -> transcript 的
 *   JSON 映射）；缺少 prompt 时记为 ERROR，绝不静默通过。这是可在 CI 中运行的路径。
 * --provider rig：真实席位 provider（证明契约闸门）。必须二选一：
 *     --seat <session>      连接现有真实席位（绝不销毁），或
 *     --seat-spec <rig.yaml> 通过 `rig up` 启动临时 rig 并驱动其唯一席位
 *                            （结束时通过 `rig down` 销毁）。
 *   所有用例共用一个持久席位/代；边界是席位的只追加转录（带外读取，不发送 marker——round-5
 *   保管规则）；provider 会把开头的输入回显排除在评分之外。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCasesFromDir } from "../test/helpers/eval-cases.ts";
import { runEvals } from "../test/helpers/eval-runner.ts";
import { FakeProvider } from "../test/helpers/eval-provider.ts";
import { RigSeatProvider } from "../test/helpers/eval-rig-provider.ts";
import { recordedGrade } from "../test/helpers/eval-report.ts";
import { buildProductionPackage, resolveCaseRefs, unresolvedCases } from "../test/helpers/eval-ref-resolution.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");
// 修复（复审 HIGH-1）：评测运行会针对以隔离方式构建到临时目录中的精确生产包解析 ref，
// 绝不使用被 gitignore 的 context-packs 残留；而且对每个 provider（不只是 rig）都在自身
// 预检中验证。进程退出时删除临时包（故障安全清理由 buildProductionPackage 内部注册）。
const PRODUCTION_PACKAGE = buildProductionPackage(REPO).dir;

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const providerName = opt("--provider", "fake");
const outPath = opt("--out", null);

const { cases, errors } = loadEvalCasesFromDir(CASES_DIR);
if (errors.length > 0) {
  console.error("[REFUSED] 评测用例无效：", JSON.stringify(errors));
  process.exit(2);
}

// 预检（与守卫测试共用同一验证器）：每个用例都必须给出能在已构建生产包中解析的 canonical
// ref，否则拒绝整次运行。这样，生产解析属于运行本身，而不是旁路测试。
const unresolved = unresolvedCases(resolveCaseRefs(cases, PRODUCTION_PACKAGE));
if (unresolved.length > 0) {
  console.error(
    "[REFUSED] 评测 ref 无法在生产包中解析：" +
      unresolved.map((u) => `${u.caseId}:${u.ref ?? "<none>"}`).join(", "),
  );
  process.exit(2);
}

let provider;
if (providerName === "rig") {
  const seat = opt("--seat", null);
  const spec = opt("--seat-spec", null);
  if ((seat === null) === (spec === null)) {
    console.error(
      "[REFUSED] --provider rig 驱动一个持久真实席位，必须且只能选择以下一项：\n" +
        "  --seat <session>       连接现有真实席位（绝不销毁）\n" +
        "  --seat-spec <rig.yaml> 通过 `rig up` 启动临时 rig 并驱动其席位",
    );
    process.exit(2);
  }
  const { buildRigProviderSession } = await import("../test/helpers/eval-rig-runner.ts");
  provider = new RigSeatProvider({
    productionPackage: PRODUCTION_PACKAGE,
    // Round-6 方案 B（r2 round-6 HIGH-1）：带外边界通过权威默认读取器绑定到席位当前代的
    // 只追加 Claude 会话记录；绑定实现在此发布入口中，而不只存在于测试。Codex/未预热席位或
    // 已滚动的代都会明确拒绝，绝不静默降级，也绝不使用有界覆盖窗格。
    session: buildRigProviderSession({ seat, spec }),
  });
} else {
  const tPath = opt("--transcripts", null);
  const transcripts = tPath ? JSON.parse(readFileSync(tPath, "utf-8")) : {};
  provider = new FakeProvider(transcripts);
}

let summary;
try {
  summary = await runEvals(cases, provider);
} finally {
  // 只退役一次持久席位（幂等；fake/attach 模式为空操作）。销毁失败不得破坏运行结果——评分才是
  // 产物；残留 rig 通过明确告警提示操作员手动执行 `rig down`。
  if (typeof provider.dispose === "function") {
    try {
      await provider.dispose();
    } catch (e) {
      console.error(`[WARN] 席位退役失败——请手动执行 'rig down' 销毁临时 rig：${e.message}`);
    }
  }
}
const recorded = {
  provider: provider.name,
  total: summary.total,
  passed: summary.passed,
  failed: summary.failed,
  errored: summary.errored,
  byCategory: summary.byCategory,
  // 每条评分记录都携带自身证据（patternResults + 顺序 + FAIL 原因），因此产物能够解释判定；
  // CE-08 必须区分“未拉取”“拉取过晚”和“拉取错误”。
  grades: summary.outcomes.map(recordedGrade),
};
if (outPath) writeFileSync(outPath, JSON.stringify(recorded, null, 2));

console.log(`评测[${provider.name}] ${summary.passed}/${summary.total} 通过，${summary.failed} 失败，${summary.errored} 错误`);
for (const g of recorded.grades) {
  const tag = g.pass ? "PASS" : g.error ? "ERROR" : "FAIL";
  const detail = g.error ? ` — ${g.error}` : !g.pass && g.reason ? ` — ${g.reason}` : "";
  console.log(`  ${tag} ${g.id}${detail}`);
}
process.exit(summary.failed > 0 || summary.errored > 0 ? 1 : 0);
