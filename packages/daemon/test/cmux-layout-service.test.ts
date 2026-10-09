// 切片 24 检查点 B——CmuxLayoutService。
// 纯算法部分（computeLayout / chunkAgents / orderAgentsFromRigSpec），
// 加上通过模拟 CmuxAdapter 协调的 buildWorkspace。

import { describe, it, expect, vi } from "vitest";
import {
  CmuxLayoutService,
  autoGridCols,
  MAX_COLS,
  MAX_PER_WORKSPACE,
  OP_DELAY_MS,
  FINAL_SETTLE_MS,
  LIST_SURFACES_RETRY_DELAY_MS,
  LIST_SURFACES_MAX_ATTEMPTS,
  EQUALIZE_PASSES,
  EQUALIZE_SETTLE_MS,
} from "../src/domain/cmux-layout-service.js";
import type { CmuxResult } from "../src/adapters/cmux.js";

// 测试注入一个会记录调用的空操作 sleep，因此套件不会真的在操作之间等待 OP_DELAY_MS。
// 注入的 sleep 会记录调用，以便测试断言在正确边界等待了延迟。
function makeSleepRecorder(): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

interface MockAdapterRecord {
  method: string;
  args: unknown[];
}

function makeMockAdapter(overrides: Partial<{
  createWorkspaceFn: (name: string, cwd?: string) => Promise<CmuxResult<string>>;
  splitSurfaceFn: (
    surfaceId: string,
    direction: "left" | "right" | "up" | "down",
    workspaceId?: string,
  ) => Promise<CmuxResult<string>>;
  sendTextFn: (surfaceId: string, text: string, workspaceId?: string) => Promise<CmuxResult<void>>;
  listSurfacesFn: (workspaceId?: string) => Promise<CmuxResult<unknown[]>>;
  closeWorkspaceFn: (workspaceId: string) => Promise<CmuxResult<void>>;
  equalizeSplitsFn: (workspaceId?: string) => Promise<CmuxResult<{ equalized: boolean }>>;
}> = {}): { adapter: { [k: string]: unknown }; calls: MockAdapterRecord[] } {
  const calls: MockAdapterRecord[] = [];
  let surfaceSeq = 0;
  let workspaceSeq = 0;
  const nextSurface = () => `surface:${++surfaceSeq}`;
  const nextWorkspace = () => `workspace:${++workspaceSeq}`;

  const adapter = {
    createWorkspace: vi.fn(async (name: string, cwd?: string) => {
      calls.push({ method: "createWorkspace", args: [name, cwd] });
      return overrides.createWorkspaceFn
        ? overrides.createWorkspaceFn(name, cwd)
        : { ok: true, data: nextWorkspace() };
    }),
    splitSurface: vi.fn(async (surfaceId: string, direction: "left" | "right" | "up" | "down", workspaceId?: string) => {
      calls.push({ method: "splitSurface", args: [surfaceId, direction, workspaceId] });
      return overrides.splitSurfaceFn
        ? overrides.splitSurfaceFn(surfaceId, direction, workspaceId)
        : { ok: true, data: nextSurface() };
    }),
    sendText: vi.fn(async (surfaceId: string, text: string, workspaceId?: string) => {
      calls.push({ method: "sendText", args: [surfaceId, text, workspaceId] });
      return overrides.sendTextFn
        ? overrides.sendTextFn(surfaceId, text, workspaceId)
        : { ok: true, data: undefined };
    }),
    listSurfaces: vi.fn(async (workspaceId?: string) => {
      calls.push({ method: "listSurfaces", args: [workspaceId] });
      return overrides.listSurfacesFn
        ? overrides.listSurfacesFn(workspaceId)
        : { ok: true, data: [{ id: nextSurface(), title: "", type: "terminal" }] };
    }),
    closeWorkspace: vi.fn(async (workspaceId: string) => {
      calls.push({ method: "closeWorkspace", args: [workspaceId] });
      return overrides.closeWorkspaceFn
        ? overrides.closeWorkspaceFn(workspaceId)
        : { ok: true, data: undefined };
    }),
    equalizeSplits: vi.fn(async (workspaceId?: string) => {
      calls.push({ method: "equalizeSplits", args: [workspaceId] });
      return overrides.equalizeSplitsFn
        ? overrides.equalizeSplitsFn(workspaceId)
        : { ok: true, data: { equalized: true } };
    }),
  };

  return { adapter, calls };
}

describe("CmuxLayoutService.computeLayout", () => {
  const cases: Array<[number, number, number, number]> = [
    // [N, rows, cols, blanks]，依据 README 的“布局算法”表格
    [1, 1, 1, 0],
    [2, 1, 2, 0],
    [3, 2, 2, 1],
    [4, 2, 2, 0],
    [5, 3, 2, 1],
    [6, 3, 2, 0],
    [7, 4, 2, 1],
    [8, 4, 2, 0],
    [9, 5, 2, 1],
    [10, 5, 2, 0],
    [11, 6, 2, 1],
    [12, 6, 2, 0],
  ];

  it.each(cases)("N=%i → rows=%i cols=%i blanks=%i", (n, rows, cols, blanks) => {
    const layout = CmuxLayoutService.computeLayout(n);
    expect(layout.rows).toBe(rows);
    expect(layout.cols).toBe(cols);
    expect(layout.blanks).toBe(blanks);
  });

  it("N=0 时抛错", () => {
    expect(() => CmuxLayoutService.computeLayout(0)).toThrow();
  });

  it("N 为负数时抛错", () => {
    expect(() => CmuxLayoutService.computeLayout(-1)).toThrow();
  });

  it("N > MAX_PER_WORKSPACE 时抛错（调用方应先分块）", () => {
    expect(() => CmuxLayoutService.computeLayout(13)).toThrow(/分块/i);
  });
});

describe("CmuxLayoutService.chunkAgents", () => {
  function agents(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `agent-${i + 1}`);
  }

  it("单个 agent → 一个只含一项的分块", () => {
    expect(CmuxLayoutService.chunkAgents(agents(1))).toEqual([["agent-1"]]);
  });

  it("12 个 agent → 一个包含 12 项的分块", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(12));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(12);
  });

  it("13 个 agent → 两个分块（12 + 1）", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(13));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(12);
    expect(chunks[1]).toHaveLength(1);
    expect(chunks[1]![0]).toBe("agent-13");
  });

  it("24 个 agent → 两个分块（12 + 12）", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(24));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(12);
    expect(chunks[1]).toHaveLength(12);
  });

  it("30 个 agent → 三个分块（12 + 12 + 6）", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(30));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(12);
    expect(chunks[1]).toHaveLength(12);
    expect(chunks[2]).toHaveLength(6);
  });

  it("0 个 agent → 空数组（无需构建 workspace）", () => {
    expect(CmuxLayoutService.chunkAgents([])).toEqual([]);
  });

  it("跨分块边界保留输入顺序", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(13));
    expect(chunks[0]![0]).toBe("agent-1");
    expect(chunks[0]![11]).toBe("agent-12");
    expect(chunks[1]![0]).toBe("agent-13");
  });
});

describe("CmuxLayoutService.orderAgentsFromRigSpec", () => {
  it("按 pod 再 member 的顺序返回（跨运行确定一致）", () => {
    const rigSpec = {
      pods: [
        { id: "orch", members: [{ id: "lead" }, { id: "peer" }] },
        { id: "dev", members: [{ id: "impl" }, { id: "qa" }, { id: "design" }] },
      ],
    };
    const ordered = CmuxLayoutService.orderAgentsFromRigSpec(rigSpec);
    expect(ordered).toEqual(["orch.lead", "orch.peer", "dev.impl", "dev.qa", "dev.design"]);
  });

  it("rig 规范为空时返回空数组", () => {
    expect(CmuxLayoutService.orderAgentsFromRigSpec({ pods: [] })).toEqual([]);
  });

  it("支持一个 pod / 一个 member", () => {
    const rigSpec = { pods: [{ id: "solo", members: [{ id: "only" }] }] };
    expect(CmuxLayoutService.orderAgentsFromRigSpec(rigSpec)).toEqual(["solo.only"]);
  });

  it("保留规范中的 pod 顺序（不按字母排序）", () => {
    const rigSpec = {
      pods: [
        { id: "zulu", members: [{ id: "z1" }] },
        { id: "alpha", members: [{ id: "a1" }] },
      ],
    };
    const ordered = CmuxLayoutService.orderAgentsFromRigSpec(rigSpec);
    expect(ordered).toEqual(["zulu.z1", "alpha.a1"]);
  });
});

describe("CmuxLayoutService.buildWorkspacePanes（terminal-provider paneCommand 核心）", () => {
  it("逐字发送每条调用方组合的命令并追加换行（保留只读 -r / ssh 包装）", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspacePanes("openrig:v#l1", undefined, [
      "tmux attach -t 'a@r'",
      "ssh 'user@host' tmux attach -r -t 'b@r'",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.paneCount).toBe(2);
      expect(result.data.blanks).toBe(0);
    }
    const creates = calls.filter((c) => c.method === "createWorkspace");
    expect(creates).toHaveLength(1); // 整个页面只使用一个 workspace
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends.map((s) => s.args[1])).toEqual([
      "tmux attach -t 'a@r'\n",
      "ssh 'user@host' tmux attach -r -t 'b@r'\n",
    ]);
  });

  // PM 裁定：实际应用的网格必须与模态框 Auto-grid 预览一致
  //（TerminalLauncher suggestLayout: cols = ceil(sqrt(N))）。针对验收规模使用直接向量——
  // 固定形状、分割次数、发送次数、均分，以及单个 workspace。
  const commands = (n: number) => Array.from({ length: n }, (_, i) => `cmd-${i + 1}`);
  const gridCases: Array<{
    n: number; cols: number; rights: number; downs: number; equalizes: number; blanks: number;
  }> = [
    // N=2 → 1×2：一次向右分割，不均分（两列已经各占 50%）。
    { n: 2, cols: 2, rights: 1, downs: 0, equalizes: 0, blanks: 0 },
    // N=5 → 2 行 × 3 列：2 次向右 + 3 次向下分割，执行 EQUALIZE_PASSES 次均分。
    { n: 5, cols: 3, rights: 2, downs: 3, equalizes: EQUALIZE_PASSES, blanks: 1 },
    // N=7 → 3×3：2 次向右 + 6 次向下分割，执行 EQUALIZE_PASSES 次均分，2 个空位。
    { n: 7, cols: 3, rights: 2, downs: 6, equalizes: EQUALIZE_PASSES, blanks: 2 },
  ];

  it.each(gridCases)(
    "模态框 Auto-grid N=$n → cols=$cols：$rights 次向右 + $downs 次向下分割，$equalizes 次均分，一个 workspace",
    async ({ n, cols, rights, downs, equalizes, blanks }) => {
      expect(autoGridCols(n)).toBe(cols); // daemon 对 suggestLayout 的镜像实现
      const { adapter, calls } = makeMockAdapter();
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      const result = await service.buildWorkspacePanes("ws", undefined, commands(n), autoGridCols(n));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.paneCount).toBe(n);
        expect(result.data.blanks).toBe(blanks);
        expect(result.data.equalized).toBe(equalizes > 0 ? true : undefined);
      }
      expect(calls.filter((c) => c.method === "createWorkspace")).toHaveLength(1);
      const splits = calls.filter((c) => c.method === "splitSurface");
      expect(splits.filter((s) => s.args[1] === "right")).toHaveLength(rights);
      expect(splits.filter((s) => s.args[1] === "down")).toHaveLength(downs);
      expect(calls.filter((c) => c.method === "equalizeSplits")).toHaveLength(equalizes);
      const sends = calls.filter((c) => c.method === "sendText");
      expect(sends).toHaveLength(n);
      expect(sends.map((s) => s.args[1])).toEqual(commands(n).map((c) => `${c}\n`));
    },
  );

  // VM 诊断出的时序缺陷（PM 裁定）：在 pane 命令落地前执行均分，可能报告 equalized:true，
  // 但布局变动后仍成为 2:1:1。因此均分在最后一次发送和最终稳定等待之后执行；等待稳定后
  // 始终执行第二轮——绝不因 RPC 布尔值提前退出。
  it("仅在最后一条 pane 命令之后均分，且即使第一轮报告 true 也执行第二轮", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep, sleeps } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspacePanes("ws", undefined, commands(7), autoGridCols(7));

    expect(result.ok).toBe(true);
    const lastSendIdx = calls.map((c) => c.method).lastIndexOf("sendText");
    const firstEqIdx = calls.map((c) => c.method).indexOf("equalizeSplits");
    expect(firstEqIdx).toBeGreaterThan(lastSendIdx); // 在所有 pane 命令之后
    // Mock 在第一轮报告 equalized:true——仍会执行第二轮。
    expect(calls.filter((c) => c.method === "equalizeSplits")).toHaveLength(EQUALIZE_PASSES);
    // 最终稳定等待位于第 1 轮之前；均分稳定延迟将两轮隔开。
    expect(sleeps).toContain(FINAL_SETTLE_MS);
    expect(sleeps.filter((ms) => ms === EQUALIZE_SETTLE_MS)).toHaveLength(EQUALIZE_PASSES - 1);
  });

  it("没有任何一轮重新平衡时如实报告 equalized:false（验收仍基于 pane-frame 几何）", async () => {
    const { adapter, calls } = makeMockAdapter({
      equalizeSplitsFn: async () => ({ ok: true, data: { equalized: false } }),
    });
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspacePanes("ws", undefined, commands(7), autoGridCols(7));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.equalized).toBe(false);
    expect(calls.filter((c) => c.method === "equalizeSplits")).toHaveLength(EQUALIZE_PASSES);
  });

  it("computeGridLayout 将 cols 限制到 N，并拒绝非正 cols", () => {
    expect(CmuxLayoutService.computeGridLayout(2, 3)).toEqual({ rows: 1, cols: 2, blanks: 0 });
    expect(CmuxLayoutService.computeGridLayout(7, 3)).toEqual({ rows: 3, cols: 3, blanks: 2 });
    expect(() => CmuxLayoutService.computeGridLayout(3, 0)).toThrow(/cols/);
  });
});

describe("CmuxLayoutService.buildWorkspace", () => {
  it("N=1：创建 workspace，向默认 surface 发送 tmux attach，不分割", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["session-a"]);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(0);
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(1);
    expect((sends[0]!.args[1] as string)).toMatch(/tmux attach -t session-a/);
  });

  it("N=2：创建 workspace，向右分割 1 次，发送 2 次", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2"]);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(1);
    expect(splits[0]!.args[1]).toBe("right");
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(2);
  });

  it("N=4（2×2）：分割 3 次（向右 + 2 次向下），发送 4 次", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3", "s4"]);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(3);
    expect(splits[0]!.args[1]).toBe("right");
    expect(splits[1]!.args[1]).toBe("down");
    expect(splits[2]!.args[1]).toBe("down");
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(4);
  });

  it("N=12（2×6）：分割 11 次（1 次向右 + 10 次向下），发送 12 次", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const agents = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
    const result = await service.buildWorkspace("my-rig", "/cwd", agents);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(11);
    const rightSplits = splits.filter((s) => s.args[1] === "right");
    const downSplits = splits.filter((s) => s.args[1] === "down");
    expect(rightSplits).toHaveLength(1);
    expect(downSplits).toHaveLength(10);
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(12);
  });

  it("N 为奇数时返回空位数量（尾部一个空白面板）", async () => {
    const { adapter } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.blanks).toBe(1);
    }
  });

  it("createWorkspace 失败时返回错误", async () => {
    const { adapter } = makeMockAdapter({
      createWorkspaceFn: async () => ({ ok: false, code: "request_failed", message: "duplicate name" }),
    });
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/duplicate/i);
  });

  it("传播分割失败", async () => {
    const { adapter } = makeMockAdapter({
      splitSurfaceFn: async () => ({ ok: false, code: "request_failed", message: "split failed" }),
    });
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/split failed/);
  });

  it("N=0：返回 ok 并设置 workspaceName，但不含 agent", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", []);
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "splitSurface")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "sendText")).toHaveLength(0);
  });

  // velocity-guard 24.B 阻塞关注项回归：README §94 + 技能 §5 要求时序守卫。
  // 测试证明可注入 sleep 会在正确边界被等待。

  describe("时序陷阱（切片 24 README §94 + 技能 §5）", () => {
    it("每次 splitSurface 后等待 sleep(OP_DELAY_MS)", async () => {
      const { adapter } = makeMockAdapter();
      const { sleep, sleeps } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      // N=4（2×2）：分割 3 次 → 预期分割后等待 3 次 OP_DELAY_MS
      await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3", "s4"]);
      const opDelays = sleeps.filter((ms) => ms === OP_DELAY_MS);
      expect(opDelays).toHaveLength(3);
    });

    it("最后一次 sendText 后等待一次 sleep(FINAL_SETTLE_MS)", async () => {
      const { adapter } = makeMockAdapter();
      const { sleep, sleeps } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3", "s4"]);
      const finalSettles = sleeps.filter((ms) => ms === FINAL_SETTLE_MS);
      expect(finalSettles).toHaveLength(1);
    });

    it("最终稳定等待是最后一次 sleep 调用（此后无其他操作）", async () => {
      const { adapter } = makeMockAdapter();
      const { sleep, sleeps } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2"]);
      expect(sleeps[sleeps.length - 1]).toBe(FINAL_SETTLE_MS);
    });

    it("初始响应为空时以退避方式重试 listSurfaces", async () => {
      let listCallCount = 0;
      const { adapter } = makeMockAdapter({
        listSurfacesFn: async () => {
          listCallCount += 1;
          if (listCallCount < 3) {
            return { ok: true, data: [] };
          }
          return { ok: true, data: [{ id: "surface:default", title: "", type: "terminal" }] };
        },
      });
      const { sleep, sleeps } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      const result = await service.buildWorkspace("my-rig", "/cwd", ["s1"]);
      expect(result.ok).toBe(true);
      expect(listCallCount).toBe(3);
      // 第三次（成功）列举前有 2 次重试退避等待
      const retryBackoffs = sleeps.filter((ms) => ms === LIST_SURFACES_RETRY_DELAY_MS);
      expect(retryBackoffs.length).toBeGreaterThanOrEqual(2);
    });

    it("listSurfaces 连续 LIST_SURFACES_MAX_ATTEMPTS 次为空后返回 request_failed", async () => {
      const { adapter } = makeMockAdapter({
        listSurfacesFn: async () => ({ ok: true, data: [] }),
      });
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      const result = await service.buildWorkspace("my-rig", "/cwd", ["s1"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("request_failed");
        expect(result.message).toMatch(new RegExp(String(LIST_SURFACES_MAX_ATTEMPTS)));
      }
    });

    it("公开常量：OP_DELAY_MS=500、FINAL_SETTLE_MS=1000", () => {
      expect(OP_DELAY_MS).toBe(500);
      expect(FINAL_SETTLE_MS).toBe(1000);
    });
  });

  // velocity-guard 24.B 次要回归：README §52 的填充顺序为“从上到下、从左到右”——列优先。
  // 每列的 surface 从上到下填充完毕后，再移至下一列。

  describe("填充顺序（按 README §52 使用列优先）", () => {
    it("2×2 网格中 N=3：agent-2 → 第一次向下分割（col0,row1）；agent-3 → 向右分割（col1,row0）；(col1,row1) 为空——可区分列优先", async () => {
      // 实现中的分割顺序：(1) 先从 initial 向右分割；
      // (2) 然后在 r=1 时从 col0/row0=initial 向下分割，再从
      // col1/row0=right-split 向下分割。
      const splitCalls: Array<{ src: string; dir: string }> = [];
      let surfaceCounter = 100;
      const { adapter, calls } = makeMockAdapter({
        splitSurfaceFn: async (src, dir) => {
          const id = `surface:${++surfaceCounter}`;
          splitCalls.push({ src, dir });
          return { ok: true, data: id };
        },
        listSurfacesFn: async () => ({
          ok: true,
          data: [{ id: "surface:initial", title: "", type: "terminal" }],
        }),
      });
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["agent-1", "agent-2", "agent-3"]);

      // 验证分割顺序：1 次向右 + 2 次向下。
      expect(splitCalls).toHaveLength(3);
      expect(splitCalls[0]).toEqual({ src: "surface:initial", dir: "right" });
      // splitCalls[0] 返回 surface:101 = col1/row0（向右分割）
      // splitCalls[1] 返回 surface:102（从 col0/row0 向下 = col0/row1）
      // splitCalls[2] 返回 surface:103（从 col1/row0 向下 = col1/row1）
      expect(splitCalls[1]!.dir).toBe("down");
      expect(splitCalls[1]!.src).toBe("surface:initial"); // 从第 0 列第 0 行向下分割
      expect(splitCalls[2]!.dir).toBe("down");
      expect(splitCalls[2]!.src).toBe("surface:101"); // 从第 1 列第 0 行向下分割（向右分出的 surface）

      const sends = calls.filter((c) => c.method === "sendText");
      expect(sends).toHaveLength(3);

      // 列优先填充预期（这些断言可区分从行优先到列优先的切换——
      // 在先前的行优先实现下会失败）：
      //   agent-1 → col 0 / row 0 = "surface:initial"
      //   agent-2 → col 0 / row 1 = "surface:102"（第一次向下分割）
      //   agent-3 → col 1 / row 0 = "surface:101"（向右分割）
      // 若为行优先，agent-2 会落到 "surface:101"（col 1 / row 0），
      // agent-3 会落到 "surface:102"（col 0 / row 1）——下方两个 surface-id
      // 断言都会对调并失败。
      expect(sends[0]!.args[0]).toBe("surface:initial");
      expect((sends[0]!.args[1] as string)).toContain("agent-1");

      expect(sends[1]!.args[0]).toBe("surface:102");
      expect((sends[1]!.args[1] as string)).toContain("agent-2");

      expect(sends[2]!.args[0]).toBe("surface:101");
      expect((sends[2]!.args[1] as string)).toContain("agent-3");
    });

    it("2×2 网格中 N=4：发送顺序（列优先）为 initial → 第一次向下 → 向右 → 第二次向下", async () => {
      // 同一实现会按相同顺序分割；N=4 时四个 surface 都会填充。列优先下：
      //   send 0: col0/row0 = initial
      //   send 1: col0/row1 = 第一次向下分割（从 initial）= surface:102
      //   send 2: col1/row0 = 向右分割 = surface:101
      //   send 3: col1/row1 = 第二次向下分割（从向右分出的 surface）= surface:103
      // 行优先下，顺序会是 initial → 101 → 102 → 103。
      let surfaceCounter = 100;
      const { adapter, calls } = makeMockAdapter({
        splitSurfaceFn: async (_src, _dir) => ({ ok: true, data: `surface:${++surfaceCounter}` }),
        listSurfacesFn: async () => ({
          ok: true,
          data: [{ id: "surface:initial", title: "", type: "terminal" }],
        }),
      });
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["a1", "a2", "a3", "a4"]);
      const sends = calls.filter((c) => c.method === "sendText");
      expect(sends.map((s) => s.args[0])).toEqual([
        "surface:initial",
        "surface:102",
        "surface:101",
        "surface:103",
      ]);
    });

    it("2×1 网格中 N=2：agent 1 → col0 row0；agent 2 → col1 row0", async () => {
      const { adapter, calls } = makeMockAdapter({
        listSurfacesFn: async () => ({ ok: true, data: [{ id: "surface:initial", title: "", type: "terminal" }] }),
        splitSurfaceFn: async (_src, _dir) => ({ ok: true, data: "surface:right" }),
      });
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["agent-1", "agent-2"]);
      const sends = calls.filter((c) => c.method === "sendText");
      expect(sends[0]!.args[0]).toBe("surface:initial");
      expect((sends[0]!.args[1] as string)).toContain("agent-1");
      expect(sends[1]!.args[0]).toBe("surface:right");
      expect((sends[1]!.args[1] as string)).toContain("agent-2");
    });
  });
});

describe("CmuxLayoutService constants", () => {
  it("按照切片 24 README，MAX_COLS = 2", () => {
    expect(MAX_COLS).toBe(2);
  });

  it("按照切片 24 README，MAX_PER_WORKSPACE = 12", () => {
    expect(MAX_PER_WORKSPACE).toBe(12);
  });
});
