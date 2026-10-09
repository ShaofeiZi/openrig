import { describe, it, expect } from "vitest";
import { buildLedgerExplorer } from "../src/crash-cart/ledger-explorer.js";

// Crash-cart shell 放置重做（ruling 3c6c2be0）——daemon-down 时 explorer 侧栏恒在但
// LEDGER 供给（来自同一份 one-JSON 发现——rigs+seats——绝非第二读路径）且
// 诚实标记为 ledger 来源（founder 诚实要求）。这是窗内分屏左列渲染的
// ledger-explorer 模型。

describe("buildLedgerExplorer——ledger 喂入的 rig 侧栏（诚实标记）", () => {
  it("每个 rig 一行来自 discovery，带 seat 数与诚实 ledger 标记", () => {
    const led = buildLedgerExplorer([
      { name: "openrig-pm", seatCount: 13 },
      { name: "kernel", seatCount: 4 },
    ]);
    expect(led.ledgerSourced).toBe(true);
    expect(led.note.toLowerCase()).toContain("台账"); // honestly marked ledger-sourced
    expect(led.rows.map((r) => r.rigName)).toEqual(["openrig-pm", "kernel"]);
    expect(led.rows[0]).toMatchObject({ rigName: "openrig-pm", seatCount: 13 });
    expect(led.rows[0]!.label).toContain("openrig-pm");
  });

  it("空 discovery → 无行，仍诚实标记（first-run / 无 rig）", () => {
    const led = buildLedgerExplorer([]);
    expect(led.rows).toEqual([]);
    expect(led.ledgerSourced).toBe(true);
    expect(led.note.toLowerCase()).toContain("台账");
  });
});
