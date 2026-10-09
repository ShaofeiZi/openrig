// P16——启动接线 pin 毕业（UNINJECTED-SERVICE 类，复发两次：
// validateRig-uninjected + 死掉的 occupant-invalidator）。一个带可选 safety
// dep 的服务通过每个单测，而生产启动静默地从不注入它——该特性在 prod 关闭，
// 无人察觉。
//
// 这些 pin 驱动真实 createDaemon 组合一次，并按
// SAFETY-classified optional dep, that the production injection actually
// happened. A pin here failing means a startup edit un-wired a safety feature.
//
// The census (P16 sweep, 2026-08-07) also found FIVE deps that are UNINJECTED
// TODAY — those are it.todo ledger entries at the bottom (routed to the desk as
// findings; a passing pin would freeze the defect). When a finding's fix lands,
// its todo graduates to a real pin.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../src/startup.js";
import type { AppDeps } from "../src/server.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ExecFn } from "../src/domain/tmux-adapter.js";
import type Database from "better-sqlite3";
import type { ContextMonitor } from "../src/domain/context-monitor.js";

let db: Database.Database;
let deps: AppDeps;
let contextMonitor: ContextMonitor;
let scratch: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // D15 isolation: the composition writes real state — anchor it in scratch.
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "p16-wiring-"));
  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.OPENRIG_HOME = path.join(scratch, "home");
  process.env.OPENRIG_DB = path.join(scratch, "wiring.sqlite");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  const cmuxFactory: CmuxTransportFactory = async () => {
    throw Object.assign(new Error("no socket"), { code: "ENOENT" });
  };
  const tmuxExec: ExecFn = async () => "";
  // production passes the RESOLVED file dbPath (index.ts) — :memory: is the
  // test-friendly default that deliberately skips the slow-op recorder; the
  // wiring pin must compose like production.
  const result = await createDaemon({ cmuxFactory, tmuxExec, dbPath: process.env.OPENRIG_DB! });
  db = result.db;
  deps = result.deps;
  contextMonitor = result.contextMonitor;
}, 60000);

afterAll(() => {
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Reach a private field for a WIRING assertion (presence, never behavior). */
function priv<T>(obj: unknown, key: string): T {
  return (obj as Record<string, T>)[key] as T;
}

describe("P16 — 具有安全语义的 AppDeps 成员组成（定义引脚）", () => {
  const MEMBERS: Array<keyof AppDeps> = [
    "queueRepo", "inboxHandler", "outboxHandler", "sessionTransport",
    "transcriptStore", "providerService", "seatIdentityReconciler",
    "seatActivityService", "watchdogJobsRepo", "watchdogHistoryLog",
    "watchdogPolicyEngine", "watchdogScheduler", "periodicSnapshotScheduler",
    "workflowRuntime", "selfAttachService", "rigLifecycleService",
    "resumeMetadataRefresher", "runtimeAdapters",
    "seatStructuralActivityService",
    "streamStore", "askService", "wakeResolveService", "projectClassifier",
    "classifierLeaseManager", "classificationAttemptLedger", "viewProjector", "tmuxOptionDefaults",
  ];
  for (const member of MEMBERS) {
    it(`deps.${String(member)} is constructed by production startup`, () => {
      expect(deps[member], `AppDeps.${String(member)} must be composed by createDaemon`).toBeDefined();
    });
  }
});

describe("P16 — 域内部安全注入（重复类，固定在线路上）", () => {
  it("QueueRepository.validateRig 是拓扑门，而不是默认的许可（重复#1）", async () => {
    // behavioral probe through the composed object: an unknown-rig destination must refuse.
    await expect(
      deps.queueRepo!.create({
        sourceSession: "a@known-nowhere",
        destinationSession: "b@definitely-unregistered-rig",
        body: "wiring probe",
      } as never),
    ).rejects.toThrow(/未知 rig/);
  });

  it("QueueRepository.workflowFrontierPredicate 被注入（近路径防护）", () => {
    expect(priv(deps.queueRepo, "workflowFrontierPredicate")).toBeTruthy();
  });

  it("SessionTransport携带eventBus（没有它的话危险覆盖审计失败关闭）", () => {
    expect(priv(deps.sessionTransport, "eventBus")).toBeTruthy();
  });

  it("SessionTransport 带有慢速操作记录器（在启动时有条件地组成：238 — real-db 后台服务必须拥有它）", () => {
    expect(priv(deps.sessionTransport, "slowOpRecorder")).toBeTruthy();
  });

  it("ContextMonitor携带压缩执行器（阈值->动作检测器）", () => {
    expect(priv(contextMonitor, "compactionEnforcer")).toBeTruthy();
  });

  it.todo("51-08（切片折叠处的毕业生）：ContextMonitor 携带 useSamples + providerWindowSampler — 当 hv/51-08-telemetry 落地时 pin 翻转；现在断言将引脚主接线尚未携带");

  it("ClassifierLeaseManager.isAlive 是在构建后附加的（租赁活动接缝）", () => {
    expect(priv(deps.classifierLeaseManager, "isAlive")).toBeTruthy();
  });

  it("QueueRepository 传输是在构建后附加的（唤醒路径）", () => {
    expect(priv(deps.queueRepo, "transport")).toBeTruthy();
  });
});

describe("P16 — 未注入服务发现分类账（发送到办公桌；修复完成后，待办事项会转到大头针上）", () => {
  it.todo("发现 A1：SeatHandoverService.occupantInvalidator 未注入（routes/seat.ts 构造）——每次切换都会提交零状态失效； Ghost-stage Atom-B Lane 拥有该 impl");
  it.todo("发现A2：投影规划器resolveTargetPath未注入（rigspec-instantiator.ts：1672）- hash_conflict分类已死；操作员修改的文件被静默覆盖");
  it.todo("发现 A3：InboxHandler.authenticate 未注入 (startup.ts:950) — 发件人欺骗门是允许所有的；路由转发客户端提供的authentiatedSender");
  it.todo("发现 A4：WorkflowValidator SeatLivenessCheck 从未构建 — role_no_live_preferred_target 建议已失效；实例在没有警告的情况下停在步骤 1");
  it("A5 毕业 (P19)：AskService 的 PsProjectionService 携带 SeatActivity — 一个终端活跃的事实跨越两条路径", () => {
    const ps = priv<unknown>(deps.askService, "deps") as { psProjectionService: unknown };
    expect(priv(ps.psProjectionService, "seatActivity"), "the ask path must inject seatActivity like the attention path does").toBeTruthy();
  });

  it("慢速操作请求中间件连线：server.ts app.use 是 createSlowOpRequestMiddleware 接缝", () => {
    // The middleware CONTRACT moved to hermetic unit tests (slow-op-recorder.test), which cannot cover
    // 'the real server actually uses this middleware' — the uninjected-service enable-path gap. This pin
    // closes it at the source: the seam must be imported AND app.use'd (an import alone leaves the
    // request observer dead in prod).
    const src = fs.readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(src, "server.ts must import the extracted seam").toContain("createSlowOpRequestMiddleware");
    expect(src, "server.ts must app.use the seam, not just import it").toMatch(
      /app\.use\(\s*["']\*["']\s*,\s*createSlowOpRequestMiddleware\(/,
    );
  });
});
