// B12-T——B12 异步转换的判别测试（防止空洞通过）。
//
// 其他所有 suite 都注入同步 listProcesses stub，因此没有覆盖 runAsyncSite/defaultListProcesses：
// 转换在没有实际验证的情况下变为 green。本测试在两个采样点驱动真实默认实现（实际调用 `ps`），
// 并断言 B12 之前的实现所违反的精确属性：调用 sampler 后必须立即将控制权交还 event loop，
// 而不是在整个 spawn 期间阻塞。旧代码在 async 函数体中通过 execSync 运行 ps，因此调用本身会在
// ps 的整个执行期间停滞（此类机器上实测约 100–220ms），所有 HTTP 请求都会排在其后。
// 判别依据是顺序属性，而不是挂钟时限——行内注释记录了尝试后放弃时限的原因。
// 门禁测试：在本地还原异步包装时失败，在候选实现上通过。

import { describe, it, expect } from "vitest";
import { defaultListProcesses as refresherListProcesses } from "../src/domain/resume-metadata-refresher.js";
import { defaultListProcesses as codexListProcesses } from "../src/adapters/codex-runtime-adapter.js";

const SITES = [
  ["resume-metadata-refresher", refresherListProcesses],
  ["codex-runtime-adapter", codexListProcesses],
] as const;

describe.each(SITES)("B12-T 真实异步 list_processes——%s", (_site, listProcesses) => {
  it("运行真实 ps 路径，并在表中看到当前进程", async () => {
    const rows = await listProcesses();
    expect(rows.length).toBeGreaterThan(10);
    const self = rows.find((r) => r.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.ppid).toBeGreaterThan(0);
  });

  it("将控制权交还 event loop，而不是在 spawn 期间阻塞（B12 之前的同步实现上为 RED）", async () => {
    // 此处不作断言的是调用同步返回所需时间。实测即使异步实现，在负载下调用也会花费 60–80ms
    //（child-process spawn 初始化），因此挂钟时限受环境影响。确定性判别依据是顺序：B12 之前的
    // execSync 实现会在调用内完成 ps，因此其 promise 在首个 microtask 中 settle，早于任何 timer，
    // 此时 `turnedBeforeResolve` 始终为 false。
    const pending = listProcesses();

    // ps 运行期间 event loop 必须轮转：调用之后启动的 0ms timer 必须先于慢得多的 spawn 完成而触发。
    let loopTurnedFirst = false;
    setTimeout(() => { loopTurnedFirst = true; }, 0);
    const { rows, turnedBeforeResolve } = await pending.then((r) => ({ rows: r, turnedBeforeResolve: loopTurnedFirst }));

    expect(rows.length).toBeGreaterThan(0); // 非阻塞返回并非返回空结果的捷径
    expect(turnedBeforeResolve).toBe(true);
  });
});

// F1——resolve_home 使用相同判别依据：每个 PID 的 `ps eww` spawn 必须将控制权交还 event loop
//（F1 之前在 8 次尝试的捕获循环内运行 execFileSync——线上实测每 15 分钟会突发阻塞 28.9 秒）。
// 与上述采样点使用相同的顺序属性。
//
// 探测目标是一个已知 HOME 的已启动子进程：此平台上的 `ps eww` 无法读取 vitest worker 自身环境
//（实测输出 21 字节，不含环境变量），因此对 process.pid 作断言会受环境影响；
// 我们以显式环境变量启动的子进程则具有确定性。
describe("F1 真实异步 resolve_home——codex-thread-id", () => {
  async function withChild<T>(fn: (pid: number) => Promise<T>): Promise<T> {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
      env: { HOME: "/tmp/f1-probe-home", PATH: process.env.PATH ?? "" },
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 100)); // 等待其完成 exec
      return await fn(child.pid!);
    } finally {
      child.kill("SIGKILL");
    }
  }

  it("运行真实 ps eww 路径，并从已启动子进程的环境中解析 HOME", async () => {
    const { defaultResolveHomeDirByPid } = await import("../src/domain/codex-thread-id.js");
    const home = await withChild((pid) => defaultResolveHomeDirByPid(pid));
    expect(home).toBe("/tmp/f1-probe-home");
  });

  it("将控制权交还 event loop，而不是在 spawn 期间阻塞（F1 之前的同步实现上为 RED）", async () => {
    const { defaultResolveHomeDirByPid } = await import("../src/domain/codex-thread-id.js");
    const { home, turnedBeforeResolve } = await withChild(async (pid) => {
      const pending = defaultResolveHomeDirByPid(pid);
      let loopTurnedFirst = false;
      setTimeout(() => { loopTurnedFirst = true; }, 0);
      return Promise.resolve(pending).then((h) => ({ home: h, turnedBeforeResolve: loopTurnedFirst }));
    });
    expect(home).toBe("/tmp/f1-probe-home"); // 快速返回并非空结果捷径
    expect(turnedBeforeResolve).toBe(true);
  });
});
