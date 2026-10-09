import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { StreamStore } from "../domain/stream-store.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function hasSubMillisecondPrecision(value: string): boolean {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  return /[1-9]/.test(fraction?.slice(3) ?? "");
}

function normalizeIsoTimestamp(value: string): string | null {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() + 1 !== month ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

/**
 * 协调 L1——Stream HTTP 路由（PL-004 Phase A）。
 *
 * Host 范围（路径中无 rigId）。协调原语的只追加 intake/audit 根。
 * CLI `zrig stream` 调用这些端点。
 */
export function streamRoutes(): Hono {
  const app = new Hono();

  function getStore(c: { get: (key: string) => unknown }): StreamStore {
    return c.get("streamStore" as never) as StreamStore;
  }

  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  // POST /emit——追加一条 stream 项
  app.post("/emit", async (c) => {
    const body = await c.req.json<{
      streamItemId?: string;
      sourceSession?: string;
      body?: string;
      format?: string;
      hintType?: string | null;
      hintUrgency?: string | null;
      hintDestination?: string | null;
      hintTags?: string[] | null;
      interrupt?: boolean;
    }>().catch(() => ({} as never));

    // P21 I3：stream 来源是 transport 派生的身份，绝不是 body.sourceSession。
    const identity = requireSenderIdentity(c, { verb: "stream 投递", bodyClaim: body.sourceSession });
    if (!identity.ok) return identity.response;
    if (!body.body) return c.json({ error: "body 为必填项" }, 400);

    const store = getStore(c);
    const item = store.emit({
      streamItemId: body.streamItemId,
      sourceSession: identity.session,
      body: body.body,
      format: body.format,
      hintType: body.hintType ?? null,
      hintUrgency: body.hintUrgency ?? null,
      hintDestination: body.hintDestination ?? null,
      hintTags: body.hintTags ?? null,
      interrupt: body.interrupt,
      identityProvenance: resolveRecordedProvenance(c, identity), // P21 §4 时代戳：若头在此证明则 transport:v1，否则 claimed:v1（resolveRecordedProvenance 会降级）
    });
    return c.json(item, 201);
  });

  // GET /list——带过滤的分页列表
  app.get("/list", (c) => {
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const afterSortKey = c.req.query("afterSortKey") || undefined;
    const direction = c.req.query("direction");
    if (direction && direction !== "chronological" && direction !== "latest") {
      return c.json({ error: "direction 必须为 chronological 或 latest" }, 400);
    }
    if (direction === "latest" && afterSortKey) {
      return c.json({ error: "direction=latest 不能与 afterSortKey 同时使用" }, 400);
    }
    const parsedDirection = direction === "latest" || direction === "chronological" ? direction : undefined;
    const sourceSession = c.req.query("sourceSession") || undefined;
    const hintDestination = c.req.query("hintDestination") || undefined;
    const hintTag = c.req.query("hintTag") || undefined;
    const sinceInput = c.req.query("since") || undefined;
    const untilInput = c.req.query("until") || undefined;
    let since: string | undefined;
    let until: string | undefined;
    if (sinceInput) {
      if (hasSubMillisecondPrecision(sinceInput)) {
        return c.json({ error: "since 最多只能用毫秒精度" }, 400);
      }
      since = normalizeIsoTimestamp(sinceInput) ?? undefined;
      if (!since) return c.json({ error: "since 必须是合法的 ISO 时间戳" }, 400);
    }
    if (untilInput) {
      if (hasSubMillisecondPrecision(untilInput)) {
        return c.json({ error: "until 最多只能用毫秒精度" }, 400);
      }
      until = normalizeIsoTimestamp(untilInput) ?? undefined;
      if (!until) return c.json({ error: "until 必须是合法的 ISO 时间戳" }, 400);
    }
    if (since && until && since > until) {
      return c.json({ error: "since 不能晚于 until" }, 400);
    }
    const includeArchived = c.req.query("includeArchived") === "true";

    const store = getStore(c);
    const items = store.list({
      limit,
      afterSortKey,
      sourceSession,
      hintDestination,
      hintTag,
      since,
      until,
      includeArchived,
      ...(parsedDirection ? { direction: parsedDirection } : {}),
    });
    return c.json(items);
  });

  // GET /watch——新 stream.emitted 事件的 SSE。
  // 必须在 /:streamItemId 之前，使字面量 `watch` 与 `sse` 路径优先于裸参路由
  // （否则 GET /api/stream/sse 会被解析为 /:streamItemId、id="sse"，
  // 返回 404 stream-item-not-found）。
  // 同时挂载在 /watch（旧别名）与 /sse（按 IMPL § Routes 的 Phase A 契约：
  // GET /api/stream/sse）。同一处理器；两条路径发出相同的事件流。
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    const store = getStore(c);

    return streamSSE(c, async (stream) => {
      const initialDone = { value: false };
      const pending: Array<{ id: string; data: string }> = [];

      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type !== "stream.emitted") return;
        const item = store.getById(event.streamItemId);
        if (!item) return;
        const sse = { id: item.streamItemId, data: JSON.stringify(item) };
        if (initialDone.value) {
          stream.writeSSE(sse).catch(() => {});
        } else {
          pending.push(sse);
        }
      });

      const initial = store.list({ limit: 50 });
      const sentIds = new Set<string>();
      for (const item of initial) {
        await stream.writeSSE({ id: item.streamItemId, data: JSON.stringify(item) });
        sentIds.add(item.streamItemId);
      }

      initialDone.value = true;
      for (const p of pending) {
        if (!sentIds.has(p.id)) await stream.writeSSE(p);
      }

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        unsubscribe();
      }
    });
  };

  app.get("/watch", sseHandler);
  app.get("/sse", sseHandler);

  // GET /:streamItemId——取一条
  app.get("/:streamItemId", (c) => {
    const id = c.req.param("streamItemId");
    const store = getStore(c);
    const item = store.getById(id);
    if (!item) return c.json({ error: "未找到 stream 项" }, 404);
    return c.json(item);
  });

  // POST /:streamItemId/archive
  app.post("/:streamItemId/archive", (c) => {
    const id = c.req.param("streamItemId");
    const store = getStore(c);
    const ok = store.archive(id);
    if (!ok) return c.json({ error: "未找到 stream 项或已归档" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
