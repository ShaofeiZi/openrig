import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { dropW } from "../src/text-width.js";

const style = createStyle("truecolor");
describe("rig 存活经得住裁剪、选择与生命周期文本", () => {
  for (const [cols, rows] of [[80, 24], [140, 42]]) {
    for (const name of ["short", "long-rig-name-with-a-clipped-status-suffix"]) {
      for (const selected of [false, true]) for (const focused of [false, true]) {
        it(`${cols}x${rows} ${name} selected=${selected} focused=${focused}`, () => {
          for (const presence of [true, false, null]) {
            const snap = demoSnapshot();
            snap.hosts = [{ name: "host", reachable: true, rigs: [{ name, hasLiveAgents: presence, lifecycleState: presence === false ? "stopped" : "degraded", pods: [] }] }];
            const view = createViewState({ instanceId: "instance", getSnapshot: () => snap });
            const index = computeExplorerRows(view.get(), snap).findIndex(row => row.key === `rig:host/${name}`);
            const state = { ...view.get(), selection: selected ? index : 0, focusedPane: focused ? "explorer" as const : "content" as const };
            const screen = renderScreen(state, snap, { cols: cols!, rows: rows!, colorMode: "truecolor" });
            const painted = stylizeLines(screen, style);
            painted.forEach((line, i) => expect(stripAnsi(line)).toBe(screen.lines[i]));
            const y = screen.explorerRows.find(row => row.key === `rig:host/${name}`)!.y;
            const glyph = presence === null ? "?" : "▦";
            expect(painted[y - 1]).toContain(style.paint(presence === true ? "bright" : "dim", glyph,
              selected ? { bg: "selection", bold: focused } : {}));
            if (selected) expect(painted[y - 1]).toContain("48;2;34;52;82");
          }
        });
      }
    }
  }

  it("不可达主机用 unknown 覆盖陈旧正向存活，而非 stopped", () => {
    const snap = demoSnapshot(); snap.hosts[0]!.reachable = false;
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 42 });
    const y = screen.explorerRows.find(row => row.key === "rig:vm-host/openrig-build")!.y;
    expect(screen.lines[y - 1]).toContain("? openrig-build");
    expect(screen.lines[y - 1]).not.toContain("▦");
  });

  it.each([[80, 24], [140, 42]])("landing at %ix%i keeps instance context and the prompt without repeating the Explorer list", (cols, rows) => {
    const snap = demoSnapshot();
    snap.stream = [];
    snap.hosts[0]!.rigs.push({ name: "stopped-rig", pods: [], hasLiveAgents: false, lifecycleState: "stopped" });
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols, rows });
    const body = screen.lines.map(line => dropW(line, screen.explorerWidth + 1)).join("\n");
    expect(body).toContain("拓扑 · vm-host");
    expect(body).toContain("选择一个工作组");
    expect(body).toContain("2 个工作组");
    expect(body).not.toContain("openrig-build");
    expect(body).not.toContain("stopped-rig");
    expect(view.get().drill).toEqual([]);
    expect(screen.explorerRows.some(row => row.key === "rig:vm-host/stopped-rig")).toBe(true);
  });

  it("在 topology 落地页透传摘要存活，不做新的逐 rig 读取", async () => {
    const seen: string[] = [];
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url: string) => {
      const path = new URL(url).pathname; seen.push(path);
      const data = path === "/healthz" ? { selfHostId: "host" } : path === "/api/rigs/summary" ? [
        { id: "live", name: "live", lifecycleState: "degraded", hasLiveAgents: true },
        { id: "stopped", name: "stopped", lifecycleState: "stopped", hasLiveAgents: false },
        { id: "old", name: "older-daemon" },
      ] : [];
      return { ok: true, json: async () => data } as Response;
    }) as typeof fetch });
    const view = createViewState({ instanceId: "t", getSnapshot: demoSnapshot });
    const snap = await hydrateSnapshot(client, new Map(), null, null, null, view.get());
    expect(snap.hosts[0]!.rigs.map(r => r.hasLiveAgents)).toEqual([true, false, null]);
    expect(seen.filter(path => path === "/api/rigs/summary")).toHaveLength(1);
    expect(seen.filter(path => /^\/api\/rigs\/[^/]+\//.test(path))).toEqual([]);
  });
});
