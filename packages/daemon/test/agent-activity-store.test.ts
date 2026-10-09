import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";

const NOW = new Date("2026-04-24T12:00:00.000Z");

describe("AgentActivityStore", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSession(runtime: "claude-code" | "codex" = "claude-code") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, runtime === "codex" ? "dev.qa" : "dev.impl", { runtime });
    const sessionName = runtime === "codex" ? "dev-qa@test-rig" : "dev-impl@test-rig";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, attachmentType: "tmux" });
    return { rig, node, session, sessionName };
  }

  it("将 Claude 提示词/tool hook 规范化为 running", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    const result = store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    expect(result.ok).toBe(true);
    const latest = store.getLatestForNode({
      nodeId: node.id,
      sessionName,
      now: NOW,
    });
    expect(latest).toMatchObject({
      state: "running",
      reason: "user_prompt_submit",
      evidenceSource: "runtime_hook",
      eventAt: "2026-04-24T11:59:00.000Z",
      rawEvent: "UserPromptSubmit",
      stale: false,
    });
  });

  it("将 Claude 权限通知规范化为 needs_input，将 idle_prompt 规范化为 idle", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "permission_prompt",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "idle_prompt",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "idle",
      reason: "idle_prompt",
      rawEvent: "Notification",
      rawSubtype: "idle_prompt",
    });
  });

  it("规范化 Claude PreToolUse 和 elicitation_dialog hook", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "PreToolUse",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "running",
      reason: "pre_tool_use",
      rawEvent: "PreToolUse",
    });

    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "Notification",
      subtype: "elicitation_dialog",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "needs_input",
      reason: "elicitation_dialog",
      rawEvent: "Notification",
      rawSubtype: "elicitation_dialog",
    });
  });

  it("将 Codex prompt-submit 规范化为 running，将 Stop 规范化为 idle", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:58:00.000Z",
    });
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "idle",
      reason: "stop",
      evidenceSource: "runtime_hook",
      rawEvent: "Stop",
    });
  });

  it("将 Codex PermissionRequest hook 规范化为 needs_input（OPR.0.4.1.10 hook-primary 生产者）", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    // Codex 官方审批 hook（openai/codex PR #17563）：hook_event_name=PermissionRequest，
    // relay 将 tool_name（例如 "Bash"）作为 subtype 转发。
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "PermissionRequest",
      subtype: "Bash",
      occurredAt: "2026-04-24T11:59:30.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "needs_input",
      reason: "permission_request",
      evidenceSource: "runtime_hook",
      rawEvent: "PermissionRequest",
      evidence: "Bash", // 指明正在审批的 tool
    });
  });

  it("将 Codex SessionStart 记录为已观察但未活跃", () => {
    const { node, sessionName } = seedSession("codex");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "SessionStart",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "session_start_observed",
      evidenceSource: "runtime_hook",
      rawEvent: "SessionStart",
    });
  });

  it("对于过期 hook 证据返回 unknown stale，而非 green 状态", () => {
    const { node, sessionName } = seedSession("claude-code");
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW, freshnessMs: 60_000 });
    store.recordHookEvent({
      runtime: "claude-code",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:50:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });

    expect(latest).toMatchObject({
      state: "unknown",
      reason: "stale_runtime_hook",
      evidenceSource: "runtime_hook",
      stale: true,
    });
  });

  it("拒绝缺少受管 session 身份的 hook 事件", () => {
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    const result = store.recordHookEvent({
      runtime: "claude-code",
      hookEvent: "UserPromptSubmit",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "missing_session_identity",
    });
  });
});

// W2a-1——GENERATION IDENTITY（SOURCE-BOUND）。来自先前 occupant generation 的声明不得被视为当前存活席位。
// 发出事件的 occupant generation 会以 source-bound 方式随 hook 携带（producer/relay 在触发时提供，
// route 负责摄取），绝不能根据记录时状态推断。这种推断会把延迟到达的前任 occupant hook 错归给当前 occupant，
// 而且在 1 秒精度和时钟偏移下，timing/boot_at 并不可靠。读取时解析 LIVE generation
//（session-registry currentOccupantTenure）并进行比较。场景如下：(1) carried != live ⇒ MISMATCH——
// unknown/generation_mismatch/stale，provenance 为 RESOLVED，并拒绝采信（这是前任 tenure 已失效的正向证据；
// 不受时序影响，同一秒也仍然不匹配）；(2) carried == live（包括同一 native 的 relaunch 延续）⇒ fresh，
// provenance 为 resolved；(3) 任一侧为 null ⇒ UNRESOLVABLE（缺少证据）：unknown + 不同的 reason
//（unresolvable = live 为 null / unverifiable = carried 缺失）+ stale，绝不 fresh；同时携带
// generationProvenance='unresolved'，使该行仍可 DELIVERED（tap verify-demotion 为后续工作）。carried 缺失
// 是按路径显式缺少：即使 managed launch/fresh-handover 生产者现在会携带 generation，也仍保证可靠且绝不误判 fresh；
// (4) 没有 resolver ⇒ legacy，无标签；(5) resolver EXCEPTION ⇒ 降级为 generation_resolver_error。
// 无知与证据必须得到不同结论，不得合并。
describe("AgentActivityStore——generation identity（W2a-1）", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedGenSession() {
    const rig = rigRepo.createRig("gen-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    const sessionName = "dev-qa@gen-rig";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName, attachmentType: "tmux" });
    return { node, sessionName };
  }

  // (1) DELAYED PRIOR-OCCUPANT / SAME-SECOND——该原子场景完全依靠 SOURCE-BINDING 而非时序闭环。
  // 当存活 occupant 为 gen-B 时，读取到携带先前 generation（gen-A）的 hook，应判定为 MISMATCH——
  // 即使处于同一挂钟秒也一样（这里不依赖计时；generation 是随事件携带而非推断，因此 boot_at 的 1 秒精度
  // 和时钟偏移无关）。绝不能将其呈现为当前存活 occupant 的 fresh 证据。这就是记录时推断版本会错误采信的
  // 延迟前任 occupant hook。
  it("携带的先前 generation 与 live 不同（同一秒）⇒ unknown/generation_mismatch，绝不 fresh", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => "gen-B", // 读取时的 LIVE occupant
    });

    // hook 携带其发出方 occupant 的 gen-A，在 gen-B 已存活时记录。
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
      generation: "gen-A",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "generation_mismatch",
      evidenceSource: "runtime_hook",
      stale: true,
      generationProvenance: "resolved", // 两个 generation 均已解析，只是彼此不同
    });
  });

  // (2) CARRIED == LIVE（包括 relaunch 延续）⇒ fresh。hook 携带的 generation 与 ledger 当前报告为 live 的
  // generation 相同（同一 native 的 relaunch 属于延续，不产生新 generation）。
  it("携带的 generation 等于 live（包括 relaunch 延续）⇒ fresh，provenance resolved", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => "gen-A",
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:30.000Z",
      generation: "gen-A",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "running",
      reason: "user_prompt_submit",
      stale: false,
      generationProvenance: "resolved",
    });
  });

  // (3a) UNRESOLVABLE——live 侧。尽管 hook 携带 gen-A，live generation 仍为 UNKNOWN（resolver ⇒ null）。
  // 这表示缺少证据，而不是认定 tenure 已失效：state UNKNOWN + 独立 reason + stale:true，绝不 fresh；
  // 同时携带 generationProvenance='unresolved'，使该行仍可 DELIVERED（tap verify-demotion 为后续工作）。
  // reason 与 (3b) 及 mismatch 均不同。
  it("无法解析 live generation（resolver ⇒ null）⇒ unknown/generation_unresolvable + unresolved、stale", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => null, // ledger 无法解析 LIVE occupant generation
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
      generation: "gen-A", // 已携带，但 live 侧未知 ⇒ 无法验证
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown", // 不为 fresh——不作虚假存活声明
      reason: "generation_unresolvable",
      stale: true,
      generationProvenance: "unresolved",
    });
  });

  // (3b) UNVERIFIABLE——carried 侧。此 hook 未携带 generation（legacy/excluded 或无 tenure 的发送路径
  // ⇒ 缺失 ⇒ null），因此无法与 live generation 核对。它与 (3a) 同属一类——unknown + 标签且绝不 fresh——
  // 但使用独立 reason（必须保持区分；无知有多种形态，合并会丢失取证信息）。Managed launch/fresh-handover
  // 生产者会携带 generation；显式缺失仍然可靠，且绝不误判 fresh。
  it("无法验证携带的 generation（hook 未携带）⇒ unknown/generation_unverifiable + unresolved、stale", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => "gen-B",
    });

    // 此发送路径未携带 generation ⇒ 记录为 null（可靠的按路径缺失）。
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "generation_unverifiable",
      stale: true,
      generationProvenance: "unresolved",
    });
  });

  // (4) ZERO-RIPPLE——未注入 resolver 时，读取行为不变且不携带 provenance 标签（legacy 的纯时钟路径）。
  // 这是生产环境不可达分支（生产始终注入 resolver——参见单一构造点门禁）；保持 green，
  // 确保该注入仍可安全选择启用。
  it("没有 generation resolver ⇒ legacy 行为，无标签", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({ db, eventBus, now: () => NOW });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:30.000Z",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({ state: "running", reason: "user_prompt_submit", stale: false });
    expect(latest?.generationProvenance).toBeUndefined();
  });

  // (2b) PURE-FRESHNESS 固定测试——按设计在基线为 GREEN（明确记录，避免被误认为无效测试）。只断言
  // 同一 generation 保持 fresh 的行为（基线已具备），刻意不断言新的 provenance 标签。这里变 red
  // 只明确表示 freshness 回归，绝不是“标签缺失”（上面的测试 (2) 守护标签）。每项声明对应一个固定测试：
  // 若同一测试可能因两个原因失败，就无法说明任何一个原因（P32——断言具有判别力的字段）。
  it("同一 generation ⇒ 保持 fresh——仅验证 freshness，不断言标签（基线及之后均为 green）", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => "gen-A",
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "UserPromptSubmit",
      occurredAt: "2026-04-24T11:59:30.000Z",
      generation: "gen-A",
    });

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest?.state).toBe("running");
    expect(latest?.stale).toBe(false);
    // 此处刻意不作 generationProvenance 断言——只判别 freshness。
  });

  // (5) 针对已发布 occupant-tenure ledger 的 MECHANISM 证明——不是常量 fake。读取侧 resolver 是真实的
  // currentOccupantTenure(nodeId).generationUuid；hook 携带通过真实 mintOccupantTenure 生成的发送方
  // generation。验证效果（store 是否遵循真实 ledger），而非表面指标。一次覆盖两个边界方向：同一 native
  // 的 relaunch 属于延续（live generation 仍等于所携带的 generation ⇒ fresh）；不同 native 的 occupant
  // 会生成新的 live generation（⇒ 携带的先前 generation 属于已失效 tenure ⇒ mismatch/refused）。
  it("真实 ledger：携带 gen-A 的 hook 经同一 native relaunch 后仍 fresh，遇到不同 native 的新 occupant 时不匹配", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    });

    // hook 携带发送方 occupant 通过真实 ledger 生成的 generation。
    const genA = sessionRegistry.mintOccupantTenure(node.id, "initial", "boot-A").generationUuid;
    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      occurredAt: "2026-04-24T11:59:00.000Z",
      generation: genA,
    });

    // RELAUNCH——相同 native id ⇒ mintOccupantTenure 返回现有 tenure（不产生新 generation），
    // 因而 LIVE generation 仍为 gen-A ⇒ carried == live ⇒ fresh。
    const genRelaunch = sessionRegistry.mintOccupantTenure(node.id, "initial", "boot-A").generationUuid;
    expect(genRelaunch).toBe(genA); // 延续关系由 ledger 证明，而非由 fake 预设
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "idle",
      reason: "stop",
      stale: false,
      generationProvenance: "resolved",
    });

    // NEW OCCUPANT——不同 native id 生成新的 live generation ⇒ 所携带的 gen-A 属于已失效 tenure。
    const genB = sessionRegistry.mintOccupantTenure(node.id, "initial", "boot-B").generationUuid;
    expect(genB).not.toBe(genA);
    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "unknown",
      reason: "generation_mismatch",
      stale: true,
      generationProvenance: "resolved",
    });
  });

  // (6) RESOLVER EXCEPTION ⇒ DEGRADE。live-generation resolver 抛出异常（临时 ledger/db 故障）。
  // 读取不得崩溃，也不得呈现为 fresh：应给出独立的 unknown/generation_resolver_error 结论、stale，
  // 且 provenance unresolved。记录阶段不会解析 generation（source-bound），因此记录也绝不抛出异常。
  it("读取时 resolver 异常 ⇒ unknown/generation_resolver_error（降级），且绝不崩溃", () => {
    const { node, sessionName } = seedGenSession();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => {
        throw new Error("occupant-tenure ledger unavailable");
      },
    });

    expect(() =>
      store.recordHookEvent({
        runtime: "codex",
        sessionName,
        hookEvent: "Stop",
        occurredAt: "2026-04-24T11:59:00.000Z",
        generation: "gen-A",
      }),
    ).not.toThrow();

    const latest = store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW });
    expect(latest).toMatchObject({
      state: "unknown",
      reason: "generation_resolver_error",
      stale: true,
      generationProvenance: "unresolved",
    });
  });

  it("携带的 generation 不在此节点 ledger 中时为 unresolvable，而非 mismatch", () => {
    const { node, sessionName } = seedGenSession();
    const unregistered = sessionRegistry.reserveOccupantGeneration();
    expect(unregistered).not.toBeNull();
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (nodeId, generation) =>
        sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      generation: unregistered,
    });

    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "unknown",
      reason: "generation_unresolvable",
      stale: true,
      generationProvenance: "unresolved",
    });
  });

  it("registered-generation membership resolver 故障时仍为 generation_resolver_error", () => {
    const { node, sessionName } = seedGenSession();
    const liveGeneration = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    const store = new AgentActivityStore({
      db,
      eventBus,
      now: () => NOW,
      resolveOccupantGeneration: () => liveGeneration,
      isRegisteredOccupantGeneration: () => {
        throw new Error("membership lookup failed");
      },
    });

    store.recordHookEvent({
      runtime: "codex",
      sessionName,
      hookEvent: "Stop",
      generation: liveGeneration,
    });

    expect(store.getLatestForNode({ nodeId: node.id, sessionName, now: NOW })).toMatchObject({
      state: "unknown",
      reason: "generation_resolver_error",
      stale: true,
      generationProvenance: "unresolved",
    });
  });
});
