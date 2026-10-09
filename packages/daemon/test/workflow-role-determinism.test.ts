import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "../src/db/migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "../src/db/migrations/052_workflow_instance_bound_rig.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { resolveDefaultOwner } from "../src/domain/workflow-projector.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "../src/domain/workflow-role-resolver.js";
import type { WorkflowSpec } from "../src/domain/workflow-types.js";

// OPR.0.4.6.FAC1 提交 4——确定性 + 零回归 + handover 固定测试
//（架构 F1/F2；QA-3/QA-6；守卫 B1；planner2 §4.8）。仅测试。
//
// VM 捕获证明接线；纯度在这里证明（QA-6/F2 的分工——仅靠捕获证明纯度只是表面工作）。
// 证明矩阵相应标记运行时重复支路。

// ---------- 具名单位向量集合（纯度）----------

function facts(over: Partial<RoleSeatCandidateFacts>): RoleSeatCandidateFacts {
  return {
    logicalId: "dev.x",
    role: "driver",
    nodeKind: "agent",
    lifecycleState: "running",
    runtime: "claude-code",
    pendingWorkCount: 0,
    coordinate: "dev-x@f",
    rawSessionName: "dev-x@f",
    ...over,
  };
}

function seat(coordinate: string, pendingWorkCount = 0): RoleSeatCandidateFacts {
  return facts({ logicalId: coordinate, coordinate, rawSessionName: coordinate, pendingWorkCount });
}

describe("FAC-1 C4：具名确定性单位向量（QA-6 / 架构 F2）", () => {
  const CANDIDATES = [seat("dev-b@f", 1), seat("dev-a@f", 0), seat("dev-c@f", 0)];

  it("可重复性：每次调用时，相同候选集合都会得到相同 seat", () => {
    const first = selectRoleSeat({ role: "driver", candidates: CANDIDATES }).seat;
    for (let i = 0; i < 10; i++) {
      expect(selectRoleSeat({ role: "driver", candidates: CANDIDATES }).seat).toBe(first);
    }
  });

  it("排列不变性：候选数组顺序绝不影响结果", () => {
    // 确定性排列（确定性测试中没有运行时随机性）：轮转 + 反转覆盖不同顺序。
    const perms: RoleSeatCandidateFacts[][] = [
      CANDIDATES,
      [...CANDIDATES].reverse(),
      [CANDIDATES[1]!, CANDIDATES[2]!, CANDIDATES[0]!],
      [CANDIDATES[2]!, CANDIDATES[0]!, CANDIDATES[1]!],
      [CANDIDATES[2]!, CANDIDATES[1]!, CANDIDATES[0]!],
      [CANDIDATES[1]!, CANDIDATES[0]!, CANDIDATES[2]!],
    ];
    const results = perms.map((p) => selectRoleSeat({ role: "driver", candidates: p }).seat);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("dev-a@f");
  });

  it("固定的反直觉向量：driver10@rig < driver2@rig（普通码点排序，绝非自然排序）", () => {
    // 任何把它“修复”为自然排序的操作都会破坏跨版本重放的确定性——该固定点确保此类
    // 修改无法静默发生。
    const result = selectRoleSeat({
      role: "driver",
      candidates: [seat("dev-driver2@rig"), seat("dev-driver10@rig")],
    });
    expect(result.seat).toBe("dev-driver10@rig");
  });

  it("固定大小写处理：普通码点比较（大写排在小写之前）", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [seat("dev-a@f"), seat("Dev-a@f")],
    });
    expect(result.seat).toBe("Dev-a@f"); // 'D' (68) < 'd' (100)
  });

  it("排除 NULL coordinate：从未启动的 seat 不能让比较器崩溃，也不能胜出", () => {
    const result = selectRoleSeat({
      role: "driver",
      candidates: [
        facts({ logicalId: "flat", coordinate: null, rawSessionName: null }),
        seat("dev-a@f"),
      ],
    });
    expect(result.seat).toBe("dev-a@f");
    const nullOne = result.disqualified.find((d) => d.logicalId === "flat");
    // 没有 coordinate 的 RUNNING seat 会被明确记录，绝不静默跳过。
    expect(nullOne?.disqualifier).toBe("coordinate_underivable");
  });

  it("静态导入审计：策略模块不携带时钟、随机性、locale 或数据库依赖", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      join(here, "../src/domain/workflow-role-resolver.ts"),
      "utf-8",
    );
    // 仅审计代码行——模块自身的文档注释会明确提到禁用结构（这是其职责）；
    // 若匹配包含注释，会误中自身（VM 首次运行时发现）。
    const code = source
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n");
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now|new Date\(/);
    expect(code).not.toMatch(/localeCompare|Intl\./);
    expect(code).not.toMatch(/\basync\b|await/);
    // 零运行时导入：仅允许 type-only（import type ...）导入行。当前模块没有任何导入。
    const runtimeImports = code
      .split("\n")
      .filter((l) => /^import /.test(l) && !/^import type /.test(l));
    expect(runtimeImports).toEqual([]);
  });
});

// ---------- tier-2 字节一致向量（零回归围栏）----------

describe("FAC-1 C4：tier-2 字节一致性（声明的 preferred_targets 绝不按清单筛选）", () => {
  const runtimeOf = (session: string): string | null =>
    session.includes("codex") ? "codex" : "claude-code";

  function specWith(targets: string[] | undefined): WorkflowSpec {
    return {
      id: "parity",
      version: "1",
      roles: { driver: targets ? { preferred_targets: targets } : {} },
      steps: [{ id: "s1", actor_role: "driver" }],
    };
  }

  it("即使提供含“更优”角色 seat 的 bound-rig 上下文，未固定的 targets[0] 仍胜出", () => {
    const spec = specWith(["declared-seat@rig", "second@rig"]);
    const ctx = {
      boundRig: "factory-a",
      candidatesForRig: () => {
        throw new Error("tier-2 绝不能读取清单");
      },
    };
    const owner = resolveDefaultOwner(spec, spec.steps[0]!, runtimeOf, ctx);
    expect(owner).toBe("declared-seat@rig");
  });

  it("仍会返回已失效的声明目标——按活跃性筛选声明目标是具名回归", () => {
    // 围栏：tier 2 不查询清单，因此 stopped/dead 的声明 seat 与当前行为完全相同地路由
    //（后果由 WF-5 的 stuck 类负责，而非解析器）。
    const spec = specWith(["dead-seat@rig"]);
    const ctx = {
      boundRig: "factory-a",
      candidatesForRig: () => {
        throw new Error("tier-2 绝不能读取清单");
      },
    };
    expect(resolveDefaultOwner(spec, spec.steps[0]!, runtimeOf, ctx)).toBe("dead-seat@rig");
  });

  it("声明目标内部由 harness 固定的选择不受上下文影响", () => {
    const spec = specWith(["wrong-codex@rig", "right-claude@rig"]);
    const step = { ...spec.steps[0]!, harness: "claude-code" as const };
    const ctx = {
      boundRig: "factory-a",
      candidatesForRig: () => {
        throw new Error("tier-2 绝不能读取清单");
      },
    };
    expect(resolveDefaultOwner(spec, step, runtimeOf, ctx)).toBe("right-claude@rig");
  });

  it("未绑定且无目标时保持字节一致：返回 null，不使用上下文机制", () => {
    const spec = specWith(undefined);
    expect(resolveDefaultOwner(spec, spec.steps[0]!, runtimeOf, undefined)).toBeNull();
  });
});

// ---------- 使用读取 spy 的重放固定测试（守卫 B1，binding）----------

const ROLE_ONLY_SPEC = `workflow:
  id: fac1-c4-replay
  version: 1
  objective: 重放固定点
  target:
    rig: factory-a
  entry:
    role: planner
  roles:
    planner: {}
    driver: {}
  steps:
    - id: plan
      actor_role: planner
      allowed_exits:
        - handoff
        - waiting
    - id: build
      actor_role: driver
      allowed_exits:
        - done
`;

describe("FAC-1 C4：重放固定点——两类重放的 role 解析都不读取清单", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let tmp: string;
  let rigAId: string;
  let specPath: string;
  let sessionSeq = 0;

  function seedSeat(pod: string, member: string, opts: { role?: string; sessionStatus?: string }): string {
    const podRec = podRepo.getPodByNamespace(rigAId, pod) ?? podRepo.createPod(rigAId, pod, pod);
    const node = rigRepo.addNode(rigAId, `${pod}.${member}`, {
      role: opts.role,
      runtime: "claude-code",
      cwd: "/tmp",
      podId: podRec.id,
      agentRef: "local:agents/x",
      profile: "default",
    });
    const coordinate = `${pod}-${member}@factory-a`;
    sessionSeq += 1;
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)`).run(
      `s-${String(sessionSeq).padStart(4, "0")}`,
      node.id,
      coordinate,
      opts.sessionStatus ?? "running",
    );
    return coordinate;
  }

  /** 读取 spy：统计触及节点清单表面的预备语句（从 nodes/sessions/bindings 读取）。
   *  role 解析是 project() 内唯一使用这些表的工作流路径消费者；重放绝不能触发它们。 */
  function spyInventoryReads(): { count: () => number; restore: () => void } {
    const orig = db.prepare.bind(db);
    let n = 0;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (/FROM nodes\b/i.test(sql)) n += 1;
      return orig(sql);
    };
    return {
      count: () => n,
      restore: () => {
        delete (db as unknown as Record<string, unknown>)["prepare"];
      },
    };
  }

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [
      outboxEntriesSchema,
      workflowSpecsSchema,
      workflowInstancesSchema,
      workflowStepTrailsSchema,
      workflowInstanceVersionSchema,
      workflowSpecJsonSchema,
      workflowResumeSchema,
      workflowInstanceBoundRigSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    // P34：W1 接缝采用闭合失败（MF2）——意图发送 nudge 的 terminal 关闭需要同数据库
    // intent store，才能使其唤醒持久化。
    queueRepo.attachOutbox(new OutboxHandler(db));
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    rigAId = rigRepo.createRig("factory-a").id;
    tmp = mkdtempSync(join(tmpdir(), "wf-c4-"));
    specPath = join(tmp, "replay.yaml");
    writeFileSync(specPath, ROLE_ONLY_SPEC);
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("TERMINAL 重放：清单在解析记录与重放之间变化；仍返回 409，记录目标不变，且不读取清单", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    const firstDriver = seedSeat("dev", "driver1", { role: "driver" });
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(firstDriver);

    // 清单变化：新增一个负载更低、码点排序更靠前的 seat。
    seedSeat("dev", "driver0", { role: "driver" });

    const spy = spyInventoryReads();
    try {
      await expect(
        runtime.projector.project({
          instanceId: inst.instance.instanceId,
          currentPacketId: inst.entryQitemId, // already closed → not on frontier
          exit: "handoff",
          actorSession: "dev-planner1@factory-a",
        }),
      ).rejects.toMatchObject({ code: "packet_not_on_frontier" });
      expect(spy.count()).toBe(0); // 守卫 B1：重放未读取任何内容
    } finally {
      spy.restore();
    }
    // 已记录目标是确定性锚点——保持不变。
    const packet = queueRepo.getById(projected.nextQitemId!);
    expect(packet?.destinationSession).toBe(firstDriver);
  });

  it("已吸收的 waiting 重放：完全相同的重复请求被吸收，既不写入也不读取清单", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    seedSeat("dev", "driver1", { role: "driver" });
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const parkInput = {
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "waiting" as const,
      actorSession: "dev-planner1@factory-a",
      blockedOn: "external-gate",
    };
    await runtime.projector.project(parkInput);

    // 清单在 park 与重放之间变化（无关紧要——spy 证明重放从未查看它）。
    seedSeat("dev", "driver0", { role: "driver" });

    const spy = spyInventoryReads();
    try {
      const replayed = await runtime.projector.project(parkInput);
      expect(replayed.absorbedReplay).toBe(true);
      expect(spy.count()).toBe(0);
    } finally {
      spy.restore();
    }
  });

  it("HANDOVER 稳定性固定点（AC-3）：seat 背后的 occupant 切换后，已记录目标和全新解析仍指向同一 coordinate", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    const driverSeat = seedSeat("dev", "driver1", { role: "driver" });
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected.nextOwnerSession).toBe(driverSeat);

    // 模拟 handover 变更（SeatHandoverMutationResult 结构）：occupant 时期字段改变；
    // 新会话行注册到相同规范 coordinate 下（handover 重新启动会复用它）。
    const node = db.prepare(`SELECT id FROM nodes WHERE logical_id = 'dev.driver1'`).get() as { id: string };
    db.prepare(`UPDATE sessions SET status = 'stopped' WHERE node_id = ?`).run(node.id);
    db.prepare(`UPDATE nodes SET previous_occupant = ?, handover_result = 'handed_over' WHERE id = ?`).run(
      driverSeat,
      node.id,
    );
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-successor', ?, ?, 'running')`).run(
      node.id,
      driverSeat,
    );

    // (a) 已记录目标仍指向该 seat（coordinate 稳定）。
    const packet = queueRepo.getById(projected.nextQitemId!);
    expect(packet?.destinationSession).toBe(driverSeat);

    // (b) 全新解析（第二个绑定实例）选择相同 coordinate。
    const inst2 = await runtime.instantiate({ specPath, rootObjective: "t2", createdBySession: "orch@factory-a" });
    const projected2 = await runtime.projector.project({
      instanceId: inst2.instance.instanceId,
      currentPacketId: inst2.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
    });
    expect(projected2.nextOwnerSession).toBe(driverSeat);
  });

  it("兼容性：实例化时 ENTRY-OWNER 覆盖值优先于 bound rig 上的解析器", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    seedSeat("dev", "driver1", { role: "driver" });
    const override = seedSeat("dev", "special", {});
    const inst = await runtime.instantiate({
      specPath,
      rootObjective: "t",
      createdBySession: "orch@factory-a",
      entryOwnerSession: override,
    });
    expect(inst.entryOwnerSession).toBe(override);
  });

  it("兼容性：显式 nextOwnerSession 覆盖值优先于 bound rig 下的解析器", async () => {
    seedSeat("dev", "planner1", { role: "planner" });
    seedSeat("dev", "driver1", { role: "driver" });
    const override = seedSeat("dev", "special", {});
    const inst = await runtime.instantiate({ specPath, rootObjective: "t", createdBySession: "orch@factory-a" });
    const projected = await runtime.projector.project({
      instanceId: inst.instance.instanceId,
      currentPacketId: inst.entryQitemId,
      exit: "handoff",
      actorSession: "dev-planner1@factory-a",
      nextOwnerSession: override,
    });
    expect(projected.nextOwnerSession).toBe(override);
    // Evidence 记录 explicit 模式。
    const trail = runtime.trailLog.listForInstance(inst.instance.instanceId);
    const evidence = trail[0]?.closureEvidence as Record<string, Record<string, unknown>> | null;
    expect(evidence?.["owner_resolution"]?.["mode"]).toBe("explicit");
  });
});
