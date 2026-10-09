// 密闭性守卫——gate 密闭检查器的 WRITE 方向兄弟。cli TEST 进程默认经 STATE_FILE
// 发现不得触达 LIVE daemon；一次未限定范围的 WRITE（如 `rig broadcast`）会泄漏进
// 活拓扑。当已解析 OpenRig home 非 fixture 范围时，守卫大声失败。
//
// 这是已知负向：一个只能通过的检查不是检查——故我们证明
// 守卫在故意活 home 上触发，在 fixture home 上通过。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertFixtureScopedHome } from "./live-daemon-guard.js";
import { FIXTURE_HOME_MARKER } from "../src/openrig-compat.js";

describe("live-daemon hermeticity guard", () => {
  it("KNOWN-NEGATIVE: THROWS on a live (non-fixture) home — the guard fires", () => {
    const liveHome = fs.mkdtempSync(path.join(os.tmpdir(), "live-home-")); // no fixture marker
    try {
      expect(() => assertFixtureScopedHome(liveHome)).toThrow(/HERMETICITY GUARD|live/i);
    } finally {
      fs.rmSync(liveHome, { recursive: true, force: true });
    }
  });

  it("PASSES on a fixture-scoped home (carries the marker)", () => {
    const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-home-"));
    fs.writeFileSync(path.join(fixtureHome, FIXTURE_HOME_MARKER), "");
    try {
      expect(() => assertFixtureScopedHome(fixtureHome)).not.toThrow();
    } finally {
      fs.rmSync(fixtureHome, { recursive: true, force: true });
    }
  });
});
