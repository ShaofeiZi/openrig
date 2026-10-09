// release-0.4.7 intent-stage/scaffold-projection——T5：具名 R3 分歧测试。共享
// scaffold-placeholder 语法的三个消费者都会读取同一个纯 placeholder fixture（由真实 CLI
// renderer 从模板生成的原始 `zrig scope slice create` 输出），且必须一致认定它不含已创作内容：
//   1. scope-audit（两个 twin，固定一致性）→ 触发 proof_contract_missing_or_malformed finding；
//   2. review compose → extractProofContract = []（promised 为空）；
//   3. slice-detail-projector → acceptance item = 0。
// audit-says-present / review-says-absent 是 seam map 的 R3 类；本测试让未来任何分歧成为
// CI 失败，而不是 dogfood finding。

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../src/domain/slices/slice-detail-projector.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { classifyScopeItem } from "../src/domain/scope/scope-audit.js";
import { extractProofContract } from "../src/domain/review/compose.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

let tpl: { readme: string; prd: string; progress: string };

beforeAll(async () => {
  const mod = await import(join(REPO_ROOT, "packages/cli/src/lib/scope/templates.ts"));
  const opts = {
    id: "OPR.T.97",
    slice_number: "97",
    slug: "crossread",
    mission: "release-t",
    title: "Crossread",
    created_date: "2026-07-11",
  };
  tpl = {
    readme: mod.renderSliceTemplate("placeholder", opts),
    prd: mod.renderImplementationPrdTemplate(opts),
    progress: mod.renderSliceProgressTemplate("Crossread"),
  };
});

describe("T5——三个 reader 之间的 shared-helper 一致性（已证明的 R3 固定点）", () => {
  let db: Database.Database;
  let cleanupRoot: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    cleanupRoot = mkdtempSync(join(tmpdir(), "scaffold-crossreader-"));
  });

  afterEach(() => {
    db.close();
    rmSync(cleanupRoot, { recursive: true, force: true });
  });

  it("audit + compose + acceptance 都把原始 fixture 读作不含已创作 deliverable", () => {
    // Reader 1——scope-audit：纯 placeholder PRD 会触发 contract-malformed finding（修复前
    // 保持静默：仅 checkbox 存在便被算作 contract）。
    const audit = classifyScopeItem({
      id: "OPR.T.97",
      path: "/fixture/97-crossread",
      readmeFrontmatterRaw: "id: OPR.T.97",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      readmeContent: tpl.readme,
      implementationPrdContent: tpl.prd,
    });
    expect(audit.findings.map((f) => f.kind)).toContain("proof_contract_missing_or_malformed");

    // Reader 2——review compose：promised = []（仅 placeholder）。
    expect(extractProofContract(tpl.prd)).toEqual([]);

    // Reader 3——slice-detail-projector：acceptance = 0 个 item。
    const slicesRoot = join(cleanupRoot, "slices");
    const dir = join(slicesRoot, "97-crossread");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), tpl.readme);
    writeFileSync(join(dir, "IMPLEMENTATION-PRD.md"), tpl.prd);
    writeFileSync(join(dir, "PROGRESS.md"), tpl.progress);
    const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db });
    const projector = new SliceDetailProjector({ db, indexer, workflowSpecCache: new WorkflowSpecCache(db) });
    const slice = indexer.get("97-crossread");
    expect(slice).toBeTruthy();
    expect(projector.project(slice!).acceptance.totalItems).toBe(0);
  });

  it("相同三个 reader 都能看到已创作 contract 行（正例也保持一致）", () => {
    const prd = tpl.prd.replace(
      /^##\s+(?:Proof contract|证明契约|证据约定)\s*$/m,
      "## 证明契约\n\n- [ ] 手机流程视频",
    );
    const audit = classifyScopeItem({
      id: "OPR.T.97",
      path: "/fixture/97-crossread",
      readmeFrontmatterRaw: "id: OPR.T.97",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      readmeContent: tpl.readme,
      implementationPrdContent: prd,
    });
    expect(audit.findings.map((f) => f.kind)).not.toContain("proof_contract_missing_or_malformed");
    expect(extractProofContract(prd).map((i) => i.text)).toEqual(["手机流程视频"]);
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 placeholder-suppression 完整性——T-A1（audit mini-reqs 分支学习合并语法）+
// T-A2（IF-3 括号语法修复：基线 b8c11535 的 RED 证明当前 audit-absent/review-present
// 分歧；变更后的 green 证明 audit 加入了 compose 已批准的语法——这是架构限定的预期变更披露，
// 不是回归）。
// ---------------------------------------------------------------------------

function auditFor(prd: string) {
  return classifyScopeItem({
    id: "OPR.T.96",
    path: "/fixture/96-minireqs",
    readmeFrontmatterRaw: "id: OPR.T.96",
    progressFileExists: true,
    readmeOnlyMarker: false,
    isActiveRelease: true,
    level: "slice",
    readmeContent: "# 96\n\n## Intent\n\nauthored\n",
    implementationPrdContent: prd,
  });
}

describe("T-A1——audit mini-reqs 分支只计算已创作的编号 item", () => {
  it("纯 placeholder mini-reqs → 触发 mini_requirements finding（此前：静默）", () => {
    const audit = auditFor(tpl.prd); // 原始模板：`1. [...]` placeholder + placeholder contract
    expect(audit.findings.map((f) => f.kind)).toContain("mini_requirements_missing_or_malformed");
  });

  it("已创作的点号形式 mini-reqs → 无 mini_requirements finding", () => {
    const prd = tpl.prd.replace(/^1\. \[.*\]$/m, "1. 一个真实可观察结果。");
    const audit = auditFor(prd);
    expect(audit.findings.map((f) => f.kind)).not.toContain("mini_requirements_missing_or_malformed");
  });
});

describe("T-A2——IF-3 修复：`1)` 括号形式的已创作 item——audit 加入 compose 语法", () => {
  it("括号形式的已创作 mini-reqs：audit finding 缺席，compose 读取为已创作（一致）", async () => {
    const prd = tpl.prd.replace(/^1\. \[.*\]$/m, "1) 一个真实可观察结果。");
    // Reader 1——audit：无 malformed finding（基线 RED：只识别点号的正则漏掉 `1)`）。
    const audit = auditFor(prd);
    expect(audit.findings.map((f) => f.kind)).not.toContain("mini_requirements_missing_or_malformed");
    // Reader 2——compose：通过同一共享语法得到 authored TRUE。
    const { extractMiniReqs, hasAuthoredMiniReqs } = await import("../src/domain/review/compose.js");
    expect(hasAuthoredMiniReqs(extractMiniReqs(prd))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PM dogfood #1（qitem-20260720015700-630eef64）——反向一致性：已创作 README section
// 优先于原始纯 scaffold PRD section，三个语法消费者保持一致。projector 分支断言 VM-006
// QA-verdict 提升（done:true、doneVia:"qa-verdict"）——判别点：仅 row 存在可通过当前 README
// 扫描；若 `promised` 只从原始 PRD 提取，则无法触发提升。
// ---------------------------------------------------------------------------

describe("PM dogfood #1——已创作 README + 原始 PRD：三个 reader 一致（修复前 RED）", () => {
  let db2: Database.Database;
  let root2: string;

  beforeEach(() => {
    db2 = createDb();
    migrate(db2, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      missionControlActionsSchema,
    ]);
    db2.prepare(`INSERT INTO rigs (id, name) VALUES ('r-2', 'rig')`).run();
    root2 = mkdtempSync(join(tmpdir(), "scaffold-crossreader-df1-"));
  });

  afterEach(() => {
    db2.close();
    rmSync(root2, { recursive: true, force: true });
  });

  function authoredReadme(): string {
    // 真实 renderer 输出，仅创作两个约定行——即 dogfood fixture 的形状（frontmatter 中
    // status 仍为 `placeholder`）。
    return tpl.readme
      .replace(/^1\. \[.*\]$/m, "1. 第一条已创作需求")
      .replace(/^- \[ \] \[.*\]$/m, "- [ ] 第一项已创作交付物");
  }

  const QA_ARTIFACT = [
    "---",
    "slice: 97-crossread",
    "candidate_sha: cafe1234",
    "artifact_type: qa",
    "verdict: PASS",
    'money_evidence: "已将渲染后的 UI 与已创作 contract 行比较"',
    "self_check: 已与已创作 contract 行比较",
    "evidences:",
    "  - 第一项已创作交付物",
    "---",
    "",
    "QA 已验证已创作交付物。",
  ].join("\n");

  it("reader 1——audit：已创作 README + 原始 PRD 不产生 convention finding", () => {
    const audit = classifyScopeItem({
      id: "OPR.T.97",
      path: "/fixture/97-crossread",
      readmeFrontmatterRaw: "id: OPR.T.97\nstatus: placeholder",
      progressFileExists: true,
      readmeOnlyMarker: false,
      isActiveRelease: true,
      level: "slice",
      readmeContent: authoredReadme(),
      implementationPrdContent: tpl.prd,
    });
    const kinds = audit.findings.map((f) => f.kind);
    expect(kinds).not.toContain("mini_requirements_missing_or_malformed");
    expect(kinds).not.toContain("proof_contract_missing_or_malformed");
  });

  it("reader 2——review compose：PLAN + DELIVERED 投影已创作 README section", async () => {
    const { composeSliceReview } = await import("../src/domain/review/compose.js");
    const r = composeSliceReview({
      slice: { name: "97-crossread", id: "OPR.T.97", title: "Crossread", missionId: "release-t" },
      readme: authoredReadme(),
      prd: tpl.prd,
      proofMd: null,
      artifacts: [],
      lockedArtifacts: [],
      mediaRefs: [],
      proofDirExists: false,
      attention: [],
      agents: [],
      activeQitemPresent: false,
      git: { mainTip: "tip99999", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 0 },
      approval: { spec: null, delivery: null },
      nowIso: "2026-07-20T00:00:00.000Z",
    });
    expect(r.plan.concise.text).not.toBeNull(); // 修复前 RED：无投影
    expect(r.plan.concise.text!).toContain("第一条已创作需求");
    expect(r.delivered.items.map((i) => i.promised.text)).toEqual(["第一项已创作交付物"]);
  });

  it("reader 3——slice-detail-projector：README 已创作 contract 行在匹配 QA PASS 时提升（done:true、doneVia:'qa-verdict'）", () => {
    const slicesRoot = join(root2, "slices");
    const dir = join(slicesRoot, "97-crossread");
    mkdirSync(join(dir, "proof"), { recursive: true });
    writeFileSync(join(dir, "README.md"), authoredReadme());
    writeFileSync(join(dir, "IMPLEMENTATION-PRD.md"), tpl.prd);
    writeFileSync(join(dir, "PROGRESS.md"), tpl.progress);
    writeFileSync(join(dir, "proof", "qa-verify.md"), QA_ARTIFACT);
    const indexer = new SliceIndexer({ slicesRoot, dogfoodEvidenceRoot: null, db: db2 });
    const projector = new SliceDetailProjector({ db: db2, indexer, workflowSpecCache: new WorkflowSpecCache(db2) });
    const slice = indexer.get("97-crossread");
    expect(slice).toBeTruthy();
    const row = projector.project(slice!).acceptance.items.find((i) => i.text === "第一项已创作交付物");
    expect(row, "README 中已创作的 contract 行必须显示为 acceptance item").toBeTruthy();
    // 判别点：QA-verdict 提升要求 `promised` 携带 README 中已创作的 contract item；
    // 若只从 PRD 提取则不可能做到。
    expect(row!.done).toBe(true);
    expect(row!.doneVia).toBe("qa-verdict");
  });
});
