// OPR.0.4.6.02 C3——TerminalService 编排（所有 view kind 的唯一 composer）。使用注入依赖与
// fake provider 的纯编排：
//  - view 解析优先级：mission:/slice:（只读）· rig 名 + rig:<id> 别名（交互式）· saved view
//    （逐 member 只读）· unknown；
//  - 解析失败（unknown provider / view_required / view_not_found）也使用同一个共享
//    {opened,absent,degraded} 结果结构；
//  - 如实呈现部分结果：死亡的本地 seat（has-session false）进入 absent[]；
//  - 交给 provider 的组合 view 携带 composer 的 partition。

import { describe, it, expect } from "vitest";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import type {
  ComposedView,
  OpenViewResult,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
} from "../src/domain/terminal/terminal-provider.js";
import type { LiveSeatRow, SavedView } from "../src/domain/terminal/terminal-views-store.js";

/** 记录收到的组合 view 并报告成功的 provider。 */
class RecordingProvider implements TerminalProvider {
  readonly name: string;
  lastView: ComposedView | null = null;
  constructor(name: string) {
    this.name = name;
  }
  async status(): Promise<ProviderStatus> {
    return { provider: this.name, available: true, capabilities: { layout: true } };
  }
  async liveness(): Promise<ProviderLiveness> {
    return { alive: true };
  }
  async openView(view: ComposedView): Promise<OpenViewResult> {
    this.lastView = view;
    return {
      provider: this.name,
      ok: view.opened.length > 0,
      opened: view.opened.map((p) => p.seat),
      absent: view.absent,
      degraded: view.degraded,
      pages: view.pages.length,
    };
  }
}

const rigRows: LiveSeatRow[] = [
  { canonicalSessionName: "dev-driver@acme-build", attachmentType: "tmux", tmuxSession: "dev-driver@acme-build", rigName: "acme-build", logicalId: "dev.driver" },
  { canonicalSessionName: "rev-r1@acme-build", attachmentType: "tmux", tmuxSession: "rev-r1@acme-build", rigName: "acme-build", logicalId: "rev.r1" },
];

const savedView: SavedView = {
  id: "watchtower",
  name: "Watchtower",
  members: [
    { seat: "lead@acme-ops", tmuxSession: "lead@acme-ops", readOnly: true },
    { seat: "builder@acme-ops", tmuxSession: "builder@acme-ops" },
  ],
};

function makeDeps(overrides: Partial<TerminalServiceDeps> = {}): {
  deps: TerminalServiceDeps;
  herdr: RecordingProvider;
  cmux: RecordingProvider;
} {
  const herdr = new RecordingProvider("herdr");
  const cmux = new RecordingProvider("cmux");
  const providerMap: Record<string, TerminalProvider> = { herdr, cmux };
  const deps: TerminalServiceDeps = {
    resolveProvider: (name) => providerMap[name] ?? null,
    viewsStore: {
      get: (id) => (id === savedView.id ? savedView : null),
      list: () => [savedView],
    },
    listRigSeats: (rigArg) => (rigArg === "acme-build" || rigArg === "rig-id-1" ? rigRows : null),
    listPodSeats: (rigArg, pod) => (rigArg === "acme-build" && pod === "dev" ? [rigRows[0]!] : null),
    listScopeSeats: (scope) =>
      scope === "mission:4.6" || scope === "slice:02"
        ? [{ canonicalSessionName: "dev-driver@acme-build", attachmentType: "tmux", tmuxSession: "dev-driver@acme-build", rigName: "acme-build", logicalId: "dev.driver" }]
        : null,
    listRigNames: () => ["acme-build"],
    resolveHost: () => null,
    hasSession: () => true,
    ...overrides,
  };
  return { deps, herdr, cmux };
}

describe("TerminalService——view 解析 + 统一结构结果", () => {
  it("将 rig 名作为交互式派生 view 打开（读写 pane）", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "acme-build" });
    expect(res.provider).toBe("herdr");
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["dev-driver@acme-build", "rev-r1@acme-build"]);
    // 交互式 → 组合 pane 命令中没有 `-r`。
    expect(herdr.lastView?.opened.every((p) => p.readOnly === false)).toBe(true);
    expect(herdr.lastView?.opened[0]?.paneCommand).toBe("tmux attach -t 'dev-driver@acme-build'");
  });

  it("rig:<id> 别名形式解析到同一个 rig（rig 范围 route delegation）", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "rig:rig-id-1" });
    expect(res.ok).toBe(true);
    expect(herdr.lastView?.id).toBe("rig:rig-id-1");
    expect(res.opened.length).toBe(2);
  });

  it("将 pod:<rig>/<pod> 作为交互式派生 view 打开（AC-5 launcher target）", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "pod:acme-build/dev" });
    expect(res.ok).toBe(true);
    expect(res.opened).toEqual(["dev-driver@acme-build"]);
    expect(herdr.lastView?.opened.every((p) => p.readOnly === false)).toBe(true);
    expect(herdr.lastView?.id).toBe("pod:acme-build/dev");
  });

  it("畸形或未知 pod view → view_not_found", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    expect((await svc.openView({ view: "pod:acme-build" })).code).toBe("view_not_found"); // no /pod
    expect((await svc.openView({ view: "pod:acme-build/ghost" })).code).toBe("view_not_found"); // unknown pod
  });

  it("将 mission:/slice: 作为只读派生 view 打开（跨 rig 观测）", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "mission:4.6" });
    expect(res.ok).toBe(true);
    expect(herdr.lastView?.opened.every((p) => p.readOnly === true)).toBe(true);
    expect(herdr.lastView?.opened[0]?.paneCommand).toContain("attach -r -t");
  });

  it("打开带逐 member 只读设置的 saved view", async () => {
    const { deps, herdr } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "watchtower" });
    expect(res.ok).toBe(true);
    const byReadOnly = Object.fromEntries((herdr.lastView?.opened ?? []).map((p) => [p.seat, p.readOnly]));
    expect(byReadOnly["lead@acme-ops"]).toBe(true);
    expect(byReadOnly["builder@acme-ops"]).toBe(false);
  });

  it("路由到具名 provider（cmux best-effort）", async () => {
    const { deps, cmux } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "acme-build", provider: "cmux" });
    expect(res.provider).toBe("cmux");
    expect(cmux.lastView).not.toBeNull();
  });

  it("在 absent[] 中点名死亡的本地 seat（通过 has-session 细化如实呈现部分结果）", async () => {
    const { deps } = makeDeps({ hasSession: (s) => s !== "rev-r1@acme-build" });
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "acme-build" });
    expect(res.opened).toEqual(["dev-driver@acme-build"]);
    expect(res.absent.map((a) => a.seat)).toContain("rev-r1@acme-build");
    // 带名称的部分 open 仍为 ok（披露，而非失败）。
    expect(res.ok).toBe(true);
  });

  it("未知 view → 统一结构，code 为 view_not_found", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "no-such-thing" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("view_not_found");
    expect(res.opened).toEqual([]);
  });

  it("无法解析的显式 rig:<x> 为 view_not_found（绝不回退到 saved）", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "rig:watchtower" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("view_not_found");
  });

  it("未知 provider → code unknown_provider（400 类），不执行组合", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "acme-build", provider: "tmate" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("unknown_provider");
  });

  it("空 view → code view_required", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.openView({ view: "   " });
    expect(res.code).toBe("view_required");
  });

  it("listViews 返回 saved view 和可打开的 rig 名", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const res = await svc.listViews();
    expect(res.saved.map((v) => v.id)).toEqual(["watchtower"]);
    expect(res.rigs).toEqual(["acme-build"]);
  });

  it("status 报告每个 provider；未知具名 provider 如实标为 unavailable", async () => {
    const { deps } = makeDeps();
    const svc = new TerminalService(deps);
    const all = await svc.status();
    expect(all.providers.map((p) => p.name).sort()).toEqual(["cmux", "herdr"]);
    const one = await svc.status("tmate");
    expect(one.providers[0]?.status.available).toBe(false);
  });
});

describe("统一 terminal catalog inventory", () => {
  it("使用一个 batch 处理派生 entry，并保留完整默认 catalog", async () => {
    const normal = makeDeps();
    const expected = await new TerminalService(normal.deps).listViews(true);
    let batches = 0; let singles = 0;
    const batched = makeDeps({
      listRigSeats: () => { singles++; return rigRows; },
      listRigSeatsBatch: names => { batches++; expect(names).toEqual(["acme-build"]); return new Map([["acme-build", rigRows]]); },
    });
    const actual = await new TerminalService(batched.deps).listViews(true);
    expect(actual).toEqual(expected);
    expect(batches).toBe(1);
    expect(singles).toBe(0);
    expect(batched.herdr.lastView).toBeNull();
  });
});
