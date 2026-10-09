// OPR.0.4.6.02 C2+FB4——herdr TerminalProvider（受 proof 门禁保护的主 provider）。
// 与 AGPL 保持独立：通过注入的 `HerdrTransport`（见 herdr-transport.ts）驱动已安装 herdr 的
// 本地控制 SOCKET，绝不链接 herdr。
//
// FB4（VM-RED 修正）：herdr 0.7.1 没有 `layout` CLI 命令；旧 CLI 形状
//（`herdr layout apply …`）无法完成平铺，已在 VM e373f741 证明为 RED。herdr 的真实布局机制是
// socket `layout.apply`，并由 research/herdr-socket-captures/herdr-phase3-*.json 逐字验证：
//   request  {id, method:"layout.apply",
//             params:{workspace_id, tab_label, focus, root}}
//   root     = {type:"split", direction:"right"|"down", ratio, first, second}
//              | {type:"pane", label, command:[argv…]}
//   response {id, result:{type:"layout_apply", layout:{workspace_id, tab_id,…}}}
//
// 行为契约（与通过 guard 的形状保持一致）：
//  - 每个网格页只发一个原子 `layout.apply`；整页 pane 在同一请求中落地，绝不会只平铺半页。
//  - 每次重新打开都创建全新 tab/工作区（BR-5，非替换式幂等）：每次 open 创建自己的工作区
//    (`workspace.create`)，tab label 嵌入逐 launch token。实测 `layout.apply` 本身不幂等
//    （四次重应用 capture 显示重应用会创建 tab t3，绝不替换 t2），因此重新打开不会覆盖旧视图。
//  - Pane 标签写入 layout.apply pane node 的 `label` 字段（AC-7 `<agent> · <slice>`）。
//    capture 显示每个 pane 都会回显 label，因此无需单独执行 `pane rename`；也不存在可调用的
//    `pane rename` 命令行。
//  - composer 的 `paneCommand` 是 shell 字符串（`tmux attach -r -t 's'`、
//    `ssh 'dest' tmux attach …`），pane node 的 `command` 是 argv 数组，因此以
//    `["sh", "-c", paneCommand]` 携带，在 adapter 不重新解析 shell 的情况下逐字保留 quoting。
//  - 存活/可用性由 socket `ping` 决定，即 multiplexer 自身控制 socket 是否响应，而不是后台服务
//    server ping；这延续 HERDR-FINDINGS #3 的意图。没有“layout command”探针，CLI 帮助表面与
//    socket API 无关。
//  - 自动网格单元格等大（OPR.0.4.7.1）。布局树与 UI TerminalLauncher 的 suggestLayout 形状完全
//    一致：cols=ceil(sqrt(N))，rows=ceil(N/cols)；N=2 → 2×1、N=5 → 3×2、N=7 → 3×3
//    （cols×rows）。每行由等大的 right strip 构成，再由等大的 down strip 组合，并使用
//    first-vs-rest 比例（1/N、1/(N-1)…；VM pane.layout 已验证）。旧版交替 0.5 BSP 已退役；
//    它会把 N=7 渲染为 4×2，并产生一个双宽单元格。不完整矩形使用惰性空白 pane 填充
//    （沿用 cmux 空白表面先例），空白 pane 绝不报告为已打开席位。
//
// `workspace.create` 响应 envelope 已由 VM 确认（OPR.0.4.7.1）：
// `result.workspace.workspace_id` + `result.tab.tab_id` + `result.root_pane`.
// 对旧版构建，提取过程保持 null-safe 且防御性（extractWorkspaceId）。OPR.0.6.0.8：issue #26
// 是早先裁决等待的线上证据——用户会落在 create 创建的空默认 tab。布局后 adapter 会聚焦它知道的
// 第一个非空 tab（tab.focus），并且仅在确定起始 tab 为空时将其关闭（tab.close）：每页均已应用并
// 报告 tab id，且没有一个是起始 tab。否则保留起始 tab，并在结果中说明。两个方法都属于 herdr
// 0.7.1 socket API（`herdr tab focus|close <tab_id>`）；任一被拒都只报告 note，绝不标记席位失败。

import type {
  AbsentSeat,
  ComposedPane,
  ComposedView,
  DegradedSeat,
  OpenViewResult,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
} from "./terminal-provider.js";
import type {
  HerdrResult,
  HerdrTransport,
  HerdrTransportFactory,
} from "./herdr-transport.js";
import { autoGridCols } from "../cmux-layout-service.js";

/** herdr 表面降级使用的主机哨兵，即 herdr 自身未能渲染 pane。 */
const HERDR_SURFACE_HOST = "herdr";

/** herdr 布局树的 pane 叶节点；`command` 为 argv 数组，已经 capture 验证。 */
export interface HerdrPaneNode {
  type: "pane";
  label: string;
  command: string[];
}

/** herdr 布局树的二叉 split；形状已经 capture 验证。 */
export interface HerdrSplitNode {
  type: "split";
  direction: "right" | "down";
  ratio: number;
  first: HerdrLayoutNode;
  second: HerdrLayoutNode;
}

export type HerdrLayoutNode = HerdrPaneNode | HerdrSplitNode;

/**
 * 沿一个方向把 N 个节点组合为等大的 N 路条带；纯函数。等大 N 路 BSP 采用 first-vs-rest，
 * 比例依次为 1/N、1/(N-1)，而非中点 0.5。VM 已复现旧缺陷：交替 0.5 split 会把 N=7
 * 渲染为带一个双宽单元格的 4×2，而不是承诺的 3×3。
 */
export function equalStrip(nodes: HerdrLayoutNode[], direction: "right" | "down"): HerdrLayoutNode {
  if (nodes.length === 1) return nodes[0]!;
  return {
    type: "split",
    direction,
    ratio: 1 / nodes.length,
    first: nodes[0]!,
    second: equalStrip(nodes.slice(1), direction),
  };
}

/** 惰性空白 pane；用于填充不完整网格矩形，沿用 cmux 空白表面先例。 */
function blankPane(): HerdrPaneNode {
  return { type: "pane", label: "", command: ["sh"] };
}

/**
 * 为一页 pane 构建等大 auto-grid 布局树；纯函数。网格形状与 UI TerminalLauncher 的
 * `suggestLayout` 完全一致：
 * cols = ceil(sqrt(N)), rows = ceil(N/cols): N=2 → 2×1, N=5 → 3×2, N=7 → 3×3
 *（cols×rows）。不完整矩形用惰性空白 pane 填充，使每个单元格等大；空白只用于布局，绝不报告为
 * 已打开席位。每个真实叶节点通过 `["sh","-c",…]` 运行 composer 的 shell `paneCommand`，
 * 原样保留组合后的 quoting（只读 `-r`、ssh 包装）。先把各行构建为等大的 `right` 条带，
 * 再用等大的 `down` 条带组合。
 */
export function buildGridRoot(panes: ComposedPane[]): { root: HerdrLayoutNode; blanks: number; columns: number; rows: number } {
  const cols = autoGridCols(panes.length);
  const rows = Math.ceil(panes.length / cols);
  const blanks = rows * cols - panes.length;
  const leaves: HerdrLayoutNode[] = panes.map((pane) => ({
    type: "pane",
    label: pane.label,
    command: ["sh", "-c", pane.paneCommand],
  }));
  for (let i = 0; i < blanks; i++) leaves.push(blankPane());
  const rowStrips: HerdrLayoutNode[] = [];
  for (let r = 0; r < rows; r++) {
    rowStrips.push(equalStrip(leaves.slice(r * cols, (r + 1) * cols), "right"));
  }
  return { root: equalStrip(rowStrips, "down"), blanks, columns: cols, rows };
}

/** 逐页 socket 请求计划；纯函数，因此测试会直接断言。 */
export interface HerdrPagePlan {
  /** 本页的新 tab label；嵌入 launch token，保证重新启动时新建。 */
  tabLabel: string;
  /** 整页布局树；作为一个原子 layout.apply 请求 body。 */
  root: HerdrLayoutNode;
  /** 填充网格矩形的惰性空白叶节点；绝不报告为已打开。 */
  blanks: number;
}

export interface HerdrLayoutPlan {
  /** 每次 open 创建的新工作区标签；使用与 tab 相同的 token 规则。 */
  workspaceLabel: string;
  pages: HerdrPagePlan[];
}

/**
 * 为组合视图构建 herdr socket 计划；纯函数，无 I/O。每页获得一个标签为
 * `${tabPrefix}:${view.id}#${launchToken}/<pageIndex>` 的新 tab；不同 `launchToken` 的两次调用
 * 产生不同标签，这正是重新启动时创建新 tab 而非替换的不变量。
 */
export function planHerdrLayout(
  view: ComposedView,
  launchToken: string,
  tabPrefix: string = "openrig",
): HerdrLayoutPlan {
  const base = `${tabPrefix}:${view.id}#${launchToken}`;
  // 工作区名称面向人类：工作组视图使用工作组名，其他视图使用 view id。Tab label 保留 launch token，
  // 因而每次 open 仍是全新且独立的空间。
  const workspaceLabel = view.id.startsWith("rig:") ? view.id.slice("rig:".length) : view.id;
  const pages: HerdrPagePlan[] = view.pages.map((page, pageIndex) => {
    const grid = buildGridRoot(page);
    return {
      tabLabel: view.pages.length > 1 ? `${base}/${pageIndex + 1}` : base,
      root: grid.root,
      blanks: grid.blanks,
    };
  });
  return { workspaceLabel, pages };
}

/**
 * 从 `workspace.create` 结果 body 提取已创建工作区 id。线上 envelope 已由 VM 确认
 *（OPR.0.4.7.1）：`result.workspace.workspace_id` + `result.tab.tab_id` +
 * `result.root_pane`，由下方嵌套 `workspace` 分支覆盖。为旧版构建保留其他防御性位置
 *（顶层 `workspace_id`、嵌套 `layout`、裸 `id`）。找不到字符串形状时返回 null，
 * 调用方会诚实降级而非猜测。
 */
export function extractWorkspaceId(result: HerdrResult): string | null {
  const direct = result["workspace_id"];
  if (typeof direct === "string" && direct) return direct;
  for (const key of ["workspace", "layout"]) {
    const nested = result[key];
    if (nested && typeof nested === "object") {
      const obj = nested as Record<string, unknown>;
      const id = obj["workspace_id"] ?? obj["id"];
      if (typeof id === "string" && id) return id;
    }
  }
  const bare = result["id"];
  if (typeof bare === "string" && bare) return bare;
  return null;
}

export interface HerdrAdapterDeps {
  transportFactory: HerdrTransportFactory;
  /**
   * 每次 `openView` 生成新的 launch token，使重新启动创建新 tab（BR-5）。确定性测试可注入；
   * 默认使用逐实例单调计数器，在后台服务生命周期内唯一。
   */
  newLaunchToken?: () => string;
  /** Tab 名称前缀，默认为 `openrig`。 */
  tabPrefix?: string;
}

/** Herdr 每个 tab 按 4×4 布局（OPR.0.6.0.8）；cmux 保留 composer 默认值。 */
export const HERDR_PANES_PER_PAGE = 16;

/** 从 herdr 结果 body 读取 `tab_id`：`result.tab.tab_id`、`result.layout.tab_id` 或顶层字段。 */
export function extractTabId(result: HerdrResult | null | undefined): string | null {
  if (!result) return null;
  if (typeof result["tab_id"] === "string" && result["tab_id"]) return result["tab_id"] as string;
  for (const key of ["tab", "layout"]) {
    const nested = result[key];
    if (nested && typeof nested === "object") {
      const id = (nested as Record<string, unknown>)["tab_id"];
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}

/** 从 `workspace.list` 结果 body 读取工作区标签；形状未知时返回 []。 */
export function extractWorkspaceLabels(result: HerdrResult | null | undefined): string[] {
  const list = result?.["workspaces"];
  if (!Array.isArray(list)) return [];
  return list.map((w) => (w && typeof w === "object" ? (w as Record<string, unknown>)["label"] : null))
    .filter((l): l is string => typeof l === "string");
}

export class HerdrAdapter implements TerminalProvider {
  readonly name = "herdr";
  readonly panesPerPage = HERDR_PANES_PER_PAGE;
  private readonly transport: HerdrTransport;
  private readonly newLaunchToken: () => string;
  private readonly tabPrefix: string;
  private launchCounter = 0;

  constructor(private readonly deps: HerdrAdapterDeps) {
    this.transport = deps.transportFactory();
    this.tabPrefix = deps.tabPrefix ?? "openrig";
    this.newLaunchToken =
      deps.newLaunchToken ?? (() => `l${(this.launchCounter += 1)}`);
  }

  async status(): Promise<ProviderStatus> {
    try {
      const probe = await this.transport.probe();
      return {
        provider: this.name,
        available: probe.alive,
        ...(probe.version ? { version: probe.version } : {}),
        // socket 响应 ping 本身就是能力表面：layout.apply 是协议的布局动词；0.7.1 没有逐命令发现，
        // `api schema` 也不存在（HERDR-FINDINGS §3）。
        capabilities: { socket: probe.alive, "layout.apply": probe.alive },
      };
    } catch {
      // socket 不可达（herdr 未运行）时，如实报告不可用。
      return { provider: this.name, available: false, capabilities: {} };
    }
  }

  async liveness(): Promise<ProviderLiveness> {
    // 存活性指 multiplexer 自身控制 socket 响应 ping。
    try {
      const probe = await this.transport.probe();
      return probe.alive
        ? { alive: true }
        : { alive: false, detail: "herdr 控制 socket 未响应 ping" };
    } catch (err) {
      return { alive: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async openView(view: ComposedView): Promise<OpenViewResult> {
    const absent: AbsentSeat[] = [...view.absent];
    const degraded: DegradedSeat[] = [...view.degraded];
    const opened: string[] = [];

    // 以 socket 存活为门禁，如实拒绝“herdr 未运行”的情况。无需探测 CLI help 中的
    // “layout command”，因为 socket API 才是布局表面。
    const probe = await this.transport.probe();
    if (!probe.alive) {
      return {
        provider: this.name,
        ok: false,
        opened,
        absent,
        degraded,
        pages: 0,
        error: "herdr 控制 socket 未响应 ping；herdr 是否正在运行？",
        code: "herdr_unavailable",
      };
    }

    const launchToken = this.newLaunchToken();
    const plan = planHerdrLayout(view, launchToken, this.tabPrefix);

    // 没有内容可平铺（视图全部 absent/degraded）时，不产生工作区副作用。
    if (plan.pages.length === 0) {
      return {
        provider: this.name,
        ok: view.opened.length === 0,
        opened,
        absent,
        degraded,
        pages: 0,
      };
    }

    // 每次 open 都创建全新工作区（BR-5 fresh-on-relaunch 的最强形式）。先尝试带 label 创建；
    // 若 herdr 拒绝且同 label 工作区已存在，则附加数字后缀重试一次并明确说明；否则在降级前
    // 只回退一次裸 create。
    const notes: string[] = [];
    let workspaceId: string | null = null;
    let defaultTabId: string | null = null;
    let createErr: unknown = null;
    try {
      const created = await this.transport.request("workspace.create", { focus: false, label: plan.workspaceLabel });
      workspaceId = extractWorkspaceId(created);
      defaultTabId = extractTabId(created);
    } catch (err) {
      createErr = err;
    }
    if (workspaceId == null) {
      let existing: string[] = [];
      try { existing = extractWorkspaceLabels(await this.transport.request("workspace.list", {})); } catch { /* unknown → bare fallback */ }
      if (existing.includes(plan.workspaceLabel)) {
        let n = 2;
        while (existing.includes(`${plan.workspaceLabel} (${n})`)) n++;
        const suffixed = `${plan.workspaceLabel} (${n})`;
        try {
          const created = await this.transport.request("workspace.create", { focus: false, label: suffixed });
          workspaceId = extractWorkspaceId(created);
          defaultTabId = extractTabId(created);
          if (workspaceId != null) {
            createErr = null;
            notes.push(`名为“${plan.workspaceLabel}”的工作区已存在，因此新工作区命名为“${suffixed}”。`);
          }
        } catch (err) {
          createErr = createErr ?? err;
        }
      }
    }
    if (workspaceId == null) {
      try {
        const created = await this.transport.request("workspace.create", { focus: false });
        workspaceId = extractWorkspaceId(created);
        defaultTabId = extractTabId(created);
        if (workspaceId != null) notes.push(`herdr 拒绝了工作区名称“${plan.workspaceLabel}”；该工作区未命名。`);
        createErr = null;
      } catch (err) {
        createErr = createErr ?? err;
      }
    }
    if (workspaceId == null) {
      // 没有工作区就无法平铺；如实降级每个 pane。
      const reason = `herdr workspace.create 失败：${
        createErr instanceof Error
          ? createErr.message
          : createErr != null
            ? String(createErr)
            : "响应中没有 workspace id"
      }`;
      for (const page of view.pages) {
        for (const pane of page) {
          degraded.push({ seat: pane.seat, host: HERDR_SURFACE_HOST, reason });
        }
      }
      return {
        provider: this.name,
        ok: view.opened.length === 0,
        opened,
        absent,
        degraded,
        pages: 0,
        error: reason,
        code: "herdr_workspace_failed",
      };
    }

    const appliedTabIds: string[] = [];
    let firstPopulatedTabId: string | null = null;
    // 只有每页都应用成功并报告 tab id 时，才能确定起始 tab 为空；无 id 响应或失败但可能已生效的
    // apply 都可能使用了它。
    let everyPageKnown = true;
    for (let pageIndex = 0; pageIndex < plan.pages.length; pageIndex++) {
      const pagePlan = plan.pages[pageIndex]!;
      const pagePanes = view.pages[pageIndex]!;
      try {
        // 整页只发一个原子 layout.apply；形状已由 capture 验证。
        const applied = await this.transport.request("layout.apply", {
          workspace_id: workspaceId,
          tab_label: pagePlan.tabLabel,
          focus: true,
          root: pagePlan.root,
        });
        const tabId = extractTabId(applied);
        if (tabId) { appliedTabIds.push(tabId); firstPopulatedTabId ??= tabId; } else everyPageKnown = false;
        for (const pane of pagePanes) opened.push(pane.seat);
      } catch (err) {
        everyPageKnown = false;
        // 整页应用失败：如实降级该页席位。
        for (const pane of pagePanes) {
          degraded.push({
            seat: pane.seat,
            host: HERDR_SURFACE_HOST,
            reason: `herdr layout.apply 失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    // 先落到已知非空 tab，再仅在确认 create 的起始 tab 为空时将其移除（#26）。无法确定时保留，
    // 因为关闭它可能移除席位。
    if (opened.length > 0) {
      if (firstPopulatedTabId) {
        try { await this.transport.request("tab.focus", { tab_id: firstPopulatedTabId }); }
        catch (err) { notes.push(`herdr 未聚焦第一个 tab：${err instanceof Error ? err.message : String(err)}`); }
      } else {
        notes.push("herdr 未为任何页面返回 tab id，因此未显式聚焦 tab。");
      }
      if (defaultTabId) {
        if (!everyPageKnown) {
          notes.push("无法确认起始 tab 为空，因此予以保留。");
        } else if (!appliedTabIds.includes(defaultTabId)) {
          try { await this.transport.request("tab.close", { tab_id: defaultTabId }); }
          catch (err) { notes.push(`herdr 保留了空白起始 tab：${err instanceof Error ? err.message : String(err)}`); }
        }
      }
    }

    return {
      provider: this.name,
      ok: opened.length > 0 || view.opened.length === 0,
      opened,
      absent,
      degraded,
      pages: plan.pages.length,
      ...(notes.length ? { notes } : {}),
    };
  }
}
