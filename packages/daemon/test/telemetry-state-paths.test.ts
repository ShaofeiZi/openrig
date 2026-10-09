import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  contextUsageDirectory,
  legacyContextUsageDirectory,
  legacyProviderUsageDirectory,
  providerUsageDirectory,
  telemetrySidecarFilename,
} from "../src/domain/telemetry-state-paths.js";

describe("OpenRig 所有的 telemetry path", () => {
  it("拥有 state 下的两个 telemetry root", () => {
    expect(contextUsageDirectory("/openrig-home")).toBe("/openrig-home/state/context-usage");
    expect(providerUsageDirectory("/openrig-home")).toBe("/openrig-home/state/provider-usage");
  });

  it("命名 0.5.8 compatibility root，但不改变 canonical ownership", () => {
    expect(legacyContextUsageDirectory("/openrig-home")).toBe("/openrig-home/context");
    expect(legacyProviderUsageDirectory("/openrig-home")).toBe("/openrig-home/provider-usage");
  });

  it("拥有 reader 使用的 sidecar filename 规则", () => {
    expect(telemetrySidecarFilename("dev/impl @ test")).toBe("dev_impl_@_test.json");
  });

  it("保持 projected CJS collector filename 规则一致", () => {
    const collector = fs.readFileSync(
      path.join(import.meta.dirname, "../assets/claude-statusline-context.cjs"),
      "utf8",
    );
    const sessionName = "dev/impl @ test";
    const collectorRule = sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_") + ".json";
    expect(telemetrySidecarFilename(sessionName)).toBe(collectorRule);
    expect(collector).toContain("/[^a-zA-Z0-9@._-]/g");
  });
});
