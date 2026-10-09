import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("W2b exact-set notify envelope", () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    bus = new EventBus(db);
  });

  afterEach(() => db.close());

  function persisted(label: string) {
    return bus.persistWithinTransaction({
      type: "view.changed",
      viewName: label,
      cause: "w2b-test",
    });
  }

  it("事务打开期间惰性注册，commit 后按 seq 顺序投递", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => {
      expect(db.inTransaction).toBe(false);
      received.push(event);
    });

    bus.withNotifyEnvelope((register) => {
      const first = persisted("first");
      register(first);
      expect(received).toEqual([]);
      const second = persisted("second");
      register(second);
      expect(received).toEqual([]);
    });

    expect(received.map((event) => event.seq)).toEqual([
      received[0]!.seq,
      received[1]!.seq,
    ]);
    expect(received[0]!.seq).toBeLessThan(received[1]!.seq);
    expect(received.map((event) => event.type)).toEqual(["view.changed", "view.changed"]);
  });

  it.each([
    [
      "被覆盖的结果数",
      () => {
        let token = persisted("overwritten-a");
        token = persisted("overwritten-b");
        return [token];
      },
    ],
    [
      "switch 门控收集",
      () => {
        const token = persisted("switch");
        const registered: ReturnType<typeof persisted>[] = [];
        switch ("other") {
          case "register":
            registered.push(token);
            break;
        }
        return registered;
      },
    ],
    [
      "循环 continue 旁路",
      () => {
        const registered: ReturnType<typeof persisted>[] = [];
        for (const label of ["skip", "keep"]) {
          const token = persisted(label);
          if (label === "skip") continue;
          registered.push(token);
        }
        return registered;
      },
    ],
    [
      "更宽的 initializer 变换",
      () => {
        const registered = [persisted("initializer-a"), persisted("initializer-b")]
          .filter((token) => token.type === "view.changed")
          .slice(1);
        return registered;
      },
    ],
  ])("按效果拒绝 %s 判别器", (_name, build) => {
    expect(() =>
      bus.withNotifyEnvelope((register) => {
        for (const token of build()) register(token);
      }),
    ).toThrow(/notify envelope.*持久化.*注册/i);

    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });

  it("比较精确 token 同一性，而非基数", () => {
    expect(() =>
      bus.withNotifyEnvelope((register) => {
        const dropped = persisted("dropped");
        const duplicated = persisted("duplicated");
        void dropped;
        register(duplicated);
        register(duplicated);
      }),
    ).toThrow(/notify envelope.*持久化.*注册/i);

    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });

  it("把当前 miss 保留为产生回滚的校验失败", async () => {
    const queueRepo = new QueueRepository(db, bus);
    const item = await queueRepo.create({
      sourceSession: "source@w2b-rig",
      destinationSession: "owner@w2b-rig",
      body: "current miss",
      nudge: false,
    });

    expect(() =>
      bus.withNotifyEnvelope(() => {
        queueRepo.updateWithinTransaction({
          qitemId: item.qitemId,
          actorSession: "owner@w2b-rig",
          state: "in-progress",
          transitionNote: "intentionally omitted registration",
        });
      }),
    ).toThrow(/notify envelope.*持久化.*注册/i);

    expect(queueRepo.getById(item.qitemId)?.state).toBe("pending");
  });

  it("接受规范注册循环和零事件事务", () => {
    expect(() => bus.withNotifyEnvelope(() => undefined)).not.toThrow();

    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));
    bus.withNotifyEnvelope((register) => {
      const tokens = [persisted("a"), persisted("b")];
      for (const token of tokens) register(token);
    });

    expect(received.map((event) => (event as { viewName?: string }).viewName)).toEqual(["a", "b"]);
  });

  it("对检查了零 envelope 事务的校验失败", () => {
    expect(() => bus.assertNotifyEnvelopeExercised()).toThrow(/未检查任何 notify envelope 事务/i);
    bus.withNotifyEnvelope(() => undefined);
    expect(() => bus.assertNotifyEnvelopeExercised()).not.toThrow();
  });

  it("持久记录畸形行，推进 watermark，并报告 unparseable", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));
    let malformedSeq = 0;

    bus.withNotifyEnvelope(() => {
      malformedSeq = Number(
        db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
          .run(null, null, "malformed.fixture", "{not-json")
          .lastInsertRowid,
      );
    });

    const status = bus.getNotifyDrainStatus();
    expect(status.state).toBe("unparseable");
    expect(status.watermark).toBeGreaterThanOrEqual(malformedSeq);
    expect(status.lastPoison).toMatchObject({ seq: malformedSeq });
    expect(status.lastPoison?.payloadSha).toMatch(/^[a-f0-9]{64}$/);
    expect(status.lastPoison?.error).toBe("事件 payload JSON 无效");
    expect(received.some((event) => event.type === "malformed.fixture")).toBe(false);
    expect(received.filter((event) => event.type === "event.delivery_poisoned")).toHaveLength(1);

    const poison = db.prepare("SELECT payload FROM events WHERE type = 'event.delivery_poisoned'").get() as {
      payload: string;
    };
    expect(JSON.parse(poison.payload)).toMatchObject({
      type: "event.delivery_poisoned",
      poisonedSeq: malformedSeq,
      payloadSha: status.lastPoison?.payloadSha,
    });
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["missing type", "{}"],
    ["non-string type", '{"type":17}'],
  ])("把可解析但畸形的 %s payload 视为 unparseable 第三态", (_label, payload) => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.withNotifyEnvelope(() => {
      db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
        .run(null, null, "malformed.fixture", payload);
    });

    expect(bus.getNotifyDrainStatus()).toMatchObject({
      state: "unparseable",
      lastPoison: { error: "事件 payload 结构无效" },
    });
    expect(received.filter((event) => event.type === "event.delivery_poisoned")).toHaveLength(1);
    expect(received.some((event) => (event as { type?: unknown }).type === 17)).toBe(false);
  });

  it("从 MAX(seq) 起步，使 legacy 畸形行保持 replay-only", () => {
    db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)")
      .run(null, null, "legacy.malformed", "{not-json");
    const freshBus = new EventBus(db);
    const received: PersistedEvent[] = [];
    freshBus.subscribe((event) => received.push(event));

    freshBus.withNotifyEnvelope((register) => {
      register(freshBus.persistWithinTransaction({
        type: "view.changed",
        viewName: "fresh",
        cause: "post-boot",
      }));
    });

    expect(freshBus.getNotifyDrainStatus().state).toBe("healthy");
    expect(received.map((event) => event.type)).toEqual(["view.changed"]);
  });

  it("投递从行派生的值，使 live 与 replay payload 完全一致", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.withNotifyEnvelope((register) => {
      register(bus.persistWithinTransaction({
        type: "view.changed",
        viewName: "parity",
        cause: "row-derived",
        transient: undefined,
      } as Parameters<EventBus["persistWithinTransaction"]>[0]));
    });

    expect(received).toEqual(bus.replayAll(0));
    expect(received[0]).not.toHaveProperty("transient");
  });

  it("正常投递孤儿行，不咨询 live 拓扑", () => {
    const received: PersistedEvent[] = [];
    bus.subscribe((event) => received.push(event));

    bus.withNotifyEnvelope((register) => {
      register(
        bus.persistWithinTransaction({
          type: "rig.deleted",
          rigId: "rig-that-does-not-exist",
        }),
      );
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "rig.deleted", rigId: "rig-that-does-not-exist" });
  });
});
