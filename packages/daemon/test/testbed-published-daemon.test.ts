// PARITY FENCE：published-daemon 常量与 L3 runbook 文本是同一流程的两个使用方。
// 若只修改模块中的值而未同步 runbook（反之亦然），会产生静默漂移，使 A/B 两组测量不同配置——
// 此测试会明确暴露该漂移。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BIND_ENV, BIND_VALUE, BEARER_ENV, L3_HOST_PORT, CONTAINER_PORT,
  HEALTH_PATH, GUARDED_PROBE_PATH, publishArg, publishedDaemonEnv,
  TERMINAL_BEARER_ENV, rigReadEnv,
} from "./helpers/testbed-published-daemon.js";

const RUNBOOK = readFileSync(
  resolve(import.meta.dirname, "../../../docker/testbed/runbooks/L3-daemon-in-container.md"),
  "utf8",
);

describe("published-daemon 流程——module/runbook 一致性", () => {
  it("runbook 包含显式 bind、bearer 环境变量和显式端口", () => {
    expect(RUNBOOK).toContain(`${BIND_ENV}=${BIND_VALUE}`);
    expect(RUNBOOK).toContain(BEARER_ENV);
    expect(RUNBOOK).toContain(String(L3_HOST_PORT));
  });

  it("runbook 同时探测两个接口：无需认证的 health + guarded 路由", () => {
    expect(RUNBOOK).toContain(HEALTH_PATH);
    expect(RUNBOOK).toContain(GUARDED_PROBE_PATH);
  });

  it("publishArg 不带限定（Apple 会重置带 loopback 的形式），并拒绝临时端口 0", () => {
    expect(publishArg(L3_HOST_PORT)).toBe(`${L3_HOST_PORT}:${CONTAINER_PORT}`);
    expect(publishArg(L3_HOST_PORT)).not.toContain("127.0.0.1");
    expect(() => publishArg(0)).toThrow(/explicit positive integer/);
  });

  it("zrig READ 携带 TERMINAL token 环境变量——名称不同，但在此流程中值相同", () => {
    expect(TERMINAL_BEARER_ENV).toBe("OPENRIG_TERMINAL_BEARER_TOKEN");
    expect(TERMINAL_BEARER_ENV).not.toBe(BEARER_ENV); // 概念不同；只因 non-trusted-bind 复制而一致
    expect(rigReadEnv("t", "http://127.0.0.1:19433")).toEqual({
      [TERMINAL_BEARER_ENV]: "t",
      OPENRIG_URL: "http://127.0.0.1:19433",
    });
    expect(() => rigReadEnv("", "http://x")).toThrow(/non-empty token/);
  });

  it("runbook 保留 NEGATIVE CONTROL——这是 guard 已启用的唯一断言", () => {
    // terminal token 为 null 时，guarded 路由完全开放（middleware 直接放行），
    // 因此只做 auth probe 的 runbook 可能变 green，却什么也证明不了。
    expect(RUNBOOK).toMatch(/NEGATIVE CONTROL/i);
    expect(RUNBOOK).toMatch(/401/);
  });

  it("env helper 拒绝空 bearer——满足 guard，绝不削弱它", () => {
    expect(publishedDaemonEnv("t")).toEqual({ [BIND_ENV]: BIND_VALUE, [BEARER_ENV]: "t" });
    expect(() => publishedDaemonEnv("")).toThrow(/REFUSES a non-loopback bind/);
  });
});

describe("staging helper——runbook 与 adapter 共用一种方法", () => {
  it("stage 路径位于容器内 exec 用户的 home 下，并拒绝主机/逃逸路径", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    expect(m.containerStagePath("topologies")).toBe("/home/openrig/topologies");
    expect(() => m.containerStagePath("/abs")).toThrow(/simple relative name/);
    expect(() => m.containerStagePath("../escape")).toThrow(/simple relative name/);
  });

  it("delivery 以默认 exec 用户解压——无 -u root、无 chown（通过结构保证所有权）", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    const argv = m.stageExtractArgv("H_A", "/home/openrig/topologies");
    expect(argv).toEqual(["exec", "-i", "H_A", "tar", "-C", "/home/openrig/topologies", "-xf", "-"]);
    expect(argv).not.toContain("-u");
    expect(argv.join(" ")).not.toMatch(/chown/);
  });

  it("stage fence 通过实际操作（read + touch/rm）探测完整契约，而非读取 mode bit", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    const cmd = m.stageFenceArgv("H_A", "/home/openrig/topologies").join(" ");
    expect(cmd).toMatch(/test -r/);
    expect(cmd).toMatch(/touch/);
    expect(cmd).toMatch(/rm -f/);
    expect(cmd).not.toMatch(/stat|ls -l/); // 断言目标不是 mode bit
  });
});

describe("stageTopologyPlan——顺序即契约", () => {
  it("按 mkdir -> extract -> fence 排序，且 fence 绝不在首位（空 stage 能通过朴素读取检查）", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    const plan = m.stageTopologyPlan({ container: "H_A", hostDir: "/host/topologies" });
    expect(plan.stagePath).toBe("/home/openrig/topologies");
    expect(plan.steps.map((s: { label: string }) => s.label)).toEqual(["mkdir", "extract", "fence"]);
    expect(plan.steps[1]!.stdinFrom).toEqual(["-C", "/host/topologies", "-cf", "-", "."]);
  });
});

describe("stage fence 断言内容已到达，而不只是目录存在", () => {
  it("提供 expectFile 时 fence 针对文件（空 stage 无法通过）", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    const cmd = m.stageFenceArgv("H_A", "/home/openrig/topologies", "shared.yaml").join(" ");
    expect(cmd).toContain("test -r '/home/openrig/topologies/shared.yaml'");
    expect(cmd).toContain("touch '/home/openrig/topologies/.fence-write'"); // 可写性仍在目录上检查
  });

  it("stageTopologyPlan 将 expectFile 传递到 fence 步骤", async () => {
    const m = await import("./helpers/testbed-published-daemon.js");
    const plan = m.stageTopologyPlan({ container: "H_A", hostDir: "/host/t", expectFile: "rig-a.yaml" });
    expect(plan.steps[2]!.argv.join(" ")).toContain("/home/openrig/topologies/rig-a.yaml");
  });
});
