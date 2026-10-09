import { Hono, type Context } from "hono";
import type { ProviderService } from "../domain/provider/provider-service.js";

// Slice-04 (OPR.0.5.0.4) seam B——`/api/provider` 路由（packet 3ffa3c22 §3）。
// 薄处理器，叠在同一个服务读模型之上（过滤投影不能分叉）。边界校验 -> 400；
// 不安全的 precheck 是一个 200 判定；switch 业务结果是 200 负载；未接线的服务
// 是一个响亮的 503（绝不是空的/编造的四区块）。此处不存放任何集合或策略逻辑。

const VALID_PROVIDERS = new Set(["codex", "claude"]);

export function providerRoutes(): Hono {
  const router = new Hono();

  const svcOf = (c: Context): ProviderService | null =>
    (c.get("providerService" as never) as ProviderService | undefined) ?? null;
  const unavailable = 503 as const;
  const okProvider = (p: string | undefined): boolean => p === undefined || VALID_PROVIDERS.has(p);
  // account 过滤器在时必须是非空、非纯空白的引用。
  const okAccount = (a: string | undefined): boolean => a === undefined || a.trim().length > 0;
  // 格式错误的过滤器（坏 provider 枚举或空 account）是 400；返回消息或 null。
  const filterError = (provider: string | undefined, account: string | undefined): string | null => {
    if (!okProvider(provider)) return `非法 provider：${provider}`;
    if (!okAccount(account)) return "account 必须是非空引用";
    return null;
  };

  router.get("/status", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    return c.json(await svc.getReadModel(), 200);
  });

  // S-B (OPR.0.5.0.4-B)——外部 status 站点的全部契约：GET /api/provider/usage
  // 从同一个读模型逐字提供 S-A host 级 rollup 行（model.hostUsage）。此处不做推导——
  // state/windows/resets_at/anomalies/provenance 在 S-A 的 rollupHostUsage 中构建
  // （且这些行按构造不带 account 身份，只有 (host, provider) + 拓扑席位）。
  // 区块缺失 -> 诚实空数组（绝不编造行）；未接线服务 -> 响亮 503。
  router.get("/usage", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const model = await svc.getReadModel();
    return c.json({ hostUsage: model.hostUsage ?? [] }, 200);
  });

  router.get("/accounts", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const provider = c.req.query("provider");
    const account = c.req.query("account");
    const filterErr = filterError(provider, account);
    if (filterErr) return c.json({ error: filterErr }, 400);
    const model = await svc.getReadModel();
    const accounts = model.accounts.filter(
      (a) => (provider === undefined || a.provider === provider) && (account === undefined || a.accountId === account),
    );
    return c.json({ accounts }, 200);
  });

  router.get("/bindings", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const provider = c.req.query("provider");
    const account = c.req.query("account");
    const filterErr = filterError(provider, account);
    if (filterErr) return c.json({ error: filterErr }, 400);
    const model = await svc.getReadModel();
    const providerOf = new Map(model.accounts.map((a) => [a.accountId, a.provider]));
    const bindings = model.bindings.filter(
      (b) =>
        (account === undefined || b.accountId === account) &&
        (provider === undefined || (b.accountId !== null && providerOf.get(b.accountId) === provider)),
    );
    return c.json({ bindings }, 200);
  });

  router.get("/signals", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const provider = c.req.query("provider");
    const account = c.req.query("account");
    const filterErr = filterError(provider, account);
    if (filterErr) return c.json({ error: filterErr }, 400);
    const model = await svc.getReadModel();
    const signals = model.signals.filter(
      (s) => (provider === undefined || s.provider === provider) && (account === undefined || s.accountRef === account),
    );
    return c.json({ signals }, 200);
  });

  router.get("/precheck", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const seat = c.req.query("seat");
    const toAccount = c.req.query("toAccount");
    // 仅为校验做 trim——不透明引用原样透传，不改写。
    if (!seat || !seat.trim() || !toAccount || !toAccount.trim()) {
      return c.json({ error: "seat 和 toAccount 均为必填项" }, 400);
    }
    // 不安全的判定是一个合法的 200 响应，不是错误。
    return c.json(await svc.precheck({ seat, toAccount }), 200);
  });

  router.post("/switch", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "非法 JSON body" }, 400);
    }
    // JSON null/数组/基本类型是格式错误（400），不是从 null 上读字段导致的 500。
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "body 必须是 JSON 对象" }, 400);
    }
    const body = raw as Record<string, unknown>;
    const seat = body["seat"];
    const toAccount = body["toAccount"];
    const forceUnsafe = body["forceUnsafe"] ?? false;
    if (typeof seat !== "string" || seat.trim() === "" || typeof toAccount !== "string" || toAccount.trim() === "") {
      return c.json({ error: "seat 和 toAccount 均为必填项" }, 400);
    }
    if (typeof forceUnsafe !== "boolean") {
      return c.json({ error: "forceUnsafe 必须是布尔值" }, 400);
    }
    // 业务结果（含 failed_safely / rebind_in_progress）是显式的 200 负载。
    return c.json(await svc.switchAccount({ seat, toAccount, forceUnsafe }), 200);
  });

  return router;
}
