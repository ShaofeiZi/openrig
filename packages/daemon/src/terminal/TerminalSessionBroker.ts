import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TmuxResult, TmuxCursorPosition } from "../adapters/tmux.js";

// OPR.0.4.0.38——真实终端 session broker。
//
// 创始人给出的产品不变量：实时终端绝不说谎。实时终端界面必须显示真实 session 状态，并在
// session 终止时如实报告，绝不能保留静默陈旧的“实时”pane。
//
// 此 slice 之前，每个 WebSocket 连接都会为同一 session 打开自己的 tmux pipe-pane
//（逐连接缺陷）：同一席位的第二个查看者会与第一个争抢输出。broker 将其修复为：每个 session
// 一个 tmux pipe、多个订阅者、向所有订阅者扇出输出；每个订阅者连接时先获得当前屏幕的光标
// 安全快照；固定几何尺寸（客户端不可调整）；向所有订阅者如实报告 session 终止；最后一个
// 订阅者离开时完整清理。

const PIPE_PANE_POLL_MS = 50;
const MAX_OUTPUT_BUFFER = 64 * 1024;
const DEFAULT_LIVENESS_MS = 2000;

/**
 * broker 所有的近期输出历史环的有界大小（AC-5/FR-4）。镜像每次读取 64KB 的尾部大小：
 * session 级近期输出窗口会重放给后来订阅者，使其共享早先订阅者拥有的 scrollback，而不是逐
 * xterm 本地保存。设置上限可防止长寿命 session 无限占用内存。
 */
const MAX_HISTORY_BYTES = 64 * 1024;

/**
 * Canonical 固定终端几何尺寸（FR-7）。90 列（OPR.0.4.0.39，创始人指定）：Claude Code
 *（Ink）与 Codex CLI 都是响应式 TUI，会按给定宽度重排，没有必需宽度；80 是用户认为过窄的
 * legacy 回退值，因此 90 明显高于 80 下限，同时窄于 120，使缩放后的静态/实时镜像在拓扑网格
 * 单元中显示得更大、更易读。27 行形成经典终端的 1.72:1 横向比例（90x27 约 650x378px，
 * 对应 canonical 80x24 比例），同时保持可用的智能体 TUI 高度；订阅者可适配/滚动/平移自己的
 * viewport，但绝不调整 pane 大小，因此多个查看者无法把 session 缩到最小查看者的尺寸。必须与
 * 客户端孪生 LIVE_TERMINAL_COLS（packages/ui/.../terminal/terminal-geometry.ts）保持同步；
 * xterm 网格必须匹配 pane。
 */
export const CANONICAL_COLS = 90;
export const CANONICAL_ROWS = 27;

/** broker 的一个已连接查看者；路由把 WebSocket 适配到此接口。 */
export interface TerminalSubscriber {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * broker 驱动的 TmuxAdapter 子集。以结构方式声明，使 broker 可用普通 mock 做单元测试；
 * 真实 TmuxAdapter 满足此接口。
 */
export interface BrokerTmux {
  humanInput?<T>(name: string, fn: () => Promise<T>): Promise<T>;
  hasSession(name: string): Promise<boolean>;
  setWindowOption(name: string, option: string, value: string): Promise<TmuxResult>;
  resizeWindow(name: string, cols: number, rows: number): Promise<TmuxResult>;
  startPipePane(name: string, outputPath: string): Promise<TmuxResult>;
  stopPipePane(name: string): Promise<TmuxResult>;
  sendKeys(name: string, keys: string[]): Promise<TmuxResult>;
  sendText(name: string, text: string): Promise<TmuxResult>;
  capturePaneScreen(name: string): Promise<string | null>;
  getPaneCursorPosition(name: string): Promise<TmuxCursorPosition | null>;
  /** 捕获最后 `lines` 行，包括 scrollback 历史（tmux capture-pane -S -lines）。
   * 用于逐订阅者 scroll-back 窗口。 */
  capturePaneContent(name: string, lines: number): Promise<string | null>;
}

export interface BrokerOptions {
  /** 文件尾部轮询间隔（ms），默认 50。 */
  pollMs?: number;
  /** Session 活性探测间隔（ms），默认 2000。 */
  livenessMs?: number;
  /** Canonical pane 宽度，默认 CANONICAL_COLS（90）。 */
  cols?: number;
  /** Canonical pane 高度，默认 CANONICAL_ROWS（27）。 */
  rows?: number;
  /** 近期输出历史环的字节上限，默认 64KB。 */
  maxHistoryBytes?: number;
  /** broker 没有剩余订阅者（或打开失败）时调用。 */
  onEmpty?: (sessionName: string) => void;
}

/** 客户端驱动的输入。有意不提供 resize 消息（FR-7）。 */
export type TerminalInputMessage =
  | { type: "keys"; keys: string[] }
  | { type: "text"; text: string };

/** ANSI 从 1 开始的绝对光标移动（终端坐标从 1 开始，tmux 从 0 开始）。 */
export function cursorPositionEscape(x: number, y: number): string {
  return `\x1b[${y + 1};${x + 1}H`;
}

/**
 * 为捕获的屏幕构建光标安全的初始转义序列。每行都以绝对光标移动绘制，使客户端在与 tmux
 * 完全相同的行渲染屏幕，而不是随内容滚动产生偏移的相对追加。规范化 CRLF，移除一个尾部打印
 * 换行；已知 pane 高度且捕获内容更高时，只保留最后 `height` 行。源自 FR-4 seed 工作。
 */
export function screenSnapshotEscape(
  snapshot: string,
  cursor: { x: number; y: number; height?: number } | null,
): string {
  const normalized = snapshot.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutTrailingPrintNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  const rows = withoutTrailingPrintNewline.split("\n");
  const visibleRows = cursor?.height && rows.length > cursor.height
    ? rows.slice(rows.length - cursor.height)
    : rows;

  const paintedRows = visibleRows
    .map((row, index) => `\x1b[${index + 1};1H${row}`)
    .join("");

  return `\x1b[2J${paintedRows}${cursor ? cursorPositionEscape(cursor.x, cursor.y) : "\x1b[H"}`;
}

/**
 * 全屏 TUI 的原始 pipe 输出是重绘流，不是持久 scrollback。在当前快照前向全新 xterm 重放按
 * 光标寻址的历史，会使陈旧提示/状态行出现在真实屏幕上方或下方。对普通行输出（及简单 SGR
 * 颜色）保留 AC-5 共享历史行为，但跳过含光标移动、擦除、备用屏幕、OSC 或回车重绘语义的历史。
 */
export function isSafeHistoryReplay(data: string): boolean {
  if (!data) return false;
  if (/\r(?!\n)/.test(data)) return false;

  const escapePattern = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[\(\)][ -~]|[@-Z\\-_])/g;
  let match: RegExpExecArray | null;
  while ((match = escapePattern.exec(data)) !== null) {
    const sequence = match[0];
    const final = sequence.at(-1);
    if (final !== "m") return false;
  }
  return true;
}

/**
 * 每个实时 tmux session 一个 broker。拥有单个 pipe-pane，并向每个已连接订阅者扇出输出。
 */
export class TerminalSessionBroker {
  readonly sessionName: string;
  private readonly tmux: BrokerTmux;
  private readonly pollMs: number;
  private readonly livenessMs: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly maxHistoryBytes: number;
  private readonly onEmpty?: (sessionName: string) => void;

  private readonly subscribers = new Set<TerminalSubscriber>();
  // OPR.0.4.0.39：逐订阅者 scroll-back 偏移（实时底部上方的行数）。0/缺失 = 实时。已滚动的
  // 订阅者会绘制 tmux 历史窗口，并被实时扇出跳过（避免实时输出把它拉回底部）；对 pane 只读
  //（capture-pane），因此每个查看者独立滚动，不会干扰他人的实时视图（多订阅者安全的
  // scrollback，而非 pane 全局 copy-mode）。
  private readonly scrollOffsets = new Map<TerminalSubscriber, number>();
  // broker 所有的近期输出环（AC-5）：有界的原始扇出字节，重放给后来订阅者，使其 scrollback
  // 与早先订阅者一致。
  private history: string[] = [];
  private historyBytes = 0;
  private outputPath: string | null = null;
  private pipeActive = false;
  private tailInterval: ReturnType<typeof setInterval> | null = null;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;
  private lastSize = 0;
  private inputQueue: Promise<void> = Promise.resolve();
  // 将 pipe-open singleflight 化为共享 promise，使所有并发 attach 在 seed/add 前等待同一个打开
  // 结果（裸 boolean 会让后来的 attach 在打开结果未知时加入；若打开失败，它将永远不会关闭）。
  // 第一次 attach 开始打开前为 null。
  private openPromise: Promise<{ ok: true } | { ok: false; code: number; reason: string }> | null = null;
  private tailStarted = false;
  private torndown = false;
  // 订阅者在异步 open/seed 后恢复，却发现 broker 已销毁时应收到的真实关闭原因。每条 teardown
  // 路径都设置它，使延迟/竞态 attach 绝不会静默进入貌似实时的状态。
  private lastClose: { code: number; reason: string } | null = null;

  constructor(sessionName: string, tmux: BrokerTmux, opts: BrokerOptions = {}) {
    this.sessionName = sessionName;
    this.tmux = tmux;
    this.pollMs = opts.pollMs ?? PIPE_PANE_POLL_MS;
    this.livenessMs = opts.livenessMs ?? DEFAULT_LIVENESS_MS;
    this.cols = opts.cols ?? CANONICAL_COLS;
    this.rows = opts.rows ?? CANONICAL_ROWS;
    this.maxHistoryBytes = opts.maxHistoryBytes ?? MAX_HISTORY_BYTES;
    this.onEmpty = opts.onEmpty;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** broker 所有历史环的当前字节数（有界）。 */
  get historyByteLength(): number {
    return this.historyBytes;
  }

  /** session 范围的 pipe 输出文件（每个 session 一个）。打开前为 null。 */
  get pipeOutputPath(): string | null {
    return this.outputPath;
  }

  /**
   * 连接订阅者。第一个订阅者建立唯一 pipe-pane（固定几何尺寸、一个 outputPath、tail +
   * liveness）。每个订阅者无论先后，都在加入扇出前以当前屏幕初始化，因此会立即看到一致状态，
   * 且不依赖 resize 消息。
   */
  async attach(sub: TerminalSubscriber): Promise<void> {
    if (this.torndown) {
      this.closeTorndown(sub);
      return;
    }
    // 只启动一次 pipe-open；每个并发 attach 在 seed/add 前等待同一个结果。
    if (!this.openPromise) {
      this.openPromise = this.openPipe();
    }
    const open = await this.openPromise;

    // 等待期间 broker 可能已被销毁——共同等待者的打开失败，或 session 已终止。如实关闭当前
    // 订阅者；绝不在已死亡 broker 上留下貌似实时的订阅者（实时终端不说谎规则）。
    if (this.torndown) {
      this.closeTorndown(sub);
      return;
    }

    if (!open.ok) {
      // 打开失败：记录原因，只销毁一次，然后关闭当前订阅者。所有共同等待者都走已销毁分支，
      // 并以同一已记录原因关闭，不留下任何实时连接。
      this.lastClose = { code: open.code, reason: open.reason };
      this.torndown = true;
      this.teardownResources();
      this.onEmpty?.(this.sessionName);
      sub.close(open.code, open.reason);
      return;
    }

    // 打开成功：在订阅者加入扇出前，以环重放 + 当前屏幕初始化它。
    await this.seed(sub);
    // 异步 seed 后重新检查：捕获等待期间 liveness/dispose 可能已销毁 broker。绝不把订阅者加入
    // 已死亡 broker；用已记录的销毁原因如实关闭它。
    if (this.torndown) {
      this.closeTorndown(sub);
      return;
    }
    this.subscribers.add(sub);
    if (!this.tailStarted) {
      this.tailStarted = true;
      this.startTail();
      this.startLiveness();
    }
  }

  /** 使用已记录原因关闭在 teardown 后恢复的订阅者。 */
  private closeTorndown(sub: TerminalSubscriber): void {
    const c = this.lastClose ?? { code: 1011, reason: "终端 broker 不可用" };
    try {
      sub.close(c.code, c.reason);
    } catch {
      // 订阅者已关闭也无妨。
    }
  }

  /** 将客户端输入转发给 tmux；串行化处理，使快速输入保持顺序（FR-3）。 */
  async input(msg: TerminalInputMessage): Promise<void> {
    if (this.torndown) return;
    await this.enqueueInput(async () => {
      const write = async () => {
        if (msg.type === "keys") await this.tmux.sendKeys(this.sessionName, msg.keys);
        else if (msg.type === "text") await this.tmux.sendText(this.sessionName, msg.text);
      };
      if (this.tmux.humanInput) await this.tmux.humanInput(this.sessionName, write);
      else await write();
    });
  }

  /**
   * OPR.0.4.0.39：逐订阅者 scroll-back。`offset` = 实时底部上方的行数（0 = 实时）。通过
   * capture-pane 读取 tmux scrollback（对 pane 只读，因此绝不干扰其他订阅者的实时视图），
   * 并只向当前订阅者绘制窗口化历史。offset 为 0 时重绘当前屏幕，订阅者重新加入实时扇出。
   */
  async scroll(sub: TerminalSubscriber, offset: number): Promise<void> {
    if (this.torndown || !this.subscribers.has(sub)) return;
    const clamped = Math.max(0, Math.floor(offset));
    if (clamped === 0) {
      this.scrollOffsets.delete(sub);
      await this.repaintScreen(sub);
      return;
    }
    this.scrollOffsets.set(sub, clamped);
    // tmux `capture-pane -p -S -(offset+rows)` 返回以实时底部结束的缓冲区（真实 tmux 已验证：
    // `-S -N` 返回可见屏幕上方约 N 行历史加当前屏幕，并以底行结束）。要显示实时底部上方
    // `offset` 行的窗口，切片必须锚定底部：丢弃末尾朝实时方向的 `offset` 行，再取其上方的
    // `rows` 行。若取顶部 `rows`，第一次滚轮操作就会额外向上跳整屏。
    let content: string | null = null;
    try {
      content = await this.tmux.capturePaneContent(this.sessionName, clamped + this.rows);
    } catch {
      content = null;
    }
    if (content === null) return;
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    // 移除一个尾部空行（capture-pane 的尾随换行），使最后一个元素是真正的实时底行，
    // 保证 offset 如实。
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const bottom = lines.length - clamped; // 不含结束位置：窗口位于上方 `offset` 行处。
    const window = bottom <= this.rows
      ? lines.slice(0, this.rows) // 已滚到/越过历史顶部：显示最早的一屏。
      : lines.slice(bottom - this.rows, bottom);
    try {
      sub.send(screenSnapshotEscape(window.join("\n"), null));
    } catch { /* dead subscriber */ }
  }

  /** 只为一个订阅者重绘当前可见屏幕（scroll-back 回到实时）。 */
  private async repaintScreen(sub: TerminalSubscriber): Promise<void> {
    let snapshot: string | null = null;
    let cursor: TmuxCursorPosition | null = null;
    try { snapshot = await this.tmux.capturePaneScreen(this.sessionName); } catch { snapshot = null; }
    try { cursor = await this.tmux.getPaneCursorPosition(this.sessionName); } catch { cursor = null; }
    if (snapshot !== null) {
      try { sub.send(screenSnapshotEscape(snapshot, cursor)); } catch { /* 已断开 */ }
    }
  }

  /**
   * 分离订阅者。仍有其他订阅者时 broker 继续存活（FR-6）；最后一个订阅者分离时销毁 pipe
   * 并删除临时文件。
   */
  detach(sub: TerminalSubscriber): void {
    if (!this.subscribers.delete(sub)) return;
    this.scrollOffsets.delete(sub);
    if (this.subscribers.size === 0) {
      void this.teardown();
    }
  }

  /** 强制 teardown（由 registry/route 在关闭时及测试中使用）。 */
  dispose(): void {
    if (this.torndown) return;
    this.lastClose = { code: 1011, reason: "终端 broker 不可用" };
    this.torndown = true;
    this.subscribers.clear();
    this.scrollOffsets.clear();
    if (this.pipeActive) {
      this.pipeActive = false;
      void this.tmux.stopPipePane(this.sessionName).catch(() => {});
    }
    this.teardownResources();
    this.onEmpty?.(this.sessionName);
  }

  private async openPipe(): Promise<{ ok: true } | { ok: false; code: number; reason: string }> {
    // 关闭码镜像 broker 之前的路由，使 UI 保持其语义：1008（policy）= session 确实不存在；
    // 1011（server error）= pipe/临时文件机制失败。两者都如实反映状态。
    const alive = await this.tmux.hasSession(this.sessionName);
    if (!alive) return { ok: false, code: 1008, reason: `未找到 session：${this.sessionName}` };

    // FR-7 固定几何尺寸：将 window-size 设为 manual，使 tmux 不会自动缩到最小已连接客户端；
    // 随后只设置一次 canonical 宽高。有意不使用 aggressive-resize，后者会产生相反效果。
    await this.tmux.setWindowOption(this.sessionName, "window-size", "manual").catch(() => {});
    await this.tmux.resizeWindow(this.sessionName, this.cols, this.rows).catch(() => {});

    const outputPath = path.join(
      os.tmpdir(),
      `openrig-term-${this.sessionName.replace(/[^a-zA-Z0-9@-]/g, "_")}-${Date.now()}.log`,
    );
    try {
      fs.writeFileSync(outputPath, "", "utf-8");
    } catch (err) {
      return { ok: false, code: 1011, reason: `pipe 输出文件失败：${String(err)}` };
    }
    this.outputPath = outputPath;

    const pipe = await this.tmux.startPipePane(this.sessionName, outputPath);
    if (!pipe.ok) {
      return { ok: false, code: 1011, reason: `pipe-pane 失败：${pipe.message}` };
    }
    this.pipeActive = true;

    // 触发一次重绘，使刚连接的 pipe 捕获当前 pane 内容（与之前单连接行为一致；FR-9 无回归）。
    await this.tmux.sendKeys(this.sessionName, ["", ""]).catch(() => {});
    return { ok: true };
  }

  private async seed(sub: TerminalSubscriber): Promise<void> {
    // AC-5：先重放 broker 所有的近期输出环，使后来订阅者的 xterm 对普通终端流构建出与早先
    // 订阅者相同的 scrollback。按光标寻址的 TUI 重绘历史不是 scrollback；重放会破坏后来订阅者，
    // 因此这些 session 只从当前可见屏幕快照初始化。
    if (this.historyBytes > 0) {
      const history = this.history.join("");
      if (isSafeHistoryReplay(history)) {
        try { sub.send(history); } catch { /* 已断开的订阅者 */ }
      }
    }
    // 尽力而为：捕获失败（或 adapter 没有 seed 方法）绝不能中断 attach；tail 仍会传输实时输出。
    let snapshot: string | null = null;
    let cursor: TmuxCursorPosition | null = null;
    try {
      snapshot = await this.tmux.capturePaneScreen(this.sessionName);
    } catch {
      snapshot = null;
    }
    try {
      cursor = await this.tmux.getPaneCursorPosition(this.sessionName);
    } catch {
      cursor = null;
    }
    if (snapshot != null) {
      try {
        sub.send(screenSnapshotEscape(snapshot, cursor));
      } catch {
        // 已断开的订阅者在此无害；路由会自行处理关闭。
      }
    }
  }

  private startTail(): void {
    if (this.tailInterval) return;
    this.tailInterval = setInterval(() => {
      const p = this.outputPath;
      if (!p) return;
      try {
        const stat = fs.statSync(p);
        if (stat.size > this.lastSize) {
          const fd = fs.openSync(p, "r");
          const buf = Buffer.alloc(Math.min(stat.size - this.lastSize, MAX_OUTPUT_BUFFER));
          fs.readSync(fd, buf, 0, buf.length, this.lastSize);
          fs.closeSync(fd);
          this.lastSize += buf.length;
          this.fanout(buf.toString("utf-8"));
        }
      } catch {
        // 容忍瞬态 stat/read 失败；死亡判定归 liveness 所有。
      }
    }, this.pollMs);
  }

  private fanout(data: string): void {
    // 从执行扇出的同一个 tail 填充 broker 所有的环，使后来订阅者可在进入实时状态前重放近期窗口
    //（AC-5）。
    this.appendHistory(data);
    // 单个订阅者发送时抛错不得中断向其他订阅者投递，并应干净分离（发送抛错表示 socket 已死）。
    let dead: TerminalSubscriber[] | null = null;
    for (const sub of this.subscribers) {
      // OPR.0.4.0.39：回滚到历史中的订阅者正在查看静态 tmux 捕获窗口；跳过实时扇出，避免
      // 输出覆盖它。滚回底部（offset 0）时重新加入实时。
      if ((this.scrollOffsets.get(sub) ?? 0) > 0) continue;
      try {
        sub.send(data);
      } catch {
        (dead ??= []).push(sub);
      }
    }
    // 循环结束后再分离，避免迭代期间修改集合。
    if (dead) {
      for (const sub of dead) this.detach(sub);
    }
  }

  /** 追加到有界环，超过字节上限时丢弃最旧的数据块。 */
  private appendHistory(data: string): void {
    if (!data) return;
    this.history.push(data);
    this.historyBytes += Buffer.byteLength(data, "utf-8");
    // 至少保留最新的数据块，使单次大爆发不会被完全丢弃；其余情况下丢弃最旧块，直到回到上限内。
    while (this.historyBytes > this.maxHistoryBytes && this.history.length > 1) {
      const dropped = this.history.shift()!;
      this.historyBytes -= Buffer.byteLength(dropped, "utf-8");
    }
  }

  private startLiveness(): void {
    if (this.livenessInterval) return;
    this.livenessInterval = setInterval(() => {
      this.tmux
        .hasSession(this.sessionName)
        .then((alive) => {
          if (!alive) this.handleSessionDeath();
        })
        .catch(() => {
          this.handleSessionDeath();
        });
    }, this.livenessMs);
  }

  /** FR-5：已死亡 session 如实关闭所有订阅者，绝不静默保留陈旧实时状态。 */
  private handleSessionDeath(): void {
    if (this.torndown) return;
    this.lastClose = { code: 1001, reason: "tmux session 已终止" };
    this.torndown = true;
    const subs = [...this.subscribers];
    this.subscribers.clear();
    if (this.pipeActive) {
      this.pipeActive = false;
      void this.tmux.stopPipePane(this.sessionName).catch(() => {});
    }
    this.teardownResources();
    for (const sub of subs) {
      try {
        sub.close(1001, "tmux session 已终止");
      } catch {
        // 订阅者已关闭也无妨。
      }
    }
    this.onEmpty?.(this.sessionName);
  }

  private async teardown(): Promise<void> {
    if (this.torndown) return;
    this.lastClose = { code: 1011, reason: "终端 broker 不可用" };
    this.torndown = true;
    if (this.pipeActive) {
      this.pipeActive = false;
      await this.tmux.stopPipePane(this.sessionName).catch(() => {});
    }
    this.teardownResources();
    this.onEmpty?.(this.sessionName);
  }

  private teardownResources(): void {
    if (this.tailInterval) {
      clearInterval(this.tailInterval);
      this.tailInterval = null;
    }
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
    if (this.outputPath) {
      try {
        fs.unlinkSync(this.outputPath);
      } catch {
        // 临时文件可能已不存在。
      }
      this.outputPath = null;
    }
    this.lastSize = 0;
    // 清空历史环，使已销毁的 broker 不会泄漏保留输出。
    this.history = [];
    this.historyBytes = 0;
  }

  private enqueueInput(op: () => Promise<void>): Promise<void> {
    const run = this.inputQueue.then(op, op);
    this.inputQueue = run.catch(() => {});
    return run;
  }
}

/**
 * 后台服务所有的 broker registry，以 canonical session 名称为键。某 session 的第一个订阅者
 * 到来时创建 broker，后续订阅者复用（每个 session 只存在一个 pipe-pane）；为空时驱逐。
 */
export class TerminalBrokerRegistry {
  private readonly brokers = new Map<string, TerminalSessionBroker>();

  constructor(private readonly tmux: BrokerTmux, private readonly opts: BrokerOptions = {}) {}

  get size(): number {
    return this.brokers.size;
  }

  get(sessionName: string): TerminalSessionBroker | undefined {
    return this.brokers.get(sessionName);
  }

  /** 获取或创建 session 的 broker，连接订阅者并返回 broker。 */
  async attach(sessionName: string, sub: TerminalSubscriber): Promise<TerminalSessionBroker> {
    let broker = this.brokers.get(sessionName);
    if (!broker) {
      broker = new TerminalSessionBroker(sessionName, this.tmux, {
        ...this.opts,
        onEmpty: (name) => {
          this.brokers.delete(name);
          this.opts.onEmpty?.(name);
        },
      });
      this.brokers.set(sessionName, broker);
    }
    await broker.attach(sub);
    return broker;
  }
}
