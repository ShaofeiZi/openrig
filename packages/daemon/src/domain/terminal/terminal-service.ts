// OPR.0.4.6.02 C3——TerminalService 编排器。
//
// 每种视图都共用一个后台服务侧 composer（arch R1 / guard b1）：权威路由和 CLI
// 都调用这里，不存在第二条组合路径。它把视图参数解析成 composer 可用的成员，
// 组合为 provider 中立的 `ComposedView`（纯函数 `composeView` 负责 local/ssh/http/read-only
// 分区规则），再交给选定的 `TerminalProvider`。这里不添加像素逻辑，也不做 provider
// 专用分支——provider 负责绘制，composer 负责分区，本服务只负责解析和路由。
//
// 视图参数解析优先级：
//   1. `mission:<id>` / `slice:<id>` → 从 review agents 带实时派生；构造上只读
//      （跨工作组观测分组——AC-3“另一工作组的智能体……只读”），绝不持久化（A3）。
//   2. 工作组名称 → 从节点 inventory 按工作组实时派生；可交互
//      （你明确请求该工作组，因此可操作——AC-1c）。
//   3. saved-view id → 来自 `terminal-views.yaml`；逐成员只读性按操作人员保存值。
//   其他输入 → 具名 `view_not_found`，绝不静默打开空视图。
//
// 上述只读策略是基于 AC-1c/AC-3 的 v1 构建决策（可交互工作组视图 vs 只读跨工作组/
// 派生视图）；在此明确命名，供 guard/QA 门禁检查，不会被静默吸收。保存的视图携带
// 自己的逐成员 read-only，因此操作人员可以有意保存可交互的多工作组视图。
//
// 唯一共享结果形状为 `OpenViewResult { opened, absent, degraded }`（arch Q3）。
// 解析失败（找不到 view/provider）时本服务也返回此形状，因此路由 JSON 与 CLI JSON
// 对所有结果只承载一份契约。

import { composeView, type ViewMemberInput } from "./view-composer.js";
import { createHash } from "node:crypto";
import { buildGridRoot } from "./herdr-adapter.js";
// deriveViewMembers 是 views store 导出的值，不属于 composer。
import { deriveViewMembers } from "./terminal-views-store.js";
import type {
  LiveSeatRow,
  SavedView,
  SavedViewMember,
  TerminalViewsStore,
} from "./terminal-views-store.js";
import type { HostEntry } from "../hosts/hosts-registry-reader.js";
import type {
  OpenViewResult,
  ComposedView,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
} from "./terminal-provider.js";

/** v1 provider 名称集合：herdr 是 proof 门控主选，cmux 为尽力而为。 */
export type TerminalProviderName = "herdr" | "cmux";
export const DEFAULT_PROVIDER: TerminalProviderName = "herdr";

export interface OpenViewRequest {
  /** provider 名称；省略时默认为 herdr。 */
  provider?: string;
  /** 视图参数：工作组名、`mission:<id>`、`slice:<id>` 或 saved-view id。 */
  view: string;
  /** 预览指纹。成员或布局变化后必须重新预览。 */
  expectedPlan?: string;
}

export interface TerminalPreview {
  provider: string;
  view: string;
  planId: string;
  composed: ComposedView;
  /** 与 Herder 适配器消费的网格根完全相同。 */
  grids: ReturnType<typeof buildGridRoot>[];
  status: ProviderStatus;
}

/** `zrig terminal views` payload：已保存视图 + 可打开的实时工作组名称。 */
export interface ListViewsResult {
  saved: SavedView[];
  /** 可作为逐工作组派生视图打开的工作组名，实时来自 inventory。 */
  rigs: string[];
  catalog?: Array<{ view: string; name: string; kind: "saved" | "derived"; members: string[]; ready: number; absent: number; degraded: number; pages: number }>;
}

/** 某个 provider 在 `zrig terminal status` 中的一条 doctor 记录。 */
export interface ProviderStatusReport {
  name: string;
  status: ProviderStatus;
  liveness: ProviderLiveness;
}

export interface TerminalStatusResult {
  providers: ProviderStatusReport[];
}

export interface TerminalServiceDeps {
  /** 把 provider 名解析为适配器；未知名称返回 null。 */
  resolveProvider(name: string): TerminalProvider | null;
  /** saved-view 存储；本服务只使用其读取路径。 */
  viewsStore: Pick<TerminalViewsStore, "get" | "list">;
  /** 按名称获取工作组的实时席位；未知工作组为 null，已知但为空的工作组为 []。 */
  listRigSeats(rigName: string): Promise<LiveSeatRow[] | null> | LiveSeatRow[] | null;
  /** 为派生目录条目执行一次请求局部 inventory 折叠。 */
  listRigSeatsBatch?(rigNames: string[]): Promise<Map<string, LiveSeatRow[]>> | Map<string, LiveSeatRow[]>;
  /** 按工作组名或 id + pod namespace 获取其中某 pod 的实时席位；工作组或 pod 未知时为 null。 */
  listPodSeats(rigArg: string, podNamespace: string): Promise<LiveSeatRow[] | null> | LiveSeatRow[] | null;
  /** 派生 scope（`mission:<id>` 或 `slice:<id>`）的实时席位；scope 未知或无效时为 null。 */
  listScopeSeats(scope: string): Promise<LiveSeatRow[] | null> | LiveSeatRow[] | null;
  /** 已知工作组名称，供 `views` 列表使用。 */
  listRigNames(): Promise<string[]> | string[];
  /** 为 composer 提供只读主机解析；注册表不可用时所有 id 都返回 null。 */
  resolveHost(id: string): HostEntry | null;
  /** 本地存活性细化——检查本地 tmux 会话是否存在；此处不探测远程成员。 */
  hasSession(tmuxSession: string): Promise<boolean> | boolean;
}

/** 为 provider 前失败（找不到 view/provider）构造唯一共享结果形状。 */
function errorResult(provider: string, code: string, error: string): OpenViewResult {
  return { provider, ok: false, opened: [], absent: [], degraded: [], pages: 0, error, code };
}

/** 把持久化 saved-view 成员映射为 composer 输入；填充默认值，稍后细化 alive。 */
function savedMemberToInput(m: SavedViewMember): ViewMemberInput {
  return {
    seat: m.seat,
    label: m.label ?? m.seat,
    // 本地保存成员未显式指定 tmuxSession 时，回退到席位规范名（常见的本地 seat == session
    // 情况）；猜错只会让席位在组合时落入 absent[]，如实反映。
    tmuxSession: m.tmuxSession ?? m.seat,
    host: m.host ?? null,
    readOnly: m.readOnly === true,
    // 本地成员由 refineLiveness 细化；远程成员无论如何都由 composer 路由，
    // 因为 ssh 可达性不属于 has-session 的职责。
    alive: true,
  };
}

type ResolvedView = { id: string; members: ViewMemberInput[] } | { code: string; error: string };

export class TerminalService {
  constructor(private readonly deps: TerminalServiceDeps) {}

  /** 在所选 provider 中打开视图，始终返回唯一共享结果形状。 */
  async openView(req: OpenViewRequest): Promise<OpenViewResult> {
    const providerName = (req.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const provider = this.deps.resolveProvider(providerName);
    if (!provider) {
      return errorResult(
        providerName,
        "unknown_provider",
        `未知 provider '${providerName}'——应为 herdr 或 cmux`,
      );
    }

    const composed = await this.resolveComposed(req.view, provider.panesPerPage);
    if ("code" in composed) return errorResult(providerName, composed.code, composed.error);
    if (req.expectedPlan !== undefined && req.expectedPlan !== this.planId(providerName, composed)) {
      return errorResult(providerName, "preview_changed", "视图成员或布局已变化。请刷新预览后再打开；尚未启动任何内容。");
    }
    return provider.openView(composed);
  }

  private async resolveComposed(viewArg: string, panesPerPage?: number): Promise<ComposedView | { code: string; error: string }> {
    const view = (viewArg ?? "").trim();
    if (!view) return { code: "view_required", error: "必须提供视图参数" };
    const resolved = await this.resolveView(view);
    if ("code" in resolved) return resolved;
    return composeView(resolved.id, await this.refineLiveness(resolved.members), { resolveHost: (id) => this.deps.resolveHost(id), panesPerPage });
  }

  private planId(provider: string, composed: ComposedView): string {
    return createHash("sha256").update(JSON.stringify({ provider, composed, grids: composed.pages.map(buildGridRoot) })).digest("hex");
  }

  /** 被动检查：只做 inventory、本地 has-session 与 provider 探测，绝不调用 openView。 */
  async previewView(req: OpenViewRequest): Promise<TerminalPreview | OpenViewResult> {
    const providerName = (req.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const provider = this.deps.resolveProvider(providerName);
    if (!provider) return errorResult(providerName, "unknown_provider", `未知 provider '${providerName}'`);
    const composed = await this.resolveComposed(req.view, provider.panesPerPage);
    if ("code" in composed) return errorResult(providerName, composed.code, composed.error);
    return { provider: providerName, view: req.view, composed, grids: composed.pages.map(buildGridRoot), planId: this.planId(providerName, composed), status: await provider.status() };
  }

  /** 列出已保存视图，以及可作为派生视图打开的工作组名称。 */
  async listViews(detail = false): Promise<ListViewsResult> {
    const result: ListViewsResult = {
      saved: this.deps.viewsStore.list(),
      rigs: await this.deps.listRigNames(),
    };
    if (detail) {
      result.catalog = [];
      const entries = [
        ...result.saved.map((s) => ({ view: `saved:${s.id}`, name: s.name, kind: "saved" as const })),
        ...result.rigs.map((name) => ({ view: `rig:${name}`, name, kind: "derived" as const })),
      ];
      const inventory = await this.deps.listRigSeatsBatch?.(result.rigs);
      for (const entry of entries) {
        const rows = entry.kind === "derived" ? inventory?.get(entry.name) : undefined;
        const plan = rows ? composeView(entry.view, await this.refineLiveness(deriveViewMembers(rows, { readOnly: false })), { resolveHost: id => this.deps.resolveHost(id), panesPerPage: this.deps.resolveProvider(DEFAULT_PROVIDER)?.panesPerPage })
          : await this.resolveComposed(entry.view, this.deps.resolveProvider(DEFAULT_PROVIDER)?.panesPerPage);
        if ("code" in plan) continue;
        result.catalog.push({ ...entry, members: [...plan.opened, ...plan.absent, ...plan.degraded].map((m) => m.seat), ready: plan.opened.length, absent: plan.absent.length, degraded: plan.degraded.length, pages: plan.pages.length });
      }
    }
    return result;
  }

  /** provider 可用性 + 存活性（doctor）。未知的具名 provider 返回其空报告。 */
  async status(providerName?: string): Promise<TerminalStatusResult> {
    const names: string[] = providerName ? [providerName] : ["herdr", "cmux"];
    const providers: ProviderStatusReport[] = [];
    for (const name of names) {
      const p = this.deps.resolveProvider(name);
      if (!p) {
        providers.push({
          name,
          status: { provider: name, available: false, capabilities: {} },
          liveness: { alive: false, detail: `未知 provider '${name}'` },
        });
        continue;
      }
      providers.push({ name, status: await p.status(), liveness: await p.liveness() });
    }
    return { providers };
  }

  /** 把视图参数解析为 composer 可用的成员；优先级见文件头。 */
  private async resolveView(view: string): Promise<ResolvedView> {
    if (view.startsWith("saved:")) {
      const saved = this.deps.viewsStore.get(view.slice(6));
      return saved ? { id: saved.id, members: saved.members.map(savedMemberToInput) } : { code: "view_not_found", error: `未知 saved view '${view.slice(6)}'` };
    }
    // 1. 派生 scope 前缀 → 实时、只读、绝不持久化。
    if (view.startsWith("mission:") || view.startsWith("slice:")) {
      const rows = await this.deps.listScopeSeats(view);
      if (rows == null) {
        return { code: "view_not_found", error: `未知或无效 scope '${view}'` };
      }
      return {
        id: view,
        members: deriveViewMembers(rows, { readOnly: true, labelSuffix: view }),
      };
    }

    // 2. 工作组内的 pod——`pod:<rig-id-or-name>/<podNamespace>`（AC-5 启动目标）。
    //    可交互，因为它是自己工作组的子集。
    if (view.startsWith("pod:")) {
      const rest = view.slice("pod:".length);
      const slash = rest.lastIndexOf("/");
      if (slash <= 0 || slash === rest.length - 1) {
        return { code: "view_not_found", error: `畸形 pod 视图 '${view}'——应为 pod:<rig>/<pod>` };
      }
      const rows = await this.deps.listPodSeats(rest.slice(0, slash), rest.slice(slash + 1));
      if (rows == null) {
        return { code: "view_not_found", error: `工作组 '${rest.slice(0, slash)}' 中没有 pod '${rest.slice(slash + 1)}'` };
      }
      return { id: view, members: deriveViewMembers(rows, { readOnly: false }) };
    }

    // 3. 工作组——可以是裸名称（常见用法：`zrig terminal open acme`），也可以是工作组
    //    作用域路由别名组合出的显式 `rig:<id-or-name>` 形式。arch R1：别名只加
    //    `rig:<rigId>` 前缀并委托，自身没有组合逻辑。`listRigSeats` 先按工作组名解析参数，
    //    再按工作组 id 解析。
    const explicitRig = view.startsWith("rig:");
    const rigArg = explicitRig ? view.slice("rig:".length) : view;
    const rigRows = await this.deps.listRigSeats(rigArg);
    if (rigRows != null) {
      return { id: `rig:${rigArg}`, members: deriveViewMembers(rigRows, { readOnly: false }) };
    }
    // 显式 `rig:<x>` 若无法解析到工作组，必须返回具名 not-found；不能回落到 saved-view
    // 查找，因为调用方明确请求的是工作组。
    if (explicitRig) {
      return { code: "view_not_found", error: `未知工作组 '${rigArg}'` };
    }

    // 4. 已保存视图 id。
    const saved = this.deps.viewsStore.get(view);
    if (saved) {
      return { id: saved.id, members: saved.members.map(savedMemberToInput) };
    }

    return {
      code: "view_not_found",
      error: `未知视图 '${view}'——它不是已知工作组、mission:/slice: scope 或 saved-view id`,
    };
  }

  /** 用真实 has-session 探针细化本地成员存活性；已死席位进入 absent，形成诚实的部分结果。 */
  private async refineLiveness(members: ViewMemberInput[]): Promise<ViewMemberInput[]> {
    const out: ViewMemberInput[] = [];
    for (const m of members) {
      if (m.host === null && m.tmuxSession) {
        out.push({ ...m, alive: await this.deps.hasSession(m.tmuxSession) });
      } else {
        out.push(m);
      }
    }
    return out;
  }
}
