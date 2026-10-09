// SCOPES VIEW（封存计划 d64d2f5c）——scopes TUI 背后的 STORE-DIRECT projection。
//
// DATA-PATH 规则（binding）：slice card / proof count / progress bar 来自 SCOPE STORE，
// 即 README frontmatter LOCK 与 proof/ 中的 C1 proof drop，绝不来自容易漂移的 PROGRESS.md。
// PROGRESS.md 是显示在 `n` 下的叙事 artifact，此处完全不读取。render 绝不声称 store 未强制的
// proven-green；`paired` 的唯一含义是“至少一份 C1 drop 引用了此 contract item”。
import * as path from "node:path";
import { readSliceReadiness, readProofContract, type ScopeReadiness, type ProofPolicyRead } from "../proof/judgments.js";
import { createHash } from "node:crypto";
import { NODE_FILE_PRECEDENCE } from "./node-file.js";

export interface ScopeFsDeps {
  readBytes?: (path: string) => Uint8Array | null;
  exists: (p: string) => boolean;
  readFile: (p: string) => string | null;
  listDir: (p: string) => string[];
  isDirectory: (p: string) => boolean;
}

export interface C1Drop {
  file: string;
  artifactType: string | null;
  verdict: string | null;
  candidateSha: string | null;
  /** 此 drop 覆盖的 contract-item ref：从 1 开始的字符串 index，或 item 文本。 */
  evidences: string[];
  media: string[];
}

export interface ProofContractItem {
  id: string;
  source: { file: string; line: number };
  index: number; // 从 1 开始。
  text: string;
  /** 当且仅当至少一份 C1 drop 引用此 item 时为 true；这是 ✓ 的唯一含义，确保诚实渲染。 */
  paired: boolean;
  drops: Array<{ file: string; artifactType: string | null; verdict: string | null; media: string[] }>;
}

export interface ScopeLocks {
  spec: { by: string; at: string } | null;
  delivery: { by: string; at: string } | null;
}

export interface SliceScopeSummary {
  readiness?: ScopeReadiness;
  dirName: string;
  id: string | null;
  displayName: string;
  status: string | null;
  stage: string | null;
  locks: ScopeLocks;
  proof: { paired: number; total: number };
}

export interface SliceScopeDetail extends SliceScopeSummary {
  intent: string;
  miniRequirements: string[];
  proofContract: ProofContractItem[];
  /** `n` 叙事展示所用 PROGRESS.md 路径；绝不是数据源。 */
  progressPath: string | null;
  specShaShort: string | null;
  prdExists: boolean;
}

export interface MissionScopes {
  mission: string;
  slices: SliceScopeSummary[];
}

function extractFrontmatterRaw(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? match[1]! : null;
}

function fmValue(fm: string, key: string): string | null {
  const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(fm);
  return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : null;
}

/** 解析 `key:` 下的 YAML block list，即 C1 的 `evidences:` / `media:` 结构。 */
function fmList(fm: string, key: string): string[] {
  const lines = fm.split("\n");
  const out: string[] = [];
  let inKey = false;
  for (const line of lines) {
    if (new RegExp(`^${key}\\s*:\\s*$`).test(line)) { inKey = true; continue; }
    if (inKey) {
      const m = /^\s+-\s+(.+)$/.exec(line);
      if (m) { out.push(m[1]!.trim().replace(/^["']|["']$/g, "")); continue; }
      if (/^\S/.test(line)) inKey = false;
    }
  }
  return out;
}

const SECTION_HEADING_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Intent: ["Intent", "意图"],
  "Mini-requirements": ["Mini-requirements", "最小需求", "小型需求"],
};

/** 提取中英文 H2 section 的 body，范围到下一个 H2 或 EOF。 */
function sectionBody(content: string, heading: string): string {
  const aliases = SECTION_HEADING_ALIASES[heading] ?? [heading];
  const re = new RegExp(`^##\\s+(?:${aliases.join("|")})\\s*$`, "mi");
  const m = re.exec(content);
  if (!m) return "";
  const start = m.index + m[0].length;
  const rest = content.slice(start);
  const next = /^## /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** 带编号的 mini-requirement 行：顶层 `N.` item，并折叠后续 continuation 行。 */
function miniRequirements(content: string): string[] {
  const body = sectionBody(content, "Mini-requirements");
  const items: string[] = [];
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const m = /^(\d+)\.\s+(.*)$/.exec(line);
    if (m) {
      if (current !== null) items.push(current.trim());
      current = m[2]!;
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += " " + line.trim();
    }
  }
  if (current !== null) items.push(current.trim());
  return items;
}

function parseC1Drop(fileName: string, raw: string): C1Drop | null {
  const fm = extractFrontmatterRaw(raw);
  if (!fm) return null;
  return {
    file: fileName,
    artifactType: fmValue(fm, "artifact_type"),
    verdict: fmValue(fm, "verdict"),
    candidateSha: fmValue(fm, "candidate_sha"),
    evidences: fmList(fm, "evidences"),
    media: fmList(fm, "media"),
  };
}

function readLocks(fm: string): ScopeLocks {
  const specBy = fmValue(fm, "approved-spec-by");
  const specAt = fmValue(fm, "approved-spec-at");
  const delBy = fmValue(fm, "approved-by");
  const delAt = fmValue(fm, "approved-at");
  return {
    spec: specBy && specAt ? { by: specBy, at: specAt } : null,
    delivery: delBy && delAt ? { by: delBy, at: delAt } : null,
  };
}

/** 将 drop 连接到 contract item：drop 的 evidence ref 可通过从 1 开始的 index
 *  （已交付 `--evidences "4,5"` 约定）或精确 item 文本匹配。 */
function pairContract(items: ReturnType<typeof readProofContract>, drops: C1Drop[]): ProofContractItem[] {
  return items.map((item) => {
    const { index, text } = item;
    const matching = drops.filter((d) =>
      d.evidences.some((ref) => ref === String(index) || ref.trim() === text.trim()),
    );
    return {
      ...item,
      paired: matching.length > 0,
      drops: matching.map((d) => ({ file: d.file, artifactType: d.artifactType, verdict: d.verdict, media: d.media })),
    };
  });
}

function specShaFromLockedArtifacts(fs: ScopeFsDeps, sliceDir: string, fm: string): string | null {
  // locked-artifacts 是嵌套 YAML block list。按 plan-lock 约定，优先取首个 `kind: spec` entry
  // 的 `path:`；否则回退到任意 kind 的首个 path，再没有则使用 PRD。entry 以 `- ` item 起点分隔，
  // 避免排在前面的非 spec kind 抢走 hash（39a1c477 review nit）。
  let candidate: string | null = null;
  let firstPath: string | null = null;
  let entryPath: string | null = null;
  let entryIsSpec = false;
  const closeEntry = () => {
    if (entryPath && !firstPath) firstPath = entryPath;
    if (entryPath && entryIsSpec && !candidate) candidate = entryPath;
    entryPath = null;
    entryIsSpec = false;
  };
  for (const line of fm.split("\n")) {
    if (/^\s+-\s/.test(line)) closeEntry();
    const p = /^\s+(?:-\s+)?path:\s*(.+)$/.exec(line);
    if (p) entryPath = p[1]!.trim();
    if (/^\s+(?:-\s+)?kind:\s*spec\s*$/.test(line)) entryIsSpec = true;
  }
  closeEntry();
  if (!candidate) candidate = firstPath;
  if (!candidate) candidate = "SPEC.md";
  const p = path.join(sliceDir, candidate);
  const bytes = fs.exists(p) ? fs.readFile(p) : null;
  if (bytes === null) return null;
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

export function projectSliceScope(fs: ScopeFsDeps, sliceDir: string, readPolicy?: ProofPolicyRead): SliceScopeDetail | null {
  const readmePath = NODE_FILE_PRECEDENCE
    .map((n) => path.join(sliceDir, n))
    .find((p) => fs.exists(p));
  if (!readmePath) return null;
  const content = fs.readFile(readmePath);
  if (!content) return null;
  const fm = extractFrontmatterRaw(content) ?? "";

  const items = readProofContract(sliceDir, fs);
  const proofDir = path.join(sliceDir, "proof");
  const drops: C1Drop[] = [];
  if (fs.exists(proofDir) && fs.isDirectory(proofDir)) {
    for (const f of fs.listDir(proofDir)) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      const raw = fs.readFile(path.join(proofDir, f));
      if (!raw) continue;
      const drop = parseC1Drop(f, raw);
      if (drop) drops.push(drop);
    }
  }
  const contract = pairContract(items, drops);
  const paired = contract.filter((c) => c.paired).length;

  const heading = /^# (.+)$/m.exec(content);
  const progressPath = path.join(sliceDir, "PROGRESS.md");
  return {
    readiness: readSliceReadiness(sliceDir, fs, readPolicy),
    dirName: path.basename(sliceDir),
    id: fmValue(fm, "id"),
    displayName: heading ? heading[1]!.trim() : path.basename(sliceDir),
    status: fmValue(fm, "status"),
    stage: fmValue(fm, "stage"),
    locks: readLocks(fm),
    proof: { paired, total: items.length },
    intent: sectionBody(content, "Intent"),
    miniRequirements: miniRequirements(content),
    proofContract: contract,
    progressPath: fs.exists(progressPath) ? progressPath : null,
    // LOOK delta D1（在源头回答）：store 不保存 sha，但保存 locked artifact PATH；hash 在 projection
    // 时根据 CURRENT 字节计算（store-DERIVED、实时，绝非转录值）。优先使用首个 spec-kind artifact。
    specShaShort: specShaFromLockedArtifacts(fs, sliceDir, fm),
    // 为 TUI payload 保留兼容字段名。当前 SPEC 与可读的旧版 PRD lock 都满足旧 availability bit。
    prdExists:
      fs.exists(path.join(sliceDir, "SPEC.md")) ||
      fs.exists(path.join(sliceDir, "IMPLEMENTATION-PRD.md")) ||
      fm.includes("SPEC.md") ||
      fm.includes("IMPLEMENTATION-PRD"),
  };
}

export function projectMissionScopes(fs: ScopeFsDeps, missionsRoot: string, mission: string): MissionScopes | null {
  const missionDir = path.join(missionsRoot, mission);
  const slicesDir = path.join(missionDir, "slices");
  if (!fs.exists(missionDir)) return null;
  const slices: SliceScopeSummary[] = [];
  if (fs.exists(slicesDir) && fs.isDirectory(slicesDir)) {
    for (const entry of fs.listDir(slicesDir)) {
      const sliceDir = path.join(slicesDir, entry);
      if (!fs.isDirectory(sliceDir)) continue;
      const detail = projectSliceScope(fs, sliceDir);
      if (!detail) continue;
      const { intent: _i, miniRequirements: _m, proofContract: _p, progressPath: _pp, specShaShort: _s, prdExists: _pe, ...summary } = detail;
      slices.push(summary);
    }
  }
  return { mission, slices };
}
