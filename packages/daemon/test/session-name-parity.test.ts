// OPR.0.4.6.MH1 FR-8——session-name 解析契约，在三个 package 间由 parity 锁定
//（arch B2 裁定：workspace 不跨 import，因此 daemon/cli/ui 各自携带副本；此共享 vector 集就是
// 锁定点——这里出现分歧意味着某个副本已漂移）。
//
// 下方具名测试锁定三个架构齿：
//   TOOTH 1——queue-destination gate 在任何解析前进行 human-seat 分类（human seat 零次 rig 查询）。
//   TOOTH 2——三段 "member@rig@x" 继续以贪婪 rig（"rig@x"）解析，因此 registry lookup 未命中，
//             queue gate 以与契约出现前相同的 unknown_destination_rig 错误拒绝
//             （BR-1：host 绝不带内传递）。
//   TOOTH 3——旧版 r{NN}-suffix 语法继续作为 session 名通过校验（且不携带 rig binding）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import { HUMAN_SEAT_SESSION_PATTERN } from "../src/domain/human-route-enforcer.js";
import * as daemonCopy from "../src/domain/session-name.js";
import * as cliCopy from "../../cli/src/session-name.js";
import * as uiCopy from "../../ui/src/lib/session-name.js";

type ContractCopy = {
  parseSessionName: typeof daemonCopy.parseSessionName;
  isHumanSeatSessionRef: typeof daemonCopy.isHumanSeatSessionRef;
  sessionMemberLabel: typeof daemonCopy.sessionMemberLabel;
  sessionRigOf: typeof daemonCopy.sessionRigOf;
};

const COPIES: Array<[string, ContractCopy]> = [
  ["daemon", daemonCopy],
  ["cli", cliCopy],
  ["ui", uiCopy],
];

const malformed = (input: string) =>
  ({ kind: "malformed", error: "malformed_session_name", input }) as const;

// 一组 vector 对每个副本运行。`memberLabel`/`rigOf` 锁定展示 helper；`human` 锁定分类。
const SHARED_VECTORS = [
  {
    label: "canonical pod-member session 格式",
    input: "dev46-driver2@openrig-delivery",
    parsed: { kind: "canonical", member: "dev46-driver2", rig: "openrig-delivery" },
    human: false, memberLabel: "dev46-driver2", rigOf: "openrig-delivery",
  },
  {
    label: "简单 canonical member@rig",
    input: "member@rig",
    parsed: { kind: "canonical", member: "member", rig: "rig" },
    human: false, memberLabel: "member", rigOf: "rig",
  },
  {
    label: "TOOTH 2（parse 分支）：member@rig@x 以贪婪 rig 'rig@x' 解析",
    input: "member@rig@x",
    parsed: { kind: "canonical", member: "member", rig: "rig@x" },
    human: false, memberLabel: "member", rigOf: "rig@x",
  },
  {
    label: "TOOTH 3：旧版 r{NN}-suffix 继续通过校验（非 canonical，无 rig binding）",
    input: "r03-worker",
    parsed: { kind: "legacy", name: "r03-worker" },
    human: false, memberLabel: "r03-worker", rigOf: undefined,
  },
  {
    label: "TOOTH 1（分类分支）：human@kernel 是 human seat",
    input: "human@kernel",
    parsed: { kind: "canonical", member: "human", rig: "kernel" },
    human: true, memberLabel: "human", rigOf: "kernel",
  },
  {
    label: "host 上带后缀的 human seat",
    input: "human-mvs@host",
    parsed: { kind: "canonical", member: "human-mvs", rig: "host" },
    human: true, memberLabel: "human-mvs", rigOf: "host",
  },
  {
    label: "human@<ordinary-rig> 不是 human seat",
    input: "human@some-rig",
    parsed: { kind: "canonical", member: "human", rig: "some-rig" },
    human: false, memberLabel: "human", rigOf: "some-rig",
  },
  {
    label: "humanoid@kernel 不是 human seat（前缀必须精确）",
    input: "humanoid@kernel",
    parsed: { kind: "canonical", member: "humanoid", rig: "kernel" },
    human: false, memberLabel: "humanoid", rigOf: "kernel",
  },
  {
    label: "畸形：裸非 legacy id",
    input: "bare",
    parsed: malformed("bare"),
    human: false, memberLabel: "bare", rigOf: undefined,
  },
  {
    label: "畸形：member 为空（@rig）",
    input: "@rig",
    parsed: malformed("@rig"),
    human: false, memberLabel: "", rigOf: undefined,
  },
  {
    label: "畸形：rig 为空（member@）",
    input: "member@",
    parsed: malformed("member@"),
    human: false, memberLabel: "member", rigOf: undefined,
  },
  {
    label: "畸形：空字符串",
    input: "",
    parsed: malformed(""),
    human: false, memberLabel: "", rigOf: undefined,
  },
  {
    label: "畸形：r3-worker（legacy 要求恰好两位数字）",
    input: "r3-worker",
    parsed: malformed("r3-worker"),
    human: false, memberLabel: "r3-worker", rigOf: undefined,
  },
  // ── A2 第四分支：virtual-domain（@external）。Contract 2cf541c6 / verdict 8cd30094。
  // kind 'external' {local, domain}；human-CLASS predicate 返回 true（不静默降级为 agent-class）；
  // rigOf 为 undefined（virtual domain 不是 routing rig）。Admission（registered 与 scheme，未注册
  // 则拒绝）由 A1/A4 GATEWAY 负责。
  {
    label: "第四分支：已注册 virtual-domain ref mike@external",
    input: "mike@external",
    parsed: { kind: "external", local: "mike", domain: "external" },
    human: true, memberLabel: "mike", rigOf: undefined,
  },
  {
    label: "第四分支：scheme 形式 local 按词法进入该分支（slack:U012AB3CD@external）",
    input: "slack:U012AB3CD@external",
    parsed: { kind: "external", local: "slack:U012AB3CD", domain: "external" },
    human: true, memberLabel: "slack:U012AB3CD", rigOf: undefined,
  },
  {
    label: "第四分支：带点 local（my.name@external）",
    input: "my.name@external",
    parsed: { kind: "external", local: "my.name", domain: "external" },
    human: true, memberLabel: "my.name", rigOf: undefined,
  },
  {
    label: "第四分支：带连字符 local（my-name@external）",
    input: "my-name@external",
    parsed: { kind: "external", local: "my-name", domain: "external" },
    human: true, memberLabel: "my-name", rigOf: undefined,
  },
  {
    label: "第四分支裁定 human@external：local 'human' 有效 → external（human-class），未注册则在 gateway 拒绝",
    input: "human@external",
    parsed: { kind: "external", local: "human", domain: "external" },
    human: true, memberLabel: "human", rigOf: undefined,
  },
  {
    label: "第四分支负例：空 local（@external）→ malformed（不降级为 agent）",
    input: "@external",
    parsed: malformed("@external"),
    human: false, memberLabel: "", rigOf: undefined,
  },
  {
    label: "第四分支负例：domain 不在封闭集合（mike@externalx）→ canonical，而非 external",
    input: "mike@externalx",
    parsed: { kind: "canonical", member: "mike", rig: "externalx" },
    human: false, memberLabel: "mike", rigOf: "externalx",
  },
] as const;

describe("session-name 契约——三份副本 parity（共享 vector）", () => {
  for (const [pkg, copy] of COPIES) {
    describe(`${pkg} 副本`, () => {
      for (const v of SHARED_VECTORS) {
        it(v.label, () => {
          expect(copy.parseSessionName(v.input)).toEqual(v.parsed);
          expect(copy.isHumanSeatSessionRef(v.input)).toBe(v.human);
          expect(copy.sessionMemberLabel(v.input)).toBe(v.memberLabel);
          expect(copy.sessionRigOf(v.input)).toBe(v.rigOf);
        });
      }
    });
  }

  it("cli 与 ui 副本按字节完全一致（逐字镜像钉扎）", () => {
    const cliSrc = readFileSync(resolve(import.meta.dirname, "../../cli/src/session-name.ts"), "utf8");
    const uiSrc = readFileSync(resolve(import.meta.dirname, "../../ui/src/lib/session-name.ts"), "utf8");
    expect(cliSrc).toBe(uiSrc);
  });

  it("契约的 human-CLASS predicate = 只读 enforcer human-seat pattern 或 A2 virtual-domain 分支（有意扩宽并锁定，不静默处理）", () => {
    // 此 slice 中 human-route-enforcer.ts 为只读（PRD 约束），并保留其窄 human-seat pattern。A2
    // 扩宽契约 predicate，也将 virtual-domain ref（<local>@external）准入为 human-CLASS。该分歧是
    // 有意设计，因此锁定精确 union——enforcer-human-seat 或契约自身 external kind——使任一侧都无法
    // 静默漂移。（按 dev-planner 裁定，enforcer 的其余 consumer 在此 slice 保留窄 pattern；这是有文档
    // 记录并转入后续项的分歧。）
    for (const v of SHARED_VECTORS) {
      const enforcerHumanSeat = HUMAN_SEAT_SESSION_PATTERN.test(v.input);
      const virtualDomainLeg = daemonCopy.parseSessionName(v.input).kind === "external";
      expect(daemonCopy.isHumanSeatSessionRef(v.input)).toBe(enforcerHumanSeat || virtualDomainLeg);
    }
  });
});

describe("session-name 契约——queue-destination gate 齿", () => {
  // gate 组合与 packages/daemon/src/startup.ts 的接线（topologyValidateRig）完全相同：先进行
  // human 分类，再共享 parse，最后查询 rig-registry。
  function gateWith(findRigsByName: (rigName: string) => unknown[]) {
    return (sessionRef: string): boolean => {
      if (daemonCopy.isHumanSeatSessionRef(sessionRef)) return true;
      const parsed = daemonCopy.parseSessionName(sessionRef);
      if (parsed.kind !== "canonical") return false;
      return findRigsByName(parsed.rig).length > 0;
    };
  }

  it("TOOTH 1：human-seat 分类在任何 parse 前运行——human seat 零次 rig lookup", () => {
    const lookups: string[] = [];
    const gate = gateWith((rigName) => { lookups.push(rigName); return []; });
    expect(gate("human@kernel")).toBe(true);
    expect(gate("human-mvs@host")).toBe(true);
    expect(lookups).toEqual([]);
  });

  it("TOOTH 2（lookup 分支）：member@rig@x 精确查询贪婪 rig 'rig@x' 并无法通过 gate", () => {
    const lookups: string[] = [];
    const gate = gateWith((rigName) => { lookups.push(rigName); return []; });
    expect(gate("member@rig@x")).toBe(false);
    expect(lookups).toEqual(["rig@x"]);
  });

  it("TOOTH 3（gate 分支）：旧版 r{NN} 名作为名称仍有效，但不含 rig binding——gate 与此前一样拒绝", () => {
    expect(daemonCopy.validateSessionName("r03-worker")).toBe(true);
    const gate = gateWith(() => [{ id: "any" }]);
    expect(gate("r03-worker")).toBe(false);
  });

  describe("TOOTH 2（错误分支）：queue 以相同 unknown_destination_rig 拒绝 member@rig@x", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = createDb();
      migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    });

    afterEach(() => db.close());

    it("拒绝三段 destination；rig 存在时接受相同 member@rig", async () => {
      const known = new Set(["rig"]);
      const eventBus = new EventBus(db);
      const queueRepo = new QueueRepository(db, eventBus, {
        validateRig: gateWith((rigName) => (known.has(rigName) ? [{ id: "r-1" }] : [])),
      });

      await expect(
        queueRepo.create({ sourceSession: "src@rig", destinationSession: "member@rig@x", body: "x" }),
      ).rejects.toMatchObject({ code: "unknown_destination_rig" });
      await expect(
        queueRepo.create({ sourceSession: "src@rig", destinationSession: "member@rig@x", body: "x" }),
      ).rejects.toBeInstanceOf(QueueRepositoryError);

      const item = await queueRepo.create({ sourceSession: "src@rig", destinationSession: "member@rig", body: "ok" });
      expect(item.destinationSession).toBe("member@rig");
    });
  });
});
