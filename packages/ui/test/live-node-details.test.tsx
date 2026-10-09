import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import { DrawerSelectionContext, type DrawerSelection } from "../src/components/AppShell.js";
import {
  resetTopologyActivityStoreForTests,
  useTopologyActivity,
} from "../src/hooks/useTopologyActivity.js";
import { buildTopologySessionIndex } from "../src/lib/topology-activity.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";

const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;

// V0.3.1 slice 25 —— 席位详情页现已采用“概览 + 详情”双标签布局。
// 本测试针对新结构。
const NODE_DETAIL = {
  rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "dev",
  canonicalSessionName: "dev-impl@test-rig", nodeKind: "agent", runtime: "claude-code",
  sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t dev-impl@test-rig", resumeCommand: null,
  latestError: null, model: "opus", agentRef: "local:agents/impl", profile: "default",
  resolvedSpecName: "impl", resolvedSpecVersion: "1.0.0", cwd: "/workspace",
  startupFiles: [{
    path: "role.md",
    deliveryHint: "guidance_merge",
    required: true,
    absolutePath: "/workspace/specs/agents/impl/guidance/role.md",
  }],
  startupActions: [], recentEvents: [],
  infrastructureStartupCommand: null,
  binding: { tmuxSession: "dev-impl@test-rig" },
  peers: [{ logicalId: "dev.qa", canonicalSessionName: "dev-qa@test-rig", runtime: "codex" }],
  edges: {
    outgoing: [{ kind: "delegates_to", to: { logicalId: "dev.qa", sessionName: "dev-qa@test-rig" } }],
    incoming: [],
  },
  transcript: { enabled: true, path: "/tmp/test.log", tailCommand: "rig transcript dev-impl --tail 100" },
  compactSpec: { name: "impl", version: "1.0.0", profile: "default", skillCount: 2, guidanceCount: 1 },
  agentActivity: {
    state: "running",
    reason: "edit",
    evidenceSource: "runtime_hook",
    sampledAt: "2026-05-04T07:58:31.057Z",
    evidence: "edit",
  },
  currentQitems: [
    {
      qitemId: "qitem-20260504001234-driver",
      bodyExcerpt: "Implement PL-019 edge activity pulse and graph qitem hover.",
      tier: "mode-2",
    },
  ],
  contextUsage: {
    availability: "known",
    usedPercentage: 42,
    remainingPercentage: 58,
    contextWindowSize: 320000,
    sampledAt: "2026-05-04T07:58:31.057Z",
    fresh: true,
    totalInputTokens: 120000,
    totalOutputTokens: 14000,
  },
};

const INFRA_DETAIL = {
  ...NODE_DETAIL, logicalId: "infra.server", nodeKind: "infrastructure", runtime: "terminal",
  agentRef: null, profile: null,
  compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
};

describe("LiveNodeDetails（slice 25 概览 + 详情）", () => {
  beforeEach(() => {
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
    resetTopologyActivityStoreForTests();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (OriginalEventSource) {
      globalThis.EventSource = OriginalEventSource;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).EventSource;
    }
  });

  function mockNodeDetail(detail: Record<string, unknown>) {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/nodes/")) {
        return { ok: true, json: async () => detail };
      }
      // 库调用返回空
      if (typeof url === "string" && url.includes("/api/specs/library")) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
  }

  function renderDetails(logicalId = "dev.impl") {
    return render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-1" logicalId={logicalId} />,
        path: "/test",
      }),
    );
  }

  function renderDetailsWithDrawerSelection(setSelection: (sel: DrawerSelection) => void, logicalId = "dev.impl") {
    return render(
      createTestRouter({
        component: () => (
          <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
            <LiveNodeDetails rigId="rig-1" logicalId={logicalId} />
          </DrawerSelectionContext.Provider>
        ),
        path: "/test",
      }),
    );
  }

  function TopologyActivityWarmup() {
    useTopologyActivity(buildTopologySessionIndex([{
      nodeId: "rig-1::dev.impl",
      rigId: "rig-1",
      rigName: "test-rig",
      logicalId: "dev.impl",
      canonicalSessionName: "dev-impl@test-rig",
    }]));
    return <div data-testid="activity-warmup" />;
  }

  // HG-1 —— 默认标签为概览。
  it("HG-1：进入时默认标签为概览", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();

    const overviewTab = await screen.findByTestId("live-tab-overview");
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("live-overview-section")).toBeDefined();
    // 详情标签存在，但首次绘制时未激活。
    const detailsTab = screen.getByTestId("live-tab-details");
    expect(detailsTab.getAttribute("aria-selected")).toBe("false");
  });

  // HG-7 —— 终端标签不再存在；身份/智能体规格/启动/会话记录标签也不再作为具名标签存在。
  it("HG-7：旧 5 标签结构已移除——仅余概览 + 详情", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("live-tab-overview");

    expect(screen.queryByTestId("live-tab-terminal")).toBeNull();
    expect(screen.queryByTestId("live-tab-identity")).toBeNull();
    expect(screen.queryByTestId("live-tab-agent-spec")).toBeNull();
    expect(screen.queryByTestId("live-tab-startup")).toBeNull();
    expect(screen.queryByTestId("live-tab-transcript")).toBeNull();
    expect(screen.getByTestId("live-tab-overview")).toBeDefined();
    expect(screen.getByTestId("live-tab-details")).toBeDefined();
  });

  // HG-2（follow-on-2）——概览堆叠顺序：通知横幅（可选，仅真实告警）
  // -> 信息表 -> 次区块（cwd + 当前工作）-> 内联终端 -> 最近事件（底部）。
  // LiveNodeCurrentState 已移除。顺序通过始终渲染元素间的
  // compareDocumentPosition 断言。
  it("HG-2：概览标签 DOM 顺序为 通知 -> 表 -> 次区块 -> 终端 -> 最近事件", async () => {
    // 注入一个能浮现通知横幅的 startupStatus，使断言覆盖完整 5 元素顺序。
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "attention_required",
      latestError: "synthetic attention",
      recentEvents: [
        { type: "agent.activity", createdAt: "2026-05-12T00:00:00Z" },
      ],
    });
    renderDetails();

    const banner = await screen.findByTestId("seat-notification-banner");
    const table = await screen.findByTestId("seat-overview-table");
    const secondary = await screen.findByTestId("seat-overview-secondary");
    const terminal = await screen.findByTestId("live-terminal-shell");
    const events = await screen.findByTestId("live-node-recent-events");

    expect(banner.compareDocumentPosition(table)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(table.compareDocumentPosition(secondary)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(secondary.compareDocumentPosition(terminal)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(terminal.compareDocumentPosition(events)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // LiveNodeCurrentState 不再挂载在概览内（保留 follow-on-1 不变量）。
    expect(screen.queryByTestId("live-node-current-state")).toBeNull();
  });

  // HG-1（follow-on-2）——信息表渲染列头 + 单行数据，共 7 字段。
  // “OVERVIEW”分区头行已移除；列头即首行。
  it("HG-1：信息表渲染列头 + 单行数据（7 字段）；无 OVERVIEW 行", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    const table = await screen.findByTestId("seat-overview-table");

    // 7 个列头
    const headerRow = screen.getByTestId("seat-overview-header-row");
    expect(headerRow).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-runtime")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-model")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-profile")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-spec")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-activity")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-context-percent")).toBeDefined();
    expect(screen.getByTestId("seat-overview-header-total-tokens")).toBeDefined();

    // HG-6（follow-on-2）：列头标签为“令牌数”而非“总令牌数”。
    expect(screen.getByTestId("seat-overview-header-total-tokens").textContent).toBe("令牌数");

    const dataRow = screen.getByTestId("seat-overview-data-row");
    expect(dataRow.getAttribute("data-row-shape")).toBe("data");

    // HG-3（follow-on-2）分区头行已移除——表内没有以
    // “OVERVIEW”/“Overview”为唯一内容的元素。
    const tableText = table.textContent ?? "";
    // 活动列可能显示“active”，但旧分区头是独立 div 文本“Overview”。
    expect(tableText.toLowerCase()).not.toContain("overview");

    // HG-5（follow-on-2）cwd + 当前工作移出表。
    // 列表格内不再有整行宽的行。
    expect(screen.queryByTestId("seat-overview-row-cwd")).toBeNull();
    expect(screen.queryByTestId("seat-overview-row-current-work")).toBeNull();

    // 数据格内容取自 NodeDetailData 字段。
    expect(screen.getByTestId("seat-overview-cell-model").textContent).toContain("opus");
    expect(screen.getByTestId("seat-overview-cell-profile").textContent).toContain("default");
    expect(screen.getByTestId("seat-overview-cell-spec").textContent).toContain("impl@1.0.0");
    expect(screen.getByTestId("seat-overview-cell-context-percent").textContent).toContain("42%");
  });

  // HG-4（follow-on-2）——列格之间的垂直网格线。
  // 除最后一格外每个列格都带 `border-r border-outline-variant`。
  it("HG-4：列格有垂直网格线（列间 border-r）", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    // 列头（7 个中前 6 个带 border-r；最后一个不带）。
    const headers = [
      "runtime",
      "model",
      "profile",
      "spec",
      "activity",
      "context-percent",
    ];
    for (const key of headers) {
      const cell = screen.getByTestId(`seat-overview-header-${key}`);
      expect(cell.className).toContain("border-r");
      expect(cell.className).toContain("border-outline-variant");
    }
    // 最后一个列头（令牌数）——无尾部 border-r。
    expect(screen.getByTestId("seat-overview-header-total-tokens").className).not.toContain("border-r");

    // 数据格同理。
    for (const key of headers) {
      const cell = screen.getByTestId(`seat-overview-cell-${key}`);
      expect(cell.className).toContain("border-r");
      expect(cell.className).toContain("border-outline-variant");
    }
    expect(screen.getByTestId("seat-overview-cell-total-tokens").className).not.toContain("border-r");
  });

  // HG-5（follow-on-2）——cwd + 当前工作移入列表格下方的独立
  // 原语；不是同一表内的 colSpan。
  it("HG-5：cwd + 当前工作渲染在独立原语（seat-overview-secondary）中", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();

    const secondary = await screen.findByTestId("seat-overview-secondary");
    expect(secondary).toBeDefined();
    // 独立原语——与列表格不同。
    const table = screen.getByTestId("seat-overview-table");
    expect(table.contains(secondary)).toBe(false);
    expect(secondary.contains(table)).toBe(false);

    // 次区块内出现各行。
    expect(screen.getByTestId("seat-overview-secondary-row-cwd")).toBeDefined();
    expect(screen.getByTestId("seat-overview-secondary-row-current-work")).toBeDefined();
  });

  // HG-3a —— 活动行经 getActivityState 接到 data.agentActivity
  // （与 LiveNodeCurrentState 用同一 helper；与拓扑基线读取同一来源）。
  // agentActivity.state 为 "running" 时，格子显示标签 "active"，
  // 与拓扑图/表命名一致。
  it("HG-3a：活动行实时接线，state=running 时显示“active”并带微光", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    const cell = screen.getByTestId("seat-overview-cell-activity");
    expect(cell.textContent?.trim()).toContain("活动中");
    const stateEl = screen.getByTestId("seat-overview-activity-state");
    expect(stateEl.getAttribute("data-activity-state")).toBe("active");
    // HG-3c 微光复用：active 时套用 slice-14 的微光类。
    expect(stateEl.className).toContain("topology-table-active-shimmer");
  });

  it("HG-3a：agentActivity.state=idle 时活动行显示“idle”且无微光", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      agentActivity: { ...NODE_DETAIL.agentActivity, state: "idle" },
      currentQitems: [],
    });
    renderDetails();
    await screen.findByTestId("seat-overview-table");
    const cell = screen.getByTestId("seat-overview-cell-activity");
    expect(cell.textContent?.trim()).toContain("idle");
    const stateEl = screen.getByTestId("seat-overview-activity-state");
    expect(stateEl.getAttribute("data-activity-state")).toBe("idle");
    expect(stateEl.className).not.toContain("topology-table-active-shimmer");
  });

  it("HG-3a：席位页在 图/表 -> 席位 导航间复用最近拓扑活动", async () => {
    const warmup = render(<TopologyActivityWarmup />);
    await waitFor(() => {
      expect(instances).toHaveLength(1);
    });

    instances[0]!.simulateMessage(JSON.stringify({
      type: "agent.activity",
      sessionName: "dev-impl@test-rig",
      activity: { state: "running" },
    }));
    warmup.unmount();

    mockNodeDetail({
      ...NODE_DETAIL,
      agentActivity: {
        ...NODE_DETAIL.agentActivity,
        state: "unknown",
        reason: "no_activity_signal",
        fallback: true,
      },
      currentQitems: [],
    });
    renderDetails();
    const stateEl = await screen.findByTestId("seat-overview-activity-state");
    expect(stateEl.textContent).toBe("活动中");
    expect(stateEl.getAttribute("data-activity-state")).toBe("active");
    expect(stateEl.getAttribute("data-activity-source")).toBe("ring");
    expect(stateEl.className).toContain("topology-table-active-shimmer");
  });

  // HG-3b（follow-on-2）——当前工作在行次区块实时接线。
  it("HG-3b：当前工作格实时接线，浮现进行中的 qitem", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-secondary");
    const cell = screen.getByTestId("seat-overview-secondary-cell-current-work");
    expect(cell.textContent).toContain("qitem-20260504001234-driver");
    expect(cell.textContent).toContain("Implement PL-019 edge activity pulse");
  });

  it("HG-3b：无进行中 qitem 时当前工作格显示破折号", async () => {
    mockNodeDetail({ ...NODE_DETAIL, currentQitems: [] });
    renderDetails();
    await screen.findByTestId("seat-overview-secondary");
    const cell = screen.getByTestId("seat-overview-secondary-cell-current-work");
    expect(cell.textContent).toContain("—");
  });

  // HG-3d（follow-on-2）——cwd 在次区块中渲染，行上带截断 + 悬停提示。
  it("HG-3d：cwd 在次区块中渲染，带截断 + 提示", async () => {
    const longCwd = "/Users/example/very/long/workspace/path/that/should/truncate/at/the/end";
    mockNodeDetail({ ...NODE_DETAIL, cwd: longCwd });
    renderDetails();
    const row = await screen.findByTestId("seat-overview-secondary-row-cwd");
    expect(row.getAttribute("title")).toBe(longCwd);
    const cell = screen.getByTestId("seat-overview-secondary-cell-cwd");
    // 该格带 truncate 类，使 cwd 不溢出。
    expect(cell.className).toContain("truncate");
  });

  // HG-4（保留）——模型优雅缺失：列表格显示破折号，而非 "undefined"。
  // 列头行保留；数据行中的模型格承载占位。
  it("HG-4：model 字段缺失时模型格优雅显示破折号", async () => {
    mockNodeDetail({ ...NODE_DETAIL, model: null });
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    // 模型列头仍在。
    expect(screen.getByTestId("seat-overview-header-model")).toBeDefined();
    // 数据格承载占位，而非字面 "undefined"。
    const modelCell = screen.getByTestId("seat-overview-cell-model");
    expect(modelCell).toBeDefined();
    expect(modelCell.textContent).not.toContain("undefined");
    expect(modelCell.textContent).toContain("—");
  });

  // HG-5 —— 黑玻终端内联渲染在概览中（不在独立标签）。终端壳带黑玻
  // chrome 类。OPR.0.4.0.1（二轮 QA 裁定）：内联终端现复用全局 live-terminal
  // 限额下的渐进式 default-static -> 点入转活 ProgressiveTerminal，
  // 故打开时显示静态预览——而非立即常驻的 FocusedTerminal/WebSocket。
  it("HG-5：黑玻终端内联渲染在概览中（渐进 default-static）", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    const terminalShell = await screen.findByTestId("live-terminal-shell");
    expect(terminalShell.className).toContain("bg-stone-950/65");
    // Default-static：ProgressiveTerminal 静态触发器出现……
    await screen.findByTestId("node-detail-terminal-static");
    // ……且打开时未挂载常驻 xterm/WebSocket 终端。
    expect(screen.queryByTestId(`focused-terminal-${NODE_DETAIL.canonicalSessionName}`)).toBeNull();
    // 终端位于概览段落内，而非独立标签体。概览段落包裹它。
    const overview = screen.getByTestId("live-overview-section");
    expect(overview.contains(terminalShell)).toBe(true);
  });

  // HG-6（follow-on）——详情标签重排。新的自上而下顺序：
  // 启动 → 智能体规格 → 边 → 对等 →（上下文用量）→ 会话记录。
  // 通过始终渲染段落 testid 间的 DOM 顺序断言。
  it("HG-6：详情标签顺序为 启动 -> 规格/拓扑（智能体规格 + 边 + 对等）-> 会话记录", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));

    await waitFor(() => {
      expect(screen.getByTestId("live-details-section")).toBeDefined();
    });
    const startup = screen.getByTestId("live-startup-section");
    const agentSpec = screen.getByTestId("live-agent-spec-section");
    const edges = screen.getByTestId("detail-edges");
    const peers = screen.getByTestId("detail-peers");
    const transcript = screen.getByTestId("live-transcript-section");

    expect(startup.compareDocumentPosition(agentSpec)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(agentSpec.compareDocumentPosition(edges)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(edges.compareDocumentPosition(peers)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(peers.compareDocumentPosition(transcript)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // PreviewPane 刻意不在启动段（终端在概览中；保留 slice-25 基线不变量）。
    expect(screen.queryByTestId("live-node-preview")).toBeNull();
  });

  // HG-3（follow-on）——仅当存在活动消息时才渲染通知横幅；否则不渲染。
  it("HG-3：设置了 latestError + attention_required 时渲染通知横幅", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "attention_required",
      latestError: "Synthetic test error.",
      recoveryGuidance: {
        summary: "Synthetic guidance summary.",
        commands: ["rig restore <snap>"],
        notes: [],
      },
    });
    renderDetails();
    const banner = await screen.findByTestId("seat-notification-banner");
    expect(banner.getAttribute("data-startup-status")).toBe("attention_required");
    expect(screen.getByTestId("seat-notification-headline").textContent).toContain("需要关注");
    expect(screen.getByTestId("seat-notification-error").textContent).toContain("Synthetic test error");
    expect(screen.getByTestId("seat-notification-guidance").textContent).toContain("Synthetic guidance summary");
  });

  it("HG-3：无活动消息时不渲染通知横幅", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "ready",
      latestError: null,
      recoveryGuidance: null,
    });
    renderDetails();
    await screen.findByTestId("seat-overview-table");
    expect(screen.queryByTestId("seat-notification-banner")).toBeNull();
  });

  // HG-2（follow-on-2 关键）——仅有通用 recoveryGuidance（无 failed /
  // attention_required / latestError）时不渲染横幅。recoveryGuidance 是恢复
  // 步骤文档，不是告警。follow-on-1 曾仅凭 guidance 触发横幅，导致每个正常席位
  // 都误报；本测试守护这类回归。
  it("HG-2：仅有通用 recoveryGuidance 的正常席位不渲染通知横幅", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "ready",
      latestError: null,
      recoveryGuidance: {
        summary: "Generic recovery guidance documentation.",
        commands: ["rig restore <snap>"],
        notes: [],
      },
    });
    renderDetails();
    await screen.findByTestId("seat-overview-table");
    // 横幅绝不能挂载——仅 recoveryGuidance 不是告警。
    expect(screen.queryByTestId("seat-notification-banner")).toBeNull();
  });

  // HG-2 —— 每种告警触发条件都渲染横幅：
  // startupStatus=failed、startupStatus=attention_required，或
  // latestError 存在（即使 startupStatus 为 "ready"）。
  it("HG-2：startupStatus=failed 时渲染通知横幅", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "failed",
      latestError: null,
      recoveryGuidance: null,
    });
    renderDetails();
    const banner = await screen.findByTestId("seat-notification-banner");
    expect(banner.getAttribute("data-startup-status")).toBe("failed");
    expect(screen.getByTestId("seat-notification-headline").textContent).toContain("启动失败");
  });

  it("HG-2：仅 latestError（无 startupStatus 告警）时渲染通知横幅", async () => {
    mockNodeDetail({
      ...NODE_DETAIL,
      startupStatus: "ready",
      latestError: "Runtime error occurred.",
      recoveryGuidance: null,
    });
    renderDetails();
    const banner = await screen.findByTestId("seat-notification-banner");
    expect(banner.getAttribute("data-startup-status")).toBe("ready");
    expect(screen.getByTestId("seat-notification-headline").textContent).toContain("错误");
    expect(screen.getByTestId("seat-notification-error").textContent).toContain("Runtime error occurred");
  });

  // 基础设施节点仍是同样的 2 标签结构；只是详情内不渲染智能体规格段。
  it("基础设施节点渲染概览 + 详情（详情内无智能体规格卡）", async () => {
    mockNodeDetail(INFRA_DETAIL);
    renderDetails("infra.server");
    await screen.findByTestId("live-tab-overview");
    expect(screen.getByTestId("live-tab-overview")).toBeDefined();
    expect(screen.getByTestId("live-tab-details")).toBeDefined();
    expect(screen.queryByTestId("live-tab-agent-spec")).toBeNull();

    fireEvent.click(screen.getByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("live-details-section")).toBeDefined();
    });
    // 基础设施节点无 live-agent-spec-section。
    expect(screen.queryByTestId("live-agent-spec-section")).toBeNull();
  });

  // 智能体规格不可用场景——切到详情，再分别跑 null 与非本地 agentRef 两种形状。
  it("详情标签：agentRef 为 null 时智能体规格段显示不可用", async () => {
    mockNodeDetail({ ...NODE_DETAIL, agentRef: null });
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-unavailable")).toBeDefined();
    });
  });

  it("详情标签：agentRef 为非本地形式时智能体规格段显示不可用", async () => {
    mockNodeDetail({ ...NODE_DETAIL, agentRef: "remote:agents/impl" });
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-unavailable")).toBeDefined();
    });
  });

  // 启动文件出现在 详情 > 启动 段内。
  it("详情标签：启动段显示启动文件", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("live-startup-section")).toBeDefined();
      expect(screen.getByTestId("live-node-status")).toBeDefined();
      expect(screen.getByText(/role\.md/)).toBeDefined();
    });
  });

  it("详情标签：启动文件触发器串联文件来源，供抽屉加载", async () => {
    const setSelection = vi.fn();
    mockNodeDetail(NODE_DETAIL);
    renderDetailsWithDrawerSelection(setSelection as (sel: DrawerSelection) => void);
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    fireEvent.click(await screen.findByTestId("live-startup-file-trigger-role.md"));

    expect(setSelection).toHaveBeenCalledWith({
      type: "file",
      data: {
        path: "role.md",
        absolutePath: "/workspace/specs/agents/impl/guidance/role.md",
      },
    });
  });

  it("详情标签：会话记录段独占会话记录内容", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    expect(await screen.findByTestId("detail-transcript")).toBeDefined();
  });

  // Slice 3.3 fix-B 保留——详情 > 智能体 规格区内的插件段。
  // 无 batch 1 的构建上渲染空态。
  it("slice 3.3 fix-B 保留：详情标签智能体规格区有插件段", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/nodes/")) {
        return { ok: true, json: async () => NODE_DETAIL };
      }
      if (typeof url === "string" && url === "/api/specs/library?kind=agent") {
        return { ok: true, json: async () => [{ id: "agent-1", kind: "agent", name: "impl", version: "1.0.0", sourceType: "builtin", sourcePath: "/x/agent.yaml", relativePath: "x/agent.yaml" }] };
      }
      if (typeof url === "string" && url.includes("/api/specs/library/agent-1/review")) {
        return { ok: true, json: async () => ({ kind: "agent", name: "impl", version: "1.0.0", raw: "", sourcePath: "/x/agent.yaml", sourceState: "library_item", libraryEntryId: "agent-1", description: null, profiles: [], resources: { plugins: [], skills: [], guidance: [], hooks: [] }, startup: { files: [], actions: [] } }) };
      }
      if (typeof url === "string" && url.startsWith("/api/specs/library")) {
        return { ok: true, json: async () => [] };
      }
      if (typeof url === "string" && url === "/api/plugins") {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    });
    renderDetails();
    fireEvent.click(await screen.findByTestId("live-tab-details"));
    await waitFor(() => {
      expect(screen.getByTestId("live-agent-plugins-section")).toBeDefined();
    });
    expect(screen.getByTestId("agent-plugins-empty")).toBeDefined();
  });

  // PL-019 保留（follow-on-2）——活动呈现在概览信息表（列格）；
  // 当前工作呈现在表下方的次区块。
  it("PL-019 保留：概览呈现活动 + 当前 qitem", async () => {
    mockNodeDetail(NODE_DETAIL);
    renderDetails();
    await screen.findByTestId("seat-overview-table");

    // 活动列格带 active 标签（拓扑命名）。
    expect(screen.getByTestId("seat-overview-cell-activity").textContent?.trim()).toContain("活动中");
    // 次区块中的当前工作格带 qitem + 摘要。
    const cwCell = screen.getByTestId("seat-overview-secondary-cell-current-work");
    expect(cwCell.textContent).toContain("04001234-driver");
    expect(cwCell.textContent).toContain("Implement PL-019 edge activity pulse");
    // LiveNodeCurrentState 卡片已移除（保留不变量）。
    expect(screen.queryByTestId("live-node-current-state")).toBeNull();
  });

  // 恢复动作图标与标签结构无关。
  it("复制恢复命令用恢复动作图标而非运行时标记", async () => {
    mockNodeDetail({ ...NODE_DETAIL, resumeCommand: "rig seat resume dev.impl" });
    renderDetails();
    const resumeButton = await screen.findByTestId("detail-copy-resume");
    expect(resumeButton.textContent).toContain("复制恢复命令");
    expect(resumeButton.textContent).not.toContain("Claude");
    expect(resumeButton.querySelector("svg")).toBeDefined();
  });
});
