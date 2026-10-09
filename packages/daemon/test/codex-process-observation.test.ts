import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultListProcesses } from "../src/adapters/codex-runtime-adapter.js";

let scratch: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

it("通过真实异步可执行程序与解析器路径读取前台身份", async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-process-read-"));
  // 隔离的 ps 可执行程序；不启动 provider、tmux 或守护进程。
  const output = [
    "PID PPID PGID TPGID UCOMM LSTART COMMAND",
    "101 1 101 102 zsh Sat Jan  1 12:00:00 2000 -zsh",
    "102 101 102 102 node Sat Jan  1 12:00:00 2000 node /opt/bin/codex -C /project",
    "103 102 102 102 codex Sat Jan  1 12:00:00 2000 /opt/vendor/bin/codex -C /project",
    "104 1 104 -1 node Sat Jan  1 12:00:00 2000 node /tmp/other.js --label codex",
    "broken row",
    "105 1 105 0",
  ];
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(scratch, "ps"), "#!/bin/sh\n"
    + `printf '%s\\n' "$@" > ${quote(path.join(scratch, "args"))}\n`
    + `printf '%s\\n' ${output.map(quote).join(" ")}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", scratch);
  const rows = await defaultListProcesses();
  expect(fs.readFileSync(path.join(scratch, "args"), "utf8")).toBe("-Ao\npid,ppid,pgid,tpgid,ucomm,lstart,command\n");
  expect(rows).toEqual([
    { pid: 101, ppid: 1, pgid: 101, tpgid: 102, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000", command: "-zsh" },
    { pid: 102, ppid: 101, pgid: 102, tpgid: 102, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000", command: "node /opt/bin/codex -C /project" },
    { pid: 103, ppid: 102, pgid: 102, tpgid: 102, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "/opt/vendor/bin/codex -C /project" },
    { pid: 104, ppid: 1, pgid: 104, tpgid: -1, executableName: "node", startedAt: "Sat Jan  1 12:00:00 2000", command: "node /tmp/other.js --label codex" },
  ]);
  fs.writeFileSync(path.join(scratch, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  expect(await defaultListProcesses()).toEqual([]);
});

it("使用已安装的 ps 列读取当前测试进程，且不启动 provider", async () => {
  const rows = await defaultListProcesses();
  const self = rows.find((r) => r.pid === process.pid);
  expect(self).toBeDefined();
  expect(self!.ppid).toBe(process.ppid);
  expect(self!.pgid).toBeGreaterThan(0);
  expect(Number.isInteger(self!.tpgid)).toBe(true);
  expect(self!.executableName).toBeTruthy();
  expect(self!.command).toBeTruthy();
  expect(self!.startedAt).toMatch(/\d{2}:\d{2}:\d{2}.*\d{4}/);
});
