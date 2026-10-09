import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_OPENRIG_HOME = process.env.OPENRIG_HOME;
const ORIGINAL_RIGGED_HOME = process.env.RIGGED_HOME;

afterEach(() => {
  if (ORIGINAL_OPENRIG_HOME === undefined) delete process.env.OPENRIG_HOME;
  else process.env.OPENRIG_HOME = ORIGINAL_OPENRIG_HOME;

  if (ORIGINAL_RIGGED_HOME === undefined) delete process.env.RIGGED_HOME;
  else process.env.RIGGED_HOME = ORIGINAL_RIGGED_HOME;

  vi.resetModules();
  vi.restoreAllMocks();
});

describe("openrig-compat", () => {
  it("已设置 OPENRIG_HOME 时 getOpenRigHome 优先使用它", async () => {
    process.env.OPENRIG_HOME = "/tmp/custom-openrig-home";
    delete process.env.RIGGED_HOME;

    const mod = await import("../src/openrig-compat.js");

    expect(mod.getOpenRigHome()).toBe("/tmp/custom-openrig-home");
    expect(mod.getDefaultOpenRigPath("daemon.json")).toBe("/tmp/custom-openrig-home/daemon.json");
  });

  it("getOpenRigHome 回退到 RIGGED_HOME 并发出警告", async () => {
    delete process.env.OPENRIG_HOME;
    process.env.RIGGED_HOME = "/tmp/legacy-rigged-home";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("../src/openrig-compat.js");

    expect(mod.getOpenRigHome()).toBe("/tmp/legacy-rigged-home");
    expect(warnSpy).toHaveBeenCalledWith(
      "警告：RIGGED_HOME 已弃用；请改用 OPENRIG_HOME。",
    );
  });
});
