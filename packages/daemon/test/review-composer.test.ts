// Living Notes——组合器核心验收条件（OPR.0.4.4.20，按 2026-07-05 的纠正性重设计重建）。
//
// 此处每个测试都是规范验收条件，使用手工构造的输入驱动纯组合器（幂等性指序列化输出
// 逐字节相等——相同输入、相同字节）。单一结构契约本身也在测试范围内：已被取代的结构
//（sections / acceptance / compare / join / green）不得出现在组合输出中。

import { describe, it, expect } from "vitest";
import {
  composeDelivered,
  composeLineage,
  composeMissionReview,
  composeRecordedGreenForSlice,
  composeSliceReview,
  computeRecordedGreen,
  deriveCandidateSha,
  deriveGateCells,
  derivePhase,
  extractMediaRefs,
  extractMiniReqs,
  extractProofContract,
  extractSection,
  isPassing,
  parseC1Header,
  proofClaimsPass,
  sliceRelativeMediaPath,
  type MissionSliceEntry,
  type SliceComposeInputs,
} from "../src/domain/review/compose.js";
import type { ProofArtifact } from "../src/domain/review/types.js";

const NOW = "2026-07-04T10:00:00.000Z";

function artifact(over: Partial<ProofArtifact> & { artifactType: ProofArtifact["artifactType"] }): ProofArtifact {
  return {
    relPath: `proof/${over.artifactType}.md`,
    slice: "s-20",
    candidateSha: "cand1234",
    verdict: null,
    moneyEvidence: null,
    evidences: [],
    selfCheck: null,
    mediaRefs: [],
    droppedAt: "2026-07-04T09:00:00.000Z",
    ...over,
  };
}

function fullGate(overrides: Partial<Record<"guard" | "qa" | "rev1-r1" | "rev1-r2", ProofArtifact["verdict"] | undefined>> = {}): ProofArtifact[] {
  const base = { guard: "CLEAR", qa: "PASS", "rev1-r1": "CLEAR", "rev1-r2": "CLEAR" } as const;
  return (Object.keys(base) as Array<keyof typeof base>)
    .filter((r) => overrides[r] !== undefined ? overrides[r] !== null : true)
    .map((r) => artifact({ artifactType: r, verdict: (r in overrides ? overrides[r] : base[r]) as ProofArtifact["verdict"] }));
}

function baseInputs(over: Partial<SliceComposeInputs> = {}): SliceComposeInputs {
  return {
    slice: { name: "20-fixture", id: "OPR.T.20", title: "Fixture 切片", missionId: "release-t" },
    readme: "---\ntitle: t\n---\n\n# Fixture\n\n## Intent\n\n创始人的原话。\n",
    prd: "---\ntitle: t\n---\n\n## Mini-requirements\n\n1. 一个界面。\n2. 仅依据已记录的 QA 对比进行验证。\n\n# Spec\n\n正文。\n\n## Proof contract\n\n- [ ] 手机端流程视频\n- [ ] 范围探针 206\n",
    proofMd: null,
    artifacts: [],
    lockedArtifacts: [],
    mediaRefs: [],
    proofDirExists: true,
    attention: [],
    agents: [],
    activeQitemPresent: false,
    git: { mainTip: "tip99999", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 0 },
    approval: { spec: null, delivery: null },
    nowIso: NOW,
    ...over,
  };
}

const DELIVERY_STAMP = { by: "human@host", at: NOW, auditRowPresent: true };

describe("唯一结构（§3.1）——不保留任何已被取代的结构", () => {
  it("只组合 intent/plan/delivered——sections/acceptance/compare/join/green 键均不存在", () => {
    const r = composeSliceReview(baseInputs({ artifacts: fullGate() })) as unknown as Record<string, unknown>;
    for (const dead of ["sections", "acceptance", "compare", "join", "green", "locked"]) {
      expect(r, `已被取代的结构 '${dead}' 不得保留在契约中`).not.toHaveProperty(dead);
    }
    for (const alive of ["intent", "plan", "delivered", "needsYou", "agents", "lineage", "defects", "composedAt"]) {
      expect(r).toHaveProperty(alive);
    }
  });

  it("每个 section 始终参与组合，来源缺失时如实降级", () => {
    const r = composeSliceReview(baseInputs({ readme: null, prd: null }));
    expect(r.intent.text).toBeNull();
    expect(r.intent.degrade).toBe("未记录意图");
    expect(r.intent.ssotPath).toBeNull();
    expect(r.plan.concise.text).toBeNull();
    expect(r.plan.ssotPath).toBeNull();
    expect(r.delivered.items).toHaveLength(0);
  });
});

describe("C1 头部解析", () => {
  it("解析完整头部，并将集合外 verdict 视为 null（存在 != verdict）", () => {
    const good = parseC1Header(
      "---\nslice: s-20\ncandidate_sha: abc123\nartifact_type: qa\nverdict: PASS\nmoney_evidence: 一行证据\nevidences:\n  - 1\nself_check: 已检查\n---\n正文",
      "proof/qa.md",
      NOW,
    );
    expect(good.artifactType).toBe("qa");
    expect(good.verdict).toBe("PASS");
    expect(good.evidences).toEqual(["1"]);
    const bad = parseC1Header(
      "---\nslice: s\ncandidate_sha: abc\nartifact_type: qa\nverdict: PASSED\n---\n",
      "proof/qa.md",
      NOW,
    );
    expect(bad.verdict).toBeNull();
    const invalid = parseC1Header("完全没有 frontmatter", "proof/x.md", NOW);
    expect(invalid.artifactType).toBeNull();
  });

  it("捕获正文媒体引用（Markdown 图片 + video 标签），排除 http", () => {
    const a = parseC1Header(
      '---\nartifact_type: qa\nverdict: PASS\n---\n\n![shot](drawer-right.png)\n<video src="playing.webm"></video>\n![ext](https://x/y.png)\n',
      "proof/qa.md",
      NOW,
    );
    expect(a.mediaRefs).toEqual(["drawer-right.png", "playing.webm"]);
  });
});

describe("FR-2——通过映射 + 已记录 verdict", () => {
  it("精确固定 verdict 通过映射", () => {
    expect(isPassing("guard", "CLEAR")).toBe(true);
    expect(isPassing("guard", "PASS")).toBe(false);
    expect(isPassing("qa", "PASS")).toBe(true);
    expect(isPassing("qa", "CLEAR")).toBe(false);
    expect(isPassing("adjudication", "CLEAR")).toBe(true);
    expect(isPassing("adjudication", "PASS")).toBe(true);
    for (const t of ["guard", "qa", "rev1-r1", "rev1-r2", "adjudication"] as const) {
      expect(isPassing(t, "BLOCKING")).toBe(false);
      expect(isPassing(t, "CONCERNING")).toBe(false);
      expect(isPassing(t, "NOT-CLEAR")).toBe(false);
      expect(isPassing(t, null)).toBe(false);
    }
  });

  it("已记录 green（任务目标 ledger 事实）：regime 1 来自四个通过 verdict，regime 2 来自裁决", () => {
    expect(composeRecordedGreenForSlice(fullGate())).toEqual({ green: true, regime: 1 });
    const adj = artifact({ artifactType: "adjudication", verdict: "CLEAR", relPath: "proof/adjudication.md" });
    expect(composeRecordedGreenForSlice([adj])).toEqual({ green: true, regime: 2 });
    expect(composeRecordedGreenForSlice(fullGate({ "rev1-r2": "CONCERNING" }))).toEqual({ green: false, regime: null });
    expect(composeRecordedGreenForSlice([])).toEqual({ green: false, regime: null });
  });

  it("缺少一个 gate artifact 时，对应单元格为 missing", () => {
    const arts = fullGate().filter((a) => a.artifactType !== "rev1-r2");
    const r = composeSliceReview(baseInputs({ artifacts: arts }));
    const cell = r.lineage.gateCells.find((c) => c.role === "rev1-r2")!;
    expect(cell.state).toBe("missing");
    expect(cell.recordedToken).toBeNull();
  });

  it("未通过的 verdict 保留原始 token；批准印记绝不改变其颜色", () => {
    const arts = fullGate({ "rev1-r2": "CONCERNING" });
    const r = composeSliceReview(baseInputs({ artifacts: arts, approval: { spec: null, delivery: DELIVERY_STAMP } }));
    const cell = r.lineage.gateCells.find((c) => c.role === "rev1-r2")!;
    expect(cell.recordedToken).toBe("CONCERNING"); // 逐字保留——绝不折叠为 FAIL
    expect(cell.tone).toBe("fail"); // tone 独立派生
    expect(r.delivered.lock).not.toBeNull(); // 印记会渲染……
    expect(cell.state).toBe("non-passing"); // ……但 gate 单元格保留真实状态
    expect(computeRecordedGreen(r.lineage.gateCells, arts, "cand1234").green).toBe(false); // BR-6
  });

  it("仅在同一 (candidate, artifact_type) tuple 内采用最新项覆盖", () => {
    const early = artifact({ artifactType: "qa", verdict: "NOT-CLEAR", droppedAt: "2026-07-04T08:00:00.000Z", relPath: "proof/qa-1.md" });
    const later = artifact({ artifactType: "qa", verdict: "PASS", droppedAt: "2026-07-04T09:30:00.000Z", relPath: "proof/qa-2.md" });
    const cells = deriveGateCells([early, later, ...fullGate({ qa: undefined as never }).filter((a) => a.artifactType !== "qa")], "cand1234");
    expect(cells.find((c) => c.role === "qa")!.recordedToken).toBe("PASS");
    // 另一个候选项的更晚 artifact 不会覆盖。
    const otherSha = artifact({ artifactType: "qa", verdict: "NOT-CLEAR", candidateSha: "other999", droppedAt: "2026-07-04T09:45:00.000Z", relPath: "proof/qa-3.md" });
    const cells2 = deriveGateCells([later, otherSha], "cand1234");
    expect(cells2.find((c) => c.role === "qa")!.recordedToken).toBe("PASS");
  });

  it("PROOF.md 自称 PASS 但没有 gate artifact 时触发 confirm-faithful，绝不验证任何内容", () => {
    const r = composeSliceReview(baseInputs({ proofMd: "# Proof\n\nResult: PASS\n" }));
    const cf = r.needsYou.items.find((i) => i.leg === "confirm-faithful");
    expect(cf).toBeDefined();
    expect(cf!.summary).toBe("确认此证明真实可靠");
    expect(r.delivered.items.every((it) => it.verified === "missing")).toBe(true);
    // slice-04 REV6（qitem-20260722114922）：confirm-faithful evidenceRef 是切片相对引用
    //（EvidenceOpener 与其他 proof 引用一样，会拼接当前 slice-dir relPath）。它必须严格为
    // "PROOF.md"——若发出完整的任务目标相对路径 "<mission>/slices/<slice>/PROOF.md"，
    // opener 会重复拼接切片路径并返回 404。在 compose.ts 发出切片相对路径前，这是真正的 RED。
    expect(cf!.evidenceRef).toBe("PROOF.md");
  });

  it("待处理 PROOF.md 中偶然出现的 PASS 字样不算自我声明", () => {
    const pending = [
      "# Proof",
      "",
      "Closed by: OPEN — build handed to QA   Date: 2026-07-04   Verdict: PENDING",
      "",
      "- 遍历声称 PASS 的 fixture",
      "- rig scope audit PASS",
    ].join("\n");
    expect(proofClaimsPass(pending)).toBe(false);
    const r = composeSliceReview(baseInputs({ proofMd: pending }));
    expect(r.needsYou.items.find((i) => i.leg === "confirm-faithful")).toBeUndefined();
  });

  it("显式的 Closed by Verdict: PASS 算作 PROOF.md 自我声明", () => {
    expect(proofClaimsPass("Closed by: qa@rig   Date: 2026-07-04   Verdict: PASS")).toBe(true);
  });

  it("adjudication 为 CLEAR 时，重组后清除 confirm-faithful（regime 2）", () => {
    const adj = artifact({ artifactType: "adjudication", verdict: "CLEAR", relPath: "proof/adjudication.md" });
    const r = composeSliceReview(baseInputs({ proofMd: "Result: PASS\n", artifacts: [adj] }));
    expect(r.needsYou.items.find((i) => i.leg === "confirm-faithful")).toBeUndefined();
  });

  it("N1 lineage：三个事实始终存在；标签从合并状态派生", () => {
    const cells = deriveGateCells(fullGate(), "cand1234");
    const unmergedFresh = composeLineage("cand1234", { mainTip: "tip", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 1 }, cells);
    expect(unmergedFresh).toMatchObject({ candidateSha: "cand1234", mergeSha: null, mainTip: "tip", freshness: "fresh" });
    const unmergedStale = composeLineage("cand1234", { mainTip: "tip", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 12 }, cells);
    expect(unmergedStale.freshness).toBe("stale");
    expect(unmergedStale.staleBehind).toBe(12);
    const mergedFresh = composeLineage("cand1234", { mainTip: "tip", mergeSha: "merge55", mergeIsAncestorOfTip: true, candidateBehindTip: null }, cells);
    expect(mergedFresh.freshness).toBe("fresh");
    expect(mergedFresh.mergeSha).toBe("merge55");
  });
});

describe("§4——两个 lock（已发布的分阶段批准印记）", () => {
  it("plan.lock = spec 范围印记；delivered.lock = delivery 范围印记；二者独立", () => {
    const specOnly = composeSliceReview(
      baseInputs({ approval: { spec: { by: "planner@rig", at: "2026-07-03T00:00:00.000Z", auditRowPresent: true }, delivery: null } }),
    );
    expect(specOnly.plan.lock).toEqual({ by: "planner@rig", at: "2026-07-03T00:00:00.000Z", auditVerified: true });
    expect(specOnly.delivered.lock).toBeNull();
    expect(specOnly.phase).not.toBe("locked"); // 只有 delivery 印记会锁定

    const both = composeSliceReview(
      baseInputs({ approval: { spec: { by: "planner@rig", at: "2026-07-03T00:00:00.000Z", auditRowPresent: true }, delivery: DELIVERY_STAMP } }),
    );
    expect(both.delivered.lock).toEqual({ by: "human@host", at: NOW, auditVerified: true });
    expect(both.phase).toBe("locked");
  });

  it("未验证印记：没有匹配审计行时携带 auditVerified false——可见但绝不阻塞", () => {
    const r = composeSliceReview(
      baseInputs({ approval: { spec: null, delivery: { by: "s", at: NOW, auditRowPresent: false } } }),
    );
    expect(r.delivered.lock).toEqual({ by: "s", at: NOW, auditVerified: false });
    expect(r.phase).toBe("locked"); // 开放失败：印记仍然有效；渲染会标出它
  });

  it("lockedArtifacts 作为固定计划集原样传递；媒体类型条目显示在 plan media 中", () => {
    const r = composeSliceReview(
      baseInputs({
        lockedArtifacts: [
          { name: "PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" },
          { name: "抽屉模型", path: "mockups/drawer-right.png", kind: "mockup" },
        ],
      }),
    );
    expect(r.plan.lockedArtifacts).toHaveLength(2);
    expect(r.plan.concise.media).toContainEqual({ kind: "image", src: "mockups/drawer-right.png", caption: "mockups/drawer-right.png" });
  });
});

describe("FR-1——原样 intent、section 媒体、幂等性", () => {
  it("组合两次的字节完全一致（纯核心，视图时间事实作为输入）", () => {
    const inputs = baseInputs({ artifacts: fullGate(), proofMd: "PASS" });
    const a = JSON.stringify(composeSliceReview(inputs));
    const b = JSON.stringify(composeSliceReview(inputs));
    expect(a).toBe(b);
  });

  it("投影与源 section 字符完全一致的 INTENT 及其媒体", () => {
    const r = composeSliceReview(
      baseInputs({ readme: "---\nt: x\n---\n\n## Intent\n\n创始人的原话。\n\n![sketch](sketch.png)\n" }),
    );
    expect(r.intent.text).toContain("创始人的原话。");
    expect(r.intent.media).toEqual([{ kind: "image", src: "sketch.png", caption: "sketch.png" }]);
    expect(r.intent.ssotPath).toBe("release-t/slices/20-fixture/README.md");
  });

  it("C7 固定名称处没有 PRD 时，plan 降级为空文本且不合成任何内容", () => {
    const r = composeSliceReview(baseInputs({ prd: null }));
    expect(r.plan.concise.text).toBeNull();
    expect(r.plan.ssotPath).toBeNull();
  });

  it("绝对媒体路径会显示为缺陷发现", () => {
    const r = composeSliceReview(baseInputs({ mediaRefs: ["/abs/path/shot.png", "proof/ok.png"] }));
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0]).toContain("/abs/path/shot.png");
  });

  it("路径穿越媒体引用会显示为越界缺陷发现（rev1 回修）", () => {
    const r = composeSliceReview(
      baseInputs({ mediaRefs: ["../sibling/shot.png", "proof/sub/../../../x.png", "proof/ok..png", "proof/fine.png"] }),
    );
    expect(r.defects).toHaveLength(2); // 仅将 ".." 路径段视为穿越——"ok..png" 是文件名，不是穿越
    expect(r.defects[0]).toContain("../sibling/shot.png");
    expect(r.defects[1]).toContain("proof/sub/../../../x.png");
  });

  it("越出切片目录的 artifact 媒体会成为缺陷发现，绝不静默筛选", () => {
    const qa = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "已检查", mediaRefs: ["../../outside.png", "in-proof.png"] });
    const r = composeSliceReview(baseInputs({ artifacts: [qa] }));
    expect(r.defects.some((d) => d.includes("../../outside.png"))).toBe(true);
    const item = r.delivered.items[0]!;
    expect(item.proof).toEqual([{ kind: "image", src: "proof/in-proof.png", caption: "in-proof.png" }]);
  });
});

describe("FR-3——五类派生阶段，自上而下确定优先级", () => {
  // release-0.4.7 intent-stage：重塑信号结构（prdPresent → prdAuthored；
  // proofArtifactPresent → realProofArtifactsPresent；新增 specLocked）。仍采用相同的五类
  // 优先级；building 通道现在需要真实 artifact，或（qitem 且规范已编写/已锁定）。
  const NONE = { prdAuthored: false, realProofArtifactsPresent: false, activeQitemPresent: false, verdictOrEvidenceSetPresent: false, specLocked: false, approved: false };

  it("仅依据层完整性派生每个阶段", () => {
    expect(derivePhase({ ...NONE })).toBe("intent");
    expect(derivePhase({ ...NONE, prdAuthored: true })).toBe("spec");
    expect(derivePhase({ ...NONE, prdAuthored: true, activeQitemPresent: true })).toBe("building");
    expect(derivePhase({ ...NONE, prdAuthored: true, realProofArtifactsPresent: true, verdictOrEvidenceSetPresent: true })).toBe("review");
    expect(derivePhase({ ...NONE, prdAuthored: true, realProofArtifactsPresent: true, verdictOrEvidenceSetPresent: true, approved: true })).toBe("locked");
  });

  it("单独的跟踪 qitem 属于协作而非构建（AR-3）", () => {
    expect(derivePhase({ ...NONE, activeQitemPresent: true })).toBe("intent");
    expect(derivePhase({ ...NONE, activeQitemPresent: true, specLocked: true })).toBe("building");
    expect(derivePhase({ ...NONE, activeQitemPresent: true, prdAuthored: true })).toBe("building");
  });

  it("仅 specLocked 会提升为 spec（按授权视为已编写）；仅真实 artifact 会进入 building", () => {
    expect(derivePhase({ ...NONE, specLocked: true })).toBe("spec");
    expect(derivePhase({ ...NONE, realProofArtifactsPresent: true })).toBe("building");
  });

  it("一个信号同时满足两个通道时按优先级确定性解析", () => {
    const s = { ...NONE, prdAuthored: true, realProofArtifactsPresent: true, verdictOrEvidenceSetPresent: true };
    expect(derivePhase(s)).toBe("review");
    expect(derivePhase(s)).toBe(derivePhase({ ...s }));
  });

  it("将阶段映射到 SS14 通道词汇", () => {
    const r = composeSliceReview(baseInputs({ prd: null, readme: null }));
    expect(r.phase).toBe("intent");
    expect(r.laneLabel).toBe("INTENT");
    const spec = composeSliceReview(baseInputs());
    expect(spec.laneLabel).toBe("PLAN");
  });
});

describe("§3.1 DELIVERED——重新设计的关联（planned ↔ 精选证明 ↔ verified）", () => {
  const promised = extractProofContract(baseInputs().prd);

  it("verified 要求已记录且通过的 QA 对比（self_check + 通过 verdict），不能只凭存在性", () => {
    const qa = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "已观察其运行", mediaRefs: ["playing.webm"] });
    const d = composeDelivered(promised, [qa]);
    expect(d.items[0]).toMatchObject({ verified: "verified", note: "旧版已记录验证（未绑定条目修订）。已观察其运行" });
    expect(d.items[0]!.proof).toEqual([{ kind: "video", src: "proof/playing.webm", caption: "playing.webm" }]);
    expect(d.items[1]).toMatchObject({ verified: "missing" });
    expect(d.missingCount).toBe(1);
  });

  it("同一候选项收到 NOT-CLEAR 后不保留旧 PASS 验证", () => {
    const pass = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "已观察承诺的结果", droppedAt: "2026-07-04T08:00:00Z" });
    const correction = artifact({ artifactType: "qa", verdict: "NOT-CLEAR", evidences: ["1"], selfCheck: "结果未通过对比", droppedAt: "2026-07-04T09:00:00Z", relPath: "proof/correction.md" });
    expect(composeDelivered(promised, [pass]).items[0]!.verified).toBe("verified");
    expect(composeDelivered(promised, [pass, correction]).items[0]).toMatchObject({ verified: "unverified", note: "结果未通过对比" });
  });

  it("将旧版胜出项和修正限制在各自条目与候选项内", () => {
    const first = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], candidateSha: "first-cut", selfCheck: "第一项结果", droppedAt: "2026-07-04T08:00:00Z", relPath: "proof/first.md" });
    const second = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["2"], candidateSha: "second-cut", selfCheck: "第二项结果", droppedAt: "2026-07-04T09:00:00Z", relPath: "proof/second.md" });
    const correction = artifact({ ...second, verdict: "NOT-CLEAR", selfCheck: "第二项失败", droppedAt: "2026-07-04T10:00:00Z", relPath: "proof/correction.md" });
    expect(composeDelivered(promised, [first, second]).items.map(i => i.verified)).toEqual(["verified", "verified"]);
    const corrected = composeDelivered(promised, [first, second, correction]).items;
    expect(corrected.map(i => i.verified)).toEqual(["verified", "unverified"]);
    expect(corrected[0]!.note).toContain("第一项结果");
    expect(corrected[1]!.note).toBe("第二项失败");
  });

  it("覆盖 artifact 没有已记录对比时，条目保持 unverified——可见但不阻塞", () => {
    const guardArt = artifact({ artifactType: "guard", verdict: "CLEAR", evidences: ["范围探针 206"] });
    const d = composeDelivered(promised, [guardArt]);
    expect(d.items[1]!.verified).toBe("unverified"); // 非 QA artifact 类型绝不能完成验证
    const qaNoSelfCheck = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"] });
    expect(composeDelivered(promised, [qaNoSelfCheck]).items[0]!.verified).toBe("unverified");
  });

  it("QA 的退回原因会显示，而未通过的对比保持 unverified", () => {
    const kicked = artifact({ artifactType: "qa", verdict: "BLOCKING", evidences: ["1"], selfCheck: "模型显示抽屉从右侧打开，但构建产物从左侧打开——已退回" });
    const d = composeDelivered(promised, [kicked]);
    expect(d.items[0]!.verified).toBe("unverified");
    expect(d.items[0]!.note).toContain("已退回");
  });

  it("按精确文本及从 1 开始的索引匹配 evidences 引用", () => {
    const byText = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["范围探针 206"], selfCheck: "已看到 206" });
    const d = composeDelivered(promised, [byText]);
    expect(d.items[1]!.verified).toBe("verified");
    expect(d.items[0]!.verified).toBe("missing");
  });

  it("未声明契约时条目数与缺失数均为零（绝不轻率判定充分，也不虚构行）", () => {
    const d = composeDelivered([], [artifact({ artifactType: "qa", verdict: "PASS", mediaRefs: ["x.png"] })]);
    expect(d.items).toHaveLength(0);
    expect(d.missingCount).toBe(0);
    expect(d.extraProof).toEqual([{ kind: "image", src: "proof/x.png", caption: "x.png" }]); // §6：显示在自己的标签下
  });

  it("未映射的 artifact 媒体以有界 extraProof 渲染——可见但绝不堆入主视图", () => {
    const stray = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["完全不同的内容"], mediaRefs: ["stray.png"] });
    const d = composeDelivered(promised, [stray]);
    expect(d.extraProof).toEqual([{ kind: "image", src: "proof/stray.png", caption: "stray.png" }]);
    expect(d.items.every((it) => it.proof.length === 0)).toBe(true);
  });

  it("plannedRef：契约行中的 Markdown 图片会将模型与交付项配对", () => {
    const prd = "## Proof contract\n\n- [ ] 抽屉从右侧打开 ![mockup](mockups/drawer.png)\n- [ ] 范围探针 206\n";
    const items = extractProofContract(prd);
    // VM-006：`rawText` 携带编写的字节（保留图片标记），`text` 则移除图片——
    // Progress↔Review 关联和 DELIVERED 渲染分别读取这两个载体。
    expect(items[0]).toEqual({
      text: "抽屉从右侧打开",
      rawText: "抽屉从右侧打开 ![mockup](mockups/drawer.png)",
      plannedRef: "mockups/drawer.png",
    });
    const d = composeDelivered(items, []);
    expect(d.items[0]!.promised.plannedRef).toEqual({ kind: "image", src: "mockups/drawer.png", caption: "mockups/drawer.png" });
    expect(d.items[1]!.promised.plannedRef).toBeUndefined();
  });

  it("精选证明集会去重，并按最新 artifact 优先排序", () => {
    const older = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "v1", mediaRefs: ["a.png", "b.png"], droppedAt: "2026-07-04T08:00:00.000Z", relPath: "proof/qa-1.md" });
    const newer = artifact({ artifactType: "qa", verdict: "PASS", evidences: ["1"], selfCheck: "v2——规范集合", mediaRefs: ["b.png", "c.png"], droppedAt: "2026-07-04T09:30:00.000Z", relPath: "proof/qa-2.md" });
    const d = composeDelivered(promised, [older, newer]);
    expect(d.items[0]!.proof.map((p) => p.src)).toEqual(["proof/b.png", "proof/c.png", "proof/a.png"]);
    expect(d.items[0]!.note).toBe("旧版已记录验证（未绑定条目修订）。v2——规范集合"); // 最新记录的对比决定 note
  });

  it("根据 delivered.items 的 MISSING 数量提供 ▲ insufficient-proof 信号（§11 重新绑定）", () => {
    const r = composeSliceReview(baseInputs()); // 已声明契约，但未交付任何内容
    const insufficient = r.needsYou.items.find((i) => i.derived?.kind === "insufficient-proof");
    expect(insufficient).toBeDefined();
    expect(insufficient!.derived!.evidence).toContain("2 个承诺交付项中有 2 个");
    expect(insufficient!.derived!.threshold).toBe("delivered.items 的 MISSING 数量 > 0");
  });

  it("proof/ 存在时 proofDirPath 是深入入口，否则为 null", () => {
    expect(composeSliceReview(baseInputs()).delivered.proofDirPath).toBe("release-t/slices/20-fixture/proof");
    expect(composeSliceReview(baseInputs({ proofDirExists: false })).delivered.proofDirPath).toBeNull();
  });
});

describe("Markdown 结构与媒体提取", () => {
  it("提取 section、mini-reqs、证明契约和媒体引用", () => {
    const prd = baseInputs().prd!;
    expect(extractMiniReqs(prd)).toContain("1. 一个界面。");
    expect(extractProofContract(prd).map((p) => p.text)).toEqual(["手机端流程视频", "范围探针 206"]);
    expect(extractSection("## A\n\n正文 a\n\n## B\n\n正文 b", "B")).toBe("正文 b");
    expect(extractSection(null, "A")).toBeNull();
    expect(extractMediaRefs('x ![a](a.png) y <video src="v.mp4"> z ![h](http://x/h.png)')).toEqual(["a.png", "v.mp4"]);
  });

  it("切片相对路径规范化：拼接 proof 相对引用；越界时返回 null", () => {
    expect(sliceRelativeMediaPath("shot.png", "proof")).toBe("proof/shot.png");
    expect(sliceRelativeMediaPath("../mockups/m.png", "proof")).toBe("mockups/m.png");
    expect(sliceRelativeMediaPath("../../out.png", "proof")).toBeNull();
    expect(sliceRelativeMediaPath("/abs.png", "proof")).toBeNull();
    expect(sliceRelativeMediaPath("sketch.png", "")).toBe("sketch.png");
  });
});

describe("FR-7——任务目标组合（ledger 保留已记录 verdict 的 green）", () => {
  function entry(name: string, over: Partial<SliceComposeInputs> = {}): MissionSliceEntry {
    const inputs = baseInputs({ slice: { name, id: null, title: name, missionId: "m" }, ...over });
    return { review: composeSliceReview(inputs), green: composeRecordedGreenForSlice(inputs.artifacts).green };
  }

  it("ledger 是对切片集合的查询——跟踪缺口重放会渲染所有切片", () => {
    const slices = [
      entry("s1", { artifacts: fullGate(), git: { mainTip: "tip", mergeSha: "m1", mergeIsAncestorOfTip: true, candidateBehindTip: null } }),
      entry("s2", { artifacts: fullGate(), git: { mainTip: "tip", mergeSha: "m2", mergeIsAncestorOfTip: true, candidateBehindTip: null } }),
      entry("s3", { artifacts: fullGate(), git: { mainTip: "tip", mergeSha: "m3", mergeIsAncestorOfTip: true, candidateBehindTip: null } }),
      entry("s4"),
    ];
    const m = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices, missionAttention: [], agents: [], nowIso: NOW });
    expect(m.ledger).toHaveLength(4); // 结构上防止遗漏
    expect(m.ledger.filter((r) => r.green)).toHaveLength(3);
  });

  it("cut-complete 要求每个切片均为 green、已合并且 needs-human 为零", () => {
    const greenUnmerged = entry("s1", { artifacts: fullGate() }); // green 但未合并
    const m1 = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [greenUnmerged], missionAttention: [], agents: [], nowIso: NOW });
    expect(m1.cutComplete).toBe(false); // 已证明但未合并，不是 cut-complete
    const greenMerged = entry("s1", {
      artifacts: fullGate(),
      git: { mainTip: "tip", mergeSha: "m1", mergeIsAncestorOfTip: true, candidateBehindTip: null },
      prd: baseInputs().prd!.replace("## Proof contract\n\n- [ ] 手机端流程视频\n- [ ] 范围探针 206\n", ""),
    });
    const m2 = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [greenMerged], missionAttention: [], agents: [], nowIso: NOW });
    expect(greenMerged.review.needsYou.items).toHaveLength(0);
    expect(m2.cutComplete).toBe(true);
  });

  it("看板单元格重新绑定到折叠后的契约：n/m 来自已交付条目，印记来自 lock", () => {
    const building = entry("s1", { activeQitemPresent: true, artifacts: [artifact({ artifactType: "qa", verdict: null, evidences: ["1"], relPath: "proof/wip.md" })] });
    const m = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [building], missionAttention: [], agents: [], nowIso: NOW });
    expect(m.board[0]!.stageCell).toBe("1/2 个证明");
    const specStamped = entry("s2", { artifacts: [], approval: { spec: { by: "p", at: "2026-07-03T00:00:00.000Z", auditRowPresent: true }, delivery: null }, proofMd: null });
    const m2 = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [specStamped], missionAttention: [], agents: [], nowIso: NOW });
    expect(m2.board[0]!.stageCell).toBe("规格已批准 2026-07-03T00:00:00.000Z");
  });

  it("任务目标 NEEDS YOU 是不同身份的并集——从 N 个高度看到一个条目，而不是 N 个条目", () => {
    const s1 = entry("s1"); // 携带 insufficient-proof ▲
    const m = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [s1, s1], missionAttention: [], agents: [], nowIso: NOW });
    const ids = m.needsYou.items.map((i) => i.identity);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("空任务目标如实渲染零状态来源", () => {
    const m = composeMissionReview({ mission: { name: "m", id: null, title: "m" }, slices: [], missionAttention: [], agents: [], nowIso: NOW });
    expect(m.board).toHaveLength(0);
    expect(m.cutComplete).toBe(false);
    expect(m.needsYou.provenance).toContain("0 个待关注项");
  });
});

describe("候选项派生", () => {
  it("采用最新落盘 gate artifact 的 candidate_sha，并忽略 adjudication", () => {
    const arts = [
      artifact({ artifactType: "guard", verdict: "CLEAR", candidateSha: "old1", droppedAt: "2026-07-04T07:00:00.000Z", relPath: "proof/g1.md" }),
      artifact({ artifactType: "qa", verdict: "PASS", candidateSha: "new2", droppedAt: "2026-07-04T09:00:00.000Z", relPath: "proof/q2.md" }),
      artifact({ artifactType: "adjudication", verdict: "CLEAR", candidateSha: "adj3", droppedAt: "2026-07-04T09:30:00.000Z", relPath: "proof/a3.md" }),
    ];
    expect(deriveCandidateSha(arts)).toBe("new2");
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 intent-stage/scaffold-projection——T2（仅占位契约 → []）、
// T3（regime 矩阵，组合器层级）、T7（字节身份例外，compose 半侧）。
//
// Fixture 从模板派生：由真实 CLI 渲染器生成（与 scope-audit-parity.test.ts 完全相同地
// 动态导入），因此模板漂移会如实使这些测试失败。原始 `zrig scope slice create` 输出是
// 规范的 intent-stage fixture。
// ---------------------------------------------------------------------------

import * as nodePath from "node:path";
import { beforeAll as beforeAllIntent } from "vitest";

const INTENT_REPO_ROOT = nodePath.resolve(import.meta.dirname, "..", "..", "..");

interface PristineFixture {
  readme: string;
  prd: string;
  proof: string;
}

let pristine: PristineFixture;

beforeAllIntent(async () => {
  const mod = await import(
    nodePath.join(INTENT_REPO_ROOT, "packages/cli/src/lib/scope/templates.ts")
  );
  const opts = {
    id: "OPR.T.99",
    slice_number: "99",
    slug: "pristine",
    mission: "release-t",
    title: "原始状态",
    created_date: "2026-07-11",
  };
  pristine = {
    readme: mod.renderSliceTemplate("placeholder", opts),
    prd: mod.renderImplementationPrdTemplate(opts),
    proof: mod.renderSliceProofTemplate({ id: "OPR.T.99", title: "原始状态" }),
  };
});

describe("T2——extractProofContract 过滤 scaffold 占位符", () => {
  it("原始模板 PRD 的契约提取结果为 []（仅占位符）", () => {
    expect(extractProofContract(pristine.prd)).toEqual([]);
  });

  it("已编写行在占位符旁逐字节保留；方括号边界文本也会保留", () => {
    const prd = pristine.prd.replace(
      /^##\s+(?:Proof contract|证明契约|证据约定)\s*$/m,
      "## 证明契约\n\n- [ ] 手机端流程视频\n- [ ] [P0] 交付抽屉",
    );
    const items = extractProofContract(prd);
    expect(items.map((i) => i.text)).toEqual(["手机端流程视频", "[P0] 交付抽屉"]);
  });

  it("原始模板 PROOF.md 不会声明通过（verdict 是占位符）", () => {
    expect(proofClaimsPass(pristine.proof)).toBe(false);
  });
});

describe("T3——regime 矩阵（保留多 regime，不折叠）", () => {
  function pristineInputs(over: Partial<SliceComposeInputs> = {}): SliceComposeInputs {
    return baseInputs({
      readme: pristine.readme,
      prd: pristine.prd,
      proofMd: pristine.proof,
      proofDirExists: true,
      ...over,
    });
  }

  it("第 1 行：原始 scaffold + 跟踪 qitem → INTENT，并如实保留三个空值", () => {
    const r = composeSliceReview(pristineInputs({ activeQitemPresent: true }));
    expect(r.phase).toBe("intent");
    // DELIVERED 如实为空（VM-002）：不保留占位承诺。
    expect(r.delivered.items).toHaveLength(0);
    // PLAN 如实为空（S5 合入）：仅含占位符的 mini-reqs 渲染为未规划。
    expect(r.plan.concise.text).toBeNull();
  });

  it("第 2 行：原始 scaffold + 零个 qitem → INTENT", () => {
    expect(composeSliceReview(pristineInputs()).phase).toBe("intent");
  });

  it("第 3 行：已编写 PRD + qitem + 无 plan-lock → BUILDING（prdAuthored 支路）", () => {
    const r = composeSliceReview(baseInputs({ activeQitemPresent: true }));
    expect(r.phase).toBe("building");
  });

  it("第 4 行：plan 已锁定的原始状态 + qitem → BUILDING（specLocked 支路——按授权视为已编写）", () => {
    const r = composeSliceReview(
      pristineInputs({ activeQitemPresent: true, approval: { spec: DELIVERY_STAMP, delivery: null } }),
    );
    expect(r.phase).toBe("building");
  });

  it("第 5 行：带 verdict 的 PROOF.md → REVIEW（层级逻辑不变——保持非目标）", () => {
    const r = composeSliceReview(
      pristineInputs({ proofMd: "Closed by: qa@rig   Date: 2026-07-11   Verdict: PASS\n\n已证明。\n" }),
    );
    expect(r.phase).toBe("review");
  });

  it("第 6 行：真实 C1 落盘使原始 scaffold 离开 INTENT（BUILDING/REVIEW）", () => {
    const r = composeSliceReview(pristineInputs({ artifacts: [artifact({ artifactType: "qa" })] }));
    expect(["building", "review"]).toContain(r.phase);
  });

  it("第 7 行：已编写 mini-reqs + 仅占位契约 → SPEC 且渲染 PLAN 文本（独立 section）", () => {
    const prd = pristine.prd.replace(
      /^1\. \[.*\]$/m,
      "1. 一个真实可观察的结果。",
    );
    const r = composeSliceReview(pristineInputs({ prd }));
    expect(r.phase).toBe("spec");
    expect(r.plan.concise.text).toContain("1. 一个真实可观察的结果。");
    expect(r.delivered.items).toHaveLength(0);
  });

  it("第 3b 行：单独的跟踪 qitem 没有已编写/已锁定规范时属于协作而非构建 → INTENT", () => {
    const r = composeSliceReview(pristineInputs({ activeQitemPresent: true, proofMd: null }));
    expect(r.phase).toBe("intent");
  });
});

describe("T7——字节身份例外（compose 半侧）：已编写切片保持相同投影", () => {
  it("完整编写的 fixture 保持变更前的精确投影", () => {
    const r = composeSliceReview(baseInputs());
    expect(r.phase).toBe("spec");
    expect(r.delivered.items.map((i) => i.promised.text)).toEqual(["手机端流程视频", "范围探针 206"]);
    expect(r.plan.concise.text).toContain("1. 一个界面。");
    expect(r.plan.concise.text).toContain("2. 仅依据已记录的 QA 对比进行验证。");
    expect(r.intent.text).toContain("创始人的原话。");
  });

  it("带 artifact + qitem 的已编写切片保持其阶段行为", () => {
    expect(composeSliceReview(baseInputs({ activeQitemPresent: true })).phase).toBe("building");
    expect(composeSliceReview(baseInputs({ artifacts: fullGate() })).phase).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// release-0.4.7 占位符抑制完整性——T-B1（INTENT section：仅占位符时投影现有如实降级；
// 已编写 intent 逐字节一致）+ T-C compose 支路（仅散文/项目符号 mini-reqs 的抑制固定点——
// 断言已发布的 b8c11535 行为，预期行为变化为零）。
// ---------------------------------------------------------------------------

describe("T-B1——仅含占位符的 INTENT 投影如实降级（micro-bundle B）", () => {
  it("当前 scaffold 携带已编写的默认 intent", () => {
    const r = composeSliceReview(baseInputs({ readme: pristine.readme, prd: pristine.prd, proofMd: pristine.proof }));
    expect(r.intent.text).toBe("原始状态");
    expect(r.intent.degrade).toBeNull();
  });

  it("两行 `[a]\\n[b]` 占位 Intent → 降级（逐行块语法）", () => {
    const readme = "---\ntitle: t\n---\n\n# F\n\n## Intent\n\n[a]\n[b]\n";
    const r = composeSliceReview(baseInputs({ readme }));
    expect(r.intent.text).toBeNull();
    expect(r.intent.degrade).toBe("未记录意图");
  });

  it("已编写 intent 逐字节一致地投影（例外——过滤器绝不吞掉真实 intent）", () => {
    const r = composeSliceReview(baseInputs());
    expect(r.intent.text).toContain("创始人的原话。");
    expect(r.intent.degrade).toBeNull();
    const mixed = composeSliceReview(baseInputs({ readme: baseInputs().readme!.replace("创始人的原话。", "[看似方括号占位] 但后面是已编写文本") }));
    expect(mixed.intent.text).toContain("[看似方括号占位] 但后面是已编写文本");
  });

  it("Intent section 缺失时保持自身状态（null → 相同降级，契约不变）", () => {
    const r = composeSliceReview(baseInputs({ readme: "---\nt: 1\n---\n\n# F\n\n此处没有 intent 标题\n" }));
    expect(r.intent.text).toBeNull();
    expect(r.intent.degrade).toBe("未记录意图");
  });
});

describe("T-C——仅散文/项目符号 mini-reqs 的抑制固定点（reviewer-L1 裁定；已发布行为）", () => {
  it("仅散文 mini-reqs → PLAN“— 尚未规划”（简洁文本为 null）", () => {
    const prd = "## Mini-requirements\n\n只有散文，没有编号层级。\n\n## Proof contract\n\n- [ ] 真实条目\n";
    const r = composeSliceReview(baseInputs({ prd }));
    expect(r.plan.concise.text).toBeNull();
  });

  it("仅项目符号 mini-reqs → 简洁文本为 null", () => {
    const prd = "## Mini-requirements\n\n- 项目一\n- 项目二\n\n## Proof contract\n\n- [ ] 真实条目\n";
    const r = composeSliceReview(baseInputs({ prd }));
    expect(r.plan.concise.text).toBeNull();
  });

  it("混合散文 + 一个已编写编号项 → 渲染", () => {
    const prd = "## Mini-requirements\n\n上下文散文。\n\n1. 一个真实结果。\n\n## Proof contract\n\n- [ ] 真实条目\n";
    const r = composeSliceReview(baseInputs({ prd }));
    expect(r.plan.concise.text).toContain("1. 一个真实结果。");
  });
});

// ---------------------------------------------------------------------------
// PM dogfood #1（qitem-20260720015700-630eef64）——Review 投影：当对应 PRD section
// 仅为原始 scaffold 时，已编写的 README 约定 section 必须投影到 PLAN/DELIVERED。
// 已编写 PRD 仍是规范来源。逐 section 选择，绝不读取生命周期状态。
// ---------------------------------------------------------------------------

describe("PM dogfood #1——compose 以已编写 README section 覆盖原始 PRD section", () => {
  const AUTHORED_README = [
    "---",
    "id: OPR.99.0.2.1",
    "status: placeholder",
    "---",
    "",
    "# 切片 01——占位符约定",
    "",
    "## Intent",
    "",
    "让审阅标签页如实呈现",
    "",
    "## Mini-requirements",
    "",
    "1. 第一条已编写需求",
    "2. 第二条已编写需求",
    "",
    "## Proof contract",
    "",
    "- [ ] 已编写交付项一——已捕获",
    "- [ ] 已编写交付项二——已捕获",
  ].join("\n");

  it("原始 PRD + 已编写 README：PLAN 渲染已编写 mini-reqs；DELIVERED 关联已编写契约；ssotPath 指向 README；phase 派生为 spec", () => {
    // pristine.prd = 真实渲染器输出（文件范围的 intent-stage fixture）。
    const r = composeSliceReview(baseInputs({ readme: AUTHORED_README, prd: pristine.prd }));
    expect(r.plan.concise.text).not.toBeNull(); // 修复前为 RED：无投影
    expect(r.plan.concise.text!).toContain("第一条已编写需求");
    expect(r.delivered.items.map((i) => i.promised.text)).toEqual([
      "已编写交付项一——已捕获",
      "已编写交付项二——已捕获",
    ]);
    expect(r.plan.ssotPath?.endsWith("README.md")).toBe(true);
    // 单次解析固定点：同一选定解析同时驱动渲染与信号——已编写结构化需求会被投影，
    // 因此派生阶段为 spec（这只是投影；选择过程不读写任何存储状态）。
    expect(r.phase).toBe("spec");
  });

  it("固定点：即使 README section 也以不同内容编写，已编写 PRD 仍为规范来源", () => {
    const r = composeSliceReview(baseInputs({ readme: AUTHORED_README })); // baseInputs 的默认 prd 已编写
    expect(r.plan.concise.text).not.toBeNull();
    expect(r.plan.concise.text!).toContain("一个界面。");
    expect(r.plan.concise.text!).not.toContain("第一条已编写需求");
    expect(r.delivered.items.map((i) => i.promised.text)).toEqual([
      "手机端流程视频",
      "范围探针 206",
    ]);
    expect(r.plan.ssotPath?.endsWith("IMPLEMENTATION-PRD.md")).toBe(true);
  });

  it("状态不变性：README frontmatter 的 status 为 placeholder 或 planned 时投影一致", () => {
    const asPlanned = AUTHORED_README.replace("status: placeholder", "status: planned");
    const a = composeSliceReview(baseInputs({ readme: AUTHORED_README, prd: pristine.prd }));
    const b = composeSliceReview(baseInputs({ readme: asPlanned, prd: pristine.prd }));
    expect(b.plan).toEqual(a.plan);
    expect(b.delivered).toEqual(a.delivered);
    expect(b.phase).toEqual(a.phase);
  });
});

// ---------------------------------------------------------------------------
// qitem-render-driver B——复选框续行在 UI 看到载荷之前被丢弃
//（QA：DELIVERED 字符串在续行边界截断，与 CSS 溢出无关）。
//
// 根因：extractProofContract 遍历 body.split("\n") 并匹配单行
//（/^\s*-?\s*\[( |x|X)\]\s+(.+)$/），因此复选框的缩进续行会被丢弃。
//
// 此处固定的契约（经守卫修正）：共享 logical-checkbox 记录携带
// {checked, rawText, sourceLine}；rawText 使用恰好一个 U+0020 拼接符合条件的缩进续行，
// 并作为 VM-006 关联键；compose 从 rawText 派生展示文本/plannedRef。符合条件的续行必须
// 非空、非复选框，且缩进严格深于复选框行。下一个复选框、空行或相同/更浅缩进的散文会
// 终止当前条目。sourceLine 始终指向复选框行。
// ---------------------------------------------------------------------------

describe("qitem-render-driver B——证明契约续行合并为一个逻辑条目", () => {
  const contract = (body: string) => `# PRD\n\n## Proof contract\n\n${body}\n`;

  it("RED：缩进续行以单个空格与复选框合并为一个条目", () => {
    const items = extractProofContract(contract("- [ ] 抽屉从右侧打开\n      并在重新加载后保持打开"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("抽屉从右侧打开 并在重新加载后保持打开");
    expect(items[0]!.text).toBe("抽屉从右侧打开 并在重新加载后保持打开");
  });

  it("RED：多条续行全部合并，每条之间恰好一个空格", () => {
    const items = extractProofContract(contract("- [ ] 第一段\n    第二段\n      第三段"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("第一段 第二段 第三段");
  });

  it("GREEN 边界：下一个复选框终止前一条目（不跨条目吸收）", () => {
    const items = extractProofContract(contract("- [ ] alpha 承诺\n- [x] beta 承诺"));
    expect(items.map((i) => i.rawText)).toEqual(["alpha 承诺", "beta 承诺"]);
  });

  it("GREEN 边界：空行终止条目", () => {
    const items = extractProofContract(contract("- [ ] alpha 承诺\n\n      孤立散文"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("alpha 承诺");
  });

  it("RED：是否符合条件取决于相对深度——复选框已缩进时，更深缩进的行会合并", () => {
    // 复选框本身缩进 2 个空格；续行缩进 6 个空格（严格更深），因此必须合并。
    // 仅使用零列起始的 fixture 无法区分“任意前导空白”和真正的相对深度语义。
    const items = extractProofContract(contract("  - [ ] 缩进承诺\n      更深的续行"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("缩进承诺 更深的续行");
  });

  it("GREEN 边界：复选框已缩进时，相同缩进的散文不会合并", () => {
    // 与复选框相同的 2 空格缩进 => 并非严格更深 => 终止。
    const items = extractProofContract(contract("  - [ ] 缩进承诺\n  同深度散文"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("缩进承诺");
  });

  it("GREEN 边界：复选框已缩进时，更浅缩进的散文不会合并", () => {
    const items = extractProofContract(contract("    - [ ] 深度缩进承诺\n  更浅的散文"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("深度缩进承诺");
  });

  it("GREEN 边界：无缩进（相同/更浅）的散文不会合并", () => {
    const items = extractProofContract(contract("- [ ] alpha 承诺\n位于第零列的普通散文"));
    expect(items).toHaveLength(1);
    expect(items[0]!.rawText).toBe("alpha 承诺");
  });

  it("RED：每个条目携带 checked 状态，并合并其续行", () => {
    const items = extractProofContract(contract("- [x] 已完成承诺\n      带一条续行\n- [ ] 开放承诺"));
    expect(items).toHaveLength(2);
    expect(items[0]!.rawText).toBe("已完成承诺 带一条续行");
    expect(items[1]!.rawText).toBe("开放承诺");
  });

  it("RED：plannedRef/text 从 rawText 派生（rawText 保留图片，text 移除图片），且续行已合并", () => {
    const items = extractProofContract(contract("- [ ] 面板渲染 ![planned](mockups/panel.png)\n      重新加载后仍然如此"));
    expect(items).toHaveLength(1);
    expect(items[0]!.plannedRef).toBe("mockups/panel.png");
    expect(items[0]!.rawText).toContain("![planned](mockups/panel.png)");
    expect(items[0]!.rawText).toContain("重新加载后仍然如此");
    expect(items[0]!.text).not.toContain("![planned]");
    expect(items[0]!.text).toContain("重新加载后仍然如此");
  });

  it("GREEN：格式错误、缺失或占位契约均如实呈现", () => {
    expect(extractProofContract(null)).toEqual([]);
    expect(extractProofContract("# PRD\n\n## Notes\n\n此处没有契约\n")).toEqual([]);
    expect(extractProofContract(contract("只有散文，没有复选框"))).toEqual([]);
    // Scaffold 占位行（方括号包裹）仍会被过滤，无论是否有续行。
    expect(extractProofContract(contract("- [ ] [一个承诺交付项]\n      [带占位续行]"))).toEqual([]);
  });
});
