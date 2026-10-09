// OPR.0.4.3.29 —— ThemeProvider + useTheme。
//
// 持有当前主题选择，通过 applyTheme 应用到 <html>，将显式选择持久化到 localStorage，
// 并在选择为 `system` 时订阅 `prefers-color-scheme`，使操作系统切换实时重新解析。
// matchMedia 的订阅/初始化/清理结构参照 usePrefersReducedMotion；
// localStorage 惯用法参照 useDismissedSeqs（懒初始化 + try/catch 吞错）。
//
// index.html 中的首帧前脚本已在首次绘制前设置正确 class（无 FOUC）；
// 本 provider 在挂载时重新确认同一解析结果，并在此后保持同步。

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyTheme,
  COLOR_SCHEME_QUERY,
  DEFAULT_THEME,
  readStoredTheme,
  resolveTheme,
  THEMES,
  writeStoredTheme,
  type ResolvedTheme,
  type ThemeId,
  type ThemeOption,
} from "../lib/theme.js";

interface ThemeContextValue {
  /** 已持久化的选择（light / dark / system）。 */
  theme: ThemeId;
  /** 当前实际应用的调色板（light 或 dark）。 */
  resolved: ResolvedTheme;
  /** 可用主题列表（驱动选择器）。 */
  themes: readonly ThemeOption[];
  /** 设置并持久化显式选择；立即生效。 */
  setTheme: (theme: ThemeId) => void;
}

// 提供函数式独立默认值，使裸用的 <ThemeSelector/>（例如测试中渲染 AppShell
// 而无根 provider）仍能持久化 + 应用主题，而不会抛错。生产环境始终用
// <ThemeProvider> 包裹 <App/>（main.tsx），由其提供下方的响应式值。
const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  resolved: "light",
  themes: THEMES,
  setTheme: (next: ThemeId) => {
    writeStoredTheme(next);
    applyTheme(next);
  },
});

export function ThemeProvider({
  children,
  initialTheme,
}: {
  children: ReactNode;
  /**
   * OPR.0.4.6.2（FR-5）—— 用 prop 而非 localStorage 作为主题种子。
   * 不透明源捕获（file:// 页面上的无头 Chrome）会静默禁用 localStorage，
   * 导致 `readStoredTheme()` 返回默认值，深色捕获却渲染成浅色。
   * 为主题截图渲染启动器的驱动通过 `initialTheme` 传入主题，
   * 不依赖任何 localStorage。省略时（生产路径）→ 使用已存储/系统选择，
   * 与之前完全一致——完全向后兼容。
   */
  initialTheme?: ThemeId;
}) {
  const [theme, setThemeState] = useState<ThemeId>(() => initialTheme ?? readStoredTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(theme));

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next);
    writeStoredTheme(next);
    applyTheme(next);
    setResolved(resolveTheme(next));
  }, []);

  // 挂载时应用 + 选择变化时应用（重新确认首帧前 class）。
  useEffect(() => {
    applyTheme(theme);
    setResolved(resolveTheme(theme));
  }, [theme]);

  // 跟随操作系统（`system`）时，在系统偏好切换时重新解析。
  useEffect(() => {
    if (theme !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    const onChange = () => {
      applyTheme("system");
      setResolved(resolveTheme("system"));
    };
    mediaQuery.addEventListener?.("change", onChange);
    return () => mediaQuery.removeEventListener?.("change", onChange);
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, themes: THEMES, setTheme }),
    [theme, resolved, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
