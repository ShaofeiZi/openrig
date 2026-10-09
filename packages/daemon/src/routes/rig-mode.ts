// Slice 09——Rig Policy（操作员上下文模式）HTTP 路由。
//
// 表面（仅绑定相关——HG-SAFE）：
//   GET    /api/rig-mode/bindings                      — 列出绑定
//   GET    /api/rig-mode/bindings/:scope/:qualifier?   — 读一个绑定
//   PUT    /api/rig-mode/bindings/:scope/:qualifier?   — upsert（操作员）
//   DELETE /api/rig-mode/bindings/:scope/:qualifier?   — 取消（操作员）
//   GET    /api/rig-mode/effective                     — 解析 effective
//                                                          (?rig=&project=&mission=&workstream=&qitem=)
//   GET    /api/rig-mode/defaults                      — 推荐的
//                                                          每模式 8×7
//                                                          + 默认 scope
//                                                          + DEFAULT_STALE_RULE
//
// 权限（HG-4）：写动词（PUT / DELETE）需要后台服务的操作员 bearer
// （与 mission-control 同姿态）。读是开放的（在后台服务既有的 loopback/tailnet/bearer
// 模型内）。没有智能体设置代码路径——本路由只在写动词上挂载 bearer 中间件；
// 调用读端点的智能体必须使用后台服务在 listen 层已强制的同一套鉴权。
//
// HG-SAFE 保留：本路由器绝不触碰权限白名单 / runtime 配置 / auth token / tmux / 生命周期。
// 它只调用单个 store（RigModeStore），其表面本身也是绑定受限的。

import { Hono } from "hono";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import type { RigModeStore } from "../domain/rig-mode/rig-mode-store.js";
import type { OperatingPostureService } from "../domain/rig-mode/operating-posture.js";
import {
  OPERATOR_CONTEXT_SCOPES,
  SCOPE_SPECIFICITY,
  type OperatorContextScope,
} from "../domain/rig-mode/rig-mode-types.js";
import {
  DEFAULT_STALE_RULE,
  RECOMMENDED_DEFAULT_SCOPE,
  RECOMMENDED_MODE_DEFAULTS,
} from "../domain/rig-mode/rig-mode-defaults.js";

export interface RigModeRoutesOpts {
  /** 操作员 bearer token（与 Mission Control 用同一个）。为 null 时，
   * 后台服务 listen 层仅 loopback，写动词直接放行；非 null 时需要
   * `Authorization: Bearer <token>`。 */
  bearerToken?: string | null;
}

const VALID_SCOPES = new Set<string>(OPERATOR_CONTEXT_SCOPES);

function parseScope(raw: string): OperatorContextScope | null {
  return VALID_SCOPES.has(raw) ? (raw as OperatorContextScope) : null;
}

interface ScopeQualifierOk {
  ok: true;
  scope: OperatorContextScope;
  qualifier: string | null;
}
interface ScopeQualifierErr {
  ok: false;
  status: 400;
  body: { error: string; hint: string };
}

/**
 * 解析 + 校验 `:scope` / `:qualifier` 路径参数。拒绝：
 *   - 未知 scope 名                          → scope_invalid
 *   - global_host scope 带非空 qualifier    → qualifier_forbidden
 *     （防止对 global-host 绑定做隐藏的 scope 推断 / 变更——守卫 BLOCKER 2）
 *   - 非 global scope 不带 qualifier        → qualifier_required
 *
 * 被每个路由动词使用，使 GET / PUT / DELETE 共享完全相同的解析规则。
 * 写路径上绝不静默丢弃 qualifier。
 */
function parseScopeAndQualifier(scopeRaw: string, qualifierRaw: string | undefined): ScopeQualifierOk | ScopeQualifierErr {
  const scope = parseScope(scopeRaw);
  if (!scope) {
    return {
      ok: false,
      status: 400,
      body: { error: "scope_invalid", hint: `未知 scope。允许值：${OPERATOR_CONTEXT_SCOPES.join(", ")}。` },
    };
  }
  if (scope === "global_host") {
    if (qualifierRaw !== undefined && qualifierRaw.length > 0) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "qualifier_forbidden",
          hint: "global-host 绑定不能带 qualifier。请使用 /api/rig-mode/bindings/global_host，不带尾部路径段。",
        },
      };
    }
    return { ok: true, scope, qualifier: null };
  }
  if (qualifierRaw === undefined || qualifierRaw.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "qualifier_required",
        hint: `scope ${scope} 需要 qualifier（rig/project/qitem ID 或 project/mission[/slice-id]）。`,
      },
    };
  }
  return { ok: true, scope, qualifier: qualifierRaw };
}

function getStore(c: { get: (key: string) => unknown }): RigModeStore | null {
  const store = c.get("rigModeStore" as never) as RigModeStore | undefined;
  return store ?? null;
}

export function rigModeRoutes(opts?: RigModeRoutesOpts): Hono {
  const router = new Hono();
  const bearer = opts?.bearerToken ?? null;
  const requireOperator = authBearerTokenMiddleware({ expectedToken: bearer });

  // -- read: defaults --------------------------------------------------
  router.get("/defaults", (c) => {
    return c.json({
      recommendedModeDefaults: RECOMMENDED_MODE_DEFAULTS,
      recommendedDefaultScope: RECOMMENDED_DEFAULT_SCOPE,
      defaultStaleRule: DEFAULT_STALE_RULE,
    });
  });

  // -- read: list ------------------------------------------------------
  router.get("/bindings", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    return c.json({ bindings: store.listBindings() });
  });

  // -- read: resolveEffective ------------------------------------------
  router.get("/effective", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const rigId = c.req.query("rig");
    const projectId = c.req.query("project");
    const missionId = c.req.query("mission");
    const workstreamId = c.req.query("workstream");
    const qitemId = c.req.query("qitem");
    const input = { rigId, projectId, missionId, workstreamId, qitemId };
    const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
    const operatingPosture = service?.resolve(input) ?? {
      posture: "unknown", source: "unknown", context: null, binding: null,
      reason: "操作姿态解析器不可用。", grantsAuthority: false,
    };
    let resolved;
    try {
      // 让既有按原始名寻址的易用绑定保持可读。
      const raw = store.resolveEffective(input);
      const canonical = store.resolveEffective(operatingPosture.context ?? input);
      resolved = !raw || (canonical && SCOPE_SPECIFICITY[canonical.resolvedScope] > SCOPE_SPECIFICITY[raw.resolvedScope]) ? canonical : raw;
    }
    catch { return c.json({ effective: null, posture: "unknown_posture", operatingPosture }); }
    // Q6——null = unknown_posture；绝不静默默认。向调用方显现。
    if (!resolved) {
      return c.json({
        effective: null,
        operatingPosture,
        posture: "unknown_posture",
        hint: "没有绑定匹配此读取上下文。按约定 §Q6，调用方必须将其视为 unknown_posture（不要默认到 desk）。",
      });
    }
    return c.json({ effective: resolved, posture: "known", operatingPosture });
  });

  // -- 读取：一条绑定（qualifier 路径可选，可用 /:scope 或 /:scope/:qualifier）
  router.get("/bindings/:scope/:qualifier?", (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const parsed = parseScopeAndQualifier(c.req.param("scope"), c.req.param("qualifier"));
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    let binding = store.getBinding(parsed.scope, parsed.qualifier);
    if (!binding) {
      const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
      if (service) {
        try { binding = store.getBinding(parsed.scope, service.target(parsed.scope, parsed.qualifier)); }
        catch (error) { return c.json({ error: "scope_unresolved", hint: String(error) }, 400); }
      }
    }
    if (!binding) return c.json({ error: "not_found" }, 404);
    return c.json({ binding });
  });

  // -- write: upsert (operator-only) -----------------------------------
  router.put("/bindings/:scope/:qualifier?", requireOperator, async (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const parsed = parseScopeAndQualifier(c.req.param("scope"), c.req.param("qualifier"));
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") {
      return c.json({
        error: "body_required",
        hint: "PUT body 必须为 { mode: <受支持模式>, record: <10 字段 OperatorContextModeRecord> }。",
      }, 400);
    }
    const { mode, record } = body as { mode?: unknown; record?: unknown };
    if (mode === undefined || record === undefined) {
      return c.json({
        error: "body_shape_invalid",
        hint: "PUT body 必须为 { mode: <受支持模式>, record: <10 字段 OperatorContextModeRecord> }。",
      }, 400);
    }
    let qualifier = parsed.qualifier;
    if (mode === "human-led" || mode === "delegated") {
      const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
      if (!service) return c.json({ error: "operating_posture_unavailable" }, 503);
      try { qualifier = service.target(parsed.scope, qualifier); }
      catch (error) { return c.json({ error: "scope_unresolved", hint: String(error) }, 400); }
    }
    const result = store.setBinding(parsed.scope, qualifier, mode, record);
    if (!result.ok) {
      return c.json({ error: "validation_failed", errors: result.errors }, 400);
    }
    return c.json({ binding: result.binding });
  });

  // -- write: delete (operator-only) -----------------------------------
  router.delete("/bindings/:scope/:qualifier?", requireOperator, (c) => {
    const store = getStore(c);
    if (!store) return c.json({ error: "rig_policy_store_unavailable" }, 503);
    const parsed = parseScopeAndQualifier(c.req.param("scope"), c.req.param("qualifier"));
    if (!parsed.ok) return c.json(parsed.body, parsed.status);
    let qualifier = parsed.qualifier;
    if (!store.getBinding(parsed.scope, qualifier)) {
      const service = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
      if (service) {
        try { qualifier = service.target(parsed.scope, qualifier); }
        catch (error) { return c.json({ error: "scope_unresolved", hint: String(error) }, 400); }
      }
    }
    const removed = store.deleteBinding(parsed.scope, qualifier);
    return c.json({ removed });
  });

  return router;
}
