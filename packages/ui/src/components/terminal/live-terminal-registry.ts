// OPR.0.4.0.1 —— 全局实时终端上限注册表。
//
// PM 锁定架构（并发 qitem-20260621004748-63ec48b1）：
//   - 上限是全局的：图 + 表格 + 拓扑表面同时实时的终端总数必须 <= MAX_LIVE_TERMINALS；
//   - 超过上限打开实时终端会驱逐最旧的实时终端，该终端回退到静态模式
//    （其回退回调关闭 WS + 渲染静态预览——无 WS 泄漏）。它是被回退，不是被移除。
//
// 这是无框架核心（纯类）。React 上下文（LiveTerminalProvider）包装单一实例，
// 挂载在三个表面之上，使上限真正全局。保持纯函数，使上限/驱逐逻辑
// 无需渲染 xterm/WebSocket 即可单元测试。

/** OPR.0.4.0.1 —— 唯一命名的默认上限（PM 决定：2；根据性能数据可调整为 3）。
 *  这是默认值的唯一位置；配置键 `ui.terminal.max_live_terminals`（后台服务支持）
 *  在运行时覆盖它，因此 2 → 3 的变更只需改一处默认值/一个配置，不需重写代码。 */
export const MAX_LIVE_TERMINALS = 2;

export class LiveTerminalRegistry {
  /** 按插入顺序排列的实时键——索引 0 是最旧的（最先被驱逐）。 */
  private order: string[] = [];
  /** key -> 其回退到静态的回调（驱逐时运行）。 */
  private reverts = new Map<string, () => void>();
  private readonly cap: number;

  constructor(cap: number) {
    // 错误/零上限绝不能意味着"永远不能有终端实时"；下限为 1。
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** 标记 `key` 为实时。如果已实时，刷新其最近度（它变为最新，因此最后被驱逐）。
   *  否则驱逐最旧的实时终端直到有空间，然后接纳 `key`。被驱逐的终端会调用
   *  其 `revertToStatic` 回调。 */
  requestLive(key: string, revertToStatic: () => void): void {
    if (this.reverts.has(key)) {
      this.touch(key);
      this.reverts.set(key, revertToStatic);
      return;
    }
    while (this.order.length >= this.cap) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      const revert = this.reverts.get(oldest);
      this.reverts.delete(oldest);
      revert?.();
    }
    this.order.push(key);
    this.reverts.set(key, revertToStatic);
  }

  /** 释放 `key` 的槽位，不驱逐（例如卸载或手动回退时）。
   *  不运行回退回调——调用者已转为静态。幂等。 */
  release(key: string): void {
    if (!this.reverts.has(key)) return;
    this.reverts.delete(key);
    this.order = this.order.filter((k) => k !== key);
  }

  isLive(key: string): boolean {
    return this.reverts.has(key);
  }

  get size(): number {
    return this.order.length;
  }

  private touch(key: string): void {
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
  }
}
