import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// slice-07 re-review MEDIUM-1——独立 eval entry 必须能通过已记录的路径运行。它导入的 TS helper
// 需要 tsx loader，因此只执行 `node run-evals.mjs` 会失败；package command 提供 loader，
// 此文件也以 executable 形式交付，确保 shebang 真正有效。
const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = resolve(HERE, "..");
const ENTRY = resolve(DAEMON, "scripts/run-evals.mjs");

describe("run-evals——具有可运行且有文档说明的 entry", () => {
  it("公开提供 tsx loader 的 `eval` package command", () => {
    const pkg = JSON.parse(readFileSync(resolve(DAEMON, "package.json"), "utf-8"));
    const cmd = String(pkg.scripts?.eval ?? "");
    expect(cmd).toMatch(/run-evals\.mjs/);
    expect(cmd).toMatch(/tsx/);
  });

  it("以 executable 形式交付 entry（shebang 真实有效）", () => {
    expect(statSync(ENTRY).mode & 0o111).not.toBe(0);
  });
});
