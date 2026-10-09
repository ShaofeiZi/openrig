import { describe, it, expect } from "vitest";
import { classifyNodeVersion } from "../src/node-support.js";
import { checkAbi } from "../scripts/check-abi.mjs";

// 安装器（check-abi.mjs）与诊断（doctor、preflight）必须
// 声明同一 Node 支持策略。遍历 20 到 26 每个主版本。
const MATRIX: Array<[string, "supported" | "too_old" | "odd" | "untested"]> = [
  ["v20.20.2", "too_old"],
  ["v22.22.1", "supported"],
  ["v23.11.1", "odd"],
  ["v24.21.0", "supported"],
  ["v25.8.0", "odd"],
  ["v26.1.0", "untested"],
];

describe("classifyNodeVersion", () => {
  it.each(MATRIX)("%s → %s", (version, kind) => {
    const out = classifyNodeVersion(version);
    expect(out.kind).toBe(kind);
    if (kind === "supported") expect(out.message).toBeUndefined();
    else expect(out.message).toContain(kind === "untested" ? "尚未在 zrig 上测试" : "不受支持");
  });

  it("names 22 and 24 in every refusal fix", () => {
    for (const v of ["v20.20.2", "v23.11.1", "v25.8.0"]) {
      expect(classifyNodeVersion(v).fix).toContain("Node 22 或 24");
    }
  });
});

describe("installer and diagnostics agree", () => {
  it.each(MATRIX)("%s: checkAbi outcome matches %s", (version, kind) => {
    const abi = checkAbi({
      nodeVersion: version,
      loadNativeAddon: () => {},
      openNativeDatabase: () => ({ ok: true }),
    });
    if (kind === "supported") expect(abi).toEqual({ ok: true });
    if (kind === "untested") expect(abi.ok && "warning" in abi && Boolean(abi.warning)).toBe(true);
    if (kind === "too_old" || kind === "odd") expect(abi.ok).toBe(false);
  });
});
