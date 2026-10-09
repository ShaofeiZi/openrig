import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RestoreCheckService, type RestoreCheckDeps, type NodeInventoryEntry, type RestoreCheckResult } from "../src/domain/restore-check-service.js";

function makeReadyNode(logicalId: string): NodeInventoryEntry {
  return {
    logicalId,
    canonicalSessionName: `${logicalId.replace(".", "-")}@test-rig`,
    sessionStatus: "running",
    startupStatus: "ready",
    cwd: "/project",
    latestError: null,
    tmuxAttachCommand: `tmux attach -t ${logicalId.replace(".", "-")}@test-rig`,
  } as NodeInventoryEntry;
}

function makeNotReadyNode(logicalId: string): NodeInventoryEntry {
  return {
    logicalId,
    canonicalSessionName: `${logicalId.replace(".", "-")}@test-rig`,
    sessionStatus: "exited",
    startupStatus: "failed",
    cwd: "/project",
    latestError: "Startup failed",
  } as NodeInventoryEntry;
}

function makeDeps(nodes: NodeInventoryEntry[]): RestoreCheckDeps {
  return {
    listRigs: () => [{ rigId: "rig-1", name: "test-rig" }],
    getNodeInventory: () => nodes,
    getStartupContext: () => ({ status: "missing" as const, evidence: "no context" }),
    hasSnapshot: () => true,
    getLatestSnapshot: () => ({ id: "snap-1", kind: "full" }),
    probeDaemonHealth: () => ({ healthy: true, evidence: "OK" }),
    exists: () => false,
    readFile: () => "",
  };
}

describe("OPR.0.4.0.29——通过 service 实现 restore-check compact", () => {
  it("AC-1：compact 产生的检查少于 full", () => {
    const nodes = [
      makeReadyNode("dev.impl"),
      makeReadyNode("dev.qa"),
      makeReadyNode("dev.guard"),
      makeNotReadyNode("dev.design"),
    ];

    const service = new RestoreCheckService(makeDeps(nodes));
    const full = service.check({ compact: false });
    const compact = service.check({ compact: true });

    expect(compact.checks.length).toBeLessThan(full.checks.length);
    expect(compact.rigs.length).toBe(full.rigs.length);
  });

  it("AC-3：compact 跳过 ready 席位的逐席位详情（FR-3/AC-4）", () => {
    const nodes = [
      makeReadyNode("dev.impl"),
      makeReadyNode("dev.qa"),
      makeNotReadyNode("dev.design"),
    ];

    const service = new RestoreCheckService(makeDeps(nodes));
    const compact = service.check({ compact: true });
    const full = service.check({ compact: false });

    const compactSeatChecks = compact.checks.filter((c) => c.check.startsWith("seat."));
    const fullSeatChecks = full.checks.filter((c) => c.check.startsWith("seat."));
    expect(compactSeatChecks.length).toBeLessThan(fullSeatChecks.length);

    const notReadyCheck = compact.checks.find((c) => c.status === "red" && c.check.includes("readiness"));
    expect(notReadyCheck).toBeDefined();
    expect(notReadyCheck!.evidence).toContain("未处于 running/ready");
  });

  it("AC-7：readiness 类别来自真实 enum", () => {
    const nodes = [makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    const validStatuses = new Set(["ready", "ready_with_caveats", "not_ready", "unknown"]);
    expect(validStatuses.has(result.readiness.status)).toBe(true);
    for (const rig of result.rigs) {
      expect(validStatuses.has(rig.status)).toBe(true);
    }
  });

  it("AC-5：没有 compact 选项 = full 结果（向后兼容）", () => {
    const nodes = [makeReadyNode("dev.impl")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    const seatChecks = result.checks.filter((c) => c.check.startsWith("seat.") || c.check.includes("startup_context") || c.check.includes("transcript") || c.check.includes("resume"));
    expect(seatChecks.length).toBeGreaterThan(1);
  });

  it("AC-8：按 rig 分组显示 rig 汇总", () => {
    const nodes = [makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")];
    const service = new RestoreCheckService(makeDeps(nodes));
    const result = service.check({});

    expect(result.rigs.length).toBe(1);
    expect(result.rigs[0]!.rigName).toBe("test-rig");
    expect(result.rigs[0]!.expectedNodes).toBe(2);
  });

  // OPR.0.4.0.29 FR-8 / AC-7——按 5 个真实 enum 类别拆分 ready-confidence。
  it("AC-7：classCounts 将席位分入 5 个真实 enum 类别（不虚构状态）", () => {
    const makeAttentionNode = (logicalId: string): NodeInventoryEntry => ({
      logicalId,
      canonicalSessionName: `${logicalId.replace(".", "-")}@test-rig`,
      sessionStatus: "running",
      startupStatus: "attention_required",
      cwd: "/project",
      latestError: "Awaiting operator",
    } as NodeInventoryEntry);

    // 两个 ready 席位确实干净（nodeId + ok startup context + exists:true 表示文件存在 +
    // daemon 健康），因此计为普通 `ready`，真正覆盖 ready 类别。（默认 compact 的 caveat 检测
    // 由下面两个专门测试覆盖；缺少 startup context 的裸 makeReadyNode 属于 ready_with_caveats，
    // 而非 ready，且默认 compact 现在能检测到这一点。）
    const nodes = [
      { ...makeReadyNode("dev.impl"), nodeId: "node-impl" } as NodeInventoryEntry,
      { ...makeReadyNode("dev.qa"), nodeId: "node-qa" } as NodeInventoryEntry,
      makeNotReadyNode("dev.design"),
      makeAttentionNode("dev.synth"),
    ];
    const deps: RestoreCheckDeps = {
      ...makeDeps(nodes),
      exists: () => true,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      getStartupContext: () => ({ status: "ok" as const, runtime: null, resolvedStartupFiles: [], projectionEntries: [] }),
    };
    const result = new RestoreCheckService(deps).check({ compact: true });

    // 恰好为 5 个真实 enum 类别 key——没有 fresh-primed/awaiting-decision 等虚构状态。
    expect(Object.keys(result.classCounts).sort()).toEqual(
      ["attention_required", "not_ready", "ready", "ready_with_caveats", "unknown"],
    );
    expect(result.classCounts.ready).toBe(2);
    expect(result.classCounts.attention_required).toBe(1);
    expect(result.classCounts.not_ready).toBe(1);
    // 拆分结果覆盖每个席位。
    const total = Object.values(result.classCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
  });

  it("AC-7：各 rig 的 classCounts 总和等于整个机群的 classCounts", () => {
    const result = new RestoreCheckService(
      makeDeps([makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")]),
    ).check({});
    const rigSum = result.rigs.reduce((a, r) => a + Object.values(r.classCounts).reduce((x, y) => x + y, 0), 0);
    const fleetSum = Object.values(result.classCounts).reduce((a, b) => a + b, 0);
    expect(rigSum).toBe(fleetSum);
  });

  it("AC-7：无 snapshot rig 的 running/ready 席位计为 unknown，而非 ready（真实 snapshot 原语）", () => {
    const deps: RestoreCheckDeps = { ...makeDeps([makeReadyNode("dev.impl"), makeReadyNode("dev.qa")]), hasSnapshot: () => false };
    const result = new RestoreCheckService(deps).check({ compact: true });
    // 没有 snapshot 就无法恢复 rig -> 其 ready 席位为 unknown。
    expect(result.classCounts.ready).toBe(0);
    expect(result.classCounts.unknown).toBe(2);
  });

  it("AC-7：no-snapshot 不会隐藏失败席位（not_ready 优先于 no-snapshot）", () => {
    const deps: RestoreCheckDeps = { ...makeDeps([makeReadyNode("dev.impl"), makeNotReadyNode("dev.qa")]), hasSnapshot: () => false };
    const result = new RestoreCheckService(deps).check({ compact: true });
    // 失败席位保持 not_ready（对外呈现）；只有干净席位 -> unknown。
    expect(result.classCounts.not_ready).toBe(1);
    expect(result.classCounts.unknown).toBe(1);
    expect(result.classCounts.ready).toBe(0);
  });

  // OPR.0.4.0.29 QA-blocking forward-fix（qa-blocking-1f7b1282）：restore-proof-caveat 复现。
  // 有 snapshot 支撑且处于 running/ready 的席位，如果 startup context 缺失，就存在真实 yellow caveat。
  // 每 rig status + caveatNodes 已经报告该问题；classCounts 也必须体现 caveat——ready_with_caveats
  // 优先于普通 ready（但仍低于上文断言的 attention/not_ready/no-snapshot）。
  it("AC-7：存在真实 yellow caveat 的 running/ready 席位计为 ready_with_caveats，而非 ready", () => {
    // makeReadyNode 为 running+ready；缺少 startup context 时，其 seat.<session>.startup-context
    // 检查为 yellow（buildStartupContextAvailabilityCheck）。includeReady 强制组装 ready 席位详情
    //（QA 证明使用的 --ready 路径）。exists:true + 健康 daemon 会清除无关的 rig/host red 检查
    //（spec-present、daemon.reachable、transcript/queue 文件），使真实 startup-context caveat
    // 成为唯一非 green 信号，从而隔离该缺陷。
    const deps: RestoreCheckDeps = {
      ...makeDeps([makeReadyNode("dev.impl")]),
      hasSnapshot: () => true,
      exists: () => true,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      getStartupContext: () => ({ status: "missing" as const, evidence: "Persisted startup context missing" }),
    };
    const result = new RestoreCheckService(deps).check({ compact: true, includeReady: true });

    const rig = result.rigs.find((r) => r.rigName === "test-rig")!;
    expect(rig.status).toBe("ready_with_caveats");
    expect(rig.caveatNodes).toBe(1);
    expect(result.classCounts.ready_with_caveats).toBe(1);
    expect(result.classCounts.ready).toBe(0);
  });

  // OPR.0.4.0.29 code-review BLOCKING forward-fix（qitem-...52809188）：QA 证明实际运行的 DEFAULT
  // compact 路径（`zrig restore-check`，不是 --ready）。默认 compact 从输出中省略 ready 席位详情
  //（节省 token），但汇总仍必须检测 caveat——有 snapshot 支撑的 running/ready 席位若缺少
  // startup context，应为 ready_with_caveats，而非 ready。上面的 includeReady 测试必要但不充分：
  // 它会掩盖 default-compact 跳过详情的问题。
  it("AC-7：DEFAULT compact（无 includeReady）仍将 running/ready 席位的 yellow caveat 计为 ready_with_caveats", () => {
    // 设置 nodeId，使真实 getStartupContext-missing 路径产生 yellow startup-context caveat。
    // 使用干净依赖，确保它是唯一非 green 的席位信号。
    const caveatNode = { ...makeReadyNode("dev.impl"), nodeId: "node-caveat" } as NodeInventoryEntry;
    const deps: RestoreCheckDeps = {
      ...makeDeps([caveatNode]),
      hasSnapshot: () => true,
      exists: () => true,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      getStartupContext: () => ({ status: "missing" as const, evidence: "Persisted startup context missing" }),
    };
    const result = new RestoreCheckService(deps).check({ compact: true });

    const rig = result.rigs.find((r) => r.rigName === "test-rig")!;
    expect(rig.status).toBe("ready_with_caveats");
    expect(rig.caveatNodes).toBe(1);
    expect(result.classCounts.ready_with_caveats).toBe(1);
    expect(result.classCounts.ready).toBe(0);
    // 节省 token：默认 compact 不输出 ready 席位的详情行。
    expect(result.checks.some((c) => c.check.endsWith(".startup-context"))).toBe(false);
  });

  // OPR.0.4.0.29 code-review BLOCKING（qitem-...4f06e820）：AC-4/FR-3 要求 daemon 在默认 compact
  // 模式下跳过完整 ready 席位详情组装，而不只是组装后隐藏。默认 compact 只计算 FR-8 汇总所需的
  // startup-context caveat 信号；不会为 green ready 席位组装 transcript/resume/queue/hooks。
  // 行为级无调用证明：一个 startup context 干净但没有 attach command 的 green ready 席位。
  // 如果默认 compact 组装详情，就会运行 checkResumePath -> yellow resume-path caveat ->
  // ready_with_caveats。跳过详情则使席位保持普通 ready。
  it("AC-4：默认 compact 不为 green ready 席位组装完整详情（resume/transcript/queue/hooks）", () => {
    const cleanReadyNoAttach = { ...makeReadyNode("dev.impl"), nodeId: "node-clean", tmuxAttachCommand: undefined } as NodeInventoryEntry;
    const deps: RestoreCheckDeps = {
      ...makeDeps([cleanReadyNoAttach]),
      hasSnapshot: () => true,
      exists: () => true,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      // ok startup context -> startup-context 为 GREEN，因此它不是 caveat。
      getStartupContext: () => ({ status: "ok" as const, runtime: null, resolvedStartupFiles: [], projectionEntries: [] }),
    };

    // 默认 compact：不组装 resume-path（及其余详情），因此缺少 attach command 不会产生 caveat -> 普通 ready。
    const compact = new RestoreCheckService(deps).check({ compact: true });
    expect(compact.classCounts.ready).toBe(1);
    expect(compact.classCounts.ready_with_caveats).toBe(0);
    expect(compact.rigs.find((r) => r.rigName === "test-rig")!.status).toBe("ready");

    // --ready/includeReady 会组装详情 -> 缺少 attach command 成为 yellow resume-path caveat ->
    // ready_with_caveats。这证明详情集合真实存在，只有 default-compact 路径会跳过。
    const ready = new RestoreCheckService(deps).check({ compact: true, includeReady: true });
    expect(ready.classCounts.ready_with_caveats).toBe(1);
    expect(ready.classCounts.ready).toBe(0);
  });

  // OPR.0.4.0.29 rev1-r2 BLOCKING（qitem-...f13fc5b4）：no-false-ready。已跳过
  //（已计算但未输出）的 ready 席位 startup-context caveat 仍必须驱动顶层 verdict/readiness/counts；
  // 否则默认 compact 会错误报告顶层 ready/restorable，而同一 payload 又承认存在 ready_with_caveats rig。
  // 使用干净 host（green daemon + green host-infra 声明），使隐藏的 startup-context caveat
  // 成为唯一非 green 信号。
  it("AC-4 / no-false-ready：隐藏的 ready 席位 caveat 在默认 compact 中驱动顶层 verdict/readiness", () => {
    const caveatNode = { ...makeReadyNode("dev.impl"), nodeId: "node-caveat" } as NodeInventoryEntry;
    const hostInfra = JSON.stringify({ schemaVersion: 1, daemonBootstrap: { mechanism: "launchd", declared: true }, supportingInfra: [] });
    const deps: RestoreCheckDeps = {
      ...makeDeps([caveatNode]),
      hasSnapshot: () => true,
      exists: () => true,
      readFile: () => hostInfra,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running" }),
      getStartupContext: () => ({ status: "missing" as const, evidence: "Persisted startup context missing" }),
    };
    const result = new RestoreCheckService(deps).check({ compact: true });

    // 顶层不得错误报告 ready/restorable。
    expect(result.verdict).toBe("restorable_with_caveats");
    expect(result.readiness.status).toBe("ready_with_caveats");
    expect(result.readiness.caveatRigCount).toBe(1);
    expect(result.counts.yellow).toBeGreaterThanOrEqual(1);
    // Rollup 与 classCounts 一致。
    expect(result.classCounts.ready_with_caveats).toBe(1);
    expect(result.classCounts.ready).toBe(0);
    // 保持 AC-4：仍不输出 startup-context 详情行。
    expect(result.checks.some((c) => c.check.endsWith(".startup-context"))).toBe(false);
  });
});
