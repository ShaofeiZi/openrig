// OPR.0.4.3.29 —— 主题选择器（多主题系统，而非二元开关）。
//
// 在主题注册表之上放一个原生 <select>——它是选择器，未来要扩展更多主题只需加一个令牌块
// + 一条注册表项（无需改动本文件）。位置：AppShell 顶栏右侧槽位（最终形态/位置由创始人
// 审美把关；按 PRD 开放问题暂定为如此）。用令牌着色，使其随应用一起换肤。

import { useTheme } from "./ThemeProvider.js";
import type { ThemeId } from "../lib/theme.js";

export function ThemeSelector() {
  const { theme, themes, setTheme } = useTheme();
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">主题</span>
      <select
        data-testid="theme-selector"
        aria-label="主题"
        value={theme}
        onChange={(e) => setTheme(e.target.value as ThemeId)}
        className="font-mono text-[10px] uppercase tracking-[0.14em] bg-transparent text-on-surface-variant border border-outline-variant px-2 py-1 hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-secondary cursor-pointer"
      >
        {themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
