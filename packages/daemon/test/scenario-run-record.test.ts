import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunRecord,
  readRunRecords,
  type RunRecord,
} from "./helpers/scenario-run-record.js";

// 切片 51-02——仅追加的 run-record ledger（results-ledger 结构）：每个场景一行，
// 使多次运行可随时间比较（证明项 3 将一次 FAIL 与追加的 run-record 行配对）。
// 仅追加：绝不重写先前行。
describe("场景 run-record ledger", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const ledger = () => {
    const d = mkdtempSync(join(tmpdir(), "runrec-"));
    dirs.push(d);
    return join(d, "runs.jsonl");
  };

  const rec = (scenario: string, verdict: "PASS" | "FAIL", extra: Partial<RunRecord> = {}): RunRecord => ({
    scenario,
    verdict,
    at: "2026-08-05T00:00:00Z",
    ...extra,
  });

  it("追加一行并将其读回", () => {
    const p = ledger();
    appendRunRecord(p, rec("clean-lifecycle", "PASS"));
    const rows = readRunRecords(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].scenario).toBe("clean-lifecycle");
    expect(rows[0].verdict).toBe("PASS");
  });

  it("仅追加：多行按顺序保留，先前字节不变", () => {
    const p = ledger();
    appendRunRecord(p, rec("a", "PASS"));
    const afterFirst = readFileSync(p, "utf8");
    appendRunRecord(p, rec("b", "FAIL", { failedStep: 2, diff: "预期 X，观察到 Y" }));
    const afterSecond = readFileSync(p, "utf8");
    // 第二次写入仅追加（第一行字节是文件前缀）
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    const rows = readRunRecords(p);
    expect(rows.map((r) => r.scenario)).toEqual(["a", "b"]);
    expect(rows[1].verdict).toBe("FAIL");
    expect(rows[1].failedStep).toBe(2);
    expect(rows[1].diff).toContain("观察到");
  });

  it("每一行都是独立有效的 JSON（JSONL）", () => {
    const p = ledger();
    appendRunRecord(p, rec("a", "PASS"));
    appendRunRecord(p, rec("b", "FAIL"));
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("读取缺失的 ledger 时返回空列表（不抛错）", () => {
    const p = ledger();
    expect(existsSync(p)).toBe(false);
    expect(readRunRecords(p)).toEqual([]);
  });
});
