import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const script = resolve("specs/agents/shared/skills/process/systematic-debugging/find-polluter.sh");
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture(files: string[], mode = "clean", prior = false) {
 const dir = mkdtempSync(join(tmpdir(), "polluter-")); roots.push(dir);
 mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "src"));
 for (const file of files) writeFileSync(join(dir, "src", file), "");
 writeFileSync(join(dir, "bin", "npm"), '#!/bin/sh\nprintf "%s\\n" "$2" >> calls\ncase "$PROBE_MODE" in\n dirty) touch pollution;;\n fail) exit 7;;\nesac\n', { mode: 0o755 });
 if (prior) mkdirSync(join(dir, "pollution"));
 if (mode === "find-fail") writeFileSync(join(dir,"bin","find"),"#!/bin/sh\nexit 3\n",{mode:0o755});
 const result = spawnSync("bash", [script, "pollution", "src/*.test.ts"], {
  cwd: dir, env: { ...process.env, PATH: join(dir, "bin")+":"+process.env.PATH, PROBE_MODE: mode }, encoding: "utf8",
 });
 const calls = existsSync(join(dir,"calls")) ? readFileSync(join(dir,"calls"),"utf8").trim().split("\n") : [];
 return { ...result, calls };
}
describe("polluter search reports observed execution", () => {
 it("空选择不能被认证为成功", () => { const r=fixture([]); expect(r.status).toBe(2); expect(r.stdout).toContain("未运行任何测试"); expect(r.calls).toEqual([]); });
 it("不会隐藏发现命令失败", () => { const r=fixture(["one.test.ts"],"find-fail"); expect(r.status).toBe(2); expect(r.stdout).toContain("测试选择失败"); expect(r.calls).toEqual([]); });
 it("统计并执行一个匹配文件", () => { const r=fixture(["one.test.ts"]); expect(r.status).toBe(0); expect(r.stdout).toContain("找到 1 个测试文件"); expect(r.calls).toEqual(["./src/one.test.ts"]); });
 it("保留文件名中的空格并统计两个文件", () => { const r=fixture(["one test.test.ts","two.test.ts"]); expect(r.status).toBe(0); expect(r.stdout).toContain("找到 2 个测试文件"); expect(r.calls).toEqual(["./src/one test.test.ts","./src/two.test.ts"]); });
 it("报告真正的污染源并停止", () => { const r=fixture(["one.test.ts","two.test.ts"],"dirty"); expect(r.status).toBe(1); expect(r.stdout).toContain("找到污染源"); expect(r.calls).toEqual(["./src/one.test.ts"]); });
 it("不会把失败测试视为干净通过", () => { const r=fixture(["one.test.ts"],"fail"); expect(r.status).toBe(2); expect(r.stdout).toContain("1 次测试运行失败"); expect(r.stdout).not.toContain("所有测试均干净"); });
 it("存在预先污染时拒绝运行测试", () => { const r=fixture(["one.test.ts"],"clean",true); expect(r.status).toBe(2); expect(r.stdout).toContain("测试前污染目标已存在"); expect(r.calls).toEqual([]); });
});
