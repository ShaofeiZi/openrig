export interface CmuxTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

export type CmuxTransportFactory = () => Promise<CmuxTransport>;

export interface CmuxStatus {
  available: boolean;
  capabilities: Record<string, boolean>;
}

export interface CmuxWorkspace {
  id: string;
  name: string;
}

export interface CmuxSurface {
  id: string;
  title: string;
  type: string;
}

export type CmuxResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

interface CmuxAdapterOptions {
  timeoutMs: number;
}

export class CmuxAdapter {
  private status: CmuxStatus = { available: false, capabilities: {} };
  protected transport: CmuxTransport | null = null;

  constructor(
    private factory: CmuxTransportFactory,
    private options: CmuxAdapterOptions
  ) {}

  async connect(): Promise<void> {
    // 清理已有 transport。
    if (this.transport) {
      try {
        this.transport.close();
      } catch {
        // 忽略关闭错误。
      }
      this.transport = null;
    }

    // 跟踪瞬态 transport，以便 factory 成功后 connect 失败（如 capabilities 卡住或抛错）时清理。
    // 使用对象包装，因为 TS 控制流不会跟踪异步闭包中对普通 let 绑定的修改。
    const holder: { transport: CmuxTransport | null } = { transport: null };

    try {
      const { transport, capabilities } = await withTimeout(
        (async () => {
          holder.transport = await this.factory();

          const result = await holder.transport.request("capabilities");
          const caps = normalizeCapabilities(result);
          await holder.transport.request("workspace.current");

          return { transport: holder.transport, capabilities: caps };
        })(),
        this.options.timeoutMs
      );

      this.transport = transport;
      this.status = { available: true, capabilities };
    } catch {
      // factory 成功但后续失败时清理瞬态 transport。
      if (holder.transport) {
        try {
          holder.transport.close();
        } catch {
          // 忽略关闭错误。
        }
      }
      this.transport = null;
      this.status = { available: false, capabilities: {} };
    }
  }

  getStatus(): CmuxStatus {
    return this.status;
  }

  isAvailable(): boolean {
    return this.status.available;
  }

  async listWorkspaces(): Promise<CmuxResult<CmuxWorkspace[]>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const result = (await this.transport.request("workspace.list")) as {
        workspaces?: CmuxWorkspace[];
      };
      return { ok: true, data: result.workspaces ?? [] };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listSurfaces(workspaceId?: string): Promise<CmuxResult<CmuxSurface[]>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const params = workspaceId != null ? { workspaceId } : undefined;
      const result = (await this.transport.request("surface.list", params)) as {
        surfaces?: CmuxSurface[];
      };
      return { ok: true, data: result.surfaces ?? [] };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async focusSurface(surfaceId: string, workspaceId?: string): Promise<CmuxResult<void>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      await this.transport.request("surface.focus", { surfaceId, workspaceId });
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendText(surfaceId: string, text: string, workspaceId?: string): Promise<CmuxResult<void>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      await this.transport.request("surface.sendText", { surfaceId, text, workspaceId });
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async currentWorkspace(): Promise<CmuxResult<string>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const raw = (await this.transport.request("workspace.current")) as Record<string, unknown>;
      const handle = normalizeHandle("workspace", raw["workspace_id"] ?? raw["id"]);
      if (!handle) {
        return { ok: false, code: "request_failed", message: "cmux current-workspace 未返回 workspace handle" };
      }
      return { ok: true, data: handle };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async createTerminalSurface(workspaceId: string): Promise<CmuxResult<string>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const raw = (await this.transport.request("surface.create", { workspaceId, type: "terminal" })) as Record<string, unknown>;
      const handle = [
        raw["created_surface_ref"],
        raw["created_surface_id"],
        raw["surface_ref"],
        raw["surface_id"],
        raw["id"],
      ]
        .map((value) => normalizeHandle("surface", value))
        .find((value): value is string => Boolean(value));
      if (!handle) {
        return { ok: false, code: "request_failed", message: "cmux new-surface 未返回 surface handle" };
      }
      return { ok: true, data: handle };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Slice 24 布局原语——见 slice 24 脚手架前探索结果。cmux RPC 接受这些带 snake_case 参数的
  // 方法（经 `cmux rpc workspace.close` 探针验证）。新方法显式采用 snake_case；现有 camelCase
  // 调用方（sendText、focus 等）在此检查点保持不变。

  async splitSurface(
    surfaceId: string,
    direction: "left" | "right" | "up" | "down",
    workspaceId?: string,
  ): Promise<CmuxResult<string>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const params: Record<string, unknown> = {
        surface_id: surfaceId,
        direction,
      };
      if (workspaceId != null) params["workspace_id"] = workspaceId;
      const raw = (await this.transport.request("surface.split", params)) as Record<string, unknown>;
      const handle = [
        raw["created_surface_ref"],
        raw["created_surface_id"],
        raw["surface_ref"],
        raw["surface_id"],
        raw["id"],
      ]
        .map((value) => normalizeHandle("surface", value))
        .find((value): value is string => Boolean(value));
      if (!handle) {
        return { ok: false, code: "request_failed", message: "cmux surface.split 未返回 surface handle" };
      }
      return { ok: true, data: handle };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * `equalized` 回显 cmux 自身判定：true = frame 已重新均衡；false = cmux 未做更改
   *（没有可均衡内容，或 workspace 仍在稳定）。调用方必须读取它——丢弃 false 正是 VM 诊断
   * 捕获的静默 2:1:1 网格。
   */
  async equalizeSplits(workspaceId?: string): Promise<CmuxResult<{ equalized: boolean }>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const params: Record<string, unknown> = {};
      if (workspaceId != null) params["workspace_id"] = workspaceId;
      const raw = (await this.transport.request("workspace.equalize_splits", params)) as Record<string, unknown>;
      return { ok: true, data: { equalized: raw["equalized"] === true } };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async createWorkspace(name: string, cwd?: string): Promise<CmuxResult<string>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const params: Record<string, unknown> = { title: name };
      if (cwd != null) params["cwd"] = cwd;
      const raw = (await this.transport.request("workspace.create", params)) as Record<string, unknown>;
      const handle = [
        raw["workspace_ref"],
        raw["workspace_id"],
        raw["id"],
      ]
        .map((value) => normalizeHandle("workspace", value))
        .find((value): value is string => Boolean(value));
      if (!handle) {
        return { ok: false, code: "request_failed", message: "cmux workspace.create 未返回 workspace handle" };
      }
      return { ok: true, data: handle };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async closeWorkspace(workspaceId: string): Promise<CmuxResult<void>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      await this.transport.request("workspace.close", { workspace_id: workspaceId });
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listPaneSurfaces(paneId: string, workspaceId?: string): Promise<CmuxResult<CmuxSurface[]>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const params: Record<string, unknown> = { pane_id: paneId };
      if (workspaceId != null) params["workspace_id"] = workspaceId;
      const result = (await this.transport.request("pane.surfaces", params)) as {
        surfaces?: CmuxSurface[];
      };
      return { ok: true, data: result.surfaces ?? [] };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 向 cmux 查询智能体 PID（侧边栏元数据）。返回 Map<pid, { runtime, pid }>。 */
  async queryAgentPIDs(): Promise<CmuxResult<Map<number, { runtime: string; pid: number }>>> {
    if (!this.transport) {
      return { ok: false, code: "unavailable", message: "cmux 未连接" };
    }
    try {
      const result = (await this.transport.request("workspace.agentPIDs")) as {
        agents?: Array<{ pid: number; runtime: string }>;
      };
      const map = new Map<number, { runtime: string; pid: number }>();
      if (result.agents) {
        for (const agent of result.agents) {
          map.set(agent.pid, { runtime: agent.runtime, pid: agent.pid });
        }
      }
      return { ok: true, data: map };
    } catch (err) {
      return { ok: false, code: "request_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }
}

function normalizeCapabilities(raw: unknown): Record<string, boolean> {
  const caps: Record<string, boolean> = {};

  if (Array.isArray(raw)) {
    for (const cap of raw) {
      if (typeof cap === "string" && cap.trim() !== "") {
        caps[cap] = true;
      }
    }
    return caps;
  }

  if (!raw || typeof raw !== "object") {
    return caps;
  }

  const record = raw as Record<string, unknown>;
  const nested = record["capabilities"];
  if (Array.isArray(nested)) {
    for (const cap of nested) {
      if (typeof cap === "string" && cap.trim() !== "") {
        caps[cap] = true;
      }
    }
    return caps;
  }

  for (const [key, value] of Object.entries(record)) {
    if (value === false || value == null) continue;
    caps[key] = true;
  }

  return caps;
}

function normalizeHandle(kind: "workspace" | "surface", value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const refPattern = kind === "workspace" ? /(workspace:[^\s]+)/ : /(surface:[^\s]+)/;
  const refMatch = trimmed.match(refPattern);
  if (refMatch) return refMatch[1];

  const withoutOK = trimmed.replace(/^OK\s+/, "");
  const firstToken = withoutOK.split(/\s+/)[0];
  return firstToken || undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`连接在 ${ms}ms 后超时`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
