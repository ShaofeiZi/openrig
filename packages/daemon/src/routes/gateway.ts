// S10 —— gateway 子系统管理路由。relay 的启用/禁用语义在切换后连同其锁定规则完整保留，
// 重新归位到后台服务（它现在拥有队列和持久 seen 态）：
//   POST /api/gateway/slack/enable  —— 把当前告警积压种子化为历史（slice-11 item 9：在积压上启用
//     不会重放任何东西；只有此后新建的告警才投递），翻转 config enabled=true，然后重启子系统，
//     使线路按新配置重建。返回诚实的在线状态行。
//   POST /api/gateway/slack/disable —— 翻转 enabled=false 并重启（线路变为惰性）。

import { connectionsProjection } from "../domain/gateway/connections-projection.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import { Hono } from "hono";
import path from "node:path";
import type { QueueRepository } from "../domain/queue-repository.js";
import { loadConfig, saveConfig } from "../domain/gateway/slack/config.js";
import { SeenStore } from "../domain/gateway/slack/state-store.js";
import { makeQueuePorts, seedBacklogAsHistory } from "../domain/gateway/slack/queue-access.js";
import { OPENRIG_HOME } from "../openrig-compat.js";
import { loadHumanRegistry } from "../domain/gateway/human-registry.js";
import { resolveSecret } from "../domain/gateway/slack/secrets.js";
import { resolveHumanDeliveryReadiness, type HumanDeliveryReadiness } from "../domain/gateway/human-readiness.js";
import { requireSenderIdentity } from "./require-sender-identity.js";
import { runChannelOperation } from "../domain/gateway/channel-operations.js";
import { buildSlackAppManifest } from "../domain/gateway/slack/manifest.js";

interface SubsystemHandle {
  restart: () => void;
  status: () => Record<string, unknown>;
}

export function gatewayRoutes(opts: {
  home?: string;
  readiness?: (entityId: string, gatewayState: string) => Promise<HumanDeliveryReadiness | null>;
} = {}): Hono {
  const app = new Hono();
  let adminTail: Promise<unknown> = Promise.resolve();

  app.get("/connections", (c) => {
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    let status: Record<string, unknown> | null = null;
    try { status = subsystem?.status() ?? null; } catch { /* 不可用被保留 */ }
    return c.json(connectionsProjection(opts.home ?? OPENRIG_HOME, status,
      c.get("settingsStore" as never) as SettingsStore | undefined));
  });

  // OPR.0.6.0.5 —— 只读：与 `zrig slack manifest` 打印的同一份 manifest。无配置、无密钥。
  app.get("/slack/manifest", (c) => c.json(buildSlackAppManifest()));

  app.get("/human/:entityId/readiness", async (c) => {
    const entityId = c.req.param("entityId");
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    const gatewayState = String(subsystem?.status().state ?? "unavailable");
    if (opts.readiness) {
      const readiness = await opts.readiness(entityId, gatewayState);
      return readiness ? c.json({ ok: true, readiness }) : c.json({ error: "human_not_found", entityId }, 404);
    }
    const home = opts.home ?? OPENRIG_HOME;
    const registry = loadHumanRegistry(home);
    if (!registry.ok) return c.json({ error: "human_registry_unavailable", message: registry.error }, 503);
    const human = registry.entities.find((candidate) => candidate.entityId === entityId);
    if (!human) return c.json({ error: "human_not_found", entityId }, 404);
    const cfg = loadConfig(home);
    const botToken = resolveSecret("SLACK_BOT_TOKEN", { envFile: cfg.secretsEnvFile ?? undefined });
    const readiness = await resolveHumanDeliveryReadiness({ human, config: cfg, gatewayState, botToken });
    return c.json({ ok: true, readiness });
  });

  app.post("/slack/:operation", async (c) => {
    const operation = c.req.param("operation");
    if (operation !== "enable" && operation !== "disable") return c.notFound();
    const body = (await c.req.json<{ actor?: string; reason?: string }>().catch(() => ({} as { actor?: string; reason?: string }))) ?? {};
    const actor = requireSenderIdentity(c, { verb: `slack ${operation}`, bodyClaim: typeof body.actor === "string" ? body.actor : null });
    if (!actor.ok) return actor.response;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (operation === "disable" && !reason) return c.json({ error: "reason_required", message: "禁用人工投递需要用 --reason 说明本次关停原因。" }, 400);
    const queueRepo = c.get("queueRepo" as never) as QueueRepository | undefined;
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    if (!subsystem || (operation === "enable" && !queueRepo)) return c.json({ error: "gateway_admin_unavailable" }, 503);
    const home = opts.home ?? OPENRIG_HOME;
    const pending = adminTail.then(async () => {
      const cfg = loadConfig(home);
      const enabled = operation === "enable";
      const state = () => ({ enabled: loadConfig(home).enabled, active: subsystem.status().state === "active" });
      return runChannelOperation({
        action: operation, subject: "slack", actor: actor.session, provenance: actor.provenance,
        reason: reason || "启用人工投递", before: state(),
        run: async () => {
          let value = { seeded: 0, onlineStatus: `slack connector 已处于${enabled ? "启用" : "禁用"}状态；无变化` };
          if (cfg.enabled === enabled) return { value, after: state(), effect: "no-op" };
          if (enabled) {
            const registry = loadHumanRegistry(home);
            if (!registry.ok) throw new Error(`无法将既有投递积压种子化：${registry.error}`);
            const seen = new SeenStore(path.join(home, "state", "slack-outbound-seen.jsonl"));
            value = await seedBacklogAsHistory({
              queue: makeQueuePorts(queueRepo!, { loadHumanRegistry: () => registry }), seen,
              filter: { minimumLevel: cfg.minimumLevelThatPosts },
            });
          } else value.onlineStatus = "slack connector 已禁用";
          saveConfig({ ...cfg, enabled }, home);
          subsystem.restart();
          return { value, after: state(), effect: "applied" };
        },
      }, home);
    });
    adminTail = pending.catch(() => undefined);
    const result = await pending;
    return c.json({ ok: true, ...result.value, receipt: result.receipt, subsystem: subsystem.status() });
  });

  return app;
}
