// Living Notes Packet 2 —— 手工编写的 fixture 构建器（OPR.0.4.4.20）。
//
// 构建符合已批准约定契约的真实磁盘切片 fixture：C1 proof-artifact 头（闭集）、
// C7 固定规范名（IMPLEMENTATION-PRD.md）、D2 `## Proof contract` 章节，以及审批
// frontmatter 标记（Packet 1 FR-9 结构）。供 composer 单元测试和 proof-walk
// fixture（双阶段遍历、台账跟踪缺口重放）使用。

import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { C1ArtifactType, C1Verdict } from "../src/domain/review/types.js";

export interface FixtureWorkspace {
  /** missions 根目录（包含 missions/<mission>/slices/<slice>）。 */
  root: string;
  missionDir(mission: string): string;
  sliceDir(mission: string, slice: string): string;
}

export function makeFixtureWorkspace(): FixtureWorkspace {
  const root = mkdtempSync(join(tmpdir(), "review-fixture-"));
  return {
    root,
    missionDir: (mission) => join(root, mission),
    sliceDir: (mission, slice) => join(root, mission, "slices", slice),
  };
}

export interface SliceFixtureOpts {
  /** Frontmatter ID（点分 ID）。 */
  id?: string;
  title?: string;
  status?: string;
  /** 添加 `ux-change: true`。 */
  uxChange?: boolean;
  /** 审批标记（Packet 1 FR-9 frontmatter 结构）。 */
  approvedBy?: string;
  approvedAt?: string;
  specApprovedBy?: string;
  specApprovedAt?: string;
  /** Corrective §3.1 — the pinned plan set (`locked-artifacts:` frontmatter list). */
  lockedArtifacts?: Array<{ name: string; path: string; kind: string }>;
  /** README 意图章节正文（由 FR-1 逐字投影）；省略则跳过 README。 */
  intent?: string;
  /**
   * IMPLEMENTATION-PRD.md 内容控制：
   *  - miniReqs：PRD 顶部的固定简明层级行
   *  - proofContract：`## Proof contract` 复选框项（D2）
   *  - prdBody：额外正文 markdown
   *  - prdCheckboxes：PRD 内的验收复选框行
   * 对未规格化 slice 完全省略 `prd`（prd: false）。
   */
  prd?: false | {
    miniReqs?: string[];
    proofContract?: string[];
    prdCheckboxes?: Array<{ text: string; done?: boolean }>;
    prdBody?: string;
  };
  /** PROGRESS.md 复选框行（冲突来源 fixture）。 */
  progressCheckboxes?: Array<{ text: string; done?: boolean }>;
  /** README 复选框行。 */
  readmeCheckboxes?: Array<{ text: string; done?: boolean }>;
}

function checkboxLines(items: Array<{ text: string; done?: boolean }> | undefined): string {
  if (!items?.length) return "";
  return items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n") + "\n";
}

/** 写入 fixture 切片目录并返回其绝对路径。 */
export function writeFixtureSlice(
  ws: FixtureWorkspace,
  mission: string,
  slice: string,
  opts: SliceFixtureOpts = {},
): string {
  const dir = ws.sliceDir(mission, slice);
  mkdirSync(join(dir, "proof"), { recursive: true });

  const fm: string[] = [];
  if (opts.id) fm.push(`id: ${opts.id}`);
  fm.push(`title: ${opts.title ?? slice}`);
  fm.push(`status: ${opts.status ?? "active"}`);
  if (opts.uxChange) fm.push("ux-change: true");
  if (opts.approvedBy) fm.push(`approved-by: ${opts.approvedBy}`);
  if (opts.approvedAt) fm.push(`approved-at: ${opts.approvedAt}`);
  if (opts.specApprovedBy) fm.push(`approved-spec-by: ${opts.specApprovedBy}`);
  if (opts.specApprovedAt) fm.push(`approved-spec-at: ${opts.specApprovedAt}`);
  if (opts.lockedArtifacts?.length) {
    fm.push("locked-artifacts:");
    for (const a of opts.lockedArtifacts) {
      fm.push(`  - name: ${a.name}`, `    path: ${a.path}`, `    kind: ${a.kind}`);
    }
  }

  if (opts.intent !== undefined || opts.readmeCheckboxes) {
    writeFileSync(
      join(dir, "README.md"),
      `---\n${fm.join("\n")}\n---\n\n# ${opts.title ?? slice}\n\n## Intent\n\n${opts.intent ?? ""}\n\n${checkboxLines(opts.readmeCheckboxes)}`,
    );
  } else {
    // 即使没有意图内容，frontmatter 的状态/标记仍需承载文件。
    writeFileSync(join(dir, "README.md"), `---\n${fm.join("\n")}\n---\n\n# ${opts.title ?? slice}\n`);
  }

  if (opts.prd !== false && opts.prd !== undefined) {
    const p = opts.prd;
    const mini = p.miniReqs?.length
      ? `## Mini-requirements\n\n${p.miniReqs.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n`
      : "";
    const contract = p.proofContract?.length
      ? `## Proof contract\n\n${p.proofContract.map((c) => `- [ ] ${c}`).join("\n")}\n\n`
      : "";
    const acceptance = p.prdCheckboxes?.length ? `## Acceptance\n\n${checkboxLines(p.prdCheckboxes)}\n` : "";
    writeFileSync(
      join(dir, "IMPLEMENTATION-PRD.md"),
      `---\ntitle: ${opts.title ?? slice} PRD\n---\n\n${mini}# Spec\n\n${p.prdBody ?? ""}\n\n${acceptance}${contract}`,
    );
  }

  if (opts.progressCheckboxes) {
    writeFileSync(join(dir, "PROGRESS.md"), `# Progress\n\n${checkboxLines(opts.progressCheckboxes)}`);
  }

  return dir;
}

export interface ProofArtifactOpts {
  slice: string;
  candidateSha: string;
  artifactType: C1ArtifactType;
  /** 传入集合外字符串以构造无效判定 fixture；省略则表示缺失。 */
  verdict?: C1Verdict | string;
  moneyEvidence?: string;
  evidences?: string[];
  selfCheck?: string;
  /** proof/ 下的文件名（默认为 <artifactType>.md）。 */
  fileName?: string;
  /** 用于“最新优先”排序的 mtime。 */
  mtime?: Date;
  body?: string;
}

/** 将带 C1 头的证明产物写入 <sliceDir>/proof/。 */
export function writeProofArtifact(sliceDir: string, opts: ProofArtifactOpts): string {
  const fm: string[] = [
    `slice: ${opts.slice}`,
    `candidate_sha: ${opts.candidateSha}`,
    `artifact_type: ${opts.artifactType}`,
  ];
  if (opts.verdict !== undefined) fm.push(`verdict: ${opts.verdict}`);
  if (opts.moneyEvidence) fm.push(`money_evidence: ${opts.moneyEvidence}`);
  if (opts.evidences?.length) fm.push(`evidences:\n${opts.evidences.map((e) => `  - ${e}`).join("\n")}`);
  if (opts.selfCheck) fm.push(`self_check: ${opts.selfCheck}`);

  const file = join(sliceDir, "proof", opts.fileName ?? `${opts.artifactType}.md`);
  writeFileSync(file, `---\n${fm.join("\n")}\n---\n\n${opts.body ?? "Evidence body.\n"}`);
  if (opts.mtime) utimesSync(file, opts.mtime, opts.mtime);
  return file;
}

/** 阶段 1 fixture：一个候选 SHA 的四项独立门禁判定全部通过。 */
export function writeFullGateSet(
  sliceDir: string,
  slice: string,
  candidateSha: string,
  overrides: Partial<Record<"guard" | "qa" | "rev1-r1" | "rev1-r2", C1Verdict | string | null>> = {},
): void {
  const defaults: Record<"guard" | "qa" | "rev1-r1" | "rev1-r2", C1Verdict> = {
    guard: "CLEAR",
    qa: "PASS",
    "rev1-r1": "CLEAR",
    "rev1-r2": "CLEAR",
  };
  for (const role of ["guard", "qa", "rev1-r1", "rev1-r2"] as const) {
    const v = role in overrides ? overrides[role] : defaults[role];
    if (v === null) continue; // absent artifact fixture
    writeProofArtifact(sliceDir, {
      slice,
      candidateSha,
      artifactType: role,
      verdict: v,
      moneyEvidence: `${role} money line`,
    });
  }
}
