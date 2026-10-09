import type { PageRead } from "./page-read.js";
import type { ProjectSelection } from "./types.js";
// TUI 的唯一后台服务面——§4.A 端点表之上的薄类型化 fetch 包装，
// 设计上一个模块：R7 无新数据源检查是单文件读取
// （下面每条路由都是已存在的、Web 消费的后台服务读取）。
// 直接访问后台服务，绝不通过 Studio serve-shell（FR-9）。
// Phase 1 发布包装器；Phase 2 将三个分区绑定到它们。
export interface DaemonClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string> | (() => Record<string, string>);
}

export class StartupRequestError extends Error {
  constructor(readonly status: number, readonly result: Record<string, unknown>) {
    super(String(result.message ?? result.error ?? `启动请求返回 HTTP ${status}`));
  }
}

/** 一次工作组恢复尝试的轮询（后台服务的 GET 状态形状）。裁决由
 *  服务端从汇总计数派生（绝非存储字段）。 */
export interface RestoreFleetStatus {
  done: boolean;
  cancelled: boolean;
  verdict: string;
  rollup: {
    counts: { fully_restored: number; partially_restored: number; failed: number; not_attempted: number };
    sequence: Array<{ rigId: string; outcome: string; reason?: string; remediation?: string }>;
    attention_required: Array<{ rigId: string; seat: string; need: string }>;
  };
}

export interface TerminalOpenResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: Array<{ seat: string; reason: string }>;
  degraded: Array<{ seat: string; reason: string }>;
  pages: number;
  error?: string;
  code?: string;
  notes?: string[];
}

export interface LaunchNodeResult {
  ok: boolean;
  code?: string;
  launched?: Array<{ logicalId?: string }>;
  alreadyRunning?: Array<{ logicalId?: string }>;
}

export function launchNodeNotice(agent: string, result: LaunchNodeResult): string {
  return result.code === "already_running"
    ? `智能体已在运行: ${agent}`
    : `已请求运行智能体: ${agent}`;
}

export class DaemonClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private optionalFetchImpl: typeof fetch;
  private readonly headerSource: Record<string, string> | (() => Record<string, string>);

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env["OPENRIG_URL"] ?? "http://127.0.0.1:7433").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.optionalFetchImpl = this.fetchImpl;
    this.headerSource = options.headers ?? {};
  }

  forPage(page: PageRead, signal: AbortSignal): DaemonClient {
    const client = new DaemonClient({ baseUrl: this.baseUrl, headers: this.headerSource,
      fetchImpl: page.fetch(this.fetchImpl, signal) });
    client.optionalFetchImpl = page.fetch(this.fetchImpl, signal, true);
    return client;
  }

  private get headers(): Record<string, string> {
    return typeof this.headerSource === "function" ? this.headerSource() : this.headerSource;
  }

  /** S19 AM-R18——打开 oracle 的 SSE 事件流（FR-8：HTTP 保持在此模块中）。
   *  特性检测：非 OK 或非事件流应答（旧后台服务、外部
   *  服务器）返回 null——调用方永久禁用该通道，TUI 行为
   *  完全如 S16 发布的那样（点击刷新）。null 时绝不重试。 */
  async openActivityEvents(): Promise<Response | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/activity/events`, {
        headers: { ...this.headers, accept: "text/event-stream" },
      });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return null;
      return res;
    } catch {
      return null; // 打开时后台服务不可达——通道保持关闭；刷新仍可用
    }
  }

  private async get(route: string, fetchImpl = this.fetchImpl): Promise<unknown> {
    const res = await fetchImpl(`${this.baseUrl}${route}`, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`后台服务读取失败：GET ${route} → ${res.status}`);
    return res.json();
  }

  private async post(route: string, body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = parsed && typeof parsed === "object" && "error" in parsed ? ` — ${(parsed as { error: unknown }).error}` : "";
      throw new Error(`后台服务写入失败：POST ${route} → ${res.status}${detail}`);
    }
    return parsed;
  }

  /** 运行中后台服务身份。旧后台服务上 `selfHostId` 可能缺失。 */
  async configBrowser() {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/config?view=browser`, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      const reason = error instanceof Error && error.name === "TimeoutError" ? "读取 5 秒后超时。"
        : code === "ECONNREFUSED" ? "显示的后台服务目标拒绝连接。"
        : code === "ENOTFOUND" ? "显示的后台服务主机名无法解析。"
        : "读取失败；原因未识别。";
      throw new Error(reason);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} · ${res.status === 401 || res.status === 403 ? "显示的后台服务拒绝访问。"
      : res.status === 404 ? "CONFIG 浏览器端点未找到；版本兼容性未验证。"
      : "CONFIG 无法读取；原因未识别。"}`);
    const data = await res.json().catch(() => null) as Partial<import("./config/config-model.js").ConfigRead> | null;
    // 旧后台服务忽略 view 查询并返回原始设置；绝不渲染该响应。
    if (!data || data.readOnly !== true || !Array.isArray(data.entries) || !Array.isArray(data.sources) || !Array.isArray(data.exclusions)) {
      throw new Error("响应不包含 CONFIG 浏览器契约；兼容性未验证。");
    }
    return data;
  }

  humanUpdates() { return this.get("/api/queue/human-updates?limit=20"); }
  connections() { return this.get("/api/gateway/connections"); }
  slackManifest() { return this.get("/api/gateway/slack/manifest"); }

  fileRoots() { return this.get("/api/files/roots") as Promise<{ roots: import("./reading.js").FileRoot[]; hint?: string }>; }

  async readFile(target: import("./reading.js").FileTarget): Promise<import("./reading.js").FileReadResult> {
    if (!target.root) return { error: "root_unknown", message: "源在配置的可读根之外。未搜索其他根。" };
    const query = new URLSearchParams({ root: target.root, path: target.path });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/files/read?${query}`, { headers: this.headers, signal: AbortSignal.timeout(5_000) });
      const data = await response.json() as Record<string, unknown> | null;
      if (!response.ok) return { error: String(data?.error ?? `HTTP ${response.status}`), message: String(data?.message ?? "无法读取当前文件") };
      if (!data || typeof data.content !== "string" || typeof data.absolutePath !== "string" || typeof data.mtime !== "string" || typeof data.contentHash !== "string" || typeof data.truncated !== "boolean") {
        return { error: "invalid_file_response", message: "读取器未服务当前文件内容和元数据" };
      }
      return data as unknown as import("./reading.js").FileRead;
    } catch (error) { return { error: "read_unavailable", message: error instanceof Error ? error.message : String(error) }; }
  }

  health() {
    return this.get("/healthz");
  }

  /** 有界规范发现；TUI 按工作范围过滤此单记录集。 */
  healthFindings(limit = 200) {
    return this.get(`/api/health?limit=${limit}`);
  }

  // --- 故障诊断工作组恢复（B1 指挥——TUI 拥有启动/轮询/取消
  //     生命周期，使其能保留尝试 id、从轮询流渲染进度，
  //     并到达取消端点；它不再盲目委托给缓冲子进程）---
  /** 启动异步工作组恢复；后台服务在提交时以工作组尝试句柄应答。 */
  restoreFleet(): Promise<{ fleetAttemptId: string; status: string }> {
    return this.post("/api/crash-cart/restore-fleet", {}) as Promise<{ fleetAttemptId: string; status: string }>;
  }
  /** 轮询一个工作组尝试的进度 + 汇总 + 派生裁决。 */
  restoreFleetStatus(id: string): Promise<RestoreFleetStatus> {
    return this.get(`/api/crash-cart/restore-fleet/${encodeURIComponent(id)}`) as Promise<RestoreFleetStatus>;
  }
  /** 在运行中的工作组尝试上请求下一个工作组前停止的取消。 */
  cancelRestoreFleet(id: string): Promise<{ ok: boolean; cancelled: boolean }> {
    return this.post(`/api/crash-cart/restore-fleet/${encodeURIComponent(id)}/cancel`, {}) as Promise<{
      ok: boolean;
      cancelled: boolean;
    }>;
  }

  // --- 拓扑（§4.A 行 1–3）---
  rigGraph(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/graph`);
  }
  ps() {
    return this.get(`/api/ps`);
  }
  rigsSummary() {
    return this.get(`/api/rigs/summary`);
  }
  rigNodes(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
  }
  reviewAgents(scope: "rig" | "fleet" = "rig") {
    return this.get(`/api/review/agents?scope=${scope}`);
  }

  // --- 规格（§4.A 行 4）---
  specsLibrary(kind?: string) {
    return this.get(`/api/specs/library${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`);
  }
  rigSpec(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/spec.json`);
  }
  /** 结构化规格详情（spec-library.ts /:id/review——实时路由；
   *  规格的 §4.A 引用 `GET /api/specs/review` 在 tip 返回 404，QA 发现） */
  specLibraryReview(id: string) {
    return this.get(`/api/specs/library/${encodeURIComponent(id)}/review`);
  }

  // --- Needs-You（§4.A 行 5–6）：composeNeedsYou 腿 + 主机/工作组降级旁置 ---
  /** SCOPES 视图（d64d2f5c）：store-direct 单读取水合。 */
  projects() { return this.get("/api/scopes/projects"); }
  private projectQuery(project?: ProjectSelection | null): string {
    return project ? `&project=${encodeURIComponent(project.id)}&projectRoot=${encodeURIComponent(project.root)}` : "";
  }
  scopesDetailed(project?: ProjectSelection | null) {
    return this.get(`/api/scopes?detail=1${this.projectQuery(project)}`);
  }

  /** 通过已发布通用视图路由的 EXECUTION 视图；无新端点。 */
  execution(mission?: string, project?: ProjectSelection | null) {
    const query = `${mission ? `&mission=${encodeURIComponent(mission)}` : ""}${this.projectQuery(project)}`;
    return this.get(`/api/views/execution${query ? "?" + query.slice(1) : ""}`);
  }
  /** 已存在的六标签切片负载；仅为打开的切片读取。 */
  sliceDetail(directory: string, mission?: string | null, project?: ProjectSelection | null) {
    const query = `${mission ? `&mission=${encodeURIComponent(mission)}` : ""}${this.projectQuery(project)}`;
    return this.get(`/api/slices/${encodeURIComponent(directory)}${query ? "?" + query.slice(1) : ""}`);
  }

  /** 当前拓扑工作范围的一个有界类型化队列时序。 */
  queueRecentTransitions(scope: { kind: "instance" } | { kind: "rig"; rig: string }, limit = 20) {
    const query = scope.kind === "instance"
      ? "scope=instance"
      : `scope=rig&rig=${encodeURIComponent(scope.rig)}`;
    return this.get(`/api/queue/recent-transitions?${query}&limit=${limit}`);
  }

  queueAttention() {
    return this.get(`/api/queue/list?attention=1`);
  }
  /** 通过相同已发布 /list 路由带 ?state=blocked 的所有被阻塞 qitem
   * （queue.ts 读取 c.req.query("state") 并过滤）。queueAttention 的镜像
   *  ——现有路由上的客户端方法添加，非新端点。
   *  PULSE 渲染将这些过滤为非人类 blockedOn。 */
  queueBlocked() {
    return this.get(`/api/queue/list?state=blocked`);
  }
  /** 通过相同已发布 /list 路由带 ?state=in-progress 的所有进行中 qitem
   * （queue.ts 读取 c.req.query("state") 并过滤）。queueBlocked 的镜像——
   *  现有路由上的客户端方法添加，非新端点。PULSE
   *  PARKED 连接仅保留空闲、未交接的所有者。 */
  queueInProgress() {
    return this.get(`/api/queue/list?state=in-progress`);
  }
  /** 通过相同已发布 /list 路由带
   *  ?state=pending（UP NEXT 积压）的所有未认领待处理 qitem。queueInProgress 的镜像——
   *  现有路由上的客户端方法添加，非新端点。后台服务
   *  以 ts_created DESC 服务；PULSE 渲染仅保留未认领 + 限制显示。
   *  有界使巨大积压无法无界帧。 */
  queuePending(limit = 50) {
    return this.get(`/api/queue/list?state=pending&limit=${limit}`);
  }
  /** 最近终端转换（刚完成）通过相同已发布 /list
   *  路由带逗号多状态 ?state=done,handed-off（queue.ts 在 "," 上拆分
   *  stateRaw）。无全组完成时间转换端点，因此
   *  这是以 ts_created 顺序获取的有界最近窗口；PULSE 渲染
   *  以 tsUpdated DESC（完成时间）重新排序为最新优先。非新端点。 */
  queueRecentlyFinished(limit = 20) {
    return this.get(`/api/queue/list?state=done,handed-off&limit=${limit}`);
  }
  /** 通过已发布 GET /api/queue/:qitemId 的单个 qitem（queue.ts:864，
   *  返回 QueueItem 或 404）。用于被阻塞智能体行的有界
   *  查找：blockedOn 是 qitem 指针，因此阻塞智能体是该 qitem 的
   *  所有者（destinationSession）。非新端点。 */
  humanAttention(item?: string | null) {
    return this.get(`/api/attention${item ? `?item=${encodeURIComponent(item)}` : ""}`);
  }
  queueItem(qitemId: string, options: { optional?: boolean } = {}) {
    return this.get(`/api/queue/${encodeURIComponent(qitemId)}`, options.optional ? this.optionalFetchImpl : this.fetchImpl);
  }
  reviewRig() {
    return this.get(`/api/review/rig`);
  }
  reviewFleet() {
    return this.get(`/api/review/fleet`);
  }
  attentionAggregate() {
    return this.get(`/api/queue/attention-aggregate`);
  }
  rigStatus(rigId: string) {
    return this.get(`/api/rigs/${encodeURIComponent(rigId)}/status`);
  }

  // --- 工作组流页脚（§4.A 行 7：工作组流读取面）---
  /** 遗留时序页面契约，为附加 API 兼容性保留 */
  streamList(limit = 100, afterSortKey?: string) {
    return this.get(`/api/stream/list?limit=${limit}${afterSortKey ? `&afterSortKey=${encodeURIComponent(afterSortKey)}` : ""}`);
  }
  /** 维护的活动流的最新有界页面，返回旧→新 */
  streamLatest(limit = 5) {
    return this.get(`/api/stream/list?limit=${limit}&direction=latest`);
  }

  // --- drive-structure 写入（BR-8：仅现有契约；唯一两个）---
  /** Web 的 TerminalLauncher 契约：POST /api/terminal/open {view} */
  async terminalViews(): Promise<{ saved: Array<{ id: string; name: string; members: Array<{ seat: string }> }>; rigs: string[] }> {
    return await this.get("/api/terminal/views") as { saved: Array<{ id: string; name: string; members: Array<{ seat: string }> }>; rigs: string[] };
  }
  async previewTerminal(view: string): Promise<import("./terminals/terminal-model.js").TerminalPreview> {
    return await this.get(`/api/terminal/preview?view=${encodeURIComponent(view)}`) as import("./terminals/terminal-model.js").TerminalPreview;
  }
  async openTerminal(view: string, expectedPlan?: string): Promise<TerminalOpenResult> {
    const result = (await this.post(`/api/terminal/open`, { view, ...(expectedPlan !== undefined ? { expectedPlan } : {}) })) as TerminalOpenResult;
    if (!Array.isArray(result.opened) || result.opened.length === 0) {
      throw new Error(`终端打开失败：${result.error ?? result.code ?? ([...new Set(result.degraded?.map(m => m.reason))].join("; ") || "未打开任何磁贴")}`);
    }
    return result;
  }
  /** `rig launch` 的每席位契约 */
  async launchNode(rigId: string, logicalId: string): Promise<LaunchNodeResult> {
    return (await this.post(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(logicalId)}/launch`, {})) as LaunchNodeResult;
  }

  async startupRequest<T>(route: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/startup${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body === undefined ? 15_000 : 120_000),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok || result.ok === false) throw new StartupRequestError(response.status, result);
    return result as T;
  }
}
