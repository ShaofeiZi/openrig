// OPR.0.4.6.MH1 FR-5/FR-6——窄命名 host add/pair 路由族
// （arch B1 裁定，pin P1：仅 host add + pair 握手——不存在通用 registry 写路由，
// remove/edit 不在范围内；后台服务 reader 模块永久只读）。
//
// 表面映射：
//   POST /api/hosts/pair-request      TARGET 侧，OPEN（pre-token
//                                     引导——按定义 pairing 客户端尚无 bearer）。
//                                     生成 pairing code + 唯一一次人工批准时刻
//                                     （arch Ruling 2：人工路由的队列项——已交付的
//                                     human-gate 机制本身就是批准表面）。
//   GET  /api/hosts/pair-request/:id  TARGET 侧，OPEN。轮询批准项；
//                                     批准时一次性交出 bearer（单次，随后 pairing 失效）。
//   POST /api/hosts/add               LOCAL 侧，WRITE（像其他后台服务写一样 bearer 门控）。
//                                     控制台的手动 add 接缝——委托给 parity 锁定的
//                                     writer 孪生（P3）；绝不接受 secret VALUE（P2）。
//   POST /api/hosts/pair              LOCAL 侧，WRITE。浏览器的 pair-client 接缝
//                                     （B1：UI 的写接缝就是它自己的本地后台服务）。
//   GET  /api/hosts/pair/:id          LOCAL 侧，WRITE 族。对目标的无状态透传轮询；
//                                     批准时经 writer 孪生持久化 token 文件 + registry 条目。
//
// 拒绝/超时不持久化任何东西：pairing 状态是内存 map（后台服务重启即杀掉 pending pair），
// registry 写失败时 token 文件被删除，批准项直接过期。

import { Hono } from "hono";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, randomInt } from "node:crypto";
import { connect } from "node:net";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { getOpenRigHome } from "../openrig-compat.js";
import { addHostEntry } from "../domain/hosts/hosts-registry-writer.js";
import { defaultHostRegistryPath, loadHostRegistry, validateHostRegistry, type HostEntry } from "../domain/hosts/hosts-registry-reader.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import { existsSync } from "node:fs";
import { loadHumanRegistry, type LoadResult } from "../domain/gateway/human-registry.js";

const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_HTTP_TIMEOUT_MS = 10_000;

const PAIR_SOURCE_SESSION = "host-pair@kernel";

interface IssuedPair {
  code: string;
  qitemId: string;
  requester: string;
  createdAt: number;
}

interface ClientPair {
  url: string;
  remotePairId: string;
  code: string;
  hostId: string;
  createdAt: number;
}

// P2——hosts.yaml 只携带 bearer 指针；add body 上任何 secret 值形状的字段
// 在任何写入之前被响亮拒绝。
const SECRET_SHAPED_FIELDS = ["bearer_value", "bearer_token", "token", "secret", "password"];

function deriveHostId(url: URL): string {
  const raw = url.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/\./g, "-");
  return raw.replace(/^-+|-+$/g, "") || "paired-host";
}

export function hostsRoutes(opts?: { bearerToken?: string | null; humanRegistry?: () => LoadResult }): Hono {
  const router = new Hono();
  const bearerToken = opts?.bearerToken ?? null;
  const issued = new Map<string, IssuedPair>();
  const clientPairs = new Map<string, ClientPair>();

  // 写的门控与 mission-control 写完全一致：配置了 bearer 时强制，
  // 在 loopback/tailnet-trust 后台服务上放行。
  const requireAuth = authBearerTokenMiddleware({ expectedToken: bearerToken });
  router.use("/add", requireAuth);
  router.use("/pair", requireAuth);
  router.use("/pair/:pairId", requireAuth);

  function getRepo(c: { get: (key: string) => unknown }): QueueRepository {
    return c.get("queueRepo" as never) as QueueRepository;
  }

  // ---------------------------------------------------------------------
  // 供控制台 host-config 组件使用的纯指针读（FR-5）。
  // 不是写表面（P1 的上限是写族）；行镜像 CLI `zrig host ls --json` 的附加形状：
  // 条目字段（按构造为 bearer 指针）+ `selected` + 有界粗粒度 `status`。
  // ---------------------------------------------------------------------

  function probeHost(host: HostEntry, timeoutMs = 1500): Promise<"reachable" | "unreachable" | "unknown"> {
    try {
      let target: string;
      let port: number;
      if (host.transport === "ssh") {
        target = host.target;
        port = 22;
      } else {
        const u = new URL(host.url);
        target = u.hostname;
        port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
      }
      return new Promise((resolve) => {
        const sock = connect({ host: target, port, timeout: timeoutMs });
        sock.on("connect", () => { sock.destroy(); resolve("reachable"); });
        sock.on("timeout", () => { sock.destroy(); resolve("unreachable"); });
        sock.on("error", () => { sock.destroy(); resolve("unreachable"); });
      });
    } catch {
      return Promise.resolve("unknown");
    }
  }

  router.get("/", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    const selected = (store?.resolveOne("host.selected").value as string | undefined) ?? "local";
    const ownName = (store?.resolveOne("host.name").value as string | undefined) ?? "localhost";
    const registryPath = defaultHostRegistryPath();
    if (!existsSync(registryPath)) {
      return c.json({ ownName, selected, hosts: [] });
    }
    const loaded = loadHostRegistry(registryPath);
    if (!loaded.ok) {
      return c.json({ error: "invalid_registry", message: loaded.error }, 500);
    }
    const statuses = await Promise.all(loaded.registry.hosts.map((h) => probeHost(h)));
    return c.json({
      ownName,
      selected,
      hosts: loaded.registry.hosts.map((h, i) => ({ ...h, selected: h.id === selected, status: statuses[i] })),
    });
  });

  // ---------------------------------------------------------------------
  // 目标侧：签发。
  // ---------------------------------------------------------------------

  router.post("/pair-request", async (c) => {
    if (!bearerToken) {
      // 无 token 的后台服务无可发放之物。响亮 + 结构化；指明修复方式
      // （不静默成功，不发放 token 的机制——单静态 bearer 模型就是已交付的鉴权表面）。
      return c.json({
        error: "pair_target_no_bearer",
        message: "本后台服务未运行 OPENRIG_AUTH_BEARER_TOKEN；pairing 没有可发放的凭证。请在目标后台服务上设置 OPENRIG_AUTH_BEARER_TOKEN 后重试。",
      }, 409);
    }
    const body = (await c.req.json<{ requester?: string; human?: string }>().catch(() => ({}))) as { requester?: string; human?: string };
    const registry = (opts?.humanRegistry ?? loadHumanRegistry)();
    if (!registry.ok) return c.json({ error: "pair_human_registry_unavailable", message: registry.error }, 409);
    const humans = body.human ? registry.entities.filter((human) => human.address === body.human) : registry.entities;
    if (humans.length !== 1) return c.json({
      error: "pair_human_required", addresses: registry.entities.map((human) => human.address),
      message: "pair 批准需要一名已登记的人工。查看 zrig gateway human list --json；存在多名时用 --human <entityId>@external 选择。未创建任何批准行。",
    }, 409);
    const requester = (body.requester ?? "").trim() || "未知请求方";
    const pairId = randomUUID();
    const code = String(randomInt(100000, 1000000));

    let qitemId: string;
    try {
      const item = await getRepo(c).create({
        sourceSession: PAIR_SOURCE_SESSION,
        destinationSession: humans[0]!.address,
        tier: "human-gate",
        summary: `来自 ${requester} 的主机配对请求 ${code}`,
        evidenceRef: `pair-request:${pairId}`,
        body: [
          `远程操作员（${requester}）正在请求与本主机配对。`,
          `配对码：${code}——请确认与请求方显示的码一致。`,
          `批准：zrig queue update <this-qitem-id> --state done --closure-reason no-follow-on`,
          `拒绝：zrig queue update <this-qitem-id> --state denied`,
          `批准会把本后台服务的 bearer token 交给请求方（完整 API 访问权）。`,
          `本请求在创建 ${Math.round(PAIR_TTL_MS / 60000)} 分钟后过期；过期不持久化任何内容。`,
        ].join("\n"),
      });
      qitemId = item.qitemId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "pair_approval_item_failed", message }, 500);
    }

    issued.set(pairId, { code, qitemId, requester, createdAt: Date.now() });
    return c.json({ pairId, code, approvalQitemId: qitemId });
  });

  router.get("/pair-request/:pairId", (c) => {
    const pairId = c.req.param("pairId");
    const rec = issued.get(pairId);
    if (!rec) return c.json({ error: "pair_unknown", message: "配对请求未知或已被消费" }, 404);

    if (Date.now() - rec.createdAt > PAIR_TTL_MS) {
      issued.delete(pairId);
      return c.json({ status: "expired" });
    }
    const item = getRepo(c).getById(rec.qitemId);
    const state = item?.state ?? "pending";
    if (state === "done") {
      // 单次交出：第一次批准读取即消耗该 pairing。
      issued.delete(pairId);
      return c.json({ status: "approved", token: bearerToken });
    }
    if (state === "denied" || state === "canceled" || state === "failed") {
      issued.delete(pairId);
      return c.json({ status: "denied" });
    }
    return c.json({ status: "pending", code: rec.code });
  });

  // ---------------------------------------------------------------------
  // LOCAL 侧：控制台的 add + pair-client 接缝。
  // ---------------------------------------------------------------------

  router.post("/add", async (c) => {
    const body = (await c.req.json<Record<string, unknown>>().catch(() => null));
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_host_entry", message: "body 必须是 host 条目对象" }, 400);
    }
    const secretField = SECRET_SHAPED_FIELDS.find((f) => f in body);
    if (secretField) {
      return c.json({
        error: "no_secret_values",
        message: `字段 '${secretField}' 看起来是 secret VALUE——hosts.yaml 只携带 bearer 指针（bearer_env / bearer_file）。未写入任何内容。`,
      }, 400);
    }
    const res = addHostEntry(body);
    if (!res.ok) {
      return c.json({ error: "invalid_host_entry", message: res.error }, 400);
    }
    return c.json({ ok: true, entry: res.entry, path: res.path });
  });

  router.post("/pair", async (c) => {
    const body = (await c.req.json<{ url?: string; id?: string; requester?: string; human?: string }>().catch(() => ({}))) as { url?: string; id?: string; requester?: string; human?: string };
    const rawUrl = (body.url ?? "").trim();
    if (!rawUrl) return c.json({ error: "pair_url_required", message: "body.url 为必填项（目标后台服务的地址）" }, 400);
    let target: URL;
    try {
      target = new URL(/^https?:\/\//.test(rawUrl) ? rawUrl : `http://${rawUrl}`);
    } catch {
      return c.json({ error: "pair_url_invalid", message: `'${rawUrl}' 不是可用地址` }, 400);
    }
    const targetBase = target.origin;

    // B1 fixback（guard code-review 2026-07-07）：在联系目标之前做 PREFLIGHT。
    // 候选条目跑 add 将使用的同一校验契约（重复/保留 id、既有 registry 非法
    // 都在此失败——赶在目标上生成任何批准项之前），而已存在的 token 文件是既有
    // 凭证状态：拒绝，绝不被本 pairing 覆盖或删除。
    const hostId = (body.id ?? "").trim() || deriveHostId(target);
    const tokenPath = join(getOpenRigHome(), "secrets", `host-${hostId}.token`);
    {
      const registryPath = defaultHostRegistryPath();
      let existing: HostEntry[] = [];
      if (existsSync(registryPath)) {
        const loaded = loadHostRegistry(registryPath);
        if (!loaded.ok) {
          return c.json({ error: "invalid_registry", message: loaded.error }, 400);
        }
        existing = loaded.registry.hosts;
      }
      const preflight = validateHostRegistry(
        { hosts: [...existing, { id: hostId, transport: "http", url: targetBase, bearer_file: tokenPath }] },
        registryPath,
      );
      if (!preflight.ok) {
        return c.json({ error: "invalid_host_entry", message: preflight.error }, 400);
      }
      if (existsSync(tokenPath)) {
        return c.json({
          error: "pair_token_path_exists",
          message: `${tokenPath} 已存在凭证文件——既有凭证状态绝不被覆盖。请用不同 id 配对，或若该文件已过期则删除它。`,
        }, 409);
      }
    }

    let remote: { pairId?: string; code?: string; error?: string; message?: string };
    let status: number;
    try {
      const res = await fetch(`${targetBase}/api/hosts/pair-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requester: body.requester ?? `dashboard@${getOpenRigHome()}`, ...(body.human ? { human: body.human } : {}) }),
        signal: AbortSignal.timeout(PAIR_HTTP_TIMEOUT_MS),
      });
      status = res.status;
      remote = (await res.json().catch(() => ({}))) as typeof remote;
    } catch (err) {
      return c.json({ error: "pair_target_unreachable", message: `无法访问 ${targetBase}：${(err as Error).message}` }, 502);
    }
    if (status !== 200 || !remote.pairId || !remote.code) {
      return c.json({
        error: remote.error ?? "pair_request_failed",
        message: remote.message ?? `目标响应 HTTP ${status}`,
      }, 502);
    }

    const localPairId = randomUUID();
    clientPairs.set(localPairId, {
      url: targetBase,
      remotePairId: remote.pairId,
      code: remote.code,
      hostId,
      createdAt: Date.now(),
    });
    return c.json({ pairId: localPairId, code: remote.code, target: targetBase });
  });

  router.get("/pair/:pairId", async (c) => {
    const rec = clientPairs.get(c.req.param("pairId"));
    if (!rec) return c.json({ error: "pair_unknown", message: "配对未知或已完成" }, 404);
    if (Date.now() - rec.createdAt > PAIR_TTL_MS) {
      clientPairs.delete(c.req.param("pairId"));
      return c.json({ status: "expired" });
    }

    let remote: { status?: string; token?: string };
    try {
      const res = await fetch(`${rec.url}/api/hosts/pair-request/${rec.remotePairId}`, {
        signal: AbortSignal.timeout(PAIR_HTTP_TIMEOUT_MS),
      });
      remote = (await res.json().catch(() => ({}))) as typeof remote;
    } catch (err) {
      return c.json({ error: "pair_target_unreachable", message: `无法访问 ${rec.url}：${(err as Error).message}` }, 502);
    }

    if (remote.status === "pending" || remote.status === undefined) {
      return c.json({ status: "pending", code: rec.code });
    }
    if (remote.status !== "approved" || !remote.token) {
      clientPairs.delete(c.req.param("pairId"));
      return c.json({ status: remote.status === "expired" ? "expired" : "denied" });
    }

    // 已批准：以排他创建（open flag "wx"，0600——rev1-r2 B3：check-then-rename
    // 曾有一个窗口，并发的同 id pair 可能覆盖胜者文件并在自己 add 失败时删掉它；
    // "wx" 在文件系统层原子，因此创建成功就是清理所依赖的所有权证明）持久化 token，
    // 然后经唯一写契约写 registry 条目。addHostEntry 权威性地重新校验。
    const secretsDir = join(getOpenRigHome(), "secrets");
    const tokenPath = join(secretsDir, `host-${rec.hostId}.token`);
    try {
      mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      writeFileSync(tokenPath, `${remote.token}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        clientPairs.delete(c.req.param("pairId"));
        return c.json({
          error: "pair_token_path_exists",
          message: `配对期间 ${tokenPath} 出现凭证文件——拒绝覆盖；本 pairing 未持久化任何内容。`,
        }, 409);
      }
      return c.json({ error: "pair_token_write_failed", message: (err as Error).message }, 500);
    }
    const added = addHostEntry({
      id: rec.hostId,
      transport: "http",
      url: rec.url,
      bearer_file: tokenPath,
      notes: `paired ${new Date().toISOString().slice(0, 10)}`,
    });
    if (!added.ok) {
      rmSync(tokenPath, { force: true });
      clientPairs.delete(c.req.param("pairId"));
      return c.json({ error: "invalid_host_entry", message: added.error }, 400);
    }
    clientPairs.delete(c.req.param("pairId"));
    return c.json({ status: "approved", entry: added.entry });
  });

  return router;
}
