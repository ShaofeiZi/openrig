// REGISTRY I5——context 组合与 C3 detector 状态：detector 翻转在每个表面
// 一致地改变可用性（一规则，三投影）。
import { describe, it, expect } from "vitest";
import { COMMAND_REGISTRY, serializeCommands, evaluateAvailability, currentCommandContext } from "../src/commands/registry.js";
import { filterPalette } from "../src/commands/palette.js";

describe("detector-state → command 上下文 (I5)", () => {
  it("映射 C3 状态：up/absent=standard，down=crash-cart，unverified=unverified", () => {
    expect(currentCommandContext(null)).toBe("standard");
    expect(currentCommandContext("up")).toBe("standard");
    expect(currentCommandContext("down")).toBe("crash-cart");
    expect(currentCommandContext("unverified")).toBe("unverified");
  });

  it("daemon-down：standard 命令在 palette 与 socket 上一致地变为带原因不可用；help 保持可用", () => {
    const ctx = currentCommandContext("down");
    const socketRows = serializeCommands(ctx);
    const paletteRows = filterPalette("", COMMAND_REGISTRY, ctx);
    for (const e of COMMAND_REGISTRY) {
      const s = socketRows.find((r) => r.name === e.name)!;
      const p = paletteRows.find((r) => r.entry.name === e.name)!;
      expect(p.available).toBe(s.available); // IDENTICAL across surfaces
      expect(p.reason).toBe(s.reason);
      expect(evaluateAvailability(e, ctx).available).toBe(s.available); // one rule
    }
    expect(socketRows.find((r) => r.name === "help")!.available).toBe(true);
    expect(socketRows.find((r) => r.name === "graph")!.available).toBe(false);
    expect(socketRows.find((r) => r.name === "graph")!.reason).toMatch(/standard/);
  });
});
