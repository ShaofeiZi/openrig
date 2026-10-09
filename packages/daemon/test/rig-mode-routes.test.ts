// Slice 09——rig-mode HTTP route 测试。
//
// 在 route 层锁定 HG-4 + HG-SAFE：
//   - 配置 bearer 后，PUT/DELETE 要求 operator bearer（HG-4，agent 路径不能修改）。
//   - PUT 通过同一个 store validator 验证 record；拒绝 auto-accept posture
//     （HG-SAFE runtime 防御）。
//   - GET 端点在 daemon 现有 posture 内保持开放。
//   - resolveEffective 返回更具体的 binding（HG-3）。
//   - 源码 grep：route 文件不含 permission-allowlist / auth / tmux / lifecycle 标识符
//     （HG-SAFE 源码级约束）。
//
// BLOCKING-1 修复（guard 裁定 qitem-20260518043346）：PUT body 形状为
// `{ mode, record }`；record 自身是 10 字段 schema，内部没有 `mode`。
//
// BLOCKING-2 修复（guard 裁定 qitem-20260518043346）：GET / PUT / DELETE 均将带非空
// qualifier 的 `global_host` 拒绝为 `qualifier_forbidden`。不做隐藏 scope 推断，也不能因
// 路径中误加 segment 而修改 global-host。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigModeStore } from "../src/domain/rig-mode/rig-mode-store.js";
import { rigModeRoutes } from "../src/routes/rig-mode.js";
import type { OperatorContextMode, OperatorContextModeRecord } from "../src/domain/rig-mode/rig-mode-types.js";

function makeRecord(overrides?: Partial<OperatorContextModeRecord>): OperatorContextModeRecord {
  return {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
    scope: "qitem",
    expiry_or_stale_rule: "re_confirm_on_long_gap",
    evidence_citation: "operator confirmed debug",
    ...overrides,
  };
}

function putBody(mode: OperatorContextMode, recordOverrides?: Partial<OperatorContextModeRecord>): unknown {
  return { mode, record: makeRecord(recordOverrides) };
}

function buildApp(db: Database.Database, bearer: string | null): { app: Hono; store: RigModeStore } {
  const store = new RigModeStore(db);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigModeStore" as never, store);
    await next();
  });
  app.route("/api/rig-mode", rigModeRoutes({ bearerToken: bearer }));
  return { app, store };
}

describe("rig-mode HTTP route——slice 09", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET /defaults 返回 6×7 配置、default-scope 与 DEFAULT_STALE_RULE", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-mode/defaults");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recommendedModeDefaults: Record<string, unknown>;
      recommendedDefaultScope: Record<string, string>;
      defaultStaleRule: string;
    };
    expect(Object.keys(body.recommendedModeDefaults).sort()).toEqual(["away", "debug", "delegated", "desk", "focus", "human-led", "mobile", "sleep"]);
    expect(body.recommendedDefaultScope.debug).toBe("qitem");
    expect(body.defaultStaleRule).toBe("re_confirm_on_long_gap");
  });

  it("HG-4：配置后 PUT 要求 operator bearer", async () => {
    const { app } = buildApp(db, "operator-token");
    const res = await app.request("/api/rig-mode/bindings/qitem/q-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(putBody("debug")),
    });
    expect(res.status).toBe(401);
  });

  it("HG-4（BLOCKING-1）：PUT 接受 { mode, record } 并可通过 GET 往返读取", async () => {
    const { app } = buildApp(db, "operator-token");
    const put = await app.request("/api/rig-mode/bindings/qitem/q-1", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer operator-token",
      },
      body: JSON.stringify(putBody("debug")),
    });
    expect(put.status).toBe(200);
    const putBodyResp = (await put.json()) as { binding: { mode: string; setBy: string; record: Record<string, unknown> } };
    expect(putBodyResp.binding.setBy).toBe("operator");
    expect(putBodyResp.binding.mode).toBe("debug");
    // record 自身不携带 `mode`。
    expect(putBodyResp.binding.record.mode).toBeUndefined();

    const get = await app.request("/api/rig-mode/bindings/qitem/q-1");
    expect(get.status).toBe(200);
    const getBody = (await get.json()) as { binding: { mode: string; record: Record<string, unknown> } };
    expect(getBody.binding.mode).toBe("debug");
    expect(getBody.binding.record.mode).toBeUndefined();
  });

  it("BLOCKING-1：缺少 `mode` 的 PUT body 以 body_shape_invalid 拒绝", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-mode/bindings/qitem/q-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: makeRecord() }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("body_shape_invalid");
  });

  it("BLOCKING-1：在 record 中夹带 `mode` 的 PUT body 以未知字段拒绝", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-mode/bindings/qitem/q-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "debug", record: { ...makeRecord(), mode: "debug" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors?: string[] };
    expect(body.error).toBe("validation_failed");
    expect(body.errors?.some((e) => e.includes(`未知字段 "mode"`))).toBe(true);
  });

  it("HG-SAFE：拒绝 permission_prompt_posture='auto_accept' 的 PUT（runtime 防御）", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-mode/bindings/qitem/q-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "debug",
        record: { ...makeRecord(), permission_prompt_posture: "auto_accept" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors?: string[] };
    expect(body.error).toBe("validation_failed");
    expect(body.errors?.some((e) => e.includes("permission_prompt_posture"))).toBe(true);
  });

  it("HG-3 有效解析：qitem 优先于 global_host", async () => {
    const { app, store } = buildApp(db, null);
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("qitem", "q-1", "debug", makeRecord({ scope: "qitem" }));

    const r1 = await app.request("/api/rig-mode/effective?qitem=q-1");
    expect(r1.status).toBe(200);
    const r1body = (await r1.json()) as { effective: { resolvedScope: string; binding: { mode: string } }; posture: string };
    expect(r1body.effective.resolvedScope).toBe("qitem");
    expect(r1body.effective.binding.mode).toBe("debug");
    expect(r1body.posture).toBe("known");

    const r2 = await app.request("/api/rig-mode/effective?qitem=q-other");
    const r2body = (await r2.json()) as { effective: { resolvedScope: string; binding: { mode: string } } };
    expect(r2body.effective.resolvedScope).toBe("global_host");
    expect(r2body.effective.binding.mode).toBe("sleep");
  });

  it("Q6 unknown_posture：GET /effective 无匹配 binding 时返回 null + unknown_posture", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-mode/effective?qitem=q-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { effective: unknown; posture: string };
    expect(body.effective).toBeNull();
    expect(body.posture).toBe("unknown_posture");
  });

  it("GET /bindings 返回全部 binding", async () => {
    const { app, store } = buildApp(db, null);
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    const res = await app.request("/api/rig-mode/bindings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindings: Array<{ id: string }> };
    expect(body.bindings.map((b) => b.id).sort()).toEqual(["global_host:host", "rig:rig-a"]);
  });

  it("HG-4：配置后 DELETE 要求 operator bearer", async () => {
    const { app, store } = buildApp(db, "operator-token");
    store.setBinding("rig", "rig-a", "focus", makeRecord({ scope: "rig" }));
    const noAuth = await app.request("/api/rig-mode/bindings/rig/rig-a", { method: "DELETE" });
    expect(noAuth.status).toBe(401);
    const auth = await app.request("/api/rig-mode/bindings/rig/rig-a", {
      method: "DELETE",
      headers: { authorization: "Bearer operator-token" },
    });
    expect(auth.status).toBe(200);
    const body = (await auth.json()) as { removed: boolean };
    expect(body.removed).toBe(true);
  });

  it("route 层以 scope_invalid 拒绝未知 scope", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-mode/bindings/banana/x", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(putBody("debug")),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("scope_invalid");
  });

  it("qualifier_required：GET /bindings/rig 缺少 qualifier 时返回 400", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-mode/bindings/rig");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("qualifier_required");
  });

  it("GET /bindings/global_host 不带 qualifier 时读取 host binding", async () => {
    const { app, store } = buildApp(db, null);
    store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
    const res = await app.request("/api/rig-mode/bindings/global_host");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { binding: { mode: string } };
    expect(body.binding.mode).toBe("sleep");
  });

  it("binding 不存在时返回 404", async () => {
    const { app } = buildApp(db, null);
    const res = await app.request("/api/rig-mode/bindings/rig/rig-not-there");
    expect(res.status).toBe(404);
  });

  // BLOCKING-2——所有动词都必须拒绝带非空 qualifier 的 global_host。route 不会静默把
  // qualifier 丢弃为 null，否则会形成隐藏 scope 推断，并允许拼错的 URL 写入/删除 host binding。
  describe("BLOCKING-2：拒绝 global_host + 非空 qualifier（无隐藏推断）", () => {
    it("GET /bindings/global_host/unexpected → 400 qualifier_forbidden", async () => {
      const { app } = buildApp(db, null);
      const res = await app.request("/api/rig-mode/bindings/global_host/unexpected");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("qualifier_forbidden");
    });

    it("PUT /bindings/global_host/unexpected → 400 qualifier_forbidden，且 global-host 行不变", async () => {
      const { app, store } = buildApp(db, null);
      store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
      const before = store.getBinding("global_host", null)!;
      const res = await app.request("/api/rig-mode/bindings/global_host/unexpected", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(putBody("debug", { scope: "global_host" })),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("qualifier_forbidden");
      const after = store.getBinding("global_host", null)!;
      expect(after.mode).toBe("sleep");
      expect(after.setAt).toBe(before.setAt);
    });

    it("DELETE /bindings/global_host/unexpected → 400 qualifier_forbidden，且不删除 global-host 行", async () => {
      const { app, store } = buildApp(db, null);
      store.setBinding("global_host", null, "sleep", makeRecord({ scope: "global_host" }));
      const res = await app.request("/api/rig-mode/bindings/global_host/unexpected", {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("qualifier_forbidden");
      expect(store.getBinding("global_host", null)).not.toBeNull();
    });
  });

  // HG-SAFE 源码级约束——route 文件不引用 permission allowlist / runtime config / tmux /
  // lifecycle 标识符；该 route 是纯粹与 binding 相关的表面（HG-SAFE）。
  it("HG-SAFE：rig-mode route 源码不含 permission / auth-token / tmux / lifecycle 标识符", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "..", "src", "routes", "rig-mode.ts"),
      "utf-8",
    );
    for (const forbidden of [
      "permissionAllowlist",
      "permission_allowlist",
      "runtimeConfig",
      "runtime_config",
      "tmuxAdapter",
      "tmux_session",
      "session_transport",
      "auth_token",
    ]) {
      expect(src.includes(forbidden)).toBe(false);
    }
  });
});
