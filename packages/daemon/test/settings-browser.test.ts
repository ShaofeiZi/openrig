import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { SettingsStore, SETTINGS_VALID_KEYS } from "../src/domain/user-settings/settings-store.js";
import { settingsBrowser } from "../src/domain/user-settings/settings-browser.js";
import { configRoutes } from "../src/routes/config.js";
import { DEFAULT_CONFIG, configPathFor, saveConfig } from "../src/domain/gateway/slack/config.js";
import { addHumanFragment, projectionPath } from "../src/domain/gateway/human-registry.js";
import { DEFAULT_HEALTH_POLICY } from "../src/domain/health-policy.js";
import { channelStateDigest } from "../src/domain/gateway/channel-operations.js";

let home: string, store: SettingsStore;
const credential = "fixture-private-bot-value";
let external: ReturnType<typeof vi.fn>;
const read = () => settingsBrowser(store, null, home);
const entry = (key: string) => read().entries.find((e) => e.key === key)!;
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((d): Array<[string, string]> => {
    const file = join(dir, d.name);
    return d.isDirectory() ? Object.entries(snapshot(file)) : [[file, readFileSync(file).toString("base64")]];
  }));
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "s06-browser-"));
  store = new SettingsStore(join(home, "config.json"));
  for (const key of Object.keys(process.env).filter((k) => /^(OPENRIG_|RIGGED_|SLACK_)/.test(k))) vi.stubEnv(key, "");
  vi.stubEnv("OPENRIG_HOME", home);
  vi.stubEnv("OPENRIG_WORKSPACE_ROOT", join(home, "workspace"));
  external = vi.fn(() => { throw new Error("发生非预期的外部调用"); });
  vi.stubGlobal("fetch", external);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });

describe("被动 CONFIG 读取 view", () => {
  it("枚举实际 registry 与动态 entry，同时保持缺失的结构化 source 可区分", () => {
    const first = read();
    expect(first.entries.filter((e) => e.group === "general").map((e) => e.key)).toEqual([...SETTINGS_VALID_KEYS]);
    expect(first.sources.map((s) => [s.id, s.state])).toEqual([
      ["general", "missing"], ["slack", "missing"], ["people", "missing"], ["hosts", "missing"], ["health", "missing"],
    ]);
    expect(entry("slack.enabled")).toMatchObject({ value: false, source: "default" });
    store.set("feed.subscriptions.fixture-host.enabled", "true");
    expect(entry("feed.subscriptions.fixture-host.enabled")).toMatchObject({ value: true, defaultValue: false, source: "file" });
    expect(entry("retention.usage_samples_days")).toMatchObject({ value: 14, source: "default" });
    expect(entry("ui.terminal.max_live_terminals")).toMatchObject({ value: "", scope: "旧版 Web 客户端" });
    // 保留准备阶段的 CLI/daemon parity 失败，不在这里“修复”。
    expect(entry("workflow.exception_routing")).toMatchObject({ value: "", defaultValue: "", source: "default" });
  });

  it("使用 resolver provenance 并保留完整安全值，同时隐藏非预期值和指令 body", () => {
    const longPath = join(home, "one very long folder", "detail".repeat(50));
    writeFileSync(store.configPath, JSON.stringify({ workspace: { projectsRoot: longPath },
      host: { name: { innocent: credential } }, policies: { claudeCompaction: { messageInline: credential } } }));
    vi.stubEnv("OPENRIG_UI_TIMEZONE", "Europe/London");
    expect(entry("workspace.projects_root")).toMatchObject({ value: longPath, source: "file", visibility: "shown" });
    expect(entry("ui.timezone")).toMatchObject({ value: "Europe/London", source: "env" });
    expect(entry("host.name")).toMatchObject({ value: null, source: "file", visibility: "withheld" });
    expect(entry("policies.claude_compaction.message_inline")).toMatchObject({ value: null, visibility: "withheld" });
    expect(JSON.stringify(read())).not.toContain(credential);
  });

  it.each(["{ broken", "null", "[]"])("保持畸形 general source %s 与可读 health 和 Slack 分离", (bytes) => {
    writeFileSync(store.configPath, bytes);
    const result = read();
    expect(result.sources.find((s) => s.id === "general")?.state).toBe("malformed");
    expect(result.entries.filter((e) => e.group === "general").every((e) => e.visibility === "unavailable")).toBe(true);
    expect(result.entries.filter((e) => e.group === "general").every((e) => e.defaultKnown === false)).toBe(true);
    expect(result.entries.find((e) => e.key === "health.policy.diagnosis.enabled")?.value).toBe(false);
    expect(result.entries.find((e) => e.key === "slack.enabled")?.value).toBe(false);
  });

  it("让已删除配置保持 unavailable，不宣称使用 fallback 默认值", () => {
    writeFileSync(store.configPath, JSON.stringify({ context: { packsRoot: "/obsolete" } }));
    expect(read().sources.find((s) => s.id === "general")?.state).toBe("unavailable");
    expect(entry("workspace.root").visibility).toBe("unavailable");
  });

  it.each(["malformed", "unavailable", "disabled"])("防止 %s Slack 隐藏通用设置", (state) => {
    if (state === "malformed") writeFileSync(configPathFor(home), "{ " + credential);
    if (state === "unavailable") mkdirSync(configPathFor(home));
    if (state === "disabled") saveConfig({ ...DEFAULT_CONFIG, enabled: false }, home);
    const result = read();
    expect(result.sources.find((s) => s.id === "slack")?.state).toBe(state === "disabled" ? "available" : state);
    expect(entry("queue.wake_retry_cap").value).toBe(3);
    expect(entry("slack.enabled")).toMatchObject(state === "disabled"
      ? { value: false, source: "file", visibility: "shown" } : { value: null, visibility: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("安全覆盖结构化 owner，重复读取 route 时不修复、不写入、也不联系 target", async () => {
    const envFile = join(home, "credentials.env");
    writeFileSync(envFile, "SLACK_BOT_TOKEN=" + credential + "\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, sourceLabel: credential, secretsEnvFile: envFile }, home);
    store.set("workspace.projects_root", join(home, credential));
    expect(addHumanFragment({ entityId: "alex", class: "human", displayName: "Alex", address: "alex@external",
      prefs: { deliveryClass: "B", availability: "focus" },
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://private-fixture", role: "primary", handle: "U-FIXTURE" }],
    }, home).ok).toBe(true);
    writeFileSync(join(home, "hosts.yaml"), stringify({ hosts: [{ id: "remote", transport: "http",
      url: "https://user:unpublished-value@example.test/private-path?q=private-query#private-fragment",
      bearer_file: "/private-auth-reference", notes: "private free notes" }] }));
    mkdirSync(join(home, "health"));
    writeFileSync(join(home, "health", "policy.json"), JSON.stringify(DEFAULT_HEALTH_POLICY));
    const before = snapshot(home);
    const http = new Hono();
    http.use("*", async (c, next) => { c.set("settingsStore" as never, store as never); await next(); });
    http.route("/api/config", configRoutes({ home }));
    for (let i = 0; i < 2; i++) {
      const response = await http.request("/api/config?view=browser");
      expect(response.status).toBe(200);
      const result = await response.json();
      const bytes = JSON.stringify(result);
      for (const hidden of [credential, "private-fixture", "private-auth-reference", "private free notes",
        "unpublished-value", "private-path", "private-query", "private-fragment"]) expect(bytes.includes(hidden)).toBe(false);
      expect(result.entries.find((e: { key: string }) => e.key.startsWith("hosts.") && e.key.endsWith(".url"))).toMatchObject({ value: "https://example.test" });
      expect(result.entries.find((e: { key: string }) => e.key.startsWith("people.") && e.key.endsWith(".credentialReference"))).toMatchObject({ value: true });
      expect(result.entries.find((e: { key: string }) => e.key === "workspace.projects_root")).toMatchObject({ visibility: "withheld" });
      expect(result.entries.some((e: { key: string }) => e.key === "health.policy.thresholds.ceremonyTransitions")).toBe(true);
    }
    expect(snapshot(home)).toEqual(before);
    expect(external).not.toHaveBeenCalled();
    // 现有 route 契约仍是通用 settings map，而非 browser payload。
    expect(await (await http.request("/api/config")).json()).toHaveProperty(["settings", "workspace.projects_root"]);
  });

  it("即使 Slack 无法加载也遮蔽环境凭据", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", credential);
    writeFileSync(configPathFor(home), "malformed");
    store.set("host.name", credential);
    expect(JSON.stringify(read()).includes(credential)).toBe(false);
    expect(entry("host.name").visibility).toBe("withheld");
  });

  it("registry 顺序变化时保留 target 选择 key", () => {
    const a = { id: "first", transport: "ssh", target: "first.example" };
    const b = { id: "second", transport: "ssh", target: "second.example" };
    const file = join(home, "hosts.yaml");
    writeFileSync(file, stringify({ hosts: [a, b] }));
    const key = read().entries.find((e) => e.group === "hosts" && e.value === "first.example")!.key;
    writeFileSync(file, stringify({ hosts: [b, a] }));
    expect(read().entries.find((e) => e.key === key)?.value).toBe("first.example");
  });

  it("隔离畸形 host、health 与 human source，并在刷新时移除旧值", () => {
    writeFileSync(join(home, "hosts.yaml"), "hosts: invalid");
    mkdirSync(join(home, "health"));
    writeFileSync(join(home, "health", "policy.json"), "{ " + credential);
    mkdirSync(join(home, "gateway"), { recursive: true });
    writeFileSync(projectionPath(home), credential);
    const result = read();
    for (const id of ["hosts", "health", "people"]) expect(result.sources.find((s) => s.id === id)?.state).toBe("malformed");
    expect(result.entries.find((e) => e.key === "health.policy.diagnosis.enabled")?.visibility).toBe("unavailable");
    expect(result.entries.find((e) => e.key === "workspace.root")?.visibility).toBe("shown");
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("区分已配置的启用状态、matching/changed 与缺失的运行观测", () => {
    const cfg = { ...DEFAULT_CONFIG, enabled: false };
    saveConfig(cfg, home);
    const matching = settingsBrowser(store, { state: "active", connector: { configurationDigest: channelStateDigest(cfg) } }, home);
    expect(matching.sources.find((s) => s.id === "slack")?.detail).toContain("已禁用；已应用 matching");
    const changed = settingsBrowser(store, { state: "active", connector: { configurationDigest: "old" } }, home);
    expect(changed.sources.find((s) => s.id === "slack")?.detail).toContain("已应用 changed");
    expect(read().sources.find((s) => s.id === "slack")?.detail).toContain("已应用 unverified");
  });
});
