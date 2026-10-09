// B12-S（已裁定的安全修复）——独立场景 runner（scripts/run-scenarios.mjs）会在运行任何场景前
// 拒绝未知标志。
//
// 它防范的风险（run-scenarios.mjs 第 34–37 行，修复前）：argv 直接映射到 resolve(a)，
// 因而以短横线开头的参数会变成无效路径，在运行循环内部抛错并计为一个失败“场景”，同时其余
// 文件仍以主机模式运行。于是 `run-scenarios.mjs --container x.yaml` 会打印一条 [ERROR] 和
// 部分成功摘要，让读者误以为容器模式已经运行。拒绝必须发生在执行前：非零退出、指出准确标志、
// 运行零个场景。
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, "../scripts/run-scenarios.mjs");
// 真实场景 YAML（入口测试形态）：证明标志后的文件绝不会运行。
const REAL_SCENARIO = "test/fixtures/scenarios/scenario-01-per-seat-scripts.yaml";

function runWith(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", RUNNER, ...args], {
    encoding: "utf-8",
    env: { ...process.env },
  });
}

// 场景台账行或部分摘要——表示已有内容实际运行。
const RAN_SOMETHING = /\[(PASS|FAIL|ERROR|错误)\]|scenarios passed|个场景通过/;

describe("run-scenarios standalone runner — unknown-flag refusal (B12-S)", () => {
  it("refuses '--container <yaml>' pre-execution: nonzero exit, names --container, ZERO scenarios run", () => {
    const r = runWith(["--container", REAL_SCENARIO]);
    expect(r.status).toBe(2); // 非零，且不同于表示场景失败的退出码 1。
    expect(r.stderr).toContain("[已拒绝]");
    expect(r.stderr).toContain("--container");
    // 未执行任何内容：无场景台账行、无部分摘要，stdout 为空。
    expect(r.stdout).not.toMatch(RAN_SOMETHING);
    expect(r.stdout.trim()).toBe("");
  });

  it("names the EXACT offending flag (a bare '-x') and still runs nothing", () => {
    const r = runWith(["-x"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("'-x'");
    expect(r.stdout).not.toMatch(RAN_SOMETHING);
  });
});
