import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { compileProjectLifecycle } from "../src/domain/project-lifecycle-compiler.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { buildExecutionView } from "../src/domain/execution-view.js";

const example = parse(readFileSync(new URL("../../../docs/reference/project-release-profile.yaml", import.meta.url), "utf8"));
// 人工编写的 outcome 清单：不要从被测 fixture 推导期望集合。
const ids = ["mission-outcome", "exact-release-candidate", "capability-delta", "exact-cut-substance",
  "release-verification", "git-canonicalization", "public-release", "parent-adoption", "record-shipped", "release-boundary"];

describe("项目自有的 boundary profile", () => {
  let root: string;
  let missionPath: string;
  let project: typeof example;
  let mission: Record<string, unknown>;
  const compile = () => compileProjectLifecycle({ missionPath, operationKey: "release" });
  function save() {
    writeFileSync(join(root, "project.yaml"), stringify(project));
    writeFileSync(join(missionPath, "mission.yaml"), stringify(mission));
  }
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "project-boundary-")));
    missionPath = join(root, "missions", "release-0.5.11");
    mkdirSync(missionPath, { recursive: true });
    project = structuredClone(example);
    mission = { kind: "mission", metadata: { name: "release-0.5.11" }, composition: { slices: [] } };
    save();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("继承每一条具名 obligation，附带 digest、source 绑定与稳定的绝对地址", () => {
    const first = compile();
    expect(first.eligible).toBe(true);
    expect(first.workflowSpec?.steps.map((s) => s.id)).toEqual(ids);
    expect(first.graphSource).toEqual({ mode: "project-profile", profileSource: `${root}/project.yaml#lifecycle.profiles.release-boundary-v0`, missionSource: null, requiredSteps: ids });
    expect(first.sources.map((s) => s.kind)).toEqual(["project", "mission"]);
    expect(first.workflowSpec?.steps[0]).toMatchObject({ re_present_after_seconds: 300, re_present_max_seconds: 3600 });
    expect(compileProjectLifecycle({ missionPath: resolve(missionPath, "./mission.yaml"), operationKey: "different" }).compiledInputDigest).toBe(first.compiledInputDigest);
    project.lifecycle.profiles["release-boundary-v0"].workflow.steps[0].objective = "修订后的策略";
    save();
    expect(compile().compiledInputDigest).not.toBe(first.compiledInputDigest);
  });

  it("把目录别名绑定到同一 source/digest，且不接受 symlink manifest", () => {
    const alias = join(root, "alias");
    symlinkSync(root, alias, "dir");
    expect(compileProjectLifecycle({ missionPath: join(alias, "missions", "release-0.5.11"), operationKey: "release" })).toEqual(compile());
    const link = join(missionPath, "linked.yaml");
    symlinkSync(join(missionPath, "mission.yaml"), link);
    expect(() => compileProjectLifecycle({ missionPath: link, operationKey: "release" })).toThrow(expect.objectContaining({ code: "lifecycle_manifest_symlink" }));
  });

  it.each(ids)("拒绝缺失的 required step %s", (id) => {
    const profile = project.lifecycle.profiles["release-boundary-v0"];
    profile.workflow.steps = profile.workflow.steps.filter((s: { id: string }) => s.id !== id);
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_required_step_missing", details: { missing: [id] } }));
  });

  it("以就绪的后继扩展，而不复制 release graph", () => {
    mission.lifecycle = { profile: "release-boundary-v0", mode: "extend", workflow: {
      context_refs: ["SPEC.md"], steps: [{ id: "activate-successor", actor_role: "orchestrator", depends_on: ["release-boundary"], objective: "评判人工编写且已就绪的后继并显式激活它", allowed_exits: ["done", "waiting", "failed"] }],
    } };
    save();
    expect(compile()).toMatchObject({ eligible: true, graphSource: { mode: "mission-extend" } });
    expect(compile().workflowSpec?.steps.map((s) => s.id)).toEqual([...ids, "activate-successor"]);
    expect(compile().workflowSpec?.context_refs).toContain(join(missionPath, "SPEC.md"));
  });

  it("允许显式 override，但保留 required ID 与前置顺序", () => {
    const workflow = structuredClone(project.lifecycle.profiles["release-boundary-v0"].workflow);
    workflow.roles.orchestrator.preferred_targets = ["other@example"];
    mission.lifecycle = { profile: "release-boundary-v0", mode: "override", workflow };
    save();
    expect(compile()).toMatchObject({ eligible: true, graphSource: { mode: "mission-override" } });
    workflow.steps.find((s: { id: string }) => s.id === "public-release").depends_on = ["mission-outcome"];
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_required_order_changed" }));
    workflow.steps = workflow.steps.filter((s: { id: string }) => s.id !== "exact-cut-substance");
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_required_step_missing" }));
  });

  it.each([undefined, 100])("拒绝保留 required 祖先关系却新增前置环路的 override，max_hops=%s", (maxHops) => {
    const workflow = structuredClone(project.lifecycle.profiles["release-boundary-v0"].workflow);
    workflow.steps.find((step: { id: string }) => step.id === "record-shipped").depends_on.push("release-boundary");
    if (maxHops !== undefined) workflow.loop_guards = { max_hops: maxHops };
    mission.lifecycle = { profile: "release-boundary-v0", mode: "override", workflow };
    save();
    const result = compile();
    expect(result.eligible).toBe(false);
    expect(result.unknowns.some((issue) => issue.includes("[dependency_cycle]"))).toBe(true);
  });

  it.each([
    ["歧义", { workflow: example.lifecycle.profiles["release-boundary-v0"].workflow }, "lifecycle_override_ambiguous"],
    ["未知 mode", { mode: "merge", workflow: {} }, "lifecycle_override_ambiguous"],
    ["空 mode", { mode: "extend" }, "lifecycle_manifest_shape_invalid"],
    ["未知 key", { workflow_ref: "ignored.yaml" }, "lifecycle_boundary_unknown_key"],
    ["step 冲突", { mode: "extend", workflow: { steps: [{ id: "exact-cut-substance" }] } }, "lifecycle_extension_collision"],
  ])("拒绝 %s 且不静默回退", (_name, settings, code) => {
    mission.lifecycle = { profile: "release-boundary-v0", ...settings as object };
    save();
    expect(compile).toThrow(expect.objectContaining({ code }));
  });

  it("拒绝无作用的 project workflow 字段与被选中的缺失 profile", () => {
    project.lifecycle.workflow = {};
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_boundary_unknown_key" }));
    delete project.lifecycle.workflow;
    project.lifecycle.profile = "absent";
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_profile_not_found" }));
  });

  it("在安装 project graph 之前，显式保留 legacy mission 优先级", () => {
    const workflow = project.lifecycle.profiles["release-boundary-v0"].workflow;
    delete project.lifecycle.profiles;
    mission.lifecycle = { profile: "release-boundary-v0", workflow };
    save();
    expect(compile()).toMatchObject({ eligible: true, graphSource: { mode: "legacy-mission", requiredSteps: [] } });
    project.lifecycle.profiles = structuredClone(example.lifecycle.profiles);
    save();
    expect(compile).toThrow(expect.objectContaining({ code: "lifecycle_override_ambiguous" }));
  });

  it.each([false, true])("执行完整 boundary、receipts 与可选后继 successor=%s", async (successor) => {
    if (successor) mission.lifecycle = { profile: "release-boundary-v0", mode: "extend", workflow: {
      steps: [{ id: "activate-successor", actor_role: "orchestrator", depends_on: ["release-boundary"], allowed_exits: ["done", "waiting", "failed"] }],
    } };
    save();
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const bus = new EventBus(db);
      const queue = new QueueRepository(db, bus, { validateRig: () => true });
      const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
      const created = await runtime.instantiateLifecycle({ missionPath, operationKey: "release", rootObjective: "发布 release", createdBySession: "orch@example" });
      const instanceId = created.instance.instanceId;
      expect(runtime.inspect(instanceId).boundaryObligations.map((s) => s.stepId)).toEqual(successor ? [...ids, "activate-successor"] : ids);
      expect(runtime.inspect(instanceId).boundaryObligations.every((s) => s.receipt === null)).toBe(true);
      const start = runtime.inspect(instanceId).frontier[0]!;
      const mutationCount = () => db.prepare("SELECT total_changes() n").get();
      const before = mutationCount();
      await expect(runtime.project({ instanceId, currentPacketId: start.packetId, exit: "handoff", actorSession: "orch@example" })).rejects.toMatchObject({ code: "lifecycle_receipt_required" });
      expect(mutationCount()).toEqual(before);
      // wait 是续行而非验收，因此不需要 success receipt。
      await runtime.project({ instanceId, currentPacketId: start.packetId, exit: "waiting", actorSession: "orch@example", blockedOn: "等待确凿证据" });
      expect(runtime.inspect(instanceId).boundaryObligations[0]).toMatchObject({ state: "waiting", receiptState: "missing" });
      for (const id of ids) {
        const packet = runtime.inspect(instanceId).frontier[0]!;
        expect(packet.stepId).toBe(id);
        if (id === "release-boundary") {
          const body = queue.getByIdOrThrow(packet.packetId).body;
          for (const area of ["席位续期与重新初始化", "记忆提炼", "目标队列清理",
            "substrate 拆除或保留", "看板冻结与 clean-box 基线", "capability-delta 吸收与过期", "打包产品的可发现性"]) {
            expect(body).toContain(area);
          }
          expect(body).toContain("不是七个后台服务门禁");
          expect(runtime.inspect(instanceId).instance.status).toBe("active");
        }
        await runtime.project({ instanceId, currentPacketId: packet.packetId, exit: id === "release-boundary" ? "done" : "handoff", actorSession: "orch@example", closureEvidence: { evidence_ref: `proof/${id}.md` } });
      }
      let view = runtime.inspect(instanceId);
      expect(view.boundaryObligations.filter((s) => s.required).every((s) => s.receiptState === "recorded")).toBe(true);
      if (successor) {
        expect(view.frontier.map((p) => p.stepId)).toEqual(["activate-successor"]);
        expect(view.instance.status).toBe("active");
        await runtime.project({ instanceId, currentPacketId: view.frontier[0]!.packetId, exit: "done", actorSession: "orch@example" });
        view = runtime.inspect(instanceId);
      }
      expect(view.instance.status).toBe("completed");
      const projected = buildExecutionView({ db, slicesRoot: () => join(root, "missions"), buildInfo: { semver: null, commit: null, dirty: null, builtAt: null } }, { mission: "release-0.5.11" }) as { lifecycle_instances: Array<{ boundary_obligations: unknown }> };
      expect(projected.lifecycle_instances[0]?.boundary_obligations).toEqual(view.boundaryObligations);
      const replay = await runtime.instantiateLifecycle({ missionPath, operationKey: "release", rootObjective: "发布 release", createdBySession: "orch@example" });
      expect(replay.replayed).toBe(true);
      expect(replay.instance.instanceId).toBe(instanceId);
    } finally { db.close(); }
  });
});
