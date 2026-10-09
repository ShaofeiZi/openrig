// 切片 15——SeatActivityService 单元测试（TDD）。
//
// 该服务是 daemon 中 `terminal-active` 原语的所有者。它以可配置周期轮询 tmux 的逐 pane
// 静默标志，并以规范会话名称为键在内存中保存最新观察。下游消费者（ps-projection、
// node-inventory，以及通过事件流接入的 UI hook）通过该服务读取。该服务不触碰
// queue/assignment 状态——这是非推断契约。

import { describe, it, expect, vi } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// 切片 15——以规范会话名称为键的 tmux 适配器 mock。映射值为最后活动的 Unix epoch 秒数，
// 或用 null 模拟“无信号”（目标缺失或 tmux 输出为空，例如 velocity-qa 观察到的 tmux 3.6a 行为）。
function makeTmuxAdapter(
  lastActivityBySession: Record<string, number | null>,
): TmuxAdapter {
  return {
    readPaneLastActivity: vi.fn(async (paneId: string) => {
      return Object.prototype.hasOwnProperty.call(lastActivityBySession, paneId)
        ? lastActivityBySession[paneId]!
        : null;
    }),
  } as unknown as TmuxAdapter;
}

const FIXED_NOW = new Date("2026-05-16T10:00:00.000Z");
const FIXED_NOW_EPOCH = FIXED_NOW.getTime() / 1000;

describe("SeatActivityService", () => {
  it("window_activity 位于静默窗口内时，pollSeat 记录 ACTIVE 观察", async () => {
    // 1 秒前有活动，窗口 3 秒 → active
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 1 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@rig");

    expect(observed).not.toBeNull();
    expect(observed!.paneId).toBe("claude@rig");
    expect(observed!.isActiveWithinWindow).toBe(true);
    expect(observed!.silenceWindowSeconds).toBe(3);
    expect(observed!.lastObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("window_activity 早于静默窗口时，pollSeat 记录 IDLE 观察", async () => {
    // 10 秒前有活动，窗口 5 秒 → idle（10 秒 ≥ 5 秒）
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 10 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 5, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@rig");

    expect(observed!.isActiveWithinWindow).toBe(false);
    expect(observed!.silenceWindowSeconds).toBe(5);
  });

  it("HG-7 判别项——活动时间戳相同而窗口不同：window=3 → idle；window=20 → active", async () => {
    // 最后活动在 10 秒前。窗口 3 秒时为 idle；窗口 20 秒时为 active。
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 10 });
    const tight = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });
    const loose = new SeatActivityService({ tmux, defaultWindowSeconds: 20, now: () => FIXED_NOW });

    const tightObs = await tight.pollSeat("claude@rig");
    const looseObs = await loose.pollSeat("claude@rig");

    expect(tightObs!.isActiveWithinWindow).toBe(false); // 10s > 3s
    expect(looseObs!.isActiveWithinWindow).toBe(true);  // 10s < 20s
  });

  it("tmux 读取返回 null 时 pollSeat 返回 null（无观察；消费者视为 'unknown'）", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": null });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    expect(await svc.pollSeat("claude@rig")).toBeNull();
  });

  it("getSeatActivity 返回 seat 最新的存储观察", async () => {
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    expect(svc.getSeatActivity("claude@rig")).toBeNull();
    await svc.pollSeat("claude@rig");

    const stored = svc.getSeatActivity("claude@rig");
    expect(stored).not.toBeNull();
    expect(stored!.isActiveWithinWindow).toBe(true);
  });

  it("getSeatActivity 逐 seat 定键；观察不会在 seat 之间泄漏", async () => {
    // a 为 idle（60 秒前），b 为 active（当前）
    const tmux = makeTmuxAdapter({
      "a@rig": FIXED_NOW_EPOCH - 60,
      "b@rig": FIXED_NOW_EPOCH,
    });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    await svc.pollSeat("a@rig");
    await svc.pollSeat("b@rig");

    expect(svc.getSeatActivity("a@rig")!.isActiveWithinWindow).toBe(false);
    expect(svc.getSeatActivity("b@rig")!.isActiveWithinWindow).toBe(true);
  });

  it("pollSeat 会遵循逐 seat 覆盖值；默认值作为回退", async () => {
    // 5 秒前有活动。默认窗口 3 秒 → idle；覆盖为 10 秒 → active。
    const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 5 });
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

    const observed = await svc.pollSeat("claude@rig", { silenceWindowSeconds: 10 });
    expect(observed!.silenceWindowSeconds).toBe(10);
    expect(observed!.isActiveWithinWindow).toBe(true); // 5s < 10s

    const observed2 = await svc.pollSeat("claude@rig"); // no override → default 3s
    expect(observed2!.silenceWindowSeconds).toBe(3);
    expect(observed2!.isActiveWithinWindow).toBe(false); // 5s > 3s
  });

  it("吸收 tmux 错误，使轮询失败绝不会让 daemon 循环崩溃", async () => {
    const tmux = {
      readPaneLastActivity: vi.fn(async () => {
        throw new Error("tmux gone");
      }),
    } as unknown as TmuxAdapter;
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });

    await expect(svc.pollSeat("claude@rig")).resolves.toBeNull();
  });

  // 切片 15 非推断契约（HG-4 部分）：服务没有 queue/assignment 状态输入端口。即使在类型层，
  // 构造函数也不得接受 queue repo / projection。若未来贡献者在此读取队列数据，
  // 此构造函数结构测试会编译失败，从而暴露回归。
  it("HG-4 部分——构造函数表面仅依赖 tmux + 周期（无 queue/assignment 输入）", () => {
    const tmux = makeTmuxAdapter({});
    // 构造函数只接受 `tmux` + `defaultWindowSeconds`（以及可选 bus）。
    // 若尝试传入任何 queue/assignment 形态的依赖，编译会失败。
    const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
    expect(svc).toBeDefined();
  });

  // ── 架构裁定 3a947fb1（pulse PARKED-WITH-BATON owner 空闲时长）：pollSeat 已读取原始
  // ── window_activity epoch 来派生 active/idle，随后将其丢弃。FR-7 以加法方式将其作为
  // ── `lastActivityAt`（ISO）显示在记录上。原始事实绝不截断（C2）；只增加一个字段，不增加
  // ── ageSeconds 同级字段（C3——age 是渲染器侧视图 = f(fact, reader-clock)）。
  describe("lastActivityAt——原始 window_activity 事实（架构 3a947fb1）", () => {
    it("将原始活动 epoch 记录为 ISO——与 lastObservedAt（观察时间）不同", async () => {
      // 活动发生在观察时钟之前 10 秒。
      const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH - 10 });
      const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

      const observed = await svc.pollSeat("claude@rig");

      // 该事实是 tmux 活动时间，而非我们观察它的时间。
      expect(observed!.lastActivityAt).toBe(new Date((FIXED_NOW_EPOCH - 10) * 1000).toISOString());
      expect(observed!.lastObservedAt).toBe(FIXED_NOW.toISOString());
      expect(observed!.lastActivityAt).not.toBe(observed!.lastObservedAt);
    });

    it("C2 原始事实，不截断——时钟偏差使活动时间领先观察时钟时保留原值，不向下修正", async () => {
      // 时钟偏差：tmux 报告的活动时间比本地时钟早到未来 5 秒。
      const tmux = makeTmuxAdapter({ "claude@rig": FIXED_NOW_EPOCH + 5 });
      const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

      const observed = await svc.pollSeat("claude@rig");

      // 原样呈现——领先 lastObservedAt。投影绝不截断/向下修正；渲染器仅为显示而截断。
      expect(observed!.lastActivityAt).toBe(new Date((FIXED_NOW_EPOCH + 5) * 1000).toISOString());
      expect(Date.parse(observed!.lastActivityAt)).toBeGreaterThan(Date.parse(observed!.lastObservedAt));
    });

    it("C1 无信号则缺失——tmux 读取为 null 时不生成记录（事实缺失，绝不伪造）", async () => {
      const tmux = makeTmuxAdapter({ "claude@rig": null });
      const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

      expect(await svc.pollSeat("claude@rig")).toBeNull();
      expect(svc.getSeatActivity("claude@rig")).toBeNull(); // no record ⟹ no lastActivityAt
    });
  });

  describe("pollAllRunningTmuxSeats", () => {
    // 使用与 daemon 相同的数据库 schema——采用 test-app 辅助函数创建包含全部迁移的内存数据库。
    async function makeDb() {
      const { createFullTestDb } = await import("./helpers/test-app.js");
      return createFullTestDb();
    }

    it("单次并发：前一轮仍在进行时启动完整扫描，不会增加重叠读取（对应 seat-structural-activity-service 必修项 2）", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)").run("s1", "n1", "dev@rig", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)").run("s2", "n2", "qa@rig", "running", ts);

        // 阻塞逐 seat 读取，使第一轮扫描在第二轮触发时仍在进行。
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let reads = 0;
        const tmux = {
          readPaneLastActivity: vi.fn(async () => { reads += 1; await gate; return FIXED_NOW_EPOCH - 1; }),
        } as unknown as TmuxAdapter;
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

        const sweep1 = svc.pollAllRunningTmuxSeats(db);       // starts; issues both reads, both hold on the gate
        await new Promise((r) => setTimeout(r, 0));           // flush so sweep1's reads are issued
        expect(reads).toBe(2);                                // sweep1 is in flight, holding two reads

        const sweep2 = svc.pollAllRunningTmuxSeats(db);       // must be single-flight while sweep1 holds
        await new Promise((r) => setTimeout(r, 0));           // give sweep2 a tick to do whatever it will
        expect(reads).toBe(2);                                // WITHOUT the guard sweep2 would add 2 more reads (overlap)

        release();
        await Promise.all([sweep1, sweep2]);
        expect(reads).toBe(2);

        // 守卫在 finally 中重置：稳定后的新一轮扫描正常运行
        await svc.pollAllRunningTmuxSeats(db);
        expect(reads).toBe(4);
      } finally {
        db.close();
      }
    });

    it("对每个运行中的 tmux 绑定 seat 轮询一次；以规范会话名称为键存储观察", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s2", "n2", "qa@rig", "running", ts);

        const tmux = makeTmuxAdapter({
          "dev@rig": FIXED_NOW_EPOCH,         // active (now)
          "qa@rig": FIXED_NOW_EPOCH - 60,     // idle (60s old, window 3s)
        });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });

        await svc.pollAllRunningTmuxSeats(db);

        expect(svc.getSeatActivity("dev@rig")!.isActiveWithinWindow).toBe(true);
        expect(svc.getSeatActivity("qa@rig")!.isActiveWithinWindow).toBe(false);
        expect(tmux.readPaneLastActivity).toHaveBeenCalledTimes(2);
      } finally {
        db.close();
      }
    });

    it("跳过 detached / stopped seat——只轮询 `running` 状态", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n2', 'r1', 'qa')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s2", "n2", "qa@rig", "detached", ts);

        const tmux = makeTmuxAdapter({
          "dev@rig": FIXED_NOW_EPOCH,
          "qa@rig": FIXED_NOW_EPOCH,
        });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3, now: () => FIXED_NOW });
        await svc.pollAllRunningTmuxSeats(db);

        expect(svc.getSeatActivity("dev@rig")).not.toBeNull();
        expect(svc.getSeatActivity("qa@rig")).toBeNull(); // detached → skipped
        expect(tmux.readPaneLastActivity).toHaveBeenCalledTimes(1);
      } finally {
        db.close();
      }
    });

    it("丢弃已不在运行集合中的 seat 缓存观察（内存卫生）", async () => {
      const db = await makeDb();
      try {
        db.prepare("INSERT INTO rigs (id, name) VALUES ('r1', 'rig-a')").run();
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1', 'r1', 'dev')").run();
        const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, ?, ?)")
          .run("s1", "n1", "dev@rig", "running", ts);

        const tmux = makeTmuxAdapter({ "dev@rig": FIXED_NOW_EPOCH });
        const svc = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
        await svc.pollAllRunningTmuxSeats(db);
        expect(svc.getSeatActivity("dev@rig")).not.toBeNull();

        // 停止 seat；预期下一轮扫描会丢弃该观察。
        db.prepare("UPDATE sessions SET status = 'detached' WHERE id = 's1'").run();
        await svc.pollAllRunningTmuxSeats(db);
        expect(svc.getSeatActivity("dev@rig")).toBeNull();
      } finally {
        db.close();
      }
    });
  });
});
