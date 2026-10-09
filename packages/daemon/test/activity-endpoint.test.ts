// OPR.0.4.3.28 B2——后台服务自行配置的 activity-hook token 与 endpoint。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { ensureActivityHookToken, writeActivityEndpointFile, readActivityEndpointFile, deriveActivityUrl } from "../src/domain/activity-endpoint.js";

describe("activity-endpoint（OPR.0.4.3.28 B2）", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-s28-"));
  });
  afterEach(() => {
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* 忽略。 */ }
  });

  it("没有持久化 token 时生成一个，并以 0600 mode 持久化", () => {
    const token = ensureActivityHookToken(stateDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 个随机字节的十六进制表示。
    const tokenPath = nodePath.join(stateDir, "activity-hook-token");
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(fs.readFileSync(tokenPath, "utf-8").trim()).toBe(token);
    // mode 受保护（仅 owner 可访问）。
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("跨调用复用持久化 token（后台服务重启后保持稳定）", () => {
    const first = ensureActivityHookToken(stateDir);
    const second = ensureActivityHookToken(stateDir); // 模拟后台服务后续启动。
    expect(second).toBe(first);
  });

  it("写入并读回 endpoint 快照 {baseUrl, token}", () => {
    writeActivityEndpointFile(stateDir, { baseUrl: "http://127.0.0.1:7433", token: "abc123" });
    const endpointPath = nodePath.join(stateDir, "activity-endpoint.json");
    expect(fs.statSync(endpointPath).mode & 0o777).toBe(0o600);
    const read = readActivityEndpointFile(stateDir);
    expect(read).toEqual({ baseUrl: "http://127.0.0.1:7433", token: "abc123" });
  });

  // OPR.0.4.3.28 Blocker 2——URL 必须遵循显式的后台服务绑定 host（后台服务只绑定该 host）；
  // 通配或缺失值映射到 loopback。
  it("deriveActivityUrl 逐字使用显式的 tailnet/hostname host", () => {
    expect(deriveActivityUrl("100.64.0.5", "7433")).toBe("http://100.64.0.5:7433");
    expect(deriveActivityUrl("my-box.tail-scale.ts.net", "7433")).toBe("http://my-box.tail-scale.ts.net:7433");
    expect(deriveActivityUrl("localhost", "7433")).toBe("http://localhost:7433");
  });

  it("deriveActivityUrl 将通配或 bind-all host 映射到 loopback（原地址不可连接）", () => {
    expect(deriveActivityUrl("0.0.0.0", "7433")).toBe("http://127.0.0.1:7433");
    expect(deriveActivityUrl("::", "7433")).toBe("http://127.0.0.1:7433");
  });

  it("host/port 缺失时 deriveActivityUrl 回退到 loopback + DEFAULT_PORT", () => {
    expect(deriveActivityUrl(undefined, undefined)).toBe("http://127.0.0.1:7433");
    expect(deriveActivityUrl(undefined, "9001")).toBe("http://127.0.0.1:9001");
  });

  it("文件缺失或格式错误时 readActivityEndpointFile 返回 null", () => {
    expect(readActivityEndpointFile(stateDir)).toBeNull();
    fs.writeFileSync(nodePath.join(stateDir, "activity-endpoint.json"), "{not json");
    expect(readActivityEndpointFile(stateDir)).toBeNull();
    fs.writeFileSync(nodePath.join(stateDir, "activity-endpoint.json"), JSON.stringify({ baseUrl: "" }));
    expect(readActivityEndpointFile(stateDir)).toBeNull();
  });
});
