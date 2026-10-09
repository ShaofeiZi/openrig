// release-0.3.2 slice 01（OPR.0.3.2.1）——覆盖 zrig workflow 命令界面的 GA 润色。
//
// 范围：静态 --help + 描述覆盖；what/state/next 摘要行为通过
// printOutcomeSummary 单元测试在构建块层验证（专为此目的导出），因为
// 实时操作路径受 getDaemonStatus 门禁约束，并已在其他位置的集成层测试。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  workflowCommand,
  printOutcomeSummary,
  type OutcomeSummary,
} from "../src/commands/workflow.js";

describe("zrig workflow --help 为每条命令提供示例（HG-4）", () => {
  const expectedVerbs = [
    "validate",
    "instantiate",
    "project",
    "list",
    "specs",
    "show",
    "trace",
    "continue",
  ];

  // Commander v13 将 `addHelpText('after', ...)` 作为 listener 附加，
  // 在渲染 --help 时触发；`helpInformation()` 返回 Usage+Options+Subcommands，
  // 但不包含 after-text。扫描命令源码以证明每个动词都包含示例块——
  // 如果未来重构只从某个动词移除 `addHelpText`，此测试可捕获漂移。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workflowSrc = readFileSync(
    path.resolve(here, "../src/commands/workflow.ts"),
    "utf8",
  );

  for (const verb of expectedVerbs) {
    it(`${verb} 包含带示例章节的 addHelpText('after', ...) 块`, () => {
      const root = workflowCommand();
      const sub = root.commands.find((c) => c.name() === verb);
      expect(sub, `应注册动词 ${verb}`).toBeTruthy();
      // 扫描源码：定位 command(...) 声明，并检查其后的 addHelpText 是否包含示例块。
      const verbBlockRe = new RegExp(
        `\\.command\\("${verb}[ "(<]([\\s\\S]*?)\\.action\\(`,
        "m",
      );
      const match = verbBlockRe.exec(workflowSrc);
      expect(match, `无法定位 "${verb}" 的构建器`).toBeTruthy();
      const block = match![0];
      expect(block).toMatch(/\.addHelpText\("after",/);
      expect(block).toMatch(/示例：?/i);
      expect(block).toMatch(/\$ zrig workflow /); // 至少包含一个具体调用示例
    });
  }

  it("每个动词都有非空描述", () => {
    const root = workflowCommand();
    for (const sub of root.commands) {
      expect(
        sub.description().length,
        `动词 ${sub.name()} 需要描述`,
      ).toBeGreaterThan(0);
    }
  });

  it("顶层命令本身已有文档说明", () => {
    const root = workflowCommand();
    expect(root.description().length).toBeGreaterThan(0);
  });
});

describe("printOutcomeSummary——what/state/next 收尾（HG-4）", () => {
  function captureStdout(): { logs: string[]; restore: () => void } {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    return { logs, restore: () => { console.log = original; } };
  }

  const baseSummary: OutcomeSummary = {
    what: "Closed QITEM-123 (handoff) and projected QITEM-456 to velocity-qa@openrig-velocity",
    state: "instance WF01ABC = active",
    next: "Inspect: rig queue show QITEM-456",
  };

  it("成功时在人类模式输出 4 行（空行 + what + state + next）", () => {
    const out = captureStdout();
    printOutcomeSummary(false, 200, baseSummary);
    out.restore();
    const joined = out.logs.join("\n");
    expect(joined).toMatch(/做了什么：\s*Closed QITEM-123/);
    expect(joined).toMatch(/state.*instance.*WF01ABC|状态.*WF01ABC/);
    expect(joined).toMatch(/next.*Inspect.*rig queue show QITEM-456|下一步.*Inspect/);
    // 摘要前有一个空白分隔行。
    expect(out.logs[0]).toBe("");
  });

  it("--json 模式抑制输出（保持机器消费者输入干净）", () => {
    const out = captureStdout();
    printOutcomeSummary(true, 200, baseSummary);
    out.restore();
    expect(out.logs.length).toBe(0);
  });

  it("status >= 400 时抑制输出（错误路径使用自己的界面）", () => {
    const out = captureStdout();
    printOutcomeSummary(false, 500, baseSummary);
    out.restore();
    expect(out.logs.length).toBe(0);
  });

  it("summary 为 null 时抑制输出", () => {
    const out = captureStdout();
    printOutcomeSummary(false, 200, null);
    out.restore();
    expect(out.logs.length).toBe(0);
  });
});
