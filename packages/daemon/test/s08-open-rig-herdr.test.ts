// OPR.0.6.0.8——在 Herdr 中打开整个 rig。通过注入的 socket transport 使用真实
// TerminalService + HerdrAdapter，并构造一个有 17 个席位的 rig。测试证明 adapter 发送的内容
// 及其读取响应的方式，不证明真实 Herdr 如何处理重复 label 或 focus。
import { describe, expect, it } from "vitest";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { HerdrAdapter, HERDR_PANES_PER_PAGE, planHerdrLayout } from "../src/domain/terminal/herdr-adapter.js";
import { PANES_PER_PAGE } from "../src/domain/terminal/view-composer.js";
import { MAX_COLS, MAX_PER_WORKSPACE } from "../src/domain/cmux-layout-service.js";
import type { HerdrResult, HerdrTransport } from "../src/domain/terminal/herdr-transport.js";
import type { ComposedView, OpenViewResult, TerminalProvider } from "../src/domain/terminal/terminal-provider.js";

const RIG = "big";
const rows = Array.from({ length: 17 }, (_, i) => {
  const s = `seat-${String(i + 1).padStart(2, "0")}@${RIG}`;
  return { canonicalSessionName: s, attachmentType: "tmux" as const, tmuxSession: s, rigName: RIG, logicalId: `pod.s${i + 1}` };
});

type Req = { method: string; params: Record<string, unknown> };
function herdrTransport(respond?: (method: string, params: Record<string, unknown>, n: number) => HerdrResult): { transport: HerdrTransport; requests: Req[] } {
  const requests: Req[] = [];
  let applied = 0;
  return {
    requests,
    transport: {
      probe: async () => ({ alive: true, version: "0.7.1", protocol: 14 }),
      request: async (method, params) => {
        requests.push({ method, params: params as Record<string, unknown> });
        if (respond) return respond(method, params as Record<string, unknown>, applied);
        if (method === "workspace.create") return { type: "workspace_created", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
        if (method === "layout.apply") { applied++; return { type: "layout_apply", layout: { workspace_id: "w1", tab_id: `w1:t${applied}` } }; }
        return { type: "ok" };
      },
    },
  };
}

class RecordingCmux implements TerminalProvider {
  readonly name = "cmux";
  last: ComposedView | null = null;
  async status() { return { provider: this.name, available: true, capabilities: { layout: true } }; }
  async liveness() { return { alive: true }; }
  async openView(view: ComposedView): Promise<OpenViewResult> {
    this.last = view;
    return { provider: this.name, ok: true, opened: view.opened.map((p) => p.seat), absent: view.absent, degraded: view.degraded, pages: view.pages.length };
  }
}

function service(herdr: TerminalProvider, cmux = new RecordingCmux()): { svc: TerminalService; cmux: RecordingCmux } {
  const deps: TerminalServiceDeps = {
    resolveProvider: (n) => (n === "herdr" ? herdr : n === "cmux" ? cmux : null),
    viewsStore: { get: () => null, list: () => [] },
    listRigSeats: (r) => (r === RIG ? rows : null),
    listPodSeats: () => null,
    listScopeSeats: () => null,
    listRigNames: () => [RIG],
    resolveHost: () => null,
    hasSession: () => true,
  } as TerminalServiceDeps;
  return { svc: new TerminalService(deps), cmux };
}

const cellSeats = (root: unknown): string[] => {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "pane" && Array.isArray(n.command)) { const m = /attach -t '([^']+)'/.exec(n.command.join(" ")); if (m) out.push(m[1]!); }
    for (const k of ["first", "second", "children", "left", "right", "top", "bottom"]) {
      const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else walk(v);
    }
  };
  walk(root);
  return out;
};

describe("S08——把 rig 作为一个 Herdr space 打开，每个 tab 16 个 cell", () => {
  it("17 个存活席位 → workspace 以 rig 命名，tab 依次容纳 16 和 1 个席位，每个 cell 按顺序对应一个席位", async () => {
    const { transport, requests } = herdrTransport();
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => "tok" }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(res).toMatchObject({ provider: "herdr", ok: true, pages: 2, absent: [], degraded: [] });
    expect(res.opened).toEqual(rows.map((r) => r.canonicalSessionName));
    const create = requests.find((r) => r.method === "workspace.create")!;
    expect(create.params).toEqual({ focus: false, label: RIG });
    const applies = requests.filter((r) => r.method === "layout.apply");
    expect(applies.map((a) => a.params["tab_label"])).toEqual([`openrig:rig:${RIG}#tok/1`, `openrig:rig:${RIG}#tok/2`]);
    expect(applies.map((a) => cellSeats(a.params["root"]).length)).toEqual([16, 1]);
    expect([...cellSeats(applies[0]!.params["root"]), ...cellSeats(applies[1]!.params["root"])]).toEqual(rows.map((r) => r.canonicalSessionName));
  });

  it("第一个 tab 是 4×4 等分网格；preview plan 使用相同分页方式", async () => {
    const { transport } = herdrTransport();
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const preview = await svc.previewView({ view: `rig:${RIG}` }) as { grids: Array<{ columns: number; rows: number; blanks: number }>; composed: ComposedView };
    expect(preview.composed.pages.map((p) => p.length)).toEqual([16, 1]);
    expect(preview.grids.map((g) => [g.columns, g.rows, g.blanks])).toEqual([[4, 4, 0], [1, 1, 0]]);
    expect(HERDR_PANES_PER_PAGE).toBe(16);
  });

  it("layout 后聚焦首个非空 tab，再关闭空白起始 tab", async () => {
    const { transport, requests } = herdrTransport();
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply", "layout.apply", "tab.focus", "tab.close"]);
    expect(requests[3]!.params).toEqual({ tab_id: "w1:t1" });
    expect(requests[4]!.params).toEqual({ tab_id: "w1:t0" });
    expect(res.notes).toBeUndefined();
  });

  it("即使 herdr 复用起始 tab，也绝不关闭承载页面的 tab", async () => {
    const { transport, requests } = herdrTransport((m) =>
      m === "workspace.create" ? { type: "c", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } }
        : m === "layout.apply" ? { type: "l", layout: { tab_id: "w1:t0" } } : { type: "ok" });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    await svc.openView({ view: `rig:${RIG}` });
    expect(requests.some((r) => r.method === "tab.close")).toBe(false);
  });

  it("重新打开会创建同名的第二个 space，并使用不同 tab label", async () => {
    const { transport, requests } = herdrTransport();
    let n = 0;
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport, newLaunchToken: () => `l${++n}` }));
    await svc.openView({ view: `rig:${RIG}` });
    await svc.openView({ view: `rig:${RIG}` });
    const creates = requests.filter((r) => r.method === "workspace.create");
    expect(creates.map((c) => c.params["label"])).toEqual([RIG, RIG]);
    const labels = requests.filter((r) => r.method === "layout.apply").map((a) => a.params["tab_label"]);
    expect(new Set(labels).size).toBe(4);
    expect(labels[0]).not.toBe(labels[2]);
  });

  it("herdr 拒绝重复名称时，以数字后缀重试并明确说明", async () => {
    const { transport, requests } = herdrTransport((m, p) => {
      if (m === "workspace.create") {
        if (p["label"] === RIG) throw new Error("label 已被使用");
        return { type: "c", workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t0" } };
      }
      if (m === "workspace.list") return { type: "workspaces", workspaces: [{ label: RIG }, { label: `${RIG} (2)` }] };
      if (m === "layout.apply") return { type: "l", layout: { tab_id: "w2:t1" } };
      return { type: "ok" };
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(requests.filter((r) => r.method === "workspace.create").map((c) => c.params["label"])).toEqual([RIG, `${RIG} (3)`]);
    expect(res.ok).toBe(true);
    expect(res.notes).toEqual([`名为“${RIG}”的工作区已存在，因此新工作区命名为“${RIG} (3)”。`]);
  });

  it("focus 或 close 被拒绝时记录 note；已打开席位不变", async () => {
    const { transport } = herdrTransport((m, _p, n) => {
      if (m === "workspace.create") return { type: "c", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
      if (m === "layout.apply") return { type: "l", layout: { tab_id: `w1:t${n + 1}` } };
      throw new Error(`${m} 不受支持`);
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(res.opened).toHaveLength(17);
    expect(res.degraded).toEqual([]);
    expect(res.notes).toEqual(["herdr 未聚焦第一个 tab：tab.focus 不受支持", "herdr 保留了空白起始 tab：tab.close 不受支持"]);
  });

  it("如实报告部分成功：herdr 拒绝页面时把其中席位标为 degraded，tile 数绝不多报", async () => {
    let applyCall = 0;
    const { transport } = herdrTransport((m) => {
      if (m === "workspace.create") return { type: "c", workspace: { workspace_id: "w1" }, tab: { tab_id: "w1:t0" } };
      if (m === "layout.apply") { applyCall++; if (applyCall === 2) throw new Error("页面被拒绝"); return { type: "l", layout: { tab_id: "w1:t1" } }; }
      return { type: "ok" };
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(res.opened).toHaveLength(16);
    expect(res.degraded.map((d) => d.seat)).toEqual([rows[16]!.canonicalSessionName]);
    expect(res.degraded[0]!.reason).toContain("页面被拒绝");
  });
});

describe("S08 修正——除非确认起始 tab 为空，否则予以保留", () => {
  const create = { type: "c", workspace: { workspace_id: "w1" }, tab: { tab_id: "t0" } };
  const closes = (reqs: Req[]) => reqs.filter((r) => r.method === "tab.close");
  const KEPT = "无法确认起始 tab 为空，因此予以保留。";

  it("应用页面但没有 tab id（可能进入起始 tab）时保留起始 tab，并聚焦已知页面", async () => {
    let n = 0;
    const { transport, requests } = herdrTransport((m) => {
      if (m === "workspace.create") return create;
      if (m === "layout.apply") { n++; return n === 1 ? { type: "l" } : { type: "l", layout: { tab_id: "t2" } }; }
      return { type: "ok" };
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(closes(requests)).toEqual([]);
    expect(requests.find((r) => r.method === "tab.focus")!.params).toEqual({ tab_id: "t2" });
    expect(res.opened).toHaveLength(17);
    expect(res.notes).toEqual([KEPT]);
  });

  it("没有页面报告 tab id：既不 focus 也不 close，并同时说明", async () => {
    const { transport, requests } = herdrTransport((m) => (m === "workspace.create" ? create : { type: "l" }));
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply", "layout.apply"]);
    expect(res.notes).toEqual(["herdr 未为任何页面返回 tab id，因此未显式聚焦 tab。", KEPT]);
  });

  it("apply 失败（但可能已生效）时保留起始 tab；其席位保持 degraded 且不计数", async () => {
    let n = 0;
    const { transport, requests } = herdrTransport((m) => {
      if (m === "workspace.create") return create;
      if (m === "layout.apply") { n++; if (n === 1) throw new Error("响应丢失"); return { type: "l", layout: { tab_id: "t2" } }; }
      return { type: "ok" };
    });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(closes(requests)).toEqual([]);
    expect(res.opened).toEqual([rows[16]!.canonicalSessionName]);
    expect(res.degraded).toHaveLength(16);
    expect(res.notes).toEqual([KEPT]);
  });

  it("所有页面都失败时：不 focus 或 close 任何内容", async () => {
    const { transport, requests } = herdrTransport((m) => { if (m === "workspace.create") return create; throw new Error("已拒绝"); });
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(requests.map((r) => r.method)).toEqual(["workspace.create", "layout.apply", "layout.apply"]);
    expect(res.opened).toEqual([]);
    expect(res.degraded).toHaveLength(17);
  });

  it("所有页面均已知且都不是起始 tab 时，仍会执行 close", async () => {
    const { transport, requests } = herdrTransport();
    const { svc } = service(new HerdrAdapter({ transportFactory: () => transport }));
    const res = await svc.openView({ view: `rig:${RIG}` });
    expect(closes(requests).map((r) => r.params)).toEqual([{ tab_id: "w1:t0" }]);
    expect(res.notes).toBeUndefined();
  });
});

describe("S08 修正——catalog 页数与 Herdr open 一致", () => {
  const ten = rows.slice(0, 10);
  const saved = { id: "ten", name: "十席位", members: ten.map((r) => ({ seat: r.canonicalSessionName, tmuxSession: r.tmuxSession })) };
  function catalogService(batch: boolean): TerminalService {
    const { transport } = herdrTransport();
    const herdr = new HerdrAdapter({ transportFactory: () => transport });
    return new TerminalService({
      resolveProvider: (n) => (n === "herdr" ? herdr : null),
      viewsStore: { get: (id) => (id === "ten" ? saved : null), list: () => [saved] },
      listRigSeats: (r) => (r === RIG ? ten : null),
      ...(batch ? { listRigSeatsBatch: (names: string[]) => new Map(names.map((n) => [n, n === RIG ? ten : []])) } : {}),
      listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [RIG],
      resolveHost: () => null, hasSession: () => true,
    } as TerminalServiceDeps);
  }

  for (const batch of [false, true]) {
    it(`${batch ? "批量" : "回退"} inventory：saved 与 derived 条目和 preview 一样，为 10 个席位显示 1 页`, async () => {
      const svc = catalogService(batch);
      const views = await svc.listViews(true);
      const pages = Object.fromEntries((views.catalog ?? []).map((e) => [e.view, e.pages]));
      expect(pages).toEqual({ "saved:ten": 1, [`rig:${RIG}`]: 1 });
      const preview = await svc.previewView({ view: "saved:ten" }) as { composed: ComposedView };
      expect(preview.composed.pages).toHaveLength(1);
    });
  }
});

describe("S08——cmux 保持不变", () => {
  it("cmux 仍按默认每页 9 个分页，并保持每 workspace 12 个与 2 列限制", async () => {
    const { transport } = herdrTransport();
    const { svc, cmux } = service(new HerdrAdapter({ transportFactory: () => transport }));
    await svc.openView({ view: `rig:${RIG}`, provider: "cmux" });
    expect(cmux.last!.pages.map((p) => p.length)).toEqual([9, 8]);
    expect(PANES_PER_PAGE).toBe(9);
    expect(MAX_PER_WORKSPACE).toBe(12);
    expect(MAX_COLS).toBe(2);
  });

  it("workspace 命名规则仅适用于 Herdr：mission/slice/saved view 保留其 view id", () => {
    const view: ComposedView = { id: "mission:4.6", opened: [], absent: [], degraded: [], pages: [] };
    expect(planHerdrLayout(view, "t").workspaceLabel).toBe("mission:4.6");
  });
});
