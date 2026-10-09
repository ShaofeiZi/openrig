// OPR.0.4.3.28 B1+B3——relay 解析 ingest URL + token，无需运维把
// OPENRIG_URL/OPENRIG_ACTIVITY_HOOK_TOKEN 种进 shell。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  resolveEndpoint: (env: Record<string, string | undefined>) => { baseUrl?: string; token?: string };
  buildOpenRigPayload: (
    providerPayload: Record<string, unknown>,
    env: Record<string, string | undefined>,
    now?: () => Date,
  ) => Record<string, unknown> | null;
};

describe("activity-relay resolveEndpoint（OPR.0.4.3.28 B1+B3）", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-relay-")); });
  afterEach(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 忽略 */ } });

  it("快路径：env OPENRIG_URL + token 原样使用", () => {
    const r = relay.resolveEndpoint({ OPENRIG_URL: "http://d:9999", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r).toEqual({ baseUrl: "http://d:9999", token: "tok" });
  });

  it("B1：URL 缺失时由 OPENRIG_HOST + OPENRIG_PORT 合成 base URL", () => {
    const r = relay.resolveEndpoint({ OPENRIG_HOST: "10.0.0.5", OPENRIG_PORT: "7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r.baseUrl).toBe("http://10.0.0.5:7433");
    expect(r.token).toBe("tok");
  });

  it("B1：仅有 PORT 时 host 默认 127.0.0.1", () => {
    const r = relay.resolveEndpoint({ OPENRIG_PORT: "7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" });
    expect(r.baseUrl).toBe("http://127.0.0.1:7433");
  });

  it("B3：file-discovery 为 reconcile/restored seat 提供 url+token（无 env 变量）", () => {
    fs.writeFileSync(nodePath.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:7433", token: "filetok" }));
    // 冻结 env 只有 OPENRIG_HOME（继承而来），无 url/token。
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home });
    expect(r.baseUrl).toBe("http://127.0.0.1:7433");
    expect(r.token).toBe("filetok");
  });

  it("B3：file-discovery 只补缺失的那一半（env token 优先，file 提供 url）", () => {
    fs.writeFileSync(nodePath.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://file:1", token: "filetok" }));
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home, OPENRIG_ACTIVITY_HOOK_TOKEN: "envtok" });
    expect(r.token).toBe("envtok"); // env token 不被覆盖
    expect(r.baseUrl).toBe("http://file:1");
  });

  it("安全 no-op：env 中什么都没有且无可发现文件 → url/token 为 undefined", () => {
    const r = relay.resolveEndpoint({ OPENRIG_HOME: home }); // home 无 endpoint.json
    expect(r.baseUrl).toBeFalsy();
    expect(r.token).toBeFalsy();
  });
});

describe("activity-relay occupant generation 携带（W2a producer）", () => {
  const identity = {
    OPENRIG_SESSION_NAME: "dev-qa@producer-rig",
    OPENRIG_NODE_ID: "node-1",
    OPENRIG_RUNTIME: "codex",
  };

  it("精确携带 launch generation", () => {
    const payload = relay.buildOpenRigPayload(
      { hookEvent: "Stop" },
      { ...identity, OPENRIG_OCCUPANT_GENERATION: "generation-A" },
      () => new Date("2026-08-09T00:00:00.000Z"),
    );
    expect(payload).toMatchObject({ generation: "generation-A" });
  });

  it("launch generation 缺失时显式发 null", () => {
    const payload = relay.buildOpenRigPayload(
      { hookEvent: "Stop" },
      identity,
      () => new Date("2026-08-09T00:00:00.000Z"),
    );
    expect(payload).toHaveProperty("generation", null);
  });
});
