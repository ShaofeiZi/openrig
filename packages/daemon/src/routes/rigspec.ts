import fs from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import type { RigSpecExporter } from "../domain/rigspec-exporter.js";
import type { RigInstantiator, PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import type { RigSpecPreflight } from "../domain/rigspec-preflight.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { LegacyRigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../domain/rigspec-schema.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { rigPreflight } from "../domain/rigspec-preflight.js";
import { RigNotFoundError } from "../domain/errors.js";
import { runSyncSite } from "../domain/sync-site-wrap.js";

export const rigspecImportRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    exporter: c.get("rigSpecExporter" as never) as RigSpecExporter,
    instantiator: c.get("rigInstantiator" as never) as RigInstantiator,
    preflight: c.get("rigSpecPreflight" as never) as RigSpecPreflight,
    podInstantiator: c.get("podInstantiator" as never) as PodRigInstantiator,
    rigRepo: c.get("rigRepo" as never) as RigRepository,
  };
}

// GET /api/rigs/:rigId/spec -> YAML
export function handleExportYaml(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    // 探测格式：pod 感知的 RigSpec 有 `pods`，旧版有 `schemaVersion`
    const isPodAware = "pods" in spec;
    const yaml = isPodAware
      ? RigSpecCodec.serialize(spec as import("../domain/types.js").RigSpec)
      : LegacyRigSpecCodec.serialize(spec as import("../domain/types.js").LegacyRigSpec);
    return new Response(yaml, {
      status: 200,
      headers: { "Content-Type": "text/yaml" },
    });
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "导出失败" }, 500);
  }
}

// GET /api/rigs/:rigId/spec.json -> JSON
export function handleExportJson(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    return c.json(spec);
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "导出失败" }, 500);
  }
}

// POST /api/rigs/import -> 从 YAML 实例化
rigspecImportRoutes.post("/", async (c) => {
  const { instantiator, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);

  if (isPodAware) {
    const rigRoot = c.req.header("X-Rig-Root");
    if (!rigRoot) return c.json({ error: "pod 感知的 spec 需要 X-Rig-Root 头", code: "missing_rig_root" }, 400);
    const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;

    const outcome = await podInstantiator.instantiate(body, rigRoot, { cwdOverride });
    if (!outcome.ok) {
      const status = outcome.code === "validation_failed" ? 400
        : outcome.code === "preflight_failed" ? 409
        : outcome.code === "cycle_error" ? 400
        // S5b final-fix F1：running-name 守卫拒绝在直接实例化路由上也是冲突——
        // 绝不是 500（映射一致性）。
        : outcome.code === "rig_name_running" ? 409
        : 500;
      const body = outcome.code === "rig_name_running"
        ? { ...outcome, error: outcome.message }
        : outcome;
      return c.json(body, status);
    }
    return c.json(outcome.result, 201);
  }

  // 旧版路径
  let spec;
  try {
    spec = LegacyRigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const outcome = await instantiator.instantiate(spec);
  if (!outcome.ok) {
    const status = outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" ? 409
      : outcome.code === "rig_name_running" ? 409
      : 500;
    const body = outcome.code === "rig_name_running"
      ? { ...outcome, error: outcome.message }
      : outcome;
    return c.json(body, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/rigs/import/workspace -> 只应用已校验的 workspace 声明
rigspecImportRoutes.post("/workspace", async (c) => {
  const { rigRepo } = getDeps(c);
  const targetRigId = c.req.header("X-Target-Rig-Id");
  if (!targetRigId) {
    return c.json({ ok: false, code: "target_rig_required", error: "仅 workspace 应用需要 X-Target-Rig-Id 头" }, 400);
  }

  const body = await c.req.text();
  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, code: "validation_failed", errors: [message] }, 400);
  }

  const workspace = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)["workspace"]
    : undefined;
  if (workspace === undefined || workspace === null) {
    return c.json({ ok: false, code: "workspace_required", errors: ["workspace：仅 workspace 应用时必填"] }, 400);
  }

  const validation = RigSpecSchema.validateWorkspace(workspace);
  if (!validation.valid) {
    return c.json({ ok: false, code: "validation_failed", errors: validation.errors }, 400);
  }

  const normalizedWorkspace = RigSpecSchema.normalizeWorkspace(workspace)!;
  if (!rigRepo.getRig(targetRigId)) {
    return c.json({ ok: false, code: "target_rig_not_found", error: `未找到工作组：${targetRigId}` }, 404);
  }

  const current = rigRepo.getRigWorkspace(targetRigId);
  const changed = JSON.stringify(current) !== JSON.stringify(normalizedWorkspace);
  if (changed) rigRepo.setRigWorkspace(targetRigId, normalizedWorkspace);

  return c.json({ rigId: targetRigId, changed, workspace: normalizedWorkspace });
});

// POST /api/rigs/import/materialize -> 不启动即创建工作组拓扑
rigspecImportRoutes.post("/materialize", async (c) => {
  const { podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (!isPodAware) {
    return c.json({ error: "仅 materialize 需要 pod 感知的 RigSpec", code: "pod_aware_required" }, 400);
  }

  const rigRoot = c.req.header("X-Rig-Root");
  if (!rigRoot) return c.json({ error: "pod 感知的 spec 需要 X-Rig-Root 头", code: "missing_rig_root" }, 400);

  const targetRigId = c.req.header("X-Target-Rig-Id") ?? undefined;
  const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;
  const outcome = await podInstantiator.materialize(body, rigRoot, { targetRigId, cwdOverride });
  if (!outcome.ok) {
    const status = outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" ? 409
      : outcome.code === "target_rig_not_found" ? 404
      : outcome.code === "materialize_conflict" ? 409
      : outcome.code === "rig_name_running" ? 409
      : 500;
    const body = outcome.code === "rig_name_running"
      ? { ...outcome, error: outcome.message }
      : outcome;
    return c.json(body, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/rigs/import/validate -> 仅校验（自动探测格式）
rigspecImportRoutes.post("/validate", async (c) => {
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (isPodAware) {
    return c.json(RigSpecSchema.validate(raw));
  }
  return c.json(LegacyRigSpecSchema.validate(raw));
});

// POST /api/rigs/import/preflight -> 校验 + preflight（自动探测格式）
rigspecImportRoutes.post("/preflight", async (c) => {
  const { preflight, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (isPodAware) {
    const rigRoot = c.req.header("X-Rig-Root");
    if (!rigRoot) return c.json({ ready: false, errors: ["pod 感知的 spec 需要 X-Rig-Root 头"], warnings: [] }, 400);
    const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;
    const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) };
    const { execSync } = await import("node:child_process");
    const exec = async (cmd: string) => runSyncSite("rigspec.import.preflight", () =>
      execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 })
    );
    const result = await rigPreflight({
      rigSpecYaml: body,
      rigRoot,
      cwdOverride,
      fsOps,
      skillsRoot: podInstantiator.resolveSkillsRoot?.(),
      exec,
    });
    return c.json(result);
  }

  // 旧版
  let spec;
  try {
    spec = LegacyRigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const result = await preflight.check(spec);
  return c.json(result);
});
