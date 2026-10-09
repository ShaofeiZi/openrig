// 已取代的契约完成翻转（2026-08-27 创始人根不变量，原 51-09 增量 4 写入时标记）：
// 本地创建队列时存储裸传输身份；仅在跨主机转发边界添加主机身份
// （routes/queue.ts 在转发时标记），到达的来源三元组逐字存储。深层固定测试位于
// local-bare-identity.test.ts；本文件在新契约下保留原测试套件的仓库级创建接缝。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { setSelfHostId, getSelfHostId } from "../src/domain/hosts/fanout-contract.js";

describe("队列发送方身份——本地写入为裸值，仅转发边界使用三元组", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let prior: string | null;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    prior = getSelfHostId();
    setSelfHostId("mars-01");
  });
  afterEach(() => { setSelfHostId(prior); db.close(); });

  it("即使有已对账 self-id，也以裸值存储 source_session", async () => {
    const row = await repo.create({ sourceSession: "dev50-driver@v-openrig-build", destinationSession: "b@r", body: "x" });
    expect(row.sourceSession).toBe("dev50-driver@v-openrig-build");
  });

  it("逐字存储转发的 ORIGIN 三元组（非裸值守卫：绝不重新标记）", async () => {
    const row = await repo.create({ sourceSession: "pm@other-rig@mm2-openrig1", destinationSession: "b@r", body: "x" });
    expect(row.sourceSession).toBe("pm@other-rig@mm2-openrig1");
  });
});
