// OPR.0.4.6.02 C2——terminal-provider ride 核心提交。
//
// 覆盖计划中的 C2 测试契约：
//  - composer 分区向量：只读 `-r`、ssh 包装、http 如实降级（精确 reason 类）、未知 host
//    降级、具名 absent、混合分区、每页上限 9（3×3）；
//  - 实时计算的派生 view 绝不持久化（A3）；
//  - saved-views store 往返字节稳定 + 原子写入（tmp+rename）；
//  - herdr 重新启动时新建 tab（不替换）的决策 + FB4 socket 形状（probe=ping；全新
//    workspace.create → 每页一个原子 layout.apply；无 CLI 字符串回归——VM-RED
//    `herdr layout apply` 类）；
//  - herdr 等分 auto-grid root（2×1 / 3×2 / 3×3，与 UI suggestLayout 一致；
//    first-vs-rest 比例；非活动空白填充——OPR.0.4.7.1 对交替 0.5 双宽 cell 缺陷的修复）；
//  - cmux provider 通过 CmuxLayoutService.buildWorkspacePanes 每页渲染一个网格化 workspace
//    （绝非每席位一个 window），并如实降级。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  composeView,
  chunkPanes,
  PANES_PER_PAGE,
  type ViewMemberInput,
  type ComposeContext,
} from "../src/domain/terminal/view-composer.js";
import {
  TerminalViewsStore,
  deriveViewMembers,
  type SavedView,
  type LiveSeatRow,
} from "../src/domain/terminal/terminal-views-store.js";
import {
  planHerdrLayout,
  buildGridRoot,
  extractWorkspaceId,
  HerdrAdapter,
  type HerdrLayoutNode,
  type HerdrPaneNode,
  type HerdrSplitNode,
} from "../src/domain/terminal/herdr-adapter.js";
import {
  createHerdrSocketTransport,
  resolveHerdrSocketPath,
  parseHerdrVersion,
  unwrapHerdrResponse,
  type HerdrResult,
  type HerdrSocketRpc,
  type HerdrTransport,
} from "../src/domain/terminal/herdr-transport.js";
import { CmuxProviderAdapter } from "../src/domain/terminal/cmux-provider-adapter.js";
import type { HostEntry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { ComposedView } from "../src/domain/terminal/terminal-provider.js";

// --- host-registry fixture ---
const SSH_HOST: HostEntry = { id: "vm1", transport: "ssh", target: "vm1.local", user: "admin" };
const SSH_HOST_NO_USER: HostEntry = { id: "vm2", transport: "ssh", target: "10.0.0.9" };
const HTTP_HOST: HostEntry = { id: "factory", transport: "http", url: "http://x:7433", bearer_env: "T" };

function ctxWith(hosts: HostEntry[]): ComposeContext {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  return { resolveHost: (id) => byId.get(id) ?? null };
}

function member(overrides: Partial<ViewMemberInput> & { seat: string }): ViewMemberInput {
  return {
    label: overrides.seat,
    tmuxSession: overrides.seat,
    host: null,
    readOnly: false,
    alive: true,
    ...overrides,
  };
}

describe("view-composer 分区向量", () => {
  it("本地存活席位 → tmux attach -t（无 -r）", () => {
    const v = composeView("v", [member({ seat: "dev-a@rig" })], ctxWith([]));
    expect(v.opened).toHaveLength(1);
    expect(v.opened[0]!.paneCommand).toBe("tmux attach -t 'dev-a@rig'");
    expect(v.opened[0]!.readOnly).toBe(false);
    expect(v.absent).toHaveLength(0);
    expect(v.degraded).toHaveLength(0);
  });

  it("仅查看/跨 rig 只读席位 → tmux attach -r -t", () => {
    const v = composeView("v", [member({ seat: "dev-a@rig", readOnly: true })], ctxWith([]));
    expect(v.opened[0]!.paneCommand).toBe("tmux attach -r -t 'dev-a@rig'");
    expect(v.opened[0]!.readOnly).toBe(true);
  });

  it("ssh host → ssh '<user@target>' tmux attach -t（destination 经 shell 引用）；只读时添加 -r", () => {
    const rw = composeView("v", [member({ seat: "s@r", host: "vm1", tmuxSession: "s@r" })], ctxWith([SSH_HOST]));
    expect(rw.opened[0]!.paneCommand).toBe("ssh 'admin@vm1.local' tmux attach -t 's@r'");

    const ro = composeView("v", [member({ seat: "s@r", host: "vm1", readOnly: true })], ctxWith([SSH_HOST]));
    expect(ro.opened[0]!.paneCommand).toBe("ssh 'admin@vm1.local' tmux attach -r -t 's@r'");

    const nouser = composeView("v", [member({ seat: "s@r", host: "vm2" })], ctxWith([SSH_HOST_NO_USER]));
    expect(nouser.opened[0]!.paneCommand).toBe("ssh '10.0.0.9' tmux attach -t 's@r'");
  });

  // Guard G1——ssh destination 是注入 shell 命令字符串的结构化 registry 数据；必须保持
  // shell 惰性（恰好一个参数），且绝不能呈 option 形状。
  it("G1：shell 敏感的 ssh destination 保持为一个引用参数（无额外 shell word）", () => {
    const NASTY: HostEntry = { id: "evil", transport: "ssh", target: "a b; rm -rf /", user: "u'x" };
    const v = composeView("v", [member({ seat: "s@r", host: "evil", tmuxSession: "s@r" })], ctxWith([NASTY]));
    expect(v.opened).toHaveLength(1);
    // 单引号包裹，内嵌引号按 POSIX 转义（'\''）——元字符均为字面量。
    expect(v.opened[0]!.paneCommand).toBe(`ssh 'u'"'"'x@a b; rm -rf /' tmux attach -t 's@r'`);
    // 危险片段绝不会成为独立 shell word：
    expect(v.opened[0]!.paneCommand).not.toContain("; rm -rf / tmux");
  });

  it("G1：option 形状的 ssh destination（以 '-' 开头）会降级，绝不组合", () => {
    const OPT: HostEntry = { id: "opt", transport: "ssh", target: "-oProxyCommand=touch pwned" };
    const v = composeView("v", [member({ seat: "s@r", host: "opt", tmuxSession: "s@r" })], ctxWith([OPT]));
    expect(v.opened).toHaveLength(0);
    expect(v.degraded).toHaveLength(1);
    expect(v.degraded[0]!.reason).toContain("形似选项");
  });

  it("http host → 无 pane，以精确 reason 类如实降级", () => {
    const v = composeView("v", [member({ seat: "s@r", host: "factory" })], ctxWith([HTTP_HOST]));
    expect(v.opened).toHaveLength(0);
    expect(v.degraded).toEqual([
      { seat: "s@r", host: "factory", reason: "主机 factory 以 HTTP 注册；终端磁贴需要 SSH" },
    ]);
  });

  it("未知 host id → 具名 degraded，绝不静默省略", () => {
    const v = composeView("v", [member({ seat: "s@r", host: "ghost" })], ctxWith([]));
    expect(v.opened).toHaveLength(0);
    expect(v.degraded).toEqual([
      { seat: "s@r", host: "ghost", reason: "主机 ghost 不在主机注册表中" },
    ]);
  });

  it("失活本地席位 → 具名 absent；无 session 席位 → 具名 absent", () => {
    const dead = composeView("v", [member({ seat: "s@r", alive: false })], ctxWith([]));
    expect(dead.opened).toHaveLength(0);
    expect(dead.absent).toEqual([{ seat: "s@r", host: null, reason: "tmux 会话 s@r 未存活" }]);

    const noSess = composeView("v", [member({ seat: "s@r", tmuxSession: null })], ctxWith([]));
    expect(noSess.absent).toEqual([
      { seat: "s@r", host: null, reason: "未记录此席位的 tmux 会话" },
    ]);

    const sshNoSess = composeView("v", [member({ seat: "s@r", host: "vm1", tmuxSession: null })], ctxWith([SSH_HOST]));
    expect(sshNoSess.absent).toEqual([
      { seat: "s@r", host: "vm1", reason: "未记录此席位的 tmux 会话" },
    ]);
  });

  it("混合 view 把每个成员分入正确 bucket", () => {
    const v = composeView(
      "mix",
      [
        member({ seat: "live@r" }),
        member({ seat: "ro@r", readOnly: true }),
        member({ seat: "ssh@r", host: "vm1" }),
        member({ seat: "http@r", host: "factory" }),
        member({ seat: "dead@r", alive: false }),
        member({ seat: "ghost@r", host: "nope" }),
      ],
      ctxWith([SSH_HOST, HTTP_HOST]),
    );
    expect(v.opened.map((p) => p.seat)).toEqual(["live@r", "ro@r", "ssh@r"]);
    expect(v.degraded.map((d) => d.seat).sort()).toEqual(["ghost@r", "http@r"]);
    expect(v.absent.map((a) => a.seat)).toEqual(["dead@r"]);
  });

  it("分页上限为每页 9（3×3）个 pane，且顺序确定", () => {
    expect(PANES_PER_PAGE).toBe(9);
    const members = Array.from({ length: 20 }, (_, i) => member({ seat: `s${i}@r` }));
    const v = composeView("big", members, ctxWith([]));
    expect(v.opened).toHaveLength(20);
    expect(v.pages).toHaveLength(3); // 9 + 9 + 2
    expect(v.pages[0]).toHaveLength(9);
    expect(v.pages[1]).toHaveLength(9);
    expect(v.pages[2]).toHaveLength(2);
    // 页面中保留原顺序。
    expect(v.pages[0]![0]!.seat).toBe("s0@r");
    expect(v.pages[2]![1]!.seat).toBe("s19@r");
  });

  it("chunkPanes 拒绝非正 page size", () => {
    expect(() => chunkPanes([], 0)).toThrow();
  });
});

describe("terminal-views store——往返字节稳定 + 原子写入 + A3", () => {
  function tmpStore(): { store: TerminalViewsStore; dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-views-"));
    const file = path.join(dir, "terminal-views.yaml");
    return { store: new TerminalViewsStore(file), dir, file };
  }

  const view: SavedView = {
    id: "acme-build",
    name: "acme build",
    members: [
      { seat: "orch@acme", label: "orch@acme · s02", host: "vm1", tmuxSession: "orch@acme", readOnly: true },
      { seat: "dev@acme", tmuxSession: "dev@acme" }, // 无 host/label/readOnly → 写入时省略
    ],
  };

  it("文件缺失时读取为空集合", () => {
    const { store } = tmpStore();
    expect(store.read()).toEqual({ version: 1, views: [] });
    expect(store.list()).toEqual([]);
  });

  it("save→read→save 往返字节一致（缺失即省略，顺序固定）", () => {
    const { store, file } = tmpStore();
    store.save(view);
    const firstBytes = fs.readFileSync(file, "utf-8");

    const readBack = store.read();
    // 原为 false/缺失的可选值不会以 null 复活。
    expect(readBack.views[0]!.members[1]).toEqual({ seat: "dev@acme", tmuxSession: "dev@acme" });

    // 重新保存相同逻辑内容会生成相同字节。
    store.save(readBack.views[0]!);
    expect(fs.readFileSync(file, "utf-8")).toBe(firstBytes);
  });

  it("save 通过 tmp 文件再 rename 原子写入（不残留 tmp）", () => {
    const { store, dir, file } = tmpStore();
    store.save(view);
    expect(fs.existsSync(file)).toBe(true);
    // tmp sidecar 经 rename 移走，绝不残留。
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(["terminal-views.yaml"]);
  });

  it("按 id upsert 与 remove 都是幂等的", () => {
    const { store } = tmpStore();
    store.save(view);
    store.save({ ...view, name: "renamed" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("acme-build")!.name).toBe("renamed");
    store.remove("acme-build");
    expect(store.list()).toEqual([]);
    store.remove("acme-build"); // 幂等
    expect(store.list()).toEqual([]);
  });

  it("派生 view 实时计算且绝不写入磁盘（A3）", () => {
    const { store, file } = tmpStore();
    const rows: LiveSeatRow[] = [
      { canonicalSessionName: "a@r", attachmentType: "tmux", logicalId: "pod.a", rigName: "r" },
      { canonicalSessionName: "b@r", attachmentType: "external_cli", logicalId: "pod.b", rigName: "r" }, // 丢弃（非 tmux）
      { canonicalSessionName: null, attachmentType: "tmux" }, // 丢弃（无席位）
    ];
    const derived = deriveViewMembers(rows, { labelSuffix: "s02", readOnly: true, host: "vm1" });
    expect(derived).toEqual([
      { seat: "a@r", label: "pod.a · s02", tmuxSession: "a@r", host: "vm1", readOnly: true, alive: true },
    ]);
    // 未调用 save 路径 → store 文件不得存在。
    expect(fs.existsSync(file)).toBe(false);
    expect(store.read()).toEqual({ version: 1, views: [] });
  });
});

describe("herdr layout plan——重新启动时新建 tab（BR-5）+ 等分 auto-grid root + label", () => {
  const view: ComposedView = {
    id: "acme-build",
    opened: [
      { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false },
      { seat: "b@r", label: "pod.b · s02", paneCommand: "tmux attach -r -t 'b@r'", readOnly: true },
    ],
    absent: [],
    degraded: [],
    pages: [
      [
        { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false },
        { seat: "b@r", label: "pod.b · s02", paneCommand: "tmux attach -r -t 'b@r'", readOnly: true },
      ],
    ],
  };

  it("重新启动同一 view 会生成不同 tab label（不替换式幂等）", () => {
    const first = planHerdrLayout(view, "l1");
    const second = planHerdrLayout(view, "l2");
    expect(first.pages[0]!.tabLabel).toBe("openrig:acme-build#l1");
    expect(second.pages[0]!.tabLabel).toBe("openrig:acme-build#l2");
    expect(first.pages[0]!.tabLabel).not.toBe(second.pages[0]!.tabLabel);
    // token 相同 → 结果确定（label 相同）。OPR.0.6.0.8：workspace 采用人类可读名称（此处为
    // view id；rig: view 则为 rig 名称）；tab 保留 token。
    expect(planHerdrLayout(view, "l1").pages[0]!.tabLabel).toBe(first.pages[0]!.tabLabel);
    expect(first.workspaceLabel).toBe("acme-build");
    expect(second.workspaceLabel).toBe("acme-build");
  });

  it("每页一个 grid root（N=2 → 2×1）——pane leaf 携带 <agent> · <slice>，并通过 sh -c 携带组合 shell 命令", () => {
    const plan = planHerdrLayout(view, "l1");
    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]!.blanks).toBe(0);
    // N=2 是比例 1/2 的单个等分 right strip（layout.apply 的 argv 命令形状已由 capture 验证）。
    expect(plan.pages[0]!.root).toEqual({
      type: "split",
      direction: "right",
      ratio: 0.5,
      first: { type: "pane", label: "pod.a · s02", command: ["sh", "-c", "tmux attach -t 'a@r'"] },
      second: { type: "pane", label: "pod.b · s02", command: ["sh", "-c", "tmux attach -r -t 'b@r'"] },
    });
  });

  // VM 复现缺陷：交替 0.5 的 BSP 把 N=7 渲染为 4 列 × 2 行，且有一个双宽 cell。grid root
  // 必须匹配 UI suggestLayout 形状（cols=ceil(sqrt(N))、rows=ceil(N/cols)）并使用等分 cell：
  // 每行用等分 right strip（first-vs-rest 比例 1/N、1/(N-1)……），再以等分 down strip 组合，
  // 用非活动 blank 填满矩形。
  function walkLeaves(n: HerdrLayoutNode, out: HerdrPaneNode[] = []): HerdrPaneNode[] {
    if (n.type === "pane") out.push(n);
    else {
      walkLeaves(n.first, out);
      walkLeaves(n.second, out);
    }
    return out;
  }

  it.each([
    { n: 2, cols: 2, rows: 1, blanks: 0 },
    { n: 5, cols: 3, rows: 2, blanks: 1 },
    { n: 7, cols: 3, rows: 3, blanks: 2 }, // 创始人复现时的规模
  ])("buildGridRoot N=$n → $cols×$rows，含 $blanks 个非活动 blank，pane 保持顺序", ({ n, cols, rows, blanks }) => {
    const panes = Array.from({ length: n }, (_, i) => ({
      seat: `s${i + 1}`,
      label: `s${i + 1}`,
      paneCommand: `attach s${i + 1}`,
      readOnly: false,
    }));
    const grid = buildGridRoot(panes);
    expect(grid.blanks).toBe(blanks);

    const leaves = walkLeaves(grid.root);
    expect(leaves).toHaveLength(rows * cols); // 完整矩形：N 个真实 pane + blank
    // 真实 pane 在前，保持页面顺序，并通过 sh -c 运行其组合命令。
    expect(leaves.slice(0, n).map((l) => l.label)).toEqual(panes.map((p) => p.label));
    for (const leaf of leaves.slice(0, n)) expect(leaf.command.slice(0, 2)).toEqual(["sh", "-c"]);
    // blank 填充矩形尾部且不活动（无组合 attach 命令）。
    for (const leaf of leaves.slice(n)) {
      expect(leaf.label).toBe("");
      expect(leaf.command).toEqual(["sh"]);
    }

    // 等分 cell 几何：root 以 1/rows（再 1/(rows-1)……）比例组合 `rows` 个 down strip；
    // 每行以 1/cols（再 1/(cols-1)……）比例向右组合 `cols` 个 leaf——first-vs-rest，
    // 绝不固定为中点 0.5。
    const root = grid.root;
    if (rows > 1) {
      if (root.type !== "split") throw new Error("预期为 split root");
      expect(root.direction).toBe("down");
      expect(root.ratio).toBeCloseTo(1 / rows, 10);
      if (rows > 2) {
        const restRows = root.second;
        if (restRows.type !== "split") throw new Error("预期为嵌套 down split");
        expect(restRows.direction).toBe("down");
        expect(restRows.ratio).toBeCloseTo(1 / (rows - 1), 10);
      }
    }
    const firstRow: HerdrLayoutNode = rows > 1 ? (root as HerdrSplitNode).first : root;
    if (cols > 1) {
      if (firstRow.type !== "split") throw new Error("预期为 row split");
      expect(firstRow.direction).toBe("right");
      expect(firstRow.ratio).toBeCloseTo(1 / cols, 10);
      if (cols > 2) {
        const restCols = firstRow.second;
        if (restCols.type !== "split") throw new Error("预期为嵌套 right split");
        expect(restCols.direction).toBe("right");
        expect(restCols.ratio).toBeCloseTo(1 / (cols - 1), 10);
      }
    }
  });

  it("多页 view 每页获得一个全新 tab label", () => {
    const many: ComposedView = {
      ...view,
      pages: [view.pages[0]!, view.pages[0]!],
    };
    const plan = planHerdrLayout(many, "l9");
    expect(plan.pages.map((p) => p.tabLabel)).toEqual([
      "openrig:acme-build#l9/1",
      "openrig:acme-build#l9/2",
    ]);
  });
});

describe("herdr adapter——socket ping 探测 + workspace.create → layout.apply（FB4）", () => {
  function fakeSocketTransport(opts?: {
    alive?: boolean;
    respond?: (method: string, params: unknown) => Promise<HerdrResult>;
  }): { transport: HerdrTransport; requests: Array<{ method: string; params: unknown }> } {
    const requests: Array<{ method: string; params: unknown }> = [];
    const transport: HerdrTransport = {
      async probe() {
        return { alive: opts?.alive ?? true, version: "0.7.1", protocol: 14 };
      },
      async request(method, params) {
        requests.push({ method, params });
        if (opts?.respond) return opts.respond(method, params);
        if (method === "workspace.create") return { type: "workspace_created", workspace_id: "wG" };
        return { type: "layout_apply", layout: { workspace_id: "wG", tab_id: "wG:t2" } };
      },
    };
    return { transport, requests };
  }

  const pane = { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false };
  const view: ComposedView = { id: "v", opened: [pane], absent: [], degraded: [], pages: [[pane]] };

  it("liveness = socket ping（socket 响应时 alive，否则如实给出 detail）", async () => {
    const { transport } = fakeSocketTransport();
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    expect((await adapter.liveness()).alive).toBe(true);
    const dead = new HerdrAdapter({
      transportFactory: () => fakeSocketTransport({ alive: false }).transport,
    });
    const live = await dead.liveness();
    expect(live.alive).toBe(false);
    expect(live.detail).toContain("ping");
  });

  it("status 反映 ping 探测（available + version），不可达时如实为 down", async () => {
    const { transport } = fakeSocketTransport();
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    const status = await adapter.status();
    expect(status.available).toBe(true);
    expect(status.version).toBe("0.7.1");
    const down = new HerdrAdapter({
      transportFactory: () => fakeSocketTransport({ alive: false }).transport,
    });
    expect((await down.status()).available).toBe(false);
  });

  it("socket 失活时 openView 以 herdr_unavailable 拒绝，且不发送任何内容", async () => {
    const { transport, requests } = fakeSocketTransport({ alive: false });
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("herdr_unavailable");
    expect(requests).toEqual([]);
  });

  it("openView = 全新 workspace.create，随后每页一个原子 layout.apply（参数已由 capture 验证）", async () => {
    const { transport, requests } = fakeSocketTransport();
    const adapter = new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "tok" });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["a@r"]);
    expect(res.pages).toBe(1);
    // OPR.0.6.0.8：页面应用后聚焦其 tab（此处不关闭空白 tab：create 响应不含默认 tab id）。
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply", "tab.focus"]);
    expect(requests[0]!.params).toEqual({ focus: false, label: "v" });
    expect(requests[2]!.params).toEqual({ tab_id: "wG:t2" });
    expect(requests[1]!.params).toEqual({
      workspace_id: "wG",
      tab_label: "openrig:v#tok",
      focus: true,
      root: { type: "pane", label: "pod.a · s02", command: ["sh", "-c", "tmux attach -t 'a@r'"] },
    });
  });

  it("回归（VM-RED 类）：始终只用 socket 方法——不存在的 CLI `herdr layout apply` 不能再次混入", async () => {
    const { transport, requests } = fakeSocketTransport();
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    await adapter.openView(view);
    await adapter.status();
    await adapter.liveness();
    for (const r of requests) {
      // socket 方法 token，绝不是 shell 命令行。
      expect(r.method).toMatch(/^[a-z_]+(\.[a-z_]+)*$/);
      expect(r.method.startsWith("herdr")).toBe(false);
      expect(r.method).not.toContain("--help");
      expect(r.method).not.toContain(" ");
    }
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply", "tab.focus"]);
  });

  it("带 label 的 workspace.create 失败时只回退一次裸 create（未捕获参数防护）", async () => {
    const { transport, requests } = fakeSocketTransport({
      respond: async (method, params) => {
        if (method === "workspace.create") {
          if ((params as Record<string, unknown>)["label"] != null) throw new Error("未知参数：label");
          return { type: "workspace_created", workspace_id: "wH" };
        }
        return { type: "layout_apply" };
      },
    });
    const adapter = new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "t" });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["a@r"]);
    // OPR.0.6.0.8：裸回退前检查同名 workspace（此处没有）。
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "workspace.list", "workspace.create", "layout.apply"]);
    expect((requests[3]!.params as Record<string, unknown>)["workspace_id"]).toBe("wH");
    expect(res.notes?.join(" ")).toContain('拒绝了工作区名称“v”');
  });

  it("workspace.create 完全失败时如实降级每个 pane（herdr_workspace_failed）", async () => {
    const { transport } = fakeSocketTransport({
      respond: async (method) => {
        if (method === "workspace.create") throw new Error("失败");
        return { type: "layout_apply" };
      },
    });
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("herdr_workspace_failed");
    expect(res.opened).toEqual([]);
    expect(res.pages).toBe(0);
    expect(res.degraded).toHaveLength(1);
    expect(res.degraded[0]).toMatchObject({ seat: "a@r", host: "herdr" });
    expect(res.degraded[0]!.reason).toContain("workspace.create 失败");
  });

  it("页面失败时降级其席位；其他页面仍打开（如实报告部分成功）", async () => {
    const paneB = { seat: "b@r", label: "pod.b · s02", paneCommand: "tmux attach -t 'b@r'", readOnly: false };
    const two: ComposedView = {
      id: "v",
      opened: [pane, paneB],
      absent: [],
      degraded: [],
      pages: [[pane], [paneB]],
    };
    let applies = 0;
    const { transport } = fakeSocketTransport({
      respond: async (method) => {
        if (method === "workspace.create") return { type: "workspace_created", workspace_id: "wG" };
        applies += 1;
        if (applies === 2) throw new Error("herdr 错误：无效树");
        return { type: "layout_apply" };
      },
    });
    const adapter = new HerdrAdapter({ transportFactory: () => transport });
    const res = await adapter.openView(two);
    expect(res.ok).toBe(true); // 第 1 页已打开 → 披露部分成功
    expect(res.opened).toEqual(["a@r"]);
    expect(res.degraded.map((d) => d.seat)).toEqual(["b@r"]);
    expect(res.degraded[0]!.reason).toContain("layout.apply 失败");
  });
});

describe("herdr socket transport——ping 探测、envelope 解包、socket 路径（FB4）", () => {
  it("createHerdrSocketTransport 通过 socket `ping` 方法探测（绝不使用 CLI --help）", async () => {
    const sent: Array<{ id: string; method: string; params: unknown }> = [];
    const rpc: HerdrSocketRpc = async (req) => {
      sent.push(req);
      return { type: "pong", version: "0.7.1", protocol: 14 };
    };
    const t = createHerdrSocketTransport(rpc)();
    const probe = await t.probe();
    expect(probe).toEqual({ alive: true, version: "0.7.1", protocol: 14 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("ping");
    expect(sent[0]!.id).toBeTruthy();
  });

  it("socket 不可达或返回无效内容时，probe 如实为 dead", async () => {
    const dead = createHerdrSocketTransport(async () => {
      throw new Error("connect ENOENT herdr.sock");
    })();
    expect((await dead.probe()).alive).toBe(false);
    const weird = createHerdrSocketTransport(async () => ({ type: "nope" }))();
    expect((await weird.probe()).alive).toBe(false);
  });

  it("unwrapHerdrResponse 接受包装的 {id,result:{type}} 与裸 {type}；error/无形状值会抛错", () => {
    expect(unwrapHerdrResponse({ id: "x", result: { type: "layout_apply", layout: {} } })).toEqual({
      type: "layout_apply",
      layout: {},
    });
    expect(unwrapHerdrResponse({ type: "pong", version: "0.7.1" })).toEqual({ type: "pong", version: "0.7.1" });
    expect(() => unwrapHerdrResponse({ id: "x", error: "unknown method" })).toThrow(/herdr error/);
    expect(() => unwrapHerdrResponse({ id: "x" })).toThrow(/unrecognized/);
    expect(() => unwrapHerdrResponse("junk")).toThrow(/unrecognized/);
  });

  it("extractWorkspaceId 按顺序尝试防御性位置（未捕获的 workspace.create envelope）", () => {
    expect(extractWorkspaceId({ type: "w", workspace_id: "w1" })).toBe("w1");
    expect(extractWorkspaceId({ type: "w", workspace: { workspace_id: "w2" } })).toBe("w2");
    expect(extractWorkspaceId({ type: "w", workspace: { id: "w3" } })).toBe("w3");
    expect(extractWorkspaceId({ type: "w", layout: { workspace_id: "w4" } })).toBe("w4");
    expect(extractWorkspaceId({ type: "w", id: "w5" })).toBe("w5");
    expect(extractWorkspaceId({ type: "w" })).toBeNull();
  });

  it("resolveHerdrSocketPath：env 覆盖 → 逐 session → 默认值；解析 version", () => {
    expect(resolveHerdrSocketPath({ HERDR_SOCKET_PATH: "/x/h.sock" })).toBe("/x/h.sock");
    expect(resolveHerdrSocketPath({ HERDR_SESSION: "s1" })).toContain(path.join("sessions", "s1", "herdr.sock"));
    expect(resolveHerdrSocketPath({})).toContain(path.join(".config", "herdr", "herdr.sock"));
    expect(parseHerdrVersion("herdr 0.7.1")).toBe("0.7.1");
    expect(parseHerdrVersion(undefined)).toBeNull();
  });
});

describe("cmux provider——每页一个网格 workspace（绝非每席位一个 window），并如实降级", () => {
  function fakeCmuxAdapter(available: boolean) {
    return {
      getStatus: () => ({ available, capabilities: { rpc: true } }),
      isAvailable: () => available,
    } as unknown as import("../src/adapters/cmux.js").CmuxAdapter;
  }

  /** 记录 buildWorkspacePanes 调用；按名称覆盖 outcome 以构造失败向量。 */
  function fakeLayoutService(failFor: (name: string) => string | null = () => null) {
    const builds: Array<{ name: string; commands: string[]; cols?: number }> = [];
    const layoutService = {
      buildWorkspacePanes: async (name: string, _cwd: string | undefined, commands: string[], cols?: number) => {
        builds.push({ name, commands, cols });
        const fail = failFor(name);
        if (fail) return { ok: false as const, code: "request_failed", message: fail };
        return {
          ok: true as const,
          data: { workspaceId: `ws:${name}`, workspaceName: name, paneCount: commands.length, blanks: 0 },
        };
      },
    } as unknown as import("../src/domain/cmux-layout-service.js").CmuxLayoutService;
    return { layoutService, builds };
  }

  const pane = { seat: "a@r", label: "pod.a · s02", paneCommand: "tmux attach -t 'a@r'", readOnly: false };
  const paneB = { ...pane, seat: "b@r", paneCommand: "tmux attach -r -t 'b@r'", readOnly: true };
  const view: ComposedView = {
    id: "v",
    opened: [pane, paneB],
    absent: [{ seat: "z@r", host: null, reason: "dead" }],
    degraded: [{ seat: "h@r", host: "factory", reason: "http-registered" }],
    pages: [[pane, paneB]],
  };

  it("把页面渲染为一个 workspace；原样携带 paneCommand、absent 与 degraded", async () => {
    const { layoutService, builds } = fakeLayoutService();
    const adapter = new CmuxProviderAdapter({
      cmuxAdapter: fakeCmuxAdapter(true),
      layoutService,
      newLaunchToken: () => "t1",
    });

    const res = await adapter.openView(view);
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["a@r", "b@r"]);
    expect(res.pages).toBe(1);
    // 关键修复不变量：整页只构建一个 grid——绝非每席位一个 window——并原样携带组合命令
    //（包括只读 -r）。
    expect(builds).toHaveLength(1);
    expect(builds[0]!.commands).toEqual(["tmux attach -t 'a@r'", "tmux attach -r -t 'b@r'"]);
    expect(res.absent).toEqual([{ seat: "z@r", host: null, reason: "dead" }]);
    expect(res.degraded).toEqual([{ seat: "h@r", host: "factory", reason: "http-registered" }]);
  });

  it.each([
    { n: 2, cols: 2 },
    { n: 5, cols: 3 },
    { n: 7, cols: 3 }, // 创始人的 7 席位复现：modal 承诺 3×3——cmux 必须应用
  ])("传递 N=$n（cols=$cols）时 modal 的 Auto-grid 列数——PM 裁定", async ({ n, cols }) => {
    const panes = Array.from({ length: n }, (_, i) => ({
      ...pane,
      seat: `s${i + 1}@r`,
      paneCommand: `tmux attach -t 's${i + 1}@r'`,
    }));
    const { layoutService, builds } = fakeLayoutService();
    const adapter = new CmuxProviderAdapter({
      cmuxAdapter: fakeCmuxAdapter(true),
      layoutService,
      newLaunchToken: () => "t1",
    });

    const res = await adapter.openView({ id: "v", opened: panes, absent: [], degraded: [], pages: [panes] });
    expect(res.opened).toHaveLength(n);
    expect(builds).toHaveLength(1); // 一个新 workspace——绝不追加 surface
    expect(builds[0]!.cols).toBe(cols);
  });

  it("多页 view → 每页一个带 /N 后缀的 workspace；失败页面降级其席位，其他页面仍打开", async () => {
    const paneC = { ...pane, seat: "c@r", paneCommand: "tmux attach -t 'c@r'" };
    const multiView: ComposedView = {
      id: "v",
      opened: [pane, paneB, paneC],
      absent: [],
      degraded: [],
      pages: [[pane, paneB], [paneC]],
    };
    const { layoutService, builds } = fakeLayoutService((name) =>
      name.endsWith("/2") ? "cmux daemon 未就绪" : null,
    );
    const adapter = new CmuxProviderAdapter({
      cmuxAdapter: fakeCmuxAdapter(true),
      layoutService,
      newLaunchToken: () => "t1",
    });

    const res = await adapter.openView(multiView);
    expect(builds.map((b) => b.name)).toEqual(["openrig:v#t1/1", "openrig:v#t1/2"]);
    expect(res.ok).toBe(true); // 如实报告部分成功：第 1 页已打开
    expect(res.opened).toEqual(["a@r", "b@r"]);
    expect(res.pages).toBe(1);
    expect(res.degraded).toEqual([
      { seat: "c@r", host: "local", reason: "cmux: cmux daemon 未就绪" },
    ]);
  });

  it("cmux 未连接 → 如实以 cmux_unavailable 拒绝；不构建任何内容", async () => {
    const { layoutService, builds } = fakeLayoutService();
    const adapter = new CmuxProviderAdapter({
      cmuxAdapter: fakeCmuxAdapter(false),
      layoutService,
    });
    const res = await adapter.openView(view);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("cmux_unavailable");
    expect(res.opened).toEqual([]);
    expect(builds).toHaveLength(0);
  });

  it("全部 absent/degraded 的 view（无页面）→ 无 workspace 副作用", async () => {
    const { layoutService, builds } = fakeLayoutService();
    const adapter = new CmuxProviderAdapter({
      cmuxAdapter: fakeCmuxAdapter(true),
      layoutService,
    });
    const res = await adapter.openView({
      id: "v",
      opened: [],
      absent: [{ seat: "z@r", host: null, reason: "dead" }],
      degraded: [],
      pages: [],
    });
    expect(res.ok).toBe(true);
    expect(res.pages).toBe(0);
    expect(builds).toHaveLength(0);
  });

  it("status/liveness 反映已发布的 CmuxAdapter", async () => {
    const { layoutService } = fakeLayoutService();
    const adapter = new CmuxProviderAdapter({
      cmuxAdapter: fakeCmuxAdapter(false),
      layoutService,
    });
    expect((await adapter.status()).available).toBe(false);
    expect((await adapter.liveness()).alive).toBe(false);
  });
});
