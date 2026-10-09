// 用户设置 v0 —— 面向 UI System 抽屉设置面板的后台服务 HTTP 路由。
//
// 端点：
//   GET    /api/config                  → 所有键及其 value/source/default
//   GET    /api/config/:key             → 单个键及其 value/source/default
//   POST   /api/config/:key             → 设置一个键（body: { value: string }）
//   DELETE /api/config/:key             → 重置一个键（恢复默认）
//   POST   /api/config/init-workspace   → 搭建默认工作区目录
//
// CLI（`zrig config get/set/reset/init-workspace`）是操作员 + 智能体的规范编辑表面。
// 本路由为 UI 而存在；按已交付的 openrig-user-settings 技能，智能体仍走 CLI-shell-out。

import { Hono } from "hono";
import { settingsBrowser } from "../domain/user-settings/settings-browser.js";
import {
  SETTINGS_VALID_KEYS,
  isSettingsValidKey,
  parseFeedHostSubscriptionKey,
  removedContextSettingMessage,
  type SettingsStore,
} from "../domain/user-settings/settings-store.js";
import {
  ensureDefaultWorkspace,
} from "../domain/workspace/default-workspace-scaffold.js";

interface InitWorkspaceBody {
  root?: string;
  /** 已废弃的兼容输入。既有文件始终保留。 */
  force?: boolean;
  dryRun?: boolean;
}

export function configRoutes(opts: { home?: string } = {}): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    if (c.req.query("view") === "browser") {
      const gateway = c.get("gatewaySubsystem" as never) as { status(): Record<string, unknown> } | undefined;
      let observed: Record<string, unknown> | null = null;
      try { observed = gateway?.status() ?? null; } catch { /* 仍可浏览配置 */ }
      return c.json(settingsBrowser(store, observed, opts.home));
    }
    // OPR.0.4.4.15：动态类枚举以叠加方式位于静态设置映射旁（既有 `settings` 消费方不受影响）。
    try {
      return c.json({ settings: store.resolveAllWithSource(), feedHostSubscriptions: store.listFeedHostSubscriptions() });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  router.post("/init-workspace", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const body = (await c.req.json<InitWorkspaceBody>().catch(() => ({}))) as InitWorkspaceBody;
    const root = body.root ?? (store.resolveOne("workspace.root").value as string);
    const dryRun = !!body.dryRun;
    const result = ensureDefaultWorkspace({ root, dryRun });
    if (!result.ok) return c.json({ error: "init_workspace_conflict", ...result }, 409);
    return c.json(result);
  });

  router.get("/:key", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) return c.json({ error: removedMessage, replacement: "context.root" }, 400);
    // OPR.0.4.4.15：唯一注册的动态类在此解析；其他未知键保持下面的 400 字节不变。
    const dynamic = store.resolveFeedHostSubscription(key);
    if (dynamic) return c.json(dynamic);
    if (!isSettingsValidKey(key)) {
      return c.json({ error: `未知配置键 '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    try {
      return c.json(store.resolveOne(key));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  router.post("/:key", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) return c.json({ error: removedMessage, replacement: "context.root" }, 400);
    const isDynamic = parseFeedHostSubscriptionKey(key) !== null;
    if (!isDynamic && !isSettingsValidKey(key)) {
      return c.json({ error: `未知配置键 '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    const body = (await c.req.json<{ value?: string }>().catch(() => ({}))) as { value?: string };
    if (typeof body.value !== "string") {
      return c.json({ error: "value_required", hint: "POST body 必须为 { \"value\": <string> }" }, 400);
    }
    try {
      store.set(key, body.value);
      return c.json({ ok: true, key, resolved: isDynamic ? store.resolveFeedHostSubscription(key) : store.resolveOne(key as never) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  router.delete("/:key", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) return c.json({ error: removedMessage, replacement: "context.root" }, 400);
    const isDynamic = parseFeedHostSubscriptionKey(key) !== null;
    if (!isDynamic && !isSettingsValidKey(key)) {
      return c.json({ error: `未知配置键 '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    try {
      store.reset(key);
      return c.json({ ok: true, key, resolved: isDynamic ? store.resolveFeedHostSubscription(key) : store.resolveOne(key as never) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return router;
}
