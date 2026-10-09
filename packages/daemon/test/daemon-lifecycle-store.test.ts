import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { DaemonLifecycleStore } from "../src/domain/daemon-lifecycle-store.js";

describe("DaemonLifecycleStore——P7 atom 1（mig-061 lifecycle record）", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createFullTestDb();
  });

  it("首次 boot 前 get() 为 null", () => {
    expect(new DaemonLifecycleStore(db).get()).toBeNull();
  });

  it("recordBoot 写入 epoch + started_at；heartbeat + stopped 为 null", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("epoch-1", "2026-08-07T00:00:00.000Z");
    const r = s.get()!;
    expect(r.bootEpoch).toBe("epoch-1");
    expect(r.startedAt).toBe("2026-08-07T00:00:00.000Z");
    expect(r.lastHeartbeatAt).toBeNull();
    expect(r.stoppedAt).toBeNull();
  });

  it("新的 boot 生成新 epoch、推进 started_at，并清除上次运行的 stopped_at + heartbeat", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("epoch-1", "2026-08-07T00:00:00.000Z");
    s.recordHeartbeat("2026-08-07T00:05:00.000Z");
    s.recordStop("epoch-1", "2026-08-07T00:10:00.000Z");

    s.recordBoot("epoch-2", "2026-08-07T01:00:00.000Z"); // 新 boot
    const r = s.get()!;
    expect(r.bootEpoch).toBe("epoch-2");
    expect(r.startedAt).toBe("2026-08-07T01:00:00.000Z");
    expect(r.stoppedAt).toBeNull(); // 不是上次运行的 stop
    expect(r.lastHeartbeatAt).toBeNull();
  });

  it("运行期间 recordHeartbeat 推进 last_heartbeat_at", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("e", "2026-08-07T00:00:00.000Z");
    s.recordHeartbeat("2026-08-07T00:01:00.000Z");
    expect(s.get()!.lastHeartbeatAt).toBe("2026-08-07T00:01:00.000Z");
    s.recordHeartbeat("2026-08-07T00:02:00.000Z");
    expect(s.get()!.lastHeartbeatAt).toBe("2026-08-07T00:02:00.000Z");
  });

  it("recordHeartbeat 保护 not-stopped——stop 后的 stray tick 不得推进 last-seen（写入顺序 pin）", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("e", "2026-08-07T00:00:00.000Z");
    s.recordHeartbeat("2026-08-07T00:05:00.000Z");
    s.recordStop("e", "2026-08-07T00:10:00.000Z");
    s.recordHeartbeat("2026-08-07T00:11:00.000Z"); // stop 后的 stray tick
    const r = s.get()!;
    expect(r.stoppedAt).toBe("2026-08-07T00:10:00.000Z");
    expect(r.lastHeartbeatAt).toBe("2026-08-07T00:05:00.000Z"); // 未推进到 stop 之后
  });

  it("recordStop 对每个 epoch 都是 terminal——第二次 stop（或错误 epoch）不会移动 stopped_at", () => {
    const s = new DaemonLifecycleStore(db);
    s.recordBoot("e1", "2026-08-07T00:00:00.000Z");
    s.recordStop("e1", "2026-08-07T00:10:00.000Z");
    s.recordStop("e1", "2026-08-07T00:20:00.000Z"); // 第二次 stop——忽略（terminal）
    s.recordStop("e-other", "2026-08-07T00:30:00.000Z"); // 错误 epoch——忽略
    expect(s.get()!.stoppedAt).toBe("2026-08-07T00:10:00.000Z");
  });
});
