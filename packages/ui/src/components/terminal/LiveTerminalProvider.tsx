// OPR.0.4.0.1——包裹单一全局 LiveTerminalRegistry 的 React context。
//
// PM 锁定：上限是全局的，因此单一 provider 挂载在三个终端界面（graph + table + topology）
// 之上，每个 ProgressiveTerminal 共享同一个 registry。上限来自配置
// （ui.terminal.max_live_terminals），默认 MAX_LIVE_TERMINALS；上限变化会重建 registry
// （罕见，配置驱动）。当没有 provider 时（例如隔离渲染），惰性创建的模块单例保持“构造即全局”，
// 而非崩溃。

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { LiveTerminalRegistry, MAX_LIVE_TERMINALS } from "./live-terminal-registry.js";
import { useSettings } from "../../hooks/useSettings.js";

/** OPR.0.4.0.1——读取配置的全局上限
 *  （ui.terminal.max_live_terminals），未设置/非法时回退 MAX_LIVE_TERMINALS。
 *  2 -> 3 的改动是一处配置编辑（AC-5）。挂载点：`<LiveTerminalProvider cap={useTerminalCap()}>`。 */
export function useTerminalCap(): number {
  const { data } = useSettings();
  const raw = data?.settings?.["ui.terminal.max_live_terminals"]?.value;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? n : MAX_LIVE_TERMINALS;
}

export interface LiveTerminalContextValue {
  /** 标记一个终端为实时；超上限时驱逐最旧的（退回静态）。 */
  requestLive(key: string, revertToStatic: () => void): void;
  /** 释放一个终端的槽位而不驱逐（卸载/手动退回时）。 */
  release(key: string): void;
  isLive(key: string): boolean;
}

const LiveTerminalContext = createContext<LiveTerminalContextValue | null>(null);

function toValue(registry: LiveTerminalRegistry): LiveTerminalContextValue {
  return {
    requestLive: (key, revert) => registry.requestLive(key, revert),
    release: (key) => registry.release(key),
    isLive: (key) => registry.isLive(key),
  };
}

interface LiveTerminalProviderProps {
  /** 来自配置的上限；默认 MAX_LIVE_TERMINALS。 */
  cap?: number;
  children: ReactNode;
}

export function LiveTerminalProvider({ cap = MAX_LIVE_TERMINALS, children }: LiveTerminalProviderProps) {
  // 每个 provider 实例一个 registry；仅当上限变化（配置编辑）时重建。
  // 上限变化会重置实时集合——可接受且罕见。
  const value = useMemo(() => toValue(new LiveTerminalRegistry(cap)), [cap]);
  return <LiveTerminalContext.Provider value={value}>{children}</LiveTerminalContext.Provider>;
}

// 模块单例回退：即使某个界面在显式 provider 之外渲染 ProgressiveTerminal，
// 也保持上限全局（防御）。真正的应用把 LiveTerminalProvider 挂载在所有界面之上。
let fallbackRegistry: LiveTerminalRegistry | null = null;
function getFallbackValue(): LiveTerminalContextValue {
  if (!fallbackRegistry) fallbackRegistry = new LiveTerminalRegistry(MAX_LIVE_TERMINALS);
  return toValue(fallbackRegistry);
}

export function useLiveTerminal(): LiveTerminalContextValue {
  const ctx = useContext(LiveTerminalContext);
  const fallbackRef = useRef<LiveTerminalContextValue | null>(null);
  if (ctx) return ctx;
  if (!fallbackRef.current) fallbackRef.current = getFallbackValue();
  return fallbackRef.current;
}

/** 仅供测试：重置模块单例，使上限/驱逐状态不跨测试泄漏
 *  （这些测试在没有显式 provider 的情况下渲染 ProgressiveTerminal）。 */
export function __resetFallbackRegistryForTests(): void {
  fallbackRegistry = null;
}
