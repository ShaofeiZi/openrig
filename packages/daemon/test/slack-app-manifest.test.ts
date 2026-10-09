import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { parse } from "yaml";
import { buildSlackAppManifest, CANONICAL_MANIFEST_SOURCES } from "../src/domain/gateway/slack/manifest.js";
import { BASELINE_REQUIRED_SCOPES, EVENT_SUBSCRIPTIONS, FEATURE_SCOPES } from "../src/domain/gateway/slack/capabilities.js";
import { DEFAULT_CONFIG } from "../src/domain/gateway/slack/config.js";
import { ingestDecision } from "../src/domain/gateway/slack/inbound.js";
import { gatewayRoutes } from "../src/routes/gateway.js";

const setOf = (xs: Iterable<string>) => new Set(xs);

// 用于探测真实准入门禁的载荷类型：已准入类型加其他可能类型，包括本身并非载荷类型的
// 订阅名称。
const PROBE_TYPES = ["message", "app_mention", "reaction_added", "member_joined_channel", "message.channels", "file_shared"];
const admits = (type: string) => {
  const d = ingestDecision({ type, user: "U1", text: "hello" });
  return d.ingest || d.reason !== "type";
};

describe("发行版 Slack 应用清单——标准来源", () => {
  const bundle = buildSlackAppManifest();
  const scopeSet = setOf(bundle.scopes);

  it("恰好申请基线必需 scope 与功能 scope（顺序无关）", () => {
    expect(scopeSet).toEqual(setOf([...BASELINE_REQUIRED_SCOPES, ...FEATURE_SCOPES.map((f) => f.scope)]));
    expect(setOf(bundle.manifest.oauth_config.scopes.bot)).toEqual(scopeSet);
  });

  it("包含连接器默认配置要求 `zrig slack verify` 检查的每个 scope", () => {
    for (const scope of DEFAULT_CONFIG.requiredScopes) expect(scopeSet.has(scope)).toBe(true);
  });

  it("为每个功能 scope 提供明确的代码路径", () => {
    for (const f of FEATURE_SCOPES) expect(f.usedBy.trim().length).toBeGreaterThan(0);
  });

  it("恰好为入站门禁准入的载荷类型订阅事件", () => {
    const admittedByBehavior = setOf(PROBE_TYPES.filter(admits));
    const subscribedPayloadTypes = setOf(Object.entries(EVENT_SUBSCRIPTIONS)
      .filter(([, m]) => bundle.events.includes(m.subscription)).map(([type]) => type));
    expect(admittedByBehavior).toEqual(subscribedPayloadTypes);
    expect(setOf(bundle.manifest.settings.event_subscriptions.bot_events)).toEqual(setOf(bundle.events));
  });

  it("为每个已订阅事件申请 Slack 要求的 scope", () => {
    for (const m of Object.values(EVENT_SUBSCRIPTIONS)) {
      if (bundle.events.includes(m.subscription)) expect(scopeSet.has(m.scope)).toBe(true);
    }
  });

  it("是 Socket Mode 应用，不含请求 URL、交互或组织级部署", () => {
    const s = bundle.manifest.settings;
    expect(s.socket_mode_enabled).toBe(true);
    expect(s.interactivity.is_enabled).toBe(false);
    expect(s.org_deploy_enabled).toBe(false);
    expect(JSON.stringify(bundle.manifest)).not.toMatch(/request_url|redirect_url/);
  });

  it("往返一致：YAML 解析为清单，链接携带完全相同的 YAML", () => {
    expect(parse(bundle.yaml)).toEqual(bundle.manifest);
    const prefix = "https://api.slack.com/apps?new_app=1&manifest_yaml=";
    expect(bundle.url.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(bundle.url.slice(prefix.length))).toBe(bundle.yaml);
    expect(bundle.url.slice(prefix.length)).not.toMatch(/[\s\n:]/);
  });

  it("不携带私有实例、主机、装备、席位或工作区标识符", () => {
    const text = bundle.yaml + bundle.url + JSON.stringify(bundle);
    for (const forbidden of [/esoteric/i, /v-openrig/i, /mm2/i, /openrig-build/i, /\/Users\//, /kernel/i, /@[a-z0-9-]+\b/i, /\bT0[A-Z0-9]{6,}\b/]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});

describe("发行版 Slack 应用清单——变异控制", () => {
  it("拒绝没有订阅映射的已准入载荷类型", () => {
    expect(() => buildSlackAppManifest({ ...CANONICAL_MANIFEST_SOURCES, admittedEventTypes: ["message", "app_mention", "reaction_added"] }))
      .toThrow(/允许的 event type "reaction_added" 没有 subscription 映射/);
  });

  it("拒绝所需 scope 未申请的订阅事件", () => {
    expect(() => buildSlackAppManifest({ ...CANONICAL_MANIFEST_SOURCES, featureScopes: ["files:read", "files:write"] }))
      .toThrow(/需要尚未申请的 scope "app_mentions:read"/);
  });

  it("删除功能 scope 时 scope 集合发生变化（一致性测试会失败）", () => {
    const narrowed = buildSlackAppManifest({ ...CANONICAL_MANIFEST_SOURCES, featureScopes: ["files:write", "app_mentions:read"] });
    expect(setOf(narrowed.scopes)).not.toEqual(setOf(buildSlackAppManifest().scopes));
  });

  it("能检测入站门禁准入清单未订阅类型的情况", () => {
    // 行为级检查：门禁当前拒绝的探测类型必须保持在清单之外。
    expect(admits("reaction_added")).toBe(false);
    expect(buildSlackAppManifest().events).not.toContain("reaction_added");
  });
});

describe("GET /slack/manifest（只读路由）", () => {
  it("返回与构造器生成内容相同的对象", async () => {
    const app = new Hono();
    app.route("/", gatewayRoutes({ home: "/nonexistent-openrig-home-for-test" }));
    const res = await app.request("/slack/manifest");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(buildSlackAppManifest())));
  });

  it("仅支持 GET", async () => {
    const app = new Hono();
    app.route("/", gatewayRoutes({ home: "/nonexistent-openrig-home-for-test" }));
    const res = await app.request("/slack/manifest", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
