import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adaptContextUsageEvidence,
  adaptLifecycleReceiptEvidence,
  adaptOccupantModelEvidence,
  adaptQueueTransitionEvidence,
  adaptTopologyActivityEvidence,
  adaptWatchdogHistoryEvidence,
  adaptWorkGraphEvidence,
  boundHealthEvidence,
  canonicalHealthJson,
  deriveHealthSourceFreshness,
  projectHealthRecord,
  type BoundedHealthEvidence,
  type HealthEvidenceReference,
  type HealthRecordDraft,
} from "../src/health-projection-surface.js";

const QUERY = {
  source: "queue-transition" as const,
  startedAt: "2026-09-03T00:00:00Z",
  endedAt: "2026-09-03T01:00:00Z",
  limit: 10,
  retentionSeconds: 7_200,
};

function queueEvidence(
  sourceOrder = 0,
  observedAt: string | null = "2026-09-03T00:30:00Z",
): HealthEvidenceReference {
  if (observedAt === null) {
    return {
      type: "queue-transition",
      sourceOrder,
      observedAt: null,
      qitemId: "qitem-a",
      transitionId: sourceOrder + 1,
      state: "in-progress",
      actorSession: "builder@rig",
      identityProvenance: "transport:v1",
    };
  }
  return adaptQueueTransitionEvidence({
    qitemId: "qitem-a",
    transitionId: sourceOrder + 1,
    ts: observedAt,
    state: "in-progress",
    actorSession: "builder@rig",
    identityProvenance: "transport:v1",
  }, sourceOrder);
}

function freshSource(evidence: readonly HealthEvidenceReference[] = [queueEvidence()]): BoundedHealthEvidence {
  return boundHealthEvidence(evidence, QUERY, deriveHealthSourceFreshness({
    evaluatedAt: QUERY.endedAt,
    newestSourceAt: "2026-09-03T00:30:00Z",
    maxAgeSeconds: 3_600,
  }));
}

function draft(source: BoundedHealthEvidence = freshSource()): HealthRecordDraft {
  return {
    detector: "process.repeated-handoff",
    category: "process",
    scope: { type: "mission", projectId: "openrig", missionId: "release-0.5.9" },
    severity: "warning",
    confidence: "high",
    status: "active",
    startedAt: "2026-09-03T00:10:00Z",
    lastObservedAt: "2026-09-03T00:30:00Z",
    summary: "同一事件中持续发生重复交接。",
    threshold: "有界区间内至少发生三次符合条件的交接。",
    explanation: "证据符合检测器的字面规则。",
    suggestedInspection: "检查列出的队列转换。",
    source,
  };
}

describe("健康投影契约", () => {
  it("在后续符合条件的区间开始前保持事件身份稳定", () => {
    const active = projectHealthRecord(draft());
    const refreshed = projectHealthRecord({
      ...draft(),
      lastObservedAt: "2026-09-03T00:45:00Z",
      summary: "同一事件仍处于活跃状态。",
    });
    const cleared = projectHealthRecord({ ...draft(), status: "cleared" });
    const later = projectHealthRecord({
      ...draft(),
      startedAt: "2026-09-03T00:50:00Z",
      lastObservedAt: "2026-09-03T00:55:00Z",
    });

    expect(refreshed.id).toBe(active.id);
    expect(cleared.id).toBe(active.id);
    expect(later.id).not.toBe(active.id);
    expect(canonicalHealthJson([refreshed, active])).toBe(canonicalHealthJson([active, refreshed]));
    expect(canonicalHealthJson([later, active])).toBe(canonicalHealthJson([active, later]));
    expect(canonicalHealthJson([active])).toBe(canonicalHealthJson([active]));
  });

  it.each([
    ["过期", { state: "stale" as const, newestSourceAt: "2026-09-02T00:00:00Z", ageSeconds: 90_000 }],
    ["不可用", { state: "unavailable" as const, newestSourceAt: null, ageSeconds: null }],
    ["矛盾", { state: "contradictory" as const, newestSourceAt: "2026-09-03T00:30:00Z", ageSeconds: 1_800 }],
  ])("绝不将%s来源证据呈现为活跃", (_name, freshness) => {
    const source = freshSource();
    source.freshness = {
      ...source.freshness,
      ...freshness,
    };
    const record = projectHealthRecord(draft(source));
    expect(record.status).toBe("indeterminate");
    expect(record.indeterminateReason).toContain(`来源新鲜度为 ${freshness.state}`);
  });

  it("将未来的来源时间戳视为矛盾，而不是新鲜", () => {
    expect(deriveHealthSourceFreshness({
      evaluatedAt: "2026-09-03T00:30:00Z",
      newestSourceAt: "2026-09-03T00:31:00Z",
      maxAgeSeconds: 3_600,
    })).toMatchObject({ state: "contradictory", ageSeconds: 0 });
  });

  it.each([
    ["缺少时间戳", freshSource([queueEvidence(0, null)]), "缺少观测时间戳"],
    ["窗口外证据", freshSource([queueEvidence(0, "2026-09-02T23:59:59Z")]), "没有来源证据"],
    ["结果限制", boundHealthEvidence(
      [queueEvidence(0), queueEvidence(1, "2026-09-03T00:31:00Z")],
      { ...QUERY, limit: 1 },
      deriveHealthSourceFreshness({
        evaluatedAt: QUERY.endedAt,
        newestSourceAt: "2026-09-03T00:31:00Z",
        maxAgeSeconds: 3_600,
      }),
    ), "结果上限"],
    ["来源不匹配", freshSource([adaptLifecycleReceiptEvidence({
      sourceOrder: 0,
      observedAt: "2026-09-03T00:30:00Z",
      receiptId: "receipt-a",
      operation: "handover",
      outcome: "complete",
    })]), "请求的适配器"],
    ["保留期缺口", boundHealthEvidence(
      [queueEvidence()],
      { ...QUERY, retentionSeconds: 60 },
      deriveHealthSourceFreshness({
        evaluatedAt: QUERY.endedAt,
        newestSourceAt: "2026-09-03T00:30:00Z",
        maxAgeSeconds: 3_600,
      }),
    ), "保留期未覆盖"],
  ])("将%s呈现为不确定", (_name, source, reason) => {
    const record = projectHealthRecord(draft(source));
    expect(record.status).toBe("indeterminate");
    expect(record.indeterminateReason).toContain(reason);
  });

  it("规范化每个已接受来源，且不写入、不重排", () => {
    const workDependencies = Object.freeze(["slice-a"]);
    const evidence = [
      queueEvidence(0),
      adaptWatchdogHistoryEvidence({
        historyId: "history-a",
        jobId: "job-a",
        evaluatedAt: "2026-09-03T00:31:00Z",
        outcome: "sent",
        deliveryStatus: "ok",
      }, 1),
      adaptWorkGraphEvidence({
        sourceOrder: 2,
        observedAt: "2026-09-03T00:32:00Z",
        nodeType: "slice",
        nodeId: "slice-b",
        missionId: "mission-a",
        stage: "wip",
        dependsOn: workDependencies,
      }),
      adaptTopologyActivityEvidence({
        logicalId: "seat-a",
        canonicalSessionName: "builder@rig",
        lastActivityAt: "2026-09-03T00:33:00Z",
        agentActivity: undefined,
        activityState: {
          activity: "working",
          display: "Working",
          needsInput: { count: 0, reason: null },
          decidedBy: "activity-oracle",
          seq: 7,
          lastSwap: null,
        },
      }, 3),
      adaptContextUsageEvidence("seat-a", {
        availability: "known",
        reason: null,
        source: "codex_token_count_jsonl",
        usedPercentage: 84,
        remainingPercentage: 16,
        contextWindowSize: 250_000,
        totalInputTokens: 210_000,
        totalOutputTokens: 3_000,
        currentUsage: "213000",
        transcriptPath: "/redacted/rollout.jsonl",
        sessionId: "session-a",
        sessionName: "builder@rig",
        sampledAt: "2026-09-03T00:34:00Z",
        fresh: true,
      }, 4),
      adaptOccupantModelEvidence({
        sourceOrder: 5,
        observedAt: "2026-09-03T00:35:00Z",
        nodeId: "seat-a",
        occupantGeneration: "generation-a",
        runtime: "codex",
        model: "gpt-test",
      }),
      adaptLifecycleReceiptEvidence({
        sourceOrder: 6,
        observedAt: "2026-09-03T00:36:00Z",
        receiptId: "receipt-a",
        operation: "handover",
        outcome: "complete",
      }),
    ] as const;

    const bounded = boundHealthEvidence(evidence, {
      ...QUERY,
      source: "mixed",
    }, deriveHealthSourceFreshness({
      evaluatedAt: QUERY.endedAt,
      newestSourceAt: "2026-09-03T00:36:00Z",
      maxAgeSeconds: 3_600,
    }));

    expect(bounded.evidence.map((item) => item.type)).toEqual([
      "queue-transition",
      "watchdog-history",
      "work-graph",
      "topology-activity",
      "context-usage",
      "occupant-model",
      "lifecycle-receipt",
    ]);
    expect(bounded.evidence.map((item) => item.sourceOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const projectedDependencies = bounded.evidence[2]?.type === "work-graph"
      ? bounded.evidence[2].dependsOn
      : [];
    expect(projectedDependencies).toEqual(workDependencies);
    expect(projectedDependencies).not.toBe(workDependencies);
    expect(workDependencies).toEqual(["slice-a"]);
  });

  it("投影发现前拒绝无效边界", () => {
    const freshness = deriveHealthSourceFreshness({
      evaluatedAt: QUERY.endedAt,
      newestSourceAt: "2026-09-03T00:30:00Z",
      maxAgeSeconds: 3_600,
    });
    expect(() => boundHealthEvidence([queueEvidence()], { ...QUERY, limit: 0 }, freshness)).toThrow(/正整数/);
    expect(() => boundHealthEvidence([queueEvidence()], {
      ...QUERY,
      startedAt: "2026-09-03T02:00:00Z",
    }, freshness)).toThrow(/不得晚于/);
  });

  it("不投影超出来源窗口的符合条件区间", () => {
    const record = projectHealthRecord({
      ...draft(),
      startedAt: "2026-09-02T23:59:59Z",
    });
    expect(record.status).toBe("indeterminate");
    expect(record.indeterminateReason).toContain("超出观测窗口");
  });
});

interface ReplayCorpus {
  schema: string;
  sourceCut: string;
  cases: {
    staleConductor: {
      transitionIds: number[];
      autoUnparks: Array<{ transitionId: number }>;
      clearingTransition: { transitionId: number; state: string; closureReason: string };
    };
    signedQuiescence: {
      authority: { effectCount: number; stopOnMismatch: boolean };
      protectedSeats: string[];
      inFlightHeavyProcesses: unknown[];
      independentEffects: unknown[];
    };
    scopeAdmissionCandidate: {
      scope: { type: string; projectId: string; missionId: string; sliceId: string };
      technicalReview: {
        candidate: string;
        base: string;
        reviewedAt: string;
        outcome: string;
        source: { artifact: string; sha256: string };
      };
      governingAuthorityEvidence: { availability: string };
    };
    naturalContextClear: {
      nativeResumeIdentity: string;
      observations: Array<{ sourceOrder: number; state: string; usedPercentageRange: number[] }>;
      stableSeatIdentity: boolean;
      inheritedQueueCustody: number;
      intervention: unknown;
    };
    ordinaryControls: Array<{ id: string }>;
  };
}

describe("0.5.9 版本重放语料库", () => {
  const raw = readFileSync(
    new URL("./fixtures/health-projection/release-0.5.9.json", import.meta.url),
    "utf8",
  );
  const corpus = JSON.parse(raw) as ReplayCorpus;

  it("将事实固定到精确的公开来源切点，且不包含预期检测器答案", () => {
    expect(corpus.schema).toBe("openrig.health-replay/v0alpha1");
    expect(corpus.sourceCut).toBe("dbf05f9d59ef3b0ae14fc00174c643df4858d45a");
    expect(raw).not.toContain("expectedFindings");
  });

  it("携带完整的指挥者区间及其显式清除转换", () => {
    const subject = corpus.cases.staleConductor;
    expect(subject.transitionIds).toHaveLength(257);
    expect(subject.transitionIds.slice(0, -1)).toHaveLength(256);
    expect(subject.transitionIds.every((id, index, ids) => index === 0 || id > ids[index - 1]!)).toBe(true);
    expect(subject.clearingTransition).toMatchObject({
      transitionId: subject.transitionIds.at(-1),
      state: "done",
      closureReason: "no-follow-on",
    });
    expect(subject.autoUnparks).toHaveLength(52);
    expect(subject.autoUnparks.every(({ transitionId }) => subject.transitionIds.includes(transitionId))).toBe(true);
    expect(subject.autoUnparks.every(({ transitionId }) => transitionId < subject.clearingTransition.transitionId)).toBe(true);
  });

  it("保持已签名静默与来源绑定的 S13 案例相互独立", () => {
    const clear = corpus.cases.signedQuiescence;
    expect(clear.authority).toMatchObject({ effectCount: 1, stopOnMismatch: true });
    expect(clear.protectedSeats).toHaveLength(16);
    expect(clear.inFlightHeavyProcesses).toEqual([]);
    expect(clear.independentEffects).toEqual([]);
    const s13 = corpus.cases.scopeAdmissionCandidate;
    expect(s13.scope).toEqual({
      type: "slice",
      projectId: "openrig",
      missionId: "release-0.5.9",
      sliceId: "OPR.0.5.9.13",
    });
    expect(s13.technicalReview).toEqual({
      candidate: "857d05a0dc91b0eb0793a475820b55255783ed48",
      base: "128e87deb9121e0bc038747f3b50a798c50186f2",
      reviewedAt: "2026-09-04T03:31:00Z",
      outcome: "CLEAR",
      source: {
        artifact: "state/review50/r059-s13-effective-model-identity-r2-CLEAR-857d05a0d-20260904.md",
        sha256: "c84a013b72a98d75249972b3a78e3e2a366a718d2488269c1da9e7f72de5d0ed",
      },
    });
    expect(s13.governingAuthorityEvidence.availability).toBe("unavailable");
  });

  it("将原生上下文清除表示为无需干预的稳定身份", () => {
    const subject = corpus.cases.naturalContextClear;
    expect(subject.nativeResumeIdentity).toBeTruthy();
    expect(subject.observations).toEqual([
      { sourceOrder: 0, state: "pressure", usedPercentageRange: [83, 85] },
      { sourceOrder: 1, state: "naturally-cleared", usedPercentageRange: [29, 31] },
    ]);
    expect(subject.stableSeatIdentity).toBe(true);
    expect(subject.inheritedQueueCustody).toBe(0);
    expect(subject.intervention).toBeNull();
  });

  it("包含普通健康、过期和不可用对照项", () => {
    expect(corpus.cases.ordinaryControls.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "single-proportional-review",
      "one-recovery-wake",
      "native-blocker-wake",
      "productive-volume",
      "stale-context",
      "unavailable-context",
    ]));
  });
});
