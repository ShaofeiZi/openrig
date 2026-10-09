// OPR.0.4.4.19 FR-9——scope approve：frontmatter 唯一 writer + 仅追加 audit 行。包含 plan-review
// QA guardrail：audit 写入失败绝不能留下被信任的半 stamp（恢复 frontmatter，显著报错），且绝不删除
// audit 行（arch-lead 顺序钉扎）。

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
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { ScopeApproveError, ScopeApproveService } from "../src/domain/scope/scope-approve.js";
// Stage-3 Lever A（REV4 348f84f3 §4/§6）——gather+compose render-parity RED 在 fixture slice
// 上驱动已发布 ReviewGatherer/composer；镜像已证明的 review-freeze 构造
//（schema + SliceIndexer + writeFixtureSlice）。
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { makeFixtureWorkspace, writeFixtureSlice } from "./review-fixtures.js";

describe("ScopeApproveService (OPR.0.4.4.19 FR-9)", () => {
  let db: Database.Database;
  let actionLog: MissionControlActionLog;
  let auditBrowse: MissionControlAuditBrowse;
  let missionsRoot: string;
  let sliceDir: string;
  let readmePath: string;

  function service(overrides?: { actionLog?: MissionControlActionLog }): ScopeApproveService {
    return new ScopeApproveService({
      missionsRoot: () => missionsRoot,
      actionLog: overrides?.actionLog ?? actionLog,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    actionLog = new MissionControlActionLog(db);
    auditBrowse = new MissionControlAuditBrowse(db);
    missionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-approve-"));
    sliceDir = path.join(missionsRoot, "release-x", "slices", "19-signal-layer");
    fs.mkdirSync(sliceDir, { recursive: true });
    readmePath = path.join(sliceDir, "SPEC.md");
    fs.writeFileSync(readmePath, "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\nbody prose stays intact\n");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(missionsRoot, { recursive: true, force: true });
  });

  function frontmatterOf(p: string): Record<string, unknown> {
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(fs.readFileSync(p, "utf8"));
    return m ? (YAML.parse(m[1]!) as Record<string, unknown>) : {};
  }

  const baseInput = {
    scopeTier: "slice" as const,
    scopePath: "release-x/slices/19-signal-layer",
    approvalScope: "delivery" as const,
    actorSession: "human-review@kernel",
  };

  it("delivery approve 在一次操作中同时写入 approved-by/-at 和符合锁定 target 契约的 audit 行", () => {
    const result = service().approve(baseInput);
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-by"]).toBe("human-review@kernel");
    expect(typeof fm["approved-at"]).toBe("string");
    // Body prose 保持不变。
    expect(fs.readFileSync(readmePath, "utf8")).toContain("body prose stays intact");
    // audit 行携带锁定结构。
    const rows = auditBrowse.query({ scopeId: "OPR.X.19" }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actionVerb).toBe("approve");
    expect(rows[0]!.actorSession).toBe("human-review@kernel");
    expect(rows[0]!.qitemId).toBeNull();
    expect(rows[0]!.auditNotes).toMatchObject({
      kind: "scope-approval",
      scope_tier: "slice",
      scope_id: "OPR.X.19",
      scope_path: "release-x/slices/19-signal-layer",
      approval_scope: "delivery",
      on_behalf_of: null,
    });
    expect(result.freezeFired).toBe(false);
  });

  it("按 scope target + approver + approval scope 单次查询，恰好返回匹配行", () => {
    seedAuthoredSpec();
    service().approve({ ...baseInput, approvalScope: "spec" });
    service().approve(baseInput);
    // 无关 action 噪声。
    actionLog.record({
      actionVerb: "annotate",
      qitemId: null,
      actorSession: "a@r",
      actedAt: new Date().toISOString(),
      annotation: "n",
    });
    const rows = auditBrowse.query({
      scopeTier: "slice",
      scopeId: "OPR.X.19",
      scopePath: "release-x/slices/19-signal-layer",
      approvalScope: "delivery",
      actorSession: "human-review@kernel",
    }).rows;
    expect(rows).toHaveLength(1);
    expect((rows[0]!.auditNotes as Record<string, unknown>).approval_scope).toBe("delivery");
  });

  it("手工编辑的 frontmatter 无匹配 audit 行时，交叉检查查询为空（UNVERIFIED-stamp 信号）", () => {
    fs.writeFileSync(readmePath, "---\nid: OPR.X.19\napproved-by: forged@nowhere\napproved-at: 2026-07-04T00:00:00Z\n---\n# s\n");
    const rows = auditBrowse.query({ scopeTier: "slice", scopeId: "OPR.X.19" }).rows;
    expect(rows).toHaveLength(0); // detectable from stored data alone
  });

  it("分阶段：--scope spec 写 approved-spec-by/-at 和 approval_scope=spec；后续 delivery 属常规阶段序列而非重新盖章", () => {
    seedAuthoredSpec();
    service().approve({ ...baseInput, approvalScope: "spec", actorSession: "pm-lead@openrig-pm" });
    let fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-by"]).toBe("pm-lead@openrig-pm");
    expect(fm["approved-by"]).toBeUndefined();
    // Delivery stamp 独立落地。
    service().approve(baseInput);
    fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-by"]).toBe("pm-lead@openrig-pm");
    expect(fm["approved-by"]).toBe("human-review@kernel");
    const spec = auditBrowse.query({ scopeId: "OPR.X.19", approvalScope: "spec" }).rows;
    const delivery = auditBrowse.query({ scopeId: "OPR.X.19", approvalScope: "delivery" }).rows;
    expect(spec).toHaveLength(1);
    expect(delivery).toHaveLength(1);
  });

  it("在同一 scope 重新 approve 会显著失败并点名现有 stamp", () => {
    service().approve(baseInput);
    expect(() => service().approve(baseInput)).toThrow(/已有 delivery approval stamp/);
    try {
      service().approve(baseInput);
    } catch (err) {
      expect((err as ScopeApproveError).code).toBe("already_approved");
    }
    // 只有一条 audit 行。
    expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(1);
  });

  it("委托：--on-behalf-of 保持真实调用 session 为 actor；delegation 存于 audit notes", () => {
    service().approve({ ...baseInput, actorSession: "orch-advisor@openrig-delivery", onBehalfOf: "founder" });
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-by"]).toBe("orch-advisor@openrig-delivery"); // honest provenance
    const rows = auditBrowse.query({ scopeId: "OPR.X.19" }).rows;
    expect(rows[0]!.actorSession).toBe("orch-advisor@openrig-delivery");
    expect((rows[0]!.auditNotes as Record<string, unknown>).on_behalf_of).toBe("founder");
    expect(rows[0]!.reason).toContain("on behalf of founder");
  });

  it("mission-tier approve 具有相同语义", () => {
    const missionReadme = path.join(missionsRoot, "release-x", "README.md");
    fs.writeFileSync(missionReadme, "---\nid: OPR.X\n---\n# mission\n");
    service().approve({ scopeTier: "mission", scopePath: "release-x", approvalScope: "delivery", actorSession: "human@kernel" });
    expect(frontmatterOf(missionReadme)["approved-by"]).toBe("human@kernel");
    const rows = auditBrowse.query({ scopeTier: "mission", scopeId: "OPR.X" }).rows;
    expect(rows).toHaveLength(1);
  });

  it("QA GUARDRAIL：audit 写入失败会恢复先前 frontmatter 并显著失败——无可信半 stamp，也不删除 audit 行", () => {
    const failingLog = {
      record: () => { throw new Error("disk full"); },
    } as unknown as MissionControlActionLog;
    const before = fs.readFileSync(readmePath, "utf8");
    expect(() => service({ actionLog: failingLog }).approve(baseInput)).toThrow(/无半 stamp/);
    // Frontmatter 按字节恢复。
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before);
    expect(frontmatterOf(readmePath)["approved-by"]).toBeUndefined();
    // 失败路径从未写入（或删除）audit 行。
    expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(0);
  });

  it("守卫：路径逃逸、缺少 README、缺少 dot-ID", () => {
    expect(() => service().approve({ ...baseInput, scopePath: "../../etc" })).toThrow(ScopeApproveError);
    expect(() => service().approve({ ...baseInput, scopePath: "release-x/slices/nope" })).toThrow(/不是已声明的 slice/);
    fs.writeFileSync(readmePath, "---\nstatus: building\n---\n# no id\n");
    expect(() => service().approve(baseInput)).toThrow(/没有 frontmatter id/);
  });

  // ===================================================================
  // STAGE-3 LEVER A——plan-lock snapshot（收集 RED + gate GREEN 钉扎）
  // REV4 348f84f3 §4/§6。仅测试：RED-1..5 因 `locked-artifacts` 缺席（plan-lock writer 尚未构建）
  // 而失败；writer 在单独的 Guard-gated GREEN dispatch 落地后，它们转为回归钉扎。每条断言都通过
  // 已发布 ScopeApproveService + gather/compose 运行，不 import 尚未构建的模块。配套 GREEN 钉扎在
  // writer 前后均成立（它们锁定 gate）。预期结构按 §3 派生编写（SPEC → 所选 proof-contract
  // plannedRef → intent visual；规范化路径去重；排除 escape/N-A）。
  // ===================================================================

  const specInput = { ...baseInput, approvalScope: "spec" as const, actorSession: "pm-lead@openrig-pm" };

  // B14——spec approval 拒绝无内容的派生集合，因此以“普通 spec approve 成功”为前提的测试会准备
  // 一份最低限度已编写的当前 SPEC。
  function seedAuthoredSpec(): void {
    fs.writeFileSync(readmePath, "---\nid: OPR.X.19\nstatus: building\n---\n\n# Spec\n\nauthored requirement prose\n");
  }

  function approveErrCode(fn: () => unknown): string | null {
    try { fn(); return null; } catch (e) { return e instanceof ScopeApproveError ? e.code : String(e); }
  }
  const lockedOf = (p: string) => frontmatterOf(p)["locked-artifacts"] as Array<Record<string, unknown>> | undefined;
const SPEC = { name: "规格", path: "SPEC.md", kind: "spec" };

  it("slice-spec 按顺序锁定当前 SPEC、proof-contract mockup 和 intent visual", () => {
    fs.writeFileSync(
      readmePath,
      "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\n\n## Intent visual\n\n![the landing](mockups/landing.png)\n\n## Proof contract\n\n- [ ] drawer opens ![drawer](mockups/drawer.png)\n- [ ] row hit target ![row](mockups/row.png)\n",
    );
    service().approve(specInput);
    const locked = lockedOf(readmePath);
    expect(locked).toBeDefined();
    expect(locked).toEqual([
      SPEC,
      { name: "drawer opens", path: "mockups/drawer.png", kind: "mockup" },
      { name: "row hit target", path: "mockups/row.png", kind: "mockup" },
      { name: "mockups/landing.png", path: "mockups/landing.png", kind: "mockup" },
    ]);
  });

  it("RED-2 compose parity：已写入 slice 经 gather+compose 渲染精确有序的 plan.lockedArtifacts（失败：空）", () => {
    const ws = makeFixtureWorkspace();
    const gdb = createDb();
    try {
      migrate(gdb, [coreSchema, eventsSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema, queueItemSummarySchema]);
      writeFixtureSlice(ws, "release-y", "20-plan", {
        id: "OPR.Y.20",
        intent: "founder words",
        prd: { proofContract: ["drawer opens ![drawer](mockups/drawer.png)"] },
      });
      const fixtureDir = path.join(ws.root, "release-y", "slices", "20-plan");
      fs.renameSync(path.join(fixtureDir, "README.md"), path.join(fixtureDir, "SPEC.md"));
      new ScopeApproveService({ missionsRoot: () => ws.root, actionLog: new MissionControlActionLog(gdb) })
        .approve({ scopeTier: "slice", scopePath: "release-y/slices/20-plan", approvalScope: "spec", actorSession: "pm-lead@openrig-pm" });
      const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db: gdb });
      const gatherer = new ReviewGatherer({ db: gdb, indexer, gitRepoPath: null, now: () => "2026-07-23T00:00:00.000Z" });
      const composed = gatherer.composeSlice("20-plan");
      expect(composed).not.toBeNull();
      const locked = composed!.plan.lockedArtifacts;
      expect(locked.length).toBeGreaterThan(0); // <-- RED: empty (approve wrote no locked-artifacts)
      // intent 位于 `## Intent`（而非 `## Intent visual`），因此只有 SPEC + proof-contract mockup。
      expect(locked).toEqual([SPEC, { name: "drawer opens", path: "mockups/drawer.png", kind: "mockup" }]);
    } finally {
      gdb.close();
      fs.rmSync(ws.root, { recursive: true, force: true });
    }
  });

  it("没有 mockup 的当前 SPEC 锁定精确 singleton SPEC", () => {
    seedAuthoredSpec();
    service().approve(specInput);
    const locked = lockedOf(readmePath);
    expect(locked).toEqual([SPEC]);
  });

  // B14——无内容场景下，旧 Guard #4“fail-open singleton”行为已退役：两个 live lock 曾冻结无人选择
  // 的 placeholder 集。现在，如果 plan-lock 派生集合只有当前 SPEC，且该文件无内容/为脚手架，则会
  // 带教学信息拒绝。
  it("B14：拒绝无内容的 SPEC singleton（plan_lock_contentless）", () => {
    fs.writeFileSync(readmePath, "---\nid: OPR.X.19\n---\n\n# Spec\n");
    expect(approveErrCode(() => service().approve(specInput))).toBe("plan_lock_contentless");
    expect(frontmatterOf(readmePath)["approved-spec-by"]).toBeUndefined();
    expect(lockedOf(readmePath)).toBeUndefined();
  });

  it("B14：拒绝未修改的脚手架 SPEC singleton（标题、注释、方括号 placeholder 不算已编写内容）", () => {
    fs.writeFileSync(
      readmePath,
      "---\nid: OPR.X.19\nstatus: intent\n---\n\n<!-- ELASTIC MIDDLE guidance -->\n\n# Slice 19\n\n## Intent\n\n[The recorded intent, verbatim.]\n\n## Mini-requirements\n\n1. [The concise one-glance requirement tier.]\n\n## Proof contract\n\n- [ ] [One promised deliverable.]\n",
    );
    expect(approveErrCode(() => service().approve(specInput))).toBe("plan_lock_contentless");
    expect(frontmatterOf(readmePath)["approved-spec-by"]).toBeUndefined();
  });

  it("B14：显式 lockedArtifacts 集合完全替代派生", () => {
    fs.writeFileSync(
      readmePath,
      "---\nid: OPR.X.19\nstatus: intent\n---\n\n## Intent\n\n[placeholder]\n",
    );
    const specPath = path.join(sliceDir, "SPEC.md");
    fs.writeFileSync(path.join(sliceDir, "PLAN-x.md"), "the grounded plan\n");
    service().approve({ ...specInput, lockedArtifacts: ["PLAN-x.md", "SPEC.md"] });
    expect(frontmatterOf(specPath)["approved-spec-by"]).toBe("pm-lead@openrig-pm");
    expect(lockedOf(specPath)).toEqual([
      { name: "PLAN-x.md", path: "PLAN-x.md", kind: "spec" },
      { name: "SPEC.md", path: "SPEC.md", kind: "spec" },
    ]);
  });

  it("B14：显式集合点名缺失文件时拒绝（locked_artifact_missing）——选定集合必须指向真实文件", () => {
    expect(approveErrCode(() => service().approve({ ...specInput, lockedArtifacts: ["PLAN-missing.md"] })))
      .toBe("locked_artifact_missing");
    expect(frontmatterOf(readmePath)["approved-spec-by"]).toBeUndefined();
  });

  it("B14：显式集合拒绝 URI scheme、绝对路径与逃逸路径（locked_artifact_invalid）", () => {
    fs.writeFileSync(path.join(sliceDir, "SPEC.md"), "---\nid: OPR.X.19\n---\n\nreal\n");
    for (const bad of ["https://x/SPEC.md", "/etc/passwd", "../outside.md"]) {
      expect(approveErrCode(() => service().approve({ ...specInput, lockedArtifacts: [bad] })), bad)
        .toBe("locked_artifact_invalid");
    }
  });

  it("旧版 README 仍可审批，并优先于未修改的旧版 PRD proof contract", () => {
    fs.rmSync(readmePath);
    const legacyReadme = path.join(sliceDir, "README.md");
    fs.writeFileSync(
      legacyReadme,
      "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\n\n## Proof contract\n\n- [ ] authored ![authored](mockups/authored.png)\n",
    );
    // 未修改脚手架 PRD proof-contract（方括号包裹 placeholder）→ README 优先；PRD 脚手架不贡献内容。
    fs.writeFileSync(
      path.join(sliceDir, "IMPLEMENTATION-PRD.md"),
      "---\ntitle: prd\n---\n\n# Spec\n\n## Proof contract\n\n- [ ] [what will you show]\n",
    );
    service().approve(specInput);
    const locked = lockedOf(legacyReadme);
    expect(locked).toEqual([
      { name: "旧版规格", path: "README.md", kind: "spec" },
      { name: "authored", path: "mockups/authored.png", kind: "mockup" },
    ]);
  });

  it("RED-5 拒绝 URL scheme、逃逸和绝对路径；抑制含图片的 N/A；规范化首项优先去重；精确顺序和确定性（失败：缺席）", () => {
    // Intent visual body 同时包含 N/A 和真实图片 → 抑制该 section（图片不得出现）。Proof contract：
    // 规范化前不同的重复项（先 mockups/./d.png，再 mockups/d.png）→ 首项名称优先；另有 URL scheme
    // plannedRef、/absolute 和 ../escape，三者都必须拒绝（每条锁定路径均相对于 slice）。
    const body =
      "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\n\n## Intent visual\n\nN/A ![shouldnotappear](mockups/skip.png)\n\n## Proof contract\n\n- [ ] alpha ![a](mockups/./d.png)\n- [ ] beta ![b](mockups/d.png)\n- [ ] abs ![c](/absolute.png)\n- [ ] esc ![e](../secret.png)\n- [ ] external ![ext](https://example.invalid/external.png)\n";
    fs.writeFileSync(readmePath, body);
    service().approve(specInput);
    // 第二个独立创建且派生输入相同的 slice（确定性）。
    const dirB = path.join(missionsRoot, "release-x", "slices", "19d-plan");
    fs.mkdirSync(dirB, { recursive: true });
    const readmeB = path.join(dirB, "SPEC.md");
    fs.writeFileSync(readmeB, body);
    service().approve({ ...specInput, scopePath: "release-x/slices/19d-plan" });

    const locked = lockedOf(readmePath);
    expect(locked).toBeDefined(); // <-- RED: absent
    // 拒绝 /absolute.png + ../secret.png；抑制 N/A section（skip.png）；mockups/./d.png 规范化为
    // mockups/d.png 且首项优先（名称 "alpha"，而非去重后的 "beta"）；SPEC 居首。
    expect(locked).toEqual([SPEC, { name: "alpha", path: "mockups/d.png", kind: "mockup" }]);
    expect(lockedOf(readmeB)).toEqual(locked); // determinism: identical input -> identical ordered array
  });

  // ——配套 GREEN 钉扎（writer 前后均成立，用于锁定 gate）——

  it("GREEN gate——mission-spec approve 绝不创建 locked-artifacts", () => {
    const missionReadme = path.join(missionsRoot, "release-x", "README.md");
    fs.writeFileSync(missionReadme, "---\nid: OPR.X\n---\n# mission\n");
    service().approve({ scopeTier: "mission", scopePath: "release-x", approvalScope: "spec", actorSession: "pm-lead@openrig-pm" });
    expect(frontmatterOf(missionReadme)["locked-artifacts"]).toBeUndefined();
  });

  it("GREEN gate——fresh slice DELIVERY approve 绝不创建 locked-artifacts", () => {
    service().approve(baseInput); // delivery
    expect(frontmatterOf(readmePath)["locked-artifacts"]).toBeUndefined();
  });

  it("GREEN gate——spec 后接 delivery 会逐字保留现有 locked-artifacts 列表（merge 保留）", () => {
    // 使用名称/path/kind 各异的具体有序多 entry 列表，使断言证明精确保留（顺序 + 每个字段 + 数量），
    // 而不只是部分或首项匹配。
    fs.writeFileSync(
      readmePath,
      "---\nid: OPR.X.19\nstatus: building\n" +
        "locked-artifacts:\n" +
        "  - name: Specification\n    path: SPEC.md\n    kind: spec\n" +
        "  - name: drawer opens right\n    path: mockups/drawer.png\n    kind: mockup\n" +
        "  - name: intent shot\n    path: proof/intent.png\n    kind: intent\n" +
        "---\n# s\n",
    );
    service().approve(baseInput); // delivery approve merges the stamp, keeps locked-artifacts untouched
    expect(lockedOf(readmePath)).toEqual([
      { name: "Specification", path: "SPEC.md", kind: "spec" },
      { name: "drawer opens right", path: "mockups/drawer.png", kind: "mockup" },
      { name: "intent shot", path: "proof/intent.png", kind: "intent" },
    ]);
  });

  it("GREEN gate——slice-spec audit 失败会逐字恢复原 README，且不写 action 行", () => {
    seedAuthoredSpec();
    const failingLog = { record: () => { throw new Error("disk full"); } } as unknown as MissionControlActionLog;
    const before = fs.readFileSync(readmePath, "utf8");
    expect(() => service({ actionLog: failingLog }).approve(specInput)).toThrow(/无半 stamp/);
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before);
    expect(frontmatterOf(readmePath)["approved-spec-by"]).toBeUndefined();
    expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(0);
  });
});
