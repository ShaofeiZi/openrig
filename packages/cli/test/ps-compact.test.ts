// OPR.0.4.0.25 — rig ps token-safe defaults (compact-by-default projection-trim).
// Large multi-rig fixture exercises compact default, --full byte-equivalence,
// --rig/--session 过滤与字段集合诚实性。镜像 ps.test.ts 的 harness。

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { psCommand } from "../src/commands/ps.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const errLogs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errLogs.push(args.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander throws on exitOverride */ }
    const exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
    resolve({ logs, errLogs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-06-19T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

// --- Large multi-rig fixture ---
// 3 个 rig、共约 15 个 node，带丰满字段（contextUsage、agentActivity、
// resumeCommand、tmuxAttachCommand、额外 [key:string]:unknown 字段）。
// 这是证明 compact 默认 token 回归的最小集合。

function makeFatNode(rigId: string, rigName: string, logicalId: string, opts?: {
  lifecycleState?: string;
  startupStatus?: string;
  activityState?: string;
  activityReason?: string;
  hasAssignedWork?: boolean;
  assignedWorkCount?: number;
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
  latestError?: string | null;
  contextPercent?: number | null;
}) {
  return {
    rigId,
    rigName,
    logicalId,
    podId: `pod-${logicalId.split(".")[0]}`,
    podNamespace: logicalId.split(".")[0],
    canonicalSessionName: `${logicalId.replace(".", "-")}@${rigName}`,
    // Slice 13 修复 2——daemon 给每个服务出的行盖上其启动对账后的
    // self-id；fixture 镜像服务形状，使 compact/full 比率守卫度量真实表面。
    hostSelfId: "host-84c37990",
    nodeKind: "agent" as const,
    runtime: "claude-code",
    sessionStatus: "running",
    startupStatus: opts?.startupStatus ?? "ready",
    restoreOutcome: "n-a",
    lifecycleState: opts?.lifecycleState ?? "running",
    tmuxAttachCommand: `tmux attach -t ${logicalId.replace(".", "-")}@${rigName}`,
    resumeCommand: `claude --resume /path/to/session/${logicalId}`,
    latestError: opts?.latestError ?? null,
    terminalActive: true,
    hasAssignedWork: opts?.hasAssignedWork ?? false,
    assignedWorkCount: opts?.assignedWorkCount ?? opts?.pendingWorkCount ?? 0,
    pendingWorkCount: opts?.pendingWorkCount ?? 0,
    inProgressWorkCount: opts?.inProgressWorkCount ?? 0,
    blockedWorkCount: opts?.blockedWorkCount ?? 0,
    agentActivity: {
      state: opts?.activityState ?? "running",
      reason: opts?.activityReason ?? "mid_work_pattern",
      evidenceSource: "pane_heuristic",
      sampledAt: "2026-06-19T12:00:00.000Z",
      evidence: "Working on slice 25",
    },
    contextUsage: {
      availability: opts?.contextPercent === null ? "unknown" : "known",
      usedPercentage: opts?.contextPercent ?? 45,
      fresh: true,
      state: (opts?.contextPercent ?? 45) >= 80 ? "critical" : (opts?.contextPercent ?? 45) >= 60 ? "warning" : "low",
      sampledAt: "2026-06-19T12:00:00.000Z",
    },
    // Extra unknown fields that [key: string]: unknown picks up — these MUST
    // survive in --full but be dropped in compact.
    resolvedSpecHash: "abc123def456",
    agentRef: { provider: "anthropic", model: "claude-opus-4-20250514" },
    recoveryGuidance: "If this node is stuck, try: rig restart --session " + `${logicalId.replace(".", "-")}@${rigName}` + ". Detailed recovery steps: check tmux session, verify daemon health, ensure the agent process is running and responsive to signals. Additional context: this is a long recovery guidance string that adds significant token weight to every node entry in the default output.",
  };
}

const RIG_A_NODES = [
  makeFatNode("rig-a", "openrig-build", "orch1.lead"),
  makeFatNode("rig-a", "openrig-build", "orch1.peer"),
  makeFatNode("rig-a", "openrig-build", "dev1.impl"),
  makeFatNode("rig-a", "openrig-build", "dev1.qa"),
  makeFatNode("rig-a", "openrig-build", "rev1.r1"),
  makeFatNode("rig-a", "openrig-build", "rev1.r2"),
  // 一个 attention 节点——reason 必须出现在 compact 中
  makeFatNode("rig-a", "openrig-build", "dev1.design", {
    lifecycleState: "attention_required",
    startupStatus: "attention_required",
    activityState: "needs_input",
    activityReason: "approval_pending",
    latestError: "Compaction imminent",
    hasAssignedWork: true,
    assignedWorkCount: 6,
    pendingWorkCount: 3,
    inProgressWorkCount: 2,
    blockedWorkCount: 1,
    contextPercent: 92,
  }),
];

const RIG_B_NODES = [
  makeFatNode("rig-b", "openrig-comms", "orch1.lead"),
  makeFatNode("rig-b", "openrig-comms", "orch1.peer"),
  makeFatNode("rig-b", "openrig-comms", "content1.writer"),
  makeFatNode("rig-b", "openrig-comms", "content1.editor"),
  makeFatNode("rig-b", "openrig-comms", "comm1.social"),
];

const RIG_C_NODES = [
  makeFatNode("rig-c", "openrig-velocity", "orch1.lead", {
    hasAssignedWork: true,
    assignedWorkCount: 7,
    pendingWorkCount: 5,
    inProgressWorkCount: 1,
    blockedWorkCount: 1,
  }),
  makeFatNode("rig-c", "openrig-velocity", "dev1.driver"),
  makeFatNode("rig-c", "openrig-velocity", "dev1.qa"),
];

const ALL_NODES = [...RIG_A_NODES, ...RIG_B_NODES, ...RIG_C_NODES];
const TOTAL_NODE_COUNT = ALL_NODES.length; // 15

const PS_DATA = [
  { rigId: "rig-a", name: "openrig-build", rigName: "openrig-build", nodeCount: 7, runningCount: 7, status: "running", lifecycleState: "attention_required", uptime: "2h", latestSnapshot: null },
  { rigId: "rig-b", name: "openrig-comms", rigName: "openrig-comms", nodeCount: 5, runningCount: 5, status: "running", lifecycleState: "running", uptime: "1h", latestSnapshot: null },
  { rigId: "rig-c", name: "openrig-velocity", rigName: "openrig-velocity", nodeCount: 3, runningCount: 3, status: "running", lifecycleState: "running", uptime: "30m", latestSnapshot: null },
];

const NODES_BY_RIG: Record<string, unknown[]> = {
  "rig-a": RIG_A_NODES,
  "rig-b": RIG_B_NODES,
  "rig-c": RIG_C_NODES,
};

describe("OPR.0.4.0.25 — rig ps token-safe defaults", () => {
  let server: http.Server;
  let port: number;
  let savedSessionName: string | undefined;

  beforeAll(async () => {
    savedSessionName = process.env.OPENRIG_SESSION_NAME;
    delete process.env.OPENRIG_SESSION_NAME;
    server = http.createServer((req, res) => {
      const m = req.url?.match(/^\/api\/rigs\/([^/]+)\/nodes(?:\?.*)?$/);
      if (m && req.method === "GET") {
        const rigId = decodeURIComponent(m[1]!);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(NODES_BY_RIG[rigId] ?? []));
      } else if (req.url === "/api/ps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(PS_DATA));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    if (savedSessionName !== undefined) process.env.OPENRIG_SESSION_NAME = savedSessionName;
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(psCommand(runningDeps(port)));
    return prog;
  }

  // -- AC-1: token-safe default (the regression) --
  it("AC-1: default --nodes --json is an order of magnitude smaller than --full", async () => {
    const { logs: defaultLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });

    const defaultOutput = defaultLogs.join("");
    const fullOutput = fullLogs.join("");

    // compact 必须显著小于 full。slice 13 修复 2 重定基 /3 → /2.8：
    // hostSelfId 是加进两个投影的一个受裁定标量（host 归属必须随 token 安全
    // 默认走——否则合并 roster 读起来像权威），它在没有任何重字段返回的情况下
    // 移动了比率。真正的回归守卫——重字段保持从 compact 省略——在 AC-7 直接断言。
    expect(defaultOutput.length).toBeLessThan(fullOutput.length / 2.8);
    // 健全性：full 输出存在且非平凡
    expect(fullOutput.length).toBeGreaterThan(1000);
  });

  // -- AC-2: same breadth (no node dropped) --
  it("AC-2: compact default lists ALL nodes (same count as --full)", async () => {
    const { logs: defaultLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });

    const defaultNodes = JSON.parse(defaultLogs.join(""));
    const fullNodes = JSON.parse(fullLogs.join(""));

    expect(Array.isArray(defaultNodes)).toBe(true);
    expect(Array.isArray(fullNodes)).toBe(true);
    expect(defaultNodes.length).toBe(TOTAL_NODE_COUNT);
    expect(fullNodes.length).toBe(TOTAL_NODE_COUNT);
  });

  // -- AC-3：--full --json 与今日默认逐字节等价 --
  // 今日默认发出原始 fat 数组。本切片之后，--full 必须
  // 发出同一个原始数组。我们把今日行为捕获为 golden。
  it("AC-3: --full --json is byte-equivalent to today's raw default", async () => {
    // Today's default IS the full raw array (no compact yet).
    // After slice-25, --full must produce the same output as today's default.
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });

    const fullOutput = fullLogs.join("");
    const fullParsed = JSON.parse(fullOutput);

    // 必须是裸数组（非信封）
    expect(Array.isArray(fullParsed)).toBe(true);
    expect(fullParsed.length).toBe(TOTAL_NODE_COUNT);

    // Must preserve [key: string]: unknown extras
    const firstNode = fullParsed[0];
    expect(firstNode.resolvedSpecHash).toBeDefined();
    expect(firstNode.agentRef).toBeDefined();
    expect(firstNode.recoveryGuidance).toBeDefined();

    // Must preserve full agentActivity object
    expect(firstNode.agentActivity).toBeDefined();
    expect(firstNode.agentActivity.evidenceSource).toBeDefined();
    expect(firstNode.agentActivity.evidence).toBeDefined();

    // Must preserve full contextUsage object
    expect(firstNode.contextUsage).toBeDefined();
    expect(firstNode.contextUsage.usedPercentage).toBeDefined();
  });

  // -- AC-4: compact field set --
  it("AC-4: compact projection includes the specified field set", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const nodes = JSON.parse(logs.join(""));

    for (const node of nodes) {
      // Required fields present
      expect(node).toHaveProperty("rigName");
      expect(node).toHaveProperty("canonicalSessionName");
      expect(node).toHaveProperty("lifecycleState");
      expect(node.agentActivity).toBeDefined();
      expect(node.agentActivity).toHaveProperty("state");
      expect(node).toHaveProperty("hasAssignedWork");
      expect(node).toHaveProperty("assignedWorkCount");
      expect(node).toHaveProperty("pendingWorkCount");
      // 详细状态兄弟字段仍经 --full/--fields 可用；compact
      // 保留每个基础键，加上诚实渲染已声明工作所需的 total。
      expect(node.inProgressWorkCount).toBeUndefined();
      expect(node.blockedWorkCount).toBeUndefined();

      // Excluded heavy fields absent
      expect(node.contextUsage).toBeUndefined();
      expect(node.recoveryGuidance).toBeUndefined();
      expect(node.resolvedSpecHash).toBeUndefined();
      expect(node.agentRef).toBeUndefined();
      expect(node.resumeCommand).toBeUndefined();
      expect(node.tmuxAttachCommand).toBeUndefined();

      // agentActivity 是 compact 的（仅 state，attention 时加 reason）
      expect(node.agentActivity.evidenceSource).toBeUndefined();
      expect(node.agentActivity.evidence).toBeUndefined();
      expect(node.agentActivity.sampledAt).toBeUndefined();
    }
  });

  it("AC-4: attention node includes reason + latestError; healthy node omits reason", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const nodes = JSON.parse(logs.join(""));

    // dev1.design 是 attention 节点
    const attentionNode = nodes.find((n: { canonicalSessionName: string }) =>
      n.canonicalSessionName === "dev1-design@openrig-build"
    );
    expect(attentionNode).toBeDefined();
    expect(attentionNode.agentActivity.state).toBe("needs_input");
    expect(attentionNode.agentActivity.reason).toBe("approval_pending");
    expect(attentionNode.latestError).toBe("Compaction imminent");

    // orch1.lead 是 healthy——reason 应省略
    const healthyNode = nodes.find((n: { canonicalSessionName: string }) =>
      n.canonicalSessionName === "orch1-lead@openrig-build"
    );
    expect(healthyNode).toBeDefined();
    expect(healthyNode.agentActivity.state).toBe("running");
    expect(healthyNode.agentActivity.reason).toBeUndefined();
    expect(healthyNode.latestError).toBeUndefined();
  });

  // -- AC-5: --rig and --session filters compose --
  it("AC-5: --rig narrows to nodes of that rig", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--rig", "openrig-comms"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(nodes.length).toBe(RIG_B_NODES.length);
    for (const n of nodes) {
      expect(n.rigName).toBe("openrig-comms");
    }
  });

  it("AC-5: --session narrows to matching session", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--session", "dev1-driver@openrig-velocity"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(nodes.length).toBe(1);
    expect(nodes[0].canonicalSessionName).toBe("dev1-driver@openrig-velocity");
  });

  it("AC-5: --rig composes with --full (full payload, rig-filtered)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "--json", "--rig", "openrig-velocity", "--full"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(nodes.length).toBe(RIG_C_NODES.length);
    // full payload 带重字段
    expect(nodes[0].contextUsage).toBeDefined();
    expect(nodes[0].recoveryGuidance).toBeDefined();
    expect(nodes[0].resolvedSpecHash).toBeDefined();
  });

  it("AC-5: --session composes with compact (compact payload, session-filtered)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--session", "orch1-lead@openrig-build"]);
    });
    const nodes = JSON.parse(logs.join(""));
    expect(nodes.length).toBe(1);
    // Compact — no heavy fields
    expect(nodes[0].contextUsage).toBeUndefined();
    expect(nodes[0].recoveryGuidance).toBeUndefined();
  });

  // -- AC-6: help text --
  it("AC-6: help text documents compact default, --full, --rig, --session, queue frontier", () => {
    const psCmd = psCommand(runningDeps(port));
    let helpOutput = "";
    psCmd.configureOutput({ writeOut: (s) => { helpOutput += s; } });
    psCmd.outputHelp();
    expect(helpOutput).toContain("--full");
    expect(helpOutput).toContain("--rig");
    expect(helpOutput).toContain("--session");
    expect(helpOutput).toContain("当前 rig");
    expect(helpOutput).toContain("紧凑");
  });

  // -- AC-7: both paths in one suite --
  it("AC-7: default compact and --full exercised on same fixture (regression guard)", async () => {
    const { logs: compactLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });

    const compact = JSON.parse(compactLogs.join(""));
    const full = JSON.parse(fullLogs.join(""));

    // Both are bare arrays with the same node count
    expect(Array.isArray(compact)).toBe(true);
    expect(Array.isArray(full)).toBe(true);
    expect(compact.length).toBe(full.length);

    // Compact is much smaller (re-based /3 → /2.8 with AC-1 — see its comment)
    expect(compactLogs.join("").length).toBeLessThan(fullLogs.join("").length / 2.8);

    // Full preserves all fields; compact omits heavy ones
    expect(full[0].contextUsage).toBeDefined();
    expect(compact[0].contextUsage).toBeUndefined();
    expect(full[0]).toHaveProperty("inProgressWorkCount");
    expect(full[0]).toHaveProperty("blockedWorkCount");
  });

  // -- Composition: --fields overrides compact (existing behavior preserved) --
  it("--fields overrides compact (explicit projection takes precedence)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--fields", "rigName,canonicalSessionName"]);
    });
    const parsed = JSON.parse(logs.join(""));
    // --fields triggers envelope
    const entries = parsed.entries;
    expect(entries.length).toBe(TOTAL_NODE_COUNT);
    expect(Object.keys(entries[0])).toEqual(["rigName", "canonicalSessionName"]);
  });

  it("--fields exposes the exact assigned-work state breakdown omitted from compact rows", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync([
        "node", "rig", "ps", "--nodes", "-A", "--json", "--fields",
        "canonicalSessionName,assignedWorkCount,pendingWorkCount,inProgressWorkCount,blockedWorkCount",
      ]);
    });
    const entries = JSON.parse(logs.join("")).entries;
    const assigned = entries.find((entry: Record<string, unknown>) =>
      entry.canonicalSessionName === "dev1-design@openrig-build");
    expect(assigned).toEqual({
      canonicalSessionName: "dev1-design@openrig-build",
      assignedWorkCount: 6,
      pendingWorkCount: 3,
      inProgressWorkCount: 2,
      blockedWorkCount: 1,
    });
  });

  // -- --verbose alias --
  it("--verbose is an alias for --full", async () => {
    const { logs: fullLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--full"]);
    });
    const { logs: verboseLogs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json", "--verbose"]);
    });
    expect(fullLogs.join("")).toBe(verboseLogs.join(""));
  });

  // -- Default shape is bare array (back-compat) --
  it("compact default --json stays a bare array (not envelope)", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--json"]);
    });
    const parsed = JSON.parse(logs.join(""));
    expect(Array.isArray(parsed)).toBe(true);
    // Not an envelope object — a bare array has no own 'entries' property
    expect(Object.prototype.hasOwnProperty.call(parsed, "entries")).toBe(false);
  });

  // -- Human table compact --
  it("compact default human table uses compact columns and omits full-only columns", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A"]);
    });
    const output = logs.join("\n");
    // Compact headers present
    expect(output).toContain("RIG");
    expect(output).toContain("SESSION");
    expect(output).toContain("LIFECYCLE");
    expect(output).toContain("ACTIVITY");
    expect(output).toContain("WORK");
    // Full-only headers absent
    expect(output).not.toContain("CTX");
    expect(output).not.toContain("RESTORE");
    expect(output).not.toContain("RUNTIME");
    expect(output).not.toContain("STARTUP");
    expect(output).not.toContain("TERMINAL");
    expect(output).not.toContain("POD");
    expect(output).not.toContain("MEMBER");
    // All nodes rendered (same breadth)
    expect(output).toContain("orch1-lead@openrig-build");
    expect(output).toContain("dev1-driver@openrig-velocity");
    const assignedLine = output.split("\n").find((line) => line.includes("dev1-design@openrig-build"));
    expect(assignedLine).toBeDefined();
    // WORK begins after the fixed RIG/SESSION/LIFECYCLE/ACTIVITY columns.
    // It renders the total active assignment count (6), never the pending-only count (3).
    expect(assignedLine!.slice(22 + 38 + 11 + 14, 22 + 38 + 11 + 14 + 6).trim()).toBe("6");
  });

  it("--full human table uses full-detail columns", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "ps", "--nodes", "-A", "--full"]);
    });
    const output = logs.join("\n");
    // Full headers present
    expect(output).toContain("CTX");
    expect(output).toContain("RESTORE");
    expect(output).toContain("RUNTIME");
    expect(output).toContain("STARTUP");
    expect(output).toContain("TERMINAL");
    expect(output).toContain("POD");
    expect(output).toContain("MEMBER");
    const assignedLine = output.split("\n").find((line) => line.includes("dev1-design@openrig-build"));
    expect(assignedLine).toBeDefined();
    // WORK begins after the fixed columns through TERMINAL in the full table.
    expect(assignedLine!.slice(30 + 10 + 14 + 34 + 12 + 17 + 10 + 10 + 9 + 11 + 9,
      30 + 10 + 14 + 34 + 12 + 17 + 10 + 10 + 9 + 11 + 9 + 6).trim()).toBe("6");
  });
});
