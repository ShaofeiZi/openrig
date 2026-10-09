// Slice 28 Checkpoint C-3——Skill 库 HTTP 路由。
//
// SC-29 EXCEPTION #11 累积（逐字声明见 packages/daemon/src/routes/plugins.ts
// 头部；本文件新增与 C-1 落地的 plugin 端点对称的 skill 表面）：
//
// Slice 28 SKILL 侧范围（叠加只读端点）：
//   GET /api/skills/library                          → LibrarySkillPublic[]
//   GET /api/skills/:id/files/list?path=<rel>        → 文件列表
//   GET /api/skills/:id/files/read?path=<rel>        → 文件内容
//
// 为何存在：见 slice 28 C-final 的 velocity-qa BLOCKING 结论
// （qitem-20260513045711-39ccfdf3）——在 founder-walk VM 上，后台服务的
// 白名单不含 openrig 源码树，因此先前基于 /api/files/list 的 useLibrarySkills
// 三路径探针够不到 `packages/daemon/specs/agents/shared/skills`。
// 后台服务自有发现通过后台服务安装路径解析 shared-skills（与
// /api/plugins/:id/files/* 通过 pluginDiscoveryService 解析对称）。

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillLibraryDiscoveryService } from "../domain/skill-library-discovery.js";
import {
  resolveAllowedDirectory,
  resolveAllowedFile,
  FilePathSafetyError,
  type AllowlistRoot,
} from "../domain/files/path-safety.js";
import { sha256Hex } from "../domain/files/file-write-service.js";
import { FILE_READ_TRUNCATION_BYTES } from "./files.js";

type ContextGetter = (key: string) => unknown;

function getService(c: { get: ContextGetter }): SkillLibraryDiscoveryService | undefined {
  return c.get("skillLibraryDiscoveryService" as never) as SkillLibraryDiscoveryService | undefined;
}

function skillRootAllowlist(absolutePath: string): AllowlistRoot[] {
  // 限定在该 skill 文件夹内的合成单 root 白名单。
  // 与 pluginRootAllowlist（plugins.ts）同模式——通过单元素白名单复用既有的
  // path-safety 辅助。
  let canonical: string;
  try {
    canonical = fs.realpathSync(absolutePath);
  } catch {
    canonical = path.resolve(absolutePath);
  }
  return [{ name: "skill", canonicalPath: canonical }];
}

function pathSafetyErrorResponse(
  c: { json: (body: unknown, status?: number) => Response },
  err: FilePathSafetyError,
): Response {
  const status =
    err.code === "root_unknown" ? 400
    : err.code === "path_invalid" || err.code === "path_escape" ? 400
    : err.code === "stat_failed" ? 404
    : err.code === "not_a_file" || err.code === "not_a_directory" ? 400
    : 500;
  return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
}

export function skillsRoutes(): Hono {
  const router = new Hono();

  // GET /library——合并的 skill 列表（workspace + openrig 托管）。
  router.get("/library", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "skill_library_unavailable" }, 503);
    return c.json(service.listLibrarySkillsPublic());
  });

  // GET /:id/files/list——列出 skill 文件夹内的一个目录。
  // 挂载在任何裸 /:id 路由之前（防御性——当前没有裸 /:id 端点，
  // 但顺序纪律与 plugins.ts 一致）。
  router.get("/:id/files/list", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "skill_library_unavailable" }, 503);
    const id = c.req.param("id");
    const skill = service.getSkill(id);
    if (!skill) return c.notFound();
    const relativePath = c.req.query("path") ?? "";
    try {
      const allowlist = skillRootAllowlist(skill.absolutePath);
      const resolved = resolveAllowedDirectory(allowlist, "skill", relativePath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return c.json({
        skillId: id,
        path: relativePath,
        entries: entries
          .map((entry) => {
            const fullPath = path.join(resolved, entry.name);
            let stat: fs.Stats | null = null;
            try { stat = fs.statSync(fullPath); } catch { /* 跳过 stat 失败 */ }
            return {
              name: entry.name,
              type: entry.isDirectory() ? "dir" as const : entry.isFile() ? "file" as const : "other" as const,
              size: stat?.isFile() ? stat.size : null,
              mtime: stat ? stat.mtime.toISOString() : null,
            };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
      });
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "list_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /:id/files/read——读取 skill 文件夹内的一个文件。
  router.get("/:id/files/read", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "skill_library_unavailable" }, 503);
    const id = c.req.param("id");
    const skill = service.getSkill(id);
    if (!skill) return c.notFound();
    const relativePath = c.req.query("path") ?? "";
    if (!relativePath) return c.json({ error: "path_required" }, 400);
    try {
      const allowlist = skillRootAllowlist(skill.absolutePath);
      const resolved = resolveAllowedFile(allowlist, "skill", relativePath);
      const stat = fs.statSync(resolved);
      const fullContent = fs.readFileSync(resolved);
      const truncated = stat.size > FILE_READ_TRUNCATION_BYTES;
      const returnedContent = truncated
        ? fullContent.subarray(0, FILE_READ_TRUNCATION_BYTES)
        : fullContent;
      return c.json({
        skillId: id,
        path: relativePath,
        absolutePath: resolved,
        content: returnedContent.toString("utf-8"),
        mtime: stat.mtime.toISOString(),
        contentHash: sha256Hex(fullContent),
        size: stat.size,
        truncated,
        truncatedAtBytes: truncated ? FILE_READ_TRUNCATION_BYTES : null,
        totalBytes: stat.size,
      });
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "read_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  router.get("/audit", async (c) => {
    const service = getService(c);
    if (!service) return c.json({ ok: false, error: "skill_library_unavailable" }, 503);

    const { discoverSkillsWithProvenance } = await import("../domain/skill-discovery.js");
    const { auditSkills } = await import("../domain/skill-audit.js");

    const homedir = c.get("homedir" as never) as string | undefined ?? process.env.HOME ?? "/tmp";
    const cwd = c.get("cwd" as never) as string | undefined ?? process.cwd();

    const claudeResult = discoverSkillsWithProvenance({ runtime: "claude-code", homedir, cwd });
    const codexResult = discoverSkillsWithProvenance({ runtime: "codex", homedir, cwd });

    const seenPaths = new Set<string>();
    const allSkills: typeof claudeResult.skills = [];
    for (const s of claudeResult.skills) {
      seenPaths.add(s.path);
      allSkills.push(s);
    }
    for (const s of codexResult.skills) {
      if (!seenPaths.has(s.path)) {
        seenPaths.add(s.path);
        allSkills.push(s);
      }
    }

    let mirrorDrift: { stale: boolean; changes: string[] } | undefined;
    let mirrorDriftError: string | undefined;
    try {
      const { checkMirrorDriftSafe } = await import("../domain/skill-mirror-drift.js");
      const driftResult = await checkMirrorDriftSafe();
      if (driftResult.ok) {
        mirrorDrift = { stale: driftResult.stale, changes: driftResult.changes };
      } else {
        mirrorDriftError = driftResult.reason;
      }
    } catch (err) {
      mirrorDriftError = `镜像漂移检查不可用：${err instanceof Error ? err.message : String(err)}`;
    }

    const auditResult = auditSkills(allSkills, { mirrorDrift });
    const totalFindings = auditResult.entries.filter((e) => !e.shadowed).reduce((sum, e) => sum + e.findings.length, 0)
      + auditResult.mirrorDriftFindings.length;
    const rejected = [...claudeResult.rejected, ...codexResult.rejected];

    return c.json({ ok: true, entries: auditResult.entries, mirrorDriftFindings: auditResult.mirrorDriftFindings, mirrorDriftError, totalFindings, rejected });
  });

  return router;
}
