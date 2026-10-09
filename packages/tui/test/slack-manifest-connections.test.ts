// OPR.0.6.0.5——尚未创建 Slack 应用时，连接页的 Slack 区域会把随附清单的 create-app
// 链接显示为可选择文本，并提供展开清单的开关。fake client 背后使用真实 daemon gateway
// 路由；不写入，也不发起外部调用。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayRoutes } from "../../daemon/src/routes/gateway.js";
import { channelStateDigest } from "../../daemon/src/domain/gateway/channel-operations.js";
import { DEFAULT_CONFIG, saveConfig } from "../../daemon/src/domain/gateway/slack/config.js";
import { buildSlackAppManifest } from "../../daemon/src/domain/gateway/slack/manifest.js";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { connectionsLines, SLACK_MANIFEST_EXPAND_KEY } from "../src/connections/connections-model.js";
import type { FleetSnapshot } from "../src/types.js";

let home: string;
let external: ReturnType<typeof vi.fn>;
let manifestRoute: boolean;
let config: typeof DEFAULT_CONFIG;

function makeClient(): DaemonClient {
  const http = new Hono();
  http.use("*", async (c, next) => {
    c.set("gatewaySubsystem" as never, { status: () => ({ state: "active", connector: { outboundReady: false, inboundReady: false, configurationDigest: channelStateDigest(config) } }), restart: external } as never);
    await next();
  });
  http.route("/api/gateway", gatewayRoutes({ home }));
  return new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/gateway/slack/manifest" && !manifestRoute) return Response.json({ error: "not_found" }, { status: 404 });
    if (path.startsWith("/api/gateway")) return http.request(path, init);
    const fixtures: Record<string, unknown> = {
      "/healthz": { status: "ok", semver: "0.6.0", commit: "fixture", selfHostId: "fixture-host", selfHostIdSource: "registry" },
      "/api/rigs/summary": [], "/api/review/fleet": { needsYou: { items: [] }, hosts: [] },
      "/api/queue/attention-aggregate": { hosts: [] }, "/api/scopes": { missions: [] }, "/api/views/execution": { rows: [] },
    };
    return Response.json(fixtures[path] ?? []);
  }) as typeof fetch });
}
const hydrate = (client: DaemonClient) =>
  hydrateSnapshot(client, undefined, null, null, "fixture", { section: "connections", viewTab: "table", drill: [] });
const text = (lines: Array<{ text: string }>) => lines.map((l) => l.text).join("\n");
const screenText = (lines: string[]) => lines.join("\n");
/** 链接行：从 URL 起始行开始，直到所有续行结束。 */
function linkRows(lines: Array<{ text: string }>): string {
  const start = lines.findIndex((l) => l.text.startsWith("https://api.slack.com/apps?"));
  let joined = "";
  for (let i = start; i >= 0 && i < lines.length && !lines[i]!.text.startsWith(" "); i++) joined += lines[i]!.text;
  return joined;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "s05-connections-"));
  config = { ...DEFAULT_CONFIG };
  manifestRoute = true;
  external = vi.fn(() => { throw new Error("no external calls"); });
  vi.stubGlobal("fetch", external);
  vi.stubEnv("SLACK_BOT_TOKEN", ""); vi.stubEnv("SLACK_APP_TOKEN", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe("连接 · Slack 未配置（没有应用 token）", () => {
  it("显示未配置提示、create-app 链接和折叠清单，并在下一步中说明该清单", async () => {
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    const bundle = buildSlackAppManifest();
    expect(snap.slackManifest?.url).toBe(bundle.url);
    // 后台协议仍返回兼容入口，只有 TUI 展示切换为中文发行版入口。
    expect(snap.connections?.nextAction).toBe("zrig slack manifest --url");
    const lines = connectionsLines(snap, 400);
    const body = text(lines);
    expect(body).toContain("未配置 · 尚无 Slack 应用令牌");
    expect(linkRows(lines)).toBe(bundle.url);
    expect(body).toContain("▸ 显示 清单（回车）");
    expect(body).not.toContain("socket_mode_enabled: true");
    expect(body).toContain("下一步：zrig slack manifest --url");
    expect(external).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it("开关行通过真实 view-state 动作原地展开清单，并可再次折叠", async () => {
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    const view = createViewState({ instanceId: "fixture", getSnapshot: () => snap });
    view.dispatch(parseCommand("connections"));
    const toggle = connectionsLines(snap, 400).find((l) => l.text.includes("显示 清单"))!;
    expect(toggle.action).toEqual({ type: "toggle-expand", key: SLACK_MANIFEST_EXPAND_KEY });
    view.dispatch(toggle.action!);
    const expanded = screenText(renderScreen(view.get(), snap, { cols: 160, rows: 200 }).lines);
    expect(expanded).toContain("▾ 隐藏 清单（回车）");
    expect(expanded).toContain("socket_mode_enabled: true");
    expect(expanded).toContain("app_mentions:read");
    view.dispatch(toggle.action!);
    const collapsed = screenText(renderScreen(view.get(), snap, { cols: 160, rows: 200 }).lines);
    expect(collapsed).not.toContain("socket_mode_enabled: true");
  });

  it("小终端中每行都不超宽，换行后的链接可重新拼成精确 URL", async () => {
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    const narrow = connectionsLines(snap, 44);
    for (const l of narrow) expect(l.text.length).toBeLessThanOrEqual(44);
    expect(linkRows(narrow)).toBe(buildSlackAppManifest().url);
    const view = createViewState({ instanceId: "fixture", getSnapshot: () => snap });
    view.dispatch(parseCommand("connections"));
    const screen = renderScreen(view.get(), snap, { cols: 60, rows: 20 });
    for (const row of screen.lines) expect(row.length).toBeLessThanOrEqual(60);
  });
});

describe("连接 · Slack 已配置与旧版 daemon", () => {
  it("已配置且 token 可解析时不显示设置区块，既有状态保持不变", async () => {
    const secrets = join(home, "secret.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=fixture-bot\nSLACK_APP_TOKEN=fixture-app\n", { mode: 0o600 });
    config = { ...DEFAULT_CONFIG, secretsEnvFile: secrets, channel: "C-FIXTURE" };
    saveConfig(config, home);
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    const body = text(connectionsLines(snap, 400));
    expect(body).not.toContain("未配置 · 尚无 Slack 应用令牌");
    expect(body).not.toContain("显示 清单");
    expect(snap.connections?.nextAction).not.toContain("manifest");
  });

  it("缺少清单路由的旧版 daemon 回退到 CLI 命令，且不添加读取错误", async () => {
    manifestRoute = false;
    const snap = await hydrate(makeClient()) as FleetSnapshot;
    expect(snap.slackManifest).toBeNull();
    expect(snap.readErrors.join("\n")).not.toMatch(/manifest/i);
    const body = text(connectionsLines(snap, 400));
    expect(body).toContain("zrig slack manifest --url（此后台服务不提供清单）");
  });
});
