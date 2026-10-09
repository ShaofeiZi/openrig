// OPR.0.4.6.02 C2——TerminalProvider abstraction（terminal-provider 路径的核心 seam）。
//
// provider 将已完成 composition 的 view 渲染到自身 surface model（herdr workspace/tab/pane；
// cmux workspace/surface）。它绝不自行组合 pane command——pane-command composition 完全位于
// `view-composer.ts`，后者发出 provider-neutral `ComposedPane.paneCommand` string。provider
// 只负责 placement + labeling + liveness。无论由哪个 provider 绘制 tile，此拆分都将 composition
// rule（local 与 ssh、http honest-degrade、只读 `-r`、paging）集中在一个纯且可测试的位置。
//
// 唯一共享的 result shape 为 `{ opened, absent, degraded }`（BR-6 honest-partial）：
// 只能部分渲染的 view 会明确说明，绝不静默遗漏。

/**
 * 完整组合的单个 provider-neutral pane。`paneCommand` 是 provider 在 pane 内运行的精确
 * shell command（例如 `tmux attach -t 's'` 或 `ssh host tmux attach -r -t 's'`）；
 * provider 不会修改它。
 */
export interface ComposedPane {
  /** 此 pane 所附加 seat 的 canonical session name。 */
  seat: string;
  /** 人类可读 pane label——按 AC-7 为 `<agent> · <slice>`。 */
  label: string;
  /** pane 运行的 provider-neutral shell command，由上游组合。 */
  paneCommand: string;
  /** attach 仅供查看（`tmux attach -r`）时为 true——cross-rig / saved read-only。 */
  readOnly: boolean;
}

/** 因没有 live/attachable session 而无法平铺的 seat。具名保留，绝不丢弃。 */
export interface AbsentSeat {
  seat: string;
  /** seat 为 remote 时的结构化 host id；local seat 为 null。 */
  host: string | null;
  reason: string;
}

/** 如实降级的 seat（例如已通过 http 注册、但 tile 无法经 ssh 到达的 host）。 */
export interface DegradedSeat {
  seat: string;
  /** 结构化 host id（degrade 始终由 host 驱动）。 */
  host: string;
  reason: string;
}

/**
 * 完整组合的 view：`composeView` 的 provider-neutral 输出。`opened` 是平铺后的扁平集合；
 * `pages` 是按固定大小 grid 分块后的同一集合（每页一个 provider tab/workspace）。
 */
export interface ComposedView {
  id: string;
  opened: ComposedPane[];
  absent: AbsentSeat[];
  degraded: DegradedSeat[];
  /** `opened` 被分为不超过 PANES_PER_PAGE 的 grid；provider 每页渲染一个 tab。 */
  pages: ComposedPane[][];
}

/** Provider availability + version + capability map（来自 version-adaptive probe）。 */
export interface ProviderStatus {
  provider: string;
  available: boolean;
  /** probe 能确定时的 provider version；未知时省略。 */
  version?: string;
  capabilities: Record<string, boolean>;
}

/** provider surface 自身的 liveness（herdr：`herdr status`；不是 daemon ping）。 */
export interface ProviderLiveness {
  alive: boolean;
  /** 可选的如实详情（未存活原因 / probe note）。 */
  detail?: string;
}

/**
 * 渲染 composed view 的结果。`opened` 列出实际放入 pane 的 seat；`absent`/`degraded`
 * 透传 composer 的 honest-partial classification（provider 可添加自身 degrade，例如渲染失败的
 * pane）。`pages` 是已绘制 grid page 的数量。
 */
export interface OpenViewResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: AbsentSeat[];
  degraded: DegradedSeat[];
  pages: number;
  /** 仅在 provider 硬失败（surface 不可达、layout apply 被拒绝）时存在。 */
  error?: string;
  code?: string;
  /** 用户应知晓的 open 过程自然语言事实（例如带 suffix 的 workspace name，或 provider
   *  拒绝的 focus step）。 */
  notes?: string[];
}

/**
 * provider contract。仅有三个方法：
 *  - `status()`   —— 可用性 + 版本 + 能力（版本自适应探测）。
 *  - `liveness()` —— provider surface 当前是否运行。
 *  - `openView()` —— 将已组合的 view 渲染到 provider surface。
 *
 * pane-command composition 刻意不属于此 interface。
 */
export interface TerminalProvider {
  readonly name: string;
  /** 此 provider 每页布局的 pane 数；缺失时 composer 使用 PANES_PER_PAGE。 */
  readonly panesPerPage?: number;
  status(): Promise<ProviderStatus>;
  liveness(): Promise<ProviderLiveness>;
  openView(view: ComposedView): Promise<OpenViewResult>;
}
