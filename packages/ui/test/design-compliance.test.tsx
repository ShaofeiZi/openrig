import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const SRC_DIR = resolve(__dirname, "../src");
const COMPONENTS_DIR = resolve(SRC_DIR, "components");

function readAllTsx(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readAllTsx(fullPath));
    } else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
      results.push(readFileSync(fullPath, "utf-8"));
    }
  }
  return results;
}

describe("Design System Compliance", () => {
  // 测试 1：无圆角——除值为 0px 的 rounded-md 外，不允许 rounded-* 类。
  it("no non-zero border-radius in any component", () => {
    const config = readFileSync(resolve(__dirname, "../tailwind.config.ts"), "utf-8");
    const radiusMatch = config.match(/borderRadius:\s*\{([^}]+)\}/);
    expect(radiusMatch).not.toBeNull();

    // 除印章圆形使用的 `full: "9999px"` 外，所有圆角值均为 0px。
    const pairs = [...radiusMatch![1]!.matchAll(/(\w+):\s*"([^"]+)"/g)];
    for (const [, key, value] of pairs) {
      if (key === "full") {
        expect(value).toBe("9999px");
      } else {
        expect(value).toBe("0px");
      }
    }

    // 源文件中不使用内联 borderRadius。
    const allSource = readAllTsx(COMPONENTS_DIR);
    for (const src of allSource) {
      // 允许 borderRadius: 0 或 0px，不允许任何正值。
      const inlineRadius = src.match(/borderRadius:\s*(\d+)/g) ?? [];
      for (const match of inlineRadius) {
        const value = parseInt(match.replace(/borderRadius:\s*/, ""), 10);
        expect(value).toBe(0);
      }
    }
  });

  // 测试 2：所有节点状态颜色符合设计系统映射。
  it("status color mapping matches design-system.md", async () => {
    const { getStatusColorClass } = await import("../src/lib/status-colors.js");

    expect(getStatusColorClass("running")).toBe("bg-success");
    expect(getStatusColorClass("idle")).toBe("bg-foreground-muted");
    expect(getStatusColorClass("exited")).toBe("bg-destructive");
    expect(getStatusColorClass("detached")).toBe("bg-warning");
    expect(getStatusColorClass(null)).toBe("bg-foreground-muted/50");
    expect(getStatusColorClass("unknown")).toBe("bg-foreground-muted/50");
  });

  // 测试 3：数据显示使用等宽字体类。
  it("data display components use font-mono for IDs and values", () => {
    // 检查展示数据的关键组件。
    const rigCard = readFileSync(resolve(SRC_DIR, "components/RigCard.tsx"), "utf-8");
    expect(rigCard).toContain("font-mono");

    const snapshotPanel = readFileSync(resolve(SRC_DIR, "components/SnapshotPanel.tsx"), "utf-8");
    expect(snapshotPanel).toContain("font-mono");

    const rigNode = readFileSync(resolve(SRC_DIR, "components/RigNode.tsx"), "utf-8");
    expect(rigNode).toContain("font-mono");

    // V1 润色 slice 阶段 5.1 P5.1-1：NodeDetailPanel.tsx 已退役；当前规范智能体详情表面为
    // LiveNodeDetails.tsx，并按战术美学同样使用 font-mono。
    const liveNodeDetails = readFileSync(resolve(SRC_DIR, "components/LiveNodeDetails.tsx"), "utf-8");
    expect(liveNodeDetails).toContain("font-mono");

    const importFlow = readFileSync(resolve(SRC_DIR, "components/ImportFlow.tsx"), "utf-8");
    expect(importFlow).toContain("font-mono");
  });
});
