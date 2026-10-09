import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

// 缺陷 qitem-20260827065907-b9ae334c（S1-class，desk 已在 live 验证，3 个样本）：queue NUDGE
// 路径会对 @external human 目标落入 tmux 解析，并记录
// `failed: Session 'human-founder@external' not found: tmux reports no session`，而 gateway 子系统
//（Slack connector 的 queue-polling bridge）实际上已经投递消息。问题分两部分：(a) @external wake
// 由 gateway 所有——row 本身是 connector 的输入，connector ledger 是投递记录；绝不能查询 tmux；
// (b) 对 tmux 永远无法承载的地址类别，记录措辞必须诚实。受污染的 `failed:` 字面量还破坏了
// undelivered surface（已投递给 founder 的消息被读成失败 wake——dogfood aggregation caveat）。

const FOUNDER = "human-founder@external";

describe("external-nudge 记账（gateway 所有，绝不走 tmux）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let sends: Array<{ session: string; text: string }>;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    sends = [];
    repo = new QueueRepository(db, bus, {
      transport: {
        // 此类别 live 样本的准确 transport 行为：tmux 无法承载它。
        send: async (sessionName: string, text: string) => {
          sends.push({ session: sessionName, text });
          return sessionName.endsWith("@external")
            ? { ok: false, error: `Session '${sessionName}' not found: tmux reports no session with this name. No text was sent. Check available sessions with: rig ps --nodes` }
            : { ok: true, verified: true };
        },
      },
    });
    repo.attachOutbox(new OutboxHandler(db));
  });

  afterEach(() => db.close());

  it("样本形态：create nudge @external 时绝不触碰 tmux transport，并记录 gateway-owned 结果", async () => {
    const item = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: FOUNDER,
      body: "L1 alert for the founder",
      summary: "Founder alert: plain-language decision ask",
      evidenceRef: "shared-docs/rigs/v-openrig-build/state/evidence-a.md",
    });
    // (a) 未查询 tmux——row 本身就是 gateway 输入：
    expect(sends).toHaveLength(0);
    const fresh = repo.getById(item.qitemId)!;
    // (b) 措辞如实：点名所属子系统及未查询 tmux；对 tmux 永远无法承载的地址类别，绝不声称存在
    // 正向 tmux evidence。
    expect(fresh.lastNudgeResult).toMatch(/^gateway-owned/);
    expect(fresh.lastNudgeResult).toMatch(/未查询 tmux/i);
    expect(fresh.lastNudgeResult).not.toMatch(/^failed:/);
    expect(fresh.lastNudgeResult).not.toMatch(/tmux reports no session/);
    expect(fresh.lastNudgeAttempt).not.toBeNull(); // attempt 仍会记录。
  });

  it("DOGFOOD SURFACE 已修复：@external row 绝不出现在 undelivered（failed-nudge）surface", async () => {
    const item = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: FOUNDER,
      body: "founder message that DID deliver via slack",
      summary: "Founder message: delivered on the phone",
      evidenceRef: "shared-docs/rigs/v-openrig-build/state/evidence-b.md",
    });
    const undelivered = repo.findUndelivered({});
    expect(undelivered.map((u) => u.qitemId)).not.toContain(item.qitemId);
  });

  it("HANDOFF INTENT 路径：发往 @external 的 wake intent 以 gateway-owned 方式 drain，且不触碰 transport", async () => {
    const item = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "dev50-driver@v-openrig-build",
      body: "work",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "dev50-driver@v-openrig-build" });
    await repo.handoff({
      qitemId: item.qitemId,
      fromSession: "dev50-driver@v-openrig-build",
      toSession: FOUNDER,
      summary: "Escalation to the founder in plain language",
      evidenceRef: "shared-docs/rigs/v-openrig-build/state/evidence-c.md",
    });
    await repo.drainPendingWakeIntents();
    expect(sends.filter((s) => s.session === FOUNDER)).toHaveLength(0);
    const successor = repo
      .list({ destinationSession: FOUNDER, limit: 10 })
      .find((r) => r.handedOffFrom === item.qitemId)!;
    expect(successor).toBeDefined();
    expect(successor.lastNudgeResult ?? "").toMatch(/^gateway-owned/);
  });

  it("对照：普通 agent 目标仍与此前一样通过 tmux transport nudge", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "ping",
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.session).toBe("bob@rig");
    expect(repo.getById(item.qitemId)!.lastNudgeResult).toBe("verified");
  });

  it("对照：带真实 pane 的 human 类 seat（human-*@kernel）保留 tmux transport——只有虚拟 @external domain 归 gateway 所有", async () => {
    const item = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-operator@kernel",
      body: "operator ping",
      summary: "Operator ping in plain language",
      evidenceRef: "shared-docs/rigs/v-openrig-build/state/evidence-d.md",
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.session).toBe("human-operator@kernel");
    expect(repo.getById(item.qitemId)!.lastNudgeResult).toBe("verified");
  });
});
