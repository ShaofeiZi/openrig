import { describe, it, expect } from "vitest";
import {
  detectAmbientClockHazard,
  assertNoAmbientClock,
  AmbientClockHazardError,
  TEST_CLOCK_ENV_VARS,
  prepareHermeticEnv,
} from "./helpers/hermetic-env.js";

// Slice 51-01 第 6—8 项——A3-R3 注入时钟环境防护与注入接线。
//
// OPENRIG_TEST_CLOCK_NOW 是压缩桥读取的确定性时钟注入变量（缺失即生产环境，回退到
// new Date()）。真实席位中存在此时钟变量会静默冻结生产压缩时间戳——这是静默重定向
// 缺陷在时间维度上的版本。因此，隔离辅助函数会强制拒绝并非由自身设置的环境时钟变量，
// 与后台服务目标变量的处理一致；脚手架仅通过 injectClockNow 设置它（自设注入）。

const cleanBase = () => ({ HOME: "/base-home", PATH: "/usr/bin", TERM: "xterm" });

describe("环境测试时钟风险防护（A3-R3 泄漏固定）", () => {
  it("检测存在的 OPENRIG_TEST_CLOCK_NOW，并将空值或缺失视为干净", () => {
    expect(TEST_CLOCK_ENV_VARS).toContain("OPENRIG_TEST_CLOCK_NOW");
    expect(detectAmbientClockHazard({ OPENRIG_TEST_CLOCK_NOW: "2020-01-01T00:00:00.000Z" }))
      .toEqual({ name: "OPENRIG_TEST_CLOCK_NOW", value: "2020-01-01T00:00:00.000Z" });
    expect(detectAmbientClockHazard({ OPENRIG_TEST_CLOCK_NOW: "" })).toBeNull();
    expect(detectAmbientClockHazard({})).toBeNull();
  });

  it("assertNoAmbientClock 强制拒绝存在的时钟变量（具名、失败关闭）", () => {
    expect(() => assertNoAmbientClock({ OPENRIG_TEST_CLOCK_NOW: "frozen" })).toThrow(AmbientClockHazardError);
    expect(() => assertNoAmbientClock(cleanBase())).not.toThrow();
  });

  it("prepareHermeticEnv 在文件系统产生副作用前拒绝携带泄漏时钟变量的基础环境", () => {
    let err: unknown;
    try {
      prepareHermeticEnv({ baseEnv: { ...cleanBase(), OPENRIG_TEST_CLOCK_NOW: "leaked" } });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AmbientClockHazardError);
  });

  it("injectClockNow 在脚手架自己的子环境中设置时钟变量（自设注入），随后清理", () => {
    const scaffold = prepareHermeticEnv({ baseEnv: cleanBase(), injectClockNow: "2021-06-06T06:06:06.000Z" });
    try {
      expect(scaffold.env.OPENRIG_TEST_CLOCK_NOW).toBe("2021-06-06T06:06:06.000Z");
    } finally {
      scaffold.cleanup();
    }
  });

  it("省略 injectClockNow 时子环境不设置时钟变量（缺失即生产实时时间）", () => {
    const scaffold = prepareHermeticEnv({ baseEnv: cleanBase() });
    try {
      expect(scaffold.env.OPENRIG_TEST_CLOCK_NOW).toBeUndefined();
    } finally {
      scaffold.cleanup();
    }
  });
});
