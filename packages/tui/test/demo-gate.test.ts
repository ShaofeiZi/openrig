import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// 常驻不变量（arch ruling，2026-08-02）：--demo 门是硬门。
// demo fixture 漏进 live STATUS 渲染 = 伪造状态 = 正是 PIN-2 违规。
// 与 no-fetch-elsewhere 检查一样，钉在源码级。

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (f: string) => readFileSync(path.join(srcDir, f), "utf8");

describe("--demo 门控是硬的（PIN-2 防伪造围栏）", () => {
  it("无 live render/hydration 模块 import demo fixture", () => {
    for (const file of ["hydrate.ts", "render.ts", "state.ts", "daemon-client.ts", "socket-server.ts", "grammar.ts", "input.ts"]) {
      expect(read(file), `${file} must not import demo-data`).not.toMatch(/demo-data/);
    }
  });

  it("main.ts 仅在 --demo 标志后触及 demoSnapshot，且从不据此构造 client", () => {
    const main = read("main.ts");
    const demoUses = main.match(/demoSnapshot\(\)/g) ?? [];
    expect(demoUses).toHaveLength(1);
    expect(main).toMatch(/demo \? demoSnapshot\(\) : emptySnapshot\(\)/);
    expect(main).toMatch(/demo \? null : new DaemonClient/);
  });

  it("--demo 绝不探测会覆盖 fixture 的 live crash-cart 路径", () => {
    const main = read("main.ts");
    expect(main).toMatch(/else if \(!demo\) void refreshCrashCart\(\)/);
  });
});
