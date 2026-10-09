import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, configFileExists, staticReadiness, DEFAULT_CONFIG } from "../src/domain/gateway/slack/config.js";
import { parseEnvFile, resolveSecret, checkEnvFilePermissions, type SecretFsOps } from "../src/domain/gateway/slack/secrets.js";

describe("Slice-11 config——一等支持 + 如实报告未配置（第 5 项）", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "slice11-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("配置缺失时 loadConfig 返回默认值（不抛错）；inbound-dest 是一等默认值", () => {
    expect(configFileExists(home)).toBe(false);
    const cfg = loadConfig(home);
    expect(cfg.enabled).toBe(false);
    expect(cfg.inboundDestination).toBe("operator-agent@kernel");
    expect(cfg).not.toHaveProperty("alertTag");
  });

  it("save + reload 往返；inbound destination 可覆盖（T1075）", () => {
    const p = saveConfig({ ...DEFAULT_CONFIG, inboundDestination: "ops-desk@kernel", channel: "C123", enabled: true }, home);
    expect(fs.existsSync(p)).toBe(true);
    const cfg = loadConfig(home);
    expect(cfg.inboundDestination).toBe("ops-desk@kernel");
    expect(cfg.channel).toBe("C123");
    expect(cfg.enabled).toBe(true);
    // config file 不携带 secret value（仅 ref）——第 10 项
    const raw = fs.readFileSync(p, "utf8");
    expect(raw).not.toMatch(/xox[bp]-|xapp-|hooks\.slack\.com/);
  });

  it("staticReadiness 不抛错并如实报告缺失项（S10：bot+channel 控制 outbound；webhook 已退役）", () => {
    const cfg = loadConfig(home);
    const r = staticReadiness(cfg, /*bot*/ false, /*app*/ false);
    const byLabel = Object.fromEntries(r.map((x) => [x.label, x.ok]));
    expect(byLabel["bot-token"]).toBe(false);
    expect(byLabel["app-token (Socket Mode)"]).toBe(false);
    expect(byLabel["enabled"]).toBe(false);
    expect(byLabel["outbound-webhook"]).toBeUndefined(); // webhook row 随 relay 一并退役
    // secret 解析成功时，这些状态会翻转
    const r2 = staticReadiness({ ...cfg, channel: "C1", enabled: true }, true, true);
    const by2 = Object.fromEntries(r2.map((x) => [x.label, x.ok]));
    expect(by2["bot-token"] && by2["app-token (Socket Mode)"] && by2["channel"] && by2["enabled"]).toBe(true);
  });
});

describe("Slice-11 secret——解析 + hygiene（第 7 + 10 项）", () => {
  it("parseEnvFile 解析 KEY=VALUE、裁剪引号并忽略注释/空行", () => {
    const m = parseEnvFile('# c\nSLACK_WEBHOOK_URL="https://x"\n\nSLACK_APP_TOKEN=xapp-1\nbad line\n');
    expect(m.SLACK_WEBHOOK_URL).toBe("https://x");
    expect(m.SLACK_APP_TOKEN).toBe("xapp-1");
    expect(Object.keys(m)).toHaveLength(2);
  });

  it("resolveSecret：env var 优先；回退到 env-file；未设置时为 null", () => {
    const fsops: SecretFsOps = { readFileSync: () => "SLACK_WEBHOOK_URL=https://from-file", statMode: () => 0o600 };
    // env var precedence
    expect(resolveSecret("SLACK_WEBHOOK_URL", { env: { SLACK_WEBHOOK_URL: "https://from-env" }, envFile: "/x", fsops })).toBe("https://from-env");
    // env-file fallback
    expect(resolveSecret("SLACK_WEBHOOK_URL", { env: {}, envFile: "/x", fsops })).toBe("https://from-file");
    // B4：普通 OPENRIG_SLACK_* alias（OPENRIG_ + name）可解析
    expect(resolveSecret("SLACK_APP_TOKEN", { env: { OPENRIG_SLACK_APP_TOKEN: "xapp-EXAMPLE-fake" } })).toBe("xapp-EXAMPLE-fake");
    expect(resolveSecret("SLACK_WEBHOOK_URL", { env: { OPENRIG_SLACK_WEBHOOK_URL: "https://from-alias" } })).toBe("https://from-alias");
    // B4 回归 pin：重复前缀的 OPENRIG_SLACK_SLACK_* 形式不得解析
    expect(resolveSecret("SLACK_APP_TOKEN", { env: { OPENRIG_SLACK_SLACK_APP_TOKEN: "doubled-wrong" } })).toBeNull();
    // 无法解析 → null（如实）
    expect(resolveSecret("MISSING", { env: {} })).toBeNull();
  });

  it("checkEnvFilePermissions 标记 group/world 可读的 secret file（第 10 项）", () => {
    const strict: SecretFsOps = { readFileSync: () => "", statMode: () => 0o600 };
    const loose: SecretFsOps = { readFileSync: () => "", statMode: () => 0o644 };
    const absent: SecretFsOps = { readFileSync: () => "", statMode: () => null };
    expect(checkEnvFilePermissions("/s.env", strict)).toBeNull();
    expect(checkEnvFilePermissions("/s.env", loose)).toMatch(/0600/);
    expect(checkEnvFilePermissions("/s.env", absent)).toBeNull();
  });
});
