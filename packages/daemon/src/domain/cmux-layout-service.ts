// Slice 24——CmuxLayoutService。
//
// “在 CMUX 中启动”功能的算法核心。三个纯 helper（computeLayout / chunkAgents /
// orderAgentsFromRigSpec）加上协调式 grid builder（buildWorkspacePanes，buildWorkspace 是其
// tmux-attach 包装器），通过 workspace.create + N-1 次 surface.split + N 次 surface.sendText
// 驱动 CmuxAdapter，在新建 cmux workspace 中为每个智能体填充一个 panel。terminal-provider
// 路径复用同一核心，并使用 composer 构建的 pane command（保留只读 -r、ssh-wrap 和 quoting）。
//
// 时序策略（见 slice 24 README §Daemon-side 与 cmux-rig-layout skill §5 陷阱）：
//   - 每次 splitSurface 后等待 OP_DELAY_MS，让新 surface 的 shell 在下一操作前到达 prompt
//     （skill §5 陷阱 3：surface 暂时无法接收输入的窗口）。
//   - 最后一次 sendText 后等待 FINAL_SETTLE_MS，规避 last-send-key 竞态（skill §5 陷阱 2）。
//   - createWorkspace 后立即调用 listSurfaces 时采用短暂 backoff 重试，以吸收 workspace 默认
//     surface 的 attach 延迟。cmux 后台服务在 workspace.create 时创建默认 surface，但列表可能
//     暂时还看不到它。
// Sleep 通过构造器注入，测试可将其替换为 no-op。
//
// 按 slice 24 README §Layout algorithm §“Configurability posture”，常量位于文件顶部。v0
// 以硬编码常量交付；v0.3.2 后续版本再升级为 settings key。
//
// TODO(0.3.2)：将 MAX_COLS 和 MAX_PER_WORKSPACE 提升为设置键。
// cmux.workspace_columns + cmux.workspace_max_panels (slice 08 settings
// 基础设施已就绪；这是包含两个 key 与可选 UI surface 的后续工作）。

import type { CmuxAdapter, CmuxResult } from "../adapters/cmux.js";

export const MAX_COLS = 2;
export const MAX_PER_WORKSPACE = 12;
export const OP_DELAY_MS = 500;
export const FINAL_SETTLE_MS = 1000;
export const LIST_SURFACES_RETRY_DELAY_MS = 100;
export const LIST_SURFACES_MAX_ATTEMPTS = 5;
export const EQUALIZE_PASSES = 2;
export const EQUALIZE_SETTLE_MS = 1200;

export type SleepFn = (ms: number) => Promise<void>;

/**
 * N 个 pane 的弹窗 Auto-grid 列数。必须镜像 UI TerminalLauncher 的 `suggestLayout`。PM 裁定：
 * 实际 cmux grid 必须与弹窗 preview 一致，N=7 时为 3×3，绝不能是 2×4。这里保留一份实现，
 * 因为后台服务无法从 packages/ui 导入；任一侧发生漂移都属于 bug。
 */
export function autoGridCols(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

const defaultSleep: SleepFn = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LayoutShape {
  rows: number;
  cols: number;
  blanks: number;
}

export interface BuildWorkspaceResult {
  workspaceId: string;
  workspaceName: string;
  agents: string[];
  blanks: number;
}

export interface BuildWorkspacePanesResult {
  workspaceId: string;
  workspaceName: string;
  paneCount: number;
  blanks: number;
  /**
   * 仅用于可观测性，不是 acceptance signal。VM 已证明 cmux 可能报告 equalized:true，但后续
   * layout churn 又恢复二叉尺寸；最终 pane frame 才是 acceptance。true 表示至少一次 equalize
   * pass 报告 rebalance；false 表示一次也没有；缺失表示不适用，即当前形状无需 equalize。
   */
  equalized?: boolean;
}

export interface RigSpecLike {
  pods?: Array<{
    id: string;
    members?: Array<{ id: string }>;
  }>;
}

export interface CmuxLayoutServiceOptions {
  sleep?: SleepFn;
}

export class CmuxLayoutService {
  private readonly sleep: SleepFn;

  constructor(private cmuxAdapter: CmuxAdapter, opts: CmuxLayoutServiceOptions = {}) {
    this.sleep = opts.sleep ?? defaultSleep;
  }

  static computeLayout(n: number): LayoutShape {
    if (n === 1) {
      // 在这里校验 n，使 1×1 快速路径仍会在上游拒绝非整数。
      return CmuxLayoutService.computeGridLayout(n, 1);
    }
    return CmuxLayoutService.computeGridLayout(n, MAX_COLS);
  }

  /** 使用显式列数计算 N 个 pane 的 grid 形状；列数最大限制为 N。 */
  static computeGridLayout(n: number, cols: number): LayoutShape {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`CmuxLayoutService.computeLayout：N 必须是正整数（收到 ${n}）`);
    }
    if (n > MAX_PER_WORKSPACE) {
      throw new Error(
        `CmuxLayoutService.computeLayout：N=${n} 超过 MAX_PER_WORKSPACE=${MAX_PER_WORKSPACE}；调用方应先分块`,
      );
    }
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new Error(`CmuxLayoutService.computeGridLayout：cols 必须是正整数（收到 ${cols}）`);
    }
    const effectiveCols = Math.min(cols, n);
    const rows = Math.ceil(n / effectiveCols);
    const blanks = rows * effectiveCols - n;
    return { rows, cols: effectiveCols, blanks };
  }

  static chunkAgents<T>(agents: T[]): T[][] {
    if (agents.length === 0) return [];
    const chunks: T[][] = [];
    for (let i = 0; i < agents.length; i += MAX_PER_WORKSPACE) {
      chunks.push(agents.slice(i, i + MAX_PER_WORKSPACE));
    }
    return chunks;
  }

  static orderAgentsFromRigSpec(rigSpec: RigSpecLike): string[] {
    const out: string[] = [];
    for (const pod of rigSpec.pods ?? []) {
      for (const member of pod.members ?? []) {
        out.push(`${pod.id}.${member.id}`);
      }
    }
    return out;
  }

  async buildWorkspace(
    workspaceName: string,
    cwd: string | undefined,
    agentSessions: string[],
  ): Promise<CmuxResult<BuildWorkspaceResult>> {
    const built = await this.buildWorkspacePanes(
      workspaceName,
      cwd,
      agentSessions.map((session) => `tmux attach -t ${session}`),
    );
    if (!built.ok) return built;
    return {
      ok: true,
      data: {
        workspaceId: built.data.workspaceId,
        workspaceName,
        agents: agentSessions.slice(),
        blanks: built.data.blanks,
      },
    };
  }

  /**
   * 命令级 grid builder（共享核心）。与 buildWorkspace 使用相同的单 workspace grid，但每个
   * pane 逐字运行调用方组合的任意 shell command，并追加换行；这就是 terminal-provider 路径
   * 的 `paneCommand` 契约，保留只读 `-r`、ssh-wrap 和 quoting。
   *
   * `cols` 覆盖列数。terminal launcher 传入弹窗 Auto-grid 的 `autoGridCols(N)`；按 PM 裁定，
   * 实际 grid 必须与弹窗 preview 一致。省略时使用 legacy 双列 rig-launch 形状。
   */
  async buildWorkspacePanes(
    workspaceName: string,
    cwd: string | undefined,
    paneCommands: string[],
    cols?: number,
  ): Promise<CmuxResult<BuildWorkspacePanesResult>> {
    if (paneCommands.length === 0) {
      const ws = await this.cmuxAdapter.createWorkspace(workspaceName, cwd);
      if (!ws.ok) return ws;
      return {
        ok: true,
        data: { workspaceId: ws.data, workspaceName, paneCount: 0, blanks: 0 },
      };
    }

    if (paneCommands.length > MAX_PER_WORKSPACE) {
      return {
        ok: false,
        code: "invalid_input",
        message: `buildWorkspace：${paneCommands.length} 个智能体超过 MAX_PER_WORKSPACE=${MAX_PER_WORKSPACE}；调用方应先分块`,
      };
    }

    const layout =
      cols != null
        ? CmuxLayoutService.computeGridLayout(paneCommands.length, cols)
        : CmuxLayoutService.computeLayout(paneCommands.length);

    // 1. 创建 workspace。
    const wsResult = await this.cmuxAdapter.createWorkspace(workspaceName, cwd);
    if (!wsResult.ok) return wsResult;
    const workspaceId = wsResult.data;

    // 2. 发现 workspace 默认 surface。workspace.create 会自动创建一个 terminal surface，
    //    但列表不一定立即反映；使用短 backoff 重试。skill §5 陷阱 3 的 surface 输入未就绪
    //    窗口同样适用于 surface 枚举。
    const initialSurface = await this.discoverInitialSurface(workspaceId);
    if (!initialSurface.ok) return initialSurface;

    // 3. 构建 grid，grid[col][row] 保存 surface id。layout 形状决定 split 顺序：
    //    - 第 1 列：初始 surface + 其下方 (rows-1) 次 down split；
    //    - 后续每列：从前一列顶部 surface 向右 split 一次，再执行 (rows-1) 次 down split。
    //    每次 split 后等待 OP_DELAY_MS，让新 surface 的 shell 在下一操作前到达 prompt。
    const grid: string[][] = [[initialSurface.data]];

    for (let c = 1; c < layout.cols; c++) {
      const rightSplit = await this.cmuxAdapter.splitSurface(
        grid[c - 1]![0]!,
        "right",
        workspaceId,
      );
      if (!rightSplit.ok) return rightSplit;
      grid.push([rightSplit.data]);
      await this.sleep(OP_DELAY_MS);
    }

    for (let r = 1; r < layout.rows; r++) {
      for (let c = 0; c < layout.cols; c++) {
        const prevSurfaceInCol = grid[c]![r - 1]!;
        const downSplit = await this.cmuxAdapter.splitSurface(
          prevSurfaceInCol,
          "down",
          workspaceId,
        );
        if (!downSplit.ok) return downSplit;
        grid[c]!.push(downSplit.data);
        await this.sleep(OP_DELAY_MS);
      }
    }

    // 4. 按 COLUMN-MAJOR 顺序把每个 pane command 发送到对应 surface：先自上而下填满第 0 列，
    //    再自上而下填第 1 列。与 README §52 “Fill ... (top-to-bottom, left-to-right)”一致，
    //    每列内容按阅读顺序排列，再从左向右移动。最后几行未填充的 surface 保持为空白，cmux
    //    仍会把它们显示为空 terminal。
    let paneIndex = 0;
    for (let c = 0; c < layout.cols && paneIndex < paneCommands.length; c++) {
      for (let r = 0; r < layout.rows && paneIndex < paneCommands.length; r++) {
        const surface = grid[c]![r]!;
        const command = paneCommands[paneIndex]!;
        const sendResult = await this.cmuxAdapter.sendText(
          surface,
          `${command}\n`,
          workspaceId,
        );
        if (!sendResult.ok) return sendResult;
        paneIndex += 1;
      }
    }

    // 5. 最终 settle。按 skill §5 陷阱 2，脚本立即退出时最后一次 send-key 可能丢失；等待可确保
    //    terminal 刷出 Enter 字符。
    await this.sleep(FINAL_SETTLE_MS);

    // 6. Equalize——只用于显式 cols 的 Auto-grid；legacy 双列 rig-launch 保持逐字节不变。任一维
    //    超过 2 时，连续 50/50 二叉 split 会形成 50/25/25。VM 已证明并由 PM 裁定：必须等所有
    //    pane command 落地且 workspace settle 后再 equalize；过早调用即使报告 equalized:true，
    //    后续 layout churn 仍可能恢复二叉尺寸，最终变成 2:1:1。因此固定执行若干 pass，pass 间
    //    留 settle delay，绝不因 RPC boolean 提前退出。boolean 只供观测，最终 pane-frame 几何
    //    才是 acceptance。按设计此步骤非致命：未 equalize 只会降低尺寸质量，不影响 pane。
    let equalized: boolean | undefined;
    if (cols != null && (layout.cols > 2 || layout.rows > 2)) {
      equalized = false;
      for (let pass = 0; pass < EQUALIZE_PASSES; pass++) {
        const eq = await this.cmuxAdapter.equalizeSplits(workspaceId);
        if (eq.ok && eq.data.equalized) equalized = true;
        if (pass < EQUALIZE_PASSES - 1) {
          await this.sleep(EQUALIZE_SETTLE_MS);
        }
      }
    }

    return {
      ok: true,
      data: {
        workspaceId,
        workspaceName,
        paneCount: paneCommands.length,
        blanks: layout.blanks,
        ...(equalized !== undefined ? { equalized } : {}),
      },
    };
  }

  private async discoverInitialSurface(workspaceId: string): Promise<CmuxResult<string>> {
    for (let attempt = 0; attempt < LIST_SURFACES_MAX_ATTEMPTS; attempt++) {
      const result = await this.cmuxAdapter.listSurfaces(workspaceId);
      if (!result.ok) return result;
      if (result.data.length > 0) {
        return { ok: true, data: result.data[0]!.id };
      }
      if (attempt < LIST_SURFACES_MAX_ATTEMPTS - 1) {
        await this.sleep(LIST_SURFACES_RETRY_DELAY_MS);
      }
    }
    return {
      ok: false,
      code: "request_failed",
      message: `buildWorkspace：尝试 ${LIST_SURFACES_MAX_ATTEMPTS} 次后，workspace ${workspaceId} 仍没有默认 surface；cmux 后台服务可能尚未就绪`,
    };
  }
}
