// Slice 51-01 stub-runtime——仅用于测试的 RED，覆盖无争议的机械性 FACT 5（就绪状态如实性）。
//
// 生产代码暂缓（编辑前门禁）。stub adapter 类尚不存在，因此每个测试都在测试体内动态导入
// `../src/adapters/stub-runtime-adapter.js`——文件仍能被收集（其他同级测试若存在则保持 green），
// 且每项事实都会在导入处独立变为 red。但根据 Guard REV1，导入后的测试体完全可执行：
// 仅导出一个空壳 `StubRuntimeAdapter` 仍无法通过这些就绪断言（只有存活证据才能返回 ready；
// absent/exited/stale 证据必须返回 not-ready）。FACT3（有序双重投递）和 FACT4（感知 pod 的恢复派发）
// 分别在 startup-orchestrator.test.ts / restore-orchestrator.test.ts 中按生产层级验证。
//
// 确切的就绪机制（sidecar 文件、pane 标记等）属于修订包 / 首次生产 RED 的设计决策点（Guard）。
// 这些测试只通过具体注入的 fs/tmux 证据固定接口级契约：对于 live/ready 席位，
// ReadinessResult.ready 为 true；对于 absent/exited/stale 则为 false。下方注入的证据结构
// 是暂定设计，将在 adapter 发布时最终确定。
//
// FROZEN：不编码任何有争议的接口（hook channel / 结构化 usage_limit / compaction /
// script packaging），只验证就绪状态。
import { describe, it, expect, vi } from "vitest";

const STUB_ADAPTER_MODULE = "../src/adapters/stub-runtime-adapter.js";

// 暂定的注入依赖结构（依据最终发布的构造函数定稿）。存活席位：tmux session 存在，且存在 ready 标记/状态。
// 死亡席位：session 消失 / exited / stale。
function memFs(files: Record<string, string> = {}) {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" }); },
    exists: (p: string) => p in files,
    writeFile: vi.fn(),
  };
}
function tmuxWith(opts: { hasSession?: boolean; pane?: string }) {
  return {
    hasSession: vi.fn(async () => opts.hasSession ?? false),
    capturePaneContent: vi.fn(async () => opts.pane ?? ""),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  };
}
const binding = { tmuxSession: "dev-impl@test-rig", cwd: "/work" };

describe("StubRuntimeAdapter.checkReady——就绪状态如实性（RED：生产代码 CLEAR 前 adapter 不存在）", () => {
  // FACT5a——READY-POSITIVE 对照：存活席位（session 存在 + ready 证据）报告 ready。
  // 如果没有此正向对照，永远返回 not-ready 的实现也能通过所有反向测试。
  it("FACT5a：具有 ready 证据的存活席位报告 READY", async () => {
    const mod = await import(STUB_ADAPTER_MODULE) as { StubRuntimeAdapter: new (deps: unknown) => { checkReady(b: unknown): Promise<{ ready: boolean; code?: string }> } }; // 当前为 RED：模块不存在
    const adapter = new mod.StubRuntimeAdapter({ tmux: tmuxWith({ hasSession: true, pane: "STUB_READY\n" }), fsOps: memFs({ "/work/.openrig/stub/state.json": JSON.stringify({ ready: true }) }) });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "live/ready stub 席位必须报告 ready").toBe(true);
  });

  // FACT5b——ABSENT 反向场景：没有 session 和 state → not ready。
  it("FACT5b：stub 席位不存在（无 session/state）时报告 NOT ready", async () => {
    const mod = await import(STUB_ADAPTER_MODULE) as { StubRuntimeAdapter: new (deps: unknown) => { checkReady(b: unknown): Promise<{ ready: boolean }> } }; // 当前为 RED
    const adapter = new mod.StubRuntimeAdapter({ tmux: tmuxWith({ hasSession: false }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "不存在的 stub 席位不得报告 ready").toBe(false);
  });

  // FACT5c——EXITED 反向场景：已记录退出 → not ready。
  it("FACT5c：stub 进程已退出时报告 NOT ready", async () => {
    const mod = await import(STUB_ADAPTER_MODULE) as { StubRuntimeAdapter: new (deps: unknown) => { checkReady(b: unknown): Promise<{ ready: boolean }> } }; // 当前为 RED
    const adapter = new mod.StubRuntimeAdapter({ tmux: tmuxWith({ hasSession: true }), fsOps: memFs({ "/work/.openrig/stub/state.json": JSON.stringify({ ready: false, exited: { code: 1 } }) }) });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "已退出的 stub 进程不得报告 ready").toBe(false);
  });

  // FACT5d——STALE 反向场景：没有存活证据时，stale pane 字节不得证明当前仍存活。
  it("FACT5d：只有 stale pane 字节而没有存活证据时报告 NOT ready", async () => {
    const mod = await import(STUB_ADAPTER_MODULE) as { StubRuntimeAdapter: new (deps: unknown) => { checkReady(b: unknown): Promise<{ ready: boolean }> } }; // 当前为 RED
    const adapter = new mod.StubRuntimeAdapter({ tmux: tmuxWith({ hasSession: false, pane: "STUB_READY (stale)\n" }), fsOps: memFs() });
    const result = await adapter.checkReady(binding);
    expect(result.ready, "stale pane 字节不得证明当前仍存活").toBe(false);
  });
});
