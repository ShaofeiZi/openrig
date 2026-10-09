import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { ServiceOrchestrator } from "../domain/service-orchestrator.js";
import type { ComposeServicesAdapter } from "../adapters/compose-services-adapter.js";

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    serviceOrchestrator: c.get("serviceOrchestrator" as never) as ServiceOrchestrator | undefined,
    composeAdapter: c.get("composeAdapter" as never) as ComposeServicesAdapter | undefined,
  };
}

export function envRoutes(): Hono {
  const app = new Hono();

  // GET /api/rigs/:rigId/env —— 带新鲜回执的 env 状态
  app.get("/", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "缺少 rigId" }, 400);

    const { rigRepo, serviceOrchestrator } = getDeps(c);
    const record = rigRepo.getServicesRecord(rigId);
    if (!record) {
      return c.json({ ok: true, hasServices: false });
    }

    // 用诚实的探测跟踪刷新回执
    let receipt = record.latestReceiptJson ? JSON.parse(record.latestReceiptJson) : null;
    let probeStatus: "fresh" | "stale" | "no_orchestrator" = "no_orchestrator";
    let probeError: string | undefined;
    if (serviceOrchestrator) {
      try {
        const fresh = await serviceOrchestrator.captureReceipt(rigId);
        if (fresh) {
          receipt = fresh;
          probeStatus = "fresh";
        } else {
          probeStatus = "stale";
          probeError = "探测未返回回执——services 记录可能已不存在";
        }
      } catch (err) {
        probeStatus = "stale";
        probeError = (err as Error).message;
      }
    }

    // 尽力从 specJson 解析 surfaces
    let surfaces: unknown = undefined;
    try {
      const spec = JSON.parse(record.specJson) as Record<string, unknown>;
      if (spec["surfaces"]) surfaces = spec["surfaces"];
    } catch { /* 安全默认 */ }

    return c.json({
      ok: true,
      hasServices: true,
      kind: record.kind,
      composeFile: record.composeFile,
      projectName: record.projectName,
      receipt,
      probeStatus,
      ...(probeError ? { probeError } : {}),
      ...(surfaces ? { surfaces } : {}),
    });
  });

  // GET /api/rigs/:rigId/env/logs —— 服务日志
  app.get("/logs", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "缺少 rigId" }, 400);

    const { rigRepo, composeAdapter } = getDeps(c);
    const record = rigRepo.getServicesRecord(rigId);
    if (!record) {
      return c.json({ error: "该工作组未配置任何服务" }, 404);
    }

    if (!composeAdapter) {
      return c.json({ error: "Compose 适配器不可用" }, 500);
    }

    const service = c.req.query("service");
    const tailStr = c.req.query("tail");
    const tail = tailStr ? parseInt(tailStr, 10) : 100;

    let spec: { profiles?: string[] } = {};
    try { spec = JSON.parse(record.specJson); } catch { /* 空 */ }

    const result = await composeAdapter.logs({
      composeFile: record.composeFile,
      projectName: record.projectName,
      profiles: spec.profiles,
      service: service || undefined,
      tail,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({ ok: true, output: result.output });
  });

  // POST /api/rigs/:rigId/env/down —— 拆除服务
  app.post("/down", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "缺少 rigId" }, 400);

    const { rigRepo, serviceOrchestrator } = getDeps(c);
    const record = rigRepo.getServicesRecord(rigId);
    if (!record) {
      return c.json({ error: "该工作组未配置任何服务" }, 404);
    }

    if (!serviceOrchestrator) {
      return c.json({ error: "服务编排器不可用" }, 500);
    }

    const body = await c.req.json<{ volumes?: boolean }>().catch(() => ({} as { volumes?: boolean }));

    const result = body.volumes
      ? await serviceOrchestrator.teardown(rigId, { policyOverride: "down_and_volumes" })
      : await serviceOrchestrator.teardown(rigId);

    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 500);
    }

    return c.json({ ok: true });
  });

  return app;
}
