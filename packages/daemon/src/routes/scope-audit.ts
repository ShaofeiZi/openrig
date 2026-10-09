import { Hono } from "hono";
import { attestationLineage, type AttestationLineage } from "../domain/scope/attestation-lineage.generated.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  type AuditFinding,
  classifyScopeItem,
  deriveMissionDependencyGraph,
  type MissionDependencyGraph,
  type ScopeAuditResult,
} from "../domain/scope/scope-audit.js";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import { NOTES_FILE_PRECEDENCE, resolveNodeFile, resolveNotesFile } from "../domain/scope/node-file.js";

function extractFrontmatterRaw(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? match[1]! : null;
}

function directoryHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

function readNodeFrontmatter(dir: string): Record<string, unknown> {
  const nodeFile = resolveNodeFile(dir);
  if (!nodeFile) return {};
  try {
    const raw = extractFrontmatterRaw(fs.readFileSync(nodeFile, "utf-8"));
    if (raw === null) return {};
    const parsed = YAML.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function nodeId(frontmatter: Record<string, unknown>): string | null {
  const value = frontmatter.id ?? frontmatter.dotId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 后台服务侧文件系统读取器，供共享的纯图推导使用。
 * 图是建议性的：格式错误或过期数据只变成一条建议，绝不改变 audit 状态，也不阻止响应。 */
function buildAuditDependencyGraph(missionName: string, missionDir: string): MissionDependencyGraph {
  const missionFrontmatter = readNodeFrontmatter(missionDir);
  const slices: Array<{
    id: string | null;
    name: string;
    dependsOn: unknown;
    active: boolean;
    ordinal: number;
  }> = [];

  for (const bucket of ["slices", "closed"] as const) {
    const root = path.join(missionDir, bucket);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = /^(\d+)-(.+)$/.exec(entry.name);
      if (!match) continue;
      const frontmatter = readNodeFrontmatter(path.join(root, entry.name));
      const status = typeof frontmatter.status === "string" ? frontmatter.status.toLowerCase() : "";
      slices.push({
        id: nodeId(frontmatter),
        name: entry.name,
        dependsOn: frontmatter.depends_on,
        active: bucket === "slices" && !status.startsWith("closed") && !status.startsWith("shipped"),
        ordinal: Number(match[1]),
      });
    }
  }
  slices.sort((a, b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name));

  return deriveMissionDependencyGraph({
    mission: {
      id: nodeId(missionFrontmatter),
      name: missionName,
      dependsOn: missionFrontmatter.depends_on,
    },
    slices,
  });
}

// OPR.0.4.4.19 FR-10（C1 backstop 输入）——列出该 slice proof/ 下的 markdown
// 制品及其原始 frontmatter。媒体文件按构造豁免。目录缺失/不可读时返回 undefined，
// 使分类器保持惰性。
function listProofArtifactsForAudit(proofDir: string): Array<{ path: string; frontmatterRaw: string | null }> | undefined {
  if (!fs.existsSync(proofDir)) return undefined;
  try {
    return fs.readdirSync(proofDir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => {
        const artifactPath = path.join(proofDir, f);
        return { path: artifactPath, frontmatterRaw: extractFrontmatterRaw(fs.readFileSync(artifactPath, "utf-8")) };
      });
  } catch {
    return undefined;
  }
}


/**
 * 仅建议：一个工作节点同时携带两个 authored 文件。与同名 CLI finding 的后台服务孪生——
 * 同一契约、独立代码，因为后台服务不能 import packages/cli。
 *
 * SPEC.md 胜出，什么都不阻塞。重点在于：否则被遮蔽的 README.md 是不可见的，
 * 而任何仍在读旧名的表面读到的是另一个文件。
 */
function shadowedNodeFileFinding(dir: string, level: "mission" | "slice"): AuditFinding | null {
  if (!fs.existsSync(path.join(dir, "SPEC.md")) || !fs.existsSync(path.join(dir, "README.md"))) return null;
  return {
    kind: "shadowed_node_file",
    severity: "low",
    path: dir,
    message: `${level} 同时有 SPEC.md 和 README.md；SPEC.md 是 authored 节点文件并胜出，因此 README.md 被遮蔽，任何仍读旧名的表面会看到不同内容。`,
    remediation: "把 README.md 中仍需要的内容折进 SPEC.md，然后删除被遮蔽的文件。仅建议——不阻塞任何东西。",
  };
}

export function scopeAuditRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!indexer) {
      return c.json({ error: "slices_indexer_unavailable" }, 503);
    }
    if (!indexer.isReady()) {
      return c.json({ error: "slices_root_not_configured" }, 503);
    }

    const missionName = c.req.query("mission");
    if (!missionName) {
      return c.json({ error: "missing_mission_param", hint: "传入 ?mission=<name>" }, 400);
    }

    const missionsRoot = indexer.slicesRoot;
    const missionDir = path.join(missionsRoot, missionName);
    if (!fs.existsSync(missionDir)) {
      return c.json({ error: "mission_not_found", mission: missionName }, 404);
    }

    // qitem-43d69e17——一次 audit 请求是一个复合操作：下面逐 slice 的 indexer.get()
    // 遍历共享同一个 membership 批次（改前：每个未缓存的 get 自建 2 扫描批次——
    // 共 2N 次队列扫描，40 个 slice 时为 80）。处理器体完全同步。
    return indexer.withMembershipBatch(() => {
      const missionReadme = resolveNodeFile(missionDir) ?? path.join(missionDir, "SPEC.md");
      const missionProgress = path.join(missionDir, "PROGRESS.md");
      const missionNotesResolution = resolveNotesFile(missionDir);
      const missionNotesPath = missionNotesResolution?.path
        ?? path.join(missionDir, NOTES_FILE_PRECEDENCE[0]);
      const missionReadmeExists = fs.existsSync(missionReadme);
      const missionProgressExists = fs.existsSync(missionProgress);
      const graph = buildAuditDependencyGraph(missionName, missionDir);

      let missionResult: ScopeAuditResult;
      if (!missionReadmeExists && missionProgressExists) {
        missionResult = {
          railStatus: "malformed",
          findings: [{
            kind: "orphan_progress",
            severity: "high",
            path: missionDir,
            message: "PROGRESS.md 存在，但没有 SPEC.md 或旧版 README.md（孤儿 progress rail，无支撑的 scope 项）",
            remediation: "添加带 frontmatter id 的 SPEC.md，或删除孤儿 PROGRESS.md",
          }],
          frontmatterError: null,
        };
      } else {
        const missionFm = missionReadmeExists
          ? extractFrontmatterRaw(fs.readFileSync(missionReadme, "utf-8"))
          : null;
        missionResult = classifyScopeItem({
          id: null,
          path: missionDir,
          readmeFrontmatterRaw: missionFm,
            progressFileExists: missionProgressExists,
            readmeOnlyMarker: false,
            isActiveRelease: true,
            level: "mission",
            missionNotesResolution,
            missionNotesPath,
          });
      }

      const slicesDir = path.join(missionDir, "slices");
      const missionShadow = shadowedNodeFileFinding(missionDir, "mission");
      if (missionShadow) missionResult.findings.push(missionShadow);

      const sliceResults: Array<{ name: string; result: ScopeAuditResult; attestations?: AttestationLineage }> = [];

      if (fs.existsSync(slicesDir)) {
        for (const entry of fs.readdirSync(slicesDir)) {
          const sliceDir = path.join(slicesDir, entry);
          if (!fs.statSync(sliceDir).isDirectory()) continue;
          const sliceReadme = resolveNodeFile(sliceDir) ?? path.join(sliceDir, "SPEC.md");
          const sliceProgress = path.join(sliceDir, "PROGRESS.md");
          const proofFile = path.join(sliceDir, "PROOF.md");
          const proofDir = path.join(sliceDir, "proof");

          if (!fs.existsSync(sliceReadme)) {
            if (fs.existsSync(sliceProgress)) {
              sliceResults.push({
                name: entry,
                result: {
                  railStatus: "malformed",
                  findings: [{
                    kind: "orphan_progress",
                    severity: "high",
                    path: sliceDir,
                    message: "PROGRESS.md 存在，但没有 SPEC.md 或旧版 README.md（孤儿 progress rail，无支撑的 scope 项）",
                    remediation: "添加带 frontmatter id 的 SPEC.md，或删除孤儿 PROGRESS.md",
                  }],
                  frontmatterError: null,
                },
              });
            } else {
              const noReadmeResult = classifyScopeItem({
                id: null,
                path: sliceDir,
                readmeFrontmatterRaw: null,
                progressFileExists: false,
                readmeOnlyMarker: false,
                isActiveRelease: true,
                level: "slice",
              });
              sliceResults.push({ name: entry, result: noReadmeResult });
            }
            continue;
          }

          const sliceReadmeContent = fs.readFileSync(sliceReadme, "utf-8");
          const sliceFm = extractFrontmatterRaw(sliceReadmeContent);
          const readmeOnlyMarker = sliceFm !== null && /^progress_rail\s*:\s*readme-only/m.test(sliceFm);
          const indexedSlice = indexer.get(entry);

          const sliceResult = classifyScopeItem({
            id: null,
            path: sliceDir,
            readmeFrontmatterRaw: sliceFm,
            progressFileExists: fs.existsSync(sliceProgress),
            readmeOnlyMarker,
            isActiveRelease: true,
            level: "slice",
            proofFileExists: fs.existsSync(proofFile),
            proofFilePath: proofFile,
            proofDirExists: fs.existsSync(proofDir),
            proofDirPath: proofDir,
            proofDirHasEntries: directoryHasEntries(proofDir),
            hasProofPacket: indexedSlice?.proofPacket !== null && indexedSlice?.proofPacket !== undefined,
            sliceStatus: indexedSlice?.rawStatus ?? null,
            // OPR.0.4.4.19 FR-10 backstop 输入（与 CLI builder 对齐）。
            proofArtifacts: listProofArtifactsForAudit(proofDir),
            implementationPrdExists: fs.existsSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md")),
            // OPR.0.4.4.23 convention-section 建议输入（与 CLI builder 对齐）。
            nodeFileName: path.basename(sliceReadme) as "SPEC.md" | "README.md",
            readmeContent: sliceReadmeContent,
            implementationPrdContent: fs.existsSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"))
              ? fs.readFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "utf-8")
              : null,
          });

          if (!/^\d{2}-/.test(entry)) {
            sliceResult.findings.push({
              kind: "id_convention_violation",
              severity: "high",
              path: sliceDir,
              message: `目录 "${entry}" 不符合 NN-slug slice 命名约定（例如 01-my-slice）`,
              remediation: "重命名为 NN-slug 格式，或移出 slices/",
            });
          }

          sliceResults.push({ name: entry, result: sliceResult, attestations: attestationLineage(sliceFm) });
        }
      }

      for (const sr of sliceResults) {
        const shadow = shadowedNodeFileFinding(path.join(slicesDir, sr.name), "slice");
        if (shadow) sr.result.findings.push(shadow);
      }

      const allFindings = [
        ...missionResult.findings,
        ...sliceResults.flatMap((s) => s.result.findings),
      ];
      const hardFindings = allFindings.filter((f) => f.severity === "high");

      return c.json({
        ok: hardFindings.length === 0,
        mission: {
          name: missionName,
          railStatus: missionResult.railStatus,
          frontmatterError: missionResult.frontmatterError,
          findings: missionResult.findings,
        },
        slices: sliceResults.map((s) => ({
          name: s.name,
          railStatus: s.result.railStatus,
          frontmatterError: s.result.frontmatterError,
          findings: s.result.findings,
          // OPR.0.5.0.18——修订谱系（仅在重新盖章时存在）。
          ...(s.attestations ? { attestations: s.attestations } : {}),
        })),
        graph,
        totalFindings: allFindings.length,
      });
    });
  });

  return app;
}
