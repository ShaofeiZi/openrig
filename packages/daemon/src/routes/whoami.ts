import { Hono } from "hono";
import { WhoamiService, WhoamiAmbiguousError } from "../domain/whoami-service.js";
import type { PermissionDriftReader } from "../domain/permission-drift-observer.js";

export function whoamiRoutes(): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const svc = c.get("whoamiService" as never) as WhoamiService;
    const nodeId = c.req.query("nodeId");
    const sessionName = c.req.query("sessionName");
    const targetRepo = c.req.query("targetRepo");
    // OPR.0.4.0.27：CLI 会选择 compact（跳过 contextUsage/runtimeContext 的计算）。
    // 直接访问 /api/whoami 且不带 compact 参数时保持 FULL（对外消费者的 API 向后兼容）。
    const compact = c.req.query("compact") === "1";
    const permissionDiagnostics = c.req.query("diagnostics") === "permission";

    if (!nodeId && !sessionName) {
      return c.json({
        error: "缺少查询参数：请提供 nodeId 或 sessionName。运行 zrig ps --nodes 查看可用会话。",
      }, 400);
    }

    try {
      const result = svc.resolve({
        nodeId: nodeId ?? undefined,
        sessionName: sessionName ?? undefined,
        targetRepoOverride: targetRepo ?? undefined,
        compact,
      });

      if (!result) {
        const identifier = nodeId ?? sessionName;
        return c.json({
          error: `在任何受管工作组中都找不到会话或节点 '${identifier}'。用 zrig ps --nodes 查看可用会话`,
        }, 404);
      }

      if (permissionDiagnostics) {
        const observer = c.get("permissionDriftObserver" as never) as PermissionDriftReader | undefined;
        if (observer) result.permissionDrift = observer.diagnose(result.identity.nodeId);
      }

      return c.json(result);
    } catch (err) {
      if (err instanceof WhoamiAmbiguousError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return router;
}
