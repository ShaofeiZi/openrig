// OPR.0.4.4.11 FR-7 — rig --version identity, CLI side.
//
// 已盖章：`<semver> (<shortsha>)` + dirty 标记（脏时）。未盖章 dev
// 运行：semver 单独，完全同今日（负 AC：无假身份）。
// 端到端盖章（build-package.sh 写入生成模块）是
// VM-gate proof.

import { describe, it, expect } from "vitest";
import { formatCliVersion, CLI_VERSION } from "../src/version.js";
import { BUILD_INFO } from "../src/build-info.js";

describe("formatCliVersion", () => {
  it("unstamped dev run prints the semver alone", () => {
    expect(formatCliVersion("0.4.3", { semver: null, commit: null, dirty: null, builtAt: null })).toBe("0.4.3");
  });

  it("stamped build prints <semver> (<shortsha>)", () => {
    expect(
      formatCliVersion("0.4.3", { semver: "0.4.3", commit: "abcdef0123456789", dirty: false, builtAt: "t" }),
    ).toBe("0.4.3 (abcdef01)");
  });

  it("dirty stamp carries the dirty marker", () => {
    expect(
      formatCliVersion("0.4.3", { semver: "0.4.3", commit: "abcdef0123456789", dirty: true, builtAt: "t" }),
    ).toBe("0.4.3 (abcdef01, dirty)");
  });

  it("the source tree's committed stub is the dev stub, so CLI_VERSION here is the bare semver (interim SHA-deploys disambiguate ONLY when stamped)", () => {
    expect(BUILD_INFO.commit).toBeNull();
    expect(CLI_VERSION).not.toContain("(");
  });
});
