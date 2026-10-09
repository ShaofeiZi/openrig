// OPR.0.4.3.29 —— 仪表盘主题（浅色 + 深色，可扩展）。
//
// 一个主题就是一组 CSS 变量令牌值，通过 <html> 上的某个类名生效。
// 浅色即当前 `:root` 令牌集（globals.css）；深色是一个 `.dark {}` 块，
// 以同名重新声明（Vellum Dark）。由于每个组件都经 `hsl(var(--token))` 取色，
// 切换 `.dark` 类就会沿层叠把整个仪表盘翻转——无需逐组件改动。
//
// 本模块是主题注册表 + 存储键 + 解析逻辑的唯一事实来源。index.html 里的
// 首屏前内联脚本必须逐字镜像 THEME_STORAGE_KEY 与解析规则
// （light/dark 为显式选择，优先级高于系统；`system` 跟随 prefers-color-scheme），
// 这样首个像素绘制前类名就已在 <html> 上（避免主题闪烁）。

/** localStorage 键。与 index.html 的首屏前脚本逐字共享。 */
export const THEME_STORAGE_KEY = "openrig.theme";

/** `system` 使用的、仪表盘作用域内的系统配色查询。 */
export const COLOR_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** 可选主题。`light`/`dark` 为显式选择；`system` 跟随系统。 */
export type ThemeId = "light" | "dark" | "system";

/** 主题解析到的两种具体配色（即施加到 <html> 上的类名）。 */
export type ResolvedTheme = "light" | "dark";

export interface ThemeOption {
  id: ThemeId;
  label: string;
}

/**
 * 驱动选择器的主题注册表。未来新增主题 = 新增一个 `.dark` 风格的令牌块 + 这里加一条——
 * 无需改动任何组件（可扩展性验收）。本切片只交付浅色与深色两种具体配色；
 * `system` 是对二者的解析器，不是第三种配色。
 */
export const THEMES: readonly ThemeOption[] = [
  { id: "light", label: "Vellum 浅色" },
  { id: "dark", label: "Vellum 深色" },
  { id: "system", label: "跟随系统" },
] as const;

/** 未存储选择 → 跟随系统（`system`）。 */
export const DEFAULT_THEME: ThemeId = "system";

function isThemeId(value: unknown): value is ThemeId {
  return value === "light" || value === "dark" || value === "system";
}

/** 读取持久化的选择；未设置或格式异常时回退到 DEFAULT_THEME。 */
export function readStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(raw)) return raw;
  } catch {
    // localStorage 可能不可用（隐私模式、配额已满）——静默吞掉。
  }
  return DEFAULT_THEME;
}

/** 持久化显式选择。 */
export function writeStoredTheme(theme: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 静默吞掉——持久化是尽力而为。
  }
}

/** 系统当前是否偏好深色。 */
export function prefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COLOR_SCHEME_QUERY).matches;
}

/** 把主题选择解析为具体配色。`system` 跟随系统。 */
export function resolveTheme(theme: ThemeId): ResolvedTheme {
  if (theme === "system") return prefersDark() ? "dark" : "light";
  return theme;
}

/** 通过切换 <html> 上的 `.dark` 类来应用解析后的配色。 */
export function applyTheme(theme: ThemeId): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveTheme(theme) === "dark");
}
