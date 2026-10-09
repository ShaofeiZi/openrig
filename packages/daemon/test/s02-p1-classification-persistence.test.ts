import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { classificationFieldsAndAttemptsSchema } from "../src/db/migrations/086_classification_fields_and_attempts.js";
import { classificationIdentityProvenanceSchema } from "../src/db/migrations/089_classification_identity_provenance.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { projectsRoutes } from "../src/routes/projects.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager, ClassifierLeaseError } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier, ProjectClassifierError } from "../src/domain/project-classifier.js";
import {
  ClassificationAttemptLedger,
  ClassificationAttemptError,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_IN_FLIGHT_TIMEOUT_MS,
} from "../src/domain/classification-attempts.js";

/**
 * 0.6.0 S02 P1——分类持久化与租约正确性。契约：
 * missions/release-0.6.0/evidence/offline-contract-s01-s02-dev60/CONTRACT.md
 *（修订 2）及 Review-R2 REPORT 3b6d58dd（九项离线控制）。每个用例都使用内存或
 * 一次性临时数据库，并注入时钟。
 */

const TTL = 60_000;
const V = { classifierVersion: "clf-1", taxonomyVersion: "tax-0.2", evidenceEpoch: "0" };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ClassifierLeaseError || err instanceof ProjectClassifierError || err instanceof ClassificationAttemptError) {
      return err.code;
    }
    throw err;
  }
  return "no-error";
}

describe("S02 P1 分类持久化与租约正确性", () => {
  let db: Database.Database;
  let bus: EventBus;
  let clock: number;
  let leases: ClassifierLeaseManager;
  let classifier: ProjectClassifier;
  let ledger: ClassificationAttemptLedger;
  let stream: StreamStore;
  const now = () => new Date(clock);

  function seed(n: number, prefix = "item"): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-${String(i).padStart(3, "0")}`;
      stream.emit({ streamItemId: id, sourceSession: "obs@rig", body: `observation ${i}` });
      ids.push(id);
    }
    return ids;
  }

  beforeEach(() => {
    clock = Date.parse("2026-09-26T20:00:00.000Z");
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, projectClassificationsSchema, classifierLeasesSchema, classificationFieldsAndAttemptsSchema, classificationIdentityProvenanceSchema]);
    bus = new EventBus(db);
    stream = new StreamStore(db, bus);
    leases = new ClassifierLeaseManager(db, bus, { ttlMs: TTL, now });
    classifier = new ProjectClassifier(db, bus, leases, { now });
    ledger = new ClassificationAttemptLedger(db, leases, { now });
  });

  afterEach(() => db.close());

  describe("租约绑定（R2 控制项 1—3，现按修正后的方向通过）", () => {
    it("同一会话在 TTL 后获取时签发新租约 id，而非返回已过期租约", () => {
      const first = leases.acquire("occ@rig");
      clock += TTL + 1;
      const second = leases.acquire("occ@rig");
      expect(second.leaseId).not.toBe(first.leaseId);
      expect(leases.getById(first.leaseId)?.state).toBe("expired");
      expect(second.state).toBe("active");
    });

    it("同一会话在 TTL 前获取时保持幂等", () => {
      const first = leases.acquire("occ@rig");
      clock += TTL - 1;
      expect(leases.acquire("occ@rig").leaseId).toBe(first.leaseId);
    });

    it("已超过 TTL 的租约收到心跳时以 lease_expired 拒绝，且不会复活", () => {
      const lease = leases.acquire("occ@rig");
      clock += TTL + 1;
      expect(code(() => leases.heartbeat(lease.leaseId, "occ@rig"))).toBe("lease_expired");
      expect(leases.getById(lease.leaseId)?.expiresAt).toBe(lease.expiresAt);
    });

    it("绑定到同会话已替换租约的迟到结果被拒绝（lease_mismatch），且不写入任何内容", () => {
      seed(1);
      const old = leases.acquire("occ@rig");
      clock += TTL + 1;
      leases.acquire("occ@rig");
      expect(code(() => classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId: old.leaseId }))).toBe(
        "lease_mismatch",
      );
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
    });

    it("不同会话在执行评估式获取前不能接管过期租约，执行后可以", () => {
      leases.acquire("occ@rig");
      clock += TTL + 1;
      expect(code(() => leases.acquire("other@rig"))).toBe("lease_held");
      leases.evaluateDeadness();
      expect(leases.acquire("other@rig").classifierSession).toBe("other@rig");
    });

    it("已过期但尚未替换的租约拒绝写入", () => {
      seed(1);
      const lease = leases.acquire("occ@rig");
      clock += TTL + 1;
      expect(code(() => classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId: lease.leaseId }))).toBe(
        "lease_expired",
      );
    });

    it("没有 leaseId 的旧调用方收到明确拒绝，而非静默写入", () => {
      seed(1);
      leases.acquire("occ@rig");
      expect(code(() => classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig" } as never))).toBe(
        "lease_id_required",
      );
    });
  });

  describe("分类字段（迁移 086）", () => {
    it("存储四个字段及版本绑定；未知 needs_human 保持 null 而非 false", () => {
      seed(3);
      const { leaseId } = leases.acquire("occ@rig");
      const yes = classifier.classify({
        streamItemId: "item-001", classifierSession: "occ@rig", leaseId,
        area: "coordination-stream-queue", scopeRef: "OPR.0.6.0.2", candidateSetVersion: "scope@2026-09-26",
        duplicateOfStreamItemId: "item-000", needsHuman: true, classifierVersion: "clf-1", taxonomyVersion: "tax-0.2",
      });
      const no = classifier.classify({ streamItemId: "item-002", classifierSession: "occ@rig", leaseId, needsHuman: false });
      const unknown = classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId });
      expect(yes).toMatchObject({
        area: "coordination-stream-queue", scopeRef: "OPR.0.6.0.2", candidateSetVersion: "scope@2026-09-26",
        duplicateOfStreamItemId: "item-000", needsHuman: true, leaseId, classifierVersion: "clf-1", taxonomyVersion: "tax-0.2",
      });
      expect(no.needsHuman).toBe(false);
      expect(unknown.needsHuman).toBeNull();
      expect(classifier.list({ needsHuman: "false" }).map((p) => p.streamItemId)).toEqual(["item-002"]);
      expect(classifier.list({ needsHuman: "unknown" }).map((p) => p.streamItemId)).toEqual(["item-000"]);
      expect(classifier.list({ area: "coordination-stream-queue" }).map((p) => p.streamItemId)).toEqual(["item-001"]);
      expect(classifier.list({ scopeRef: "OPR.0.6.0.2" })).toHaveLength(1);
    });

    it("校验消费形态：duplicate 必须存在且不能指向自身；scopeRef 需要候选集版本", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const base = { streamItemId: "item-000", classifierSession: "occ@rig", leaseId };
      expect(code(() => classifier.classify({ ...base, duplicateOfStreamItemId: "item-000" }))).toBe("invalid_duplicate_of");
      expect(code(() => classifier.classify({ ...base, duplicateOfStreamItemId: "missing" }))).toBe("invalid_duplicate_of");
      expect(code(() => classifier.classify({ ...base, scopeRef: "OPR.0.6.0.2" }))).toBe("candidate_set_version_required");
      expect(code(() => classifier.classify({ ...base, needsHuman: "yes" as never }))).toBe("invalid_needs_human");
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
    });

    it("仍由首次写入胜出", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId, area: "a" });
      expect(code(() => classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId, area: "b" }))).toBe(
        "idempotency_violation",
      );
      expect(classifier.getByStreamItemId("item-000")?.area).toBe("a");
    });
  });

  describe("尝试台账", () => {
    it("弃权对其身份是终止状态，新版本或证据周期使该项重新具备资格", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      ledger.abstain({ attemptId: a.attemptId, executionId: a.executionId, leaseId, classifierSession: "occ@rig", reason: "margin below threshold" });
      expect(code(() => ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" }))).toBe("attempt_terminal");
      expect(ledger.eligible(V).items).toHaveLength(0);
      expect(ledger.eligible({ ...V, classifierVersion: "clf-2" }).items.map((i) => i.streamItemId)).toEqual(["item-000"]);
      expect(ledger.eligible({ ...V, evidenceEpoch: "evidence:sha256:abc" }).items).toHaveLength(1);
      // 弃权从未触碰不可变分类行。
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
    });

    it("错误经过有界倍增延迟后重试，并在预算耗尽时停止", () => {
      seed(1);
      // 测试租约 TTL（60 秒）短于退避时间，因此占用者每次等待后重新获取；其自身已过期
      // 的租约会产生新 id。
      let leaseId = leases.acquire("occ@rig").leaseId;
      const begin = () => ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const fail = (x: { attemptId: string; executionId: string }) =>
        ledger.fail({ attemptId: x.attemptId, executionId: x.executionId, leaseId, classifierSession: "occ@rig", reason: "provider 503" });
      const a = begin();
      const failed = fail(a);
      expect(failed.status).toBe("error");
      expect(Date.parse(failed.retryAfter!)).toBe(clock + DEFAULT_BASE_BACKOFF_MS);
      expect(ledger.eligible(V).items).toHaveLength(0);
      expect(code(begin)).toBe("attempt_not_due");
      clock += DEFAULT_BASE_BACKOFF_MS;
      leaseId = leases.acquire("occ@rig").leaseId;
      expect(ledger.eligible(V).items).toHaveLength(1);
      const b = begin();
      expect(b.attemptCount).toBe(2);
      expect(b.executionId).not.toBe(a.executionId);
      const second = fail(b);
      expect(Date.parse(second.retryAfter!)).toBe(clock + 2 * DEFAULT_BASE_BACKOFF_MS);
      clock += 2 * DEFAULT_BASE_BACKOFF_MS;
      leaseId = leases.acquire("occ@rig").leaseId;
      const c = begin();
      expect(c.attemptCount).toBe(3);
      const last = fail(c);
      expect(last.status).toBe("exhausted");
      expect(ledger.eligible(V).items).toHaveLength(0);
    });

    it("被遗弃的进行中尝试（崩溃）在超时后重新具备资格，并计入预算", () => {
      seed(1);
      const lease = leases.acquire("occ@rig");
      ledger.begin({ streamItemId: "item-000", ...V, leaseId: lease.leaseId, classifierSession: "occ@rig" });
      expect(ledger.eligible(V).items).toHaveLength(0);
      expect(code(() => ledger.begin({ streamItemId: "item-000", ...V, leaseId: lease.leaseId, classifierSession: "occ@rig" }))).toBe(
        "attempt_in_flight",
      );
      clock += DEFAULT_IN_FLIGHT_TIMEOUT_MS;
      const fresh = leases.acquire("occ@rig"); // own lease past TTL -> new lease id
      expect(ledger.eligible(V).items).toHaveLength(1);
      expect(ledger.begin({ streamItemId: "item-000", ...V, leaseId: fresh.leaseId, classifierSession: "occ@rig" }).attemptCount).toBe(2);
    });

    it("已替换租约下的进行中尝试可由新租约恢复，但不能由旧租约完成", () => {
      seed(1);
      const old = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId: old.leaseId, classifierSession: "occ@rig" });
      clock += TTL + 1;
      const fresh = leases.acquire("occ@rig");
      expect(code(() => ledger.abstain({ attemptId: a.attemptId, executionId: a.executionId, leaseId: old.leaseId, classifierSession: "occ@rig", reason: "x" }))).toBe(
        "lease_mismatch",
      );
      const resumed = ledger.begin({ streamItemId: "item-000", ...V, leaseId: fresh.leaseId, classifierSession: "occ@rig" });
      expect(resumed.leaseId).toBe(fresh.leaseId);
      expect(resumed.attemptCount).toBe(2);
    });

    it("绑定到尝试的 classify 在同一事务中将其标记为已写入", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      classifier.classify({
        streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: a.attemptId, executionId: a.executionId,
        classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion, classificationType: "bug",
      });
      expect(ledger.getById(a.attemptId)?.status).toBe("written");
      expect(ledger.eligible(V).items).toHaveLength(0);
      expect(ledger.eligible({ ...V, classifierVersion: "clf-2" }).items).toHaveLength(0); // classified items never re-offered
    });

    it("尝试版本不匹配的 classify 被拒绝，且不写入任何内容", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      expect(
        code(() =>
          classifier.classify({
            streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: a.attemptId, executionId: a.executionId,
            classifierVersion: "clf-other", taxonomyVersion: V.taxonomyVersion,
          }),
        ),
      ).toBe("attempt_mismatch");
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
      expect(ledger.getById(a.attemptId)?.status).toBe("in_flight");
    });

    it("检查后的事务失败会同时回滚数据行与尝试", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const original = bus.persistWithinTransaction.bind(bus);
      bus.persistWithinTransaction = ((event: Parameters<typeof original>[0]) => {
        if (event.type === "project.classified") throw new Error("injected event-store failure");
        return original(event);
      }) as typeof bus.persistWithinTransaction;
      expect(() =>
        classifier.classify({
          streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: a.attemptId, executionId: a.executionId,
          classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion,
        }),
      ).toThrow("injected event-store failure");
      bus.persistWithinTransaction = original;
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
      expect(ledger.getById(a.attemptId)?.status).toBe("in_flight");
    });
  });

  describe("F1 执行隔离（R2 510ef2da 发现）：旧执行与当前执行", () => {
    // 长 TTL 配合定期心跳，使同一租约跨重试保持存活，因此只有执行隔离（而非租约）
    // 能拒绝旧执行。
    const LONG_TTL = 60 * 60_000;
    let fenceLeases: ClassifierLeaseManager;
    let fenceLedger: ClassificationAttemptLedger;
    let fenceClassifier: ProjectClassifier;
    beforeEach(() => {
      fenceLeases = new ClassifierLeaseManager(db, bus, { ttlMs: LONG_TTL, now });
      fenceLedger = new ClassificationAttemptLedger(db, fenceLeases, { now });
      fenceClassifier = new ProjectClassifier(db, bus, fenceLeases, { now });
    });

    function retried(cause: "timeout" | "error") {
      seed(1);
      const { leaseId } = fenceLeases.acquire("occ@rig");
      const begin = () => fenceLedger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const oldExec = begin();
      if (cause === "timeout") {
        for (let t = 0; t < 3; t++) { clock += 5 * 60_000; fenceLeases.heartbeat(leaseId, "occ@rig"); }
      } else {
        fenceLedger.fail({ attemptId: oldExec.attemptId, executionId: oldExec.executionId, leaseId, classifierSession: "occ@rig", reason: "provider 503" });
        clock += DEFAULT_BASE_BACKOFF_MS;
        fenceLeases.heartbeat(leaseId, "occ@rig");
      }
      const current = begin();
      expect(current.attemptId).toBe(oldExec.attemptId);
      expect(fenceLeases.getActiveLease()?.leaseId).toBe(leaseId); // same, still-live lease
      expect(current.executionId).not.toBe(oldExec.executionId);
      return { leaseId, oldExec, current };
    }

    for (const cause of ["timeout", "error"] as const) {
      it(`${cause} 重试：旧执行不能 classify、abstain 或 fail；当前执行可以`, () => {
        const { leaseId, oldExec, current } = retried(cause);
        const finish = { attemptId: oldExec.attemptId, leaseId, classifierSession: "occ@rig", reason: "late" };
        expect(code(() => fenceLedger.abstain({ ...finish, executionId: oldExec.executionId }))).toBe("attempt_superseded");
        expect(code(() => fenceLedger.fail({ ...finish, executionId: oldExec.executionId }))).toBe("attempt_superseded");
        expect(code(() => fenceClassifier.classify({
          streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: oldExec.attemptId,
          executionId: oldExec.executionId, classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion,
        }))).toBe("attempt_superseded");
        // 旧执行的任何尝试都未触碰当前执行。
        expect(fenceClassifier.getByStreamItemId("item-000")).toBeNull();
        expect(fenceLedger.getById(current.attemptId)).toMatchObject({ status: "in_flight", executionId: current.executionId });
        // 当前执行正常完成。
        fenceClassifier.classify({
          streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: current.attemptId,
          executionId: current.executionId, classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion,
        });
        expect(fenceLedger.getById(current.attemptId)?.status).toBe("written");
      });
    }

    it("所有完成路径都拒绝缺少 executionId 的请求", () => {
      seed(1);
      const { leaseId } = fenceLeases.acquire("occ@rig");
      const a = fenceLedger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const finish = { attemptId: a.attemptId, leaseId, classifierSession: "occ@rig", reason: "x" };
      expect(code(() => fenceLedger.abstain(finish as never))).toBe("invalid_field");
      expect(code(() => fenceLedger.fail(finish as never))).toBe("invalid_field");
      expect(code(() => fenceClassifier.classify({
        streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: a.attemptId,
        classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion,
      }))).toBe("execution_id_required");
      expect(fenceLedger.getById(a.attemptId)?.status).toBe("in_flight");
    });

    it("手动分类（无 attemptId）不需要 executionId，也不受台账绑定", () => {
      seed(1);
      const { leaseId } = fenceLeases.acquire("occ@rig");
      fenceClassifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId, area: "tui" });
      expect(db.prepare(`SELECT count(*) AS n FROM classification_attempts`).get()).toEqual({ n: 0 });
    });
  });

  describe("F2 通过 HTTP 校验消费形态（R2 510ef2da 发现）", () => {
    function app(): Hono {
      const a = new Hono();
      a.use("*", async (c, next) => {
        c.set("eventBus" as never, bus);
        c.set("projectClassifier" as never, classifier);
        c.set("classifierLeaseManager" as never, leases);
        c.set("classificationAttemptLedger" as never, ledger);
        await next();
      });
      a.route("/api/projects", projectsRoutes());
      return a;
    }
    const post = (path: string, body: unknown) =>
      app().request(`/api/projects${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    it("字符串字段收到数字、对象或 null 时以字段特定 400 拒绝，且不写入", async () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const base = { streamItemId: "item-000", classifierSession: "occ@rig", leaseId };
      const cases: Array<[string, unknown]> = [
        ["scopeRef", 7], ["candidateSetVersion", 8], ["area", 9], ["scopeRef", { id: "x" }],
        ["area", null], ["classificationType", ["bug"]], ["classifierVersion", ""], ["duplicateOfStreamItemId", 0],
        ["executionId", 5],
      ];
      for (const [field, value] of cases) {
        const res = await post("/project", { ...base, [field]: value });
        const body = (await res.json()) as { error: string; field?: string };
        expect([field, res.status, body.error, body.field]).toEqual([field, 400, "invalid_field", field]);
      }
      const objSession = await post("/project", { ...base, classifierSession: { s: 1 } });
      expect(objSession.status).toBe(400);
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
    });

    it("合法字符串和 needsHuman true/false/null 仍然成功", async () => {
      seed(3);
      const { leaseId } = leases.acquire("occ@rig");
      const ok = await post("/project", {
        streamItemId: "item-000", classifierSession: "occ@rig", leaseId, area: "tui", scopeRef: "OPR.0.6.0.2",
        candidateSetVersion: "scope@1", classificationType: "", needsHuman: null,
      });
      expect(ok.status).toBe(201);
      expect(await ok.json()).toMatchObject({ area: "tui", scopeRef: "OPR.0.6.0.2", classificationType: "", needsHuman: null });
      expect((await post("/project", { streamItemId: "item-001", classifierSession: "occ@rig", leaseId, needsHuman: false })).status).toBe(201);
      expect((await post("/project", { streamItemId: "item-002", classifierSession: "occ@rig", leaseId, needsHuman: "no" })).status).toBe(400);
    });

    it("尝试路由拒绝非字符串的身份与完成字段", async () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const bad = await post("/attempts/begin", { streamItemId: "item-000", ...V, classifierVersion: 1, leaseId, classifierSession: "occ@rig" });
      expect(bad.status).toBe(400);
      const begun = await post("/attempts/begin", { streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const a = (await begun.json()) as { attemptId: string; executionId: string };
      const r = await post(`/attempts/${a.attemptId}/abstain`, { executionId: 1, leaseId, classifierSession: "occ@rig", reason: "x" });
      expect([r.status, ((await r.json()) as { field?: string }).field]).toEqual([400, "executionId"]);
      expect(ledger.getById(a.attemptId)?.status).toBe("in_flight");
    });
  });

  describe("符合资格的分页", () => {
    it("按流顺序完整分页超过 50 项，并排除已归档和已分类项", () => {
      const ids = seed(57);
      stream.archive(ids[3]!);
      const { leaseId } = leases.acquire("occ@rig");
      classifier.classify({ streamItemId: ids[10]!, classifierSession: "occ@rig", leaseId });
      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = ledger.eligible({ ...V, limit: 20, afterSortKey: after });
        expect(page.items.length).toBeLessThanOrEqual(20);
        seen.push(...page.items.map((i) => i.streamItemId));
        after = page.nextAfterSortKey ?? undefined;
        pages++;
      } while (after);
      expect(pages).toBe(3);
      expect(seen).toEqual(ids.filter((id) => id !== ids[3] && id !== ids[10]));
    });

    it("限制页大小并拒绝未知 cursor", () => {
      seed(120);
      expect(ledger.eligible({ ...V, limit: 1000 }).items).toHaveLength(100);
      expect(code(() => ledger.eligible({ ...V, afterSortKey: "not-a-key" }))).toBe("unknown_cursor");
    });
  });
});

describe("S02 P1 在已有数据的基础数据库上执行迁移 086（升级 + 重开）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "s02-p1-upgrade-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("旧行的新字段为 null 时仍可读取，升级后保持首次写入胜出", () => {
    const file = join(dir, "base.sqlite");
    const base = ALL_MIGRATIONS.filter((m) => m.name !== classificationFieldsAndAttemptsSchema.name && m.name !== classificationIdentityProvenanceSchema.name);
    expect(base.length).toBe(ALL_MIGRATIONS.length - 2);

    // 基线（截至 085）：一个按旧方式写入的分类，一个活跃租约。
    const before = createDb(file);
    migrate(before, base);
    before.prepare(`INSERT INTO stream_items (stream_item_id, ts_emitted, stream_sort_key, source_session, body) VALUES (?, ?, ?, ?, ?)`)
      .run("old-1", "2026-09-01T00:00:00.000Z", "01OLD0000000000000000000001", "obs@rig", "old observation");
    before.prepare(`INSERT INTO classifier_leases (lease_id, classifier_session, acquired_at, expires_at, last_heartbeat, state) VALUES (?, ?, ?, ?, ?, 'active')`)
      .run("lease-old", "occ@rig", "2026-09-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    before.prepare(`INSERT INTO project_classifications (project_id, stream_item_id, classification_type, classifier_session, ts_projected) VALUES (?, ?, ?, ?, ?)`)
      .run("proj-old", "old-1", "idea", "occ@rig", "2026-09-01T00:00:01.000Z");
    before.close();

    // 升级并重开。
    const upgraded = createDb(file);
    migrate(upgraded, ALL_MIGRATIONS);
    upgraded.close();
    const reopened = createDb(file);
    migrate(reopened, ALL_MIGRATIONS); // idempotent second pass
    const bus = new EventBus(reopened);
    const leases = new ClassifierLeaseManager(reopened, bus);
    const classifier = new ProjectClassifier(reopened, bus, leases);
    const old = classifier.getByStreamItemId("old-1")!;
    expect(old).toMatchObject({
      classificationType: "idea", area: null, scopeRef: null, duplicateOfStreamItemId: null,
      needsHuman: null, leaseId: null, classifierVersion: null, taxonomyVersion: null, candidateSetVersion: null,
    });
    expect(code(() => classifier.classify({ streamItemId: "old-1", classifierSession: "occ@rig", leaseId: "lease-old" }))).toBe(
      "idempotency_violation",
    );
    const tables = reopened.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'classification_attempts'`).all();
    expect(tables).toHaveLength(1);
    const cols = (reopened.prepare(`PRAGMA table_info(classification_attempts)`).all() as Array<{ name: string; notnull: number }>);
    expect(cols.find((c) => c.name === "execution_id")?.notnull).toBe(1);
    reopened.close();
  });

  it("持久错误重试在关闭/重开后仍保留，且隔离仍拒绝重启前执行", () => {
    const file = join(dir, "durable.sqlite");
    let clock = Date.parse("2026-09-27T02:00:00.000Z");
    const now = () => new Date(clock);
    const open = () => {
      const db = createDb(file);
      migrate(db, ALL_MIGRATIONS);
      const bus = new EventBus(db);
      const leases = new ClassifierLeaseManager(db, bus, { ttlMs: 60 * 60_000, now });
      return { db, bus, leases, ledger: new ClassificationAttemptLedger(db, leases, { now }), classifier: new ProjectClassifier(db, bus, leases, { now }) };
    };
    let s1 = open();
    new StreamStore(s1.db, s1.bus).emit({ streamItemId: "d-1", sourceSession: "obs@rig", body: "durable" });
    const leaseId = s1.leases.acquire("occ@rig").leaseId;
    const a = s1.ledger.begin({ streamItemId: "d-1", ...V, leaseId, classifierSession: "occ@rig" });
    s1.ledger.fail({ attemptId: a.attemptId, executionId: a.executionId, leaseId, classifierSession: "occ@rig", reason: "provider 503" });
    s1.db.close();

    clock += DEFAULT_BASE_BACKOFF_MS;
    const s2 = open();
    expect(s2.ledger.getById(a.attemptId)).toMatchObject({ status: "error", attemptCount: 1, executionId: a.executionId });
    expect(s2.ledger.eligible(V).items.map((i) => i.streamItemId)).toEqual(["d-1"]);
    const b = s2.ledger.begin({ streamItemId: "d-1", ...V, leaseId, classifierSession: "occ@rig" });
    expect(b.attemptCount).toBe(2);
    expect(code(() => s2.ledger.abstain({ attemptId: a.attemptId, executionId: a.executionId, leaseId, classifierSession: "occ@rig", reason: "late" }))).toBe(
      "attempt_superseded",
    );
    s2.ledger.abstain({ attemptId: b.attemptId, executionId: b.executionId, leaseId, classifierSession: "occ@rig", reason: "below threshold" });
    s2.db.close();
    s1 = open();
    expect(s1.ledger.getById(a.attemptId)?.status).toBe("abstained");
    expect(s1.ledger.eligible(V).items).toHaveLength(0);
    s1.db.close();
  });
});
