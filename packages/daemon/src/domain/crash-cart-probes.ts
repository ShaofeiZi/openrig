// 故障诊断 C3——接入 resolveDaemonState（main.ts）的真实探测适配器。分类逻辑通过注入 fetch
// 做单元测试；isProcessAlive/readDaemonJson 是轻量 Node API 包装器，由真实后台服务离线运行验证。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonStateFile, HealthzProbeResult } from "./crash-cart-detect.js";

/** 从 rejection tree 收集 TERMINAL ATTEMPT，即代表真实连接尝试的叶子错误节点。Node/Undici
 *  的全局 fetch 会把被拒绝的 socket 包装成外层 `TypeError
 *  {message:"fetch failed", code:undefined}` → `cause`（单个地址），或一个 `AggregateError`，其
 *  `.errors[]` 则保存逐地址尝试。带 `cause` 或非空 `errors[]` 的节点是 WRAPPER，只递归，
 *  不计作终结尝试；两者都没有的节点才是终结尝试，可能带 `code`
 *  （ECONNREFUSED/ETIMEDOUT/…），也可能完全没有。这里保留无 code 的尝试，避免被扁平 code Set
 *  抹掉。遍历有深度上限且防循环；达到上限的节点按未解析终结尝试保守处理。 */
const MAX_WALK_DEPTH = 10; // 真实 Undici 链通常只有 2–3 层；超过此宽裕上限即视为 UNRESOLVED。

function collectTerminalAttempts(err: unknown): Array<{ code?: string; name?: string; unresolved?: boolean }> {
  const attempts: Array<{ code?: string; name?: string; unresolved?: boolean }> = [];
  const onPath = new Set<object>(); // 按对象身份检测循环；回边无法解析。
  const visit = (e: unknown, depth: number): void => {
    // 非对象 rejection（字符串、undefined 等）不是可解析终结点，应判为 unknown（非 refused）。
    if (!e || typeof e !== "object") {
      attempts.push({ unresolved: true });
      return;
    }
    const o = e as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    // CYCLE：同一对象已在当前路径中，无法完整解析，因此判为 unknown。
    if (onPath.has(o)) {
      attempts.push({ unresolved: true });
      return;
    }
    const children: unknown[] = [];
    if (o.cause) children.push(o.cause);
    if (Array.isArray(o.errors)) children.push(...(o.errors as unknown[]));
    if (children.length === 0) {
      // 完整解析的终结尝试（无 cause、无 errors）：自身 code 是真实证据。
      attempts.push({ code: typeof o.code === "string" ? o.code : undefined, name: typeof o.name === "string" ? o.name : undefined });
      return;
    }
    // WRAPPER 含子节点。深度耗尽时无法解析，记录 UNKNOWN attempt；绝不能把未解析 wrapper
    // 自身的 code 重新解释为终结证据，因为耗尽本身不是证据。
    if (depth >= MAX_WALK_DEPTH) {
      attempts.push({ unresolved: true });
      return;
    }
    onPath.add(o);
    for (const c of children) visit(c, depth + 1);
    onPath.delete(o);
  };
  visit(err, 0);
  return attempts;
}

/** 把 fetch REJECTION 分类为探测结果，采用正向谓词（guard/orch 约束）。只有同时满足以下条件
 *  才判为 DOWN/refused：(a) 至少存在一个终结尝试；(b) 每个终结尝试都可识别为
 *  ECONNREFUSED。其他情况——超时、中止、其他 code、无 code 或无法识别的失败——都属于模糊
 *  证据，保持 timeout/unverified。超时绝不能升级为确认离线，故障诊断也绝不能基于部分证据
 *  提供 RESTORE。“没有已知坏 sibling”的反向 code Set 会漏掉无 code sibling；这里用“全部都是
 *  已知好证据”的正向形式封闭整个问题族。 */
export function classifyProbeError(err: unknown): HealthzProbeResult {
  const attempts = collectTerminalAttempts(err);
  const refusedUnanimous = attempts.length > 0 && attempts.every((a) => a.code === "ECONNREFUSED");
  return refusedUnanimous ? "refused" : "timeout";
}

export interface ProbeDeps {
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  timeoutMs?: number;
}

/** 探测 `<url>`（后台服务 /healthz）：2xx → answered；非 2xx（被其他进程占用）→
 *  not-openrig；rejection 分类为 refused/timeout。使用 abort timeout 限定耗时。 */
export async function probeHealthz(url: string, deps: ProbeDeps): Promise<HealthzProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 800);
  try {
    const res = await deps.fetch(url, { signal: controller.signal });
    return res.ok ? "answered" : "not-openrig";
  } catch (e) {
    return classifyProbeError((e ?? {}) as { code?: string; name?: string });
  } finally {
    clearTimeout(timer);
  }
}

/** `pid` 对应存活进程时返回 true。`process.kill(pid, 0)` 在进程不存在时抛 ESRCH；进程存在但
 *  无权发送信号时抛 EPERM，此时仍视为存活。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 读取并解析 `$OPENRIG_HOME/daemon.json`，返回 {pid,port,host} record；文件缺失或格式错误时
 *  返回 undefined，并按“无状态文件”处理。 */
export function readDaemonJson(openrigHome: string): DaemonStateFile | undefined {
  const p = join(openrigHome, "daemon.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { pid?: unknown; port?: unknown; host?: unknown };
    if (typeof j.pid === "number" && typeof j.port === "number") {
      return { pid: j.pid, port: j.port, host: typeof j.host === "string" ? j.host : undefined };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
