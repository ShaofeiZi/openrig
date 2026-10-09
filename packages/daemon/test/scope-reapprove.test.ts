// OPR.0.5.0.18——scope amend/re-stamp verb，移除 already_approved Status-note workaround。
// 记录设计：ARCH-SHAPING 9d64ceb6 v2——lock 是某一时点的 ATTESTATION；re-approval 是一份
// 带理由的新 attestation，用来 supersede 旧项；两者都保存在 append-only audit log 中。整个
// 操作是单一原子 verb，renderer 看不到 unapprove 窗口。
//
// 新文件测试套件；现有 scope-approve.test.ts 的下限只允许新增，不作编辑。

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
import { identityProvenanceSchema } from "../src/db/migrations/065_identity_provenance.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { ScopeApproveError, ScopeApproveService } from "../src/domain/scope/scope-approve.js";

function frontmatterOf(p: string): Record<string, unknown> {
  const content = fs.readFileSync(p, "utf8");
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? (YAML.parse(match[1]!) as Record<string, unknown>) : {};
}

describe("ScopeApproveService——re-approve/re-stamp（OPR.0.5.0.18）", () => {
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
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema, identityProvenanceSchema]);
    actionLog = new MissionControlActionLog(db);
    auditBrowse = new MissionControlAuditBrowse(db);
    missionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-reapprove-"));
    sliceDir = path.join(missionsRoot, "release-x", "slices", "18-amend-me");
    fs.mkdirSync(sliceDir, { recursive: true });
    readmePath = path.join(sliceDir, "README.md");
    fs.writeFileSync(readmePath, "---\nid: OPR.X.18\nstatus: building\n---\n\n# The slice\nbody prose stays intact\n");
    // B14——spec approval 拒绝无内容的派生集合；这些测试以前提为普通 approve，因此 fixture
    // PRD 携带 authored prose。
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "---\ntitle: prd\n---\n\n# Spec\n\nauthored requirement prose\n");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(missionsRoot, { recursive: true, force: true });
  });

  const base = {
    scopeTier: "slice" as const,
    scopePath: "release-x/slices/18-amend-me",
    actorSession: "pm@rig",
    onBehalfOf: null,
  };

  function approveOnce(scope: "spec" | "delivery" = "spec") {
    return service().approve({ ...base, approvalScope: scope });
  }

  it("原子 re-stamp 已批准 spec：frontmatter 新 stamp、prior 计数、带 reason + provenance triple 的新 audit row，且可从 row 取回旧 attestation", () => {
    const first = approveOnce("spec");
    const result = service().approve({
      ...base,
      approvalScope: "spec",
      actorSession: "planner@rig",
      onBehalfOf: "founder",
      reApprove: true,
      reason: "PRD §3 amended after guard round 2",
    });

    // frontmatter = 当前 attestation + prior-count。
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-by"]).toBe("planner@rig");
    expect(fm["approved-spec-at"]).toBe(result.approvedAt);
    expect(fm["approved-spec-priors"]).toBe(1);
    // body prose 保持完整。
    expect(fs.readFileSync(readmePath, "utf8")).toContain("body prose stays intact");

    // result 报告 amendment。
    expect(result.reApproved).toBe(true);
    expect(result.priorApprovedBy).toBe("pm@rig");
    expect(result.priorApprovedAt).toBe(first.approvedAt);

    // append-only row 可重建完整 history（两份 attestation）。
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "spec" }).rows;
    expect(rows).toHaveLength(2);
    const amendment = rows.find((r) => r.actionId === result.actionId)!;
    const notes = amendment.auditNotes as Record<string, unknown>;
    expect(notes["re_approval"]).toBe(true);
    expect(notes["reason"]).toBe("PRD §3 amended after guard round 2");
    expect(notes["prior_approved_by"]).toBe("pm@rig");
    expect(notes["prior_approved_at"]).toBe(first.approvedAt);
    expect(notes["on_behalf_of"]).toBe("founder"); // authorizer
    expect(amendment.actorSession).toBe("planner@rig"); // acting agent
    expect(amendment.reason).toContain("PRD §3 amended after guard round 2");
    // 旧 attestation row 不受影响；保持 append-only，不删除任何内容。
    const prior = rows.find((r) => r.actionId === first.actionId)!;
    expect((prior.auditNotes as Record<string, unknown>)["re_approval"]).toBeUndefined();
  });

  it("不带 flag 时仍触发裸 re-approve refusal，且消息点名允许的 verb", () => {
    approveOnce("spec");
    let caught: ScopeApproveError | null = null;
    try {
      service().approve({ ...base, approvalScope: "spec" });
    } catch (err) {
      caught = err as ScopeApproveError;
    }
    expect(caught?.code).toBe("already_approved");
    expect(caught?.message).toMatch(/--re-approve --reason/);
  });

  it("--re-approve 不带 --reason 时明确拒绝，且不写入任何内容", () => {
    approveOnce("spec");
    const before = fs.readFileSync(readmePath, "utf8");
    for (const badReason of [undefined, null, "", "   "]) {
      let caught: ScopeApproveError | null = null;
      try {
        service().approve({ ...base, approvalScope: "spec", reApprove: true, reason: badReason as string | null | undefined });
      } catch (err) {
        caught = err as ScopeApproveError;
      }
      expect(caught?.code).toBe("reason_required");
    }
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before); // byte-identical
    expect(auditBrowse.query({ scopeId: "OPR.X.18" }).rows).toHaveLength(1); // only the first approval
  });

  it("对没有现有 stamp 的 scope 执行 re-approve 时明确拒绝，因为 re 操作需要 prior", () => {
    let caught: ScopeApproveError | null = null;
    try {
      service().approve({ ...base, approvalScope: "spec", reApprove: true, reason: "nothing to supersede" });
    } catch (err) {
      caught = err as ScopeApproveError;
    }
    expect(caught?.code).toBe("nothing_to_reapprove");
    expect(auditBrowse.query({ scopeId: "OPR.X.18" }).rows).toHaveLength(0);
  });

  it("delivery-scope re-stamp 行为一致，使用相同机制和 delivery stamp 字段", () => {
    const first = approveOnce("delivery");
    const result = service().approve({
      ...base,
      approvalScope: "delivery",
      actorSession: "qa@rig",
      reApprove: true,
      reason: "delivery evidence superseded by corrected SHA",
    });
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-by"]).toBe("qa@rig");
    expect(fm["approved-at"]).toBe(result.approvedAt);
    expect(fm["approved-priors"]).toBe(1);
    expect(result.priorApprovedBy).toBe("pm@rig");
    expect(result.priorApprovedAt).toBe(first.approvedAt);
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "delivery" }).rows;
    expect(rows).toHaveLength(2);
  });

  it("re-stamp 时 audit 失败会逐字节恢复旧 frontmatter（stamp + priors）并明确失败；旧 row 保留", () => {
    approveOnce("spec");
    const beforeBytes = fs.readFileSync(readmePath, "utf8");
    const failingLog = {
      record: () => {
        throw new Error("disk full");
      },
    } as unknown as MissionControlActionLog;
    let caught: ScopeApproveError | null = null;
    try {
      service({ actionLog: failingLog }).approve({ ...base, approvalScope: "spec", reApprove: true, reason: "will fail" });
    } catch (err) {
      caught = err as ScopeApproveError;
    }
    expect(caught?.code).toBe("audit_write_failed");
    expect(fs.readFileSync(readmePath, "utf8")).toBe(beforeBytes); // byte-restore incl. NO priors bump
    expect(auditBrowse.query({ scopeId: "OPR.X.18" }).rows).toHaveLength(1); // first row intact, nothing deleted
  });

  it("第二次 re-stamp 把 priors 增至 2，row 可按顺序重建三份 attestation", () => {
    approveOnce("spec");
    service().approve({ ...base, approvalScope: "spec", reApprove: true, reason: "amendment one" });
    service().approve({ ...base, approvalScope: "spec", actorSession: "lead@rig", reApprove: true, reason: "amendment two" });
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-priors"]).toBe(2);
    expect(fm["approved-spec-by"]).toBe("lead@rig");
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "spec" }).rows;
    expect(rows).toHaveLength(3);
    const reasons = rows.map((r) => (r.auditNotes as Record<string, unknown>)["reason"]).filter(Boolean);
    expect(reasons).toEqual(expect.arrayContaining(["amendment one", "amendment two"]));
  });

  it("spec re-stamp 重新派生 plan-lock artifact set，修改后的 PRD 成为 locked set", () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "---\nid: OPR.X.18\n---\n# PRD v1\n\nversion one requirements\n");
    approveOnce("spec");
    const fm1 = frontmatterOf(readmePath);
    expect(Array.isArray(fm1["locked-artifacts"])).toBe(true);
    // 修改 PRD 后 re-stamp：在新 attestation 上重新派生 locked set。
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "---\nid: OPR.X.18\n---\n# PRD v2 amended\n\nversion two requirements\n");
    service().approve({ ...base, approvalScope: "spec", reApprove: true, reason: "PRD amended" });
    const fm2 = frontmatterOf(readmePath);
    expect(Array.isArray(fm2["locked-artifacts"])).toBe(true);
    expect(fm2["approved-spec-priors"]).toBe(1);
  });

  it("ROUTE：reApprove + reason 通过 POST /api/scope/approve 到达，传递值而非只有 option", async () => {
    const { Hono } = await import("hono");
    const { scopeApproveRoutes } = await import("../src/routes/scope-approve.js");
    const indexerStub = { isReady: () => true, slicesRoot: missionsRoot };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sliceIndexer" as never, indexerStub as never);
      c.set("missionControlActionLog" as never, actionLog as never);
      await next();
    });
    app.route("/api/scope/approve", scopeApproveRoutes());

    // P21 I1：approver identity 是 transport header（X-OpenRig-Session），由 CLI 从席位 env
    // 盖章。合法调用方提供它；body.actorSession 是过渡期 claim。
    const post = (body: Record<string, unknown>, session = "pm@rig") =>
      app.request("/api/scope/approve", {
        method: "POST",
        headers: { "content-type": "application/json", "X-OpenRig-Session": session },
        body: JSON.stringify(body),
      });

    const wire = { scopeTier: "slice", scopePath: base.scopePath, approvalScope: "spec", actorSession: "pm@rig" };
    expect((await post(wire)).status).toBe(201);
    // 裸重复 → 409，并指引 verb。
    const conflict = await post(wire);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { message: string }).message).toMatch(/--re-approve --reason/);
    // re-approve 不带 reason → 400 reason_required；值必须到达才能判断。
    const noReason = await post({ ...wire, reApprove: true });
    expect(noReason.status).toBe(400);
    expect(((await noReason.json()) as { error: string }).error).toBe("reason_required");
    // 完整 amendment 穿过 wire → 201，并携带 amendment 结果字段。
    const ok = await post({ ...wire, actorSession: "planner@rig", reApprove: true, reason: "wire-level amend" }, "planner@rig");
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { reApproved: boolean; priorApprovedBy: string };
    expect(okBody.reApproved).toBe(true);
    expect(okBody.priorApprovedBy).toBe("pm@rig");
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "spec" }).rows;
    expect(rows.some((r) => (r.auditNotes as Record<string, unknown>)["reason"] === "wire-level amend")).toBe(true);
  });

  it("P21 I1：signing surface 从 transport header 派生 approver——deliver-and-label（401/409 已退役）", async () => {
    const { Hono } = await import("hono");
    const { scopeApproveRoutes } = await import("../src/routes/scope-approve.js");
    const indexerStub = { isReady: () => true, slicesRoot: missionsRoot };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sliceIndexer" as never, indexerStub as never);
      c.set("missionControlActionLog" as never, actionLog as never);
      await next();
    });
    app.route("/api/scope/approve", scopeApproveRoutes());
    const req = (headers: Record<string, string>, body: Record<string, unknown>) =>
      app.request("/api/scope/approve", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const wire = { scopeTier: "slice", scopePath: base.scopePath, approvalScope: "spec" };

    // (1) header 缺失 + body actorSession → 以 claimed actor（claimed:v1）deliver-and-label，
    // 返回 201，不拒绝。
    const noHeader = await req({}, { ...wire, actorSession: "mallory@rig" });
    expect(noHeader.status).toBe(201);
    expect(frontmatterOf(readmePath)["provenance"]).toBe("claimed:v1");

    // (2) header 存在 + body actor 不同 → wire SUPERSEDE（以 pm@rig、transport:v1 re-stamp）；
    // 409 已退役。re-stamp 需要显式 reason（re-approve guard）；不同 body actor 被 supersede，
    // 不被拒绝。
    const mismatch = await req({ "X-OpenRig-Session": "pm@rig" }, { ...wire, actorSession: "mallory@rig", reApprove: true, reason: "wire supersedes body" });
    expect(mismatch.status).toBe(201);
    expect(frontmatterOf(readmePath)["provenance"]).toBe("transport:v1"); // wire wins; mallory@rig superseded

    // (3) header + 无 body actorSession → 记录的 approver 是 transport identity，transport:v1。
    const derived = await req({ "X-OpenRig-Session": "pm@rig" }, { ...wire, reApprove: true, reason: "re-derive" });
    expect(derived.status).toBe(201);
    expect(frontmatterOf(readmePath)["provenance"]).toBe("transport:v1");
  });

  it("P21 I1 era-stamp：直接 service approve（无 transport chokepoint）保持 identity_provenance NULL，即 claimed-era，绝不伪造", () => {
    // service 如实记录 actor，但不发明 provenance：缺失本身就是 claimed-era marker（P21 之前的
    // direct-caller row）。不 backfill、不重新标记（house absent-never-fabricated）。
    service().approve({ scopeTier: "slice", scopePath: base.scopePath, approvalScope: "spec", actorSession: "human@kernel" });
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "spec" }).rows;
    expect(rows[0]!.identityProvenance).toBeNull();
    expect(frontmatterOf(readmePath)["provenance"]).toBeUndefined();
  });

  it("回归：普通首次 approve 不携带 amendment 字段，保持逐字节相同的首次 approve 行为", () => {
    const result = approveOnce("spec");
    expect(result.reApproved).toBe(false);
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-priors"]).toBeUndefined();
    const rows = auditBrowse.query({ scopeId: "OPR.X.18" }).rows;
    expect(rows).toHaveLength(1);
    const notes = rows[0]!.auditNotes as Record<string, unknown>;
    expect(notes["re_approval"]).toBeUndefined();
    expect(notes["reason"]).toBeUndefined();
  });
});
