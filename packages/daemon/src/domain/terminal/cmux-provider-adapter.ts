// OPR.0.4.6.02 C2——cmux 终端提供方门面。
//
// 按工作组范围“在 CMUX 中启动”端点的一贯方式渲染组合视图：composer 的每个 `pages` 网格页
// 对应一个网格化 cmux 工作区，通过已交付的 `CmuxLayoutService` split/grid 机制驱动，绝不为每个
// 席位单独创建 window。每个 pane 原样执行 composer 的 `paneCommand`（保留只读 `-r`、ssh 包装与
// quoting），遵循 terminal-provider.ts 中的 provider 契约。
//
// 部分渲染时 cmux 保持尽力而为且不设门禁；无法平铺的页面会诚实降级并点名，绝不静默丢弃。
// cmux 表面完全未连接时会如实拒绝（`cmux_unavailable`），与 herdr socket 门禁及 rig-cmux
// 路由的 503 一致。
//
// cmux 表面始终为本地（cmux 运行在操作者机器上），因此 cmux 层降级会盖上 `local` 主机哨兵。

import type { CmuxAdapter } from "../../adapters/cmux.js";
import { autoGridCols, type CmuxLayoutService } from "../cmux-layout-service.js";
import type {
  AbsentSeat,
  ComposedView,
  DegradedSeat,
  OpenViewResult,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
} from "./terminal-provider.js";

export interface CmuxProviderDeps {
  cmuxAdapter: CmuxAdapter;
  layoutService: CmuxLayoutService;
  /**
   * 每次 `openView` 生成新的 launch token，使重新启动创建新工作区
   *（fresh-on-relaunch，与 herdr adapter 规则相同）。确定性测试可注入；默认使用逐实例单调
   * 计数器，在后台服务生命周期内唯一。
   */
  newLaunchToken?: () => string;
  /** 工作区名称前缀，默认为 `openrig`。 */
  workspacePrefix?: string;
}

/** cmux 层降级使用的主机哨兵；cmux 表面始终在本地。 */
const CMUX_LOCAL_HOST = "local";

/** cmux 工作区标题是自由文本，但仍需对 shell/UI 保持惰性。 */
function sanitizeWorkspaceName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._:@#/-]+/g, "-");
}

export class CmuxProviderAdapter implements TerminalProvider {
  readonly name = "cmux";
  private readonly newLaunchToken: () => string;
  private readonly workspacePrefix: string;
  private launchCounter = 0;

  constructor(private readonly deps: CmuxProviderDeps) {
    this.workspacePrefix = deps.workspacePrefix ?? "openrig";
    this.newLaunchToken = deps.newLaunchToken ?? (() => `l${(this.launchCounter += 1)}`);
  }

  async status(): Promise<ProviderStatus> {
    const s = this.deps.cmuxAdapter.getStatus();
    return { provider: this.name, available: s.available, capabilities: s.capabilities };
  }

  async liveness(): Promise<ProviderLiveness> {
    const alive = this.deps.cmuxAdapter.isAvailable();
    return alive ? { alive: true } : { alive: false, detail: "cmux 未连接" };
  }

  async openView(view: ComposedView): Promise<OpenViewResult> {
    // 原样传递 composer 的诚实部分完成分类。
    const absent: AbsentSeat[] = [...view.absent];
    const degraded: DegradedSeat[] = [...view.degraded];
    const opened: string[] = [];

    // 没有内容可平铺（视图全部 absent/degraded）时，不产生工作区副作用。
    if (view.pages.length === 0) {
      return { provider: this.name, ok: view.opened.length === 0, opened, absent, degraded, pages: 0 };
    }

    // cmux 表面自身不可用时诚实拒绝，不发送任何内容。
    if (!this.deps.cmuxAdapter.isAvailable()) {
      return {
        provider: this.name,
        ok: false,
        opened,
        absent,
        degraded,
        pages: 0,
        error: "cmux 未连接——请从 https://cmux.io 安装 cmux，并运行：cmux ping",
        code: "cmux_unavailable",
      };
    }

    // 每个组合页对应一个网格化工作区；每个 launch token 使用全新名称。
    const base = sanitizeWorkspaceName(`${this.workspacePrefix}:${view.id}#${this.newLaunchToken()}`);
    let pagesPainted = 0;
    for (let pageIndex = 0; pageIndex < view.pages.length; pageIndex++) {
      const page = view.pages[pageIndex]!;
      const workspaceName = view.pages.length > 1 ? `${base}/${pageIndex + 1}` : base;
      // 实际应用的网格与模态 Auto-grid 预览一致（PM 裁决）：
      // cols = ceil(sqrt(N)) — N=2 → 1×2, N=5 → 2×3, N=7 → 3×3.
      const build = await this.deps.layoutService.buildWorkspacePanes(
        workspaceName,
        undefined,
        page.map((pane) => pane.paneCommand),
        autoGridCols(page.length),
      );
      if (build.ok) {
        pagesPainted += 1;
        for (const pane of page) opened.push(pane.seat);
      } else {
        // 整页平铺失败：如实降级该页席位并继续。
        for (const pane of page) {
          degraded.push({
            seat: pane.seat,
            host: CMUX_LOCAL_HOST,
            reason: `cmux: ${build.message || build.code}`,
          });
        }
      }
    }

    return {
      provider: this.name,
      ok: opened.length > 0 || view.opened.length === 0,
      opened,
      absent,
      degraded,
      pages: pagesPainted,
    };
  }
}
