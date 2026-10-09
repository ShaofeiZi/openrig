// OPR.0.4.4.19 FR-9——POST /api/scope/approve：`zrig scope slice|mission approve`
// 背后唯一的写路径。在一次后台服务操作里完成 frontmatter 盖章 + 只追加 audit 行
// （scope-approve 服务负责排序 + 无半章保证）。

import { Hono } from "hono";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import type { MissionControlActionLog } from "../domain/mission-control/mission-control-action-log.js";
import { ScopeApproveError, ScopeApproveService, type ApprovalScope, type ScopeTier } from "../domain/scope/scope-approve.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";

export function scopeApproveRoutes(): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = await c.req.json<{
      scopeTier?: string;
      scopePath?: string;
      approvalScope?: string;
      actorSession?: string;
      onBehalfOf?: string | null;
      reApprove?: boolean;
      reason?: string | null;
      lockedArtifacts?: unknown;
    }>().catch(() => ({} as never));

    if (body.scopeTier !== "slice" && body.scopeTier !== "mission") {
      return c.json({ error: "scope_tier_invalid", message: "scopeTier 必须为 'slice' 或 'mission'" }, 400);
    }
    if (!body.scopePath) return c.json({ error: "scope_path_required", message: "scopePath 为必填项" }, 400);
    // P21 I1（签名表面）：批准者身份从已认证的 transport 头派生，绝不是请求体。
    // body.actorSession 是过渡期的 adopt-and-drop 声明——记录在线路身份旁；
    // P18 deliver-and-label：不一致的声明被头（transport:v1）取代，而非拒绝；
    // 无头 + 无 body actor → 400 actor_required（参数完整性）。
    // onBehalfOf 仍是 body 字段，记录在 transport 派生的 actor 旁
    // （委托保持为数据——sweep 所泛化的引用对）。
    const identity = requireSenderIdentity(c, { verb: "范围批准", bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    // 省略 approvalScope 表示 delivery（向后兼容默认）。
    const approvalScope: ApprovalScope = body.approvalScope === undefined ? "delivery" : (body.approvalScope as ApprovalScope);
    if (approvalScope !== "spec" && approvalScope !== "delivery") {
      return c.json({ error: "approval_scope_invalid", message: "approvalScope 必须为 'spec' 或 'delivery'（省略即 delivery）" }, 400);
    }

    const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    const actionLog = c.get("missionControlActionLog" as never) as MissionControlActionLog | undefined;
    if (!actionLog) return c.json({ error: "action_log_unavailable" }, 503);

    const service = new ScopeApproveService({
      missionsRoot: () => (indexer?.isReady() ? indexer.slicesRoot : null),
      actionLog,
    });

    try {
      const result = service.approve({
        scopeTier: body.scopeTier as ScopeTier,
        scopePath: body.scopePath,
        approvalScope,
        actorSession: identity.session, // transport 派生，权威
        identityProvenance: resolveRecordedProvenance(c, identity), // P21 时代戳：若头在此证明则 transport:v1，否则 claimed:v1（resolveRecordedProvenance 会降级）
        onBehalfOf: body.onBehalfOf ?? null,
        reApprove: body.reApprove === true,
        reason: typeof body.reason === "string" ? body.reason : null,
        // B14——盖章者显式的 plan-lock 集合；仅字符串，在服务内校验。
        lockedArtifacts: Array.isArray(body.lockedArtifacts)
          ? body.lockedArtifacts.filter((p): p is string => typeof p === "string")
          : null,
      });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ScopeApproveError) {
        const status = err.code === "scope_not_found" ? 404
          : err.code === "already_approved" ? 409
          : err.code === "nothing_to_reapprove" ? 409
          : err.code === "workspace_not_configured" ? 503
          : err.code === "audit_write_failed" ? 500
          : 400;
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
      }
      return c.json({ error: "internal", message: err instanceof Error ? err.message : "内部错误" }, 500);
    }
  });

  return app;
}
