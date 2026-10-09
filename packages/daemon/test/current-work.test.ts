import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCurrentWork } from "../src/domain/current-work.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

// 规范 mission tag 是目录名（mission:release-0.5.8）；id 形式（mission:OPR.0.5.8）仅用于历史兼容，
// 不得写入新行。这些 fixture 覆盖兼容路径，是因为仍有携带旧形式的行存在于 board；若拒绝它们，
// 等于 guess-refusal 对正确数据触发，并不表示两种形式都是有效约定。依据 2026-09-01 09:43Z
// 转达的裁决。
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function tree(): string {
  root = mkdtempSync(join(tmpdir(), "current-work-"));
  const missions = join(root, "missions");
  const slices = join(missions, "release-0.5.8", "slices");
  mkdirSync(join(slices, "14-refocus-current-work-binding"), { recursive: true });
  mkdirSync(join(slices, "09-single-topology-creation-ingress"), { recursive: true });
  writeFileSync(
    join(missions, "release-0.5.8", "SPEC.md"),
    "---\nid: OPR.0.5.8\nmission: release-0.5.8\n---\n# mission\n",
    "utf8",
  );
  writeFileSync(
    join(slices, "14-refocus-current-work-binding", "SPEC.md"),
    "---\nid: OPR.0.5.8.14\n---\n# slice 14\n",
    "utf8",
  );
  writeFileSync(
    join(slices, "09-single-topology-creation-ingress", "SPEC.md"),
    "---\nid: OPR.0.5.8.9\n---\n# slice 9\n",
    "utf8",
  );
  return missions;
}

const row = (mission: string, slice: string, state = "in-progress") => ({
  state,
  tags: [`mission:${mission}`, `slice:${slice}`],
});

describe("deriveCurrentWork——tag 形式容忍（OPR.0.5.8.14）", () => {
  it("解析以目录名标记的 mission", () => {
    const missions = tree();
    const result = deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.14")], missions);
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("仍解析 board 上既有的旧版 id 形式 mission tag（仅兼容）", () => {
    const missions = tree();
    const result = deriveCurrentWork([row("OPR.0.5.8", "OPR.0.5.8.14")], missions);
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("解析以目录名标记的 slice", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [row("release-0.5.8", "14-refocus-current-work-binding")],
      missions,
    );
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("提示规范 tag 对，并把旧形式标记为兼容项", () => {
    const missions = tree();
    const canonical = deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.14")], missions);
    expect(canonical.currentWorkBasis).toContain("任务目标通过规范目录名标签匹配");
    expect(canonical.currentWorkBasis).toContain("slice 通过规范 ID 标签匹配");
    expect(canonical.currentWorkBasis).not.toContain("兼容");

    // 命中旧路径的读取者必须获知这是兼容行为，而不能把它显示为推荐约定。
    const legacy = deriveCurrentWork([row("OPR.0.5.8", "OPR.0.5.8.14")], missions);
    expect(legacy.currentWorkBasis).toContain("旧版 ID 形式标签（兼容）");
  });
});

describe("deriveCurrentWork——在已解析节点上计算歧义", () => {
  // 兼容窗口期间，规范行和旧版行可能指向同一节点。
  it("两个用不同 tag 形式指向同一工作节点的行视为一个，而非歧义", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [row("release-0.5.8", "OPR.0.5.8.14"), row("OPR.0.5.8", "14-refocus-current-work-binding")],
      missions,
    );
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("两行解析到真正不同的工作节点时仍拒绝", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [row("release-0.5.8", "OPR.0.5.8.14"), row("OPR.0.5.8", "OPR.0.5.8.9")],
      missions,
    );
    expect(result.currentWork).toBeNull();
    expect(result.currentWorkBasis).toContain("拒绝猜测");
  });

  it("拒绝携带冲突 slice tag 的单行，无论数组顺序如何", () => {
    // tags 列逐字持久化，未规定逐前缀唯一性，因此数组位置不是数据。选择第一个匹配会让答案依赖
    // 插入顺序，相当于在更外一层把歧义错误转换成确定答案。
    const missions = tree();
    const conflicting = (...slices: string[]) => [{
      state: "in-progress",
      tags: ["mission:release-0.5.8", ...slices.map((s) => `slice:${s}`)],
    }];

    const forward = deriveCurrentWork(conflicting("OPR.0.5.8.14", "OPR.0.5.8.9"), missions);
    const reversed = deriveCurrentWork(conflicting("OPR.0.5.8.9", "OPR.0.5.8.14"), missions);
    expect(forward.currentWork).toBeNull();
    expect(reversed.currentWork).toBeNull();
    expect(forward.currentWorkBasis).toContain("slice");
    // 顺序不得改变判定；这种相等性才是实际被测属性。
    expect(forward.currentWorkBasis).toBe(reversed.currentWorkBasis);
  });

  it("拒绝携带冲突 mission tag 的单行", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [{
        state: "in-progress",
        tags: ["mission:release-0.5.8", "mission:OPR.0.5.8", "slice:OPR.0.5.8.14"],
      }],
      missions,
    );
    // 此处两个值恰好指向同一 mission，但仍必须拒绝。这不是模块无法判断；resolveRow 与 byPath
    // 去重会跨行比较不同拼写，下方测试正依赖这一点。原因在于单行以两种不同方式命名 mission
    // 本身就是格式错误。拒绝格式错误输入是本模块职责；若继续解析，就等于替调用方修复行后，
    // 再把修复结果冒充原始答案。
    expect(result.currentWork).toBeNull();
    expect(result.currentWorkBasis).toContain("mission");
  });

  it("折叠完全重复的 tag，而不视为冲突", () => {
    const missions = tree();
    const result = deriveCurrentWork(
      [{
        state: "in-progress",
        tags: ["mission:release-0.5.8", "mission:release-0.5.8", "slice:OPR.0.5.8.14"],
      }],
      missions,
    );
    expect(result.currentWork?.workNodePath).toBe(
      join(missions, "release-0.5.8", "slices", "14-refocus-current-work-binding"),
    );
  });

  it("调用方提供行 id 时，拒绝结果会点名出错行", () => {
    // R1 F3：只点名值会让读取者自行查找对应行；生产调用点会传完整 queue item，因此可直接获得 id。
    const missions = tree();
    const conflict = deriveCurrentWork(
      [{
        qitemId: "qitem-conflict-1",
        state: "in-progress",
        tags: ["mission:release-0.5.8", "slice:OPR.0.5.8.14", "slice:OPR.0.5.8.9"],
      }],
      missions,
    );
    expect(conflict.currentWork).toBeNull();
    expect(conflict.currentWorkBasis).toContain("qitem-conflict-1");

    const unresolved = deriveCurrentWork(
      [{
        qitemId: "qitem-unresolved-2",
        state: "in-progress",
        tags: ["mission:release-0.5.8", "slice:OPR.0.5.8.999"],
      }],
      missions,
    );
    expect(unresolved.currentWork).toBeNull();
    expect(unresolved.currentWorkBasis).toContain("qitem-unresolved-2");

    // 类型允许不提供 id，因此该情况下也必须干净降级。
    const anonymous = deriveCurrentWork(
      [{ state: "in-progress", tags: ["mission:release-0.5.8", "slice:OPR.0.5.8.999"] }],
      missions,
    );
    expect(anonymous.currentWorkBasis).toContain("某一行");
    expect(anonymous.currentWorkBasis).not.toContain("undefined");
  });

  it("类型化行一条解析失败、一条成功时拒绝", () => {
    // 未解析的类型化 baton 是 UNKNOWN，不是无关项。仅依据恰好解析成功的行回答，会把“无法判断它
    // 是什么”当成“它不计入”，正是本 slice 要阻止的猜测。只在 basis 中披露还不够，因为调用方
    // 读取的是 workNodePath，而非旁边的 prose。
    const missions = tree();
    const result = deriveCurrentWork(
      [row("release-0.5.8", "OPR.0.5.8.14"), row("release-0.5.8", "OPR.0.5.8.999")],
      missions,
    );
    expect(result.currentWork).toBeNull();
    expect(result.currentWorkBasis).toContain("OPR.0.5.8.999");
  });

  it("仅当每个类型化行均可解析时才跨 tag 形式去重", () => {
    const missions = tree();
    // 两行都解析到同一节点 → 一个工作项，可以回答。
    expect(
      deriveCurrentWork(
        [row("release-0.5.8", "OPR.0.5.8.14"), row("OPR.0.5.8", "14-refocus-current-work-binding")],
        missions,
      ).currentWork,
    ).not.toBeNull();
    // 一行成功、一行失败 → 去重不得掩盖问题。
    expect(
      deriveCurrentWork(
        [row("release-0.5.8", "OPR.0.5.8.14"), row("nope-not-a-mission", "OPR.0.5.8.14")],
        missions,
      ).currentWork,
    ).toBeNull();
  });

  it("即使第二个 baton 超出 recent 的 25 行上限，也拒绝歧义", async () => {
    // Guard 固定的复现：whoami.recent 上限为 25 且混合状态，因此较旧的 in-progress baton 会落在
    // 窗口外，但权威计数仍为 2。从该投影派生会把应有的歧义拒绝变成自信答案。
    const missions = tree();
    const db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema]);
    const repo = new QueueRepository(db, new EventBus(db));
    const SEAT = "dev-driver@rig";

    const claim = async (mission: string, slice: string) => {
      const item = await repo.create({
        sourceSession: "planner@rig",
        destinationSession: SEAT,
        body: `typed ${slice}`,
        tags: [`mission:${mission}`, `slice:${slice}`],
      });
      repo.claim({ qitemId: item.qitemId, destinationSession: SEAT });
      return item;
    };

    // 先放最旧的类型化 baton，再加入足够多新行，把它挤出上限。
    const older = await claim("release-0.5.8", "OPR.0.5.8.9");
    for (let i = 0; i < 24; i += 1) {
      await repo.create({
        sourceSession: "planner@rig",
        destinationSession: SEAT,
        body: `filler ${i}`,
        tags: ["kind:note"],
      });
    }
    await claim("release-0.5.8", "OPR.0.5.8.14");

    // Claim 会更新 ts_updated，而同一秒创建的行会并列，导致排序及整个 fixture 不确定。
    // 把旧 baton 固定在每个 filler 之后，使“超出上限”成为事实而非竞态。
    db.prepare(`UPDATE queue_items SET ts_updated = ? WHERE qitem_id = ?`)
      .run("2000-01-01T00:00:00.000Z", older.qitemId);

    // 对照：有上限的展示投影确实隐藏旧 baton，因此本测试在修复前输入上会失败，而非空跑通过。
    const recent = repo.whoami(SEAT).asDestination.recent;
    expect(recent.length).toBe(25);
    const typedInRecent = recent.filter(
      (r) => r.state === "in-progress" && (r.tags ?? []).some((t) => t.startsWith("slice:")),
    );
    expect(typedInRecent.length).toBe(1);
    expect(deriveCurrentWork(recent, missions).currentWork).not.toBeNull();

    // 权威输入无界，因此拒绝会按预期触发。
    const authoritative = repo.listInProgressForDestination(SEAT);
    expect(authoritative.length).toBe(2);
    const derived = deriveCurrentWork(authoritative, missions);
    expect(derived.currentWork).toBeNull();
    expect(derived.currentWorkBasis).toContain("拒绝猜测");

    db.close();
  });

  it("无任何解析结果时以具名 basis 拒绝，并忽略未 claim 行", () => {
    const missions = tree();
    expect(deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.999")], missions).currentWorkBasis)
      .toContain("解析到 0 个目录");
    // R1 F1：拒绝必须点名其工作范围，不能暗示空 desk。若席位唯一的类型化 baton 被阻塞，
    // 它仍持有真实工作；“你没有工作”会把它导向与“你的工作已停驻”不同的路径。
    const notClaimed = deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.14", "pending")], missions);
    expect(notClaimed.currentWork).toBeNull();
    expect(notClaimed.currentWorkBasis).toContain("只考虑 in-progress 行");
    expect(notClaimed.currentWorkBasis).toContain("blocked");
    expect(deriveCurrentWork([row("release-0.5.8", "OPR.0.5.8.14")], null))
      .toMatchObject({ currentWork: null });
  });
});
