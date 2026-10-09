// OPR.0.4.1.11.1（FR-3 + For-You）——EventSource 桩。静态 twin 不持有实时 SSE 连接，
// 但 For-You  feed 与拓扑活动是 SSE 驱动的（useActivityFeed / useGlobalEvents 订阅
// /api/events），而非缓存种子。因此本桩：(a) 对任何其他流，是惰性空操作；(b) 对
// /api/events，一次性发出固定的一组种子活动事件，使 feed 按 1:1 渲染卡片。
// 在任何触碰 SSE 的模块导入前安装。

import { feedEvents } from "./fixtures.js";

type MsgListener = (ev: { data: string }) => void;

class TwinEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  url = "";
  withCredentials = false;
  onopen: ((ev: unknown) => unknown) | null = null;
  onmessage: ((ev: unknown) => unknown) | null = null;
  onerror: ((ev: unknown) => unknown) | null = null;

  private listeners = new Map<string, Set<MsgListener>>();
  private closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    // 异步（setTimeout 0），使订阅者的 addEventListener 调用——它们在
    // `new EventSource(...)` 后同步立即执行——在我们发出事件之前先注册。
    if (this.url.includes("/api/events")) {
      setTimeout(() => this.emitSeeded(), 0);
    }
  }

  addEventListener(type: string, fn: MsgListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: MsgListener): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(): boolean {
    return false;
  }

  close(): void {
    this.closed = true;
  }

  private fire(type: string, ev: { data?: string }): void {
    if (this.closed) return;
    for (const fn of this.listeners.get(type) ?? []) fn(ev as { data: string });
    if (type === "open" && this.onopen) this.onopen(ev);
    if (type === "message" && this.onmessage) this.onmessage(ev);
  }

  private emitSeeded(): void {
    this.readyState = 1;
    this.fire("open", {});
    for (const evt of feedEvents) {
      this.fire("message", { data: JSON.stringify(evt) });
    }
  }
}

(globalThis as unknown as { EventSource: unknown }).EventSource = TwinEventSource;

export {};
