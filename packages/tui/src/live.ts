import { PageRead } from "./page-read.js";
// S19 ROUND-5（防护 NOT-CLEAR at b92c2a58）——刷新所有者——唯一
// 知道水合实际在飞行中、以及哪个席位在两次刷新之间
// 产生了新窗格输出的组件。renderScreen 保持纯，
// 通过 RenderOptions 消费此状态；main.ts 将其接线到终端。
//
// 事件身份（发现 2）：服务端 `terminalActive` 派生自 tmux
// `#{window_activity}`（SeatActivityService），一个 tmux 仅在
// 窗口收到输出时推进的时间戳。因此 false→true 转换
// 不可能在没有真实新窗格输出的情况下发生——一个诚实的静默后起始
// 事件，零误报。已知底层限制（已标记给防护）：
// 投影仅服务派生布尔值，而非原始时间戳，因此
// 席位已处于活动时到达的输出无法重新触发；
// 静默窗口后的起始是可观察事件。
import { singleFlight } from "./refresh.js";
import { emptySnapshot } from "./state.js";
import type { FleetSnapshot, LoadState, RowFlash } from "./types.js";

/** 一次性闪烁窗口（ms）——匹配 renderScreen 的 flashActive 窗口 */
export const FLASH_WINDOW_MS = 600;
/** 每个安静后台服务采样窗口一次被动整快照读取。 */
export const QUIET_REFRESH_MS = 30_000;

export interface QuietTimerHandle {
  unref?: () => void;
}

export interface LiveRefreshDeps {
  hydrate: (page: PageRead, signal: AbortSignal) => Promise<FleetSnapshot>;
  scopeKey?: () => string;
  /** 绘制回调——在加载生命周期或数据变化时调用，使
   *  飞行中帧在开始时实际绘制并在稳定时清除 */
  onFrame: () => void;
  now: () => number;
  /** 由确定性测试注入；生产使用 Node 超时 */
  setTimeout?: (callback: () => void, delayMs: number) => QuietTimerHandle;
  clearTimeout?: (handle: QuietTimerHandle) => void;
}

export interface LiveRefresh {
  /** 运行一次刷新（单飞）；绝不 reject——失败的水合
   *  释放飞行中，保留先前快照，下次调用重试 */
  refresh: () => Promise<void>;
  invalidate: () => Promise<void>;
  connectionStatus: (status: NonNullable<LoadState["connection"]>) => void;
  snapshot: () => FleetSnapshot;
  load: () => LoadState;
  flashes: () => RowFlash[];
  /** TUI 关闭期间停止安静回退 */
  close: () => void;
}

/** 遍历快照拓扑并按资源管理器行携带的
 *  相同稳定键为每个智能体的服务端窗格活动布尔值建键 */
function paneActivity(snap: FleetSnapshot): Map<string, boolean | null | undefined> {
  const map = new Map<string, boolean | null | undefined>();
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents)
          map.set(`agent:${host.name}/${rig.name}/${pod.name}/${agent.name}`, agent.paneActive);
  return map;
}

export function createLiveRefresh(deps: LiveRefreshDeps): LiveRefresh {
  let invalidation = 0;
  let lastConfirmedAt: number | null = null;
  let snapshot = emptySnapshot();
  let load: LoadState = { inFlight: false, settled: false };
  let flashes: RowFlash[] = [];
  let scope = deps.scopeKey?.() ?? "";
  let generation = 0;
  let controller = new AbortController();
  let page = new PageRead(deps.now, forgetDenied);
  // 此客户端本地的有界历史。返回重新验证页面自己的读取。
  const pages = new Map<string, { page: PageRead; snapshot: FleetSnapshot; load: LoadState; lastConfirmedAt: number | null }>();
  function forgetDenied(url: string): void {
    // 一个视图中的拒绝也使该相同 URL 的历史视图失效。
    // 无关页面和此页面中成功的兄弟读取保持完整。
    for (const [key, entry] of pages) if (entry.page.has(url)) pages.delete(key);
  }
  function syncScope(): void {
    const next = deps.scopeKey?.() ?? "";
    if (next === scope) return;
    pages.delete(scope);
    pages.set(scope, { page, snapshot, load: { ...load, inFlight: false }, lastConfirmedAt });
    while (pages.size > 12) pages.delete(pages.keys().next().value!);
    const prior = pages.get(next);
    const navigator = snapshot;
    scope = next; generation += 1; controller.abort(); controller = new AbortController();
    page = prior?.page ?? new PageRead(deps.now, forgetDenied);
    snapshot = prior?.snapshot ?? { ...emptySnapshot(), hosts: navigator.hosts, specs: navigator.specs,
      projects: navigator.projects, projectRead: navigator.projectRead, scopes: navigator.scopes,
      terminals: navigator.terminals && { catalog: navigator.terminals.catalog, catalogLoaded: navigator.terminals.catalogLoaded, preview: null } };
    flashes = [];
    lastConfirmedAt = prior?.lastConfirmedAt ?? null;
    load = prior ? { ...prior.load, stale: true, inFlight: false } : { inFlight: false, settled: false };
    // 旧传输可能需要时间展开。它不能延迟新页面。
    const expected = generation;
    runRefresh = singleFlight(() => expected === generation ? readPage() : Promise.resolve());
  }
  let quietTimer: QuietTimerHandle | null = null;
  let closed = false;
  let refresh: () => Promise<void>;
  const scheduleTimeout = deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelTimeout = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  function clearQuietTimer(): void {
    if (quietTimer === null) return;
    cancelTimeout(quietTimer);
    quietTimer = null;
  }

  function armQuietTimer(): void {
    clearQuietTimer();
    if (closed) return;
    quietTimer = scheduleTimeout(() => {
      quietTimer = null;
      void refresh();
    }, QUIET_REFRESH_MS);
    quietTimer.unref?.();
  }

  const readPage = async () => {
    clearQuietTimer();
    syncScope();
    const startedGeneration = generation;
    const activePage = page;
    activePage.begin();
    const startedAtInvalidation = invalidation;
    load.inFlight = true;
    deps.onFrame();
    try {
      const next = await deps.hydrate(activePage, controller.signal);
      syncScope();
      if (startedGeneration !== generation || closed) return;
      activePage.end();
      next.readErrors = [...new Set([...next.readErrors, ...activePage.errors])];
      load.retainedAt = activePage.retainedAt;
      if (load.settled) {
        // 第一次水合是加载，不是新输出——无闪烁；null（无
        // 信号）也绝不闪烁：仅服务端 false→true 转换
        const prev = paneActivity(snapshot);
        const now = deps.now();
        flashes = flashes.filter((f) => now - f.at < FLASH_WINDOW_MS);
        for (const [key, active] of paneActivity(next))
          if (active === true && prev.get(key) === false) flashes.push({ key, at: now });
      }
      snapshot = next;
      load.stale = startedAtInvalidation !== invalidation || next.readErrors.length > 0;
      if (!load.stale) lastConfirmedAt = deps.now();
      load.lastSuccessAt = lastConfirmedAt ?? undefined;
    } catch {
      if (startedGeneration !== generation || closed) return;
      load.stale = true;
      // 拒绝释放：先前快照保留（无伪造），
      // 飞行中在下面清除，下次请求的刷新重试
    } finally {
      if (startedGeneration !== generation || closed) return;
      load.inFlight = false;
      load.settled = true;
      deps.onFrame();
      armQuietTimer();
    }
  };
  let runRefresh = singleFlight(() => generation === 0 ? readPage() : Promise.resolve());

  refresh = () => {
    if (closed) return Promise.resolve();
    syncScope();
    clearQuietTimer();
    return runRefresh();
  };

  return {
    refresh,
    invalidate: () => { invalidation += 1; load.stale = true; return refresh(); },
    connectionStatus: (status) => {
      load.connection = status;
      if (status !== "connected") load.stale = true;
      else void refresh();
      deps.onFrame();
    },
    snapshot: () => { syncScope(); return snapshot; },
    load: () => { syncScope(); return { ...load, ...(lastConfirmedAt !== null && deps.now() - lastConfirmedAt > 60_000 ? { stale: true } : {}) }; },
    flashes: () => [...flashes],
    close: () => {
      closed = true;
      controller.abort();
      clearQuietTimer();
    },
  };
}
