import { describe, it, expect } from "vitest";
import { daemonStartArgs } from "../src/crash-cart/start-daemon.js";
import { resolveCrashCartKey } from "../src/crash-cart/keys.js";

describe("本地启动目标", () => {
  it("只启动预期的本地 daemon，占用者选择交给用户", () => {
    expect(daemonStartArgs("http://127.0.0.1:17433")).toEqual([
      "daemon", "start", "--no-kernel", "--host", "127.0.0.1", "--port", "17433",
    ]);
  });
  it.each(["https://example.test", "http://10.0.0.2:7433", "http://user:password@localhost:7433", "http://localhost:7433/other"])(
    "不把 %s 当作本地启动权威", (target) => {
      expect(() => daemonStartArgs(target)).toThrow("未启动任何本地后台服务");
    },
  );
  it("不可用前提允许 inspect/重试，但不产生恢复效果", () => {
    const opts = { unavailable: "native load failed" };
    expect(resolveCrashCartKey("r", opts)).toBe("retry");
    expect(resolveCrashCartKey("d", opts)).toBe("details");
    for (const key of ["s", "n", "enter", "i"]) expect(resolveCrashCartKey(key, opts)).toBeNull();
  });
});
