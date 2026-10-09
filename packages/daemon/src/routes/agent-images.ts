// Fork 原语 + Starter Agent Images v0（PL-016）——后台服务 HTTP 路由。
//
// 端点：
//   GET    /api/agent-images/library                — 列出全部镜像（resume token 已脱敏）
//   POST   /api/agent-images/library/sync           — 重新遍历发现根
//   GET    /api/agent-images/library/:id            — 镜像 manifest + 统计（resume token 已脱敏）
//   GET    /api/agent-images/library/:id/preview    — manifest + 带大小的补充文件元数据
//   POST   /api/agent-images/library/:id/pin        — pin 以防 prune
//   POST   /api/agent-images/library/:id/unpin      — 取消 pin
//   DELETE /api/agent-images/library/:id            — 删除（除非 force=true，否则受 evidence guard 约束）
//   POST   /api/agent-images/snapshot               — 从源席位捕获新镜像
//   POST   /api/agent-images/prune                  — 清理可驱逐镜像（默认 dry-run）
//
// Resume token 绝不在 wire 上返回——在路由边界脱敏。
// 只有 rigspec-instantiator（进程内）直接消费 token。

import { Hono } from "hono";
import { rmSync } from "node:fs";
import type Database from "better-sqlite3";
import type { AgentImageLibraryService } from "../domain/agent-images/agent-image-library-service.js";
import type { SnapshotCapturer } from "../domain/agent-images/snapshot-capturer.js";
import { evaluateProtection } from "../domain/agent-images/evidence-guard.js";
import { discoverResumeToken } from "../domain/agent-images/resume-token-discovery.js";
import { convergeOp } from "../domain/topology-converge.js";
import type { PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import { AgentImageError, type AgentImageEntry } from "../domain/agent-images/agent-image-types.js";

interface PruneBody {
  dryRun?: boolean;
  force?: boolean;
}

interface SnapshotBody {
  sourceSession?: string;
  name?: string;
  version?: string;
  notes?: string;
  estimatedTokens?: number;
  lineage?: string[];
}

interface DeleteQuery {
  force?: boolean;
}

interface ForkBody {
  sourceSession?: string;
  rigId?: string;
  pod?: string;
  /** fork 继任者的新 member id。 */
  member?: string;
  rigRoot?: string;
  /** 为 true 时，捕获 + PIN 一个持久镜像，并通过 mode:agent_image launch。 */
  keepImage?: boolean;
  imageName?: string;
  imageVersion?: string;
  edges?: Array<{ from: string; to: string; kind: string }>;
}

/** fork 继任者镜像源席位的 launch 形状。native resume id 单独解析
 * （discoverResumeToken）并保持后台服务本地——刻意不放入此形状，使其绝不会泄漏到响应中。 */
interface ForkSourceShape {
  runtime: string | null;
  agentRef: string | null;
  profile: string | null;
  cwd: string | null;
  codexConfigProfile: string | null;
  /** OPR.0.4.8.3 Seam B：源席位的原始 permission_policy 引用——fork/镜像化的继任者
   *  保留源的策略挂载（preflight 表面 2）。 */
  permissionPolicy: string | null;
  /** OPR.0.5.6.23 member (b)：fork 不得擦除的 node 携带 optionals——
   *  尤其是 model pin（0.4.6.PI1 relaunch-on-default 类）。 */
  model: string | null;
  role: string | null;
  restorePolicy: string | null;
  label: string | null;
}

function resolveForkSourceNode(db: Database.Database, sourceSession: string): ForkSourceShape | null {
  // SELECT n.*，使缺少 codex_config_profile 的旧 DB 对该 key 直接返回 undefined，
  // 而不是抛错。
  const row = db
    .prepare(
      `SELECT n.* FROM sessions s JOIN nodes n ON n.id = s.node_id
       WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`,
    )
    .get(sourceSession) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    runtime: (row["runtime"] as string | null) ?? null,
    agentRef: (row["agent_ref"] as string | null) ?? null,
    profile: (row["profile"] as string | null) ?? null,
    cwd: (row["cwd"] as string | null) ?? null,
    codexConfigProfile: (row["codex_config_profile"] as string | null) ?? null,
    permissionPolicy: (row["permission_policy"] as string | null) ?? null,
    model: (row["model"] as string | null) ?? null,
    role: (row["role"] as string | null) ?? null,
    restorePolicy: (row["restore_policy"] as string | null) ?? null,
    label: (row["label"] as string | null) ?? null,
  };
}

function redactResumeToken<T extends Pick<AgentImageEntry, "sourceResumeToken">>(entry: T): Omit<T, "sourceResumeToken"> & { sourceResumeToken: string } {
  return { ...entry, sourceResumeToken: "(redacted)" };
}

export interface AgentImageRoutesDeps {
  /** evidence guard 扫描的 spec-library 根。v0 包含
   *  规范用户 spec 目录 + 工作区 specs 根。 */
  specRoots: () => readonly string[];
}

export function agentImagesRoutes(deps: AgentImageRoutesDeps): Hono {
  const router = new Hono();

  router.get("/library", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    return c.json(lib.list().map(redactResumeToken));
  });

  router.post("/library/sync", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const result = lib.scan();
    return c.json({ ...result, entries: lib.list().map(redactResumeToken) });
  });

  router.post("/snapshot", async (c) => {
    const capturer = c.get("snapshotCapturer" as never) as SnapshotCapturer | undefined;
    if (!capturer) return c.json({ error: "snapshot_capturer_unavailable" }, 503);
    const body = (await c.req.json<SnapshotBody>().catch(() => ({}))) as SnapshotBody;
    if (!body.sourceSession || !body.name) {
      return c.json({
        error: "missing_required_fields",
        hint: "POST body 必须包含 { sourceSession, name }",
      }, 400);
    }
    try {
      const result = capturer.capture({
        sourceSession: body.sourceSession,
        name: body.name,
        version: body.version,
        notes: body.notes,
        estimatedTokens: body.estimatedTokens,
        lineage: body.lineage,
      });
      // 在响应中脱敏 resume token——operator 只需要镜像 id 和磁盘路径。
      return c.json({
        imageId: result.imageId,
        imagePath: result.imagePath,
        manifest: { ...result.manifest, sourceResumeToken: "(redacted)" },
      });
    } catch (err) {
      if (err instanceof AgentImageError) {
        const status = err.code === "image_not_found" ? 404
          : err.code === "runtime_mismatch" ? 400
          : err.code === "image_referenced" ? 409
          : 500;
        return c.json({ error: err.code, message: err.message, details: err.details ?? null }, status);
      }
      return c.json({ error: "snapshot_failed", message: (err as Error).message }, 500);
    }
  });

  // OPR.0.4.3.05 seat-forking 收尾——窄后台服务 fork composer。
  //
  // `zrig fork <source-session>` 发到这里。这是 slice 中唯一净新增表面：
  // 它把已交付原语（resume-token 发现 + add_member converge，或 snapshot + pin +
  // add_member）组合成一个 operator 动词。它之所以在服务端存在，是因为 native resume id
  // 按设计在每个 wire 边界脱敏——默认一次性 fork 必须在进程内解析 token，
  // 使 id 绝不离开后台服务。
  //
  //   default            → discoverResumeToken → add_member(mode: fork,
  //                        native_id) → launch。无镜像。native id 保持
  //                        后台服务本地（绝不序列化进响应）。
  //   { keepImage: true } → snapshot 捕获 → PIN（evidence-guard 保护）
  //                        → add_member(mode: agent_image) → launch。
  router.post("/fork", async (c) => {
    const db = c.get("db" as never) as Database.Database | undefined;
    const podInstantiator = c.get("podInstantiator" as never) as PodRigInstantiator | undefined;
    if (!db || !podInstantiator) return c.json({ error: "fork_composer_unavailable" }, 503);

    const body = (await c.req.json<ForkBody>().catch(() => ({}))) as ForkBody;
    const sourceSession = body.sourceSession;
    const rigId = body.rigId;
    const pod = body.pod;
    const member = body.member;
    if (!sourceSession || !rigId || !pod || !member) {
      return c.json({
        error: "missing_required_fields",
        hint: "POST body 必须包含 { sourceSession, rigId, pod, member }",
      }, 400);
    }
    const rigRoot = typeof body.rigRoot === "string" ? body.rigRoot : ".";

    // 解析源席位的 launch 形状，使继任者镜像它
    // （agent_ref / profile / cwd / codex profile）。原生续接 ID
    // 在此不读——它在下面单独解析并保持后台服务本地。
    const source = resolveForkSourceNode(db, sourceSession);
    if (!source) {
      return c.json({
        error: "session_not_found",
        message: `未找到源会话 '${sourceSession}'。运行 'zrig ps --nodes' 查看正在运行的内容。`,
      }, 404);
    }

    let sessionSource: Record<string, unknown>;
    let keptImage: { id: string; name: string; version: string; pinned: true } | undefined;

    if (body.keepImage) {
      // --keep-image：持久镜像 → PIN-ON-KEEP（evidence guard 保护 pinned 镜像
      // 免于 prune/delete）→ agent_image launch。native id 被捕获进 manifest
      // （在每个路由边界脱敏），只在进程内被 instantiator 消费——绝不离开此处。
      const capturer = c.get("snapshotCapturer" as never) as SnapshotCapturer | undefined;
      const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
      if (!capturer || !lib) return c.json({ error: "snapshot_capturer_unavailable" }, 503);
      const imageName = (body.imageName && body.imageName.trim()) || `fork-${member}`;
      const version = (body.imageVersion && body.imageVersion.trim()) || "1";
      try {
        const cap = capturer.capture({ sourceSession, name: imageName, version });
        // PIN-ON-KEEP：保护即 evidence guard 的 PINNED reason，
        // 一个显式 + 已交付的机制，能在 prune/delete 中存活。
        lib.pin(cap.imageId);
        keptImage = { id: cap.imageId, name: imageName, version, pinned: true };
      } catch (err) {
        if (err instanceof AgentImageError) {
          const status = err.code === "image_not_found" ? 404
            : err.code === "runtime_mismatch" ? 400
            : err.code === "image_referenced" ? 409
            : 500;
          return c.json({ error: err.code, message: err.message, details: err.details ?? null }, status);
        }
        return c.json({ error: "fork_snapshot_failed", message: (err as Error).message }, 500);
      }
      sessionSource = { mode: "agent_image", ref: { kind: "image_name", value: imageName, version } };
    } else {
      // 默认一次性：在服务端解析 native resume id。在 terminal / 无 token 时诚实拒绝——
      // 绝不伪造（resume-honesty）。
      const discovery = discoverResumeToken(db, sourceSession);
      if (!discovery.ok) {
        const status = discovery.failure.code === "session_not_found" ? 404 : 400;
        return c.json({ error: discovery.failure.code, message: discovery.failure.message }, status);
      }
      const nativeId = discovery.result.nativeId;
      if (!nativeId) {
        return c.json({
          error: "resume_token_unavailable",
          message: `无法为 ${discovery.result.runtime} 源会话 '${sourceSession}' 发现 resume token。该席位可能还没有 native conversation id——在它产出输出后重试。未伪造 token，也未冷启动新席位。`,
        }, 409);
      }
      // native id 仅用于在下面构建进程内 member fragment。
      // 刻意不在响应中回显（保持后台服务本地，与路由脱敏边界一致）。
      sessionSource = { mode: "fork", ref: { kind: "native_id", value: nativeId } };
    }

    const memberFragment: Record<string, unknown> = {
      id: member,
      runtime: source.runtime,
      ...(source.agentRef ? { agent_ref: source.agentRef } : {}),
      ...(source.profile ? { profile: source.profile } : {}),
      ...(source.cwd ? { cwd: source.cwd } : {}),
      ...(source.codexConfigProfile ? { codex_config_profile: source.codexConfigProfile } : {}),
      ...(source.permissionPolicy ? { permission_policy: source.permissionPolicy } : {}),
      // OPR.0.5.6.23 member (b)：每个 node 携带的 optional 都随 fork 携带。
      ...(source.model ? { model: source.model } : {}),
      ...(source.role ? { role: source.role } : {}),
      ...(source.restorePolicy ? { restore_policy: source.restorePolicy } : {}),
      ...(source.label ? { label: source.label } : {}),
      session_source: sessionSource,
    };

    const converged = await convergeOp(
      { instantiator: podInstantiator },
      rigId,
      { kind: "add_member", pod, member: memberFragment, edges: body.edges },
      rigRoot,
    );
    if (converged.kind !== "add_member" || !converged.supported) {
      return c.json({ error: "fork_failed", message: "fork add_member 的 converge 结果出乎意料" }, 500);
    }
    const outcome = converged.outcome;
    // outcome 绝不携带 native id（add_member 不持久化 session_source；
    // RigRepository.addNode 不存储 agent-image 引用）。
    if (!outcome.ok) {
      const status =
        outcome.code === "rig_not_found" || outcome.code === "pod_not_found" ? 404
        : outcome.code === "member_conflict" ? 409
        : outcome.code === "edge_unresolved" || outcome.code === "validation_failed" || outcome.code === "preflight_failed" ? 400
        : 500;
      // 即使 launch 失败，keep 的镜像也已 pinned/protected——诚实报告，
      // 使 operator 知道它已被保留。
      return c.json({ ...outcome, ...(keptImage ? { image: keptImage } : {}) }, status);
    }
    return c.json({ ...outcome, ...(keptImage ? { image: keptImage } : {}) }, 201);
  });

  router.post("/prune", async (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const body = (await c.req.json<PruneBody>().catch(() => ({}))) as PruneBody;
    const dryRun = body.dryRun !== false;
    const force = !!body.force;
    const images = lib.list();
    const protections = evaluateProtection({
      images,
      specRoots: deps.specRoots(),
    });
    const protectedImages = protections.filter((p) => p.protected);
    const evictable = protections.filter((p) => !p.protected);
    if (dryRun) {
      return c.json({
        dryRun: true,
        protected: protectedImages,
        evictable: evictable.map((p) => ({ imageId: p.imageId, imageName: p.imageName, imageVersion: p.imageVersion })),
      });
    }
    // 真正 prune：删除可驱逐镜像。Force 覆盖 guard——受保护镜像也会被删。
    // force 有灾难性 bounce 风险；在响应中显眼呈现。
    const targets = force ? protections : evictable;
    const deleted: string[] = [];
    const errors: Array<{ imageId: string; error: string }> = [];
    for (const t of targets) {
      const entry = lib.get(t.imageId);
      if (!entry) continue;
      try {
        rmSync(entry.sourcePath, { recursive: true, force: true });
        deleted.push(t.imageId);
      } catch (err) {
        errors.push({ imageId: t.imageId, error: (err as Error).message });
      }
    }
    lib.scan();
    return c.json({
      dryRun: false,
      forced: force,
      deleted,
      errors,
      protected: force ? [] : protectedImages,
    });
  });

  router.get("/library/:id", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    if (id === "sync" || id === "snapshot" || id === "prune") return c.notFound();
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `镜像库中未找到镜像 '${id}'` }, 404);
    return c.json(redactResumeToken(entry));
  });

  router.get("/library/:id/preview", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `镜像库中未找到镜像 '${id}'` }, 404);
    return c.json({
      id,
      name: entry.name,
      version: entry.version,
      runtime: entry.runtime,
      sourceSeat: entry.sourceSeat,
      manifestEstimatedTokens: entry.manifestEstimatedTokens,
      derivedEstimatedTokens: entry.derivedEstimatedTokens,
      stats: entry.stats,
      lineage: entry.lineage,
      pinned: entry.pinned,
      notes: entry.notes,
      files: entry.files,
      starterSnippet: buildStarterSnippet(entry),
    });
  });

  router.post("/library/:id/pin", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    try {
      lib.pin(id);
      return c.json({ ok: true, id, pinned: true });
    } catch (err) {
      if (err instanceof AgentImageError && err.code === "image_not_found") {
        return c.json({ error: err.code, message: err.message }, 404);
      }
      return c.json({ error: "pin_failed", message: (err as Error).message }, 500);
    }
  });

  router.post("/library/:id/unpin", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    try {
      lib.unpin(id);
      return c.json({ ok: true, id, pinned: false });
    } catch (err) {
      if (err instanceof AgentImageError && err.code === "image_not_found") {
        return c.json({ error: err.code, message: err.message }, 404);
      }
      return c.json({ error: "unpin_failed", message: (err as Error).message }, 500);
    }
  });

  router.delete("/library/:id", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    const force = ((c.req.query("force") as string | undefined) ?? "") === "true";
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `镜像库中未找到镜像 '${id}'` }, 404);
    // 非 force 删除时的 evidence guard。
    if (!force) {
      const protections = evaluateProtection({
        images: lib.list(),
        specRoots: deps.specRoots(),
      });
      const status = protections.find((p) => p.imageId === id);
      if (status && status.protected) {
        return c.json({
          error: "image_referenced",
          message: `镜像 '${id}' 受保护：${status.reasons.join(", ")}。使用 force=true 覆盖。`,
          reasons: status.reasons,
          references: status.references,
        }, 409);
      }
    }
    try {
      rmSync(entry.sourcePath, { recursive: true, force: true });
      lib.scan();
      return c.json({ ok: true, id, forced: force });
    } catch (err) {
      return c.json({ error: "delete_failed", message: (err as Error).message }, 500);
    }
  });

  return router;
}

/** PRD § Item 5：review-pane "Use as starter" 表面。我们在此合成
 *  agent.yaml 片段，使 UI 可直接渲染、无需客户端模板。
 *
 *  PL-016 source-cwd 行为：当 manifest 携带 source_cwd 时，片段在
 *  session_source 块之前输出 `cwd: <source_cwd>`。fork 在父会话创建时的同一目录启动，
 *  Claude 按 project-dir 范围的 session 存储之所以工作，是因为 jsonl 文件就在那里。
 *  后台服务依赖 provider 的 cwd 解析，不在 fork dispatch 时覆盖 cwd。
 *  若 operator 手动改了 cwd，fork 会诚实失败并报 "no conversation found"。
 *  无 source_cwd 的 manifest（Finding-2 之前）为向后兼容渲染时不带 cwd 行。 */
function buildStarterSnippet(entry: AgentImageEntry): string {
  const lines: string[] = [];
  if (entry.sourceCwd) {
    lines.push(`cwd: ${JSON.stringify(entry.sourceCwd)}`);
  }
  lines.push(
    "session_source:",
    "  mode: agent_image",
    "  ref:",
    "    kind: image_name",
    `    value: ${JSON.stringify(entry.name)}`,
    `    version: ${JSON.stringify(entry.version)}`,
  );
  return lines.join("\n") + "\n";
}
