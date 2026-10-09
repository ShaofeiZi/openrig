import { describe, it, expect, vi } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { StartupController, startupLines, type StartupSeat } from "../src/startup.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";

function fixture() {
  const seat: StartupSeat = { nodeId: "n1", logicalId: "operator.agent", runtime: "codex", model: "configured-model",
    revision: "rev1", hasHistory: true, intendedAction: "awaiting-decision", freshRequired: true, tokenState: "missing",
    reason: "No native history identity was recorded", observed: { state: "stopped", detail: "No terminal", sessionName: "operator-agent@kernel" } };
  const posts: Array<{ route: string; body: Record<string, string> }> = [];
  let response: (body: Record<string, string>) => Promise<Response> = async () => new Response(JSON.stringify({ ok: true }));
  let probeState = "up";
  const client = new DaemonClient({ baseUrl: "http://127.0.0.1:17433", headers: { Authorization: "Bearer test" },
    fetchImpl: (async (url, options) => {
      const route = new URL(String(url)).pathname;
      if (options?.method === "POST") { const body = JSON.parse(String(options.body)); posts.push({ route, body }); return response(body); }
      if (probeState === "down") throw new Error("connection refused");
      if (route === "/api/rigs/summary") return new Response(JSON.stringify([{ id: "r1", name: "kernel" }, { id: "bad", name: "unrelated-legacy" }]));
      return new Response(JSON.stringify({ rigId: "r1", rigName: "kernel", seats: [{ ...seat }] }));
    }) as typeof fetch,
  });
  const startDaemon = vi.fn(async () => { probeState = "up"; });
  const onWork = vi.fn();
  const onNative = vi.fn(async () => {});
  const controller = new StartupController({ client, home: "/private/instance", startDaemon, onWork, onNative, onChange: () => {},
    probe: async () => JSON.stringify(probeState === "down" ? { state: "down", discovery: { header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] } } : { state: probeState }),
  });
  return { controller, seat, posts, startDaemon, onWork, onNative, response: (fn: typeof response) => { response = fn; }, down: () => { probeState = "down"; } };
}
async function chooseOperator(f: ReturnType<typeof fixture>) { await f.controller.refresh(); await f.controller.key("enter"); }

describe("TUI 启动选择", () => {
  it("打开已有原生终端并刷新不启动，随后显式继续上下文", async () => {
    const f = fixture(); f.seat.observed.state = "attention_required"; f.seat.contextPending = true;
    await chooseOperator(f); await f.controller.key("o");
    expect(f.onNative).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "n1" }));
    expect(f.posts).toEqual([]);
    f.seat.observed.state = "running";
    await f.controller.key("c");
    expect(f.posts).toEqual([{ route: "/api/startup/r1/operator.agent", body: { action: "continue", revision: "rev1" } }]);
  });
  it("正向缺席后对歧义历史给出显式 fresh 选择", async () => {
    const f = fixture(); f.seat.intendedAction = "blocked"; f.seat.freshRequired = false; f.seat.freshAllowed = true;
    await chooseOperator(f); await f.controller.key("f");
    expect(f.controller.state.page).toBe("confirm");
    await f.controller.key("escape"); expect(f.posts).toEqual([]);
  });
  it("显示当前原生 gate 并打开已有席，不再启动", async () => {
    const f = fixture();
    f.seat.observed.state = "attention_required";
    f.seat.observed.detail = "Codex is waiting for hook trust approval";
    f.seat.freshAllowed = false;
    await chooseOperator(f);
    const text = startupLines(f.controller.state).map((line) => line.text).join("\n");
    expect(text).toContain("Codex is waiting for hook trust approval");
    expect(text).not.toContain("No native history identity was recorded");
    expect(text).not.toContain("Consider a fresh");
    await f.controller.key("enter");
    expect(f.posts).toEqual([]);
    expect(f.onWork).toHaveBeenCalledWith(expect.objectContaining({ rigId: "r1" }), expect.objectContaining({ nodeId: "n1" }));
  });
  it("把终端传输修复做成单独动作，不启动席", async () => {
    const f = fixture();
    f.seat.observed.state = "transport_unavailable"; f.seat.freshAllowed = false;
    f.response(async () => {
      f.seat.observed.state = "stopped"; f.seat.freshAllowed = true;
      return new Response(JSON.stringify({ ok: true }));
    });
    await chooseOperator(f);
    await f.controller.key("f"); expect(f.controller.state.page).toBe("seats");
    await f.controller.key("t");
    expect(f.posts).toEqual([{ route: "/api/startup/terminal", body: {} }]);
    await f.controller.key("f"); expect(f.controller.state.page).toBe("confirm");
    await f.controller.key("escape"); expect(f.posts).toHaveLength(1);
  });
  it("首次设置仅启动 daemon，随后给出审慎 rig 选择", async () => {
    const f = fixture(); f.down(); await f.controller.refresh();
    expect(f.controller.state.page).toBe("down");
    await f.controller.key("enter");
    expect(f.startDaemon).toHaveBeenCalledTimes(1);
    expect(f.posts).toEqual([]);
    expect(f.controller.state.page).toBe("rigs");
  });
  it("拒绝与刷新使 fresh 同意失效，无启动效果", async () => {
    const f = fixture(); await chooseOperator(f);
    await f.controller.key("f"); expect(f.controller.state.page).toBe("confirm");
    await f.controller.key("escape"); await f.controller.key("y");
    expect(f.posts).toEqual([]);
    await f.controller.key("f"); await f.controller.key("r"); await f.controller.key("y");
    expect(f.posts).toEqual([]);
  });
  it("即使实例路径很长，80x24 屏幕也显示 fresh 确认与拒绝", async () => {
    const f = fixture(); await chooseOperator(f); await f.controller.key("f");
    f.controller.state.home = "/long-instance".repeat(20);
    const screen = renderScreen(createViewState({ instanceId: "test" }).get(), emptySnapshot(), { cols: 80, rows: 24, startup: f.controller.state });
    expect(screen.lines.join("\n")).toContain("确认此全新启动");
    expect(screen.lines.join("\n")).toContain("拒绝；保持停止");
  });
  it("一次确认恰好发送该 seat/revision 一次，尽管重复输入", async () => {
    const f = fixture(); await chooseOperator(f);
    let finish!: (value: Response) => void;
    f.response(() => new Promise((resolve) => { finish = resolve; }));
    await f.controller.key("f");
    const first = f.controller.key("y"); await Promise.resolve();
    await f.controller.key("y"); await f.controller.key("enter");
    expect(f.posts).toEqual([{ route: "/api/startup/r1/operator.agent", body: { action: "fresh", revision: "rev1" } }]);
    f.seat.observed.state = "running";
    finish(new Response(JSON.stringify({ ok: true })));
    await first;
    expect(f.controller.state.consent).toBeUndefined();
    expect(f.controller.state.notice).toContain("新会话");
  });
  it("报告 producer 成功返回后观察到的 gate，而非重复其成功声明", async () => {
    const f = fixture();
    f.response(async () => {
      f.seat.observed = { ...f.seat.observed, state: "attention_required", detail: "Hook review needs a decision" };
      f.seat.freshAllowed = false;
      return new Response(JSON.stringify({ ok: true, message: "Previous conversation resumed." }));
    });
    await chooseOperator(f); await f.controller.key("enter");
    expect(f.controller.state.notice).toBe("Hook review needs a decision");
    expect(f.posts).toHaveLength(1);
  });
  it("丢失启动响应时读实际效果，绝不重复 POST", async () => {
    const f = fixture(); f.seat.intendedAction = "resume-original";
    f.response(async () => { f.seat.observed.state = "running"; f.seat.revision = "rev2"; throw new Error("response lost"); });
    await chooseOperator(f); await f.controller.key("enter");
    expect(f.posts).toHaveLength(1);
    await f.controller.key("enter");
    expect(f.posts).toHaveLength(1);
    expect(f.onWork).toHaveBeenCalledTimes(1);
  });
  it("provider 失败可见，且不以 fresh 作其解药", async () => {
    const f = fixture();
    f.response(async () => {
      f.seat.freshAllowed = false;
      f.seat.prerequisite = "Codex authentication is unavailable";
      return new Response(JSON.stringify({ ok: false, code: "provider_prerequisite", freshAllowed: false, message: f.seat.prerequisite }), { status: 409 });
    });
    await chooseOperator(f); await f.controller.key("enter"); await f.controller.key("f");
    expect(f.controller.state.page).toBe("seats");
    expect(startupLines(f.controller.state).map((line) => line.text).join("\n")).not.toContain("Consider a fresh");
    await f.controller.key("up"); await f.controller.key("r"); await f.controller.key("f");
    expect(f.controller.state.page).toBe("seats");
    expect(startupLines(f.controller.state).map((line) => line.text).join("\n")).toContain("authentication is unavailable");
    f.seat.freshAllowed = true; f.seat.prerequisite = undefined;
    await f.controller.key("r"); await f.controller.key("f");
    expect(f.controller.state.page).toBe("confirm");
  });
  it("在常规 shell 中渲染实际选中的席与鼠标动作", async () => {
    const f = fixture(); await chooseOperator(f);
    const snap = emptySnapshot(); const view = createViewState({ instanceId: "test", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols: 100, rows: 32, startup: f.controller.state });
    expect(screen.lines.join("\n")).toContain("operator.agent");
    expect(screen.lines.join("\n")).toContain("configured-model");
    expect(screen.hitMap.some((hit) => hit.action.type === "startup" && hit.action.key === "f")).toBe(true);
  });
});
