// OPR.0.4.6.MH2 FR-2 + FR-7——通用单 host READ-THROUGH。
//
// 已发布 forward-then-strip 写入模式（routes/mission-control.ts remote-forward 分支）的读取镜像：
// browser 与本地后台服务保持同源；`?host=<id>` query 参数是带外 host 信封（MH-1 BR-1 边界——host
// 绝不进入 path 或 session identity）。后台服务边缘消费该信封：解析 registry，通过共享 bearer
// transport 将同一路径（去掉信封）转发到来源后台服务，并逐字返回来源响应；status、content-type、body
// 均不变（架构 P3）。来源结构继续作为规则：单 host 读取不包装 AggregatedPayload。
//
// 只读在边缘的此处强制（FR-7，架构 R2）：携带远程 host 信封的非 GET 请求，或不在下方具名
// allowlist 内的 GET，会以点明 MH-3 边界的结构化错误被拒绝，且绝不转发。UI 隐藏修改入口是必要的，
// 但不是强制手段。
//
// local 或缺失的 host 参数会在这些逻辑运行前短路到现有 handler；按构造，本地路径保持不变
//（FR-2 零回归负例）。

import type { Context, Next } from "hono";
import { getSelfHostId, resolvesToLocalHost } from "./fanout-contract.js";
import { loadHostRegistry, resolveHost } from "./hosts-registry-reader.js";
import { remoteRawRequest } from "./remote-daemon-http.js";

// 5 秒单 host READ deadline 类（与 attention-aggregator.ts 已发布的聚合读取类一致；按架构裁定，
// deadline 是 transport 必填参数，在此命名并在调用处显式传入）。
export const READ_THROUGH_TIMEOUT_MS = 5_000;

// 具名封闭 ALLOWLIST（架构 P1）。仅一个导出常量；新增项必须是有意的跨审查扩展，绝非顺手修改，
// 需要标记架构。语法：`:seg` 恰好匹配一个非空 path segment；尾部 `/*` 匹配一个或多个末尾 segment。
// v1 精确对应 MVP 读取界面（topology / project / library / dashboard-ps）。
//
// 有意排除（有记录，并非疏漏）：/api/queue/*（queue 属于 MH-3 通道，即 MH-1 的 queue 负边界，
// 当前读取也在内）；/api/files/*（本地 FS discovery；其镜像改为从按 host 定键的 slice 列表派生远程
// mission）；/api/slices/:name/proof-asset/*（二进制，而 raw transport 按设计只传文本）；
// /api/specs/library/active-lens（带写动作的本地操作员偏好，其字面 segment 无法匹配
// `:id/review` 结构）。细节（由测试固定）：slices REFRESH 写入由 METHOD 条件排除，而非 path 结构；
// `:name` 会匹配字面量 "refresh"，所以 GET 会转发，来源将其解析为名为 "refresh" 的 slice
//（来源自身的 404，逐字返回）；POST 绝不能跨越边缘。
export const READ_THROUGH_ALLOWLIST = [
  "/api/rigs/summary",
  "/api/rigs/:rigId/graph",
  "/api/rigs/:rigId/nodes",
  // OPR.0.4.6.MH2 rev1-r2 B2 + 架构裁定（qitem-…c5402960）：seat detail 是 FR-2 层级的 LEAF，
  // 与同级 /nodes 属于同一读取类。只允许严格 SEGMENT-SHAPE 匹配（架构齿）：此前缀下更深的 ACTION
  // 路由（…/:logicalId/focus、…/open-cmux）必须继续拒绝，由具名负例固定。
  "/api/rigs/:rigId/nodes/:logicalId",
  "/api/ps",
  "/api/slices",
  "/api/slices/:name",
  "/api/slices/:name/doc/*",
  "/api/missions/:missionId",
  "/api/specs/library",
  "/api/specs/library/:id/review",
] as const;

export function isReadThroughPath(path: string): boolean {
  const parts = path.split("/").filter((s) => s !== "");
  return READ_THROUGH_ALLOWLIST.some((pattern) => {
    const pat = pattern.split("/").filter((s) => s !== "");
    const tailWild = pat[pat.length - 1] === "*";
    const fixed = tailWild ? pat.slice(0, -1) : pat;
    if (tailWild ? parts.length <= fixed.length : parts.length !== fixed.length) return false;
    return fixed.every((seg, i) => (seg.startsWith(":") ? parts[i] !== "" : seg === parts[i]));
  });
}

const MH3_BOUNDARY_MESSAGE =
  "在远程 host 上执行操作属于 MH-3 路由通道；MH-2 read-through 只转发 allowlist 中的 GET 读取";

/** 参数拦截 middleware（架构 E2 裁定）。挂载在 route table 前的 /api/* 上；消费远程读取的
 * `?host=` 信封，其他内容原样透传。 */
export function hostReadThrough() {
  return async (c: Context, next: Next) => {
    const hostParam = c.req.query("host");
    // local 或缺失的 host 参数短路到现有 handler。51-09 增量 2：后台服务自身 self-host id 也解析为
    // 本机（与 'local' 哨兵拼写不同，不是重载），因此发往本机 id 的读取在本地提供，绝不向外拨号。
    if (hostParam === undefined || resolvesToLocalHost(hostParam, getSelfHostId())) {
      return next();
    }
    const hostId = hostParam;
    const path = c.req.path;

    if (c.req.method !== "GET") {
      // FR-7 条件 1：修改请求绝不跨越边缘。
      return c.json(
        { error: "cross_host_write_refused", boundary: "MH-3", hostId, method: c.req.method, path, message: MH3_BOUNDARY_MESSAGE },
        405,
      );
    }
    if (!isReadThroughPath(path)) {
      // FR-7 条件 2：具名封闭集合之外的读取也绝不跨越。
      return c.json(
        { error: "read_through_path_not_allowed", boundary: "MH-3", hostId, path, message: MH3_BOUNDARY_MESSAGE },
        403,
      );
    }

    // 架构 P2 分支 1：任何拨号前先通过 registry 验证；未知 id 是结构化错误，绝不盲目尝试网络。
    // 使用与写入镜像相同的 injected-loader 接缝（测试替换它，生产读取 registry）。
    const registryLoader =
      (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ?? loadHostRegistry;
    const fetchImpl = c.get("remoteFetchImpl" as never) as typeof fetch | undefined;
    const fail = (detail: string, failureClass: string, remoteStatus?: number) =>
      c.json({ error: "remote_read_failed", hostId, failureClass, ...(remoteStatus !== undefined ? { remoteStatus } : {}), detail }, 502);

    const reg = registryLoader();
    if (!reg.ok) return fail(reg.error, "registry");
    const resolved = resolveHost(reg.registry, hostId);
    if (!resolved.ok) return fail(resolved.error, "unknown-host");
    if (resolved.host.transport !== "http") {
      return fail(`host '${hostId}' 声明为 SSH；read-through 需要 http-transport registry 条目（url；bearer 可选）`, "unsupported-transport");
    }

    // 架构 P2 分支 2：完整剥离——转发请求不携带任何形式的 host 参数，因此来源看不到信封，转发请求
    // 在结构上无法再次转发。其他每个 query 参数原样携带（如 slices filter）。
    const url = new URL(c.req.url);
    url.searchParams.delete("host");
    const forwardPath = `${path}${url.searchParams.size > 0 ? `?${url.searchParams.toString()}` : ""}`;

    const res = await remoteRawRequest(resolved.host, forwardPath, {
      timeoutMs: READ_THROUGH_TIMEOUT_MS,
      fetchImpl,
    });
    if (res.ok) {
      // 架构 P3：来源已响应；其 status/content-type/body 就是答案，原样透传（包括自身 404/500）。
      // 下方 edge taxonomy error 只用于转发本身失败。
      return c.body(res.bodyText, res.status as never, { "Content-Type": res.contentType });
    }
    switch (res.kind) {
      case "bearer":
        return fail(res.detail, "auth-failed");
      case "timeout":
        return fail(
          res.phase === "body"
            ? `远程读取超时：响应 header 已到达（HTTP ${res.status}），但 body 始终未完成`
            : `远程读取在 ${READ_THROUGH_TIMEOUT_MS}ms 后超时`,
          "unreachable",
          res.status,
        );
      case "network":
        return fail(res.detail, "unreachable");
    }
  };
}
