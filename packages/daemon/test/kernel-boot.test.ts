// V0.3.1 切片 05 kernel-rig-as-default——kernel 自动启动测试。
//
// 覆盖 HG-2（变体选择）、HG-3（认证阻塞三段式错误）、HG-4（已受管时直接返回）和
// HG-6（通过 OPENRIG_NO_KERNEL 环境变量传递 --no-kernel flag）。前向修复 #3 的架构
// 修订：bootKernelIfNeeded 现在返回 KernelBootTracker，bootstrap 在后台运行。测试等待
// microtask，以观察 bootstrap 完成后的 tracker 状态。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootKernelIfNeeded,
  selectVariant,
  kernelAlreadyManaged,
  authBlockMessage,
  type KernelBootDeps,
} from "../src/domain/kernel-boot.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { EventBus } from "../src/domain/event-bus.js";

function makeRigRepo(existingRigs: Array<{ id?: string; name: string }>): RigRepository {
  return {
    listRigs: () => existingRigs,
    findRigsByName: (name: string) => existingRigs.filter((r) => r.name === name),
  } as unknown as RigRepository;
}

function makeSessionRegistry(sessionsByRig: Record<string, Array<{ sessionName: string; runtime?: string; startupStatus: string }>> = {}): SessionRegistry {
  return {
    getSessionsForRig: (rigId: string) => sessionsByRig[rigId] ?? [],
  } as unknown as SessionRegistry;
}

function makeEventBus(): { bus: EventBus; emitted: Array<{ type: string }> } {
  const emitted: Array<{ type: string }> = [];
  const bus = {
    emit: (event: { type: string }) => {
      emitted.push(event);
      return event;
    },
  } as unknown as EventBus;
  return { bus, emitted };
}

function makeBootstrapMock(result?: { errors?: string[]; throwError?: Error }) {
  return {
    bootstrap: vi.fn(async () => {
      if (result?.throwError) throw result.throwError;
      return {
        runId: "test",
        status: "ok",
        stages: [],
        errors: result?.errors ?? [],
        warnings: [],
      };
    }),
  } as unknown as BootstrapOrchestrator;
}

/** 等待尚未执行的 microtask，使 tracker 的 bootstrap Promise handler 能在读取状态前触发。
 *  对于在同一 tick 内 resolve 的 vi.fn 异步 mock，一次 setImmediate 跳转已经足够。 */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeBaseDeps(
  overrides: Partial<KernelBootDeps>,
  specsDir: string,
): KernelBootDeps {
  return {
    rigRepo: makeRigRepo([]),
    sessionRegistry: makeSessionRegistry(),
    eventBus: makeEventBus().bus,
    bootstrapOrchestrator: makeBootstrapMock(),
    specsDir,
    cwdOverride: specsDir,
    probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
    log: () => {},
    degradedTimeoutMs: 0, // 默认测试禁用 degraded timer。
    ...overrides,
  };
}

let tmpSpecsDir: string;

beforeEach(() => {
  tmpSpecsDir = mkdtempSync(join(tmpdir(), "kernel-boot-"));
  const kernelDir = join(tmpSpecsDir, "rigs/launch/kernel");
  mkdirSync(kernelDir, { recursive: true });
  writeFileSync(join(kernelDir, "rig.yaml"), "name: kernel\n");
  writeFileSync(join(kernelDir, "rig-claude-only.yaml"), "name: kernel\n");
  writeFileSync(join(kernelDir, "rig-codex-only.yaml"), "name: kernel\n");
});

afterEach(() => {
  delete process.env.OPENRIG_NO_KERNEL;
  if (tmpSpecsDir) rmSync(tmpSpecsDir, { recursive: true, force: true });
});

describe("selectVariant——认证状态到变体的映射", () => {
  it("两个 runtime 都可用时选择 rig.yaml", () => {
    expect(selectVariant({ claudeCode: "ok", codex: "ok" })).toBe("rig.yaml");
  });
  it("只有 Claude 可用时选择 rig-claude-only.yaml", () => {
    expect(selectVariant({ claudeCode: "ok", codex: "unavailable" })).toBe("rig-claude-only.yaml");
  });
  it("只有 Codex 可用时选择 rig-codex-only.yaml", () => {
    expect(selectVariant({ claudeCode: "unavailable", codex: "ok" })).toBe("rig-codex-only.yaml");
  });
});

describe("kernelAlreadyManaged——直接返回谓词", () => {
  it("存在名为 kernel 的 rig 时返回 true", () => {
    expect(kernelAlreadyManaged(makeRigRepo([{ name: "kernel" }, { name: "other" }]))).toBe(true);
  });
  it("没有名为 kernel 的 rig 时返回 false（区分大小写）", () => {
    expect(kernelAlreadyManaged(makeRigRepo([{ name: "Kernel" }, { name: "other" }]))).toBe(false);
  });
  it("rig 列表为空时返回 false", () => {
    expect(kernelAlreadyManaged(makeRigRepo([]))).toBe(false);
  });
});

describe("authBlockMessage——三段式错误契约", () => {
  it("按 building-agent-software skill 规范包含错误、原因和修复三行", () => {
    const msg = authBlockMessage();
    expect(msg).toMatch(/^错误：/m);
    expect(msg).toMatch(/^原因：/m);
    expect(msg).toMatch(/^修复：/m);
    expect(msg).toContain("claude auth login");
    expect(msg).toContain("codex login");
  });
});

describe("bootKernelIfNeeded——直接返回分支", () => {
  it("OPENRIG_NO_KERNEL=1 时返回 skipped tracker", async () => {
    process.env.OPENRIG_NO_KERNEL = "1";
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("skipped");
    expect(tracker.getStatus().detail).toBe("OPENRIG_NO_KERNEL=1");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("kernel rig 已受管时返回 skipped tracker", async () => {
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      rigRepo: makeRigRepo([{ name: "kernel" }]),
      bootstrapOrchestrator: bootstrap,
    }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("skipped");
    expect(tracker.getStatus().detail).toContain("已受管");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("两个 runtime 都不可用时返回 auth_blocked tracker", async () => {
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: bootstrap,
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: "unavailable" }),
    }, tmpSpecsDir));
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("auth_blocked");
    expect(status.detail).toMatch(/^错误：Kernel rig 无法启动/);
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("选定的变体文件不存在时返回 spec_missing tracker", async () => {
    rmSync(join(tmpSpecsDir, "rigs/launch/kernel/rig.yaml"));
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("spec_missing");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });
});

describe("bootKernelIfNeeded——触发后不等待的 bootstrap", () => {
  it("使用解析出的变体和正确选项在后台触发 bootstrap", async () => {
    // 暂停 bootstrap mock，以便在 Promise resolve 前确定性地观察进行中的 booting 状态。
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => { release = r; });
    const bootstrap = {
      bootstrap: vi.fn(async () => {
        await blocked;
        return { runId: "t", status: "ok", stages: [], errors: [], warnings: [] };
      }),
    } as unknown as BootstrapOrchestrator;
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("booting");
    expect(tracker.getStatus().variant).toBe("rig.yaml");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).toHaveBeenCalledOnce();
    const opts = (bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap.mock.calls[0]![0];
    expect(opts.mode).toBe("apply");
    expect(opts.sourceRef).toBe(join(tmpSpecsDir, "rigs/launch/kernel", "rig.yaml"));
    expect(opts.sourceKind).toBe("rig_spec");
    expect(opts.autoApprove).toBe(true);
    expect(opts.cwdOverride).toBe(tmpSpecsDir);
    release();
    tracker.stop();
  });

  it("orchestrator 返回错误时在 flush 后转换为 bootstrap_failed", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: makeBootstrapMock({ errors: ["preflight: tmux missing"] }),
    }, tmpSpecsDir));
    await flushPromises();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toContain("tmux missing");
    tracker.stop();
  });

  it("orchestrator 抛错时在 flush 后转换为 bootstrap_failed 并呈现错误信息", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: makeBootstrapMock({ throwError: new Error("network blip") }),
    }, tmpSpecsDir));
    await flushPromises();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toBe("network blip");
    tracker.stop();
  });

  it("只有 Claude 可用时使用 claude-only 变体", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "unavailable" }),
    }, tmpSpecsDir));
    expect(tracker.getStatus().variant).toBe("rig-claude-only.yaml");
    tracker.stop();
  });

  it("只有 Codex 可用时使用 codex-only 变体", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: "ok" }),
    }, tmpSpecsDir));
    expect(tracker.getStatus().variant).toBe("rig-codex-only.yaml");
    tracker.stop();
  });
});
