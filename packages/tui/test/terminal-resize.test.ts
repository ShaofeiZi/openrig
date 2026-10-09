import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("终端 resize", () => {
  it("把原生 stdout resize 事件直接接到 draw，并在关闭时移除", () => {
    const main = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");
    const shutdown = main.slice(main.indexOf("async function shutdown"), main.indexOf('process.on("SIGINT"'));

    expect(main).toContain('process.stdout.on("resize", draw);');
    expect(shutdown).toContain('process.stdout.off("resize", draw);');
  });
});
