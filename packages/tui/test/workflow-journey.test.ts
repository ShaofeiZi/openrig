import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { createDb } from "../../daemon/src/db/connection.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../../daemon/src/domain/watchdog-jobs-repository.js";
import { WorkflowRuntime } from "../../daemon/src/domain/workflow-runtime.js";
import { buildExecutionView } from "../../daemon/src/domain/execution-view.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { strWidth } from "../src/text-width.js";
import { resolveEscapeAction } from "../src/input.js";
import { parseCommand } from "../src/grammar.js";
import { workflowDetail } from "../src/execution/workflow-model.js";
import type { ExecutionViewSnap } from "../src/execution/execution-model.js";
import type { FleetSnapshot } from "../src/types.js";

const mission = "release-0.5.11";
const owner = "orch@example";
const expectedSteps = ["mission-outcome", "exact-release-candidate", "capability-delta", "exact-cut-substance", "release-verification", "git-canonicalization", "public-release", "parent-adoption", "record-shipped", "release-boundary"];
const evidenceDir = process.env["S05_EVIDENCE_DIR"];

// 迁移自真实 workflow/queue/wake 生产者；无 daemon 启动、provider、auth 或 tmux。
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "s05-workflow-"));
  const missionPath = join(root, "missions", mission);
  mkdirSync(missionPath, { recursive: true });
  const project = parse(readFileSync(new URL("../../../docs/reference/project-release-profile.yaml", import.meta.url), "utf8"));
  const projectBytes = stringify(project);
  writeFileSync(join(root, "project.yaml"), projectBytes);
  writeFileSync(join(missionPath, "mission.yaml"), stringify({ kind: "mission", metadata: { name: mission }, composition: { slices: [] } }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const queue = new QueueRepository(db, bus, { validateRig: () => true });
  const jobs = new WatchdogJobsRepository(db); queue.attachWatchdogJobsRepository(jobs);
  const stop = queue.startWaitReminders();
  const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue, watchdogJobsRepo: jobs });
  const projection = () => buildExecutionView({ db, slicesRoot: () => join(root, "missions"), exec: () => { throw new Error("No repository in this fixture"); } }, { mission }) as unknown as ExecutionViewSnap;
  const snapshot = (): FleetSnapshot => ({ ...emptySnapshot(), execution: projection(), executionMission: mission, hydratedAt: new Date().toISOString(), hosts: [{ name: "fixture", reachable: true, rigs: [{ name: "example", pods: [{ name: "orch", agents: [{ name: "orch.lead", session: owner, spec: "analyst", runtime: "codex", model: "gpt-6", context: null, tokens: null, status: "active", live: true }] }] }] }] });
  return { root, missionPath, project, projectBytes, db, queue, jobs, runtime, projection, snapshot, close: () => { stop(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("已连接 workflow 旅程", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(() => f.close());
  it("跟随真实 active → wait → blocker 完成 → 恢复进度 → 完成，无后继", async () => {
    const run = await f.runtime.instantiateLifecycle({ missionPath: f.missionPath, operationKey: "s05-proof", rootObjective: "Deliver this release", createdBySession: owner });
    let snap = f.snapshot();
    const view = createViewState({ instanceId: "s05", getSnapshot: () => snap });
    const save = (name: string) => {
      snap = f.snapshot();
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(snap, null, 2));
        writeFileSync(join(evidenceDir, `${name}.txt`), renderScreen(view.get(), snap, { cols: 120, rows: 36 }).lines.join("\n"));
      }
    };
    view.dispatch(parseCommand(`mission ${mission}`));
    save("active");
    expect(snap.execution!.lifecycle_instances![0]!.graph_source).toMatchObject({ mode: "project-profile" });
    const overview = renderScreen(view.get(), snap, { cols: 120, rows: 36 });
    expect(overview.lines.join("\n")).toContain("工作流");
    view.dispatch(parseCommand(`workflow ${run.instance.instanceId}`));
    let detail = workflowDetail(snap.execution!, `workflow:${run.instance.instanceId}`, 90)!.map((l) => l.text).join("\n");
    expect(detail).toContain("收据 缺失");
    expect(detail.replace(/\s+/g, " ")).toContain("它不建立验收");
    expect(detail).toContain("发布仪式和发布后整理");
    expect(detail).toContain("无后继激活步骤绑定");
    expect(detail).toContain("project-profile");
    view.dispatch(parseCommand(`packet ${run.entryQitemId}`));
    const packetView = view.get();
    view.dispatch({ type: "layout", contentMaxOffset: 100, contentTargetCount: 3 });
    view.dispatch({ type: "content-scroll", delta: 7 });
    view.dispatch({ type: "drill", resource: "agent", name: owner });
    expect(view.get().lastError).toBeNull();
    expect(view.get().drill.at(-1)?.name).toBe("orch.lead");
    view.dispatch(resolveEscapeAction({ type: "key", key: "escape" }, view.get())!);
    expect(view.get().executionOpen).toBe(packetView.executionOpen);
    expect(view.get().contentOffset).toBe(7);
    const blocker = await f.queue.create({ sourceSession: owner, destinationSession: "review@example", body: "Inspect candidate evidence", summary: "Candidate evidence from review", nudge: false });
    await f.runtime.project({ instanceId: run.instance.instanceId, currentPacketId: run.entryQitemId, actorSession: owner, exit: "waiting", resultNote: "Waiting for candidate evidence from review", blockedOn: blocker.qitemId });
    view.dispatch({ type: "content-scroll", delta: -100 }); save("waiting");
    const frontier = snap.execution!.lifecycle_instances![0]!.frontier_packets as Array<Record<string, unknown>>;
    expect(frontier[0]).toMatchObject({ queue_state: "blocked", blocked_on: blocker.qitemId, wake: { kind: "timer", phase: "armed", live: true }, wake_schedule: { interval_seconds: 300 }, latest_transition: { actor_session: owner } });
    detail = workflowDetail(snap.execution!, `packet:${run.entryQitemId}`, 60)!.map((l) => l.text).join("\n");
    expect(detail).toContain("Candidate evidence from review");
    expect(detail).toContain("300 秒");
    await f.queue.update({ qitemId: blocker.qitemId, actorSession: "review@example", state: "done", closureReason: "no-follow-on" });
    save("resumed");
    expect((snap.execution!.lifecycle_instances![0]!.frontier_packets as Array<Record<string, unknown>>)[0]!.queue_state).toBe("pending");
    // 当前 YAML 变更不会静默替换正在显示的已编译 graph。
    writeFileSync(join(f.root, "project.yaml"), f.projectBytes + "\n# later edit\n");
    expect(f.projection().lifecycle_instances![0]!.compiled_input_digest).toBe(snap.execution!.lifecycle_instances![0]!.compiled_input_digest);
    for (const step of expectedSteps) {
      const current = f.runtime.inspect(run.instance.instanceId).frontier[0]!;
      expect(current.stepId).toBe(step);
      await f.runtime.project({ instanceId: run.instance.instanceId, currentPacketId: current.packetId, actorSession: owner, exit: step === "release-boundary" ? "done" : "handoff", closureEvidence: { evidence_ref: `proof/${step}.md` } });
    }
    view.dispatch(parseCommand(`workflow ${run.instance.instanceId}`)); save("completed");
    expect(snap.execution!.lifecycle_instances![0]!.status).toBe("completed");
    detail = workflowDetail(snap.execution!, `workflow:${run.instance.instanceId}`, 72)!.map((l) => l.text).join("\n");
    expect(detail).toContain("无当前工作包 · 工作流 已完成");
    expect(detail).not.toContain("收据 缺失");
    expect(detail).toContain("proof/release-boundary.md");
    expect(existsSync(join(f.missionPath, "proof", "release-boundary.md"))).toBe(false);
    expect(detail.replace(/\s+/g, " ")).toContain("已记录收据意味着已记录归因证据引用；它不建立验收。");
    expect(detail).toContain("orch@example");
    for (const cols of [60, 84, 120]) {
      const screen = renderScreen(view.get(), snap, { cols, rows: 24 });
      // 列宽按终端显示宽度判定：中文双宽字符占 2 列，不能用 string.length（弱断言会放过越界）
      expect(screen.lines.every((line) => strWidth(line) <= cols)).toBe(true);
      expect(screen.contentMaxOffset).toBeGreaterThan(0);
    }
    if (evidenceDir) writeFileSync(join(evidenceDir, "project.yaml"), f.projectBytes);
  });

  it("保持可选后继与缺失 packet 绑定诚实", async () => {
    writeFileSync(join(f.missionPath, "mission.yaml"), stringify({ kind: "mission", metadata: { name: mission }, composition: { slices: [] }, lifecycle: { profile: "release-boundary-v0", mode: "extend", workflow: { steps: [{ id: "activate-successor", actor_role: "orchestrator", depends_on: ["release-boundary"], allowed_exits: ["done", "waiting", "failed"] }] } } }));
    const run = await f.runtime.instantiateLifecycle({ missionPath: f.missionPath, operationKey: "下一个", rootObjective: "Release", createdBySession: owner });
    f.db.prepare("DELETE FROM workflow_frontier_bindings WHERE packet_id = ?").run(run.entryQitemId);
    const execution = f.projection();
    const body = workflowDetail(execution, `workflow:${run.instance.instanceId}`, 100)!.map((l) => l.text).join("\n");
    expect(body).toContain("可选后继");
    expect(body).toContain("0 个步骤绑定");
    expect((execution.lifecycle_instances![0]!.frontier_packets as Array<Record<string, unknown>>)[0]!.targeted_action).toBe("INDETERMINATE");
    expect(workflowDetail(execution, "packet:missing-after-refresh", 100)).toBeNull();
  });
});
