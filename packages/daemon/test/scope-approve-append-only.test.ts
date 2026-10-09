// P15——WRITER-EXCEEDS-ITS-OWNERSHIP 修复（PM ruling，在 51-08 lock-verify 发现）：approve
// stamp 是自身 key 的唯一 writer，却重新序列化整个 frontmatter block（YAML.parse -> merge ->
// YAML.stringify），从而使它所认证的 seal 失效——seal-then-lock 从结构上损坏。append-only stamping
// 会逐字保留 writer 不拥有的每个 byte。RED-first：关键 pin 会在 full-block rewriter 上失败。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { ScopeApproveService } from "../src/domain/scope/scope-approve.js";

// 51-08 drift-instance shape：folded scalar、quoted string、无 tab 的刻意 spacing、包含
// metacharacter 的 value（$、backref、regex char）——re-serializer 会 normalize、naive replacement
// 会破坏的所有内容。
const DRIFT_README = `---
id: OPR.0.5.1.8
slice: 51-08-token-telemetry-over-time
mission: release-0.5.1
status: spec
verified: >-
  2026-08-07 against scaffold (rig scope create) + the desk pin
  "062+ sequencing" — $VAR and \\1 backrefs ride along
created: 2026-08-07
tags: ["a b", 'c,d']
---

# Slice 51-08 — Per-agent token telemetry over time

## Intent

Body text with --- inside prose stays untouched.

## Proof contract

- [ ] One item — captured.
`;

const PRD = `---
id: OPR.0.5.1.8
---

## Mini-requirements

1. It works.

## Proof contract

- [ ] One item — captured.
`;

describe("P15——append-only approve stamping（writer-exceeds-its-ownership 修复）", () => {
  let db: Database.Database;
  let actionLog: MissionControlActionLog;
  let missionsRoot: string;
  let sliceDir: string;
  let readmePath: string;

  function service(): ScopeApproveService {
    return new ScopeApproveService({
      missionsRoot: () => missionsRoot,
      actionLog,
      now: () => new Date("2026-08-07T08:36:50.598Z"),
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    actionLog = new MissionControlActionLog(db);
    missionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p15-"));
    sliceDir = path.join(missionsRoot, "release-0.5.1", "slices", "51-08-token-telemetry-over-time");
    fs.mkdirSync(sliceDir, { recursive: true });
    readmePath = path.join(sliceDir, "README.md");
    fs.writeFileSync(readmePath, DRIFT_README);
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), PRD);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(missionsRoot, { recursive: true, force: true });
  });

  const specInput = {
    scopeTier: "slice" as const,
    scopePath: "release-0.5.1/slices/51-08-token-telemetry-over-time",
    approvalScope: "spec" as const,
    actorSession: "dev50-planner@v-openrig-build",
  };

  /** 仅按文本移除 writer-owned 行：approved-spec stamp 对与 plan-lock 的 locked-artifacts block
   *  （一个 top-level key + 其缩进 continuation line）。不移除其他内容。 */
  function stripOwned(content: string): string {
    return content
      .replace(/^approved-spec-by:[^\n]*\n/m, "")
      .replace(/^approved-spec-at:[^\n]*\n/m, "")
      .replace(/^locked-artifacts:[^\n]*\n(?:[ \t]+[^\n]*\n)*/m, "");
  }

  /** 用 prior generation 替换 current writer-owned generation。restamp 不等于“strip to
   *  author-pure”：generation N 之后的 amendment，其 pre-restamp byte 中本就包含 generation N。
   *  prior artifact 是这些精确 block 的来源；此 helper 只执行机械 current -> prior 替换。 */
  function restoreOwnedGeneration(current: string, prior: string): string {
    const keys = [
      "approved-spec-by",
      "approved-spec-at",
      "approved-spec-priors",
      "locked-artifacts",
      "provenance",
    ];
    const block = (content: string, key: string): string | null => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escaped}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, "m").exec(content)?.[0] ?? null;
    };
    let restored = current;
    for (const key of keys) {
      const now = block(restored, key);
      const before = block(prior, key);
      if (now && before) restored = restored.slice(0, restored.indexOf(now)) + before + restored.slice(restored.indexOf(now) + now.length);
      else if (now) restored = restored.slice(0, restored.indexOf(now)) + restored.slice(restored.indexOf(now) + now.length + (restored[restored.indexOf(now) + now.length] === "\n" ? 1 : 0));
    }
    return restored;
  }

  it("关键场景（51-08 instance）：stamp -> strip-owned-lines -> 与 pre-stamp 文件逐字一致", () => {
    const before = fs.readFileSync(readmePath, "utf8");
    service().approve(specInput);
    const after = fs.readFileSync(readmePath, "utf8");
    expect(after).not.toBe(before); // stamp 确实落盘
    expect(stripOwned(after)).toBe(before); // 且未触碰任何不属于它的内容
  });

  it("stamped 文件解析为 merged view：reader 不变、folded scalar 逐字保留、Lever A 落盘", () => {
    service().approve(specInput);
    const after = fs.readFileSync(readmePath, "utf8");
    const fm = YAML.parse(/^---\s*\n([\s\S]*?)\n---/.exec(after)![1]!) as Record<string, unknown>;
    expect(fm["approved-spec-by"]).toBe("dev50-planner@v-openrig-build");
    expect(fm["approved-spec-at"]).toBe("2026-08-07T08:36:50.598Z");
    expect(fm["id"]).toBe("OPR.0.5.1.8");
    expect(String(fm["verified"])).toContain("$VAR"); // survived byte-verbatim, still parseable
    expect(Array.isArray(fm["locked-artifacts"])).toBe(true); // the plan-lock co-write still lands
    expect(after).toContain('tags: ["a b", \'c,d\']'); // quoting style untouched
  });

  it("re-approve 只原位替换自身 key：strip-owned 后仍恢复原始 byte", () => {
    const before = fs.readFileSync(readmePath, "utf8");
    service().approve(specInput);
    service().approve({ ...specInput, reApprove: true, reason: "amended after review" } as never);
    const after = fs.readFileSync(readmePath, "utf8");
    const fm = YAML.parse(/^---\s*\n([\s\S]*?)\n---/.exec(after)![1]!) as Record<string, unknown>;
    expect(fm["approved-spec-priors"]).toBe(1);
    const stripped = stripOwned(after).replace(/^approved-spec-priors:[^\n]*\n/m, "");
    expect(stripped).toBe(before);
  });

  it("S08 amendment cycle：current stamp generation 可机械恢复 prior generation，包括 locked-artifacts.name", () => {
    service().approve({ ...specInput, lockedArtifacts: ["README.md"] });
    const firstGeneration = fs.readFileSync(readmePath, "utf8");
    expect(firstGeneration).toContain("locked-artifacts:\n  - name: README.md");

    // amendment 发生在首次 stamp 之后，因此其 pre-restamp byte 有意包含 generation 0。重新批准
    // 会重新派生 lock，并将 nested name 从显式 path 改成面向 reader 的 label。
    const amendedBeforeRestamp = firstGeneration.replace(
      "Body text with --- inside prose stays untouched.",
      "Body text amended after generation zero stays untouched.",
    );
    fs.writeFileSync(readmePath, amendedBeforeRestamp);
    service().approve({
      ...specInput,
      actorSession: "orch-advisor@v-openrig-build",
      reApprove: true,
      reason: "amended after generation zero",
    });
    const secondGeneration = fs.readFileSync(readmePath, "utf8");
    expect(secondGeneration).toContain("locked-artifacts:\n  - name: 旧版规格");

    expect(restoreOwnedGeneration(secondGeneration, amendedBeforeRestamp)).toBe(amendedBeforeRestamp);
  });

  it("已 spec-stamped 文件上的 delivery approve 也保持 append-only（两个 writer，零 drift）", () => {
    service().approve(specInput);
    const afterSpec = fs.readFileSync(readmePath, "utf8");
    service().approve({ ...specInput, approvalScope: "delivery" as const, actorSession: "dev50-qa@v-openrig-build" });
    const after = fs.readFileSync(readmePath, "utf8");
    const strippedDelivery = after
      .replace(/^approved-by:[^\n]*\n/m, "")
      .replace(/^approved-at:[^\n]*\n/m, "");
    expect(strippedDelivery).toBe(afterSpec);
  });
});
