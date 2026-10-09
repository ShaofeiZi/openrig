import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../src/domain/gateway/slack/config.js";
import { addHumanFragment } from "../src/domain/gateway/human-registry.js";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "channel-lifecycle-"));
  homes.push(home);
  addHumanFragment({ entityId: "alex", class: "human", displayName: "Alex", address: "alex@external",
    connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "env:private-pointer", role: "primary" }],
    prefs: { deliveryClass: "B" } }, home);
  saveConfig({ ...DEFAULT_CONFIG, secretsEnvFile: "private-pointer", channel: "C-private" }, home);
  const restart = vi.fn();
  const list = vi.fn(() => []);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, { list } as never);
    c.set("gatewaySubsystem" as never, { restart, status: () => ({ state: loadConfig(home).enabled ? "active" : "disabled" }) } as never);
    await next();
  });
  app.route("/", gatewayRoutes({ home }));
  const post = (verb: string, body: object = {}) => app.request(`/slack/${verb}`, {
    method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "operator@rig" }, body: JSON.stringify(body),
  });
  const receipts = () => readFileSync(join(home, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { home, app, restart, list, post, receipts };
}

describe("后台服务入口处的人类通道生命周期", () => {
  it("现有 backlog 无法解决时保持 disabled 状态", async () => {
    const f = fixture();
    writeFileSync(join(f.home, "gateway", "humans.generated.yaml"), "invalid projection");
    const response = await f.post("enable");
    expect(response.status).toBe(500);
    expect(loadConfig(f.home).enabled).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.receipts().at(-1)).toMatchObject({ effect: "failed", after: null });
  });
  it("串行化并发启用，使重复调用无法重新播种新产生的待处理工作", async () => {
    const f = fixture();
    const responses = await Promise.all([f.post("enable"), f.post("enable")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.receipts().filter((row) => row.effect !== "started").map((row) => row.effect)).toEqual(["applied", "no-op"]);
  });
  it("记录变更归属、区分重复操作，并在改变状态前要求关闭原因", async () => {
    const f = fixture();
    expect((await f.post("enable", { actor: "other@rig", reason: "resume delivery" })).status).toBe(200);
    expect(loadConfig(f.home).enabled).toBe(true);
    expect((await f.post("enable", { reason: "replay" })).status).toBe(200);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect((await f.post("disable")).status).toBe(400);
    expect(loadConfig(f.home).enabled).toBe(true);
    expect((await f.post("disable", { reason: "bounded maintenance" })).status).toBe(200);
    expect((await f.post("disable", { reason: "repeat maintenance" })).status).toBe(200);
    expect(f.restart).toHaveBeenCalledTimes(2);
    const rows = f.receipts().filter((row) => row.effect !== "started");
    expect(rows.map((row) => row.effect)).toEqual(["applied", "no-op", "applied", "no-op"]);
    expect(rows[0]).toMatchObject({ actor: "operator@rig", provenance: "transport:v1", reason: "resume delivery", before: { enabled: false }, after: { enabled: true } });
    expect(rows[2]).toMatchObject({ reason: "bounded maintenance", before: { enabled: true }, after: { enabled: false } });
    expect(JSON.stringify(rows)).not.toMatch(/private-pointer|C-private|other@rig/);
  });

  it("要求可记录的 actor，且不臆造身份", async () => {
    const f = fixture();
    const response = await f.app.request("/slack/enable", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(400);
    expect(loadConfig(f.home).enabled).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
  });
});
