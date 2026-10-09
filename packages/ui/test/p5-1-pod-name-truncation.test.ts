// V1 polish slice Phase 5.1 P5.1-3——pod 名截断回归守卫。
//
// Pod 名曾渲染为 "covery" / "anning" 等。根因：
// displayPodName 调用 shortId(podId, 6)，后者返回任意输入的
// 末 6 字符——为 26 字符 ULID 设计，但对
// 人类可读 pod namespace 错误。修复原样返回 podId。此
// 测试永久守卫症状及底层契约。

import { describe, it, expect } from "vitest";
import { displayPodName, inferPodName, displayAgentName } from "../src/lib/display-name.js";

describe("displayPodName P5.1-3 regression: human-readable pod names pass through verbatim", () => {
  it("'discovery' stays 'discovery' (NOT 'covery')", () => {
    expect(displayPodName("discovery")).toBe("discovery");
  });

  it("'planning' stays 'planning' (NOT 'anning')", () => {
    expect(displayPodName("planning")).toBe("planning");
  });

  it("'kernel' stays 'kernel'", () => {
    expect(displayPodName("kernel")).toBe("kernel");
  });

  it("'orch' stays 'orch'", () => {
    expect(displayPodName("orch")).toBe("orch");
  });

  it("'product-lab' stays 'product-lab'", () => {
    expect(displayPodName("product-lab")).toBe("product-lab");
  });

  it("'release-readiness-v2' stays full (NOT '-v2')", () => {
    expect(displayPodName("release-readiness-v2")).toBe(
      "release-readiness-v2",
    );
  });

  it("null / empty returns 'ungrouped' fallback", () => {
    expect(displayPodName(null)).toBe("未分组");
    expect(displayPodName(undefined)).toBe("未分组");
    expect(displayPodName("")).toBe("未分组");
  });

  it("source-assertion: displayPodName does NOT call shortId for pod names (ritual #9)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "../src/lib/display-name.ts"),
      "utf8",
    );
    // 剥离注释以忽略历史提及。
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    // 定位 displayPodName 函数体。
    const fnMatch = codeOnly.match(/export function displayPodName[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];
    expect(body).not.toMatch(/shortId\s*\(/);
  });
});

describe("inferPodName + displayAgentName preserved (P5.1-3 cleanup didn't regress neighbors)", () => {
  it("inferPodName splits 'discovery.intake-router' → 'discovery'", () => {
    expect(inferPodName("discovery.intake-router")).toBe("discovery");
  });

  it("displayAgentName splits 'discovery.intake-router' → 'intake-router'", () => {
    expect(displayAgentName("discovery.intake-router")).toBe("intake-router");
  });

  it("inferPodName returns the whole id when no dot", () => {
    expect(inferPodName("solo-agent")).toBe("solo-agent");
  });

  it("inferPodName returns null for null/undefined", () => {
    expect(inferPodName(null)).toBe(null);
    expect(inferPodName(undefined)).toBe(null);
  });
});
