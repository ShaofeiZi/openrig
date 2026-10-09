import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalOrigin } from "../src/local-origin.js";
import { DaemonClient, remoteDaemonClient } from "../src/client.js";
import { resolveOriginSelfHostId } from "../src/daemon-lifecycle.js";

let home: string;
let dbPath: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "openrig-qa-origin-"));
  dbPath = join(home, "source.sqlite");
  vi.stubEnv("OPENRIG_HOME", home); vi.stubEnv("OPENRIG_DB", dbPath);
  vi.stubEnv("RIGGED_DB", ""); vi.stubEnv("OPENRIG_URL", "http://forwarded-endpoint:7433");
  vi.stubEnv("RIGGED_URL", ""); vi.stubEnv("OPENRIG_SESSION_NAME", "rig-admin@ops");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(home, {recursive: true, force: true}); });
function seed(id: string, file = dbPath) {
  const db = new Database(file);
  db.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
  db.prepare("INSERT INTO self_host_identity VALUES (1, ?)").run(id); db.close();
}
function client(targetId?: string) {
  const requests: Array<{url: string; headers: Record<string,string>}> = [];
  const factory = (url: string) => new DaemonClient(url, { fetchImpl: (async (url, init) => {
    requests.push({url: String(url), headers: (init?.headers ?? {}) as Record<string,string>});
    return new Response(JSON.stringify(String(url).endsWith("/healthz") ? {selfHostId: targetId} : {ok:true}));
  }) as typeof fetch });
  return {requests, factory};
}
describe("本地持久来源", () => {
  it("不会创建缺失的数据库，也不会推断远程身份", async () => {
    expect(readLocalOrigin()).toBeUndefined(); expect(existsSync(dbPath)).toBe(false);
    const fetch = vi.fn(async () => ({ok:true,json:async()=>({selfHostId:"wrong-destination"})}));
    expect(await resolveOriginSelfHostId({fetch} as never)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
  });
  it("即使配置了不同显示名称，也读取已生成的 id", () => {
    seed("host-a1b2c3d4"); writeFileSync(join(home,"config.json"),JSON.stringify({host:{name:"new-display-name"}}));
    expect(readLocalOrigin()).toBe("host-a1b2c3d4");
  });
  it("显式 DB 配置优先于先前启动记录", () => {
    seed("configured-origin"); const previous=join(home,"old.sqlite"); seed("old-origin",previous);
    writeFileSync(join(home,"daemon.json"),JSON.stringify({db:previous})); expect(readLocalOrigin()).toBe("configured-origin");
  });
  it("不存在 DB 覆盖时保留上次启动的显式 --db", () => {
    seed("launch-origin"); vi.stubEnv("OPENRIG_DB","");
    writeFileSync(join(home,"daemon.json"),JSON.stringify({db:dbPath})); expect(readLocalOrigin()).toBe("launch-origin");
  });
  it("遵循文件中配置的 DB", () => {
    seed("file-origin"); vi.stubEnv("OPENRIG_DB","");
    writeFileSync(join(home,"config.json"),JSON.stringify({db:{path:dbPath}})); expect(readLocalOrigin()).toBe("file-origin");
  });
  it.each(["", "local", "localhost", "has@separator"])("不提升无效身份 %s", id => {
    seed(id); expect(readLocalOrigin()).toBeUndefined();
  });
  it("不可读 schema 保持未知", () => { writeFileSync(dbPath,"not sqlite"); expect(readLocalOrigin()).toBeUndefined(); });
});
describe("直连端点来源归属", () => {
  it.each(["parent-origin", undefined])("目标 %s 为远程或未经证明时携带来源", async target => {
    seed("vm-origin"); const {factory,requests}=client(target); const c=factory("http://127.0.0.1:12345");
    await c.post("/write",{}); await c.post("/again",{});
    expect(requests.filter(r=>r.url.endsWith("/healthz"))).toHaveLength(1);
    expect(requests.at(-1)?.headers["X-OpenRig-Session"]).toBe("rig-admin@ops@vm-origin");
  });
  it("已证明为本地的直连端点保留裸地址", async () => {
    seed("vm-origin"); const {factory,requests}=client("vm-origin"); await factory("http://alias:7433").post("/write",{});
    expect(requests.at(-1)?.headers["X-OpenRig-Session"]).toBe("rig-admin@ops");
  });
  it("未知来源会投递持久的不确定性标记与诊断", async () => {
    const {factory,requests}=client("parent-origin"); await factory("http://parent:7433").post("/write",{});
    expect(requests.at(-1)?.headers).toMatchObject({"X-OpenRig-Session":"rig-admin@ops","X-OpenRig-Origin-Unknown":"true"});
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("来源实例未知"));
  });
  it("普通默认本地请求无需读取或探测来源", async () => {
    vi.stubEnv("OPENRIG_URL",""); const {factory,requests}=client(); await factory("http://localhost:7433").post("/write",{});
    expect(requests).toHaveLength(1); expect(requests[0]?.headers).toMatchObject({"X-OpenRig-Session":"rig-admin@ops"});
  });
  it("本地证据不可用时，已限定的发送者仍保持不变", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME","rig-admin@ops@upstream"); const {factory,requests}=client(); await factory("http://parent:7433").post("/write",{});
    expect(requests).toHaveLength(1); expect(requests[0]?.headers["X-OpenRig-Session"]).toBe("rig-admin@ops@upstream");
  });
  it("已登记远程构造使用本地持久回退，绝不使用目标身份", async () => {
    seed("vm-origin"); const {factory,requests}=client("parent-origin"); await remoteDaemonClient(factory,"http://parent:7433").post("/write",{});
    expect(requests).toHaveLength(1); expect(requests[0]?.headers["X-OpenRig-Session"]).toBe("rig-admin@ops@vm-origin");
  });
});
