// SCOPES VIEW——store-direct projection 固定项（计划 d64d2f5c proof-contract 分支 1/3/5）：
// 计数只从 LOCK + C1 DROP 派生；绝不读取 PROGRESS.md；paired 精确表示至少一个 drop 引用 item；
// lock 状态来自 frontmatter stamp。
import { describe, it, expect } from "vitest";
import { projectSliceScope, projectMissionScopes, type ScopeFsDeps } from "../src/domain/scope/scope-view-projection.js";

const README = `---
id: OPR.0.5.2.9
slice: 09-gateway-m1
mission: release-0.5.2
status: spec
stage: building
approved-spec-by: pm-openrig@openrig-pm
approved-spec-at: 2026-08-06T10:00:00.000Z
locked-artifacts:
  - name: Implementation PRD
    path: IMPLEMENTATION-PRD.md
    kind: spec
---

# Slice 09 — gateway-m1

## Intent

"Milestone cut: Slack to the founder on the bones we keep."

## Mini-requirements

1. The daemon resolves @external addresses via domain-class
   admission; unregistered bounces loudly.
2. Human specs are one file per human.

## Proof contract

- [ ] The ack-after-delivery repair demonstrated on the SHIPPED relay path.
- [ ] A registered entity cold-DMs from Slack and it queues exactly as today.
- [ ] An unregistered domain bounces loudly with the teaching error.
`;

const DROP1 = `---
slice: OPR.0.5.2.9
candidate_sha: abc123
artifact_type: qa
verdict: PASS
evidences:
  - "1"
media:
  - "relay-repair-e2e.txt"
---
body`;

const DROP3 = `---
slice: OPR.0.5.2.9
candidate_sha: abc123
artifact_type: guard
verdict: CLEAR
evidences:
  - "3"
---
body`;

function fsFixture(files: Record<string, string>, dirs: string[]): ScopeFsDeps {
  return {
    exists: (p) => p in files || dirs.includes(p),
    readFile: (p) => files[p] ?? null,
    listDir: (p) => Object.keys(files).filter((f) => f.startsWith(p + "/")).map((f) => f.slice(p.length + 1).split("/")[0]!)
      .concat(dirs.filter((d) => d.startsWith(p + "/")).map((d) => d.slice(p.length + 1).split("/")[0]!))
      .filter((v, i, a) => a.indexOf(v) === i),
    isDirectory: (p) => dirs.includes(p),
  };
}

const S = "/root/slices/09-gateway-m1";
const baseFiles = {
  [`${S}/README.md`]: README,
  [`${S}/proof/qa-pass-1.md`]: DROP1,
  [`${S}/proof/guard-clear-3.md`]: DROP3,
  [`${S}/PROGRESS.md`]: "- [x] EVERYTHING DONE (a lie the projection must never read)",
};
const baseDirs = ["/root", "/root/slices", S, `${S}/proof`];

describe("scope-view 投影（store-direct）", () => {
  it("N/M pairing 只从 C1 drop 派生：2/3 paired；每个 paired item 携带自身 drop", () => {
    const d = projectSliceScope(fsFixture(baseFiles, baseDirs), S)!;
    expect(d.proof).toEqual({ paired: 2, total: 3 });
    expect(d.proofContract[0]!.paired).toBe(true);
    expect(d.proofContract[0]!.drops[0]!.media).toEqual(["relay-repair-e2e.txt"]);
    expect(d.proofContract[1]!.paired).toBe(false);
    expect(d.proofContract[2]!.paired).toBe(true);
    expect(d.proofContract[2]!.drops[0]!.artifactType).toBe("guard");
  });

  it("PROGRESS.md 绝不是数据源：其中失真的 checkbox 不改变任何内容（消除 drift 类）", () => {
    const withoutProgress = { ...baseFiles };
    delete (withoutProgress as Record<string, string>)[`${S}/PROGRESS.md`];
    const a = projectSliceScope(fsFixture(baseFiles, baseDirs), S)!;
    const b = projectSliceScope(fsFixture(withoutProgress, baseDirs), S)!;
    expect(a.proof).toEqual(b.proof); // counts identical with/without the narrative file
    expect(a.progressPath).toBe(`${S}/PROGRESS.md`); // surfaced ONLY as the n-display path
    expect(b.progressPath).toBeNull();
  });

  it("lock 来自 frontmatter stamp：spec 已锁定、delivery 未锁定，不虚构 proven-green", () => {
    const d = projectSliceScope(fsFixture(baseFiles, baseDirs), S)!;
    expect(d.locks.spec).toEqual({ by: "pm-openrig@openrig-pm", at: "2026-08-06T10:00:00.000Z" });
    expect(d.locks.delivery).toBeNull();
    expect(d.stage).toBe("building");
    expect(d.intent).toContain("Slack to the founder");
    expect(d.miniRequirements.length).toBe(2);
    expect(d.miniRequirements[0]).toContain("bounces loudly");
    expect(d.prdExists).toBe(true); // via locked-artifacts
  });

  it("mission overview 直接从 store 列出 slice summary", () => {
    const m = projectMissionScopes(fsFixture(baseFiles, baseDirs), "/root", "");
    // missionsRoot="/root"、mission="" 时 missionDir 为 "/root"；改用真实结构：
    const m2 = projectMissionScopes(fsFixture(baseFiles, [...baseDirs]), "/root/..", "root");
    expect(m).not.toBeNull();
  });
});

// LOOK delta D1——spec-sha 在投影时从锁定产物的字节计算（store 保存 path 而非 hash；computed 来自
// store，绝不抄录）。
import { createHash } from "node:crypto";
describe("D1——从锁定产物字节计算 spec-sha", () => {
  it("specShaShort 等于锁定产物文件的 sha256[:8]，文件缺失时为 null", () => {
    const prd = "# the PRD bytes";
    const files = { ...baseFiles, [`${S}/IMPLEMENTATION-PRD.md`]: prd };
    const d = projectSliceScope(fsFixture(files, baseDirs), S)!;
    expect(d.specShaShort).toBe(createHash("sha256").update(prd).digest("hex").slice(0, 8));
    const d2 = projectSliceScope(fsFixture(baseFiles, baseDirs), S)!;
    expect(d2.specShaShort).toBeNull(); // absent file = honest null, never fabricated
  });

  it("39a1c477：排在首位的非 spec kind 不会抢走 hash，`kind: spec` 条目胜出", () => {
    const readme = README.replace(
      `locked-artifacts:
  - name: Implementation PRD
    path: IMPLEMENTATION-PRD.md
    kind: spec`,
      `locked-artifacts:
  - name: Pulse mockup
    path: mockups/pulse-v4.html
    kind: mockup
  - name: Implementation PRD
    path: IMPLEMENTATION-PRD.md
    kind: spec`,
    );
    const prd = "# the PRD bytes";
    const files = {
      ...baseFiles,
      [`${S}/README.md`]: readme,
      [`${S}/IMPLEMENTATION-PRD.md`]: prd,
      [`${S}/mockups/pulse-v4.html`]: "<html>WRONG ARTIFACT</html>",
    };
    const d = projectSliceScope(fsFixture(files, baseDirs), S)!;
    expect(d.specShaShort).toBe(createHash("sha256").update(prd).digest("hex").slice(0, 8));
  });
});


it.each(["SPEC.md", "README.md", "IMPLEMENTATION-PRD.md"])("uses the selected %s contract and logical item grammar for legacy scope rows", (source) => {
  const files = {
    [`${S}/SPEC.md`]: "## Intent\nAn intent-only node.\n",
    [`${S}/${source}`]: "## Proof contract\n[ ] Bare checkbox. <!-- proof-item: bare -->\n  Continuation.\n  - [ ] Indented checkbox. <!-- proof-item: nested -->\n",
  };
  const d = projectSliceScope(fsFixture(files, baseDirs), S)!;
  expect(d.readiness!.configured).toBe(false);
  expect(d.proofContract.map(i => ({ id: i.id, text: i.text, source: i.source?.file }))).toEqual([
    { id: "bare", text: "Bare checkbox.  Continuation.", source },
    { id: "nested", text: "Indented checkbox.", source },
  ]);
  expect(d.proofContract.map(i => i.id)).toEqual(d.readiness!.items.map(i => i.id));
});
