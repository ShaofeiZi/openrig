import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

describe("OutboxHandler 发件箱处理器", () => {
  let db: Database.Database;
  let outbox: OutboxHandler;

  beforeEach(() => {
    db = createDb();
    migrate(db, [outboxEntriesSchema]);
    outbox = new OutboxHandler(db);
  });

  afterEach(() => db.close());

  it("record 创建 pending 状态的条目", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "fyi",
      tags: ["info"],
    });
    expect(e.outboxId).toMatch(/^outbox-\d{14}-[a-f0-9]{8}$/);
    expect(e.deliveryState).toBe("pending");
    expect(e.tags).toEqual(["info"]);
  });

  it("record 对 outbox_id 幂等", () => {
    const id = "outbox-fixed-id-0001";
    const a = outbox.record({
      outboxId: id,
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "第一条",
    });
    const b = outbox.record({
      outboxId: id,
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "第二条（忽略）",
    });
    expect(a.outboxId).toBe(b.outboxId);
    expect(b.body).toBe("第一条");
  });

  it("markDelivered 更新状态与时间戳", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const delivered = outbox.markDelivered(e.outboxId);
    expect(delivered.deliveryState).toBe("delivered");
    expect(delivered.deliveredAt).toBeTruthy();
  });

  it("对已交付条目调用 markDelivered 不执行操作（返回现有条目）", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    outbox.markDelivered(e.outboxId);
    const second = outbox.markDelivered(e.outboxId);
    expect(second.deliveryState).toBe("delivered");
  });

  it("markFailed 将 pending 转换为 failed", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const failed = outbox.markFailed(e.outboxId);
    expect(failed.deliveryState).toBe("failed");
  });

  // W1-b（事务闭合）——INDETERMINATE 表示结果不明确：无法确认是否落地的交付
  //（传输 res.ok 但未验证）记录为 `indeterminate`，绝不静默记为 `delivered`，也绝不
  // 记为 `failed`。这是在带外解决的保留状态，不是重试状态。
  it("markIndeterminate 将 pending 转换为 indeterminate（从 pending 执行 CAS）", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const indet = outbox.markIndeterminate(e.outboxId);
    expect(indet.deliveryState).toBe("indeterminate");
  });

  it("markIndeterminate 绝不覆盖已确认交付（delivered 保持 delivered）", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    outbox.markDelivered(e.outboxId);
    // 延迟或竞态产生的不确定解析不得覆盖 delivered 行——CAS 以
    // delivery_state='pending' 为条件，因此这里不执行操作。
    const after = outbox.markIndeterminate(e.outboxId);
    expect(after.deliveryState).toBe("delivered");
  });

  // 已裁定（W1-b，经规划者确认）：indeterminate 是由 CAS 保证的终态。markDelivered
  // 与 markFailed 均以 delivery_state='pending' 为门禁，因此之后都不能触碰
  // indeterminate 行。这是预期行为——结果不明确时不能静默改为 delivered（无法确认），
  // 也不能改为 failed（可能已落地）；重新交付会有重复发送风险。协调 indeterminate 行
  // 属于范围外后续工作，不是 W1 转换。
  it("indeterminate 是 CAS 终态：对其调用 markDelivered 不执行操作", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    outbox.markIndeterminate(e.outboxId);
    const after = outbox.markDelivered(e.outboxId);
    expect(after.deliveryState).toBe("indeterminate");
  });

  it("indeterminate 是 CAS 终态：对其调用 markFailed 不执行操作", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    outbox.markIndeterminate(e.outboxId);
    const after = outbox.markFailed(e.outboxId);
    expect(after.deliveryState).toBe("indeterminate");
  });

  it("listForSender 按时间倒序返回", () => {
    outbox.record({ senderSession: "a@r", destinationSession: "b@r", body: "1" });
    outbox.record({ senderSession: "a@r", destinationSession: "b@r", body: "2" });
    outbox.record({ senderSession: "x@r", destinationSession: "b@r", body: "3" });
    const list = outbox.listForSender("a@r");
    expect(list).toHaveLength(2);
    expect(list[0]!.body).toBe("2");
  });
});
