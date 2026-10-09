import * as YAML from "yaml";
import { isMissionDotId, isSliceDotId } from "./dot-id.js";
import { isScaffoldPlaceholderText, hasAuthoredNumberedItem, isPristineScaffoldSection } from "./scaffold-placeholder.js";

export type RailStatus = "present" | "missing" | "malformed" | "readme-only";
export type FindingSeverity = "high" | "medium" | "low" | "info";
export type FindingKind =
  | "missing_progress"
  | "registration_ghost"
  | "missing_id"
  | "id_convention_violation"
  | "orphan_progress"
  | "missing_mission_brief"
  | "malformed_mission_brief"
  | "missing_mission_notes"
  | "missing_proof"
  // OPR.0.4.4.19 FR-10——双重保险式兜底（绝非主要强制措施；主要措施位于投放/写入路径）：
  | "proof_artifact_c1_invalid"
  | "missing_impl_prd"
  // OPR.0.4.4.23——SDLC 约定章节建议（结构上失败开放：low/info 严重度绝不会改变
  // 审计退出码；约定的唯一事实来源为 docs/reference/sdlc-conventions.md）：
  | "missing_intent_section"
  | "mini_requirements_missing_or_malformed"
  | "proof_contract_missing_or_malformed"
  | "ui_slice_missing_mockup"
  // 发布边界能力差异仅在规范尚未准确命名该差异且已有后继版本时可继续引用。
  // 使用 medium 严重度保留这条建议。
  | "expired_capability_delta"
  // SPEC.md 兼容性：节点同时携带两份已编写文件。该检查结构上仅为建议（low 严重度绝不
  // 改变退出码）：以 SPEC.md 为准，被遮蔽的 README.md 是需要留意的状态，而非门控失败。
  | "shadowed_node_file";

export interface AuditFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  path: string;
  message: string;
  remediation: string;
}

export interface ScopeAuditInput {
  id: string | null;
  path: string;
  readmeFrontmatterRaw: string | null;
  progressFileExists: boolean;
  readmeOnlyMarker: boolean;
  isActiveRelease: boolean;
  level: "mission" | "slice";
  missionBriefExists?: boolean;
  missionBriefPath?: string;
  missionBriefContent?: string | null;
  missionNotesResolution?: {
    path: string;
    name: "NOTES.md" | "MISSION_NOTES.md";
  } | null;
  missionNotesPath?: string;
  proofFileExists?: boolean;
  proofFilePath?: string;
  proofDirExists?: boolean;
  proofDirPath?: string;
  proofDirHasEntries?: boolean;
  hasProofPacket?: boolean;
  sliceStatus?: string | null;
  // OPR.0.4.4.19 FR-10（C1 兜底）：调用方列出的切片 proof/ 目录 Markdown 产物及其
  // 原始 frontmatter。undefined 表示调用方没有 proof 目录上下文，此检查不生效，避免误报。
  // 媒体文件（视频/截图）在结构上豁免，调用方只列出 .md 产物。
  proofArtifacts?: Array<{ path: string; frontmatterRaw: string | null }>;
  // OPR.0.4.4.19 FR-10（C7 兜底）：切片根目录是否存在 IMPLEMENTATION-PRD.md。
  // undefined 表示不生效（调用方没有文件系统上下文）。
  implementationPrdExists?: boolean;
  // OPR.0.4.4.23——约定章节建议的输入：由调用方读取的完整文件内容。undefined 表示调用方
  // 没有内容上下文，所有章节检查均不生效（避免误报）；null 表示文件不存在（PRD 为 null 时，
  // proof-contract 检查回退到 README）。
  nodeFileName?: "SPEC.md" | "README.md";
  readmeContent?: string | null;
  implementationPrdContent?: string | null;
}

export interface ScopeAuditResult {
  railStatus: RailStatus;
  findings: AuditFinding[];
  frontmatterError: string | null;
}

export interface MissionDependencyGraph {
  mission: { id: string | null; name: string; dependsOn: string[] };
  nodes: Array<{ id: string; name: string; dependsOn: string[] }>;
  ready: string[];
  waiting: Array<{ id: string; on: string[] }>;
  advisories: Array<{
    id: string;
    dependency?: string;
    kind: "invalid_field" | "invalid_dependency" | "outside_parent" | "missing_sibling" | "missing_id";
    message: string;
  }>;
}

export interface MissionDependencyGraphInput {
  mission: { id: string | null; name: string; dependsOn: unknown };
  slices: Array<{ id: string | null; name: string; dependsOn: unknown; active: boolean }>;
}

/** 由 mission graph 与两个审计面共用的纯建议图推导。
 *  未知、过期、畸形、跨父级的边会被报告并忽略：依赖数据可以引导构建顺序，但绝不卡执行。 */
export function deriveMissionDependencyGraph(input: MissionDependencyGraphInput): MissionDependencyGraph {
  const active = input.slices.filter((slice) => slice.active);
  const allIds = new Set(input.slices.flatMap((slice) => slice.id ? [slice.id] : []));
  const activeIds = new Set(active.flatMap((slice) => slice.id ? [slice.id] : []));
  const advisories: MissionDependencyGraph["advisories"] = [];
  const nodes: MissionDependencyGraph["nodes"] = [];
  const ready: string[] = [];
  const waiting: MissionDependencyGraph["waiting"] = [];

  for (const slice of active) {
    if (!slice.id) {
      advisories.push({ id: slice.name, kind: "missing_id", message: "Slice 没有 dot-ID，无法参与依赖图。" });
      continue;
    }
    const dependencies: string[] = [];
    if (slice.dependsOn !== undefined && !Array.isArray(slice.dependsOn)) {
      advisories.push({ id: slice.id, kind: "invalid_field", message: "depends_on 必须是同级 dot-ID 的列表；该值已被忽略。" });
    }
    for (const value of Array.isArray(slice.dependsOn) ? slice.dependsOn : []) {
      if (typeof value !== "string" || !isSliceDotId(value)) {
        advisories.push({ id: slice.id, dependency: String(value), kind: "invalid_dependency", message: "依赖不是 slice dot-ID，已被忽略。" });
        continue;
      }
      if (input.mission.id && !value.startsWith(`${input.mission.id}.`)) {
        advisories.push({ id: slice.id, dependency: value, kind: "outside_parent", message: "依赖不在本 mission 内，已被忽略。" });
        continue;
      }
      if (!allIds.has(value)) {
        advisories.push({ id: slice.id, dependency: value, kind: "missing_sibling", message: "依赖无法解析为同级 slice，已被忽略。" });
        continue;
      }
      dependencies.push(value);
    }
    nodes.push({ id: slice.id, name: slice.name, dependsOn: dependencies });
    const unmet = dependencies.filter((dependency) => activeIds.has(dependency));
    if (unmet.length === 0) ready.push(slice.id);
    else waiting.push({ id: slice.id, on: unmet });
  }

  const missionDependsOn = Array.isArray(input.mission.dependsOn)
    ? input.mission.dependsOn.filter((value): value is string => typeof value === "string")
    : [];
  return {
    mission: { id: input.mission.id, name: input.mission.name, dependsOn: missionDependsOn },
    nodes,
    ready,
    waiting,
    advisories,
  };
}

// OPR.0.4.4.20 FR-8：导出该值，使评审简报主干写入器遵循本审计强制执行的同一套固定精确
// 顺序规范。由结构保证一致性：除非此文件也发生变化，否则生成的输出绝不可能触发
// malformed_mission_brief。
export const MISSION_BRIEF_HEADERS = ["What & why", "Building", "Progress", "Proven", "Needs you", "Pointers"];

function childPath(parent: string, child: string): string {
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

function parseStatusFromFrontmatter(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = YAML.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const status = (parsed as Record<string, unknown>).status;
      return typeof status === "string" ? status : null;
    }
  } catch {
    return null;
  }
  return null;
}

function statusRequiresProof(status: string | null | undefined): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase().trim();
  return normalized.includes("done")
    || normalized.includes("ship")
    || normalized.includes("close")
    || normalized.includes("proven")
    || normalized.includes("promoted");
}

// OPR.0.4.4.19 FR-10（C1）：已批准的闭合集合（BR-4）。投放路径的事实来源位于 CLI proof
// 命令中；此镜像文件自带一份副本，因为两份 scope-audit 必须各自完整且字节一致。
// 扩展集合属于 pm-lead 约定变更，必须在两处同时完成。
const C1_REQUIRED_FIELDS = ["slice", "candidate_sha", "artifact_type", "verdict", "money_evidence"] as const;
const C1_ARTIFACT_TYPES = ["guard", "qa", "rev1-r1", "rev1-r2", "adjudication"] as const;
const C1_VERDICTS = ["CLEAR", "BLOCKING", "CONCERNING", "PASS", "NOT-CLEAR"] as const;

/** 按 C1 契约校验一份 proof artifact 的原始 frontmatter。
 *  合法时返回 null；否则返回人类可读的问题列表。 */
function c1ArtifactProblems(frontmatterRaw: string | null): string[] | null {
  if (frontmatterRaw === null) {
    return [`完全没有 frontmatter 头（C1 必含字段：${C1_REQUIRED_FIELDS.join(", ")}）`];
  }
  let parsed: unknown = null;
  try {
    parsed = YAML.parse(frontmatterRaw);
  } catch (err) {
    return [`frontmatter 无法解析：${err instanceof Error ? err.message : String(err)}`];
  }
  const fm = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  const problems: string[] = [];
  const missing = C1_REQUIRED_FIELDS.filter((f) => typeof fm[f] !== "string" || (fm[f] as string).trim().length === 0);
  if (missing.length > 0) problems.push(`缺少字段：${missing.join(", ")}`);
  if (typeof fm.artifact_type === "string" && !(C1_ARTIFACT_TYPES as readonly string[]).includes(fm.artifact_type)) {
    problems.push(`artifact_type '${fm.artifact_type}' 不在封闭集内（${C1_ARTIFACT_TYPES.join(" | ")}）`);
  }
  if (typeof fm.verdict === "string" && !(C1_VERDICTS as readonly string[]).includes(fm.verdict)) {
    problems.push(`verdict '${fm.verdict}' 不在封闭集内（${C1_VERDICTS.join(" | ")}）`);
  }
  return problems.length > 0 ? problems : null;
}

// OPR.0.4.4.23——用于约定章节建议的 Markdown H2 章节辅助函数。标题是本文件拥有的字面量
//（"Intent"、"Proof contract"、"Intent visual"），没有用户输入会进入正则。
const H2_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Intent: ["Intent", "意图"],
  "Mini-requirements": ["Mini-requirements", "最小需求", "小型需求"],
  "Proof contract": ["Proof contract", "证明契约", "证据约定"],
  "Intent visual": ["Intent visual", "意图视觉稿", "意图视觉"],
};

function h2Pattern(heading: string): string {
  return (H2_ALIASES[heading] ?? [heading]).join("|");
}

function hasH2(content: string, heading: string): boolean {
  return new RegExp(`^##\\s+(?:${h2Pattern(heading)})\\s*$`, "mi").test(content);
}

function h2Body(content: string, heading: string): string | null {
  const match = new RegExp(`^##\\s+(?:${h2Pattern(heading)})\\s*$`, "mi").exec(content);
  if (!match) return null;
  const rest = content.slice(match.index + match[0].length);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

// 除非任务状态指向终态或归档态，否则视为活跃。SOP 要求 missing_mission_notes 只对活跃任务
// 触发；已交付/已归档任务不再需要实时连续性文件。没有状态时按活跃处理并继续标记，保留收紧
// 规则前对常见无状态任务的行为。
function missionIsActive(status: string | null | undefined): boolean {
  if (!status) return true;
  const normalized = status.toLowerCase();
  const terminal = ["archiv", "complete", "done", "shipped", "closed", "historical", "superseded", "abandoned"];
  return !terminal.some((token) => normalized.includes(token));
}

export function classifyScopeItem(input: ScopeAuditInput): ScopeAuditResult {
  const findings: AuditFinding[] = [];
  let frontmatterError: string | null = null;
  let parsedFrontmatter: Record<string, unknown> = {};
  let railStatus: RailStatus;

  // 主线状态
  if (input.readmeOnlyMarker) {
    railStatus = "readme-only";
  } else if (input.progressFileExists) {
    railStatus = "present";
  } else {
    railStatus = "missing";
    findings.push({
      kind: "missing_progress",
      severity: input.isActiveRelease ? "high" : "low",
      path: input.path,
      message: `${input.level} 既没有 PROGRESS.md，也没有 readme-only 标记`,
      remediation: `运行：zrig scope ${input.level} create（脚手架生成 PROGRESS.md），或在 README frontmatter 中加 progress_rail: readme-only`,
    });
  }

  // Frontmatter 分类（严格解析，不使用 parseYamlSafely）
  if (input.readmeFrontmatterRaw === null) {
    findings.push({
      kind: "missing_id",
      severity: input.isActiveRelease ? "high" : "low",
      path: input.path,
      message: `README 没有 frontmatter（无法提取 id）`,
      remediation: "给 README 加上带 id: 字段的 YAML frontmatter",
    });
  } else {
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = YAML.parse(input.readmeFrontmatterRaw);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }

    const hasIdLine = /^id\s*:/m.test(input.readmeFrontmatterRaw);

    if (parseError) {
      frontmatterError = parseError;
      railStatus = "malformed";
      if (hasIdLine) {
        findings.push({
          kind: "registration_ghost",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README 有 id: 行，但 frontmatter 无法解析（注册幽灵）：${parseError}`,
          remediation: "修复 YAML frontmatter 语法错误，以便读取 id",
        });
      } else {
        findings.push({
          kind: "registration_ghost",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README frontmatter 无法解析：${parseError}`,
          remediation: "修复 YAML frontmatter 语法错误",
        });
      }
    } else {
      const fm = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
      parsedFrontmatter = fm;
      const id = typeof fm.id === "string" ? fm.id : null;

      if (!id) {
        findings.push({
          kind: "missing_id",
          severity: input.isActiveRelease ? "high" : "low",
          path: input.path,
          message: `README frontmatter 没有 id 字段`,
          remediation: "在 README frontmatter 中加一个符合 scope dot-ID 约定的 id: 字段",
        });
      } else {
        const validator = input.level === "mission" ? isMissionDotId : isSliceDotId;
        if (!validator(id)) {
          findings.push({
            kind: "id_convention_violation",
            severity: input.isActiveRelease ? "high" : "info",
            path: input.path,
            message: `id "${id}" 不符合 ${input.level} 的 dot-ID 约定`,
            remediation: `使用合法的 ${input.level} dot-ID 格式`,
          });
        }
      }
    }
  }

  if (input.level === "mission") {
    if (
      input.missionNotesResolution === null
      && missionIsActive(parseStatusFromFrontmatter(input.readmeFrontmatterRaw))
    ) {
      const notesPath = input.missionNotesPath ?? input.path;
      findings.push({
        kind: "missing_mission_notes",
        severity: "low",
        path: notesPath,
        message: "Mission 没有 NOTES.md，也没有可读的旧版 MISSION_NOTES.md 上下文文件。",
        remediation: "在 mission 根目录加 NOTES.md。既有 MISSION_NOTES.md 仍作为可读的旧版回退。",
      });
    }
  }

  if (input.level === "slice") {
    const status = input.sliceStatus ?? parseStatusFromFrontmatter(input.readmeFrontmatterRaw);
    const hasProofPacket = input.hasProofPacket === true;
    const hasRootProof = input.proofFileExists === true
      && input.proofDirExists === true
      && input.proofDirHasEntries === true;
    const isProven = statusRequiresProof(status) || hasProofPacket;
    if (isProven && !hasRootProof) {
      const proofPath = input.proofFilePath ?? childPath(input.path, "PROOF.md");
      findings.push({
        kind: "missing_proof",
        severity: "medium",
        path: proofPath,
        message: "Slice 已 done/proven，但没有完整的根 PROOF.md 加上有内容的 proof/ artifacts。",
        remediation: "在 slice 根目录加 PROOF.md，并按 slice 收尾 SOP 把验证 artifacts 放到 proof/ 下。",
      });
    }

    // OPR.0.4.4.19 FR-10（C1 兜底）：标记缺少 C1 头部或携带集合外值的 proof/ 产物。
    // 该兜底会捕获绕过投放路径的内容；原始文件写入不会在写入时受门控，而会在此暴露。
    for (const artifact of input.proofArtifacts ?? []) {
      const problems = c1ArtifactProblems(artifact.frontmatterRaw);
      if (problems) {
        findings.push({
          kind: "proof_artifact_c1_invalid",
          severity: "medium",
          path: artifact.path,
          message: `Proof artifact 违反 C1 头契约：${problems.join("; ")}。`,
          remediation: `重新投递：zrig proof add <slice> --artifact-type <${C1_ARTIFACT_TYPES.join("|")}> --verdict <${C1_VERDICTS.join("|")}> --candidate-sha <sha> --money-evidence "<一句话>"——或就地补齐缺失的 frontmatter 字段。`,
        });
      }
    }

    // OPR.0.4.4.23——SDLC 约定章节建议（唯一事实来源：
    // docs/reference/sdlc-conventions.md）。结构上失败开放：审计命令只会因 HIGH 发现改变退出码，
    // 而这些发现按结构为 low/info，只做记录和建议，绝不门控。调用方未提供内容上下文
    //（输入为 undefined）时不生效。
    const frontmatterIntent = typeof parsedFrontmatter.intent === "string"
      && parsedFrontmatter.intent.trim().length > 0;
    const currentSpec = input.nodeFileName === "SPEC.md"
      || (input.nodeFileName === undefined && frontmatterIntent);
    const nodeFileName = currentSpec ? "SPEC.md" : "README.md";
    if (typeof input.readmeContent === "string" && !frontmatterIntent && !hasH2(input.readmeContent, "Intent")) {
      findings.push({
        kind: "missing_intent_section",
        severity: "low",
        path: childPath(input.path, nodeFileName),
        message: `${nodeFileName} 既没有 frontmatter \`intent:\`，也没有旧版 \`## Intent\` 章节。`,
        remediation: currentSpec
          ? "在 SPEC.md frontmatter 中加一个非空的 `intent:`。"
          : "在 README.md 中加一个非空的 `intent:`，或保留一个旧版 `## Intent` 章节。",
      });
    }

    // PM 自用验证 #1（qitem-20260720015700-630eef64）：按章节选择来源，分别独立决定
    // `## Mini-requirements` 和 `## Proof contract`。已编写的 PRD 章节是规范来源；但仅有
    // 脚手架且仍保持初始状态的 PRD 章节，会让位给已编写（非初始状态）的 README 章节。缺失、
    // 纯文本畸形或混合编写的 PRD 章节仍以 PRD 为规范来源并保持可见。该逻辑结构上不感知状态，
    // 此处绝不读取生命周期状态。PRD 不存在时，文件级 README 回退保持字节一致。
    const prdContentStr = typeof input.implementationPrdContent === "string" ? input.implementationPrdContent : null;
    const readmeContentStr = typeof input.readmeContent === "string" ? input.readmeContent : null;
    const pickSectionSource = (heading: string): { body: string | null; path: string } | null => {
      if (currentSpec && readmeContentStr !== null) {
        return { body: h2Body(readmeContentStr, heading), path: childPath(input.path, nodeFileName) };
      }
      if (prdContentStr !== null) {
        const prdBody = h2Body(prdContentStr, heading);
        if (isPristineScaffoldSection(prdBody) && readmeContentStr !== null) {
          const readmeBody = h2Body(readmeContentStr, heading);
          if (readmeBody !== null && !isPristineScaffoldSection(readmeBody)) {
            return { body: readmeBody, path: childPath(input.path, "README.md") };
          }
        }
        return { body: prdBody, path: childPath(input.path, "IMPLEMENTATION-PRD.md") };
      }
      if (readmeContentStr !== null) {
        return { body: h2Body(readmeContentStr, heading), path: childPath(input.path, "README.md") };
      }
      return null;
    };
    const miniSource = pickSectionSource("Mini-requirements");
    const contractSource = pickSectionSource("Proof contract");
    if (miniSource) {
      // OPR.0.4.4.23 rev1-r2 B1（PRD L34 守卫 F-3）：格式正确的
      // `## Mini-requirements` 是 Living Notes 投影中的计划支柱，并在本章节选中的来源上检查。
      // 格式正确表示有标题且至少有一个编号列表项；标题下只有散文属于畸形，因为没有可用的需求投影。
      const miniBody = miniSource.body;
      // release-0.4.7 微型包 A：已编写的编号项。它是镜像模块唯一的已编写编号项语法，
      // 并与 review compose 共享；一个判定函数同时修复句点/括号语法分裂和无法识别占位符的问题。
      // 下方发现消息已能如实涵盖两种情况，因此保持不变。
      const hasNumberedItem = hasAuthoredNumberedItem(miniBody);
      if (!hasNumberedItem) {
        findings.push({
          kind: "mini_requirements_missing_or_malformed",
          severity: "low",
          path: miniSource.path,
          message: miniBody === null
            ? "没有 `## Mini-requirements` 章节——范围计划缺少简明的需求层。"
            : "`## Mini-requirements` 没有编号项（`1. …`）——一眼可读的需求层正是审批的起点。",
          remediation: `在 ${nodeFileName} 中加 \`## Mini-requirements\`，写一份可观察结果的编号列表（对小 slice 而言，这可以就是整份规格）。`,
        });
      }
    }

    if (contractSource) {
      const contractBody = contractSource.body;
      // release-0.4.7 意图阶段：已编写的复选框项。脚手架占位行不构成契约；共享语法位于
      // ./scaffold-placeholder.js，review compose 和切片详情投影器也使用同一辅助函数，即 R3 固定点。
      // 无文本的复选框行与以前完全一样，仍计入有效项。检查基于本章节选中的来源，独立于
      // mini-reqs 的选择结果。
      const hasAuthoredCheckboxItem =
        contractBody !== null &&
        [...contractBody.matchAll(/^\s*-\s*\[[ xX]\]\s*(.*)$/gm)].some(
          (m) => !isScaffoldPlaceholderText((m[1] ?? "").trim()),
        );
      if (!hasAuthoredCheckboxItem) {
        findings.push({
          kind: "proof_contract_missing_or_malformed",
          severity: "low",
          path: contractSource.path,
          message: contractBody === null
            ? "没有 `## Proof contract` 章节——proof 没有可配对的“承诺交付物”来源。"
            : "`## Proof contract` 没有可配对 proof 的复选框交付物（`- [ ] …`）。",
          remediation: `在 ${nodeFileName} 中加 \`## Proof contract\`，每个承诺交付物写一行复选框，写成可观察结果（约定 SSOT：docs/reference/sdlc-conventions.md（安装位置：$OPENRIG_HOME/reference/sdlc-conventions.md））。`,
        });
      }

      if (typeof input.readmeContent === "string") {
        const visualBody = h2Body(input.readmeContent, "Intent visual");
        const isUiSlice = visualBody !== null && !/\bN\/A\b/i.test(visualBody);
        // rev1-r2 B2：只有 `## Intent visual` 中真实的 Markdown 图片/媒体引用，或 proof contract
        // 中显式的 plannedRef 标记，才表示 mockup 确实存在。仅在普通文本中出现 "mockup"
        //（脚手架占位符写着 "name their planned mockup"）不构成引用，不得抑制该建议。
        const hasMockupRef = /!\[/.test(visualBody ?? "")
          || /plannedRef/i.test(contractBody ?? "")
          || /!\[/.test(contractBody ?? "");
        if (isUiSlice && !hasMockupRef) {
          findings.push({
            kind: "ui_slice_missing_mockup",
            severity: "info",
            path: childPath(input.path, nodeFileName),
            message: "Slice 声明了 Intent visual（UI slice），但没有任何 mockup 引用——在其锁定集合里没有 mockup 的 UI slice 是不完整的计划。",
            remediation: "附上计划的 mockup：在 `## Intent visual` 里放一个图片引用，或在 proof-contract 交付物上放一个 plannedRef（约定 SSOT：docs/reference/sdlc-conventions.md §3（安装位置：$OPENRIG_HOME/reference/sdlc-conventions.md §3））。",
          });
        }
      }
    }

  }

  return { railStatus, findings, frontmatterError };
}
