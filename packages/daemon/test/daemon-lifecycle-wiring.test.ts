import { describe, it, expect } from "vitest";
import { createDaemon } from "../src/startup.js";
import { DaemonLifecycleStore } from "../src/domain/daemon-lifecycle-store.js";

// review50-r1 后续项：store data layer 已有单元测试，但 boot 接线（startup 调用 recordBoot）此前只由
// live kill-9 e2e 证明——未来若丢失接线，CI 会静默通过。此低成本 boot-level 锁定补上缺口。
describe("P7 接线锁定——startup recordBoot 在 boot 时运行", () => {
  it("createDaemon boot 后存在 lifecycle boot row（删除 recordBoot 调用会在此失败）", async () => {
    const { db } = await createDaemon({ dbPath: ":memory:" });
    const rec = new DaemonLifecycleStore(db).get();
    expect(rec).not.toBeNull();
    expect(rec!.bootEpoch).toBeTruthy();
    expect(rec!.startedAt).toBeTruthy();
    expect(rec!.stoppedAt).toBeNull(); // 全新 boot 尚无 clean-shutdown mark。
  });
});
