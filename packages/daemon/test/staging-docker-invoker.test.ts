// 已提交的真实 StagingDocker invoker（founder 于 2026-08-21 裁定，engine-independent leg）。
//
// 它修复的缺陷：L6 runbook 的内联 invoker（08-06 编写）早于 stdinFrom tar-pipe contract
//（9d2f1f2cc，08-07），因此忽略它——execFile 给 child 留下保持打开但从未写入的 pipe stdin，
// 导致 container 内的 `tar -xf -` 永久阻塞于 read(stdin)（row 42576855：child 卡住 7 分钟以上，
// parent 存活，scenario 无输出）。这些测试是 hermetic 的——`sh` 同时代替 docker 与 tar binary，
// 无需 engine 即可验证 contract 要求的 pipe/exit/timeout 机制（scenario-container-stage.ts:20-28）。
// 它们证明 invoker；明确不声称 live containment，后者等待 5.3 engine substrate 裁定。
//
// hang-class discriminator：对于旧内联 invoker shape（execFile、stdin pipe 打开但未写入），
// 下方“读取 stdin 的 child”case 永远不会结束；此处必须结束。

import { describe, it, expect } from "vitest";
import { makeRealStagingDocker } from "./helpers/staging-docker-invoker.js";

/** sh 同时代替 docker 与 tar：argv 是 `-c <script>` script。 */
function shInvoker(stepTimeoutMs?: number) {
  return makeRealStagingDocker({ command: "sh", tarCommand: "sh", ...(stepTimeoutMs ? { stepTimeoutMs } : {}) });
}

describe("makeRealStagingDocker——hermetic 双进程 tar-pipe contract（以 sh 替代）", () => {
  it("已供给的 pipe 分支：stdinFrom byte 抵达 docker 侧且 EOF 传播（consumer 结束）", async () => {
    const docker = shInvoker();
    // "tar" 产生 byte 后退出；"docker"（cat）必须同时看到 byte 与 EOF——只有 producer 退出后
    // pipe 被关闭，cat 才会结束，而旧 invoker 恰恰从未关闭它。
    const res = await docker(["-c", "cat"], ["-c", "printf 'payload-bytes'"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("payload-bytes");
  });

  it("消除 hang class：不带 stdinFrom 的 step 为 child 提供已关闭 stdin，读取 stdin 的 child 会结束而非永久阻塞", async () => {
    const docker = shInvoker();
    // 无 input 的 `cat`：旧 shape 阻塞于打开但从未写入的 pipe（08-12 样本）；正确 shape
    // 会关闭 stdin，使 cat 立即看到 EOF 并完成 step。
    const res = await docker(["-c", "cat; echo done"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("done\n");
  });

  it("step 超时：终止卡住的 docker 侧并返回具名 timeout failure，绝不无限等待", async () => {
    const docker = shInvoker(300);
    const res = await docker(["-c", "sleep 30"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("timeout");
    expect(res.stderr).toContain("300");
  });

  it("step timeout 也覆盖 tar 侧：卡住的 producer 不能挂起 step", async () => {
    const docker = shInvoker(300);
    const res = await docker(["-c", "cat"], ["-c", "sleep 30"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("timeout");
  });

  it("双出口：tar 失败而 docker 成功 → step 失败并指出 tar 侧（shell-pipeline 假绿类）", async () => {
    const docker = shInvoker();
    // tar 以 3 退出且不产生内容；cat 立即看到 EOF 并以 0 退出。shell pipeline 只报告 cat 的 0——
    // 此 contract 正是为了消除这种 masked-empty-stage 缺陷。
    const res = await docker(["-c", "cat"], ["-c", "exit 3"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("tar");
    expect(res.stderr).toContain("3");
  });

  it("docker 侧失败会传播自身 exit code", async () => {
    const docker = shInvoker();
    const res = await docker(["-c", "exit 5"]);
    expect(res.code).toBe(5);
  });

  it("tar 仍在写入时 docker 提前退出会明确失败（处理 EPIPE、不崩溃、非零）", async () => {
    const docker = shInvoker();
    // docker 侧不读取就退出；tar 侧推送约 2MB 后死于 SIGPIPE。invoker 必须承受 pipe 接线上的
    // EPIPE，并将 producer 死亡报告为 failure——无论 consumer exit 如何，内容都未抵达。
    const res = await docker(["-c", "exit 0"], ["-c", "dd if=/dev/zero bs=1024 count=2048 2>/dev/null"]);
    expect(typeof res.code).toBe("number");
    expect(res.code).not.toBe(0);
  });

  it("绝不 reject：不存在的 binary 会 resolve 为失败结果", async () => {
    const docker = makeRealStagingDocker({ command: "/nonexistent-binary-xyz" });
    const res = await docker(["anything"]);
    expect(res.code).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});
