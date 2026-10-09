import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { renderScreen } from "../src/render.js";
import { createViewState, emptySnapshot } from "../src/state.js";

// fixture 镜像 5f3b5bd4（Phase-2 端点形状普查）亲手追踪的服务形状：
// 真字段名、真枚举值、真证据
// 串——fixture 真实性才是重点（纯文本 stub 会假绿）。

const FIXTURES: Record<string, unknown> = {
  "/healthz": { ok: true, selfHostId: "mm2-openrig1" },
  "/api/health?limit=200": {
    schema: "openrig.health-list/v0alpha1",
    evaluatedAt: "2026-09-05T12:00:00.000Z",
    total: 1,
    limit: 200,
    truncated: false,
    records: [{
      schema: "openrig.health/v0alpha1",
      id: "health-context-dev-impl",
      detector: "context.pressure",
      category: "context",
      scope: { type: "seat", rigId: "01JRIG", seatId: "01JNODEIMPL" },
      severity: "warning",
      confidence: "high",
      status: "active",
      startedAt: "2026-09-05T11:50:00.000Z",
      lastObservedAt: "2026-09-05T11:59:00.000Z",
      window: { source: "context-usage", startedAt: "2026-09-04T12:00:00.000Z", endedAt: "2026-09-05T12:00:00.000Z", limit: 3, retentionSeconds: 86400 },
      freshness: { state: "fresh", evaluatedAt: "2026-09-05T12:00:00.000Z", newestSourceAt: "2026-09-05T11:59:00.000Z", maxAgeSeconds: 600, ageSeconds: 60 },
      summary: "Seat context utilization reached 96%.",
      evidence: [{ type: "context-usage", sourceOrder: 0, observedAt: "2026-09-05T11:59:00.000Z", nodeId: "01JNODEIMPL", sessionId: "session-1", usedPercentage: 96, available: true, fresh: true }],
      threshold: "fresh context utilization >= 95% (critical at >= 99%)",
      explanation: "The latest sample reports 96% utilization.",
      suggestedInspection: "Inspect the seat's context source, recency, and continuity state.",
      indeterminateReason: null,
    }],
  },
  "/api/rigs/summary": [
    { id: "01JRIG", name: "myrig", nodeCount: 4, hasServices: false, latestSnapshotAt: null, latestSnapshotId: null, archivedAt: null, lifecycleState: "running" },
    { id: "01JDOWN", name: "downrig", nodeCount: 2, hasServices: false, latestSnapshotAt: null, latestSnapshotId: null, archivedAt: null, lifecycleState: "recoverable" },
  ],
  "/api/rigs/01JDOWN/nodes": [],
  "/api/rigs/01JDOWN/spec.json": { schemaVersion: 1, name: "downrig", version: "0.1.0", nodes: [], edges: [] },
  "/api/rigs/01JDOWN/status": {
    rigId: "01JDOWN", rigName: "downrig", isKernel: false, status: "down", seatsTotal: 2, seatsRunning: 0,
    recoverable: true, perSeat: [], src: ["ps: 0/2 running · lifecycle=recoverable"],
  },
  "/api/specs/library/a1/review": {
    sourceState: "library_item", kind: "rig", name: "myrig", version: "0.2",
    format: "pod_aware",
    pods: [{
      id: "dev", label: "Development",
      members: [
        { id: "impl", agentRef: "local:../../../agents/development/implementer", runtime: "codex", profile: "default" },
        { id: "qa", agentRef: "qa-agent", runtime: "codex", profile: "default" },
      ],
      edges: [{ from: "impl", to: "qa", kind: "delegates_to" }],
    }],
    edges: [{ from: "dev.impl", to: "review.r1", kind: "collaborates_with" }],
    graph: { nodes: [], edges: [] }, raw: "name: myrig",
    libraryEntryId: "a1", sourcePath: "/s/rig.yaml",
  },
  "/api/specs/library/a2/review": {
    sourceState: "library_item", kind: "agent", name: "implementer", version: "0.1.0",
    description: "Implements locked slices",
    profiles: [{ name: "default" }],
    resources: { skills: [], guidance: ["guidance.md"], plugins: ["openrig-core"], subagents: ["reviewer"] },
    startup: { files: [{ path: "STARTUP.md", required: true }], actions: [] },
    raw: [
      "name: implementer",
      "defaults:",
      "  runtime: claude-code",
      "profiles:",
      "  default:",
      "    uses:",
      "      skills: [using-superpowers, tdd]",
    ].join("\n"),
  },
  "/api/rigs/01JRIG/nodes": [
    {
      nodeId: "01JNODEIMPL", rigId: "01JRIG", rigName: "myrig", logicalId: "dev.impl", podId: "01JPOD", podNamespace: "dev",
      role: "implementer", canonicalSessionName: "dev-impl@myrig", nodeKind: "agent", runtime: "claude-code",
      sessionStatus: "running", startupStatus: "ready", restoreOutcome: "resumed", oriented: "verified",
      terminalActive: false, lastActivityAt: "2026-08-02T09:15:00.000Z",
      lifecycleState: "running", occupantLifecycle: "active", continuityOutcome: null, handoverResult: null,
      previousOccupant: null, handoverAt: null, tmuxAttachCommand: null, resumeCommand: null,
      recoveryGuidance: null, latestError: null, model: null, agentRef: "implementer", profile: "default",
      resolvedSpecName: "implementer", resolvedSpecVersion: "0.1.0", resolvedSpecHash: "ab12", cwd: "/repo",
      restorePolicy: "resume_if_possible", resumeType: "native", resumeToken: "sess-abc", startupCompletedAt: null,
      contextUsage: { availability: "known", reason: null, source: "claude_statusline_json", usedPercentage: 42.5, remainingPercentage: 57.5, contextWindowSize: 200000, totalInputTokens: 120345, totalOutputTokens: 8422, currentUsage: null, transcriptPath: null, sessionId: null, sessionName: null, sampledAt: null, fresh: true },
      hasAssignedWork: true, pendingWorkCount: 2,
    },
    {
      nodeId: "01JNODEQA", rigId: "01JRIG", rigName: "myrig", logicalId: "dev.qa", podId: "01JPOD", podNamespace: "dev",
      role: "qa", canonicalSessionName: "dev-qa@myrig", nodeKind: "agent", runtime: "codex",
      sessionStatus: null, startupStatus: null, restoreOutcome: "n-a", oriented: "n-a",
      terminalActive: null, lastActivityAt: null,
      lifecycleState: "detached", occupantLifecycle: "unknown", continuityOutcome: null, handoverResult: null,
      previousOccupant: null, handoverAt: null, tmuxAttachCommand: null, resumeCommand: null,
      recoveryGuidance: null, latestError: null, model: null, agentRef: "qa", profile: "default",
      resolvedSpecName: "qa-agent", resolvedSpecVersion: null, resolvedSpecHash: null, cwd: null,
      restorePolicy: null, resumeType: null, resumeToken: null, startupCompletedAt: null,
      contextUsage: { availability: "unknown", reason: "missing_sidecar", source: null, usedPercentage: null, remainingPercentage: null, contextWindowSize: null, totalInputTokens: null, totalOutputTokens: null, currentUsage: null, transcriptPath: null, sessionId: null, sessionName: null, sampledAt: null, fresh: false },
      hasAssignedWork: false, pendingWorkCount: 0,
    },
    { rigId: "01JRIG", rigName: "myrig", logicalId: "svc.db", podId: null, podNamespace: null, role: null, canonicalSessionName: null, nodeKind: "infrastructure", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "n-a", oriented: "n-a", lifecycleState: "running", occupantLifecycle: "unknown", continuityOutcome: null, handoverResult: null, previousOccupant: null, handoverAt: null, tmuxAttachCommand: null, resumeCommand: null, recoveryGuidance: null, latestError: null, model: null, agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null, resolvedSpecHash: null, cwd: null, restorePolicy: null, resumeType: null, resumeToken: null, startupCompletedAt: null },
  ],
  // slice-17：topology 视图消费声明的 graph 读——
  // 闭合路由枚举获得该行；下方断言不变
  "/api/rigs/01JRIG/graph": { nodes: [], edges: [] },
  "/api/rigs/01JDOWN/graph": { nodes: [], edges: [] },
  "/api/rigs/01JRIG/spec.json": {
    version: "0.2", name: "myrig",
    pods: [{ id: "dev", label: "Development", members: [{ id: "impl", agentRef: "local:../../../agents/development/implementer", profile: "default", runtime: "claude-code", cwd: "/repo" }, { id: "qa", agentRef: "qa-agent", profile: "default", runtime: "codex", cwd: "/repo" }], edges: [] }],
    edges: [],
  },
  "/api/specs/library": [
    { id: "a1", kind: "rig", name: "myrig", version: "0.2", sourceType: "user_file", sourcePath: "/s/rig.yaml", relativePath: "rig.yaml", updatedAt: "2026-08-01T00:00:00.000Z" },
    { id: "a2", kind: "agent", name: "implementer", version: "0.1.0", sourceType: "builtin", sourcePath: "/s/implementer.yaml", relativePath: "agents/implementer.yaml", updatedAt: "2026-08-01T00:00:00.000Z" },
    { id: "a3", kind: "workflow", name: "conveyor", version: "0.3.0", sourceType: "user_file", sourcePath: "/s/conveyor.yaml", relativePath: "workflows/conveyor.yaml", updatedAt: "2026-08-01T00:00:00.000Z", isBuiltIn: false, rolesCount: 4, stepsCount: 9, status: "valid", errorMessage: null },
  ],
  "/api/review/fleet": {
    scope: "rig",
    needsYou: {
      items: [
        { source: "agent", identity: "qitem-2026080201", summary: "approve slice 11 proof", leg: "human-routed", where: "human@kernel", ageIso: "2026-08-02T08:40:00.000Z", priority: "high", tier: "human-gate", evidenceRef: "proof/qa.md", unblocks: null, qitemId: "qitem-2026080201", destinationSession: "human@kernel", derived: null, hostId: "local" },
        { source: "agent", identity: "qitem-remote", summary: "remote founder gate", leg: "human-routed", where: "human@kernel", ageIso: "2026-08-02T08:41:00.000Z", priority: "high", tier: "human-gate", evidenceRef: null, unblocks: null, qitemId: "qitem-remote", destinationSession: "human@kernel", derived: null, hostId: "mm2-host" },
        { source: "derived", identity: "dev-impl@myrig|stuck|2026-08-02T08:43:00.000Z", summary: "impl looks stuck", leg: "stuck", where: "rig", ageIso: null, priority: null, tier: null, evidenceRef: null, unblocks: null, qitemId: null, destinationSession: null, derived: { kind: "stuck", evidence: "idle 47m >= 30m default · holds 2", threshold: "idle-with-work >= 30m" }, hostId: "local" },
        { source: "derived", identity: "dev-qa@myrig|too-long-in-state|2026-08-02T05:00:00.000Z", summary: "qa has not transitioned in 180m", leg: "stuck", where: "rig", ageIso: null, priority: null, tier: null, evidenceRef: null, unblocks: null, qitemId: null, destinationSession: null, derived: { kind: "stuck", evidence: "no transition for 180m >= 120m default · holds 2", threshold: "too-long-in-state >= 120m" }, hostId: "local" },
      ],
      provenance: "computed from queue+ps (rig scope) · window: today at 2026-08-02T09:30:00.000Z",
    },
    agents: { scope: "rig", rows: [], provenance: "computed", coordinationHealth: null },
    settled: [], settledProvenance: "computed", composedAt: "2026-08-02T09:30:00.000Z",
    hosts: [{ hostId: "local", status: { hostId: "local", status: "ok" } }, { hostId: "mm2-host", status: { hostId: "mm2-host", status: "ok" } }],
  },
  "/api/stream/list?limit=5&direction=latest": [
    { streamItemId: "si-1", tsEmitted: "2026-08-02T10:00:00.000Z", streamSortKey: "k1", sourceSession: "dev-guard@myrig", body: "gate cleared: slice-11", format: "text", hintType: null, hintUrgency: null, hintDestination: null, hintTags: null, interrupt: false, archivedAt: null },
  ],
  "/api/queue/attention-aggregate": {
    items: [],
    hosts: [
      { hostId: "local", status: "ok" },
      { hostId: "mm2-host", status: "unreachable", error: "read timed out after 5000ms", failedStep: "remote-daemon-unreachable" },
    ],
  },
  // PULSE exception join（increment 2）——默认空；各测试响应覆盖
  "/api/queue/list?attention=1": [],

  "/api/scopes?detail=1": { missions: [] },
  "/api/views/execution": { rowCount: 1, rows: [{ view: "execution", mission: "release-0.5.8", q1_lanes: [], q2_sequencing: [], q4_ladder: [], q5_park: [], sources: {} }] },
  "/api/queue/list?state=blocked": [],
  // PULSE ◌ PARKED WITH BATON 源（increment 2b）——in-progress qitems
  "/api/queue/list?state=in-progress": [],
  // PULSE ○ UP NEXT + ✓ JUST FINISHED lane 源（increment 3）——同一 /list 路由
  "/api/queue/list?state=pending&limit=50": [],
  "/api/queue/list?state=done,handed-off&limit=20": [],
  "/api/queue/recent-transitions?scope=rig&rig=myrig&limit=20": [],
};

function fixtureClient(overrides: Record<string, { status: number } | undefined> = {}, responses: Record<string, unknown> = {}): DaemonClient {
  const fetchImpl = (async (url: unknown) => {
    const route = String(url).replace("http://x", "");
    const failure = overrides[route];
    if (failure) return { ok: false, status: failure.status, json: async () => ({}) } as Response;
    if (route in responses) return { ok: true, json: async () => responses[route] } as Response;
    if (!(route in FIXTURES)) throw new Error(`unexpected route in test: ${route}`);
    return { ok: true, json: async () => FIXTURES[route] } as Response;
  }) as typeof fetch;
  return new DaemonClient({ baseUrl: "http://x", fetchImpl });
}

function expectIncompleteNeedsTruth(snap: Awaited<ReturnType<typeof hydrateSnapshot>>): void {
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  view.dispatch({ type: "jump", section: "needs" });
  const text = renderScreen(view.get(), snap, { cols: 140, rows: 34 }).lines.join("\n");
  // 旧式 fleet 读不能替代专用的 Attention 权威。
  expect(text).toContain("不可用: 待关注源尚未应答。");
  expect(text).not.toContain("(read pending)");
  expect(text).not.toContain("no fleet attention items right now");
}

describe("基于 §4.A 读取的快照 hydration（Phase 2）", () => {
  it("经既有通用视图路由 hydration execution projection", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.execution).toMatchObject({ view: "execution", mission: "release-0.5.8" });
  });
  it("hydrate 有界 canonical health projection 与稳定 node join", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect((snap as unknown as { health: unknown }).health).toMatchObject({
      availability: "loaded",
      total: 1,
      truncated: false,
      records: [{ id: "health-context-dev-impl", scope: { seatId: "01JNODEIMPL" } }],
    });
    expect(snap.hosts[0]?.rigs[0]?.pods[0]?.agents[0]).toMatchObject({ nodeId: "01JNODEIMPL" });
  });
  it("请求当前所选 mission，而非复用 daemon 默认", async () => {
    const mission = "release-next";
    const route = `/api/views/execution?mission=${mission}`;
    const snap = await hydrateSnapshot(fixtureClient({}, {
      [route]: { rowCount: 1, rows: [{ view: "execution", mission, q1_lanes: [], q2_sequencing: [], q4_ladder: [], q5_park: [], sources: {} }] },
    }), undefined, mission);
    expect(snap.execution).toMatchObject({ view: "execution", mission });
    expect(snap.executionMission).toBe(mission);
  });
  it("仅对所选 slice 目录 hydration 既有丰富 slice 详情", async () => {
    const slice = "11-production-tui-composed-system";
    const route = `/api/slices/${slice}`;
    const detail = {
      name: slice,
      status: "active",
      rawStatus: "building",
      qitemIds: ["qitem-s11"],
      commitRefs: ["5f7bc3c2c"],
      lastActivityAt: "2026-09-03T22:20:25.862Z",
      story: { events: [] },
      decisions: { rows: [] },
    };
    const snap = await hydrateSnapshot(fixtureClient({}, { [route]: detail }), undefined, "release-0.5.9", slice);
    expect(snap.sliceDetail).toEqual(detail);
    expect(snap.sliceDetailName).toBe(slice);
  });
  it("映射 topology：pod 分组，agent 行逐字取自维护的 projection (PIN 2)", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    const local = snap.hosts.find((h) => h.id === "local");
    expect(local?.rigs[0]?.name).toBe("myrig");
    const dev = local?.rigs[0]?.pods.find((p) => p.name === "dev");
    expect(dev?.agents.map((a) => a.name)).toEqual(["dev.impl", "dev.qa"]);
    const impl = dev?.agents[0];
    expect(impl).toMatchObject({
      runtime: "claude-code", spec: "implementer", context: 43, tokens: "129k", status: "idle", canRun: false,
      contextWindowSize: 200000, totalInputTokens: 120345, totalOutputTokens: 8422,
      hasAssignedWork: true, pendingWorkCount: 2,
    });
    // 诚实未知：availability "unknown" → null 格；lifecycleState 逐字
    const qa = dev?.agents[1];
    expect(qa).toMatchObject({ context: null, tokens: null, status: "unknown", canRun: true });
    // 基础设施节点不是 agent 行
    expect(local?.rigs[0]?.pods.flatMap((p) => p.agents.map((a) => a.name))).not.toContain("svc.db");
  });

  it("保持两条 stuck 腿区分——served evidence/threshold 字符串逐字，无客户端 threshold", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    const stuck = snap.needs.filter((n) => n.kind === "stuck");
    expect(stuck).toHaveLength(2);
    expect(stuck[0]).toMatchObject({ target: "dev-impl@myrig", hostId: "local" });
    expect(stuck[0]?.detail).toContain("idle 47m >= 30m default");
    expect(stuck[1]?.target).toBe("dev-qa@myrig");
    expect(stuck[1]?.detail).toContain("no transition for 180m >= 120m default");
  });

  it("把 host-down 与 rig-down 组合在 items 旁，绝不并入 item 形状 (PIN 3)", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.hostsDown).toEqual([
      { hostId: "mm2-host", status: "unreachable", error: "read timed out after 5000ms" },
      { hostId: "rig:downrig", status: "recoverable (down)", error: "0/2 个席位运行中" },
    ]);
    expect(snap.needs.some((n) => n.target === "mm2-host" || n.target.includes("downrig"))).toBe(false);
    // 且不可达主机以诚实可达性出现在 topology
    expect(snap.hosts.find((h) => h.name === "mm2-host")?.reachable).toBe(false);
    // 未运行 rig 逐字携带其服务 lifecycleState（QA blocker 3）
    expect(snap.hosts.find((h) => h.id === "local")?.rigs.find((r) => r.name === "downrig")?.lifecycleState).toBe("recoverable");
  });

  it("从 LIVE /:id/review 路由 hydration agent-spec 结构化详情 (QA blocker 2)", async () => {
    const cache = new Map();
    const snap = await hydrateSnapshot(fixtureClient(), cache);
    const impl = snap.specs.find((s) => s.name === "implementer");
    expect(impl).toMatchObject({
      version: "0.1.0",
      sourcePath: "/s/implementer.yaml",
      description: "Implements locked slices",
      runtime: "claude-code",
      skills: ["using-superpowers", "tdd"],
      hasGuidance: true,
      startupFiles: [{ path: "STARTUP.md", required: true }],
      profiles: ["default"],
      resources: {
        skills: [],
        guidance: ["guidance.md"],
        plugins: ["openrig-core"],
        subagents: ["reviewer"],
      },
    });
    expect(cache.size).toBe(2); // rig + agent reviews memoized by id@updatedAt
  });

  it("从 LIVE /:id/review 路由 hydration 锁定的 rig-spec 结构与库来源", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.specs.find((s) => s.name === "myrig")).toMatchObject({
      sourceState: "library_item",
      sourceType: "user_file",
      sourcePath: "/s/rig.yaml",
      relativePath: "rig.yaml",
      format: "pod_aware",
      pods: [{
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", agentRef: "implementer", runtime: "codex", profile: "default" },
          { id: "qa", agentRef: "qa-agent", runtime: "codex", profile: "default" },
        ],
        edges: [{ from: "impl", to: "qa", kind: "delegates_to" }],
      }],
      edges: [{ from: "dev.impl", to: "review.r1", kind: "collaborates_with" }],
    });
  });

  it("映射 human-queue 腿并标为 PROBED（proven-empty vs not-yet-known）", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.humanQueueProbed).toBe(true);
    expect(snap.needs.filter((item) => item.source === "agent")).toEqual([
      { source: "agent", kind: "human-routed", target: "human@kernel", detail: "approve slice 11 proof", hostId: "local", qitemId: "qitem-2026080201", evidenceRef: "proof/qa.md", unblocks: null },
      { source: "agent", kind: "human-routed", target: "human@kernel", detail: "remote founder gate", hostId: "mm2-host", qitemId: "qitem-remote", evidenceRef: null, unblocks: null },
    ]);
  });

  it("跨 agent 与派生源保留 daemon 的 fleet-wide Needs 优先级顺序", async () => {
    const ordered = [
      { source: "derived", identity: "urgent@rig|stuck|1", summary: "urgent derived", leg: "stuck", where: "rig", priority: "urgent", derived: { kind: "stuck", evidence: "urgent evidence" }, hostId: "local" },
      { source: "agent", identity: "q-high", summary: "high human", leg: "human-routed", where: "human@kernel", priority: "high", destinationSession: "human@kernel", derived: null, hostId: "local" },
      { source: "derived", identity: "normal@rig|stuck|2", summary: "normal derived", leg: "stuck", where: "rig", priority: "normal", derived: { kind: "stuck", evidence: "normal evidence" }, hostId: "local" },
      { source: "agent", identity: "q-low", summary: "low human", leg: "human-routed", where: "human@kernel", priority: "low", destinationSession: "human@kernel", derived: null, hostId: "local" },
    ];
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/review/fleet": {
        needsYou: { items: ordered },
        hosts: [{ hostId: "local", status: { hostId: "local", status: "ok" } }],
      },
    }));

    expect(snap.needs.map((item) => [item.source, item.detail.split(" — ")[0]])).toEqual([
      ["derived", "urgent derived"],
      ["agent", "high human"],
      ["derived", "normal derived"],
      ["agent", "low human"],
    ]);
  });

  it("保留遗留 fleet 优先级数据，但不替代 Attention 权威", async () => {
    const items = [
      { source: "agent", identity: "q-high", summary: "HIGH HUMAN APPROVAL", leg: "human-routed", where: "human@kernel", priority: "high", destinationSession: "human@kernel", derived: null, hostId: "local" },
      ...Array.from({ length: 30 }, (_, index) => ({
        source: "derived", identity: `normal-${index}@rig|stuck|${index}`, summary: `normal exception ${index}`, leg: "stuck", where: "rig", priority: "normal",
        derived: { kind: "stuck", evidence: `normal evidence ${index}` }, hostId: "local",
      })),
    ];
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/review/fleet": {
        needsYou: { items },
        hosts: [{ hostId: "local", status: { hostId: "local", status: "ok" } }],
      },
    }));
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });

    expect(snap.needs[0]?.detail).toContain("HIGH HUMAN APPROVAL");
    const text = screen.lines.join("\n");
    expect(text).toContain("不可用: 待关注");
    expect(text).not.toContain("HIGH HUMAN APPROVAL");
    expect(text).not.toContain("normal exception 0");
  });

  it("任一远程 host 缺失时把 fleet attention 标为不完整，绝不 proven-empty", async () => {
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/review/fleet": {
        needsYou: { items: [] },
        hosts: [
          { hostId: "local", status: { hostId: "local", status: "ok" } },
          { hostId: "mm2-host", status: { hostId: "mm2-host", status: "unreachable" } },
        ],
      },
    }));
    expect(snap.humanQueueProbed).toBe(false);
    expect(snap.needs).toEqual([]);
    expectIncompleteNeedsTruth(snap);
  });

  it("把 fleet registry 错误视为具名不完整状态，绝不 proven-empty", async () => {
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/review/fleet": {
        needsYou: { items: [] },
        hosts: [{ hostId: "local", status: { hostId: "local", status: "ok" } }],
        registryError: "failed to parse hosts.yaml",
      },
    }));
    expect(snap.humanQueueProbed).toBe(false);
    expect(snap.readErrors).toContain("review-fleet registry: failed to parse hosts.yaml");
    expectIncompleteNeedsTruth(snap);
  });

  it("让 failed、attention、needs-input 真相优先于 terminal active/idle", async () => {
    const base = (FIXTURES["/api/rigs/01JRIG/nodes"] as Array<Record<string, unknown>>)[0]!;
    const nodes = [
      { ...base, logicalId: "dev.failed", startupStatus: "failed", lifecycleState: "attention_required", terminalActive: true },
      { ...base, logicalId: "dev.attention", startupStatus: "attention_required", lifecycleState: "attention_required", terminalActive: false },
      { ...base, logicalId: "dev.input", startupStatus: "ready", agentActivity: { state: "needs_input" }, terminalActive: true },
      { ...base, logicalId: "dev.active", startupStatus: "ready", agentActivity: { state: "running" }, terminalActive: true },
      { ...base, logicalId: "dev.mismatch", startupStatus: "ready", lifecycleState: "attention_required", agentActivity: { state: "running" }, terminalActive: true, identityVerdict: { verdict: "mismatch" } },
      { ...base, logicalId: "dev.missing", startupStatus: "ready", lifecycleState: "attention_required", agentActivity: { state: "running" }, terminalActive: true, identityVerdict: { verdict: "pane_missing" } },
    ];
    const snap = await hydrateSnapshot(fixtureClient({}, { "/api/rigs/01JRIG/nodes": nodes }));
    const statuses = Object.fromEntries(snap.hosts[0]!.rigs[0]!.pods[0]!.agents.map((agent) => [agent.name, agent.status]));
    expect(statuses).toEqual({
      "dev.failed": "failed",
      "dev.attention": "attention_required",
      "dev.input": "needs_input",
      "dev.active": "active",
      "dev.mismatch": "attention_required",
      "dev.missing": "attention_required",
    });
    const byName = Object.fromEntries(snap.hosts[0]!.rigs[0]!.pods[0]!.agents.map((agent) => [agent.name, agent]));
    expect(byName["dev.mismatch"]?.canRun).toBe(false);
    expect(byName["dev.missing"]?.canRun).toBe(false);
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "myrig" });
    const output = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    for (const name of ["dev.mismatch", "dev.missing"]) {
      const row = output.contentTargets.find((target) =>
        target.action.type === "drill" && target.action.resource === "agent" && target.action.name === name);
      expect(row, name).toBeDefined();
      expect(output.contentTargets.some((target) => target.y === row!.y && target.action.type === "act" && target.action.act === "run"), name).toBe(false);
    }
  });

  it("在既有读取上 join Specs↔Topology：rig agentRefs + agent usedByRigs", async () => {
    const snap = await hydrateSnapshot(fixtureClient());
    expect(snap.specs.find((s) => s.name === "myrig")?.agentRefs).toEqual(["implementer", "qa-agent"]);
    expect(snap.specs.find((s) => s.name === "implementer")?.usedByRigs).toEqual(["myrig"]);
    expect(snap.specs.find((s) => s.name === "conveyor")?.kind).toBe("workflow");
  });

  it("PULSE BLOCKED：经 GET /:qitemId 把 blockedOn（qitem id）解析为 blocker 的 OWNER；human-park 跳过；未命中静默降级", async () => {
    const blockedList = [
      // agent-block：blockedOn 是 qitem 指针 → 解析为 owner
      { qitemId: "b1", state: "blocked", destinationSession: "dev-a@rig", blockedOn: "qitem-blkA", handedOffTo: null, tier: null, tags: null, summary: "等待", body: "", claimedAt: "2026-08-05T09:00:00.000Z", tsUpdated: "2026-08-05T09:00:00.000Z" },
      // human-park：blockedOn 是 SESSION → 不解析（无查找，属 NEEDS YOU 下）
      { qitemId: "b2", state: "blocked", destinationSession: "dev-b@rig", blockedOn: "human-yeah@kernel", handedOffTo: null, tier: null, tags: null, summary: "human", body: "", claimedAt: "2026-08-05T09:00:00.000Z", tsUpdated: "2026-08-05T09:00:00.000Z" },
      // blocker 读 404 的 agent-block → blockerSession null，无 readError（enrichment）
      { qitemId: "b3", state: "blocked", destinationSession: "dev-c@rig", blockedOn: "qitem-gone", handedOffTo: null, tier: null, tags: null, summary: "stale", body: "", claimedAt: "2026-08-05T09:00:00.000Z", tsUpdated: "2026-08-05T09:00:00.000Z" },
    ];
    const snap = await hydrateSnapshot(fixtureClient({ "/api/queue/qitem-gone": { status: 404 } }, {
      "/api/queue/list?state=blocked": blockedList,
      "/api/queue/qitem-blkA": { qitemId: "qitem-blkA", destinationSession: "review-r1@rig", state: "in-progress", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "the blocker", body: "", claimedAt: null, tsUpdated: "2026-08-05T09:00:00.000Z" },
    }));
    const by = Object.fromEntries(snap.blocked.map((q) => [q.qitemId, q]));
    expect(by["b1"]?.blockerSession).toBe("review-r1@rig"); // resolved owner = the blocking agent
    expect(by["b2"]?.blockerSession ?? null).toBeNull();     // human-park not resolved
    expect(by["b3"]?.blockerSession ?? null).toBeNull();     // 404 miss → null (fallback to raw at render)
    // 每行 enrichment 非承重：miss 不得污染 readErrors
    expect(snap.readErrors.filter((e) => e.includes("queue-blocker") || e.includes("qitem-gone"))).toEqual([]);
  });

  it("PULSE PARKED (2b)：从 nodes 读取构建每席 ps/activity（session→terminalActive+lastActivityAt），并携带 in-progress 读取", async () => {
    const inProgress = [
      { qitemId: "qitem-p1", state: "in-progress", destinationSession: "dev-impl@myrig", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "parked?", body: "", claimedAt: "2026-08-02T09:00:00.000Z", tsUpdated: "2026-08-02T09:00:00.000Z" },
    ];
    const snap = await hydrateSnapshot(fixtureClient({}, { "/api/queue/list?state=in-progress": inProgress }));

    // seatActivity：每个带规范 session 的 agent 席一条（svc.db 无
    // → 排除）。lastActivityAt 逐字携带；terminalActive 逐字。
    const bySession = Object.fromEntries(snap.seatActivity.map((s) => [s.session, s]));
    expect(bySession["dev-impl@myrig"]).toEqual({ session: "dev-impl@myrig", logicalId: "dev.impl", terminalActive: false, lastActivityAt: "2026-08-02T09:15:00.000Z" });
    expect(bySession["dev-qa@myrig"]).toEqual({ session: "dev-qa@myrig", logicalId: "dev.qa", terminalActive: null, lastActivityAt: null });
    expect(snap.seatActivity.some((s) => s.session == null)).toBe(false); // infra seat (no session) excluded

    // 为 PARKED join 带入快照的 in-progress 读
    expect(snap.inProgress.map((q) => q.qitemId)).toEqual(["qitem-p1"]);
    expect(snap.inProgress[0]?.destinationSession).toBe("dev-impl@myrig");
  });

  it("PULSE lanes (incr 3)：携带 pending（UP NEXT）+ done/handed-off（JUST FINISHED）读取并盖 hydratedAt 时间戳", async () => {
    const pending = [
      { qitemId: "qp1", state: "pending", destinationSession: "dev-a@rig", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "next up", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:00:00.000Z" },
    ];
    const finished = [
      { qitemId: "qf1", state: "done", destinationSession: "dev-a@rig", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "closed", body: "", claimedAt: "2026-08-06T10:00:00.000Z", tsUpdated: "2026-08-06T10:30:00.000Z" },
      { qitemId: "qf2", state: "handed-off", destinationSession: "dev-b@rig", blockedOn: null, handedOffTo: "rev@rig", tier: null, tags: null, summary: "passed on", body: "", claimedAt: "2026-08-06T09:00:00.000Z", tsUpdated: "2026-08-06T09:30:00.000Z" },
    ];
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/queue/list?state=pending&limit=50": pending,
      "/api/queue/list?state=done,handed-off&limit=20": finished,
    }));
    expect(snap.pending.map((q) => q.qitemId)).toEqual(["qp1"]);
    expect(snap.recentlyFinished.map((q) => q.qitemId)).toEqual(["qf1", "qf2"]);
    // hydratedAt 是 TUI 自己的渲染时完成戳（非 daemon 读）——合法 ISO
    expect(snap.hydratedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(snap.hydratedAt!))).toBe(false);
  });

  it("让失败读取保持诚实空态并带具名错误；其他区段仍 hydration", async () => {
    const snap = await hydrateSnapshot(fixtureClient({ "/api/review/fleet": { status: 503 } }));
    expect(snap.humanQueueProbed).toBe(false);
    expect(snap.needs).toEqual([]);
    expect(snap.readErrors).toEqual([expect.stringMatching(/review-fleet: .*503/)]);
    expect(snap.hosts.find((h) => h.id === "local")?.rigs[0]?.name).toBe("myrig");
    expectIncompleteNeedsTruth(snap);
  });

  it("config 读取失败呈现中文显示标签；旧英文读取标签不得回归", async () => {
    // CONFIG 分支的命名 readError 是纯展示文案（无 startsWith 路由匹配），
    // 中文化后应为中文 label；机器路由前缀（execution:/nodes(/rigs-summary:）不在此分支，保持原值。
    const view = createViewState({ instanceId: "t", getSnapshot: () => emptySnapshot() });
    view.dispatch({ type: "jump", section: "config" });
    const snap = await hydrateSnapshot(fixtureClient({ "/api/gateway/connections": { status: 503 } }, {
      // configBrowser 需完整浏览器契约（readOnly + entries/sources/exclusions），否则
      // 会另抛"配置读取"错误；这里让它成功，从而把 readError 隔离成仅 Slack 连接故障。
      "/api/config?view=browser": { readOnly: true, groups: [], entries: [], sources: [], exclusions: [] },
    }), undefined, null, null, null, view.get());
    expect(snap.readErrors.some((e) => e.startsWith("Slack 连接观察: 不可用"))).toBe(true);
    expect(snap.readErrors.some((e) => e.startsWith("Slack observation"))).toBe(false);
    expect(snap.readErrors.filter((e) => e.includes("不可用"))).toHaveLength(1);
  });
});

describe("经有界 latest-active projection 的 footer 流尾", () => {
  function streamClient(responses: unknown[][]): DaemonClient {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const route = String(url).replace("http://x", "");
      calls.push(route);
      if (route.startsWith("/api/stream/list")) {
        return { ok: true, json: async () => responses.shift() ?? [] } as Response;
      }
      if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
      return { ok: true, json: async () => [] } as Response;
    }) as typeof fetch;
    const client = new DaemonClient({ baseUrl: "http://x", fetchImpl });
    return Object.assign(client, { __calls: calls });
  }

  const item = (n: number) => ({
    streamItemId: `si-${n}`, tsEmitted: `2026-08-03T07:${String(n % 60).padStart(2, "0")}:00.000Z`,
    streamSortKey: `k${String(n).padStart(4, "0")}`, sourceSession: "qa@rig", body: `item-${n}`,
    format: "text", hintType: null, hintUrgency: null, hintDestination: null, hintTags: null, interrupt: false, archivedAt: null,
  });

  it("超上限：6 个未归档项时 ticker 显示第 6 个（QA 确切复现形状）", async () => {
    const six = Array.from({ length: 6 }, (_, i) => item(i + 1));
    const client = streamClient([six.slice(-5)]);
    const snap = await hydrateSnapshot(client, new Map());
    expect(snap.stream.at(-1)?.body).toBe("item-6");
    expect((client as unknown as { __calls: string[] }).__calls.filter((route) => route.startsWith("/api/stream/list"))).toEqual([
      "/api/stream/list?limit=5&direction=latest",
    ]);
  });

  it("archive 真相在下次刷新即替换缓存的最新行", async () => {
    const client = streamClient([[item(1), item(2)], [item(1)]]);
    const first = await hydrateSnapshot(client, new Map());
    const afterArchive = await hydrateSnapshot(client, new Map());
    expect(first.stream.at(-1)?.body).toBe("item-2");
    expect(afterArchive.stream.at(-1)?.body).toBe("item-1");
  });

  it("空流与失败最新读取保持诚实，不复用陈旧行", async () => {
    const empty = streamClient([[]]);
    const snap = await hydrateSnapshot(empty, new Map());
    expect(snap.stream).toEqual([]);

    const failing = new DaemonClient({
      baseUrl: "http://x",
      fetchImpl: (async (url: unknown) => {
        const route = String(url).replace("http://x", "");
        if (route.startsWith("/api/stream/list")) return { ok: false, status: 503, json: async () => ({}) } as Response;
        if (route in FIXTURES) return { ok: true, json: async () => FIXTURES[route] } as Response;
        return { ok: true, json: async () => [] } as Response;
      }) as typeof fetch,
    });
    const snap2 = await hydrateSnapshot(failing, new Map());
    expect(snap2.stream).toEqual([]);
    expect(snap2.readErrors.some((e) => e.startsWith("stream-tail"))).toBe(true);
  });

  it("即使源总能再追加整页，一次有界读取也完成", async () => {
    let calls = 0;
    const client = streamClient([Array.from({ length: 5 }, (_, index) => item(index + 10))]);
    const original = (client as unknown as { __calls: string[] }).__calls;
    const snap = await hydrateSnapshot(client, new Map());
    calls = original.filter((route) => route.startsWith("/api/stream/list")).length;
    expect(calls).toBe(1);
    expect(snap.stream.at(-1)?.body).toBe("item-14");
  });

  it("并发 hydration 无共享游标，且不报虚假的无进展错误", async () => {
    const client = streamClient([[item(1)], [item(2)]]);
    const [first, second] = await Promise.all([
      hydrateSnapshot(client, new Map()),
      hydrateSnapshot(client, new Map()),
    ]);
    expect([first.stream.at(-1)?.body, second.stream.at(-1)?.body].sort()).toEqual(["item-1", "item-2"]);
    expect([...first.readErrors, ...second.readErrors].filter((error) => error.startsWith("stream-tail"))).toEqual([]);
  });
});

describe("S05 authored 源与观测到的消费者", () => {
  it("把 shipped first-project 摘要显示为其目的", async () => {
    const raw = readFileSync(new URL("../../daemon/specs/rigs/launch/first-project/rig.yaml", import.meta.url), "utf8");
    const { summary } = parseYaml(raw) as { summary: string };
    expect(summary).toContain("两个 Codex 席位");
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/specs/library/a1/review": { ...(FIXTURES["/api/specs/library/a1/review"] as object), raw },
    }));
    expect(snap.specs.find((s) => s.name === "myrig")!.description).toBe(summary);
  });

  it.each([
    ["summary: Rig purpose\ndescription: Old purpose\nmetadata:\n  description: Older purpose", "Rig purpose"],
    ["description: Legacy purpose\nmetadata:\n  description: Older purpose", "Legacy purpose"],
    ["metadata:\n  description: Metadata purpose", "Metadata purpose"],
    ["summary: '  '\ndescription: Legacy purpose", "Legacy purpose"],
    ["summary: 123\ndescription: Legacy purpose", "Legacy purpose"],
    ["name: myrig", undefined],
    ["summary: '  '", undefined],
  ])("keeps authored purpose precedence and absence honest: %s", async (raw, expected) => {
    const snap = await hydrateSnapshot(fixtureClient({}, {
      "/api/specs/library/a1/review": { ...(FIXTURES["/api/specs/library/a1/review"] as object), raw },
    }));
    expect(snap.specs.find((s) => s.name === "myrig")!.description).toBe(expected);
  });

  it("把 library 声明与 served rig/seat 消费者分离", async () => {
    const snap = await hydrateSnapshot(fixtureClient({}, { "/api/specs/library/a1/review": { ...(FIXTURES["/api/specs/library/a1/review"] as object), raw: "name: myrig\ndescription: Build and review software" } }));
    const rig = snap.specs.find((s) => s.name === "myrig")!;
    expect(rig.description).toBe("Build and review software");
    expect(rig.consumers).toContainEqual(expect.objectContaining({ rig: "myrig", host: "mm2-openrig1" }));
    const agent = snap.specs.find((s) => s.name === "implementer")!;
    expect(agent.consumers).toEqual([expect.objectContaining({ agent: "dev.impl", rig: "myrig", runtime: "claude-code" })]);
    const view = createViewState({ instanceId: "proof", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "specs" });
    view.dispatch({ type: "filter", text: "implementer" });
    view.dispatch({ type: "drill", resource: "spec", name: "implementer" });
    view.dispatch({ type: "layout", contentMaxOffset: 60, contentTargetCount: 2 });
    view.dispatch({ type: "content-scroll", delta: 6 });
    const origin = view.get();
    view.dispatch({ type: "drill", resource: "agent", name: "dev.impl", target: { host: "mm2-openrig1", rig: "myrig" } });
    expect(view.get().lastError).toBeNull();
    expect(view.get().filter).toBe("");
    view.dispatch({ type: "back" });
    expect(view.get()).toMatchObject({ drill: origin.drill, filter: "implementer", contentOffset: 6, viewTab: origin.viewTab });
  });

  it("即使同一 library revision 也刷新所选文件，且不把后续失败藏在缓存后", async () => {
    const cache = new Map();
    const context = { section: "specs", viewTab: "configuration" as const, drill: [{ kind: "spec" as const, name: "myrig" }] };
    await hydrateSnapshot(fixtureClient(), cache, undefined, undefined, undefined, context);
    const changed = await hydrateSnapshot(fixtureClient({}, { "/api/specs/library/a1/review": { ...(FIXTURES["/api/specs/library/a1/review"] as object), raw: "summary: Changed on disk" } }), cache, undefined, undefined, undefined, context);
    expect(changed.specs.find((s) => s.name === "myrig")!.description).toBe("Changed on disk");
    const failed = await hydrateSnapshot(fixtureClient({ "/api/specs/library/a1/review": { status: 404 } }, { "/api/specs/library": [{ ...(FIXTURES["/api/specs/library"] as object[])[0], summary: "Stale index purpose" }] }), cache, undefined, undefined, undefined, context);
    const view = createViewState({ instanceId: "proof", getSnapshot: () => failed });
    view.dispatch({ type: "drill", resource: "spec", name: "myrig" });
    const screen = renderScreen(view.get(), failed, { cols: 90, rows: 40 });
    const body = screen.lines.join("\n");
    expect(body).toContain("源不可用");
    expect(body).not.toContain("Stale index purpose");
    expect(failed.specs.find((s) => s.name === "myrig")!.description).toBeUndefined();
    expect(body).not.toContain("0 个席位");
    expect(body).toContain("观察到的消费者");
    expect(screen.lines.every((line) => line.length <= 90)).toBe(true);
  });
});
