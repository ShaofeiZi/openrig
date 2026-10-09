// 创始人根不变量（L2 行、transitions 10816/10817，取代裁定 cb19867f Q2）：在同一个
// OpenRig 实例内，所有持久行与渲染表面的 seat identity 都使用裸 `member@rig`——包括本地
// queue create、handoff wake envelope、本地 From 行与回复提示，以及下游 Slack thread map。
// 只有在跨 host 转发边界才添加 host identity（保留 routes/queue.ts 的 FORWARD 时盖章）；
// 收到真实 origin triple 时则逐字传递。
//
// 修复前字节上的 RED：51-09 always-suffix producer 会在本地盖上 self-host ID——create
// 持久化 triple，冻结的 wake envelope 渲染 triple From/回复提示，envelope wrapper 再追加
// 收到的 ID。删除这些本地 producer 前，下列约束会失败。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
// P8：使用规范 migration 列表，绝不手工维护内联子集。
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";
import { setSelfHostId, getSelfHostId } from "../src/domain/hosts/fanout-contract.js";

const TEST_HOST = "host-red-invariant";

describe("本地裸身份——实例内任何表面都不附加 self-host 后缀", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let outbox: OutboxHandler;
  let priorSelfId: string | null;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    outbox = new OutboxHandler(db);
    repo.attachOutbox(outbox);
    priorSelfId = getSelfHostId();
    setSelfHostId(TEST_HOST); // boot 协调出的 self ID 已知，但不得泄漏到本地。
  });
  afterEach(() => {
    setSelfHostId(priorSelfId);
    db.close();
  });

  it("queue CREATE 持久化裸 transport identity，绝不保存 self-host triple", async () => {
    const row = await repo.create({
      sourceSession: "dev-driver@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "local row",
    });
    expect(row.sourceSession, "本地 source_session 必须保持裸 member@rig").toBe("dev-driver@v-openrig-build");
    expect(row.sourceSession).not.toContain(TEST_HOST);
  });

  it("create 收到真实 ORIGIN TRIPLE（跨 host 转发）时逐字存储，边界语义不受本地删除影响", async () => {
    const row = await repo.create({
      sourceSession: "pm-lead@other-rig@host-remote1",
      destinationSession: "orch-lead@v-openrig-build",
      body: "forwarded row",
    });
    expect(row.sourceSession).toBe("pm-lead@other-rig@host-remote1"); // 既不重复盖章，也不剥离。
  });

  it("HANDOFF 冻结 wake envelope 渲染裸 From 和可在本地复制粘贴的回复提示", async () => {
    const row = await repo.create({
      sourceSession: "dev-driver@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "to hand off",
    });
    await repo.handoff({
      qitemId: row.qitemId,
      fromSession: "dev-driver@v-openrig-build",
      toSession: "orch-lead@v-openrig-build",
      nudge: true,
    });
    const intents = db
      .prepare("SELECT outbox_id, body FROM outbox_entries WHERE outbox_id LIKE ?")
      .all(`${WAKE_INTENT_PREFIX}%`) as { outbox_id: string; body: string }[];
    expect(intents.length).toBeGreaterThan(0);
    const env = intents[intents.length - 1]!.body;
    expect(env).toContain("From: dev-driver@v-openrig-build\n"); // 裸值并以换行界定，不是 triple 前缀。
    expect(env).toContain(`↩ 回复：zrig send dev-driver@v-openrig-build "..."`); // 本地可原样使用。
    expect(env).not.toContain(TEST_HOST);
  });

  it("envelope wrapper 按原样渲染 LOCAL sender，不附加 host ID", () => {
    // 通过宽松 cast 调用，使该约束在修复前后都不受签名变化影响：修复前第 4 个参数是调用方
    // 传入并会被追加的 selfHostId（RED）；修复后参数已删除，sender 按收到的值渲染（GREEN）。
    const env = (wrapPaneEnvelope as (...args: unknown[]) => string)(
      "dev-driver@v-openrig-build",
      "orch-lead@v-openrig-build",
      "hello",
      TEST_HOST,
    );
    expect(env).toContain("From: dev-driver@v-openrig-build\n");
    expect(env).toContain(`↩ 回复：zrig send dev-driver@v-openrig-build "..."`);
    expect(env).not.toContain(TEST_HOST);
  });

  it("envelope wrapper 逐字保留真实 origin TRIPLE（跨 host From 保持限定）", () => {
    const env = (wrapPaneEnvelope as (...args: unknown[]) => string)(
      "pm-lead@other-rig@host-remote1",
      "orch-lead@v-openrig-build",
      "hello from afar",
      TEST_HOST,
    );
    expect(env).toContain("From: pm-lead@other-rig@host-remote1");
    expect(env).toContain(`↩ 回复：zrig send pm-lead@other-rig@host-remote1 "..."`);
  });
});
