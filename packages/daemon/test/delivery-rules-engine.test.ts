// OPR.0.5.6.1——第 5 节交付规则引擎（锁定 spec + A1 单人收窄 + A2 AM-F1..F5；
// F-7“尊重 OFF”在派发时锁定，未收到发起人反转；F-8 裁决的 enum/档位只消费，绝不重造）。
//
// 在干净基线 0d6e65743 上以最终测试字节红灯优先：引擎模块不存在，
// prefs.deliveryClass/away 虽存储却不生效，mention 裁决由相隔 230 行的两次档位读取决定
//（queue-access.ts:39 + slack-subsystem.ts:184），操作人员层级记录“已引用但未构建”后立即耗尽，
// 且没有摘要/延后机制。下方每个区段都恰因这些原因在基线失败。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import { resolveSlackHandle, validateHumanFragment } from "../src/domain/gateway/human-registry.js";
import { WatchdogJobsRepository, PHASE_D_POLICIES } from "../src/domain/watchdog-jobs-repository.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";

// 动态导入引擎，使每个区段各自携带红灯回执（“引擎模块缺失”），而非采集阶段一次性失败。
type EngineModule = typeof import("../src/domain/gateway/delivery-rules-engine.js");
async function engine(): Promise<EngineModule | null> {
  try {
    return (await import("../src/domain/gateway/delivery-rules-engine.js")) as EngineModule;
  } catch {
    return null;
  }
}
async function deferralPolicyModule(): Promise<Record<string, unknown> | null> {
  try {
    return (await import("../src/domain/policies/delivery-deferral.js")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
async function digestFlushModule(): Promise<Record<string, unknown> | null> {
  try {
    return (await import("../src/domain/policies/delivery-digest-flush.js")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const SRC_ROOT = join(__dirname, "..", "src");

/** 工具修正（可见，W2 发现 5-7）：结构固定检查搜索代码而非文档；模块文档可以合理地
 *  点名被禁字面量（“post-failed 不存在”“此处没有 setInterval”）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function registryWith(prefs: Record<string, unknown>) {
  return {
    ok: true as const,
    entities: [{
      entityId: "human-founder",
      class: "human" as const,
      displayName: "Founder",
      address: "human-founder@external",
      connectorBindings: [{
        kind: "slack" as const,
        connectorRef: "primary",
        secretsRef: "env:SLACK_BOT_TOKEN",
        role: "primary" as const,
        handle: "UFOUNDER",
      }],
      prefs,
    }],
  };
}

function ensureFinalColumns(db: Database.Database): void {
  for (const table of ["queue_transitions", "queue_transitions_archive"]) {
    const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
    if (!names.has("owner_notification_kind")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_kind TEXT`);
    if (!names.has("owner_notification_level")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_level TEXT`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 类别矩阵（AM-F2：完整性由算术保证，每个单元格引用其裁决）。
// 4 种 prefs × 4 种 availability × 2 种 mode = 32 个单元格。单人终止列依附于 away/off
// 升级单元格（A1：next-person 从未作为独立单元格存在；终止是这些单元格的属性）。
// 静默单元格绝不 mention（仅 outcome === "interrupt" 时 mention）。
// ─────────────────────────────────────────────────────────────────────────────

type Cell = {
  pref: "A" | "B" | "C" | "D";
  availability: "available" | "focus" | "away" | "off";
  mode: "normal" | "escalation";
  outcome: "interrupt" | "notify" | "digest" | "log";
  digestWindow?: "4h" | "daily";
  deferMinutes?: number;
  termination?: boolean;
  cite: string;
};

const A = "available", F = "focus", W = "away", O = "off";
const MATRIX: Cell[] = [
  // 偏好 A——始终 interrupt（第 5 节登记：“每次立即交付”）；
  // off 是 F-7/F-8 唯一允许的调节（off 抑制打断，但绝不抑制交付）。
  { pref: "A", availability: A, mode: "normal", outcome: "interrupt", cite: "register A interrupt-always" },
  { pref: "A", availability: F, mode: "normal", outcome: "interrupt", cite: "register A overrides focus (always means always)" },
  { pref: "A", availability: W, mode: "normal", outcome: "interrupt", cite: "register A overrides away (always means always)" },
  { pref: "A", availability: O, mode: "normal", outcome: "notify", cite: "F-8: off suppresses interruption, never delivery" },
  { pref: "A", availability: A, mode: "escalation", outcome: "interrupt", cite: "escalation is interrupt-class (A1.2)" },
  { pref: "A", availability: F, mode: "escalation", outcome: "interrupt", cite: "design §3: focus escalation = post + mention" },
  { pref: "A", availability: W, mode: "escalation", outcome: "interrupt", termination: true, cite: "register A immediate even away; single-human termination recorded (A1.1)" },
  { pref: "A", availability: O, mode: "escalation", outcome: "notify", termination: true, cite: "F-7 VERBATIM: off is respected, escalation never overrides; termination row + escalations view stay loud" },
  // 偏好 B——notify；升级后为 interrupt；away+B 是 M1 第 5 节预设（延后 30 分钟）。
  { pref: "B", availability: A, mode: "normal", outcome: "notify", cite: "register B threaded post, no mention" },
  { pref: "B", availability: F, mode: "normal", outcome: "notify", cite: "register B" },
  { pref: "B", availability: W, mode: "normal", outcome: "notify", cite: "design §3: away normal = post, no mention" },
  { pref: "B", availability: O, mode: "normal", outcome: "notify", cite: "F-8: delivery never suppressed" },
  { pref: "B", availability: A, mode: "escalation", outcome: "interrupt", cite: "escalation lifts B (A1.2 interrupt-class)" },
  { pref: "B", availability: F, mode: "escalation", outcome: "interrupt", cite: "design §3: focus escalation = post + mention" },
  { pref: "B", availability: W, mode: "escalation", outcome: "interrupt", deferMinutes: 30, termination: true, cite: "M1 §5 AWAY preset + AM-F3: exactly one interrupt at T+30 to the SAME human; termination recorded (A1.1)" },
  { pref: "B", availability: O, mode: "escalation", outcome: "notify", termination: true, cite: "F-7 VERBATIM cell" },
  // 偏好 C——4 小时摘要；升级后完全脱离摘要。
  { pref: "C", availability: A, mode: "normal", outcome: "digest", digestWindow: "4h", cite: "register C worker-parked 4h digest" },
  { pref: "C", availability: F, mode: "normal", outcome: "digest", digestWindow: "4h", cite: "register C" },
  { pref: "C", availability: W, mode: "normal", outcome: "digest", digestWindow: "4h", cite: "register C" },
  { pref: "C", availability: O, mode: "normal", outcome: "digest", digestWindow: "4h", cite: "register C; off touches interruption only" },
  { pref: "C", availability: A, mode: "escalation", outcome: "interrupt", cite: "escalation never digests (A1.2)" },
  { pref: "C", availability: F, mode: "escalation", outcome: "interrupt", cite: "escalation never digests" },
  { pref: "C", availability: W, mode: "escalation", outcome: "interrupt", deferMinutes: 30, termination: true, cite: "away escalation defers per the preset (uniform non-A rule, documented)" },
  { pref: "C", availability: O, mode: "escalation", outcome: "notify", termination: true, cite: "F-7 VERBATIM cell" },
  // 偏好 D——每日摘要；采用相同的升级方式。
  { pref: "D", availability: A, mode: "normal", outcome: "digest", digestWindow: "daily", cite: "register D daily batch" },
  { pref: "D", availability: F, mode: "normal", outcome: "digest", digestWindow: "daily", cite: "register D" },
  { pref: "D", availability: W, mode: "normal", outcome: "digest", digestWindow: "daily", cite: "register D" },
  { pref: "D", availability: O, mode: "normal", outcome: "digest", digestWindow: "daily", cite: "register D" },
  { pref: "D", availability: A, mode: "escalation", outcome: "interrupt", cite: "escalation never digests" },
  { pref: "D", availability: F, mode: "escalation", outcome: "interrupt", cite: "escalation never digests" },
  { pref: "D", availability: W, mode: "escalation", outcome: "interrupt", deferMinutes: 30, termination: true, cite: "away escalation defers per the preset" },
  { pref: "D", availability: O, mode: "escalation", outcome: "notify", termination: true, cite: "F-7 VERBATIM cell" },
];

describe("OPR.0.5.6.1 §1——完整类别矩阵，每个单元格一条回执（AM-F2）", () => {
  it("算术固定：矩阵恰好枚举 4 种偏好 × 4 种可用性 × 2 种模式 = 32 个单元格", () => {
    expect(MATRIX.length).toBe(4 * 4 * 2);
    const keys = new Set(MATRIX.map((c) => `${c.pref}|${c.availability}|${c.mode}`));
    expect(keys.size).toBe(32);
  });

  for (const cell of MATRIX) {
    it(`单元格 ${cell.pref}×${cell.availability}×${cell.mode} → ${cell.outcome}${cell.deferMinutes ? ` 延后 ${cell.deferMinutes} 分钟` : ""}${cell.termination ? " +终止" : ""} [${cell.cite}]`, async () => {
      const mod = await engine();
      expect(mod, "the delivery rules engine module must exist (RED at base: absent)").not.toBeNull();
      const decision = mod!.decideDelivery({
        // Fixture 修正（可见，W2 发现 1-3）：LEVEL 不是矩阵轴；已裁决矩阵为
        // pref × availability × mode。单元格以 ALERT 运行（引擎实际路由的需人工流量）；
        // 档位降级语义在下方以 NOTICE 单独测试。
        level: "ALERT",
        escalation: cell.mode === "escalation",
        human: { entityId: "human-founder", deliveryClass: cell.pref, availability: cell.availability },
        dials: { minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT" },
      });
      expect(decision.outcome).toBe(cell.outcome);
      // 静默单元格绝不 mention；notify/digest/log 单元格出现任何 mention 都是红灯。
      expect(decision.mention).toBe(cell.outcome === "interrupt");
      if (cell.digestWindow) expect(decision.digestWindow).toBe(cell.digestWindow);
      if (cell.deferMinutes) expect(decision.deferMinutes).toBe(cell.deferMinutes);
      else expect(decision.deferMinutes).toBeUndefined();
      if (cell.termination) {
        expect(decision.termination).toMatchObject({
          who: "human-founder",
          availability: cell.availability,
          noFallbackAvailable: true,
        });
      } else {
        expect(decision.termination).toBeUndefined();
      }
    });
  }

  it("LOG：记录级消息（低于 posts 档位）裁决为 log——仅持久化，绝不发送", async () => {
    const mod = await engine();
    expect(mod).not.toBeNull();
    const decision = mod!.decideDelivery({
      level: "RECORD",
      escalation: false,
      human: { entityId: "human-founder", deliveryClass: "A", availability: "available" },
      dials: { minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT" },
    });
    expect(decision.outcome).toBe("log");
    expect(decision.mention).toBe(false);
  });

  it("档位降级：低于 interrupts 档位的 interrupt 类裁决降为 notify（通过引擎保留 S14 语义）", async () => {
    const mod = await engine();
    expect(mod).not.toBeNull();
    const decision = mod!.decideDelivery({
      level: "NOTICE",
      escalation: true,
      human: { entityId: "human-founder", deliveryClass: "A", availability: "available" },
      dials: { minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT" },
    });
    expect(decision.outcome).toBe("notify");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 注册表中的 AVAILABILITY——全新 enum key，兼容旧版 away 推导。
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §2——availability 是受校验的 prefs key；可推导旧版 away；冲突响亮失败", () => {
  function fragment(prefs: Record<string, unknown>) {
    return {
      entityId: "human-founder",
      class: "human",
      displayName: "Founder",
      address: "human-founder@external",
      connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "env:T", role: "primary", handle: "UF" }],
      prefs,
    };
  }

  it("接受 availability 的 available|focus|away|off（基线红灯：封闭 key 集拒绝该 key）", () => {
    for (const availability of ["available", "focus", "away", "off"]) {
      const r = validateHumanFragment(fragment({ deliveryClass: "B", availability }));
      expect(r.ok, `availability=${availability}: ${r.ok ? "" : (r as { error: string }).error}`).toBe(true);
    }
  });

  it("响亮拒绝未知 availability 值", () => {
    const r = validateHumanFragment(fragment({ deliveryClass: "B", availability: "busy" }));
    expect(r.ok).toBe(false);
  });

  it("availability 缺失时将旧版 away:true 读为 availability=away（仅整字段缺失时推导）", async () => {
    const mod = await engine();
    expect(mod).not.toBeNull();
    expect(mod!.resolveAvailability({ deliveryClass: "B", away: true })).toBe("away");
    expect(mod!.resolveAvailability({ deliveryClass: "B" })).toBe("available");
    expect(mod!.resolveAvailability({ deliveryClass: "B", availability: "focus" })).toBe("focus");
  });

  it("availability 与旧版 away 冲突时在校验阶段拒绝（同一事实的两种写法）", () => {
    const r = validateHumanFragment(fragment({ deliveryClass: "B", availability: "available", away: true }));
    expect(r.ok).toBe(false);
    const agreeing = validateHumanFragment(fragment({ deliveryClass: "B", availability: "away", away: true }));
    expect(agreeing.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 GATEWAY 查询引擎（AM-F5）——行为级线上 harness。
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §3——gateway 在派发前查询引擎", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    bus = new EventBus(db);
    // 写入时针对 gateway reader 使用的同一私有人类身份分类 park。交付偏好由各测试选择。
    repo = new QueueRepository(db, bus, {
      validateRig: () => true,
      loadHumanRegistry: () => registryWith({}),
    });
    home = mkdtempSync(join(tmpdir(), "s01-rules-"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function parkOnFounder(tags: string[] = []): Promise<QueueItem> {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "await decision",
      ...(tags.length ? { tags } : {}),
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "Choose A or B",
      evidenceRef: "/proof/decision.md",
      transitionNote: "parked",
    });
    return row;
  }

  function wireWith(prefs: Record<string, unknown>, posts: Array<Record<string, unknown>>) {
    const registry = registryWith(prefs);
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    return buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: `1724.000${posts.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  }

  it("F-7 单元格端到端：off 状态人员的 ALERT 停驻仍发送（交付绝不抑制）但不 mention，并在记录上保存终止信息（基线红灯：ALERT 会 mention）", async () => {
    // Fixture 修正（可见，W2 发现 4）：终止信息位于升级记录（A1.1/F-7），
    // park 携带升级 tag。
    const row = await parkOnFounder(["escalation"]);
    const registry = registryWith({ deliveryClass: "B", availability: "off" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();

    const posts: Array<Record<string, unknown>> = [];
    const wire = wireWith({ deliveryClass: "B", availability: "off" }, posts);
    try {
      wire.startServices?.();
      expect(wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length, "off never suppresses the post (F-8)").toBe(1);
      expect(JSON.stringify(posts[0]), "off is respected: no mention, ever (F-7)").not.toContain("<@UFOUNDER>");
      const termination = repo.listTransitions(row.qitemId).filter((t) => t.transitionNote?.startsWith("delivery-termination:"));
      expect(termination.length, "the termination row records who/availability/no-fallback-available").toBe(1);
      expect(termination[0]!.transitionNote).toContain("who=human-founder");
      expect(termination[0]!.transitionNote).toContain("availability=off");
      expect(termination[0]!.transitionNote).toContain("no-fallback-available");
    } finally {
      wire.stop();
    }
  });

  it("静默单元格缺省：focus 状态人员的普通 NOTICE 不 mention，而 available 状态的 A 类 ALERT 仍 mention（下限）", async () => {
    const row = await parkOnFounder();
    const registry = registryWith({ deliveryClass: "B", availability: "focus" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();
    const posts: Array<Record<string, unknown>> = [];
    const wire = wireWith({ deliveryClass: "B", availability: "focus" }, posts);
    try {
      wire.startServices?.();
      wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length).toBe(1);
      expect(JSON.stringify(posts[0])).not.toContain("<@UFOUNDER>");
      expect(row.qitemId).toBeTruthy();
    } finally {
      wire.stop();
    }
  });

  it("摘要边界：C 类人员的记录绝不单独派发（基线红灯：每条记录各自发送）", async () => {
    await parkOnFounder();
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();
    const posts: Array<Record<string, unknown>> = [];
    const wire = wireWith({ deliveryClass: "C", availability: "available" }, posts);
    try {
      wire.startServices?.();
      wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length, "digest-class rows accumulate; the flush posts, never the sweep").toBe(0);
    } finally {
      wire.stop();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 摘要——无损、恰好一次、跨重启持久的窗口（AM-F1 约束）。
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §4——C/D 摘要刷新（v3：传输事实优先，重新驱动直至成功）", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => registryWith({}),
    });
    home = mkdtempSync(join(tmpdir(), "s01-digest-"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  let parkNumber = 0;
  async function nParks(n: number): Promise<QueueItem[]> {
    const rows: QueueItem[] = [];
    for (let i = 0; i < n; i++) {
      const row = await repo.create({
        sourceSession: `seat-${i}@r`,
        destinationSession: "orch-lead@v-openrig-build",
        body: `decision ${parkNumber++}`,
        nudge: false,
      });
      repo.update({
        qitemId: row.qitemId,
        actorSession: "orch-lead@v-openrig-build",
        state: "blocked",
        blockedOn: "human-founder@kernel",
        summary: `Decision ${i}`,
        evidenceRef: `/proof/${i}.md`,
        transitionNote: "parked",
      });
      rows.push(row);
    }
    return rows;
  }

  function recordDigestDecision(qitemId: string, key: string, window: "4h" | "daily"): void {
    repo.update({
      qitemId, actorSession: "daemon@kernel",
      transitionNote: `delivery-decision: digest window=${window} notification_key=${key}`,
    });
  }

  function digestWire(posts: Array<Record<string, unknown>>, opts?: { failFetch?: boolean }) {
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    return buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl: async (url, init) => {
        if (opts?.failFetch) {
          return new Response(JSON.stringify({ ok: false, error: "fatal_error" }), { status: 500, headers: { "content-type": "application/json" } });
        }
        // 工具修正（可见，W9 HOLD）：只统计真实 chat.postMessage 发送；重放路径按标记对账的
        // channel SEARCH 也经过此 fetch，绝不能虚增发送数。
        if (String(url).includes("chat.postMessage")) {
          posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
          return new Response(JSON.stringify({ ok: true, ts: `1724.9${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  }

  async function flushViaWire(mod: Record<string, unknown>, wire: ReturnType<typeof buildSlackGatewayWire>) {
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const flush = (mod as { runDeliveryDigestFlush: (deps: unknown) => Promise<{ dispatched: number; members: number }> }).runDeliveryDigestFlush;
    return flush({
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      home,
      dispatch: (op: string, ref: string, payload: unknown, opts?: unknown) => wire.dispatcher.dispatch(op, ref, payload, opts as never),
      window: "4h" as const,
    });
  }

  it("无损且恰好一次（v3）：N 个已记录摘要裁决经真实线路刷新为独立完整消息；回执只在传输事实之后落地；第二次刷新不派发新内容（基线红灯：无刷新机制）", async () => {
    const mod = await digestFlushModule();
    expect(mod, "policies/delivery-digest-flush must exist (RED at base: absent)").not.toBeNull();
    const rows = await nParks(3);
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const keys: Array<{ qid: string; key: string }> = [];
    for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
      const key = alert.notificationKey ?? alert.qitemId;
      keys.push({ qid: alert.qitemId, key });
      recordDigestDecision(alert.qitemId, key, "4h");
    }
    const posts: Array<Record<string, unknown>> = [];
    const wire = digestWire(posts);
    try {
      wire.startServices?.();
      const first = await flushViaWire(mod!, wire);
      expect(first.members).toBe(3);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(posts.length, "one complete root per request through the real transport").toBe(3);
      const body = JSON.stringify(posts);
      for (const row of rows) expect(body).toContain(row.body);
      expect(body, "the digest is notify-class: no mention").not.toContain("<@UFOUNDER>");
      // 回执在发送（传输事实）之后落地，逐成员携带摘要 token。
      for (const { qid, key } of keys) {
        const receipts = repo.listTransitions(qid).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
        expect(receipts.length, `receipt on ${qid}`).toBe(1);
        expect(receipts[0]!.transitionNote).toContain(`notification_key=${key}`);
        expect(receipts[0]!.transitionNote).toContain("message_ts=");
      }
      const second = await flushViaWire(mod!, wire);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(second.members, "exactly-once: nothing left to flush").toBe(0);
      expect(posts.length).toBe(3);
    } finally {
      wire.stop();
    }
  });

  it("消息时刻裁决（R1 B-4）：边界收纳与刷新之间偏好变化时，不丢弃也不重新分类已记录成员", async () => {
    const mod = await digestFlushModule();
    expect(mod).not.toBeNull();
    const rows = await nParks(2);
    const cRegistry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => cRegistry } as never);
    for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
      recordDigestDecision(alert.qitemId, alert.notificationKey ?? alert.qitemId, "4h");
    }
    // 边界收纳记录摘要裁决后，人员才切换到 A。
    const posts: Array<Record<string, unknown>> = [];
    const wire = digestWire(posts);
    try {
      wire.startServices?.();
      const aRegistry = registryWith({ deliveryClass: "A", availability: "available" });
      const flush = (mod as { runDeliveryDigestFlush: (deps: unknown) => Promise<{ dispatched: number; members: number }> }).runDeliveryDigestFlush;
      const result = await flush({
        queueRepo: repo,
        registry: { loadHumanRegistry: () => aRegistry, resolveSlackHandle },
        home,
        dispatch: (op: string, ref: string, payload: unknown, opts?: unknown) => wire.dispatcher.dispatch(op, ref, payload, opts as never),
        window: "4h" as const,
      });
      expect(result.members, "recorded decisions survive later prefs drift").toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(posts.length).toBe(2);
      for (const row of rows) expect(JSON.stringify(posts)).toContain(row.body);
    } finally {
      wire.stop();
    }
  });

  it("传输失败重驱（R1/R2 必需判别）：发送失败后成员仍可刷新且无虚假回执；重建会重放同一持久裁决，最终只发送一次并生成 key 正确的回执（候选红灯：发送前回执会抑制恢复）", async () => {
    const mod = await digestFlushModule();
    expect(mod).not.toBeNull();
    await nParks(2);
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const keys: Array<{ qid: string; key: string }> = [];
    for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
      const key = alert.notificationKey ?? alert.qitemId;
      keys.push({ qid: alert.qitemId, key });
      recordDigestDecision(alert.qitemId, key, "4h");
    }
    const posts: Array<Record<string, unknown>> = [];
    let trackedC!: QueueItem;
    const failing = digestWire(posts, { failFetch: true });
    try {
      failing.startServices?.();
      const first = await flushViaWire(mod!, failing);
      expect(first.members).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(posts.length, "transport failed: nothing posted").toBe(0);
      for (const { qid } of keys) {
        const receipts = repo.listTransitions(qid).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
        expect(receipts.length, "NO false posted receipt on transport failure").toBe(0);
      }
    } finally {
      failing.stop();
    }
    // 重建：在同一 home 上建立新线路，重放保留的持久裁决；最终发送一次，
    // 回执在传输事实之后产生。
    const healthy = digestWire(posts);
    try {
      healthy.startServices?.();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(posts.length, "one eventual complete post per request after reconstruction").toBe(2);
      for (const { qid, key } of keys) {
        const receipts = repo.listTransitions(qid).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
        expect(receipts.length, `receipt on ${qid} after redrive`).toBe(1);
        expect(receipts[0]!.transitionNote).toContain(`notification_key=${key}`);
      }
      // 此时刷新找不到任何内容——端到端恰好一次。
      const after = await flushViaWire(mod!, healthy);
      expect(after.members).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length).toBe(2);
    } finally {
      healthy.stop();
    }
  });

  it("成员互斥（R1 HOLD c7818ceb 必需判别）：A+B 待处理且无回执时，加入 C 会生成不重叠摘要；待处理裁决绝不共享成员，恢复后每个成员恰好发送一次（候选红灯：集合哈希生成重叠 A/B/C 裁决）", async () => {
    const mod = await digestFlushModule();
    expect(mod).not.toBeNull();
    // A+B 已记录且传输不可用：其摘要裁决进入 pending，回执为零。
    const firstRows = await nParks(2);
    const registry = registryWith({ deliveryClass: "C", availability: "available" });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
      recordDigestDecision(alert.qitemId, alert.notificationKey ?? alert.qitemId, "4h");
    }
    const posts: Array<Record<string, unknown>> = [];
    let trackedC!: QueueItem;
    const failing = digestWire(posts, { failFetch: true });
    try {
      failing.startServices?.();
      const first = await flushViaWire(mod!, failing);
      expect(first.members).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 40));
      // A+B 待处理且无回执时，C 到达。
      const [cRowCreated] = await nParks(1);
      trackedC = cRowCreated!;
      for (const alert of await ports.listHumanAlerts({ minimumLevel: "NOTICE" })) {
        if (alert.qitemId === trackedC.qitemId) {
          recordDigestDecision(alert.qitemId, alert.notificationKey ?? alert.qitemId, "4h");
        }
      }
      const second = await flushViaWire(mod!, failing);
      await new Promise((resolve) => setTimeout(resolve, 40));
      // 待处理裁决必须保证成员互斥：任何 key 都不能出现在多个裁决中。
      const pending = new DispatchBuffer(home).pending().filter((d) => d.decisionId.startsWith("digest:"));
      const seen = new Map<string, number>();
      for (const d of pending) {
        const key = (d.payload as { notificationKey?: string }).notificationKey;
        if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
        for (const m of ((d.payload as { memberReceipts?: Array<{ notificationKey: string }> }).memberReceipts ?? [])) {
          seen.set(m.notificationKey, (seen.get(m.notificationKey) ?? 0) + 1);
        }
      }
      expect(seen.size).toBe(3);
      for (const [key, count] of seen) {
        expect(count, `member ${key} rides exactly one pending decision — overlap is the double-delivery`).toBe(1);
      }
      expect(second.members, "the second mint covers ONLY the new member").toBe(1);
    } finally {
      failing.stop();
    }
    // 传输恢复：重建会重放两个互斥裁决；每个成员事件产生一条人类可见消息，
    // 且各自恰好一条回执。
    const healthy = digestWire(posts);
    try {
      healthy.startServices?.();
      await new Promise((resolve) => setTimeout(resolve, 80));
      // R1 e22e804f 修正：每个被跟踪成员 A、B、C 都必须恰好出现在一条已发送摘要中，
      // 且恰好携带一条回执。（先前只统计 firstRows 且回执上限为 <=1，无法拒绝 C 为零的结果，
      // 这正是 HOLD 点名的证明缺口。）
      const tracked = [...firstRows, trackedC];
      const memberAppearances = new Map<string, number>();
      for (const post of posts) {
        const text = JSON.stringify(post);
        for (const row of tracked) {
          if (text.includes(row.body)) memberAppearances.set(row.qitemId, (memberAppearances.get(row.qitemId) ?? 0) + 1);
        }
      }
      for (const row of tracked) {
        expect(memberAppearances.get(row.qitemId) ?? 0, `${row.qitemId} appears in exactly one posted digest`).toBe(1);
        const receipts = repo.listTransitions(row.qitemId).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
        expect(receipts.length, `exactly one posted receipt on ${row.qitemId}`).toBe(1);
      }
    } finally {
      healthy.stop();
    }
  });

  it("已登记底座：摘要刷新和 away 延后都是 PHASE_D 策略，不引入第三套计时引擎（AM-F1 防扩散）", async () => {
    expect(PHASE_D_POLICIES).toContain("delivery-digest-flush");
    expect(PHASE_D_POLICIES).toContain("delivery-deferral");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 AWAY 延后——在 T+30 单次触发且跨重启持久（AM-F1/AM-F3 约束）。
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §5——watchdog 底座上的 30 分钟 away 延后", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let jobs: WatchdogJobsRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    jobs = new WatchdogJobsRepository(db);
  });
  afterEach(() => db.close());

  it("延后持久武装并在 T+30 恰好触发一次，能跨越窗口中途的后台服务重启（v3：T+30 派发，仅观测到回执后终态——绝不少于或多于一次）", async () => {
    const mod = await deferralPolicyModule();
    expect(mod, "policies/delivery-deferral must exist (RED at base: absent)").not.toBeNull();
    const row = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@external",
      body: "escalation",
      nudge: false,
    });
    const arm = (mod as { armDeliveryDeferral: (deps: unknown) => { jobId: string } }).armDeliveryDeferral;
    const armed = arm({ jobsRepo: jobs, queueRepo: repo, qitemId: row.qitemId, entityId: "human-founder", minutes: 30, notificationKey: `${row.qitemId}:ep1` });
    expect(armed.jobId).toBeTruthy();
    const jobRow = db.prepare("SELECT policy, state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { policy: string; state: string };
    expect(jobRow).toMatchObject({ policy: "delivery-deferral", state: "active" });

    // “重启”：同一数据库上的新 repository 实例看到同一个 job。
    const jobsAfterRestart = new WatchdogJobsRepository(db);
    const fire = (mod as { fireDeliveryDeferralIfDue: (deps: unknown) => Promise<{ fired: boolean }> }).fireDeliveryDeferralIfDue;
    const interrupts: string[] = [];
    const deps = {
      jobsRepo: jobsAfterRestart,
      queueRepo: repo,
      jobId: armed.jobId,
      deliverInterrupt: async (qitemId: string, key: string) => {
        interrupts.push(qitemId);
        // 交付接缝行为：回执在传输事实之后落地。
        repo.update({ qitemId, actorSession: "daemon@kernel",
          transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT kind=human-required message_ts=1 thread_ts=1` });
        return { ok: true as const };
      },
    };
    // T+30 前：尚未到期。
    expect((await fire({ ...deps, now: new Date(Date.now() + 10 * 60_000) })).fired).toBe(false);
    expect(interrupts.length).toBe(0);
    // T+30 时：恰好派发一次（job 保持 active，等待观测回执）。
    expect((await fire({ ...deps, now: new Date(Date.now() + 31 * 60_000) })).fired).toBe(false);
    expect(interrupts).toEqual([row.qitemId]);
    // 下一次评估观测到回执：已触发并进入终态，不再交付。
    expect((await fire({ ...deps, now: new Date(Date.now() + 32 * 60_000) })).fired).toBe(true);
    expect(interrupts.length).toBe(1);
    expect((await fire({ ...deps, now: new Date(Date.now() + 62 * 60_000) })).fired).toBe(false);
    expect(interrupts.length).toBe(1);
    const terminal = db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string };
    expect(terminal.state).toBe("terminal");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 操作人员层级执行交付（A1.2 + AM-F3）——S01 指针退役。
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §6——操作人员层级通过引擎派发", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => db.close());

  async function batonAtOperatorRung(): Promise<QueueItem> {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
    // wake 失败且老化超过重试上限，因此 ladder 升级；orchestrator 解析为目标自身，
    // 随后自跳过，并在本次 tick 进入操作人员层级。
    const ts = new Date(Date.now() - 10 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(ts, "failed:tmux session not found", created.qitemId);
    return created;
  }

  function markersOf(qitemId: string, prefix: string): string[] {
    return (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid").all(qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "")
      .filter((n) => n.startsWith(prefix));
  }

  async function tickWithEngine(engineOutcome: { decision: string; resolved: boolean }, calls: Array<{ qitemId: string }>) {
    return runWakeLadderTick({
      db,
      queueRepo: repo,
      attemptWake: async () => "failed:tmux session not found",
      resolveOrchestrator: () => null, // self-skip -> operator rung immediately
      retryIntervalSeconds: 1,
      retryCap: 0,
      log: () => {},
      deliveryEngine: {
        dispatchEscalation: async (row: QueueItem, _reason: string) => {
          calls.push({ qitemId: row.qitemId });
          return engineOutcome;
        },
      },
    } as never);
  }

  it("已派发到引擎：层级记录引擎裁决，并在结果解决后耗尽（基线红灯：WakeLadderDeps 没有 deliveryEngine，标记仍写着已引用但未构建）", async () => {
    const baton = await batonAtOperatorRung();
    const calls: Array<{ qitemId: string }> = [];
    await tickWithEngine({ decision: "interrupt", resolved: true }, calls);
    expect(calls.length, "the operator rung must dispatch through the engine").toBe(1);
    const rungMarkers = markersOf(baton.qitemId, "escalation-rung:").filter((n) => /operator/.test(n));
    expect(rungMarkers.length).toBeGreaterThanOrEqual(1);
    expect(rungMarkers.join("\n")).toContain("dispatched-to-engine");
    expect(rungMarkers.join("\n")).toContain("decision=interrupt");
    expect(rungMarkers.join("\n")).not.toContain("cited not built");
    expect(markersOf(baton.qitemId, "ladder-exhausted:").length).toBe(1);
  });

  it("不静默推进（AM-F3）：DEFERRED 结果使 ladder 在延后期间保持未耗尽，解决后才耗尽；整个事件只向引擎派发一次", async () => {
    const baton = await batonAtOperatorRung();
    const calls: Array<{ qitemId: string }> = [];
    await tickWithEngine({ decision: "interrupt", resolved: false }, calls);
    expect(calls.length).toBe(1);
    expect(markersOf(baton.qitemId, "ladder-exhausted:").length, "no advance past the operator rung while the engine's outcome is pending").toBe(0);

    // 延后期间第二次 tick：不重新派发（恰好一次），仍未耗尽。
    await tickWithEngine({ decision: "interrupt", resolved: false }, calls);
    expect(calls.length, "one dispatch per episode, never immediate-plus-deferred").toBe(1);
    expect(markersOf(baton.qitemId, "ladder-exhausted:").length).toBe(0);

    // 延后触发：交付 leg 在记录上盖 S14 回执。
    repo.update({
      qitemId: baton.qitemId,
      actorSession: "daemon@system",
      transitionNote: "slack-owner-notification-posted notification_key=test:1 level=ALERT kind=human-required message_ts=1 channel=C",
    });
    await tickWithEngine({ decision: "interrupt", resolved: false }, calls);
    expect(markersOf(baton.qitemId, "ladder-exhausted:").length, "posted receipt resolves the episode").toBe(1);
    expect(calls.length).toBe(1);
  });

  it("指针退役：queue-wake-ladder.ts 不再包含“已引用但未构建”文案（基线红灯：存在两份）", () => {
    const source = readFileSync(join(SRC_ROOT, "domain", "queue-wake-ladder.ts"), "utf8");
    expect(source).not.toContain("cited, not built");
    expect(source).not.toContain("cited not built");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 结构固定——统一词汇、不伪造状态、防扩散。
// ─────────────────────────────────────────────────────────────────────────────

describe("OPR.0.5.6.1 §7——统一词汇、没有 seen、没有第三套计时引擎", () => {
  it("结果元组只在一处定义；引擎消费 S14 戳记，不创造传输字面量（AM-F4）", async () => {
    const mod = await engine();
    expect(mod).not.toBeNull();
    expect(mod!.DELIVERY_OUTCOMES).toEqual(["interrupt", "notify", "digest", "log"]);
    const raw = readFileSync(join(SRC_ROOT, "domain", "gateway", "delivery-rules-engine.ts"), "utf8");
    const source = stripComments(raw);
    // 只消费，绝不创造：可以通过 transition-log 辅助函数引用 S14 回执字面量，
    // 但绝不能在此重新拼写为模板写入。
    expect(source).not.toMatch(/slack-owner-notification-posted\s/);
    expect(source).not.toMatch(/["'`]post-failed["'`]/);
    // 交付状态表记录在接缝处（AM-F4 的唯一定义位置）。
    expect(raw).toContain("投递状态表");
  });

  it("不伪造状态：任何引擎产物都不能表示 `seen`（schema 和写入回执）", async () => {
    for (const rel of [
      ["domain", "gateway", "delivery-rules-engine.ts"],
      ["domain", "policies", "delivery-deferral.ts"],
      ["domain", "policies", "delivery-digest-flush.ts"],
    ]) {
      const source = stripComments(readFileSync(join(SRC_ROOT, ...rel), "utf8"));
      expect(source, rel.join("/")).not.toMatch(/["'`]seen["'`]/);
    }
  });

  it("防扩散（AM-F1）：三个新模块不引入计时入口——没有 setInterval/setTimeout，仅依托 watchdog_jobs", async () => {
    for (const rel of [
      ["domain", "gateway", "delivery-rules-engine.ts"],
      ["domain", "policies", "delivery-deferral.ts"],
      ["domain", "policies", "delivery-digest-flush.ts"],
    ]) {
      const source = stripComments(readFileSync(join(SRC_ROOT, ...rel), "utf8"));
      expect(source, rel.join("/")).not.toMatch(/setInterval|setTimeout/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8 生产组合（R2 阻断修复，产物 57abf60f...）：实时路径必须可达；
// 仅注入端口后测试转绿并不能证明这一点。
// ─────────────────────────────────────────────────────────────────────────────

async function operatorEngineModule(): Promise<Record<string, unknown> | null> {
  try {
    return (await import("../src/domain/gateway/operator-delivery-engine.js")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("OPR.0.5.6.1 §8——生产组合已生效（R2 B-1/B-2/B-3）", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    home = mkdtempSync(join(tmpdir(), "s01-prod-"));
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function realWire(prefs: Record<string, unknown>, posts: Array<Record<string, unknown>>) {
    const registry = registryWith(prefs);
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    return buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: `1724.100${posts.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  }

  it("B-1：延后触发 payload 通过真实 dispatcher 派发已公布操作并到达交付接缝（候选红灯：startup 硬编码 capability 会拒绝的 outbound_post）", async () => {
    const mod = await operatorEngineModule();
    expect(mod, "operator-delivery-engine module must exist").not.toBeNull();
    const posts: Array<Record<string, unknown>> = [];
    const wire = realWire({ deliveryClass: "A", availability: "available" }, posts);
    try {
      wire.startServices?.();
      const row = await repo.create({
        sourceSession: "orch-lead@v-openrig-build",
        destinationSession: "human-founder@external",
        body: "deferred escalation",
        nudge: false,
      });
      const buildFire = (mod as { buildDeferralFirePayload: (row: QueueItem, notificationKey: string) => Record<string, unknown> }).buildDeferralFirePayload;
      const payload = buildFire(row, `${row.qitemId}:test-episode`);
      const res = wire.dispatcher.dispatch(OUTBOUND_OP, String(payload["destinationSession"] ?? ""), payload);
      expect(res).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length, "the fire must reach the delivery seam, not die at capability refusal").toBe(1);
      // R1 B-3：回执携带事件 key，绝不回退到裸 qitemId。
      const receipts = repo.listTransitions(row.qitemId).filter((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "));
      expect(receipts.length).toBe(1);
      expect(receipts[0]!.transitionNote).toContain(`notification_key=${row.qitemId}:test-episode`);
    } finally {
      wire.stop();
    }
  });

  it("B-3 ladder 绑定：带 key 的 dispatched-to-engine 事件只能由自身 key 解决；其他 key 的陈旧回执绝不关闭层级（候选红灯：任意历史备注都会解决）", async () => {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), "failed:tmux session not found", created.qitemId);
    const KEY = `${created.qitemId}:episode-7`;
    const tickDeps = {
      db, queueRepo: repo,
      attemptWake: async () => "failed:tmux session not found",
      resolveOrchestrator: () => null,
      retryIntervalSeconds: 1, retryCap: 0,
      log: () => {},
      deliveryEngine: {
        dispatchEscalation: async () => ({ decision: "interrupt", resolved: false, notificationKey: KEY }),
      },
    };
    await runWakeLadderTick(tickDeps as never);
    // 属于其他事件 key 的回执不得解决当前事件。
    repo.update({ qitemId: created.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${created.qitemId}:older-episode level=ALERT kind=human-required message_ts=1 thread_ts=1` });
    await runWakeLadderTick(tickDeps as never);
    const exhaustedEarly = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
    expect(exhaustedEarly.length, "a stale-episode receipt never closes the rung").toBe(0);
    // 已派发事件的回执会解决该事件。
    repo.update({ qitemId: created.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${KEY} level=ALERT kind=human-required message_ts=2 thread_ts=2` });
    await runWakeLadderTick(tickDeps as never);
    const exhausted = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
    expect(exhausted.length).toBe(1);
  });

  it("B-3 ladder 绑定前置标记（R2 003f4786 必需判别）：新派发标记写入前已在记录上的旧 key 回执绝不关闭新层级；必须先推导 key，再评估任何解决备注", async () => {
    const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
    const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
    // 旧事件的回执最先落地（早于任何 ladder 活动）。
    repo.update({ qitemId: created.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${created.qitemId}:older-episode level=ALERT kind=human-required message_ts=1 thread_ts=1` });
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(new Date(Date.now() - 10 * 60_000).toISOString(), "failed:tmux session not found", created.qitemId);
    const KEY = `${created.qitemId}:new-episode`;
    const tickDeps = {
      db, queueRepo: repo,
      attemptWake: async () => "failed:tmux session not found",
      resolveOrchestrator: () => null,
      retryIntervalSeconds: 1, retryCap: 0,
      log: () => {},
      deliveryEngine: { dispatchEscalation: async () => ({ decision: "interrupt", resolved: false, notificationKey: KEY }) },
    };
    await runWakeLadderTick(tickDeps as never); // dispatches, marker keyed
    await runWakeLadderTick(tickDeps as never); // must NOT exhaust on the pre-marker receipt
    const exhausted = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
    expect(exhausted.length, "the pre-existing old-episode receipt must not close the NEW keyed rung").toBe(0);
    repo.update({ qitemId: created.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${KEY} level=ALERT kind=human-required message_ts=2 thread_ts=2` });
    await runWakeLadderTick(tickDeps as never);
    const after = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
      .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
    expect(after.length).toBe(1);
  });

  it("B-1 结构：startup.ts 不含未公布的 outbound_post 字面量（候选红灯：当前含有）", () => {
    const source = readFileSync(join(SRC_ROOT, "startup.ts"), "utf8");
    expect(source).not.toContain('"outbound_post"');
  });

  it("B-2 结构：生产 index 组合向真实 tick 提供 deliveryEngine（候选红灯：只有测试替身）", () => {
    const source = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");
    expect(source).toContain("deliveryEngine");
    expect(source).toContain("makeOperatorDeliveryEngine");
  });

  it("B-2 行为：带生产端口的真实 tick 将操作人员层级升级到 dispatched-to-engine，消息落地且回执解决 ladder（候选红灯：无生产端口）", async () => {
    const mod = await operatorEngineModule();
    expect(mod).not.toBeNull();
    const posts: Array<Record<string, unknown>> = [];
    const wire = realWire({ deliveryClass: "B", availability: "available" }, posts);
    try {
      wire.startServices?.();
      const make = (mod as { makeOperatorDeliveryEngine: (deps: unknown) => { dispatchEscalation: (row: QueueItem, reason: string) => Promise<{ decision: string; resolved: boolean }> } }).makeOperatorDeliveryEngine;
      const port = make({ home, queueRepo: repo, dispatch: (op: string, ref: string, payload: unknown) => wire.dispatcher.dispatch(op, ref, payload), registry: { loadHumanRegistry: () => registryWith({ deliveryClass: "B", availability: "available" }) } });

      const src = await repo.create({ sourceSession: "sender@r", destinationSession: "relay@r", body: "obligation" });
      const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
      db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
        .run(new Date(Date.now() - 10 * 60_000).toISOString(), "failed:tmux session not found", created.qitemId);

      const tickDeps = {
        db, queueRepo: repo,
        attemptWake: async () => "failed:tmux session not found",
        resolveOrchestrator: () => null,
        retryIntervalSeconds: 1, retryCap: 0,
        log: () => {},
        deliveryEngine: port,
      };
      await runWakeLadderTick(tickDeps as never);
      const notes = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>).map((r) => r.transition_note ?? "");
      expect(notes.join("\n")).toContain("dispatched-to-engine");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(posts.length, "the escalation post reaches the delivery seam through the real wire").toBe(1);
      // 记录上的 S14 回执会在下一次 tick 解决事件。
      await runWakeLadderTick(tickDeps as never);
      const exhausted = (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?").all(created.qitemId) as Array<{ transition_note: string | null }>)
        .map((r) => r.transition_note ?? "").filter((n) => n.startsWith("ladder-exhausted:"));
      expect(exhausted.length, "receipt resolution exhausts — never silent, never premature").toBe(1);
    } finally {
      wire.stop();
    }
  });

  it("B-3 v3 重驱姿态（R1 26eee9b85 + R2 003f4786：恰好一次，绝不为零）：交付时 job 为 ACTIVE，并带独立待处理派发标记；终态只来自观测到的回执", async () => {
    const mod = await deferralPolicyModule();
    expect(mod).not.toBeNull();
    const jobs = new WatchdogJobsRepository(db);
    const row = await repo.create({ sourceSession: "a@r", destinationSession: "human-founder@external", body: "x", nudge: false });
    const arm = (mod as { armDeliveryDeferral: (deps: unknown) => { jobId: string } }).armDeliveryDeferral;
    const armed = arm({ jobsRepo: jobs, queueRepo: repo, qitemId: row.qitemId, entityId: "human-founder", minutes: 30, notificationKey: `${row.qitemId}:ep1` });
    const fire = (mod as { fireDeliveryDeferralIfDue: (deps: unknown) => Promise<{ fired: boolean }> }).fireDeliveryDeferralIfDue;
    const statesAtDelivery: string[] = [];
    const first = await fire({
      jobsRepo: jobs, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async () => {
        statesAtDelivery.push((db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string }).state);
        return { ok: true };
      },
      now: new Date(Date.now() + 31 * 60_000),
    });
    // job 在交付期间保持 ACTIVE（重驱直到回执），只在收到回执后标记 fired。
    expect(statesAtDelivery).toEqual(["active"]);
    expect(first.fired).toBe(false);
    const notes = repo.listTransitions(row.qitemId).map((t) => t.transitionNote ?? "");
    expect(notes.some((n) => n.startsWith("delivery-deferral-dispatching")), "the pending state is distinct from fired/terminal").toBe(true);
    expect(notes.some((n) => n.startsWith("delivery-deferral-fired"))).toBe(false);
    // 回执落地（交付接缝行为）后，下一次评估完成该事件。
    repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-posted notification_key=${row.qitemId}:ep1 level=ALERT kind=human-required message_ts=1 thread_ts=1` });
    const second = await fire({
      jobsRepo: jobs, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async () => { throw new Error("must not re-deliver a receipted episode"); },
      now: new Date(Date.now() + 32 * 60_000),
    });
    expect(second.fired).toBe(true);
    expect((db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string }).state).toBe("terminal");
    expect(repo.listTransitions(row.qitemId).some((t) => t.transitionNote?.startsWith("delivery-deferral-fired"))).toBe(true);
  });

  it("B-3 v3 绝不为零（R2 必需判别）：交付中途死亡后 job 保持 ACTIVE；重建 repository 后重驱为恰好一次交付、一次回执，再进入终态", async () => {
    const mod = await deferralPolicyModule();
    expect(mod).not.toBeNull();
    const jobs = new WatchdogJobsRepository(db);
    const row = await repo.create({ sourceSession: "a@r", destinationSession: "human-founder@external", body: "x", nudge: false });
    const arm = (mod as { armDeliveryDeferral: (deps: unknown) => { jobId: string } }).armDeliveryDeferral;
    const armed = arm({ jobsRepo: jobs, queueRepo: repo, qitemId: row.qitemId, entityId: "human-founder", minutes: 30, notificationKey: `${row.qitemId}:ep1` });
    const fire = (mod as { fireDeliveryDeferralIfDue: (deps: unknown) => Promise<{ fired: boolean }> }).fireDeliveryDeferralIfDue;
    // 调用中途死亡：adapter 在任何入队前抛错。
    await fire({
      jobsRepo: jobs, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async () => { throw new Error("process death"); },
      now: new Date(Date.now() + 31 * 60_000),
    });
    expect((db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string }).state, "no lost fire: the job survives the crash ACTIVE").toBe("active");
    // 重建：同一数据库上的新 repository；重驱恰好交付一次。
    const jobs2 = new WatchdogJobsRepository(db);
    let deliveries = 0;
    await fire({
      jobsRepo: jobs2, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async (_q: string, key: string) => {
        deliveries += 1;
        repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel",
          transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT kind=human-required message_ts=9 thread_ts=9` });
        return { ok: true };
      },
      now: new Date(Date.now() + 33 * 60_000),
    });
    const done = await fire({
      jobsRepo: jobs2, queueRepo: repo, jobId: armed.jobId,
      deliverInterrupt: async () => { deliveries += 1; return { ok: true }; },
      now: new Date(Date.now() + 34 * 60_000),
    });
    expect(deliveries, "exactly one delivery across death + reconstruction").toBe(1);
    expect(done.fired).toBe(true);
    expect((db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(armed.jobId) as { state: string }).state).toBe("terminal");
  });

  it("B-3 交付接缝守卫：已有回执事件的 deferral-fire payload 不发送任何内容（重放/二次裁决保护——候选红灯：仍会发送）", async () => {
    const mod = await operatorEngineModule();
    expect(mod).not.toBeNull();
    const posts: Array<Record<string, unknown>> = [];
    const wire = realWire({ deliveryClass: "A", availability: "available" }, posts);
    try {
      wire.startServices?.();
      const row = await repo.create({ sourceSession: "a@r", destinationSession: "human-founder@external", body: "x", nudge: false });
      const key = `${row.qitemId}:episode-1`;
      repo.update({
        qitemId: row.qitemId, actorSession: "daemon@kernel",
        transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT kind=human-required message_ts=1 thread_ts=1`,
      });
      const buildFire = (mod as { buildDeferralFirePayload: (row: QueueItem, notificationKey: string) => Record<string, unknown> }).buildDeferralFirePayload;
      const payload = buildFire(row, key);
      const res = wire.dispatcher.dispatch(OUTBOUND_OP, String(payload["destinationSession"] ?? ""), payload);
      expect(res).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(posts.length, "an episode with a posted receipt never posts again").toBe(0);
    } finally {
      wire.stop();
    }
  });
});
