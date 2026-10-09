// VM-005（release-0.4.7）——daemon 段，按 B3 差分裁定组织
//（plan v1.3 §D-bis；ARCH-RULING-b3，sha 632ff319…）：
//
// Tier A（两端表面、单代码路径，候选期望逐字）：mapStatus `placeholder`→draft
//（在 base 处命名为 RED：期望 'active' 为 'draft'）· terminal-default-unchanged
//（两端绿）· SliceListEntry key-set carve（两端绿）。
//
// Tier B（新符号单元，t1/t2/t3）：sidecar 方法 + 与
// routes/missions.ts readMissionStatus 的 LOCKSTEP——t1 存在性断言无条件
// and FIRST (the counted named RED at base), cases conditional, t3
// executed-count pin at the candidate.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
// NOTE: readMissionStatus is imported DYNAMICALLY in Tier B — its export is
// candidate-only (the export-keyword visibility change rides the impl SHA,
// which the RED leg keeps in place; dynamic access keeps this file one-path).

// The V6 frozen mission README frontmatter — byte-bound from the dogfood
// evidence root (fixture/README.md sha256 660068d4…e688262, packet
// V6-FROZEN-FIXTURE-PACKET-5d184b24.md sha256 274a24f9…04d1ed): a canonical
// WIP mission that declares stage/id/release and NO `status:` field.
const V6_FROZEN_README = `---
id: OPR.0.4.7
mission: release-0.4.7
release: 0.4.7
stage: wip
verified: 2026-07-10 against scaffold (rig scope create)
created: 2026-07-10
---

# Release 0.4.7 — Release 0.4.7

## Theme

[What this release is about — the coherent bet]
`;

let base: string;
let db: Database.Database;

function missionsRoot(): string {
  return path.join(base, "missions");
}

function writeMission(name: string, readme: string | null, slices: Record<string, string>): void {
  const dir = path.join(missionsRoot(), name);
  fs.mkdirSync(path.join(dir, "slices"), { recursive: true });
  if (readme !== null) fs.writeFileSync(path.join(dir, "README.md"), readme);
  for (const [sliceName, frontmatter] of Object.entries(slices)) {
    const sliceDir = path.join(dir, "slices", sliceName);
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "README.md"), frontmatter);
  }
}

function makeIndexer(): SliceIndexer {
  return new SliceIndexer({
    slicesRoot: missionsRoot(),
    dogfoodEvidenceRoot: null,
    db,
  });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "mission-status-sidecar-"));
  fs.mkdirSync(missionsRoot(), { recursive: true });
  db = createDb(":memory:");
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
});

afterEach(() => {
  db.close();
  fs.rmSync(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TIER A — both-ends differentials + carves
// ---------------------------------------------------------------------------

describe("A 层 — mapStatus 脚手架文字（C-vi、FR-3）：差异", () => {
  it("status: placeholder 被分类为 draft，而不是末端默认 active", () => {
    writeMission("scaffolded", V6_FROZEN_README, {
      "fresh-slice": "---\nstatus: placeholder\n---\n# Fresh\n",
    });
    const entries = makeIndexer().list();
    const fresh = entries.find((e) => e.name === "fresh-slice");
    expect(fresh?.status).toBe("draft");
    expect(fresh?.rawStatus).toBe("placeholder");
  });
});

describe("A 层 — 回归雕刻（两个 SHA 均为绿色）", () => {
  it("终端默认保持不变：无法识别的单词仍然映射为活动状态（命名为后续）", () => {
    writeMission("m2", null, {
      "odd-slice": "---\nstatus: percolating\n---\n# Odd\n",
    });
    const entries = makeIndexer().list();
    expect(entries.find((e) => e.name === "odd-slice")?.status).toBe("active");
  });

  it("SliceListEntry 形状未受影响 - sidecar 是附加的（固定键集）", () => {
    writeMission("m3", "---\nstatus: complete\n---\n", { s9: "---\nstatus: active\n---\n# S9\n" });
    const entries = makeIndexer().list();
    const entry = entries.find((e) => e.name === "s9")!;
    expect(Object.keys(entry).sort()).toEqual(
      [
        "name",
        "missionId",
        "displayName",
        "railItem",
        "workflowSpec",
        "status",
        "rawStatus",
        "description",
        "qitemCount",
        "hasProofPacket",
        "lastActivityAt",
        "slicePath",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// TIER B — the sidecar + lockstep (t1/t2/t3)
// ---------------------------------------------------------------------------

const executed: string[] = [];
const TIER_B_CASES = [
  "sidecar-authored-word",
  "sidecar-v6-frozen-null",
  "sidecar-population",
  "sidecar-cache-invalidate",
  "lockstep-agreement",
] as const;

describe("B 层 — MissionAuthoredStatuses sidecar（t1 存在优先）", () => {
  // t1 — UNCONDITIONAL, FIRST: the counted named RED at base.
  it("t1：索引器上存在 sidecar 方法", () => {
    const indexer = makeIndexer() as unknown as Record<string, unknown>;
    expect(typeof indexer["missionAuthoredStatuses"]).toBe("function");
  });

  // t2 (B3 ruling, arch sha 632ff319…): the cases below are conditional only
  // because the sidecar does not exist at base; NO DIFFERENTIAL VECTOR may
  // ever move inside this conditional block — differentials live in Tier A.
  const hasSidecar = () =>
    typeof (makeIndexer() as unknown as Record<string, unknown>)["missionAuthoredStatuses"] ===
    "function";

  it("带有具有自述文件状态的任务的原始创作词", () => {
    if (!hasSidecar()) return;
    executed.push("sidecar-authored-word");
    writeMission("relx", "---\nstatus: complete\n---\n# Relx\n", {
      target: "---\nstatus: active\n---\n# Target\n",
    });
    expect(makeIndexer().missionAuthoredStatuses()["relx"]).toEqual({ authoredStatus: "complete" });
  });

  it("V6 冻结字节（数据包 …5d184b24）：stage/wip frontmatter 无 status 字段时返回 null", () => {
    if (!hasSidecar()) return;
    executed.push("sidecar-v6-frozen-null");
    writeMission("release-0.4.7", V6_FROZEN_README, {
      "some-slice": "---\nstatus: active\n---\n# S\n",
    });
    expect(makeIndexer().missionAuthoredStatuses()["release-0.4.7"]).toEqual({ authoredStatus: null });
  });

  it("缺少自述文件 → null；零索引切片任务永远不会出现", () => {
    if (!hasSidecar()) return;
    executed.push("sidecar-population");
    writeMission("no-readme", null, { s1: "---\nstatus: active\n---\n" });
    writeMission("zero-slices", "---\nstatus: complete\n---\n", {});
    const sidecar = makeIndexer().missionAuthoredStatuses();
    expect(sidecar["no-readme"]).toEqual({ authoredStatus: null });
    expect("zero-slices" in sidecar).toBe(false);
  });

  it("invalidate() 会删除 sidecar 缓存（刷新后会出现状态编辑）", () => {
    if (!hasSidecar()) return;
    executed.push("sidecar-cache-invalidate");
    writeMission("m", "---\nstatus: active\n---\n", { s1: "---\nstatus: active\n---\n" });
    const indexer = makeIndexer();
    expect(indexer.missionAuthoredStatuses()["m"]).toEqual({ authoredStatus: "active" });
    fs.writeFileSync(path.join(missionsRoot(), "m", "README.md"), "---\nstatus: complete\n---\n");
    expect(indexer.missionAuthoredStatuses()["m"]).toEqual({ authoredStatus: "active" });
    indexer.invalidate();
    expect(indexer.missionAuthoredStatuses()["m"]).toEqual({ authoredStatus: "complete" });
  });

  it("LOCKSTEP：在每个fixture类上，边车读取 == paths/missions.ts readMissionStatus", async () => {
    if (!hasSidecar()) return;
    executed.push("lockstep-agreement");
    const missionsRoute = (await import("../src/routes/missions.js")) as unknown as Record<
      string,
      unknown
    >;
    const readMissionStatus = missionsRoute["readMissionStatus"] as (p: string) => string | null;
    expect(typeof readMissionStatus).toBe("function");
    writeMission("with-status", "---\nstatus: complete\n---\n# M\n", { s1: "---\nstatus: active\n---\n" });
    writeMission("v6-frozen", V6_FROZEN_README, { s2: "---\nstatus: active\n---\n" });
    writeMission("empty-value", "---\nstatus:\ntitle: x\n---\n# M\n", { s3: "---\nstatus: active\n---\n" });
    writeMission("no-readme2", null, { s4: "---\nstatus: active\n---\n" });
    const sidecar = makeIndexer().missionAuthoredStatuses();
    for (const mission of ["with-status", "v6-frozen", "empty-value", "no-readme2"]) {
      const routeValue = readMissionStatus(path.join(missionsRoot(), mission));
      expect(sidecar[mission]?.authoredStatus ?? null).toBe(routeValue);
    }
  });

  // t3 — at the candidate, ALL Tier-B cases must have executed.
  it("t3：在候选者处执行的所有 B 级案例", () => {
    if (!hasSidecar()) return;
    expect(executed.sort()).toEqual([...TIER_B_CASES].sort());
  });
});
