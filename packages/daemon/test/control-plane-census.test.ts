// OPR.0.5.3.10 mini-req 5——确定性调用计数判别项。每个测试固定一次完整周期内“底层进程枚举运行
// 多少次”。在修正前，这些计数按席位、按尝试产生：divergence poll 为每个席位派生一次 `ps`，
// snapshot refresh 为每个 codex 席位最多派生八次；这正是实测 control-plane 崩塌
//（171 个 list_processes span，平均 9.39s；298 个 resolve_home span，平均 8.24s）。
import { describe, it, expect, vi } from "vitest";
import { ProcessCensus } from "../src/domain/process-census.js";
import { ModelDivergenceMonitor } from "../src/domain/model-divergence/model-divergence-monitor.js";
import { resolveLiveCodexThreadId } from "../src/domain/model-divergence/current-generation-record.js";
import { CodexThreadIdResolver, lstartToMinTs } from "../src/domain/codex-thread-id.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { PeriodicSnapshotScheduler } from "../src/domain/periodic-snapshot-scheduler.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { seedCodexThreads } from "./helpers/codex-state.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const ROWS = [{ pid: 10, ppid: 1, command: "zsh" }];

function advancingClock(step = 60_000): () => number {
  let t = 0;
  return () => (t += step);
}

describe("OPR.0.5.3.10——每个周期一次 census", () => {
  it("mini-req 1：对三个 pinned 席位执行一次 divergence pass 时，底层枚举只运行一次", async () => {
    const underlying = vi.fn(async () => ROWS);
    // 前进的时钟使 freshness 失效；只有 cycle memo 能去重。
    const census = new ProcessCensus({ list: underlying, freshnessMs: 0, now: advancingClock() });
    const seats = ["a", "b", "c"].map((id) => ({
      nodeId: `n-${id}`, rigId: "r", rigName: "rig", runtime: "codex",
      pinnedModel: "gpt-x", sessionName: `${id}@rig`, generation: `gen-${id}`,
    }));
    const monitor = new ModelDivergenceMonitor({
      processCensus: census,
      listPinnedSeats: () => seats,
      // 镜像 startup closure 结构：传入时使用 cycle lister，否则逐席位枚举（BASE 行为会使本测试
      // 计数为 3，这就是判别项）。
      readEffectiveModel: async (seat, cycle) => {
        const live = await resolveLiveCodexThreadId(seat.sessionName, {
          getPanePid: async () => 10,
          listProcesses: cycle ? cycle.listProcesses : () => census.list(),
          readThreadIdByPid: () => undefined,
        });
        return live.ok ? { ok: true, model: "gpt-x" } : { ok: false, reason: live.reason };
      },
      sendToSession: async () => ({ ok: true }),
      resolveOrchSeats: () => [],
      resolveOperatorSeat: () => null,
      resolveOversightSeat: () => null,
      recordProclamation: () => {},
    });
    await monitor.checkOnce();
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("mini-req 2：含 codex 席位的两个 rig 执行一次 snapshot tick 时，底层枚举只运行一次且只尝试一次", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    for (const rigName of ["rig-a", "rig-b"]) {
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", cwd: "/w" });
      const session = sessionRegistry.registerSession(node.id, `dev-qa@${rigName}`);
      sessionRegistry.updateStatus(session.id, "running");
    }

    const underlying = vi.fn(async () => ROWS);
    const census = new ProcessCensus({ list: underlying, freshnessMs: 0, now: advancingClock() });
    const getPanePid = vi.fn(async () => 10);
    const sleep = vi.fn(async () => {});
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: { getPanePid } as unknown as TmuxAdapter,
      // instance lister 也计数：若 tick 绕过 census 并回退到此处，下方计数断言会捕获。
      listProcesses: () => { throw new Error("tick must use the cycle census, not the instance lister"); },
      readCodexThreadIdByPid: () => undefined,
      sleep,
    });
    const scheduler = new PeriodicSnapshotScheduler({
      db,
      snapshotCapture: { captureSnapshot: () => {} } as never,
      snapshotRepo: { pruneSnapshotsByKind: () => {} } as never,
      sessionRegistry,
      resumeMetadataRefresher: refresher,
      processCensus: census,
    });
    await scheduler.tick();
    // 两个 rig 的席位合计只进行一次枚举……
    expect(underlying).toHaveBeenCalledTimes(1);
    // ……且 discovery 只尝试一次：完全没有尝试间 sleep（BASE 会运行 8 次循环，每个无 token 的
    // codex 席位 sleep 7 次以上）。
    expect(sleep).not.toHaveBeenCalled();
    // 每个席位的 pane 恰好探测一次。
    expect(getPanePid).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("附录：default-home thread-id 命中时不派生 pid-home 解析；非默认 home 解析一次后缓存；失败绝不缓存", async () => {
    // Default-home 命中：不调用 resolver。
    const resolveHome = vi.fn(async () => "/other/home");
    const hitDefault = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome,
      readFromLogs: (_pid, home) => (home === "/home/me" ? "thread-1" : undefined),
    });
    expect(await hitDefault.resolveUngatedLegacy(42)).toBe("thread-1");
    expect(resolveHome).toHaveBeenCalledTimes(0);

    // 非默认 home：解析一次，随后从有界缓存提供。
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome,
      readFromLogs: (_pid, home) => (home === "/other/home" ? "thread-2" : undefined),
    });
    expect(await resolver.resolveUngatedLegacy(43)).toBe("thread-2");
    expect(await resolver.resolveUngatedLegacy(43)).toBe("thread-2");
    expect(resolveHome).toHaveBeenCalledTimes(1);

    // 失败的解析不缓存，下一次调用会重试。
    const failing = vi.fn(async () => { throw new Error("ps died"); });
    const failed = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: failing as never,
      readFromLogs: () => undefined,
    });
    await expect(failed.resolveUngatedLegacy(44)).rejects.toThrow("ps died");
    await expect(failed.resolveUngatedLegacy(44)).rejects.toThrow("ps died");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("附录合并：对同一非默认 pid 的两个并发解析最多派生一个 home 探针", async () => {
    let release!: (home: string) => void;
    const resolveHome = vi.fn(() => new Promise<string>((r) => { release = r; }));
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/other/home" ? "thread-9" : undefined),
    });
    const a = resolver.resolveUngatedLegacy(77);
    const b = resolver.resolveUngatedLegacy(77);
    release("/other/home");
    expect(await a).toBe("thread-9");
    expect(await b).toBe("thread-9");
    expect(resolveHome).toHaveBeenCalledTimes(1);
  });

  it("附录稳定性：HOME 解析为 DEFAULT 的 pid（任何位置均无 thread log）会缓存，不会每轮询重复派生子进程", async () => {
    // 明确决策：进程生命周期内 pid 的 HOME 不会变化，因此 HOME=default 的成功答案与其他答案一样
    // 缓存；默认 home 已先读取，后续解析该 pid 不派生任何进程。（pid 复用的有界陈旧权衡与非默认
    // 缓存同类，已接受。）
    const resolveHome = vi.fn(async () => "/home/me");
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: () => undefined,
    });
    expect(await resolver.resolveUngatedLegacy(88)).toBeUndefined();
    expect(await resolver.resolveUngatedLegacy(88)).toBeUndefined();
    expect(await resolver.resolveUngatedLegacy(88)).toBeUndefined();
    expect(resolveHome).toHaveBeenCalledTimes(1);
  });

  it("S10 后续：resolveUngatedLegacy 是唯一无 identity 的读取路径（compile 固定项位于 src/）", () => {
    const r = new CodexThreadIdResolver({});
    // REVIEW-VISIBLE compile 固定项（resolve() 必须保持 identity 必填）位于
    // src/domain/codex-thread-id.ts（ResolveRequiresIdentity），不在此处：packages/daemon/tsconfig.json
    // 排除 "test"，因此本文件中的 @ts-expect-error 永远不会被求值（r1 发现于 2026-08-23）。
    // 此 runtime 检查只记录该具名逃生口存在。
    expect(typeof r.resolveUngatedLegacy).toBe("function");
    expect(typeof r.resolve).toBe("function");
  });

  it("r2-B1：pid-home 缓存会过期——复用 PID 具有新 HOME 时在 TTL 后重新探测并返回新 thread", async () => {
    // r2 判别项：若无 freshness，有大小上限的缓存会在安静后台服务上无限期为复用 pid 返回已退役
    // occupant 的 thread id。TTL 限制该陈旧性；合并和大小上限保留。
    let t = 0;
    let liveHome = "/home/old";
    const resolveHome = vi.fn(async () => liveHome);
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/home/old" ? "old-thread" : home === "/home/new" ? "new-thread" : undefined),
      homeTtlMs: 60_000,
      now: () => t,
    });
    expect(await resolver.resolveUngatedLegacy(4242)).toBe("old-thread");
    // 该 pid 被具有不同 HOME 的新进程复用。
    liveHome = "/home/new";
    t = 30_000; // inside the TTL: cache serves (bounded staleness, accepted)
    expect(await resolver.resolveUngatedLegacy(4242)).toBe("old-thread");
    expect(resolveHome).toHaveBeenCalledTimes(1);
    t = 60_001; // past the TTL: re-probe, new answer
    expect(await resolver.resolveUngatedLegacy(4242)).toBe("new-thread");
    expect(resolveHome).toHaveBeenCalledTimes(2);
  });

  it("r1 修复：PROCESS IDENTITY 立即使复用 PID 失效，无需等待 TTL 或增加子进程", async () => {
    // orch-lead 的 freeze-boundary 裁定：仅靠 TTL 仍会在窗口内提供另一 occupant 的 thread。census
    // 行已携带进程启动时间；将其作为 identity key 传递，会在下一次 resolve 时立即使复用失效。
    let liveHome = "/home/old";
    const resolveHome = vi.fn(async () => liveHome);
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/home/old" ? "old-thread" : home === "/home/new" ? "new-thread" : undefined),
      homeTtlMs: 60_000,
      now: () => 0, // clock frozen INSIDE the TTL — only identity can invalidate
    });
    expect(await resolver.resolve(4242, "Sun Aug 23 10:00:00 2026")).toBe("old-thread");
    expect(await resolver.resolve(4242, "Sun Aug 23 10:00:00 2026")).toBe("old-thread");
    expect(resolveHome).toHaveBeenCalledTimes(1); // same identity: cached
    // pid 被复用：编号相同，启动时间和 HOME 不同。
    liveHome = "/home/new";
    expect(await resolver.resolve(4242, "Sun Aug 23 18:30:00 2026")).toBe("new-thread");
    expect(resolveHome).toHaveBeenCalledTimes(2); // identity mismatch: immediate re-probe
  });

  it("r1 修复：严格 census 行携带 resolver 所需的 start-time identity", async () => {
    const { defaultListProcessesStrict } = await import("../src/domain/resume-metadata-refresher.js");
    const rows = await defaultListProcessesStrict();
    expect(rows.length).toBeGreaterThan(0);
    const withStart = rows.filter((r) => typeof (r as { startedAt?: string }).startedAt === "string" && (r as { startedAt?: string }).startedAt!.length > 0);
    // 每行都携带可解析的启动时间，命令在增加列后仍保留。
    expect(withStart.length).toBe(rows.length);
    expect(rows.some((r) => r.command.length > 0)).toBe(true);
  });

  it("r2 第 3 轮：已知 identity 绝不加入属于其他 identity 的进行中 probe（pid 在探测中途复用）", async () => {
    // r2 延迟压力判别项：pid 4242 的 probe A（identity-A）仍进行时 pid 被复用，B 以 identity-B
    // 解析。仅按 pid 合并会把已退役 occupant 的答案交给 B；无论完成顺序如何，B 都必须启动自己的
    // probe 并取得新 thread，且 A 的晚完成不得覆盖 B 的缓存条目。
    for (const order of ["a-first", "b-first"] as const) {
      const waiters = new Map<string, (home: string) => void>();
      let probeSeq = 0;
      const resolveHome = vi.fn((_pid: number) => new Promise<string>((r) => { waiters.set(`p${++probeSeq}`, r); }));
      const resolver = new CodexThreadIdResolver({
        defaultHome: "/home/me",
        resolveHomeDirByPid: resolveHome as never,
        readFromLogs: (_pid, home) => (home === "/home/old" ? "old-thread" : home === "/home/new" ? "new-thread" : undefined),
        homeTtlMs: 60_000,
        now: () => 0,
      });
      const a = resolver.resolve(4242, "identity-A");
      const b = resolver.resolve(4242, "identity-B");
      expect(resolveHome).toHaveBeenCalledTimes(2); // B started its OWN probe
      if (order === "a-first") {
        waiters.get("p1")!("/home/old");
        waiters.get("p2")!("/home/new");
      } else {
        waiters.get("p2")!("/home/new");
        waiters.get("p1")!("/home/old");
      }
      expect(await a).toBe("old-thread");
      expect(await b).toBe("new-thread");
      // 无论完成顺序如何，B 的缓存条目都保留：后续 B 读取直接使用 fresh/cache，不产生第三个 probe。
      expect(await resolver.resolve(4242, "identity-B")).toBe("new-thread");
      expect(resolveHome).toHaveBeenCalledTimes(2);
    }
  });

  it("r2 第 4 轮：DEFAULT-HOME 快路径绝不把 RETIRED occupant 的日志行返回给复用 pid（真实 sqlite、时间 gate）", async () => {
    // r2 效果层判别项：日志行以 pid:<pid>:<opaque-uuid> 定键；在 identity 参与前，仅按 pid 的 LIKE
    // 读取会在零子进程快路径上把退役进程的 thread 返回给新 occupant。真实 gate 是时间（实测 schema：
    // ts = epoch 秒）：只有在 identity 启动时间当时或之后写入的行才属于当前 occupant。全程零 HOME 探针。
    const fs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "s10-r4-home-"));
    try {
      fs.mkdirSync(nodePath.join(home, ".codex"), { recursive: true });
      seedCodexThreads(home, ["retired-thread", "new-thread"]);
      const db = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT, process_uuid TEXT, thread_id TEXT)");
      // 只有 RETIRED occupant 的行存在，写于本地时间 2026-08-23 10:00。
      const retiredTs = Math.floor(new Date("Aug 23, 2026 10:00:00").getTime() / 1000);
      db.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(retiredTs, "pid:4242:retired-process-uuid", "retired-thread");
      db.close();

      // 真实 default-home MISS 可以合理探测（进程可能位于非默认 home）；零子进程契约只针对 HIT
      // 路径。探针如实回答“default home”。
      const homeProbes = vi.fn(async () => home);
      const resolver = new CodexThreadIdResolver({ defaultHome: home, resolveHomeDirByPid: homeProbes as never });

      // 19:30 启动的新 occupant 不得收到退役 thread。
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();
      const probesAfterMiss = homeProbes.mock.calls.length;
      // 新 occupant 自身的行存在后（在启动后写入），即可解析。
      const db2 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      const newTs = Math.floor(new Date("Aug 23, 2026 19:31:00").getTime() / 1000);
      db2.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(newTs, "pid:4242:new-process-uuid", "new-thread");
      db2.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBe("new-thread");
      // HIT 路径不派生任何进程：除一次真实 miss 外没有探针。
      expect(homeProbes.mock.calls.length).toBe(probesAfterMiss);
      expect(probesAfterMiss).toBeLessThanOrEqual(1);
      // 没有 start-time gate 时，两个保留 conversation 都有歧义。
      expect(await resolver.resolveUngatedLegacy(4242)).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("r2 第 5 轮：复用边界精确——startTs-1 的退役行绝不解析；B 的同秒行按后续裁定处理（真实 sqlite）", async () => {
    // r2 边界控制：2 秒余量会在精确复用边界重新接纳退役 token。ts 和 lstart 都按秒对齐，进程不可能
    // 在自身启动秒之前发出日志，因此 gate 精确为 ts >= startTs，不留余量。
    const fs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "s10-r5-home-"));
    try {
      fs.mkdirSync(nodePath.join(home, ".codex"), { recursive: true });
      const startTs = Math.floor(new Date("Aug 23, 2026 19:30:00").getTime() / 1000);
      seedCodexThreads(home, ["retired-thread", "new-thread"]);
      const db = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT, process_uuid TEXT, thread_id TEXT)");
      // 只有退役 occupant 的行，位于 B 启动前一秒。
      db.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(startTs - 1, "pid:4242:retired-process-uuid", "retired-thread");
      db.close();

      const homeProbes = vi.fn(async () => home);
      const resolver = new CodexThreadIdResolver({ defaultHome: home, resolveHomeDirByPid: homeProbes as never });
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();

      // r2 第 6 轮取代第 5 轮的同秒接纳：启动秒内 ownership 无法判断（lstart 无亚秒精度），因此
      // 同秒行即使属于 B 自身也关闭失败；下一秒的行才能解析。
      const db2 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db2.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(startTs, "pid:4242:new-process-uuid", "new-thread");
      db2.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();
      const db3 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db3.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(startTs + 1, "pid:4242:new-process-uuid", "new-thread");
      db3.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBe("new-thread");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("r2 第 6 轮：有歧义的启动秒关闭失败——ts == startTs 的行都不解析，之后的行可解析（真实 sqlite）", async () => {
    // r2 同秒控制：退役 A 可在 ts == B.startTs 时记录日志并退出，B 在同秒复用 pid；lstart 无亚秒
    // 分量，因此该秒内 ownership 无法判断。裁定结构选择真实的 INDETERMINATE 而非掩盖陈旧值：
    // 严格要求 ts > startTs；真正属于当前进程的同秒行会晚一个轮询解析，而不是立即解析退役 token。
    const fs = await import("node:fs");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "s10-r6-home-"));
    try {
      fs.mkdirSync(nodePath.join(home, ".codex"), { recursive: true });
      const startTs = Math.floor(new Date("Aug 23, 2026 19:30:00").getTime() / 1000);
      seedCodexThreads(home, ["retired-thread", "new-thread"]);
      const db = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT, process_uuid TEXT, thread_id TEXT)");
      // 只有退役 A 的行，位于 B 的启动秒内。
      db.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 100000000, 'info', ?, ?)")
        .run(startTs, "pid:4242:retired-process-uuid", "retired-thread");
      db.close();

      const resolver = new CodexThreadIdResolver({ defaultHome: home, resolveHomeDirByPid: (async () => home) as never });
      // 有歧义秒关闭失败：退役行不得解析……
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();
      // ……即使 B 自己的同秒行也保持未解析（ownership 无法判断）。
      const db2 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db2.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 200000000, 'info', ?, ?)")
        .run(startTs, "pid:4242:new-process-uuid", "new-thread");
      db2.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBeUndefined();
      // 严格晚于启动秒的行可解析。
      const db3 = new BetterSqlite3(nodePath.join(home, ".codex", "logs_1.sqlite"));
      db3.prepare("INSERT INTO logs (ts, ts_nanos, level, process_uuid, thread_id) VALUES (?, 0, 'info', ?, ?)")
        .run(startTs + 1, "pid:4242:new-process-uuid", "new-thread");
      db3.close();
      expect(await resolver.resolve(4242, "Sun Aug 23 19:30:00 2026")).toBe("new-thread");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("soak 发现：identity-keyed 缓存条目寿命超过 poll cadence——相隔 60 秒轮询两次总共只探测一次", async () => {
    // 413e2d541 的现场 soak：list_processes +6（census 修复有效），但 resolve_home +53/5min；
    // 60 秒 TTL 恰好等于 60 秒 divergence cadence，导致 identity-keyed 条目在下次需要时正好过期，
    // 每个 pending codex 席位每轮都重新探测。Identity 通过结构使 pid 复用失效（第 3–6 轮），所以
    // 对已稳定的 identity-keyed 条目，时间不承重（e91d7a94：probe 在 identity 启动秒结束后开始，
    // 完全不按时间过期）；60 秒边界只保留给无 identity 调用方。时钟与 identity 一致（base 位于启动秒
    // 之后），因为永久性规则以 probe START 时间判断；断言与原始 soak 发现固定项一致。
    const START = lstartToMinTs("Sun Aug 23 10:00:00 2026")!;
    const BASE = (START + 10) * 1000;
    let t = BASE;
    const resolveHome = vi.fn(async () => "/other/home");
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/other/home" ? "thread-x" : undefined),
      now: () => t,
    });
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    t = BASE + 61_000; // 下一次 divergence poll。
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    t = BASE + 601_000; // 十分钟后，identity 相同：仍缓存。
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    expect(resolveHome).toHaveBeenCalledTimes(1);
    // 无 identity 调用方保留短边界：其 slot 在 60 秒内提供服务，之后重新探测。
    expect(await resolver.resolveUngatedLegacy(501)).toBe("thread-x"); // 第 2 次 probe。
    t = BASE + 631_000; // +30 秒：位于无 identity TTL 内，使用缓存且不探测。
    expect(await resolver.resolveUngatedLegacy(501)).toBe("thread-x");
    expect(resolveHome).toHaveBeenCalledTimes(2);
    t = BASE + 692_000; // 条目后 +61 秒：已过期，重新探测。
    expect(await resolver.resolveUngatedLegacy(501)).toBe("thread-x"); // 第 3 次 probe。
    expect(resolveHome).toHaveBeenCalledTimes(3);
  });

  it("expiry-herd 修复（qitem-...e91d7a94）：稳定的 identity-keyed 条目永不按时间过期——同 pid+identity 超过 15 分钟总共只探测一次", async () => {
    // 现场标本（quiet-window receipt 20260823T222324Z）：1.5 秒突发中 resolve_home +20；5 分钟
    // snapshot surface 上约 20 个 codex 席位同时跨过 15 分钟 identityHomeTtlMs，形成原本不必要的
    // `ps eww` 同步过期群。START 位于 identity 的 lstart 秒结束之后的 probe，按构造观察到
    // (pid, lstart) 的存活 occupant；该秒过去后不可能发生同 pid 同秒复用（completion 时间不足以判断：
    // 秒内启动的 probe 可能观察退役 occupant 并稍后完成，见 deferred-probe 固定项），所以该条目已
    // 稳定：在 key 生命周期内有效，只因 identity 不匹配（新 key）或 FIFO 大小淘汰而移除。没有可同步
    // 的周期过期后，群峰不会重现。（相邻测试固定其他边界：“r1 remedy”固定 identity 不匹配时立即
    // 重探测，“soak finding”固定无 identity 的 60 秒重探测，下方 collision 固定唯一未稳定情况的有限恢复。）
    const START = lstartToMinTs("Sun Aug 23 10:00:00 2026")!;
    let t = (START + 10) * 1000; // probe 在启动秒之后很久开始：已稳定。
    const resolveHome = vi.fn(async () => "/other/home");
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/other/home" ? "thread-x" : undefined),
      now: () => t,
    });
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    t += 900_001; // 超过旧 identityHomeTtlMs：仍必须缓存。
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    t += 3 * 3_600_000; // 数小时后 identity 仍相同：始终只有一次 probe。
    expect(await resolver.resolve(500, "Sun Aug 23 10:00:00 2026")).toBe("thread-x");
    expect(resolveHome).toHaveBeenCalledTimes(1);
  });

  it("expiry-herd 修复（qitem-...e91d7a94）：W-5.3-1 collision 固定项——在有歧义启动秒内探测的条目于 60 秒边界内恢复，而非 15 分钟", async () => {
    // 缓存 HOME 唯一可能陈旧的窗口：`ps lstart` 只有秒级精度，因此在 identity 启动秒内复用的 pid
    // 保持相同 key，而在该秒内完成的 probe 可能描述退役 occupant。严格 ts > startTs gate 使其关闭
    // 失败（undefined，绝不返回错误 thread——W-5.3-1），但 15 分钟 identityHomeTtlMs 会让席位在过期前
    // 始终无法解析 thread。未稳定条目应改用短边界：有限 miss 恢复路径为 homeTtlMs（60 秒）+ 一轮 poll。
    const START = lstartToMinTs("Sun Aug 23 10:00:00 2026")!;
    let t = START * 1000 + 500; // probe 在启动秒内完成。
    let liveHome = "/home/old"; // 退役 occupant 仍持有 pid。
    const resolveHome = vi.fn(async () => liveHome);
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      // 只有新 occupant 的 home 会产生通过 gate 的行；退役 occupant 的行无法通过严格的
      // ts > startTs gate（第 6 轮）。
      readFromLogs: (_pid, home) => (home === "/home/new" ? "new-thread" : undefined),
      now: () => t,
    });
    // 首次 resolve 与席位首秒竞态：缓存注定失效的答案，并关闭失败（无 thread）。
    expect(await resolver.resolve(4242, "Sun Aug 23 10:00:00 2026")).toBeUndefined();
    expect(resolveHome).toHaveBeenCalledTimes(1);
    // pid 在同一秒内被具有不同 HOME 的新 occupant 复用（key 相同）。
    liveHome = "/home/new";
    // 下一次 poll 超过短边界：未稳定条目已过期，重新探测找到存活者 home 并解析 thread。
    t = START * 1000 + 61_500;
    expect(await resolver.resolve(4242, "Sun Aug 23 10:00:00 2026")).toBe("new-thread");
    expect(resolveHome).toHaveBeenCalledTimes(2);
  });

  it("expiry-herd 修复（qitem-...e91d7a94）：DEFERRED-PROBE 对抗固定项——在有歧义秒内启动的 probe 即使之后完成仍保持短寿命", async () => {
    // orch-lead 的时序修正：completion 时间不是安全的永久性谓词。probe 可在 S 秒内启动，观察退役
    // occupant，并在 S 结束后才完成；此时 pid 已在 S 内以相同 lstart key 被复用。永久缓存该答案会
    // 重现 W-5.3-1 无界问题。永久性必须以严格晚于 S 的 probe START 时间为依据；该 probe 在 S 内
    // 启动，因此无论何时完成，其条目都保留 60 秒边界。
    const START = lstartToMinTs("Sun Aug 23 10:00:00 2026")!;
    let t = START * 1000 + 400; // probe 在启动秒内开始。
    let release!: (home: string) => void;
    const resolveHome = vi.fn(
      (_pid: number) => new Promise<string>((r) => { release = r; }),
    );
    const resolver = new CodexThreadIdResolver({
      defaultHome: "/home/me",
      resolveHomeDirByPid: resolveHome as never,
      readFromLogs: (_pid, home) => (home === "/home/new" ? "new-thread" : undefined),
      now: () => t,
    });
    const first = resolver.resolve(4242, "Sun Aug 23 10:00:00 2026");
    // pid 在 S 内被复用（key 相同）。进行中的 probe 观察到 RETIRED occupant，并在 S 结束后才完成。
    t = (START + 5) * 1000;
    release("/home/old");
    expect(await first).toBeUndefined(); // 严格 gate 下关闭失败。
    expect(resolveHome).toHaveBeenCalledTimes(1);
    // 超过短边界（从 CACHE-WRITE 起 60 秒，即 probe 在 START+5 秒完成）后，注定失效的条目必须
    // 过期并重新探测。
    t = (START + 66) * 1000;
    resolveHome.mockImplementation(async () => "/home/new");
    expect(await resolver.resolve(4242, "Sun Aug 23 10:00:00 2026")).toBe("new-thread");
    expect(resolveHome).toHaveBeenCalledTimes(2);
  });

  it("r2-B2：census 的生产 lister 在枚举失败时拒绝——失败的 ps 绝不作为空成功缓存", async () => {
    // r2 判别项：defaultListProcesses 把 spawn 失败吞成 []；通过 census 后，该空数组会在整个
    // freshness 窗口内成为缓存的成功。census 的生产接缝必须改为拒绝。
    const { defaultListProcessesStrict } = await import("../src/domain/resume-metadata-refresher.js");
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-bin";
      await expect(defaultListProcessesStrict()).rejects.toThrow();
    } finally {
      process.env.PATH = savedPath;
    }
    const rows = await defaultListProcessesStrict();
    expect(rows.length).toBeGreaterThan(0);
    // census 默认接线到严格 lister，而非宽松版本。
    const censusSrc = await import("node:fs").then((f) => f.readFileSync("src/domain/process-census.ts", "utf-8"));
    expect(censusSrc).toContain("defaultListProcessesStrict");
  });

  it("mini-req 4 守卫：adoption 边界 capture 保留重试循环（snapshot 路径之外的 attempts 默认值不变）", async () => {
    const db = createFullTestDb();
    const sessionRegistry = new SessionRegistry(db);
    const listProcesses = vi.fn(async () => ROWS);
    const sleep = vi.fn(async () => {});
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: { getPanePid: async () => 10 } as unknown as TmuxAdapter,
      listProcesses,
      readCodexThreadIdByPid: () => undefined,
      sleep,
    });
    await refresher.captureCodexThreadId("seat@rig");
    // 直接（非 snapshot）capture 仍执行 8 次尝试。
    expect(listProcesses).toHaveBeenCalledTimes(8);
    expect(sleep).toHaveBeenCalledTimes(7);
    db.close();
  });
});
