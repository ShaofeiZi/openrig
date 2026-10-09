// 对现已在 main 的 SPEC.md 兼容性变更的修复。
//
// 三者都源于同一个错误：把 SPEC.md 放到列表最前，却没问该列表如何处理顺序。
// 在 first-match-wins 查找中，靠前意味着胜出。在 later-wins 合并中它意味着落败。
// 在全扫描循环中它意味着被遮蔽文件也被读到。同一行改动，三种不同含义。
//
// 此状态如今在本工作区三个节点上真实存在，故这些不是假设。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";

let root: string;
let db: Database.Database;
let slicesRoot: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-md-shadow-"));
  slicesRoot = path.join(root, "slices");
  fs.mkdirSync(slicesRoot, { recursive: true });
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema]);
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function slice(name: string, files: Record<string, string>): void {
  const dir = path.join(slicesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
}

const indexer = () => new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });

describe("Repair 1 — 选定的节点文件不会被隐藏的节点文件覆盖", () => {
  it("当过时的 README.md 声明相同字段时，采用 SPEC.md 值", () => {
    slice("01-conflict", {
      "SPEC.md": "---\nslice: 01-conflict\ntitle: from-SPEC\nstatus: spec\n---\n\n# t\n",
      "README.md": "---\nslice: 01-conflict\ntitle: from-README-STALE\nstatus: shipped\n---\n\n# t\n",
    });
    const got = indexer().get("01-conflict");
    expect(got!.displayName).toBe("from-SPEC");
    expect(got!.rawStatus).toBe("spec");
  });

  it("仍然让 PROGRESS.md 覆盖作为生命周期游标", () => {
    slice("02-progress", {
      "SPEC.md": "---\nslice: 02-progress\nstatus: spec\n---\n\n# t\n",
      "PROGRESS.md": "---\nstatus: shipped\n---\n\n# p\n",
    });
    expect(indexer().get("02-progress")!.rawStatus).toBe("shipped");
  });

  it("将 IMPLMENTATION-PRD.md 保留在节点文件下，与 README.md 下的完全相同", () => {
    slice("03-prd", {
      "IMPLEMENTATION-PRD.md": "---\nslice: 03-prd\ntitle: from-PRD\n---\n\n# t\n",
      "SPEC.md": "---\nslice: 03-prd\ntitle: from-SPEC\n---\n\n# t\n",
    });
    expect(indexer().get("03-prd")!.displayName).toBe("from-SPEC");
  });

  it("保留 README-only 切片原样", () => {
    slice("04-legacy", { "README.md": "---\nslice: 04-legacy\ntitle: legacy\nstatus: spec\n---\n\n# t\n" });
    expect(indexer().get("04-legacy")!.displayName).toBe("legacy");
  });
});

describe("Repair 2 — 阴影节点文件不再被扫描", () => {
  /** project() takes the indexed SliceRecord, not a name. */
  function acceptanceOf(name: string) {
    const idx = indexer();
    const record = idx.get(name);
    expect(record, `slice ${name} must index`).toBeTruthy();
    const projector = new SliceDetailProjector({ db, indexer: idx, workflowSpecCache: new WorkflowSpecCache(db) });
    return projector.project(record!).acceptance;
  }

  // POLLUTION, not duplication, is the observable form. Identical rows collapse under the existing
  // acceptance dedup, which is why an earlier version of this test passed against the defect. The
  // damage shows when the two files DISAGREE: the shadowed file's obligations leak in beside the
  // live ones, and the slice presents a contract its author never wrote.
  it("不接受来自影子 README.md 的接受行", () => {
    slice("01-both", {
      "SPEC.md": "---\nslice: 01-both\ntitle: from-SPEC\n---\n\n# s\n\n## Proof contract\n\n- [ ] The live obligation.\n",
      "README.md": "---\nslice: 01-both\ntitle: stale\n---\n\n# r\n\n## Proof contract\n\n- [ ] A STALE obligation nobody promised.\n",
    });

    const items = acceptanceOf("01-both").items;
    expect(items.some((i) => i.text.includes("The live obligation"))).toBe(true);
    expect(items.some((i) => i.text.includes("STALE obligation"))).toBe(false);
    // And every row that IS present cites the file it actually came from.
    for (const i of items) expect(i.source.file).not.toBe("README.md");
  });

  it("仍然折叠活动节点文件及其 PRD 都声明的行", () => {
    slice("03-dedup", {
      "SPEC.md": "---\nslice: 03-dedup\n---\n\n# s\n\n## Proof contract\n\n- [ ] Shared obligation.\n",
      "IMPLEMENTATION-PRD.md": "---\nslice: 03-dedup\n---\n\n# p\n\n## Proof contract\n\n- [ ] Shared obligation.\n",
    });
    const rows = acceptanceOf("03-dedup").items.filter((i) => i.text.includes("Shared obligation"));
    expect(rows.length).toBe(1);
  });

  it("仍然收集仅自述文件切片的接受行", () => {
    slice("02-legacy", { "README.md": "---\nslice: 02-legacy\n---\n\n# l\n\n## Proof contract\n\n- [ ] A legacy row.\n" });
    expect(acceptanceOf("02-legacy").items.some((i) => i.text.includes("A legacy row"))).toBe(true);
  });
});
