// OPR.0.4.3.06——启动证明（挑战验证的定向）诚实矩阵。
//
// 关键不变量：只有正确、绑定身份、属于本次启动且内容正确的证明才能设置
// `oriented=verified`。裸 ACK、空值、错误、重放或身份不匹配的证明都会被拒绝
//（仅追加），绝不会显示为 verified。`ready`（startup_status）绝不表示已定向。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import {
  issueStartupChallenge,
  verifyStartupProof,
  deriveOriented,
  buildOrientedMap,
  computeContractHash,
  computeExpectedAnswer,
} from "../src/domain/startup-proof.js";
import { activityRoutes } from "../src/routes/activity.js";

const CONTRACT = JSON.stringify([{ path: "role.md", effectiveId: "guidance/role.md" }]);

function setup() {
  const db = createFullTestDb();
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus });
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const rig = rigRepo.createRig("test-rig");
  const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "codex" });
  const sessionName = "dev-worker@test-rig";
  sessionRegistry.registerSession(node.id, sessionName);
  return { db, eventBus, store, rigId: rig.id, nodeId: node.id, sessionName };
}

describe("启动证明——签发与验证", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it("VERIFIED 设置 oriented=verified（仅追加的已接受证据）", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    // 证明前：已挑战但尚未证明。
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");

    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: challenge.challengeId,
      answer: challenge.expectedAnswer,
    });
    expect(result.ok).toBe(true);
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("verified");

    // 已接受证据是独立的仅追加事件。
    const verified = ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_proof_verified'").get(ctx.nodeId) as { n: number };
    expect(verified.n).toBe(1);
  });

  it("挑战提示包含可执行且经过认证的 hook 提交", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    expect(challenge.promptBlock).toContain("zrig startup-proof submit");
    expect(challenge.promptBlock).toContain(`--challenge-id ${challenge.challengeId}`);
    expect(challenge.promptBlock).toContain(`--answer ${challenge.expectedAnswer}`);
  });

  it("新的精简启动使证明退役，但不删除历史或接受迟到答案", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const proof = { sessionName: ctx.sessionName, challengeId: challenge.challengeId, answer: challenge.expectedAnswer };
    expect(verifyStartupProof(ctx, proof).ok).toBe(true);
    ctx.eventBus.emit({ type: "node.startup_proof_skipped", rigId: ctx.rigId, nodeId: ctx.nodeId, reason: "not_selected" });
    expect(verifyStartupProof(ctx, proof)).toMatchObject({ ok: false, code: "challenge_stale" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("n-a");
    expect(buildOrientedMap(ctx.db).get(ctx.nodeId)).toBe("n-a");
    expect(ctx.db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_verified'").get()).toEqual({ n: 1 });
    expect(ctx.db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_rejected'").get()).toEqual({ n: 0 });
    issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
    expect(buildOrientedMap(ctx.db).get(ctx.nodeId)).toBe("missing");
  });

  it("DELIVERY-READY 不等于定向：已挑战但未证明的节点为 oriented=missing", () => {
    issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    // startup_status 可以是 ready（已交付）——定向状态独立。
    ctx.eventBus.emit({ type: "node.startup_ready", rigId: ctx.rigId, nodeId: ctx.nodeId });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
  });

  it("拒绝错误答案（看似合理但内容错误）；不设置 oriented", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: challenge.challengeId,
      answer: "0".repeat(32), // right shape, wrong content
    });
    expect(result).toMatchObject({ ok: false, code: "contract_mismatch" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("rejected");
    const rejected = ctx.db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_proof_rejected'").get(ctx.nodeId) as { payload: string };
    expect(JSON.parse(rejected.payload).reason).toBe("contract_mismatch");
  });

  it("裸 ACK 只证明存在，绝不是证明（关键）", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    for (const ack of ["", "  ", "ack", "ready", "ok", "DONE", "oriented"]) {
      const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
        sessionName: ctx.sessionName,
        challengeId: challenge.challengeId,
        answer: ack,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("bare_ack");
    }
    // 裸 ACK 绝不能显示为 oriented/verified。
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("rejected");
  });

  it("重放先前启动的有效答案时以过期为由拒绝", () => {
    const first = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    // 第二次启动签发新挑战（以最新挑战为准）。
    const second = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    expect(second.challengeId).not.toBe(first.challengeId);

    const replay = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: first.challengeId, // stale
      answer: first.expectedAnswer,
    });
    expect(replay).toMatchObject({ ok: false, code: "challenge_stale" });
    // 过期重放携带旧 challengeId，因此不会降低当前启动的定向状态——它如实保持
    // `missing`（等待当前挑战的有效证明）。拒绝仍会被审计。
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
    const rejected = ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_proof_rejected'").get(ctx.nodeId) as { n: number };
    expect(rejected.n).toBe(1);

    // 当前启动的正确证明仍可通过验证。
    const fresh = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: second.challengeId,
      answer: second.expectedAnswer,
    });
    expect(fresh.ok).toBe(true);
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("verified");
  });

  it("拒绝身份不匹配（未知会话）；不投射节点状态", () => {
    issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: "nope@ghost-rig",
      challengeId: "whatever",
      answer: "whatever",
    });
    expect(result).toMatchObject({ ok: false, code: "identity_unbound" });
    // 真实节点保持 challenged/missing——拒绝不会归因到该节点。
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
  });

  // rev1-r2 阻断关键点：resolveSession 优先使用 nodeId，且不交叉检查 sessionName。
  // 携带 node-a id（及 node-a 正确答案）但使用另一个已知席位 sessionName 的证明，
  // 不得错误验证 node-a——必须同时绑定二者。
  it("身份不匹配：nodeId=node-a + sessionName=node-b 被拒绝；node-a 不会被错误验证", () => {
    const challengeA = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    // 同一工作组中的第二个真实托管席位。
    const nodeB = new RigRepository(ctx.db).addNode(ctx.rigId, "dev.worker-b", { runtime: "codex" });
    const sessionNameB = "dev-worker-b@test-rig";
    new SessionRegistry(ctx.db).registerSession(nodeB.id, sessionNameB);

    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      nodeId: ctx.nodeId,        // node-a
      sessionName: sessionNameB, // node-b — CONFLICT
      challengeId: challengeA.challengeId,
      answer: challengeA.expectedAnswer, // node-a's correct answer
    });
    expect(result).toMatchObject({ ok: false, code: "identity_mismatch" });
    // node-a 未被验证（关键），也未降级为 rejected——跨席位证明完全不得触碰其投射。
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
    expect(deriveOriented(ctx.db, nodeB.id)).toBe("n-a");
    const rejected = ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.startup_proof_rejected'").get() as { n: number };
    expect(rejected.n).toBe(0);
  });

  it("匹配的 nodeId + sessionName 仍通过验证（无回归）", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      nodeId: ctx.nodeId,
      sessionName: ctx.sessionName,
      challengeId: challenge.challengeId,
      answer: challenge.expectedAnswer,
    });
    expect(result.ok).toBe(true);
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("verified");
  });

  it("针对从未收到挑战的节点提交证明时被拒绝，但不投射 rejected", () => {
    // 没有 issueStartupChallenge → 恢复的会话/非智能体席位。
    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: "x",
      answer: "y",
    });
    expect(result).toMatchObject({ ok: false, code: "challenge_stale" });
    // 未签发挑战 → oriented 如实保持 n-a（不错误降级）。
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("n-a");
  });
});

describe("启动证明——非证明信号绝不满足证明", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it("ready / activity / session_identity / held 不设置 oriented", () => {
    issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    ctx.eventBus.emit({ type: "node.startup_ready", rigId: ctx.rigId, nodeId: ctx.nodeId });
    ctx.eventBus.emit({ type: "agent.session_identity", rigId: ctx.rigId, nodeId: ctx.nodeId, sessionName: ctx.sessionName, runtime: "codex", sessionId: "thread-1", provenance: "hook" });
    ctx.eventBus.emit({ type: "agent.activity", rigId: ctx.rigId, nodeId: ctx.nodeId, sessionName: ctx.sessionName, runtime: "codex", activity: { state: "running", reason: "active", evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), eventAt: new Date().toISOString(), fallback: false, stale: false } });
    // 这些都不是启动证明 → 仍为 missing（未验证）。
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
  });

  it("恢复后的会话（从未挑战）即使有运行时活动也投射 oriented=n-a", () => {
    ctx.eventBus.emit({ type: "node.startup_ready", rigId: ctx.rigId, nodeId: ctx.nodeId });
    ctx.eventBus.emit({ type: "agent.activity", rigId: ctx.rigId, nodeId: ctx.nodeId, sessionName: ctx.sessionName, runtime: "codex", activity: { state: "running", reason: "active", evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), eventAt: new Date().toISOString(), fallback: false, stale: false } });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("n-a");
  });
});

describe("启动证明——纯派生", () => {
  it("预期答案同时绑定 challengeId（启动）和 contractHash（内容）", () => {
    const hashA = computeContractHash("contract-A");
    const hashB = computeContractHash("contract-B");
    expect(computeExpectedAnswer("c1", hashA)).not.toBe(computeExpectedAnswer("c2", hashA)); // launch-bound
    expect(computeExpectedAnswer("c1", hashA)).not.toBe(computeExpectedAnswer("c1", hashB)); // content-bound
    expect(computeExpectedAnswer("c1", hashA)).toBe(computeExpectedAnswer("c1", hashA)); // deterministic
  });
});

describe("启动证明——认证路由摄取", () => {
  let ctx: ReturnType<typeof setup>;
  let app: Hono;
  const TOKEN = "test-hook-token";
  beforeEach(() => {
    ctx = setup();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, ctx.store as never);
      c.set("activityHookToken" as never, TOKEN as never);
      c.set("eventBus" as never, ctx.eventBus as never);
      c.set("sessionRegistry" as never, new SessionRegistry(ctx.db) as never);
      await next();
    });
    app.route("/", activityRoutes);
  });
  afterEach(() => ctx.db.close());

  async function post(body: unknown, token = TOKEN) {
    return app.request("/hooks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("拒绝未经认证的 startup_proof（401）", async () => {
    const res = await post({ eventFamily: "startup_proof" }, "wrong");
    expect(res.status).toBe(401);
  });

  it("通过 hook 验证正确证明（200 oriented=verified）", async () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const res = await post({ eventFamily: "startup_proof", sessionName: ctx.sessionName, challengeId: challenge.challengeId, answer: challenge.expectedAnswer });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, oriented: "verified" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("verified");
  });

  it("通过 hook 拒绝裸 ACK（422 bare_ack），且绝不定向", async () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const res = await post({ eventFamily: "startup_proof", sessionName: ctx.sessionName, challengeId: challenge.challengeId, answer: "ack" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, code: "bare_ack" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).not.toBe("verified");
  });

  it("通过 hook 拒绝未知身份（404 identity_unbound）", async () => {
    const res = await post({ eventFamily: "startup_proof", sessionName: "ghost@nope", challengeId: "x", answer: "y" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "identity_unbound" });
  });

  it("通过 hook 拒绝 nodeId/sessionName 不匹配（404 identity_mismatch），不错误验证", async () => {
    const challengeA = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const nodeB = new RigRepository(ctx.db).addNode(ctx.rigId, "dev.worker-b", { runtime: "codex" });
    new SessionRegistry(ctx.db).registerSession(nodeB.id, "dev-worker-b@test-rig");
    const res = await post({ eventFamily: "startup_proof", nodeId: ctx.nodeId, sessionName: "dev-worker-b@test-rig", challengeId: challengeA.challengeId, answer: challengeA.expectedAnswer });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "identity_mismatch" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).not.toBe("verified");
  });
});
