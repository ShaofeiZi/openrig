import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
  it("设置 OPENRIG_HOME 时 getOpenRigHome 优先使用它", async () => {
    process.env.OPENRIG_HOME = "/tmp/custom-openrig-home";
    delete process.env.RIGGED_HOME;

    const mod = await import("../src/openrig-compat.js");

    expect(mod.getOpenRigHome()).toBe("/tmp/custom-openrig-home");
    expect(mod.getDefaultOpenRigPath("daemon.json")).toBe("/tmp/custom-openrig-home/daemon.json");
  });

  it("getOpenRigHome 回退到 RIGGED_HOME 时发出警告", async () => {
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

describe("OPR.0.4.3.12 — isFixtureScopedHome（仅路径谓词）", () => {
  const created: string[] = [];
  afterEach(() => {
    while (created.length) {
      const dir = created.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("包含 .openrig-fixture 哨兵标记的 home 返回 true", async () => {
    const { isFixtureScopedHome, FIXTURE_HOME_MARKER } = await import("../src/openrig-compat.js");
    // 任意目录（不符合临时目录约定）中的标记仍然有效——
    // 显式哨兵是最诚实且与位置无关的信号。
    const dir = mkdtempSync(join(homedir(), ".openrig-compat-test-"));
    created.push(dir);
    writeFileSync(join(dir, FIXTURE_HOME_MARKER), "");
    expect(isFixtureScopedHome(dir)).toBe(true);
  });

  it("临时根目录下的 openrig-qa* home 返回 true（无需标记）", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    expect(isFixtureScopedHome(join(tmpdir(), "openrig-qa-abc123-home"))).toBe(true);
    expect(isFixtureScopedHome("/tmp/openrig-qa-run-xyz")).toBe(true);
  });

  it("真实默认 home（~/.openrig）返回 false", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    expect(isFixtureScopedHome(join(homedir(), ".openrig"))).toBe(false);
  });

  it("不属于 openrig-qa 夹具且无标记的普通临时 home 返回 false", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    const dir = mkdtempSync(join(tmpdir(), "plain-home-"));
    created.push(dir);
    expect(isFixtureScopedHome(dir)).toBe(false);
  });

  it("任意临时根之外以 openrig-qa 命名且无标记的路径返回 false", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    // 只有名称并不足够——必须位于临时根目录下或携带标记。
    // HOME 本身可能是隔离临时目录；此负向路径不能位于其中。
    expect(isFixtureScopedHome("/home/test-user/openrig-qa-not-a-fixture")).toBe(false);
  });

  it("空字符串返回 false", async () => {
    const { isFixtureScopedHome } = await import("../src/openrig-compat.js");
    expect(isFixtureScopedHome("")).toBe(false);
  });
});
