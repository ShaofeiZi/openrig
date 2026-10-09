// VM-005（release-0.4.7）——TIER B：new-symbol unit 套件 + TIER A 纯
// bucket 差分（plan v1.3 §D-bis；ARCH-RULING-b3，sha 632ff319…）。
//
// Tier B（下）：DYNAMIC import project-mission-state.js（该模块在两个 SHA
// 都存在，故 import 总成功）；t1 PRESENCE 断言无条件且最先——在 base
// 8757593f 它是计数的命名 RED（"expected 'undefined' to be 'function'"）；
// unit 用例条件运行，t3 executed-count 断言锁定它们全部在 candidate 运行。
//
// Tier A（底）：FR-4 bucket 差分 + V5 纯 carve，经两端 STATIC import
//（projectMissionBucket / partitionProjectMissions 在两个 SHA 都存在）——
// candidate 预期逐字，一条代码路径。

import { describe, it, expect, beforeAll } from "vitest";
import {
  projectSliceFromListEntry,
  reconcileMissionStatus,
  projectMissionBucket,
  partitionProjectMissions,
  PROJECT_CURRENT_ACTIVITY_WINDOW_MS,
  type ProjectSliceRow,
} from "../src/lib/project-mission-state.js";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const RECENT = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - PROJECT_CURRENT_ACTIVITY_WINDOW_MS - 60_000).toISOString();

function slice(over: Partial<ProjectSliceRow>): ProjectSliceRow {
  return {
    name: "s1",
    displayName: "S1",
    status: "active",
    rawStatus: null,
    qitemCount: 0,
    hasProofPacket: false,
    lastActivityAt: null,
    missionId: "m1",
    railItem: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// TIER B——new-symbol units（t1/t2/t3 按 B3 裁决）
// ---------------------------------------------------------------------------

type Pms = typeof import("../src/lib/project-mission-state.js");
let pms: Pms;
const executed: string[] = [];
const TIER_B_CASES = [
  "label-verbatim",
  "corpus-independence",
  "injected-now-purity",
  "closed-map-roundtrip",
  "unrecognized-neutral",
  "derived-ladder-words",
  "v6-frozen-semantics",
] as const;

beforeAll(async () => {
  pms = await import("../src/lib/project-mission-state.js");
});

describe("Tier B — reconcileMissionStatus unit contract (t1 presence FIRST)", () => {
  // t1——无条件、最先：base 处计数的命名 RED。
  it("t1: the reconciled home exists (reconcileMissionStatus + AUTHORED_WORD_TONES exported)", () => {
    expect(typeof (pms as Record<string, unknown>).reconcileMissionStatus).toBe("function");
    expect(typeof (pms as Record<string, unknown>).AUTHORED_WORD_TONES).toBe("object");
  });

  // t2（B3 裁决，arch sha 632ff319…）：下列用例仅因符号在 base 不存在而条件
  // 运行；任何差分向量永远不得移入此条件块——差分包在 Tier A 套件
  //（mission-status-surfaces.test.tsx + 下方 Tier A 块）。
  const hasHome = () =>
    typeof (pms as Record<string, unknown>).reconcileMissionStatus === "function";

  it("authored label renders VERBATIM (case preserved), tone via the closed constant", () => {
    if (!hasHome()) return;
    executed.push("label-verbatim");
    const rec = pms.reconcileMissionStatus("complete", [slice({ lastActivityAt: RECENT })], NOW);
    expect(rec).toEqual({ state: "shipped", label: "complete", source: "authored" });
    expect(pms.reconcileMissionStatus("Complete", [], NOW).label).toBe("Complete");
  });

  it("authored path never consults slices (identical result for any corpus)", () => {
    if (!hasHome()) return;
    executed.push("corpus-independence");
    const a = pms.reconcileMissionStatus("paused", [], NOW);
    const b = pms.reconcileMissionStatus("paused", [slice({ status: "blocked", qitemCount: 3 })], NOW);
    expect(a).toEqual(b);
  });

  it("clock purity: `now` is injected — authored output byte-stable across any jump", () => {
    if (!hasHome()) return;
    executed.push("injected-now-purity");
    const JUMP = NOW + PROJECT_CURRENT_ACTIVITY_WINDOW_MS * 10;
    for (const word of ["complete", "active"]) {
      const before = pms.reconcileMissionStatus(word, [slice({ lastActivityAt: RECENT })], NOW);
      const after = pms.reconcileMissionStatus(word, [slice({ lastActivityAt: RECENT })], JUMP);
      expect(after).toEqual(before);
    }
    // derived 保持窗口作判别器（DOM V4 的 unit 镜像）
    const corpus = [slice({ lastActivityAt: RECENT })];
    expect(pms.reconcileMissionStatus(null, corpus, NOW).state).toBe("active");
    expect(pms.reconcileMissionStatus(null, corpus, JUMP).state).toBe("idle");
  });

  it("Q3-P1: the closed map is the ONLY word registry; every entry round-trips", () => {
    if (!hasHome()) return;
    executed.push("closed-map-roundtrip");
    for (const [word, tone] of Object.entries(pms.AUTHORED_WORD_TONES)) {
      expect(pms.reconcileMissionStatus(word, [], NOW).state).toBe(tone);
    }
    for (const word of ["complete", "completed", "done", "shipped"]) {
      expect(pms.AUTHORED_WORD_TONES[word]).toBe("shipped");
    }
  });

  it("unrecognized authored word → neutral tone (idle carrier), the word still wins verbatim", () => {
    if (!hasHome()) return;
    executed.push("unrecognized-neutral");
    const rec = pms.reconcileMissionStatus("Percolating", [slice({ lastActivityAt: RECENT })], NOW);
    expect(rec).toEqual({ state: "idle", label: "Percolating", source: "authored" });
  });

  it("derived ladder words: empty · blocked · draft · active · shipped · idle (the retired word is unreachable)", () => {
    if (!hasHome()) return;
    executed.push("derived-ladder-words");
    expect(pms.reconcileMissionStatus(null, [], NOW).state).toBe("empty");
    expect(pms.reconcileMissionStatus(null, [slice({ status: "blocked" })], NOW).state).toBe("blocked");
    expect(
      pms.reconcileMissionStatus(null, [slice({ status: "draft", lastActivityAt: RECENT })], NOW).state,
    ).toBe("draft");
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: RECENT })], NOW).state).toBe("active");
    expect(pms.reconcileMissionStatus(null, [slice({ status: "done" })], NOW).state).toBe("shipped");
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: STALE })], NOW).state).toBe("idle");
    expect(pms.reconcileMissionStatus(null, [], NOW).label).toBe("空");
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: RECENT })], NOW).label).toBe("进行中");
    expect(pms.reconcileMissionStatus(null, [slice({ status: "done" })], NOW).label).toBe("已发布");
    const corpora: ProjectSliceRow[][] = [
      [],
      [slice({ lastActivityAt: STALE })],
      [slice({ status: "done" }), slice({ status: "draft", lastActivityAt: STALE })],
    ];
    for (const c of corpora) {
      expect(pms.reconcileMissionStatus(null, c, NOW).state).not.toBe("unknown");
    }
  });

  it("V6 frozen-fixture semantics (packet …5d184b24): no authored status → honest derived word", () => {
    if (!hasHome()) return;
    executed.push("v6-frozen-semantics");
    // 冻结的 mission README（fixture/README.md sha 660068d4…）携带
    // stage/id/release 且无 `status:`——这些字节 authored 为 null
    //（daemon 侧 lockstep 测试绑定实际字节）。
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: RECENT })], NOW).state).toBe("active");
    expect(pms.reconcileMissionStatus(null, [slice({ lastActivityAt: STALE })], NOW).state).toBe("idle");
  });

  // t3——在 candidate，全部 Tier-B 用例必须已执行（silent-skip 围栏）。
  it("t3: all Tier-B cases executed at the candidate", () => {
    if (!hasHome()) return;
    expect(executed.sort()).toEqual([...TIER_B_CASES].sort());
  });
});

// ---------------------------------------------------------------------------
// TIER A——FR-4 bucket 差分 + V5 纯 carve（两端 static import，一条代码路径，
// candidate 预期逐字）
// ---------------------------------------------------------------------------

describe("Tier A — FR-4 bucket coherence (differential: named RED at base)", () => {
  it("an AUTHORED shipped mission buckets ARCHIVE regardless of slice recency", () => {
    const bucket = projectMissionBucket({
      id: "m",
      label: "m",
      status: "shipped",
      statusSource: "authored",
      slices: [slice({ lastActivityAt: RECENT, qitemCount: 2 })],
    } as Parameters<typeof projectMissionBucket>[0]);
    expect(bucket).toBe("archive");
  });

  it("partitionProjectMissions routes the authored-complete recent mission to archive", () => {
    const groups = [
      {
        id: "auth", label: "auth", status: "shipped", statusSource: "authored",
        slices: [slice({ lastActivityAt: RECENT })],
      },
      {
        id: "act", label: "act", status: "active", statusSource: "derived",
        slices: [slice({ lastActivityAt: RECENT })],
      },
    ] as Parameters<typeof partitionProjectMissions>[0];
    // 注入 fixture 时钟（NOW），使固定时间戳 RECENT slice 按其 authored 瞬时
    // 评估——非 wall-clock。无此差分随真实时间推进 27 天越过 36h 窗口而烂为
    // RED（被排除的 ui leg 一直隐藏到 F1 gap-1）。
    const { current, archive } = partitionProjectMissions(groups, NOW);
    expect(archive.map((m) => m.id)).toEqual(["auth"]);
    expect(current.map((m) => m.id)).toEqual(["act"]);
  });
});

// VM-005 定时炸弹 CLASS-KILL：recency 分桶必须跟随注入时钟，绝非 wall-clock。
// 一个固定时间戳 fixture 触达未注入的生产时间，随真实时间推进烂到错误 bucket——
// 正是 F1 已闭合 gap-1 暴露的失败。本锁证明接缝被遵守，故任何 fixed-clock 差分
// 可以（且必须）注入 `now` 并永远保持确定性。
describe("Tier A — clock-determinism guard (time-bomb class-kill)", () => {
  it("projectMissionBucket + partitionProjectMissions bucket by the injected now, not Date.now()", () => {
    const fixed = "2020-01-01T00:00:00.000Z"; // long-dead wall-clock: under real Date.now() ALWAYS archive
    const at = Date.parse(fixed);
    const m = {
      id: "m", label: "m", status: "active", statusSource: "derived",
      slices: [slice({ lastActivityAt: fixed })],
    } as Parameters<typeof projectMissionBucket>[0];
    // 注入 now 窗口内 -> current（若 fn 读 Date.now() 则会是 archive）。
    expect(projectMissionBucket(m, at + 60_000)).toBe("current");
    // 注入 now 窗口外 -> archive——与真实时间无关地确定。
    expect(projectMissionBucket(m, at + PROJECT_CURRENT_ACTIVITY_WINDOW_MS + 60_000)).toBe("archive");
    // partitionProjectMissions 端到端贯穿同一时钟。
    expect(partitionProjectMissions([m], at + 60_000).current.map((x) => x.id)).toEqual(["m"]);
    expect(partitionProjectMissions([m], at + PROJECT_CURRENT_ACTIVITY_WINDOW_MS + 60_000).archive.map((x) => x.id)).toEqual(["m"]);
  });
});

describe("Tier A — V5 bucket byte-identity (green at BOTH SHAs)", () => {
  it("derived groups keep today's ladder byte-for-byte", () => {
    const current = {
      id: "m", label: "m", status: "active", statusSource: "derived",
      slices: [slice({ lastActivityAt: new Date(Date.now() - 60_000).toISOString() })],
    } as Parameters<typeof projectMissionBucket>[0];
    const archived = {
      id: "m2", label: "m2", status: "shipped", statusSource: "derived",
      slices: [slice({ status: "done", lastActivityAt: STALE })],
    } as Parameters<typeof projectMissionBucket>[0];
    const empty = {
      id: "e", label: "e", status: "active", statusSource: "derived", slices: [],
    } as Parameters<typeof projectMissionBucket>[0];
    expect(projectMissionBucket(current)).toBe("current");
    expect(projectMissionBucket(archived)).toBe("archive");
    expect(projectMissionBucket(empty)).toBe("current"); // zero-slice non-shipped stays current
  });
});


describe("current proof readiness and retained declared state", () => {
  it("shows the served proof basis without promoting readiness to publication", () => {
    const row = projectSliceFromListEntry({ name: "one", displayName: "One", missionId: "trial", railItem: null, status: "done", rawStatus: "done", qitemCount: 0, hasProofPacket: true, lastActivityAt: null, readiness: { configured: true, state: "unknown", revision: "changed-evidence" } });
    expect(row.status).toBe("校验 未知");
    expect(reconcileMissionStatus("active", [row], NOW, { state: "unknown", revision: "changed-evidence", historicalStatus: "active" })).toMatchObject({ state: "active", label: "声明 active · 校验 未知" });
    expect(reconcileMissionStatus("active", [row], NOW, { state: "ready", revision: "accepted", historicalStatus: "active" })).toMatchObject({ state: "active", label: "声明 active · 校验 已就绪" });
  });
});
