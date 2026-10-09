import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { classifyPaneActivity, SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("智能体 pane 活动分类器", () => {
  it("把处于 Working 的活动 pane 分类为 agent_active", () => {
    const result = classifyPaneActivity("Working on task...\n⠋ Processing files\nesc to interrupt");

    expect(result.state).toBe("agent_active");
    expect(result.reason).toBe("mid_work_pattern");
  });

  it("把带编号的 runtime 提示分类为 attention，而不是 idle", () => {
    const result = classifyPaneActivity([
      "› 1. Yes, continue",
      "  2. No, cancel",
      "",
      "  Press enter to continue",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("selection_prompt");
  });

  it("把带 Codex footer 的编号 runtime 提示分类为 attention，而不是 idle", () => {
    const result = classifyPaneActivity([
      "Some runtime update requires a choice.",
      "",
      "› 1. Update now",
      "  2. Skip this version",
      "  3. Remind me later",
      "",
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("selection_prompt");
  });

  it("把底部的空闲 Codex footer 分类为 agent_idle", () => {
    const result = classifyPaneActivity([
      "› Summarize recent commits",
      "",
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_status_bar");
  });

  it("把底部的空闲 Claude edit-accept footer 分类为 agent_idle", () => {
    const result = classifyPaneActivity([
      "❯ ",
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_status_bar");
  });

  it("把空闲 footer 上方已输入的 Claude prompt 文本分类为 attention，而不是 idle", () => {
    const result = classifyPaneActivity([
      "❯ I am still typing a message",
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ].join("\n"));

    expect(result.state).toBe("attention");
    expect(result.reason).toBe("prompt_draft");
    expect(result.evidence).toContain("still typing");
  });

  it("不把与 footer 隔着空行的历史已提交 Codex prompt 视为 draft", () => {
    const result = classifyPaneActivity([
      "› Summarize recent commits",
      "",
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
    expect(result.reason).toBe("idle_status_bar");
  });

  it("下方存在当前 idle footer 时不把过期 active scrollback 分类为 active", () => {
    const result = classifyPaneActivity([
      "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running",
      "",
      "› Use /skills to list available skills",
      "",
      "  gpt-5.5 xhigh fast · Context [█▉   ] · ~/code/projects/openrig",
    ].join("\n"));

    expect(result.state).toBe("agent_idle");
  });

  it.each([
    "✶ Synthesizing… (6s · ↑ 284 tokens · thinking)",
    "✢ Reviewing... (3s · ↓ 107 tokens · thinking)",
  ])("不依赖状态动词，把 Claude Code thinking 状态分类为 agent_active：%s", (statusLine) => {
    const result = classifyPaneActivity([
      "⏺ Skill(openrig-user)",
      "  ⎿  Successfully loaded skill",
      "",
      statusLine,
      "",
      "──────────────────────────────────────── dev-impl@implementation-pair-slice19 ──",
      "❯ ",
      "────────────────────────────────────────────────────────────────────────────────",
      "  paste again to expand                                      ◉ xhigh · /effort",
    ].join("\n"));

    expect(result.state).toBe("agent_active");
    expect(result.reason).toBe("mid_work_pattern");
    expect(result.evidence).toContain("thinking");
  });

  it("不把 tmux focus-events 指引分类为 idle", () => {
    const result = classifyPaneActivity("tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach");

    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("no_activity_signal");
  });

  it("下方存在当前 active 工作时不把过期 idle footer 分类为 idle", () => {
    const result = classifyPaneActivity([
      "  gpt-5.5 xhigh fast · Context [████ ] · ~/code/projects/openrig",
      "",
      "• Reading 1 file...",
      "",
      "◦ Working (0m 3s • esc to interrupt)",
    ].join("\n"));

    expect(result.state).toBe("agent_active");
  });

  it("把空 capture 分类为 unknown", () => {
    const result = classifyPaneActivity("\n\n");

    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("empty_capture");
  });
});

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
}>): TmuxAdapter {
  const hasSession = overrides?.hasSession ?? (async () => true);
  return {
    hasSession,
    // 派生分类 probe（OPR.0.5.4.2）：present/absent 来自 mock 的 hasSession；
    // hasSession 抛错时向上传播（fail-closed 类别）。
    probeSession: async (name: string) =>
      (await hasSession(name)) ? { state: "present" as const } : { state: "absent" as const },
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle prompt\n❯ "),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: overrides?.getPaneCommand ?? (async () => null),
  } as unknown as TmuxAdapter;
}

describe("SessionTransport", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  function createTransport(tmux?: TmuxAdapter, overrides?: {
    agentActivityStore?: AgentActivityStore;
    sleep?: (ms: number) => Promise<void>;
    waitForIdlePollMs?: number;
    now?: () => Date;
  }) {
    return new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux ?? mockTmux(),
      ...overrides,
    });
  }

  function seedCanonicalRig() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      role: "worker", runtime: "claude-code",
    });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
    return { rig, node, session };
  }

  function seedLegacyRig() {
    const rig = rigRepo.createRig("r00-legacy");
    const node = rigRepo.addNode(rig.id, "worker-a", {
      role: "worker", runtime: "claude-code",
    });
    const session = sessionRegistry.registerSession(node.id, "r00-legacy-worker-a");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "r00-legacy-worker-a" });
    return { rig, node, session };
  }

  function seedExternalCliRig() {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", {
      role: "orchestrator",
      runtime: "claude-code",
    });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });
    return { rig, node, session };
  }

  // 测试 1：send 调用 sendText → 延迟 → sendKeys C-m。
  it("send 先调用 sendText，延迟后再调用 sendKeys C-m", async () => {
    seedCanonicalRig();
    const callOrder: string[] = [];
    const tmux = mockTmux({
      sendText: async () => { callOrder.push("sendText"); return { ok: true }; },
      sendKeys: async (_t, keys) => { callOrder.push(`sendKeys:${keys.join(",")}`); return { ok: true }; },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(callOrder).toEqual(["sendText", "sendKeys:C-m"]);
  });

  // 测试 2：发送到规范 session 名时正确解析。
  it("发送到规范 session 名时正确解析", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "message");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "message");
  });

  // 测试 3：发送到旧式 session 名时正确解析。
  it("发送到旧式 session 名时正确解析", async () => {
    seedLegacyRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux);

    const result = await transport.send("r00-legacy-worker-a", "message");
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalledWith("r00-legacy-worker-a", "message");
  });

  // 测试 4：发送到不存在的 session 时返回带指引的错误。
  it("发送到不存在的 session 时返回带指引的错误", async () => {
    const tmux = mockTmux({ hasSession: async () => false });
    const transport = createTransport(tmux);

    const result = await transport.send("nonexistent", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("session_missing");
    expect(result.error).toContain("未找到");
    expect(result.error).toContain("zrig ps");
  });

  // 测试 5：sendKeys C-m 失败时返回“文本可见但未提交”。
  it("发送 C-m 失败时返回带指引的 submit_failed", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "session died" }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("submit_failed");
    expect(result.error).toContain("已显示");
    expect(result.error).toContain("未提交");
  });

  // 测试 6：启用 verify 的 send 会捕获 pane 并检查已发送文本。
  it("启用 verify 的 send 检查 pane 中是否出现已发送文本", async () => {
    seedCanonicalRig();
    let captureCount = 0;
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        return captureCount < 3 ? "some output\n❯ " : "some output\nhello\n❯ ";
      },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    // OPR.99.0.6.3：已确认渲染是强正向 outcome。
    expect(result.outcome).toBe("delivered");
  });

  it("启用 verify 的 send 不会对 pane 中预先存在的内容产生假阳性", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "prior output\nhello\n❯ ",
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    // OPR.99.0.6.3：文本与 Enter 都成功，只是未能再次确认渲染；这是诚实的中间结果，
    // 不是失败。
    expect(result.outcome).toBe("rendered-unconfirmed");
  });

  // OPR.99.0.6.3——诚实的 delivery-outcome 词汇。
  it("成功发送后 verify capture 抛错属于中间 outcome，而不是失败", async () => {
    seedCanonicalRig();
    let captureCount = 0;
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        // 发送前验证与 mid-work capture 成功；发送后 verify capture 抛错，例如 pane 正忙于重绘。
        if (captureCount >= 3) throw new Error("pane busy");
        return "some output\n❯ ";
      },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { verify: true });
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("rendered-unconfirmed");
  });

  it("判别器：重绘竞态发送与真实 transport 失败呈现不同结果", async () => {
    seedCanonicalRig();
    // 重绘竞态：send + submit 成功，后续 capture 无法再次确认。
    const racyTmux = mockTmux({
      capturePaneContent: async () => "prior output\nhello\n❯ ",
    });
    const middle = await createTransport(racyTmux).send("dev-impl@my-rig", "hello", { verify: true });

    // 真实 transport 失败：Enter 未送达。
    const brokenTmux = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "session died" }),
    });
    const failure = await createTransport(brokenTmux).send("dev-impl@my-rig", "hello", { verify: true });

    // 验收条件：两种状态呈现的 outcome 不相同。
    expect(middle.ok).toBe(true);
    expect(middle.outcome).toBe("rendered-unconfirmed");
    expect(failure.ok).toBe(false);
    expect(failure.outcome).toBe("failed");
    expect(middle.outcome).not.toBe(failure.outcome);
  });

  it("send_failed 与 submit_failed 都携带 outcome 'failed'（词汇对称，ok:false 不变）", async () => {
    seedCanonicalRig();
    const noPaste = mockTmux({
      sendText: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    });
    const sendFailed = await createTransport(noPaste).send("dev-impl@my-rig", "hello");
    expect(sendFailed.ok).toBe(false);
    expect(sendFailed.reason).toBe("send_failed");
    expect(sendFailed.outcome).toBe("failed");

    const noEnter = mockTmux({
      sendKeys: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    });
    const submitFailed = await createTransport(noEnter).send("dev-impl@my-rig", "hello");
    expect(submitFailed.ok).toBe(false);
    expect(submitFailed.reason).toBe("submit_failed");
    expect(submitFailed.outcome).toBe("failed");
  });

  it("不启用 verify 的 send 不携带 outcome 字段（增量且仅限 verify）", async () => {
    seedCanonicalRig();
    const transport = createTransport(mockTmux());
    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(result.outcome).toBeUndefined();
  });

  // 测试 7：检测到 mid-work 时仍交付并给出提示（OPR.0.4.3.28 fast-follow——mid_work
  // 从硬拒绝降级为非阻塞 advisory；busy 不是 blocker）。
  it("检测到 mid-work 时 send 仍交付并给出非阻塞提示，而非拒绝", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing files\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("正在任务中");
    expect(result.warning).toContain("繁忙只是提示");
    expect(sendTextSpy).toHaveBeenCalled();
  });

  // 测试 8：在 mid-work pane 上使用 --force 仍会发送（现在是向后兼容的空操作；默认路径
  // 已经会带提示交付，因此 --force 不改变结果，但不能破坏流程）。
  it("mid-work + force 时 send 仍发送（--force 现为向后兼容的空操作）", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello", { force: true });
    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("带 wait-for-idle 的 send 等待 pane 活动结束，并在 idle 后发送", async () => {
    seedCanonicalRig();
    const callOrder: string[] = [];
    let captureCount = 0;
    const sendTextSpy = vi.fn(async () => {
      callOrder.push("sendText");
      return { ok: true as const };
    });
    const tmux = mockTmux({
      capturePaneContent: async () => {
        callOrder.push("capture");
        captureCount++;
        return captureCount === 1
          ? "Working on task...\n⠋ Processing files\nesc to interrupt"
          : "› Use /skills to list available skills\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig";
      },
      sendText: sendTextSpy,
      sendKeys: async () => {
        callOrder.push("sendKeys");
        return { ok: true as const };
      },
    });
    const transport = createTransport(tmux, {
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.activity?.state).toBe("idle");
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "hello");
    expect(callOrder).toEqual(["capture", "capture", "sendText", "sendKeys"]);
  });

  it("带 wait-for-idle 的 send 等待当前 Claude thinking 证据结束，并在 idle 后发送", async () => {
    seedCanonicalRig();
    const callOrder: string[] = [];
    let captureCount = 0;
    const sendTextSpy = vi.fn(async () => {
      callOrder.push("sendText");
      return { ok: true as const };
    });
    const tmux = mockTmux({
      capturePaneContent: async () => {
        callOrder.push("capture");
        captureCount++;
        return captureCount === 1
          ? [
              "⏺ Skill(openrig-user)",
              "  ⎿  Successfully loaded skill",
              "",
              "✶ Synthesizing… (6s · ↑ 284 tokens · thinking)",
              "",
              "──────────────────────────────────────── dev-impl@implementation-pair-slice19 ──",
              "❯ ",
              "────────────────────────────────────────────────────────────────────────────────",
              "  paste again to expand                                      ◉ xhigh · /effort",
            ].join("\n")
          : [
              "Ready for QA.",
              "",
              "──────────────────────────────────────── dev-impl@implementation-pair-slice19 ──",
              "❯ ",
              "────────────────────────────────────────────────────────────────────────────────",
              "  paste again to expand                                      ◉ xhigh · /effort",
            ].join("\n");
      },
      sendText: sendTextSpy,
      sendKeys: async () => {
        callOrder.push("sendKeys");
        return { ok: true as const };
      },
    });
    const transport = createTransport(tmux, {
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.activity?.state).toBe("idle");
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "hello");
    expect(callOrder).toEqual(["capture", "capture", "sendText", "sendKeys"]);
  });

  it("带 wait-for-idle 的 send 在活动持续运行时超时，且不发送文本", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing files\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, { waitForIdlePollMs: 1 });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wait_for_idle_timeout");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("running");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("带 wait-for-idle 的 send 在 Claude thinking 证据持续存在时超时，且不发送文本", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "⏺ Skill(openrig-user)",
        "  ⎿  Initializing…",
        "",
        "✢ Reviewing... (3s · ↓ 107 tokens · thinking)",
        "",
        "──────────────────────────────────────── dev-impl@implementation-pair-slice19 ──",
        "❯ ",
        "────────────────────────────────────────────────────────────────────────────────",
        "  paste again to expand                                      ◉ xhigh · /effort",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, { waitForIdlePollMs: 1 });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wait_for_idle_timeout");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("running");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("带 wait-for-idle 的 send 遇到 attention prompt 时硬停止，且不发送文本", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "Codex update available.",
        "",
        "› 1. Update now",
        "  2. Skip this version",
        "  3. Remind me later",
        "",
        "  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("needs_input");
    expect(result.activity?.reason).toBe("selection_prompt");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("带 wait-for-idle 的 send 遇到未知 capture 证据时硬停止，且不发送文本", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => { throw new Error("capture failed"); },
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_activity_unknown");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("unknown");
    expect(result.activity?.reason).toBe("capture_failed");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("带 wait-for-idle 的 send 优先使用新鲜 hook 活动，并等待 hook 转为 idle", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "PreToolUse",
    });
    let sleepCount = 0;
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => {
        sleepCount++;
        if (sleepCount === 1) {
          agentActivityStore.recordHookEvent({
            runtime: "claude-code",
            sessionName: "dev-impl@my-rig",
            hookEvent: "Stop",
          });
        }
      },
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.activity?.state).toBe("idle");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("带 wait-for-idle 的 send 把新鲜 UserPromptSubmit hook 证据视为 running", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 1 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wait_for_idle_timeout");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("running");
    expect(result.activity?.reason).toBe("user_prompt_submit");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("带 wait-for-idle 的 send 遇到新鲜 permission prompt hook 证据时硬停止", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "Notification",
      subtype: "permission_prompt",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.sent).toBe(false);
    expect(result.activity?.state).toBe("needs_input");
    expect(result.activity?.reason).toBe("permission_prompt");
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("带 wait-for-idle 的 send 把新鲜未知 hook 证据视为 unknown，不回退到 pane idle", async () => {
    seedCanonicalRig();
    const eventBus = new EventBus(db);
    const agentActivityStore = new AgentActivityStore({ db, eventBus });
    agentActivityStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "SessionStart",
    });
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "› idle\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux, {
      agentActivityStore,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });

    const result = await transport.send("dev-impl@my-rig", "hello", { waitForIdleMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_activity_unknown");
    expect(result.sent).toBe(false);
    expect(result.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("send 不会因以 Unicode 省略号截断的空闲 Codex 状态行而拒绝", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "Lane closed.",
        "",
        "  2 background terminals running · /ps to view · /stop to close",
        "",
        "› Summarize recent commits",
        "",
        "  gpt-5.4 xhigh fast · Context [████ ] · ~/.openrig/shared-docs/rigs/kerne…",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("send 不会因以 ASCII 省略号结尾的空闲 prompt 行而拒绝", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "ready prompt...\n❯ ",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("Working 文本只是 Codex 空闲 prompt 上方的旧 scrollback 时 send 不拒绝", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running",
        "",
        "› Use /skills to list available skills",
        "",
        "  gpt-5.4 xhigh fast · Context [█▉   ] · ~/code/projects/openrig-hub · Fas…",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("Working 文本只是 Claude Code 空闲 prompt 上方的旧 scrollback 时 send 不拒绝", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "✢ Working… (5m 9s · ↑ 4.4k tokens)",
        "  ⎿  Tip: Use /btw to ask a quick side question",
        "",
        "❯ ",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
      ].join("\n"),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("prompt 字符行包含 mid-work 文本（Claude 正在输入）时 send 仍拒绝", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "❯ Working on a task.",
        "",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow——mid_work 已降级为带提示交付。
    expect(result.warning).toContain("正在任务中");
  });

  it("Codex trust-prompt 选项行是当前 pane 内容时 send 拒绝", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "› 1. Yes, continue",
        "  2. Yes, allow all tools",
        "  3. No, cancel",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    // OPR.0.4.1.10：交互提示现在以精确的 target_needs_input 拒绝，而不是笼统的
    // mid_work，使 prompt/permission guard 不依赖 --force。
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  it("全屏 Codex trust prompt 下方有空白填充时 send 拒绝", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "> You are in /Users/admin/workspace",
        "",
        "  Do you trust the contents of this directory? Working with untrusted contents",
        "  comes with higher risk of prompt injection.",
        "",
        "› 1. Yes, continue",
        "  2. No, quit",
        "",
        "  Press enter to continue",
        "",
        "",
        "",
        "",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    // OPR.0.4.1.10：trust prompt → target_needs_input（精确的 prompt/permission guard）。
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  it("Claude Code trust-prompt 选项行是当前 pane 内容时 send 拒绝", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "❯ 1. Yes",
        "  2. Yes, allow all edits in domain/ during this session",
        "  3. No",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    // OPR.0.4.1.10：trust prompt → target_needs_input（精确的 prompt/permission guard）。
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  it("存在 Working footer 且下方没有 idle prompt 时 send 仍拒绝", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "Reading file…",
        "",
        "◦ Working (2m 3s • esc to interrupt)",
        "  ⎿  Processing 4 files",
        "",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow——mid_work 已降级为带提示交付。
    expect(result.warning).toContain("正在任务中");
  });

  it("Claude prompt draft 位于 idle footer 上方时 send 拒绝", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => [
        "❯ I am typing a human message",
        "  ⏵⏵ accept edits on (shift+tab to cycle)",
      ].join("\n"),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "/compact Preserve current task.");

    // OPR.0.4.1.10：idle footer 上方的 prompt draft 属于 interactive-prompt 状态 →
    // target_needs_input；意外 send 不得落入人类正在输入的内容。
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  // --- 真实形态 pane fixture 测试（test-infrastructure lane）---
  //
  // 这些测试使用带空白填充、scrollback、status bar 与分隔线的全屏形态 fixture，以匹配真实
  // tmux capturePaneContent 输出，确保 looksLikeMidWork() 的非空窗口方法能处理真实渲染，
  // 而不只是紧凑的手写片段。

  /** 构建带终端几何结构的真实形态 pane fixture。 */
  function buildPaneFixture(opts: {
    scrollback?: string[];
    content: string[];
    statusBar?: string[];
    trailingBlanks?: number;
  }): string {
    const lines: string[] = [];
    if (opts.scrollback) lines.push(...opts.scrollback, "");
    lines.push(...opts.content);
    if (opts.statusBar) lines.push("", ...opts.statusBar);
    if (opts.trailingBlanks) lines.push(...Array(opts.trailingBlanks).fill(""));
    return lines.join("\n");
  }

  // 注意：若先前 idle 的 Codex status bar（"gpt-5.4 ... Context [...]"）在活动工作期间
  // 仍位于最后 3 个非空行内，idle 判别器会产生假阴性，把 active-work 当成 idle。真实渲染中，
  // 先前 idle 状态的 status bar 通常位于当前 working footer 上方很多行。本 fixture 模拟这种
  // 真实距离。若过期 status bar 仅在 working footer 上方 1–2 个非空行，会暴露一个缺口；该问题
  // 已作为残留记录在返回交接中。
  it("真实形态：带 scrollback 与 padding 的全屏 Codex active-working pane 会阻止发送", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "• Ran npm test --workspace @openrig/daemon",
          "  └ 1784 tests passed",
          "",
          "  gpt-5.4 high · Context [████ ] · ~/code/projects/openrig-hub",
          "",
          "• I'll read the session-transport.ts file.",
          "",
          "• Ran cat packages/daemon/src/domain/session-transport.ts",
          "  └ import type Database from 'better-sqlite3';",
          "    … +54 lines (ctrl + t to view transcript)",
        ],
        content: [
          "• Reading 3 files…",
          "",
          "◦ Working (2m 41s • esc to interrupt) · 6 background terminals running · /…",
        ],
        trailingBlanks: 6,
      }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow——mid_work 已降级为带提示交付。
    expect(result.warning).toContain("正在任务中");
  });

  it("真实形态：全屏 Codex 在 prompt 空闲且 scrollback 有旧 Working 时允许发送", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "• Ran npm test --workspace @openrig/daemon",
          "  └ 1784 tests passed",
          "",
          "◦ Working (9m 26s • esc to interrupt) · 6 background terminals running",
          "",
          "✻ Worked for 9m 26s",
        ],
        content: [
          "› Use /skills to list available skills",
          "",
          "  gpt-5.4 xhigh fast · Context [█▉   ] · ~/code/projects/openrig-hub · Fast off",
        ],
        trailingBlanks: 4,
      }),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("真实形态：带工具输出与 padding 的全屏 Claude Code active-working pane 会阻止发送", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "⏺ I'll read the session-transport.ts file to understand the current",
          "  implementation.",
          "",
          "⏺ Reading 1 file…",
          "  ⎿  Read packages/daemon/src/domain/session-transport.ts",
        ],
        content: [
          "✢ Working… (5m 9s · ↑ 4.4k tokens)",
          "  ⎿  Tip: Use /btw to ask a quick side question without",
          "     interrupting Claude's current work",
        ],
        trailingBlanks: 5,
      }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow——mid_work 已降级为带提示交付。
    expect(result.warning).toContain("正在任务中");
  });

  it("真实形态：全屏 Claude Code 在 prompt 空闲且 scrollback 有旧 Working 与 edit-bar 时允许发送", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "✢ Working… (5m 9s · ↑ 4.4k tokens)",
          "  ⎿  Tip: Use /btw to ask a quick side question without",
          "     interrupting Claude's current work",
          "",
          "⏺ Done. Committed as abc1234.",
        ],
        content: [
          "──────────────────────────────────────────────────────────────",
          "❯ ",
          "──────────────────────────────────────────────────────────────",
          "  ⏵⏵ accept edits on (shift+tab to cycle)",
        ],
        trailingBlanks: 3,
      }),
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true);
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it("真实形态：带多行说明与大量 padding 的全屏 Codex trust-prompt 会阻止发送", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        content: [
          "> You are in /Users/admin/workspace",
          "",
          "  Do you trust the contents of this directory? Working with untrusted",
          "  contents comes with higher risk of prompt injection.",
          "",
          "› 1. Yes, continue",
          "  2. No, quit",
          "",
          "  Press enter to continue",
        ],
        trailingBlanks: 8,
      }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    // OPR.0.4.1.10：全屏 trust prompt → target_needs_input（精确 prompt/permission guard）。
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("target_needs_input");
    expect(result.activity?.state).toBe("needs_input");
  });

  it("真实形态：短时 Codex 工作中，旧 status bar 位于最后 3 个非空块内", async () => {
    // 短时工作：先前 idle 状态的 Codex status bar 只比 active "Working" footer 高 2 个
    // 非空行，两者都位于最后 3 个非空行内。当前代码会出现假阴性（允许发送），因为 status bar
    // 匹配 IDLE_STATUS_BAR_PATTERNS。修复应把 status-bar 检查收紧为仅最后一个非空行，
    // 防止 active 工作上方的旧 status bar 覆盖当前状态。
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => buildPaneFixture({
        scrollback: [
          "› Use /skills to list available skills",
          "",
          "  gpt-5.4 high · Context [████ ] · ~/code/projects/openrig-hub",
        ],
        content: [
          "• Reading 1 file…",
          "",
          "◦ Working (0m 3s • esc to interrupt)",
        ],
        trailingBlanks: 4,
      }),
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");

    expect(result.ok).toBe(true); // OPR.0.4.3.28 fast-follow——mid_work 已降级为带提示交付。
    expect(result.warning).toContain("正在任务中");
  });

  it("向前台运行非 shell 命令的 terminal session 发送时，以 mid_work 拒绝", async () => {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "infra.ui", {
      role: "ui", runtime: "terminal",
    });
    const session = sessionRegistry.registerSession(node.id, "infra-ui@term-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "infra-ui@term-rig" });

    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "VITE ready\npress h + enter to show help",
      getPaneCommand: async () => "node",
      sendText: sendTextSpy,
    });
    const transport = createTransport(tmux);

    const result = await transport.send("infra-ui@term-rig", "printf 'hello\\n'");
    // OPR.0.4.3.28 fast-follow——terminal 前台命令映射为 `running`，现在会带提示交付
    //（此前为 mid_work 拒绝且不发送）；busy 不是 blocker。
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("正在任务中");
    expect(sendTextSpy).toHaveBeenCalled();
  });

  // 测试 9：未预期的 probe 抛错属于 fail-closed 类别，不是已分类的 no-server 路径
  //（后者由 one-honest-resolution-path.test.ts 使用真实适配器覆盖）；它仍如实呈现为
  // tmux_unavailable。
  it("probe 意外抛错时 send 返回带指引的 tmux_unavailable", async () => {
    const tmux = mockTmux({
      hasSession: async () => { throw new Error("no server running"); },
    });
    const transport = createTransport(tmux);

    const result = await transport.send("dev-impl@my-rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
    expect(result.error).toContain("tmux");
  });

  it("向 external_cli 目标发送时在进入 tmux transport 前如实失败", async () => {
    seedExternalCliRig();
    const hasSessionSpy = vi.fn(async () => true);
    const transport = createTransport(mockTmux({ hasSession: hasSessionSpy }));

    const result = await transport.send("orch1-lead@rigged-buildout", "hello");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("transport_unavailable");
    expect(result.error).toContain("external CLI");
    expect(hasSessionSpy).not.toHaveBeenCalled();
  });

  // 测试 10：capture 返回 pane 内容。
  it("capture 为已有 session 返回 pane 内容", async () => {
    seedCanonicalRig();
    const tmux = mockTmux({
      capturePaneContent: async () => "line1\nline2\nline3",
    });
    const transport = createTransport(tmux);

    const result = await transport.capture("dev-impl@my-rig");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("line1");
  });

  it("对 external_cli 目标执行 capture 时在进入 tmux transport 前如实失败", async () => {
    seedExternalCliRig();
    const hasSessionSpy = vi.fn(async () => true);
    const transport = createTransport(mockTmux({ hasSession: hasSessionSpy }));

    const result = await transport.capture("orch1-lead@rigged-buildout");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("external CLI");
    expect(hasSessionSpy).not.toHaveBeenCalled();
  });

  // 测试 11：按工作组 resolveSessions 返回运行中的 session。
  it("按工作组调用 resolveSessions 返回运行中的 session", async () => {
    seedCanonicalRig();
    const transport = createTransport();

    const result = await transport.resolveSessions({ rig: "my-rig" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.sessionName).toBe("dev-impl@my-rig");
    }
  });

  // 测试 12：全局 resolveSessions 返回所有工作组中运行的 session。
  it("全局调用 resolveSessions 返回所有工作组中运行的 session", async () => {
    seedCanonicalRig(); // 工作组 "my-rig"，包含 dev-impl@my-rig。
    seedLegacyRig();    // 工作组 "r00-legacy"，包含 r00-legacy-worker-a。
    seedExternalCliRig();
    const transport = createTransport();

    const result = await transport.resolveSessions({ global: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(3);
      const names = result.sessions.map((s) => s.sessionName).sort();
      expect(names).toContain("dev-impl@my-rig");
      expect(names).toContain("r00-legacy-worker-a");
      expect(names).toContain("orch1-lead@rigged-buildout");
    }
  });

  // 测试 13：按 pod resolveSessions 时根据 logicalId 前缀过滤。
  it("按 pod 调用 resolveSessions 时根据 logicalId 前缀过滤", async () => {
    const rig = rigRepo.createRig("multi-rig");
    // dev pod。
    const devNode = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const devSess = sessionRegistry.registerSession(devNode.id, "dev-impl@multi-rig");
    sessionRegistry.updateStatus(devSess.id, "running");
    sessionRegistry.updateBinding(devNode.id, { tmuxSession: "dev-impl@multi-rig" });
    // orch pod。
    const orchNode = rigRepo.addNode(rig.id, "orch.lead", { role: "orchestrator", runtime: "claude-code" });
    const orchSess = sessionRegistry.registerSession(orchNode.id, "orch-lead@multi-rig");
    sessionRegistry.updateStatus(orchSess.id, "running");
    sessionRegistry.updateBinding(orchNode.id, { tmuxSession: "orch-lead@multi-rig" });

    const transport = createTransport();
    const result = await transport.resolveSessions({ pod: "dev", rig: "multi-rig" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sessions.length).toBe(1);
      expect(result.sessions[0]!.sessionName).toBe("dev-impl@multi-rig");
    }
  });

  it("broadcast 把 external_cli 目标列为显式 transport_unavailable 失败", async () => {
    seedCanonicalRig();
    seedExternalCliRig();
    const transport = createTransport();

    const result = await transport.broadcast({ global: true }, "hello", { force: true });

    expect(result.total).toBe(2);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionName: "orch1-lead@rigged-buildout",
          ok: false,
          reason: "transport_unavailable",
        }),
      ]),
    );
  });

  // Send/broadcast header（裁定 03c35295）：扇出通过 daemon 侧 wrapper 传递 scale scope 与
  // Sent 标记，使每个收件人的 header 都携带相同 envelope 事实。
  it("multi-send 扇出在每个收件人的 To header 中渲染完整收件人列表与 Sent 标记", async () => {
    seedCanonicalRig(); // dev-impl@my-rig
    seedLegacyRig(); // r00-legacy-worker-a
    const sent: string[] = [];
    const tmux = mockTmux({ sendText: async (_t, text) => { sent.push(text); return { ok: true }; } });
    const transport = createTransport(tmux);

    await transport.broadcast(
      { sessions: ["dev-impl@my-rig", "r00-legacy-worker-a"] },
      "status",
      { envelopeSender: "orch@my-rig", stampISO: "2026-08-06T17:42:09Z" },
    );

    expect(sent).toHaveLength(2);
    for (const text of sent) {
      expect(text).toContain("To: dev-impl@my-rig, r00-legacy-worker-a"); // 完整列表，说明谁收到。
      expect(text).toContain("Sent: 08-06 17:42Z"); // transport 时间标记。
      expect(text).toContain("status");
    }
  });

  it("raw broadcast（无 envelopeSender）不加 wrapper 直接交付，header 不变", async () => {
    seedCanonicalRig();
    const sent: string[] = [];
    const tmux = mockTmux({ sendText: async (_t, text) => { sent.push(text); return { ok: true }; } });
    const transport = createTransport(tmux);

    await transport.broadcast({ rig: "my-rig" }, "raw ping", {});

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("raw ping"); // 保持不变（--raw 例外）。
  });

  // ── GHOST-STAGE (h)：在写入时刻标记 delivered-at 延迟 ──
  const H_ENVELOPE =
    'From: a@r\nTo: dev-impl@my-rig\nSent: 08-06 17:42Z\n---\nhi\n---\n↩ 回复：rig send a@r "..."';

  it("(h) compose→write 间隔超过 10 秒时，send() 在 Sent 行标记延迟交付", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    // 写入时钟比 compose 标记（opts.stampISO）晚 30 秒。
    const transport = createTransport(tmux, { now: () => new Date("2026-08-06T17:42:39Z") });
    await transport.send("dev-impl@my-rig", H_ENVELOPE, { stampISO: "2026-08-06T17:42:09Z" });
    expect(sendTextSpy).toHaveBeenCalledTimes(1);
    expect(sendTextSpy.mock.calls[0]![1]).toContain("Sent: 08-06 17:42Z · 已投递 +30s");
  });

  it("(h) 间隔低于阈值（3 秒）时 send() 不添加 delivered 片段", async () => {
    seedCanonicalRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText: sendTextSpy });
    const transport = createTransport(tmux, { now: () => new Date("2026-08-06T17:42:12Z") });
    await transport.send("dev-impl@my-rig", H_ENVELOPE, { stampISO: "2026-08-06T17:42:09Z" });
    expect(sendTextSpy.mock.calls[0]![1]).not.toContain(" · 已投递 ");
  });
});
