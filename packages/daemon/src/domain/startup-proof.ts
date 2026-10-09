import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { NodeOriented } from "./types.js";

// OPR.0.4.3.06——启动证明（经挑战验证的定向）。
//
// 当人工编写的 startup 选择认证证明时，在全新（或全新回退）受管启动中，后台服务会
// 为每次启动发出由内容派生的 CHALLENGE，并将真相持久化为只追加的
// `node.startup_challenged` 事件（challengeId + contractHash）。智能体读取启动契约后，
// 发出绑定身份、携带 { challengeId, answer } 的 `startup_proof`。后台服务验证：
// 身份可解析、challengeId 属于本次启动（防重放），且答案匹配从持久 contract hash
// 重新计算的预期答案。只有验证通过的证明才追加 `node.startup_proof_verified`，
// 并投影 `oriented: verified`；这与仅表示已投递/可交互的 `startup_status: ready` 不同。
// 裸 ACK、空/错误/重放/身份不匹配的答案会被拒绝并追加记录，绝不会渲染为 oriented。
//
// 预期答案是 (challengeId, contractHash) 的纯函数，绝不持久化；验证时从已持久化哈希
// 重新计算，因此后续启动文件漂移无法改变证明真相（持久化 contractHash 冻结启动时契约）。

export type { NodeOriented } from "./types.js";

/** 逐原因拒绝码（只追加审计，绝不折叠为 ready）。 */
export type ProofRejectReason =
  | "identity_unbound"
  | "identity_mismatch"
  | "challenge_stale"
  | "contract_mismatch"
  | "bare_ack";

export interface IssuedChallenge {
  challengeId: string;
  contractHash: string;
  /** 可重新计算；交给提示供智能体回答，不持久化。 */
  expectedAnswer: string;
  /** 追加到启动提示或作为启动提示投递的区块。 */
  promptBlock: string;
}

/** 仅证明在场的 ACK 永远不构成证明（业务规则 2）。 */
const BARE_ACK_TOKENS = new Set(["", "ack", "ok", "ready", "done", "oriented", "acknowledged"]);

export function computeContractHash(contractSource: string): string {
  return createHash("sha256").update(contractSource).digest("hex");
}

export function computeExpectedAnswer(challengeId: string, contractHash: string): string {
  return createHash("sha256").update(`${challengeId}:${contractHash}`).digest("hex").slice(0, 32);
}

function buildProofSubmissionCommand(challengeId: string, expectedAnswer: string): string {
  return `zrig startup-proof submit --challenge-id ${challengeId} --answer ${expectedAnswer}`;
}

function buildPromptBlock(challengeId: string, expectedAnswer: string): string {
  return [
    "--- zrig 启动定向挑战 ---",
    `challengeId: ${challengeId}`,
    "阅读启动契约（上方所有文件/身份）后，",
    "请提交一份经过认证、且严格包含下列内容的 startup_proof，以证明已完成定向：",
    `  answer: ${expectedAnswer}`,
    "",
    "阅读契约后，在 shell/工具中运行以下命令：",
    buildProofSubmissionCommand(challengeId, expectedAnswer),
    "裸确认（\"ack\"/\"ready\"）只能证明在场，绝不构成证明。",
    "--------------------------------------------",
  ].join("\n");
}

/**
 * 派生并持久化（只追加事件）逐启动挑战，再返回提示区块。应在全新/全新回退受管启动时、
 * 启动提示投递前调用，使真相先于任何证明存在。
 */
export function issueStartupChallenge(
  eventBus: EventBus,
  input: { rigId: string; nodeId: string; contractSource: string },
): IssuedChallenge {
  const challengeId = randomBytes(16).toString("hex");
  const contractHash = computeContractHash(input.contractSource);
  const expectedAnswer = computeExpectedAnswer(challengeId, contractHash);

  eventBus.emit({
    type: "node.startup_challenged",
    rigId: input.rigId,
    nodeId: input.nodeId,
    challengeId,
    contractHash,
  });

  return { challengeId, contractHash, expectedAnswer, promptBlock: buildPromptBlock(challengeId, expectedAnswer) };
}

export interface StartupProofInput {
  sessionName?: string | null;
  nodeId?: string | null;
  runtime?: string | null;
  challengeId?: string | null;
  answer?: string | null;
}

export type StartupProofResult =
  | { ok: true; nodeId: string; rigId: string; challengeId: string }
  | { ok: false; code: ProofRejectReason; error: string };

interface ChallengeRow {
  type: string;
  payload: string;
  seq: number;
}

/**
 * 对照持久化的逐启动挑战验证智能体发出的启动证明。要求身份绑定、防重放且内容正确；
 * 否则按原因码追加拒绝。绝不设置 `ready`，也绝不经 updateStartupStatus 路由。
 */
export function verifyStartupProof(
  deps: { store: AgentActivityStore; eventBus: EventBus },
  input: StartupProofInput,
): StartupProofResult {
  const { store, eventBus } = deps;
  const db = store.db;

  // (a) 身份——解析 {sessionId,nodeId,rigId}；未知身份会被拒绝，且不投影任何节点
  // 作用域状态，因为无法把事件归因到未知节点。
  const resolved = store.resolveSession({ sessionName: input.sessionName, nodeId: input.nodeId, runtime: input.runtime });
  if (!resolved) {
    return { ok: false, code: "identity_unbound", error: "startup_proof 未解析到受管会话/节点" };
  }

  // (a2) 身份绑定——证明必须同时绑定 nodeId 和 sessionName。`resolveSession` 优先 nodeId，
  // 不交叉检查传入的 sessionName；若不拒绝冲突，携带 nodeId=node-a + sessionName=node-b
  // 的证明会解析到 node-a 并错误通过，却声称拥有 node-b 身份。这里不为已解析节点发出
  // 节点作用域拒绝（与 identity_unbound 一致）：不匹配、跨席位或畸形证明完全不能触碰
  // 该节点投影，既不能验证，也不能降级为 `rejected`。runtime 只是 hook 分类所用的
  // 非权威提示，不是身份键；席位身份由 nodeId<->sessionName 绑定。
  if (input.sessionName && input.sessionName !== resolved.sessionName) {
    return { ok: false, code: "identity_mismatch", error: "startup_proof 的 nodeId 与 sessionName 解析到不同席位" };
  }

  // 新的精简启动会退役此前挑战，但不删除历史。
  const challengeRow = db.prepare(
    "SELECT type, payload, seq FROM events WHERE node_id = ? AND type IN ('node.startup_challenged','node.startup_proof_skipped') ORDER BY seq DESC LIMIT 1"
  ).get(resolved.nodeId) as ChallengeRow | undefined;
  if (!challengeRow || challengeRow.type === "node.startup_proof_skipped") {
    // 从未挑战（例如恢复后的 resume 或非智能体路径）。证明没有可供核验的对象——
    // 以 stale 拒绝但不追加事件，使节点 oriented 投影如实保持 `n-a`。
    return { ok: false, code: "challenge_stale", error: "此节点没有活动的启动挑战" };
  }

  let current: { challengeId: string; contractHash: string };
  try {
    current = JSON.parse(challengeRow.payload) as { challengeId: string; contractHash: string };
  } catch {
    return { ok: false, code: "challenge_stale", error: "启动挑战 payload 不可读" };
  }

  const answer = (input.answer ?? "").trim();
  const emitRejected = (reason: ProofRejectReason) => {
    eventBus.emit({
      type: "node.startup_proof_rejected",
      rigId: resolved.rigId,
      nodeId: resolved.nodeId,
      challengeId: input.challengeId ?? null,
      reason,
    });
  };

  // (b) 本次启动——回答的挑战必须是当前挑战；重放此前启动的答案会携带陈旧 challengeId。
  if (!input.challengeId || input.challengeId !== current.challengeId) {
    emitRejected("challenge_stale");
    return { ok: false, code: "challenge_stale", error: "challengeId 与本次启动的挑战不匹配（重放/陈旧）" };
  }

  // (d) 裸 ACK、空值或仅证明在场的内容永远不是证明。
  if (BARE_ACK_TOKENS.has(answer.toLowerCase())) {
    emitRejected("bare_ack");
    return { ok: false, code: "bare_ack", error: "裸确认只能证明在场，绝不构成证明" };
  }

  // (c) 契约——从持久化 contract hash 重新计算预期答案；貌似合理但内容错误的答案会被拒绝。
  const expected = computeExpectedAnswer(current.challengeId, current.contractHash);
  if (answer !== expected) {
    emitRejected("contract_mismatch");
    return { ok: false, code: "contract_mismatch", error: "证明答案与已投递的启动契约不匹配" };
  }

  eventBus.emit({
    type: "node.startup_proof_verified",
    rigId: resolved.rigId,
    nodeId: resolved.nodeId,
    sessionId: resolved.sessionId,
    challengeId: current.challengeId,
    contractHash: current.contractHash,
  });

  return { ok: true, nodeId: resolved.nodeId, rigId: resolved.rigId, challengeId: current.challengeId };
}

/**
 * 从只追加的证明事件中投影节点 oriented 信号。`verified` 要求当前最新挑战有已验证证明；
 * `missing` 表示已挑战但尚未证明；`rejected` 表示当前挑战的最新证明被拒绝；
 * `n-a` 表示无活动挑战，包括显式精简的全新启动。绝不从 startup_status 派生。
 */
type OrientedEventRow = { type: string; payload: string; seq: number };

/**
 * 对单个节点证明事件（seq 降序）的纯 oriented 折叠。由原内联 `deriveOriented` 主体
 * 原样提取，使逐节点读取器与 FS-1 W1.3 S2 批量构造器 `buildOrientedMap` 共享同一实现——
 * 构造上裁决一致，不会漂移。
 */
function orientedFromRows(rows: OrientedEventRow[]): NodeOriented {
  const challengeRow = rows.find((r) => r.type === "node.startup_challenged" || r.type === "node.startup_proof_skipped");
  if (!challengeRow || challengeRow.type === "node.startup_proof_skipped") return "n-a";
  let currentChallengeId: string;
  try {
    currentChallengeId = (JSON.parse(challengeRow.payload) as { challengeId: string }).challengeId;
  } catch {
    return "n-a";
  }

  // 引用当前挑战的最新证明事件决定 verified 或 rejected；后续 verify 会覆盖此前 reject。
  for (const row of rows) {
    if (row.seq <= challengeRow.seq) break;
    if (row.type !== "node.startup_proof_verified" && row.type !== "node.startup_proof_rejected") continue;
    let cid: string | null = null;
    try { cid = (JSON.parse(row.payload) as { challengeId: string | null }).challengeId; } catch { continue; }
    if (cid !== currentChallengeId) continue;
    return row.type === "node.startup_proof_verified" ? "verified" : "rejected";
  }
  return "missing";
}

export function deriveOriented(db: Database.Database, nodeId: string): NodeOriented {
  const rows = db.prepare(
    "SELECT type, payload, seq FROM events WHERE node_id = ? AND type IN ('node.startup_challenged','node.startup_proof_skipped','node.startup_proof_verified','node.startup_proof_rejected') ORDER BY seq DESC"
  ).all(nodeId) as OrientedEventRow[];
  return orientedFromRows(rows);
}

/**
 * FS-1 W1.3 S2——用一次查询为整个舰队批量执行 `deriveOriented`，替代逐节点查询
 *（每轮残留约 175 次查询）。获取所有证明事件，按 `node_id` 分组；
 * ORDER BY node_id, seq DESC 精确保留各节点的 seq 降序，再逐节点运行同一
 * `orientedFromRows` 折叠。结果与逐节点 `deriveOriented` 字节一致：后者以节点为作用域，
 * 因此逐节点行子集加相同折叠必然得到相同裁决。无证明事件的节点直接缺席，
 * 调用方默认 `n-a`，与无挑战分支一致。
 */
export function buildOrientedMap(db: Database.Database): Map<string, NodeOriented> {
  const rows = db.prepare(
    "SELECT node_id, type, payload, seq FROM events WHERE type IN ('node.startup_challenged','node.startup_proof_skipped','node.startup_proof_verified','node.startup_proof_rejected') ORDER BY node_id, seq DESC"
  ).all() as Array<{ node_id: string; type: string; payload: string; seq: number }>;
  const byNode = new Map<string, OrientedEventRow[]>();
  for (const r of rows) {
    let list = byNode.get(r.node_id);
    if (!list) { list = []; byNode.set(r.node_id, list); }
    list.push({ type: r.type, payload: r.payload, seq: r.seq });
  }
  const out = new Map<string, NodeOriented>();
  for (const [nodeId, nodeRows] of byNode) out.set(nodeId, orientedFromRows(nodeRows));
  return out;
}
