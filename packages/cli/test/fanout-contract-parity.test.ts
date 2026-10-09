import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { LOCAL_HOST_ID, hostsCovered, type AggregatedPayload } from "../src/lib/hosts/fanout-contract.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

// OPR.0.4.4.21 × OPR.0.4.4.15——P4 内共享 fan-out 契约。
// Slice 15 在 daemon 侧定义该模块（首个登陆，0ecd329b）；CLI
// 不能跨包边界 import（刻意无 daemon），故它携带一份逐字节相同副本
// 在此强制——已交付 scope-audit 对账模式。任何有意契约变更须落入两份副本，
// 且按 arch 裁决为跨 PRD 复审（slice 15 + 21）。
describe("fanout-contract CLI/daemon parity (CI-FAILING)", () => {
  it("fanout-contract.ts is byte-equivalent across CLI and daemon", () => {
    const cliContent = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/lib/hosts/fanout-contract.ts"), "utf-8");
    const daemonContent = fs.readFileSync(path.join(REPO_ROOT, "packages/daemon/src/domain/hosts/fanout-contract.ts"), "utf-8");
    expect(cliContent).toBe(daemonContent);
  });

  it("exports the pinned contract members", () => {
    expect(LOCAL_HOST_ID).toBe("local");
    const payload: AggregatedPayload<{ x: number }> = {
      items: [{ x: 1 }],
      hosts: [{ hostId: "h1", status: "ok" }, { hostId: "h2", status: "unsupported-transport", error: "ssh" }],
    };
    expect(hostsCovered(payload, ["h1", "h2"])).toBe(true);
    expect(hostsCovered(payload, ["h1"])).toBe(false); // extra host = violation
    expect(hostsCovered({ items: [], hosts: [] }, ["h1"])).toBe(false); // omission = violation
  });
});
