import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_RUNG_RANK } from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A9——显式拒绝，钉住以便下一代不得昂贵地
// 重新推导（mini-req 9）：transcript 静默绝不成为
// activity oracle；pane 抓取仅留在 fallback 档。

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const domainDir = join(repoRoot, "packages", "daemon", "src", "domain");

describe("S19 A9 —— 已否决的判定源保持禁用", () => {
  it("层级集合保持闭合，且不包含任何 transcript 形态的层级", () => {
    expect(EVIDENCE_RUNG_RANK).toEqual(["self-report", "lifecycle-hooks", "window-sampling"]);
    for (const rung of EVIDENCE_RUNG_RANK) expect(rung).not.toMatch(/transcript/i);
  });

  it("活动领域来源不会把 transcript 派生证据送入层级（grep 范围：packages/daemon/src/domain）", () => {
    // 范围：domain 层，即本 slice 加入的 oracle 与每个 evidence producer 所在处。
    // 命中 = 同一文件内出现 `reportEvidence`/rung 引用
    // transcript vocabulary — reviewed by hand if this ever fires.
    const offenders: string[] = [];
    for (const file of readdirSync(domainDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const src = readFileSync(join(domainDir, file), "utf8");
      if (!src.includes("reportEvidence(")) continue;
      if (/transcript/i.test(src) && !/never a rung|REJECTED|reject/i.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("采样下限是唯一的 pane 派生层级，且排在最后（pane 读取绝不优先）", () => {
    expect(EVIDENCE_RUNG_RANK[EVIDENCE_RUNG_RANK.length - 1]).toBe("window-sampling");
  });

  it("参考文档同时包含带日期的否决回执和获准的 refocus-cadence 消费者", () => {
    const doc = readFileSync(join(repoRoot, "docs", "reference", "agent-state-taxonomy.md"), "utf8");
    expect(doc).toMatch(/transcript[- ]quiescence.*REJECTED/is);
    expect(doc).toMatch(/pane[- ]scraping.*REJECTED/is);
    expect(doc).toMatch(/refocus/i);
  });
});
