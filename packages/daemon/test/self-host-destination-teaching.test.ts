// 51-09 increment 4b——destination-host TEACHING 拒绝（架构裁定 c9964404，机制 ii）。
// 三段式 destination 已会明确拒绝（BR-1）；4b 为现有拒绝增量添加结构化指引——
// 它不改变错误码、不添加门禁，也不剥离带内内容。
//
// WIRING PIN（裁定）：该证明覆盖生产环境的 topologyValidateRig 谓词（startup.ts:324-334），
// 而不是接受一切的默认实现（queue-repository.ts:417）。下方 `topologyValidateRig` 原样取自
// startup.ts:324-334，并基于真实 RigRepository——以引用为先，不做层级 green 表演。
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { parseSessionName, isHumanSeatSessionRef } from "../src/domain/session-name.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

function setup(): { repo: QueueRepository; db: Database.Database } {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
  const bus = new EventBus(db);
  const rigRepo = new RigRepository(db);
  rigRepo.createRig("known-rig");
  // startup.ts:324-334 的 topologyValidateRig，基于真实 rigRepo 原样复现：
  const topologyValidateRig = (sessionRef: string): boolean => {
    if (isHumanSeatSessionRef(sessionRef)) return true;
    const parsed = parseSessionName(sessionRef);
    if (parsed.kind !== "canonical") return false;
    return rigRepo.findRigsByName(parsed.rig).length > 0;
  };
  const repo = new QueueRepository(db, bus, { validateRig: topologyValidateRig });
  return { repo, db };
}

async function refusalFrom(fn: () => Promise<unknown>): Promise<QueueRepositoryError> {
  try {
    await fn();
    throw new Error("预期 unknown_destination_rig 拒绝，但调用成功");
  } catch (e) {
    if (e instanceof QueueRepositoryError) return e;
    throw e;
  }
}

describe("51-09 incr 4b——destination-host 指引性拒绝（注入 topologyValidateRig）", () => {
  let db: Database.Database | undefined;
  afterEach(() => { db?.close(); db = undefined; setSelfHostId(null); });

  it("RED1：三段式 destination 以 unknown_destination_rig 拒绝（错误码不变）+ 增量指引（拆分回显 + --host 提示）", async () => {
    const s = setup(); db = s.db;
    const err = await refusalFrom(() => s.repo.create({ sourceSession: "orch@known-rig", destinationSession: "orch@unknown@vps-b", body: "hi", priority: "routine" }));
    expect(err.code).toBe("unknown_destination_rig"); // C1：错误码相同
    expect(err.meta).toBeTruthy();
    expect(err.meta!["destinationSplit"]).toEqual({ member: "orch", rig: "unknown", host: "vps-b" });
    expect(String(err.meta!["hint"])).toContain("--host vps-b");
    expect(String(err.meta!["hint"])).toContain("orch@unknown"); // 不带 host 重新发送
    expect(err.meta!["selfHost"]).toBe(false);
  });

  it("RED2（C4）：带 SELF 后缀的 destination 得到相同拒绝并指明 SELF 场景——不自动剥离/路由回本机", async () => {
    const s = setup(); db = s.db;
    setSelfHostId("host-self");
    const err = await refusalFrom(() => s.repo.create({ sourceSession: "orch@known-rig", destinationSession: "orch@known-rig@host-self", body: "hi", priority: "routine" }));
    expect(err.code).toBe("unknown_destination_rig"); // 已拒绝，未路由回本机
    expect(err.meta!["selfHost"]).toBe(true);
    expect(String(err.meta!["hint"])).toContain("就是当前 host");
    expect(String(err.meta!["hint"])).toContain("orch@known-rig"); // 不带 host 重新发送
    expect(err.meta!["destinationSplit"]).toEqual({ member: "orch", rig: "known-rig", host: "host-self" });
  });

  it("RED3（C1 增量）：普通两段式未知 rig 的拒绝保持不变——无指引字段", async () => {
    const s = setup(); db = s.db;
    const err = await refusalFrom(() => s.repo.create({ sourceSession: "orch@known-rig", destinationSession: "orch@nonexistent", body: "hi", priority: "routine" }));
    expect(err.code).toBe("unknown_destination_rig");
    expect(err.meta).toBeUndefined(); // 增量指引仅适用于包含 '@' 的 rig token
  });

  it("RED4（C2 单一 helper）：跨 host HANDOFF 动词生成相同指引（四处拒绝点共用一个 helper）", async () => {
    const s = setup(); db = s.db;
    const src = await s.repo.create({ sourceSession: "orch@known-rig", destinationSession: "seat@known-rig", body: "hi", priority: "routine" });
    const errHandoff = await refusalFrom(() => s.repo.handoff({ qitemId: src.qitemId, fromSession: "orch@known-rig", toSession: "seat@unknown@vps-b" }));
    expect(errHandoff.code).toBe("unknown_destination_rig");
    expect(String(errHandoff.meta?.["hint"])).toContain("--host vps-b");
    const errHac = await refusalFrom(() => s.repo.handoffAndComplete({ qitemId: src.qitemId, fromSession: "orch@known-rig", toSession: "seat@unknown@vps-b" }));
    expect(errHac.code).toBe("unknown_destination_rig");
    expect(String(errHac.meta?.["hint"])).toContain("--host vps-b");
  });

  it("RED5（C5 如实范围）：两段式同名 destination 仍能校验并创建——不在此门禁拦截（仅由 --host / incr-3 闭环）", async () => {
    const s = setup(); db = s.db;
    // D10 silent-mint 类别（member@rig 的名称存在于本地，但发送方意图指向其他位置的同名 rig）
    // 不由此指引门禁闭环——只能通过带外 --host envelope + 发送方剥离闭环。如实范围对照：
    const item = await s.repo.create({ sourceSession: "orch@known-rig", destinationSession: "seat@known-rig", body: "hi", priority: "routine" });
    expect(item.qitemId).toBeTruthy();
  });
});
