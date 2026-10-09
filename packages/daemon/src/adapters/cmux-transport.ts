import type { CmuxTransport, CmuxTransportFactory } from "./cmux.js";
import type { ExecFn } from "./tmux.js";

/** 使用单引号为字符串添加 shell 引号（POSIX 安全）。 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * 携带稳定 `code` 判别项和可选 `method` 的 Error 子类，使更广的 adapter/route 层能区分
 * surface 级不可用与请求执行失败，同时保持在仅 adapter 的补丁边界内。`code: "unavailable"`
 * 词汇镜像现有 CmuxAdapter 结果判别项（见 `adapters/cmux.ts`）。
 */
class CmuxSurfaceError extends Error {
  readonly code: string;
  readonly method: string;

  constructor(method: string, message: string) {
    super(message);
    this.code = "unavailable";
    this.method = method;
    this.name = "CmuxSurfaceError";
  }
}

/**
 * 将 `cmux --help` 的子命令块解析为可用顶层命令名集合。cmux 帮助格式把每个命令放在缩进
 * 两个空格的一行中，例如：
 *
 *   Commands:
 *     list-panels [--workspace <id|ref>]
 *     focus-panel --panel <id|ref>
 *
 * 宽松处理：若帮助输出因任何原因无法解析，则集合为空，下游版本自适应分发会把相关 surface
 * 视为不受支持；这是诚实的结果。
 */
function parseCmuxCommands(help: string): Set<string> {
  const commands = new Set<string>();
  for (const rawLine of help.split("\n")) {
    const match = rawLine.match(/^\s{2,}([a-z][a-z0-9-]+)/);
    if (match && match[1]) commands.add(match[1]);
  }
  return commands;
}

interface BuildContext {
  supported: Set<string>;
}

interface BuildResult {
  cmd: string;
  json: boolean;
}

function buildCommand(
  method: string,
  params: Record<string, unknown> | undefined,
  ctx: BuildContext
): BuildResult {
  // --- 稳定命令（所有受支持 cmux 版本均提供）---
  if (method === "capabilities") {
    return { cmd: "cmux capabilities --json", json: true };
  }
  if (method === "workspace.list") {
    if (ctx.supported.has("rpc")) {
      return { cmd: "cmux rpc workspace.list", json: true };
    }
    return { cmd: "cmux list-workspaces --json", json: true };
  }
  if (method === "workspace.current") {
    return { cmd: "cmux current-workspace --json", json: true };
  }

  // --- 版本自适应：surface 列表 ---
  // cmux ≥0.63 提供 `list-panels`；旧版 cmux 提供 `list-surfaces`。架构方向：优先新 surface，
  // 保留 legacy 回退，绝不通过固定版本排除新版 cmux。两种结构都规范化为下游
  // `CmuxAdapter.listSurfaces` 期望的 `{surfaces: [...]}` payload（见 `adapters/cmux.ts:110-123`）。
  if (method === "surface.list") {
    const workspaceArg = params?.workspaceId
      ? ` --workspace ${shellQuote(String(params.workspaceId))}`
      : "";
    if (ctx.supported.has("list-panels")) {
      return { cmd: `cmux list-panels${workspaceArg} --json`, json: true };
    }
    if (ctx.supported.has("list-surfaces")) {
      return { cmd: `cmux list-surfaces${workspaceArg} --json`, json: true };
    }
    throw new CmuxSurfaceError(
      method,
      "cmux 未提供 surface 列表命令（既没有 `list-panels`，也没有 `list-surfaces`）"
    );
  }

  // --- 版本自适应：枚举智能体 PID ---
  // `cmux agent-pids` 在 0.63.x 中移除且无替代项。诚实检测：legacy 命令缺失时明确拒绝，
  // 而不是调用后让 cmux 输出 "Unknown command"。
  if (method === "workspace.agentPIDs") {
    if (ctx.supported.has("agent-pids")) {
      return { cmd: "cmux agent-pids --json", json: true };
    }
    throw new CmuxSurfaceError(
      method,
      "cmux 未提供 `agent-pids`（已在 cmux 0.63.x 中移除，且无等效 surface）"
    );
  }

  // --- 稳定的参数化命令 ---
  if (method === "surface.create" && params?.workspaceId) {
    return {
      cmd: `cmux new-surface --type ${shellQuote(String(params.type ?? "terminal"))} --workspace ${shellQuote(String(params.workspaceId))} --json`,
      json: true,
    };
  }

  if (method === "surface.focus" && params?.surfaceId) {
    const workspaceArg = params.workspaceId
      ? ` --workspace ${shellQuote(String(params.workspaceId))}`
      : "";
    return {
      cmd: `cmux focus-panel --panel ${shellQuote(String(params.surfaceId))}${workspaceArg}`,
      json: false,
    };
  }

  if (method === "surface.sendText" && params?.surfaceId && params?.text != null) {
    const workspaceArg = params.workspaceId
      ? ` --workspace ${shellQuote(String(params.workspaceId))}`
      : "";
    return {
      cmd: `cmux send --surface ${shellQuote(String(params.surfaceId))}${workspaceArg} ${shellQuote(String(params.text))}`,
      json: false,
    };
  }

  // Slice 24——布局方法的通用 RPC 透传（splitSurface、createWorkspace、closeWorkspace、
  // listPaneSurfaces；OPR.0.4.7.1 新增 equalizeSplits）。cmux 提供
  // `cmux rpc <method> '<json-params>'` 子命令，直接委托给后台服务 RPC。探索验证了这些方法
  // 接受 snake_case 参数（adapter 传入时已经是 snake_case）。对与 RPC 一一对应的方法，通用路径
  // 比逐方法 CLI 映射更简洁；上方版本自适应 buildCommand 分支则留给只有 CLI 形态的 legacy 方法。
  // 注意：method 名称未列入此 allowlist 的 adapter RPC 只会在运行时抛出 Unknown cmux method；
  // adapter 单元测试使用假 transport，无法发现遗漏（OPR.0.4.7.1 的 equalize 遗漏）。每个新
  // adapter RPC 都必须在此条目旁配套 cmux-transport 精确命令回归测试。
  if (
    method === "surface.split" ||
    method === "workspace.create" ||
    method === "workspace.close" ||
    method === "workspace.equalize_splits" ||
    method === "pane.surfaces"
  ) {
    const paramsJson = params ? JSON.stringify(params) : "";
    const cmd = paramsJson
      ? `cmux rpc ${method} ${shellQuote(paramsJson)}`
      : `cmux rpc ${method}`;
    return { cmd, json: true };
  }

  throw new Error(`未知 cmux 方法：${method}`);
}

/**
 * 规范化版本自适应命令返回的 JSON payload，使下游消费者无论由哪个 cmux 命令实际响应，
 * 都看到同一稳定结构。
 */
function normalizePayload(method: string, raw: unknown): unknown {
  if (method === "workspace.list") {
    if (raw === null || typeof raw !== "object") return raw;
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.workspaces)) return raw;
    return {
      ...obj,
      workspaces: obj.workspaces
        .map(normalizeWorkspaceRow)
        .filter((workspace): workspace is { id: string; name: string } => workspace !== null),
    };
  }

  if (method !== "surface.list") return raw;
  if (raw === null || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  // OPR.0.3.3.18：cmux 0.64.x 重命名了 surface 标识符——`list-panels` 行携带 `ref` 而没有
  // `id`（0.63.x 行携带 `id`），数组键也可能是 `panels`/`pane_surfaces`。同时解析数组键与
  // 每行 handle，归一为稳定的 `{surfaces: [{id,title,type}]}` 结构，使下游
  // `CmuxAdapter.listSurfaces`（及布局服务的 `result.data[0].id` 读取）无论 cmux 版本如何都能
  // 看到填充的 `id`。这是已应用于 `workspace.list` 行（`normalizeWorkspaceRow`）及 surface-create/
  // split handle（`adapters/cmux.ts`）的同一基于存在性的适配：一种解析顺序覆盖两个版本，而非
  // 版本协商 shim。携带 `id` 的 0.63.x 行保持不变。
  const rows =
    Array.isArray(obj.surfaces) ? obj.surfaces
    : Array.isArray(obj.panels) ? obj.panels
    : Array.isArray(obj.pane_surfaces) ? obj.pane_surfaces
    : null;
  if (rows === null) return raw;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "surfaces" || key === "panels" || key === "pane_surfaces") continue;
    rest[key] = value;
  }
  return {
    ...rest,
    surfaces: rows
      .map(normalizeSurfaceRow)
      .filter((surface): surface is { id: string; title: string; type: string } => surface !== null),
  };
}

function normalizeSurfaceRow(row: unknown): { id: string; title: string; type: string } | null {
  if (row === null || typeof row !== "object") return null;
  const obj = row as Record<string, unknown>;
  // OPR.0.3.3.18：从已安装 cmux 提供的任一 key 解析 surface handle。优先 `ref`
  //（cmux 0.64.x list-panels），其次 snake_case 变体，最后 `id`（cmux 0.63.x）；与
  // `adapters/cmux.ts` 的 create/split handle 及 `normalizeWorkspaceRow` 的 workspace 行
  // 使用相同优先级。
  const id =
    typeof obj.ref === "string" && obj.ref.trim()
      ? obj.ref.trim()
      : typeof obj.surface_ref === "string" && obj.surface_ref.trim()
        ? obj.surface_ref.trim()
        : typeof obj.surface_id === "string" && obj.surface_id.trim()
          ? obj.surface_id.trim()
          : typeof obj.id === "string" && obj.id.trim()
            ? obj.id.trim()
            : "";
  if (!id) return null;
  const title = typeof obj.title === "string" ? obj.title : "";
  const type =
    typeof obj.type === "string" && obj.type.trim() ? obj.type : "terminal";
  return { id, title, type };
}

function normalizeWorkspaceRow(row: unknown): { id: string; name: string } | null {
  if (row === null || typeof row !== "object") return null;
  const obj = row as Record<string, unknown>;
  const id =
    typeof obj.ref === "string"
      ? obj.ref
      : typeof obj.workspace_ref === "string"
        ? obj.workspace_ref
        : typeof obj.id === "string"
          ? obj.id
          : typeof obj.workspace_id === "string"
            ? obj.workspace_id
            : "";
  if (!id) return null;
  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : typeof obj.title === "string" && obj.title.trim()
        ? obj.title.trim()
        : id;
  return { id, name };
}

/**
 * 基于 CLI 的 CmuxTransportFactory。
 *
 * factory 创建时探测 `cmux --help`，发现实时 cmux 命令界面。该探针也用于检查二进制是否存在
 *（替代旧的 `cmux capabilities --json` 验证）：缺少 cmux 二进制会使 exec 抛出 ENOENT，
 * factory 将其传播给调用方。探针结果缓存在返回的 transport 实例上，每次请求都据此分发到
 * 已安装 cmux 版本的正确命令。
 */
export function createCmuxCliTransport(exec: ExecFn): CmuxTransportFactory {
  return async (): Promise<CmuxTransport> => {
    const helpOutput = await exec("cmux --help");
    const supported = parseCmuxCommands(helpOutput);

    return {
      request: async (method: string, params?: unknown): Promise<unknown> => {
        const { cmd, json } = buildCommand(
          method,
          params as Record<string, unknown> | undefined,
          { supported }
        );
        const output = await exec(cmd);

        if (json) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(output);
          } catch {
            const legacyFallback = legacyJsonFallback(method, output);
            if (legacyFallback !== null) {
              return legacyFallback;
            }
            throw new Error(
              `无法解析 cmux 命令 '${cmd}' 返回的 JSON：${output.slice(0, 200)}`
            );
          }
          return normalizePayload(method, parsed);
        }

        return {};
      },
      close: () => {
        // 基于 CLI 的 transport 没有需要关闭的持久连接。
      },
    };
  };
}

function legacyJsonFallback(method: string, output: string): unknown | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return method === "surface.list" ? { surfaces: [] } : null;
  }

  // cmux 0.61.x 对某些 --json 命令仍可能返回裸 handle。
  if (method === "workspace.current") {
    return { workspace_id: trimmed };
  }

  if (method === "surface.create") {
    const summary = trimmed.replace(/^OK\s+/, "");
    const refMatch = summary.match(/(?:^|\s)(surface:[^\s]+)/);
    if (refMatch) {
      return { created_surface_ref: refMatch[1] };
    }
    const firstToken = summary.split(/\s+/)[0];
    if (firstToken) {
      return { created_surface_ref: firstToken };
    }
    return null;
  }

  if (method === "surface.list") {
    const surfaces = parsePlainTextSurfaceRows(trimmed);
    if (surfaces) {
      return { surfaces };
    }
  }

  if (method === "workspace.list") {
    const workspaces = parsePlainTextWorkspaceRows(trimmed);
    if (workspaces) {
      return { workspaces };
    }
  }

  return null;
}

function parsePlainTextWorkspaceRows(output: string): Array<{ id: string; name: string }> | null {
  const workspaces: Array<{ id: string; name: string }> = [];

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const rowMatch = line.match(/^(?:\*\s+)?(workspace:[^\s]+)(?:\s+(.*?))?\s*$/);
    if (!rowMatch || !rowMatch[1]) {
      return null;
    }
    const rawName = (rowMatch[2] ?? "").replace(/\s+\[[^\]]+\]\s*$/g, "").trim();
    workspaces.push({
      id: rowMatch[1],
      name: rawName || rowMatch[1],
    });
  }

  return workspaces;
}

function parsePlainTextSurfaceRows(output: string): Array<{ id: string; title: string; type: string }> | null {
  const surfaces: Array<{ id: string; title: string; type: string }> = [];
  const knownSurfaceTypes = new Set(["terminal", "browser", "markdown"]);

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const rowMatch = line.match(
      /^(?:\*\s+)?(surface:[^\s]+)\s+([a-z][a-z0-9-]*)(?:\s+\[[^\]]+\])*\s*(?:"([^"]*)")?\s*$/i
    );
    if (!rowMatch || !rowMatch[1] || !rowMatch[2]) {
      return null;
    }
    const type = rowMatch[2].toLowerCase();
    if (!knownSurfaceTypes.has(type)) {
      return null;
    }

    surfaces.push({
      id: rowMatch[1],
      title: rowMatch[3] ?? "",
      type,
    });
  }

  return surfaces;
}
