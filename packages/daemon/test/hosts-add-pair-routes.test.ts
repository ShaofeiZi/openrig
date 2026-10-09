// OPR.0.4.6.MH1 FR-5/FR-6——窄范围的具名主机添加/配对路由族
//（架构固定项 P1—P4）及后台服务 writer twin。
//
// 测试固定项：
//   P2——后台服务添加路由绝不接受密钥值（具名负向用例）。
//   P3——后台服务 writer 与 CLI addHostEntry 固定为字节完全一致（输入相同条目 →
//        输出相同 YAML 字节），并共享 reader twin 的校验（保留 id 原样公开）。
//   FR-6——pair-request 只创建一个人工审批时刻（通过随附机制路由给人工的 qitem）；
//        批准后只移交一次 bearer；拒绝/过期时不持久化任何内容。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
// 044/048 提供 summary + evidence_ref 列；没有它们时，仓库的
// persistSummary/persistEvidenceRef 会静默不操作（WF-2 fixture 的教训：迁移断言所依赖的内容）。
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { isHumanSeatSessionRef, parseSessionName } from "../src/domain/session-name.js";
import { addHostEntry as daemonAddHostEntry } from "../src/domain/hosts/hosts-registry-writer.js";
import { addHostEntry as cliAddHostEntry } from "../../cli/src/host-registry.js";
import type { HumanFragment, LoadResult } from "../src/domain/gateway/human-registry.js";
import { hostsRoutes } from "../src/routes/hosts.js";

const BEARER = "test-bearer-token-fixture";

const human = { entityId: "alex", address: "alex@external", class: "human" } as HumanFragment;
function buildApp(queueRepo: QueueRepository, bearerToken: string | null, humanRegistry: () => LoadResult = () => ({ ok: true, entities: [human] })): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, queueRepo);
    await next();
  });
  app.route("/api/hosts", hostsRoutes({ bearerToken, humanRegistry }));
  return app;
}

describe("hosts-registry writer twin——与 CLI addHostEntry 保持 P3 字节一致", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), "mh1-parity-cli-"));
    dirB = mkdtempSync(join(tmpdir(), "mh1-parity-daemon-"));
  });
  afterEach(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  const SEQUENCE: Array<Record<string, unknown>> = [
    { id: "vm-a", transport: "ssh", target: "vm-a.local", user: "admin" },
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "VPS_B_TOKEN" },
    { id: "vps-c", transport: "http", url: "http://vps-c:7433", bearer_file: "/tmp/tok", notes: "paired 2026-07-07" },
  ];

  it("输入相同条目序列 → 输出相同 YAML 字节", () => {
    const pathA = join(dirA, "hosts.yaml");
    const pathB = join(dirB, "hosts.yaml");
    for (const entry of SEQUENCE) {
      expect(cliAddHostEntry(entry, pathA).ok).toBe(true);
      expect(daemonAddHostEntry(entry, pathB).ok).toBe(true);
    }
    expect(readFileSync(pathB, "utf8")).toBe(readFileSync(pathA, "utf8"));
  });

  it("校验结论一致：双方均拒绝保留 id 和双 bearer，且错误文本相同", () => {
    const pathA = join(dirA, "hosts.yaml");
    const pathB = join(dirB, "hosts.yaml");
    for (const bad of [
      { id: "local", transport: "ssh", target: "a" },
      { id: "../escape", transport: "ssh", target: "a" },
      // 注意：仅有 URL 的 http 条目（无 bearer）现在有效（匿名/无 token 的后台服务）——
      // 只有同时提供两个指针才会被拒绝。
      { id: "x", transport: "http", url: "http://x", bearer_env: "T", bearer_file: "/f" },
    ]) {
      const a = cliAddHostEntry(bad, pathA);
      const b = daemonAddHostEntry(bad, pathB);
      expect(a.ok).toBe(false);
      expect(b.ok).toBe(false);
      // 错误文本嵌入各 writer 自己的注册表路径——先将其规范化；一致性固定的是校验消息，
      // 而非临时目录。
      if (!a.ok && !b.ok) expect(b.error.replaceAll(pathB, "<path>")).toBe(a.error.replaceAll(pathA, "<path>"));
    }
    expect(existsSync(pathA)).toBe(false);
    expect(existsSync(pathB)).toBe(false);
  });
});

describe("POST /api/hosts/add——窄范围的具名添加接缝", () => {
  let db: Database.Database;
  let app: Hono;
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mh1-hosts-add-"));
    savedHome = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = home;
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    app = buildApp(repo, BEARER);
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = savedHome;
  });

  const auth = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };

  it("通过 writer twin 和 CLI 可见注册表文件写入有效条目", async () => {
    const res = await app.request("/api/hosts/add", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "VPS_A_TOKEN" }),
    });
    expect(res.status).toBe(200);
    const yaml = readFileSync(join(home, "hosts.yaml"), "utf8");
    expect(yaml).toContain("vps-a");
    expect(yaml).toContain("bearer_env: VPS_A_TOKEN");
  });

  it("P2 具名负向用例：拒绝形似密钥值的字段，且不写入任何内容", async () => {
    const res = await app.request("/api/hosts/add", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "vps-a", transport: "http", url: "http://vps-a:7433", token: "s3cr3t-value" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("no_secret_values");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("保留 id 原样公开校验器错误（后台服务入口处的 FR-7）", async () => {
    const res = await app.request("/api/hosts/add", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "kernel", transport: "ssh", target: "a" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain("保留主机 id");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("写入接缝受 bearer 门禁控制（配置 token 后未携带则返回 401）", async () => {
    const res = await app.request("/api/hosts/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "vps-a", transport: "ssh", target: "a" }),
    });
    expect(res.status).toBe(401);
  });

  // rev1-r1 D：将 P1“无通用注册表写入路由”固定为负向用例——接口恰好只有 add 与
  // pair 握手；任何 remove/edit 形态的接口都不存在。
  it("R1-D：不存在通用注册表写入路由（remove/edit/PUT/DELETE 均返回 404）", async () => {
    for (const [method, url] of [
      ["POST", "/api/hosts/remove"],
      ["POST", "/api/hosts/edit"],
      ["PUT", "/api/hosts"],
      ["PUT", "/api/hosts/vps-a"],
      ["DELETE", "/api/hosts/vps-a"],
      ["PATCH", "/api/hosts/vps-a"],
    ] as const) {
      const res = await app.request(url, { method, headers: auth, body: method === "PUT" || method === "POST" || method === "PATCH" ? JSON.stringify({ id: "vps-a" }) : undefined });
      expect(res.status, `${method} ${url} must not exist`).toBe(404);
    }
  });
});

describe("pair-request——目标侧签发握手（FR-6）", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    // 真实门禁组合（startup.ts 形态）：人工席位在解析前放行——配对审批项沿用该流程。
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: (ref) => {
        if (isHumanSeatSessionRef(ref)) return true;
        return parseSessionName(ref).kind === "canonical";
      },
    });
    app = buildApp(repo, BEARER);
  });
  afterEach(() => db.close());

  async function issue(): Promise<{ pairId: string; code: string; approvalQitemId: string }> {
    const res = await app.request("/api/hosts/pair-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requester: "tester@somewhere" }),
    });
    expect(res.status).toBe(200);
    return await res.json() as { pairId: string; code: string; approvalQitemId: string };
  }

  it("无 token 的目标以 pair_target_no_bearer 明确拒绝（没有可签发内容）", async () => {
    const tokenless = buildApp(repo, null);
    const res = await tokenless.request("/api/hosts/pair-request", { method: "POST", body: "{}" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("pair_target_no_bearer");
  });

  it("人工目标缺失或有歧义时在创建审批前拒绝；显式选择可消除歧义", async () => {
    for (const entities of [[], [human, { ...human, entityId: "blair", address: "blair@external" }]]) {
      const target = buildApp(repo, BEARER, () => ({ ok: true, entities }));
      const response = await target.request("/api/hosts/pair-request", { method: "POST", body: "{}" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "pair_human_required" });
      expect(repo.list({ limit: 100 })).toHaveLength(0);
    }
    const target = buildApp(repo, BEARER, () => ({ ok: true, entities: [human, { ...human, entityId: "blair", address: "blair@external" }] }));
    const response = await target.request("/api/hosts/pair-request", { method: "POST", body: JSON.stringify({ human: "blair@external" }) });
    expect(response.status).toBe(200);
    expect(repo.list({ limit: 100 })[0]?.destinationSession).toBe("blair@external");
  });

  it("签发只创建一个人工审批时刻：包含 code、summary 与 evidence_ref 的人工路由 qitem", async () => {
    const { code, approvalQitemId } = await issue();
    const item = repo.getById(approvalQitemId)!;
    expect(item.destinationSession).toBe("alex@external");
    expect(item.tier).toBe("human-gate");
    expect(item.summary).toContain(code);
    expect(item.evidenceRef).toContain("pair-request:");
    expect(item.state).toBe("pending");
  });

  it("批准（close done）→ approved 与 bearer token，仅可获取一次；随后配对失效", async () => {
    const { pairId, approvalQitemId } = await issue();

    const pending = await app.request(`/api/hosts/pair-request/${pairId}`);
    expect(((await pending.json()) as { status: string }).status).toBe("pending");

    await repo.update({ qitemId: approvalQitemId, actorSession: "alex@external", state: "done", closureReason: "no-follow-on" });

    const approved = await app.request(`/api/hosts/pair-request/${pairId}`);
    const body = await approved.json() as { status: string; token: string };
    expect(body.status).toBe("approved");
    expect(body.token).toBe(BEARER);

    const second = await app.request(`/api/hosts/pair-request/${pairId}`);
    expect(second.status).toBe(404);
  });

  it("拒绝 → 状态为 denied，配对失效（没有可移交内容）", async () => {
    const { pairId, approvalQitemId } = await issue();
    await repo.update({ qitemId: approvalQitemId, actorSession: "alex@external", state: "denied" });
    const res = await app.request(`/api/hosts/pair-request/${pairId}`);
    expect(((await res.json()) as { status: string }).status).toBe("denied");
    const second = await app.request(`/api/hosts/pair-request/${pairId}`);
    expect(second.status).toBe(404);
  });
});

describe("本地 pair-client 接缝——POST /pair + GET /pair/:id（浏览器写入接缝，B1）", () => {
  let db: Database.Database;
  let app: Hono;
  let home: string;
  let savedHome: string | undefined;
  let target: http.Server;
  let targetPort: number;
  let targetState: { status: string; token?: string };
  let targetRequests: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "mh1-pair-client-"));
    savedHome = process.env["OPENRIG_HOME"];
    process.env["OPENRIG_HOME"] = home;
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    app = buildApp(new QueueRepository(db, new EventBus(db), { validateRig: () => true }), BEARER);

    targetState = { status: "pending" };
    targetRequests = 0;
    target = http.createServer((req, res) => {
      targetRequests += 1;
      if (req.method === "POST" && req.url === "/api/hosts/pair-request") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pairId: "remote-pair-1", code: "123456", approvalQitemId: "qitem-x" }));
      } else if (req.method === "GET" && req.url === "/api/hosts/pair-request/remote-pair-1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(targetState));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => target.listen(0, resolve));
    targetPort = (target.address() as { port: number }).port;
  });
  afterEach(() => {
    db.close();
    target.close();
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = savedHome;
  });

  const auth = { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" };

  it("批准流程：token 文件以 0600 落盘，并通过 writer twin 写入注册表条目", async () => {
    const started = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "vps-paired" }),
    });
    expect(started.status).toBe(200);
    const { pairId, code } = await started.json() as { pairId: string; code: string };
    expect(code).toBe("123456");

    targetState = { status: "approved", token: "remote-bearer-value" };
    const done = await app.request(`/api/hosts/pair/${pairId}`, { headers: auth });
    const body = await done.json() as { status: string; entry: { id: string } };
    expect(body.status).toBe("approved");
    expect(body.entry.id).toBe("vps-paired");

    const tokenPath = join(home, "secrets", "host-vps-paired.token");
    expect(readFileSync(tokenPath, "utf8")).toBe("remote-bearer-value\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const yaml = readFileSync(join(home, "hosts.yaml"), "utf8");
    expect(yaml).toContain("vps-paired");
    expect(yaml).toContain(`bearer_file: ${tokenPath}`);
    expect(yaml).not.toContain("remote-bearer-value");
  });

  it("拒绝流程：不持久化任何内容（无 token 文件、无注册表条目）", async () => {
    const started = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}` }),
    });
    const { pairId } = await started.json() as { pairId: string };

    targetState = { status: "denied" };
    const done = await app.request(`/api/hosts/pair/${pairId}`, { headers: auth });
    expect(((await done.json()) as { status: string }).status).toBe("denied");
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
    expect(existsSync(join(home, "secrets"))).toBe(false);
  });

  // B1 回修（guard 代码审查，2026-07-07）：失败的配对绝不能覆盖或删除已有凭证/注册表
  // 状态，并且必须在联系目标前失败。
  it("B1：重复 id 的再次配对在预检失败——保留注册表字节、token 内容与 0600 模式；绝不联系目标", async () => {
    const secretsDir = join(home, "secrets");
    const tokenPath = join(secretsDir, "host-vps-paired.token");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "live-credential\n", { mode: 0o600 });
    expect(daemonAddHostEntry({ id: "vps-paired", transport: "http", url: "http://old-target:7433", bearer_file: tokenPath }).ok).toBe(true);
    const yamlBefore = readFileSync(join(home, "hosts.yaml"), "utf8");

    const res = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "vps-paired" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_host_entry");
    expect(body.message).toContain("重复的主机 id");

    expect(targetRequests).toBe(0);
    expect(readFileSync(join(home, "hosts.yaml"), "utf8")).toBe(yamlBefore);
    expect(readFileSync(tokenPath, "utf8")).toBe("live-credential\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("B1：派生路径已有 token 文件时，在联系目标前拒绝配对——文件保持不变", async () => {
    const secretsDir = join(home, "secrets");
    const tokenPath = join(secretsDir, "host-127-0-0-1.token");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "stale-but-not-ours-to-delete\n", { mode: 0o600 });

    const res = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}` }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("pair_token_path_exists");

    expect(targetRequests).toBe(0);
    expect(readFileSync(tokenPath, "utf8")).toBe("stale-but-not-ours-to-delete\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  // rev1-r2 B1：包含路径的 id 在注册表入口预检时即失败。
  it("rev1-r2 B1：POST /pair 预检拒绝包含路径的 id；绝不联系目标", async () => {
    const res = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "../escape" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("invalid_host_entry");
    expect(body.message).toContain("不是有效的主机 id");
    expect(targetRequests).toBe(0);
    expect(existsSync(join(home, "secrets"))).toBe(false);
  });

  // rev1-r2 B3：独占创建（"wx"）——审批等待期间出现 token 文件时拒绝，绝不覆盖或删除。
  it("rev1-r2 B3：审批等待期间出现 token 文件 → 409，并保留胜出方内容", async () => {
    const started = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "vps-mid" }),
    });
    const { pairId } = await started.json() as { pairId: string };

    const tokenPath = join(home, "secrets", "host-vps-mid.token");
    mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "winner-credential\n", { mode: 0o600 });

    targetState = { status: "approved", token: "issued-bearer" };
    const done = await app.request(`/api/hosts/pair/${pairId}`, { headers: auth });
    expect(done.status).toBe(409);
    expect(((await done.json()) as { error: string }).error).toBe("pair_token_path_exists");
    expect(readFileSync(tokenPath, "utf8")).toBe("winner-credential\n");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, "hosts.yaml"))).toBe(false);
  });

  it("B1：批准后添加失败（预检/添加竞态）时，只删除本次配对创建的 token；竞态条目保留", async () => {
    const started = await app.request("/api/hosts/pair", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ url: `127.0.0.1:${targetPort}`, id: "vps-race" }),
    });
    expect(started.status).toBe(200);
    const { pairId } = await started.json() as { pairId: string };

    // 预检无法封闭 TOCTOU 窗口：审批等待期间写入冲突条目。addHostEntry 仍是权威来源。
    expect(daemonAddHostEntry({ id: "vps-race", transport: "http", url: "http://racer:7433", bearer_env: "RACER_TOKEN" }).ok).toBe(true);
    const yamlBefore = readFileSync(join(home, "hosts.yaml"), "utf8");

    targetState = { status: "approved", token: "issued-bearer" };
    const done = await app.request(`/api/hosts/pair/${pairId}`, { headers: auth });
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toBe("invalid_host_entry");

    expect(readFileSync(join(home, "hosts.yaml"), "utf8")).toBe(yamlBefore);
    expect(existsSync(join(home, "secrets", "host-vps-race.token"))).toBe(false);
  });
});
