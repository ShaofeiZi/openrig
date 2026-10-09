// OPR.0.4.1.10——zrig send 交互提示/权限阻塞防护：关键回归。复现 2026-06-20 的隐患
//（同级 rig-send 提交了开放 AskUserQuestion 的默认选项并发布版本），并证明默认情况下
// 不可能再发生。覆盖 impl-prd 的 K-1..K-6 及防护要求的修订测试（审计全有或全无、
// danger+wait 拒绝、发送就绪新鲜度回退）。检测器同时覆盖新鲜运行时 hook 路径和
// capture-pane 回退（Codex 唯一的提示防护——精确渲染来自
// qa-codex-approval-render-research-20260627）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

// 2026-06-20 事故中开放的发布授权 AskUserQuestion（高亮默认项在前）。
const SHIP_PROMPT = [
  "Authorize the 0.4.0 release?",
  "",
  "❯ 1. Authorize publish → @latest (Recommended)",
  "  2. Roll back",
  "  3. Hold",
].join("\n");

// Codex v0.139.0 命令审批的精确渲染（QA 调研）。Codex 不发出 needs_input hook，
// 因此 capture-pane 回退是它唯一的防护。
const CODEX_APPROVAL = [
  "  Would you like to run the following command?",
  "",
  "  Reason: Do you want to allow running exactly `touch /tmp/x`?",
  "",
  "  $ touch /tmp/x",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
].join("\n");

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: overrides?.hasSession ?? (async () => true),
    probeSession: async (name: string) =>
      (await (overrides?.hasSession ?? (async () => true))(name))
        ? { state: "present" as const }
        : { state: "absent" as const },
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle\n❯ "),
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

describe("OPR.0.4.1.10 zrig send 提示/权限防护（关键）", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let agentActivityStore: AgentActivityStore;
  let rigId: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    agentActivityStore = new AgentActivityStore({ db, eventBus });
    const rig = rigRepo.createRig("my-rig");
    rigId = rig.id;
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
  });

  // 预置 Codex 席位（Codex 不发出 needs_input Notification——它的防护由 PermissionRequest
  // hook（hook 优先）和 capture-pane 回退组成）。
  function seedCodexSeat(name = "dev-qa@my-rig") {
    const node = rigRepo.addNode(rigId, "dev.qa", { role: "worker", runtime: "codex" });
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name });
    return name;
  }
  afterEach(() => db.close());

  function makeTransport(tmux: TmuxAdapter, opts?: {
    withBus?: boolean;
    now?: () => Date;
    activityEndpointFile?: () => { baseUrl: string; token: string } | null;
  }) {
    return new SessionTransport({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux, agentActivityStore,
      ...(opts?.withBus === false ? {} : { eventBus }),
      ...(opts?.now ? { now: opts.now } : {}),
      ...(opts?.activityEndpointFile ? { activityEndpointFile: opts.activityEndpointFile } : {}),
    });
  }

  function spies() {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    return { sendText, sendKeys };
  }

  function overrideEvents(): Array<Record<string, unknown>> {
    const rows = db.prepare("SELECT payload FROM events WHERE type = 'transport.prompt_override' ORDER BY seq").all() as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  }

  // K-1：默认发送到停留在交互提示的 pane → 拒绝，不输入也不提交。
  it("K-1：默认发送到 AskUserQuestion 时拒绝（target_needs_input），且绝不输入或提交", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "STAND DOWN, do not ship");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(r.activity?.state).toBe("needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // K-1 通过新鲜运行时 hook（Claude permission_prompt）——主要检测路径。
  it("K-1（hook）：新鲜 permission_prompt hook 使默认发送拒绝，不输入/提交", async () => {
    agentActivityStore.recordHookEvent({ runtime: "claude-code", sessionName: "dev-impl@my-rig", hookEvent: "Notification", subtype: "permission_prompt" });
    const { sendText, sendKeys } = spies();
    // pane 看似空闲，但新鲜 hook 是权威依据 → 仍拒绝。
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "❯ \n  ⏵⏵ accept edits on", sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(r.activity?.evidenceSource).toBe("runtime_hook");
    expect(sendText).not.toHaveBeenCalled();
  });

  // K-3（隔离隐患）：--force 不绕过提示防护。
  it("K-3：对交互提示使用 --force 仍被拒绝（force 不绕过提示防护）", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "STAND DOWN", { force: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // K-4：只有 --dangerously-interact --reason 会驱动提示，并写入审计记录。
  it("K-4：--dangerously-interact --reason 驱动提示并写入 transport.prompt_override 审计", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "1", {
      dangerouslyInteract: true, reason: "unblock stuck release prompt", actorSession: "orch-lead@my-rig",
    });
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith("dev-impl@my-rig", "1");
    expect(sendKeys).toHaveBeenCalledWith("dev-impl@my-rig", ["C-m"]);
    const events = overrideEvents();
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "transport.prompt_override",
      sessionName: "dev-impl@my-rig",
      actorSession: "orch-lead@my-rig",
      detectedState: "needs_input",
      overrideReason: "unblock stuck release prompt",
    });
    // overrideReason（调用方）与 detectedReason（分类器）不同——不得混用。
    expect(typeof events[0]!.detectedReason).toBe("string");
    expect(events[0]!.detectedReason).not.toBe(events[0]!.overrideReason);
  });

  // K-5：通过 capture-pane 回退检测 Codex 审批提示（Codex 没有 needs_input hook）。
  it("K-5：通过 capture-pane 回退检测 Codex 命令审批渲染，并阻止 default/force", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => CODEX_APPROVAL, sendText }));
    const def = await t.send("dev-impl@my-rig", "hi");
    expect(def.ok).toBe(false);
    expect(def.reason).toBe("target_needs_input");
    expect(def.activity?.evidenceSource).toBe("pane_heuristic");
    const forced = await t.send("dev-impl@my-rig", "hi", { force: true });
    expect(forced.ok).toBe(false);
    expect(forced.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
  });

  // K-5 HOOK 优先（创始人扩展）：新鲜 Codex PermissionRequest hook 是主要信号——即使 pane
  // 看似空闲，也会阻止 default/raw/force（高风险防护不能依赖屏幕抓取）。只有
  // --dangerously-interact --reason 会驱动并审计。
  it("K-5（hook）：Codex PermissionRequest hook 优先——拒绝 default/raw/force，仅 --dangerously-interact 驱动并审计", async () => {
    const seat = seedCodexSeat();
    agentActivityStore.recordHookEvent({ runtime: "codex", sessionName: seat, hookEvent: "PermissionRequest", subtype: "Bash" });
    const { sendText, sendKeys } = spies();
    // pane 看似空闲，但新鲜 hook 是权威依据。
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "› ready\n\n  gpt-5.5 xhigh fast · Context [████ ] · ~/code", sendText, sendKeys }));

    const def = await t.send(seat, "hi");
    expect(def.ok).toBe(false);
    expect(def.reason).toBe("target_needs_input");
    expect(def.activity?.evidenceSource).toBe("runtime_hook"); // HOOK-PRIMARY, not screen-scrape
    expect(def.activity?.reason).toBe("permission_request");

    const raw = await t.send(seat, "/compact", {});
    expect(raw.ok).toBe(false);
    expect(raw.reason).toBe("target_needs_input");

    const forced = await t.send(seat, "hi", { force: true });
    expect(forced.ok).toBe(false);
    expect(forced.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();

    const drive = await t.send(seat, "1", { dangerouslyInteract: true, reason: "approve the blocked command", actorSession: "orch-lead@my-rig" });
    expect(drive.ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith(seat, "1");
    const ev = overrideEvents();
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ detectedState: "needs_input", detectedReason: "permission_request", overrideReason: "approve the blocked command" });
  });

  // 两条路径：hook 缺失（或过期）时，capture-pane 回退仍可捕获 Codex 审批渲染——
  // 因此任一路径都能维持防护。
  it("K-5（双路径）：没有 hook 时，capture-pane 回退仍可捕获 Codex 审批渲染", async () => {
    const seat = seedCodexSeat("dev-qa2@my-rig");
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => CODEX_APPROVAL, sendText }));
    const def = await t.send(seat, "hi");
    expect(def.ok).toBe(false);
    expect(def.reason).toBe("target_needs_input");
    expect(def.activity?.evidenceSource).toBe("pane_heuristic"); // fell back to the scan
    expect(sendText).not.toHaveBeenCalled();
  });

  // K-6（核心结论）：发送给发布授权提示的停止消息不能发布版本。
  it("K-6：发送给发布授权 AskUserQuestion 的停止消息不会提交该提示", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }));
    const r = await t.send("advisor@my-rig".replace("advisor@my-rig", "dev-impl@my-rig"), "STAND DOWN, brief-gated, do not ship");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    // 发布授权默认项从未被选中或提交。
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // 修订 1：审计必须全有或全无——没有 eventBus → 危险覆盖拒绝且不发送。
  it("修订：--dangerously-interact 没有审计 sink 时拒绝（prompt_override_audit_unavailable），不发送", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }), { withBus: false });
    const r = await t.send("dev-impl@my-rig", "1", { dangerouslyInteract: true, reason: "x" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("prompt_override_audit_unavailable");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // 修订：--dangerously-interact 没有 reason 时拒绝（domain 防线；路由/CLI 也拒绝）。
  it("修订：--dangerously-interact 没有 --reason 时拒绝，不发送", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText }));
    const r = await t.send("dev-impl@my-rig", "1", { dangerouslyInteract: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("dangerously_interact_requires_reason");
    expect(sendText).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.28 A 部分——反转 slice-28 前行为：过期但最新的 `idle` hook
  //（展示仍新鲜 <5 分钟，但超过 15 秒发送窗口）现在可以发送。按 seq 最新的 idle 证明没有
  // 更新活动（若席位开始工作，最新 hook 会是 UserPromptSubmit/PermissionRequest，而非 idle），
  // 因此发送相信 hook 顺序，而非 Codex 无法可靠解析的易抖动实时 pane（最初的
  // no_activity_signal 回归）。经 IMPL-SPEC §2.1 + orch-advisor 检查点 4 批准：hook 未触发的
  // 剩余风险有界且可恢复——只是向工作中席位粘贴文本，而非驱动提示——B 部分还会提升 hook
  // 可靠性。新鲜的非 idle hook 和 PermissionRequest 仍会阻塞（K-5 测试 :178-237 不变）。
  function seedStaleIdleHook(fixedNow: Date) {
    // Hook 报告 idle，记录于 90 秒前：展示仍新鲜（<5 分钟），但发送已过期（>15 秒）。
    agentActivityStore.recordHookEvent({
      runtime: "claude-code", sessionName: "dev-impl@my-rig", hookEvent: "Stop",
      occurredAt: new Date(fixedNow.getTime() - 90_000).toISOString(),
    });
  }

  it("A 部分：发送已过期的 IDLE hook + 干净 pane 可以发送（解除阻塞）", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    seedStaleIdleHook(fixedNow);
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "idle\n❯ ", sendText }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(sendText).toHaveBeenCalled();
  });

  it("A 部分：发送已过期的 IDLE hook + 无法解析的 pane 仍可发送（Codex 易抖动用例）", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    seedStaleIdleHook(fixedNow);
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true); // unknown pane does NOT veto → trust the stale-idle hook
    expect(sendText).toHaveBeenCalled();
  });

  // 防护代码审查阻断项 1：窄范围选择器/权限否决——过期 idle hook 不得在实际可见的
  // 选择器/权限提示上执行粘贴并回车。
  it("A 部分：发送已过期的 IDLE hook 被可见 AskUserQuestion 选择器否决（拒绝且不输入）", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    seedStaleIdleHook(fixedNow);
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText, sendKeys }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it("A 部分：发送已过期的 IDLE hook 被可见 Codex 审批提示否决（拒绝）", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    seedStaleIdleHook(fixedNow);
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => CODEX_APPROVAL, sendText, sendKeys }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.28 A 部分——不信任过期的非 idle（running）hook；它回退到实时 pane
  // 探针（保持不变；只有 stale-idle 是新行为）。
  it("A 部分：过期的非 idle（running）hook 回退到 pane 探针", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    agentActivityStore.recordHookEvent({
      runtime: "claude-code", sessionName: "dev-impl@my-rig", hookEvent: "UserPromptSubmit",
      occurredAt: new Date(fixedNow.getTime() - 90_000).toISOString(), // stale + running
    });
    const { sendText } = spies();
    // pane 为空闲：过期 running hook 未阻塞；发送通过 pane 继续。
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "idle\n❯ ", sendText }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    // 若信任过期 running hook，发送会以 mid_work 拒绝。现已继续 → 过期非 idle hook
    // 回退到 pane（不受信任）。
    expect(r.ok).toBe(true);
    expect(r.activity?.evidenceSource).not.toBe("runtime_hook");
    expect(sendText).toHaveBeenCalled();
  });

  // OPR.0.4.3.28 修正——反转“未知时失败关闭”。`unknown` 遥测（缺失/失败，而非选择器确证）
  // 现在携带非阻塞提示继续，并仍指明失败的 producer 链路。过去会以
  // target_activity_unknown 拒绝。Hook 是建议性遥测，不是发送授权。
  it("C 部分（反转）：unknown 携带指明后台服务摄取 producer 链路的提示继续（不泄漏 token）", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }));
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("producer-link：");
    expect(r.warning).toContain("daemon-ingest 链路中断");
    expect(sendText).toHaveBeenCalled();
  });

  // OPR.0.4.3.28 修正——席位环境缺少活动变量时，提示指明 SEAT-ENV 链路（只说明是否
  // 存在，绝不包含 token 值），发送仍继续（过去会拒绝）。
  it("C 部分（反转）：url/token 缺失时 unknown 携带指明 seat-env 链路的提示继续", async () => {
    const { sendText } = spies();
    const base = mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText });
    const tmux = Object.assign({}, base, { hasSessionEnv: async () => false }) as unknown as TmuxAdapter;
    const t = makeTransport(tmux);
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("seat-env 链路中断");
    expect(r.warning).toContain("MISSING"); // 指明缺失变量，而非其值。
    expect(sendText).toHaveBeenCalled();
  });

  it("tmux 环境查找无法证明 relay 变量时使用有效 activity-endpoint 文件", async () => {
    const { sendText } = spies();
    const base = mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText });
    const tmux = Object.assign({}, base, { hasSessionEnv: async () => false }) as unknown as TmuxAdapter;
    const t = makeTransport(tmux, {
      activityEndpointFile: () => ({ baseUrl: "http://127.0.0.1:7433", token: "present-but-never-rendered" }),
    });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("daemon-ingest 链路中断");
    expect(r.warning).not.toContain("MISSING");
    expect(r.warning).not.toContain("重新启动");
    expect(r.warning).not.toContain("present-but-never-rendered");
    expect(sendText).toHaveBeenCalled();
  });

  it("没有确认 endpoint 文件回退时，将 tmux session-env 查找失败报告为 unknown", async () => {
    const { sendText } = spies();
    const base = mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText });
    const tmux = Object.assign({}, base, { hasSessionEnv: async () => null }) as unknown as TmuxAdapter;
    const t = makeTransport(tmux);
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("seat-env 链路未知");
    expect(r.warning).not.toContain("MISSING");
    expect(r.warning).not.toContain("重新启动");
    expect(sendText).toHaveBeenCalled();
  });

  it("识别 relay 支持的端口与旧 token 环境路由", async () => {
    const { sendText } = spies();
    const base = mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText });
    const tmux = Object.assign({}, base, {
      hasSessionEnv: async (_sessionName: string, varName: string) =>
        varName === "OPENRIG_PORT" || varName === "RIGGED_ACTIVITY_HOOK_TOKEN",
    }) as unknown as TmuxAdapter;
    const t = makeTransport(tmux);
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("daemon-ingest 链路中断");
    expect(r.warning).not.toContain("seat-env 链路中断");
    expect(r.warning).not.toContain("重新启动");
    expect(sendText).toHaveBeenCalled();
  });

  // OPR.0.4.3.28 修正——`unknown` 遥测不再要求 --dangerously-interact 携带 --reason
  //（现在正常继续）；reason 门禁仅适用于选择器确证的 needs_input 用例。
  it("修正：--dangerously-interact 没有 --reason 时在 unknown 遥测（无选择器）上继续，且仍携带提示", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }));
    const r = await t.send("dev-impl@my-rig", "hi", { dangerouslyInteract: true });
    expect(r.ok).toBe(true);
    // B1 代码审查修复：无论是否使用 --dangerously-interact，unknown 遥测都附带提示——
    // 覆盖分支不再绕过 unknown 处理。
    expect(r.warning).toContain("producer-link：");
    expect(sendText).toHaveBeenCalled();
  });

  // OPR.0.4.3.28 B1 代码审查回归——审查者捕获的精确绕过：对实际 unknown 的 pane 使用
  // --dangerously-interact 和 --reason 时，仍必须返回 ok:true 并携带提示警告（过去
  // dangerouslyInteract 分支跳过 unknown 处理且不返回警告）。
  it("B1：对 unknown 遥测使用 --dangerously-interact + --reason 时返回 ok:true 并携带提示", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }));
    const r = await t.send("dev-impl@my-rig", "hi", { dangerouslyInteract: true, reason: "driving anyway", actorSession: "orch-lead@my-rig" });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("producer-link：");
    expect(sendText).toHaveBeenCalled();
  });

  // W2a-1 第 3 轮——producer 链路提示不得把新鲜代判定折叠为错误的时钟过期/席位安静警告。
  // 由解析器支持的 store + 未携带代的 hook ⇒ generation_unverifiable（状态 unknown、
  // stale:true，但 age 约为 0）。提示必须如实指明代原因（UNVERIFIABLE——该发出路径未携带），
  // 绝不能说“超出 store 窗口 / 席位安静”。这是 SessionTransport 接缝的惰性可见区分。
  it("W2a-1：新鲜 generation_unverifiable 读取产生代特定提示，而非时钟过期/席位安静", async () => {
    const now = new Date("2026-06-27T12:00:00.000Z");
    // 席位有 tenure（registerSession 已创建），因此存活代可解析；hook 未携带代
    // ⇒ generation_unverifiable（新鲜，age 约为 0）。
    const genStore = new AgentActivityStore({
      db,
      eventBus,
      now: () => now,
      resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    });
    genStore.recordHookEvent({
      runtime: "claude-code",
      sessionName: "dev-impl@my-rig",
      hookEvent: "UserPromptSubmit",
      occurredAt: now.toISOString(),
      // 有意不携带 generation ⇒ 记录 null ⇒ 无法验证。
    });
    const { sendText } = spies();
    const t = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: mockTmux({ capturePaneContent: async () => "xyzzy no prompt here", sendText }),
      agentActivityStore: genStore,
      now: () => now,
    });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("producer-link：");
    expect(r.warning).toContain("未携带 occupant generation"); // 区分 generation，而非时钟过期。
    expect(r.warning).toContain("发射方 launch 路径未提供 generation");
    expect(r.warning).toContain("Generation 无法验证，不表示席位安静");
    expect(r.warning).not.toContain("not yet wired");
    expect(r.warning).not.toContain("超出 store 窗口");
    expect(r.warning).not.toContain("席位已安静");
    expect(sendText).toHaveBeenCalled();
  });

  it("修订：发送窗口内的新鲜 hook（idle）是权威依据，发送继续", async () => {
    const fixedNow = new Date("2026-06-27T12:00:00.000Z");
    agentActivityStore.recordHookEvent({
      runtime: "claude-code", sessionName: "dev-impl@my-rig", hookEvent: "Stop",
      occurredAt: new Date(fixedNow.getTime() - 10_000).toISOString(),
    });
    const { sendText } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => SHIP_PROMPT, sendText }), { now: () => fixedNow });
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(true);
    expect(r.activity === undefined || r.activity?.evidenceSource === "runtime_hook").toBe(true);
    expect(sendText).toHaveBeenCalled();
  });

  // FR-1c：没有可见选择器的权限问题仍可被检测（Codex/Claude 稳健性）。
  it("FR-1c：视图中没有选择器的权限问题行被分类为 needs_input", async () => {
    const { sendText } = spies();
    const t = makeTransport(mockTmux({
      capturePaneContent: async () => ["Do you want to proceed with this deploy?", "", "  gpt-5.5 · Context [████ ] · ~/code"].join("\n"),
      sendText,
    }));
    const r = await t.send("dev-impl@my-rig", "hi");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
  });

  // 前向修复 1（调研：ntm e28763e / AgentDeck）——Claude Code 的高页脚（状态栏 + 权限提示
  // + 分隔线 + 输入框）将真实提示的选择器推到末尾 8 行之外时，仍必须检测。旧的 8 行扫描
  // 会漏掉此处距底部第 9 个非空行的选择器，并被最后一行 ⏵⏵ idle 栏误判为空闲 → 发送
  // 落到提示上。扩大到 12 行的提示扫描可以捕获它。
  const FOOTER_PUSHED_PROMPT = [
    "Allow this edit to session-transport.ts?",
    "",
    "❯ 1. Yes",
    "  2. Yes, allow all edits in domain/ this session",
    "  3. No, and tell Claude what to do differently",
    "  4. No, and keep this file read-only",
    "",
    "  Use ↑↓ to choose, enter to confirm",
    "",
    "──────────────── dev-impl@my-rig ────────────────",
    "❯ ",
    "──────────────────────────────────────────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
  ].join("\n");

  it("前向修复 1：被高页脚推到末尾 8 行之外的提示仍为 needs_input（不误判空闲）", () => {
    const c = classifyPaneActivity(FOOTER_PUSHED_PROMPT);
    expect(c.state).toBe("attention");
    expect(c.reason).toBe("selection_prompt");
  });

  it("前向修复 1：默认发送到被页脚推高的提示时被拒绝（不因误判空闲而发送）", async () => {
    const { sendText, sendKeys } = spies();
    const t = makeTransport(mockTmux({ capturePaneContent: async () => FOOTER_PUSHED_PROMPT, sendText, sendKeys }));
    const r = await t.send("dev-impl@my-rig", "looks good");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("target_needs_input");
    expect(sendText).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // 无回归：idle 默认仍交付；running + force 仍交付。
  it("idle 目标默认发送；running 目标现在携带提示交付（OPR.0.4.3.28 快速跟进——mid_work 降级，忙碌不阻塞）", async () => {
    const idleSpy = vi.fn(async () => ({ ok: true as const }));
    const idle = makeTransport(mockTmux({ capturePaneContent: async () => "Done.\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)", sendText: idleSpy }));
    const idleRes = await idle.send("dev-impl@my-rig", "hi");
    expect(idleRes.ok).toBe(true);
    expect(idleRes.warning).toBeUndefined(); // idle → clean send, no advisory
    expect(idleSpy).toHaveBeenCalled();

    const runSpy = vi.fn(async () => ({ ok: true as const }));
    const running = makeTransport(mockTmux({ capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt", sendText: runSpy }));
    // 对 running/busy pane 的默认（非 force）发送现在携带非阻塞提示继续
    //（过去为 ok:false mid_work）。needs_input 仍是唯一强制拒绝。
    const def = await running.send("dev-impl@my-rig", "hi");
    expect(def.ok).toBe(true);
    expect(def.warning).toContain("正在任务中");
    expect(def.warning).toContain("繁忙只是提示");
    // --force 现在在此路径上不执行额外操作（为向后兼容保留）——仍会交付。
    const forced = await running.send("dev-impl@my-rig", "hi", { force: true });
    expect(forced.ok).toBe(true);
    expect(runSpy).toHaveBeenCalled();
  });
});
