import type { ViewState } from "./types.js";
import { retainAttentionSources } from "./attention/source-continuity.js";

/** 一个页面的成功 HTTP 读取；绝不在 TUI 间共享或用于效果。
 * 每个来源可失败而不擦除兄弟。 */
export class PageRead {
  private values = new Map<string, { body: string; status: number; headers: Headers; at: number }>();
  private seen = new Set<string>();
  errors: string[] = [];
  retainedAt: number | undefined;
  constructor(private now: () => number, private denied: (url: string) => void = () => {}) {}
  has(url: string): boolean { return this.values.has(url); }
  begin(): void { this.seen.clear(); this.errors = []; this.retainedAt = undefined; }
  end(): void { for (const key of this.values.keys()) if (!this.seen.has(key)) this.values.delete(key); }
  fetch(fetchImpl: typeof fetch, signal: AbortSignal, optional = false): typeof fetch {
    return (async (input, init) => {
      if (init?.method && init.method !== "GET") throw new Error("页面读取器是只读的");
      const key = String(input);
      const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
      // 可选增强共享取消，但既不贡献页面
      // 失败，也不将先前所有者保留为新解析。
      if (optional) return fetchImpl(input, { ...init, signal: requestSignal });
      this.seen.add(key);
      try {
        const response = await fetchImpl(input, { ...init, signal: requestSignal });
        if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
        // 缺席/访问拒绝是新应答；不从先前成功响应复活已删除或
        // 新禁止的内容。
        if (!response.ok) {
          signal.throwIfAborted();
          this.values.delete(key);
          this.denied(key);
          this.errors.push(`${new URL(key).pathname}: HTTP ${response.status}`);
          return response;
        }
        let body = await response.text();
        const decoded = JSON.parse(body); // 所有页面读取都是 JSON；损坏的 body 是失败读取
        signal.throwIfAborted();
        let at = this.now();
        // Attention 在 HTTP 200 内声明独立来源中断。保持
        // 这些贡献在此相同页面/URL 缓存中， alongside 新兄弟。
        if (new URL(key).pathname === "/api/attention") {
          const prior = this.values.get(key);
          const merged = retainAttentionSources(decoded, prior && JSON.parse(prior.body));
          body = JSON.stringify(merged.read);
          this.errors.push(...merged.errors);
          if (merged.retained && prior) {
            at = prior.at; // 保守时间基准，直到整个读取成功
            this.retainedAt = Math.min(this.retainedAt ?? at, at);
          }
        }
        const value = { body, status: response.status, headers: response.headers, at };
        this.values.set(key, value);
        return new Response(body, value);
      } catch (error) {
        signal.throwIfAborted();
        const detail = error instanceof Error ? error.message : String(error);
        const route = new URL(key).pathname;
        this.errors.push(`${route}: ${detail}`);
        const prior = this.values.get(key);
        if (!prior) throw error;
        this.retainedAt = Math.min(this.retainedAt ?? prior.at, prior.at);
        return new Response(prior.body, prior);
      }
    }) as typeof fetch;
  }
}

/** 仅数据坐标；滚动、选择、过滤和帮助绝不驱逐读取。 */
export function pageReadKey(s: ViewState): string {
  return JSON.stringify([s.section, s.viewTab, s.drill, s.project, s.scopesMission,
    s.scopesSelected, s.executionOpen, s.file && [s.file.root, s.file.path],
    s.externalUrl, s.terminalView, s.attentionOpen]);
}
