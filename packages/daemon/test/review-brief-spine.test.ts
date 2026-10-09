// OPR.0.4.4.20 FR-8——MISSION_BRIEF spine generation AC。
//（由 driver 编写；按 dev44 VM posture 在 QA gate run 中执行。）

import { describe, it, expect } from "vitest";
import { applyBriefSpine, renderBriefSpine } from "../src/domain/review/brief-spine.js";
import { MISSION_BRIEF_HEADERS } from "../src/domain/scope/scope-audit.js";
import { composeMissionReview, composeSliceReview } from "../src/domain/review/compose.js";
import type { SliceComposeInputs } from "../src/domain/review/compose.js";

const NOW = "2026-07-04T12:00:00.000Z";

function sliceInputs(name: string): SliceComposeInputs {
  return {
    slice: { name, id: null, title: name, missionId: "m" },
    readme: "## Intent\n\ni\n",
    prd: "## Mini-requirements\n\n1. m\n",
    proofMd: null,
    artifacts: [],
    lockedArtifacts: [],
    mediaRefs: [],
    proofDirExists: false,
    attention: [],
    agents: [],
    activeQitemPresent: false,
    git: { mainTip: "tip", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 0 },
    approval: { spec: null, delivery: null },
    nowIso: NOW,
  };
}

function mission() {
  return composeMissionReview({
    mission: { name: "m", id: null, title: "m", intent: "The founder's why." },
    slices: [{ review: composeSliceReview(sliceInputs("s1")), green: false }],
    missionAttention: [],
    agents: [],
    nowIso: NOW,
  });
}

const BRIEF = `---
id: X
---
# m — Brief

## What & why

Hand-authored prose the generator must never touch.

## Building

- stale hand line

## Progress

- stale hand line

## Proven

- stale hand line

## Needs you

- stale hand line

## Pointers

- hand-authored pointer, untouched
`;

describe("FR-8 brief spine", () => {
  it("从相同 composer query 派生 spine（无第二条计算路径），并原样携带 intent", () => {
    const m = mission();
    expect(m.intent).toBe("The founder's why.");
    expect(m.briefSpine.progress).toContain("PLAN: 1");
    expect(m.briefSpine.needsYou).toContain("0 个待关注项");
    expect(renderBriefSpine(m)).toEqual(m.briefSpine); // 同一 function、相同字符串。
  });

  it("按 section scope 应用：替换 spine section，手写 section 字节不变，保留 schema 顺序", () => {
    const m = mission();
    const applied = applyBriefSpine(BRIEF, m.briefSpine);
    expect(applied).not.toBeNull();
    expect(applied!).toContain("Hand-authored prose the generator must never touch.");
    expect(applied!).toContain("hand-authored pointer, untouched");
    expect(applied!).not.toContain("stale hand line");
    // 保留已 pin 的准确顺序 H2 schema（scope-audit 契约）。
    const headers = [...applied!.matchAll(/^##\s+(.+?)\s*$/gm)].map((x) => x[1]);
    expect(headers).toEqual(MISSION_BRIEF_HEADERS);
  });

  it("拒绝猜测并重写不含已 pin schema 的 brief", () => {
    const m = mission();
    expect(applyBriefSpine("# not a brief\n\n## Random\n\nx\n", m.briefSpine)).toBeNull();
    // 顺序错误时也拒绝——顺序是 schema 的一部分。
    const wrongOrder = BRIEF.replace("## Building", "## TEMP").replace("## Progress", "## Building").replace("## TEMP", "## Progress");
    expect(applyBriefSpine(wrongOrder, m.briefSpine)).toBeNull();
  });

  it("保持幂等：应用同一 spine 两次会产生相同字节", () => {
    const m = mission();
    const once = applyBriefSpine(BRIEF, m.briefSpine)!;
    const twice = applyBriefSpine(once, m.briefSpine)!;
    expect(twice).toBe(once);
  });
});
