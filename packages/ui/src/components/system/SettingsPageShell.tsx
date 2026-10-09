// 切片 26 —— 设置目标页面外壳。
//
// 每个设置子路由的通用外壳（eyebrow + 标题 + 内容槽位）：
// /settings、/settings/policies、/settings/log、/settings/status。
// 取代旧 SettingsCenter 使用的内联标签页导航；Explorer 侧边栏现在负责
// 目标切换，每个路由挂载自己的页面级组件。

import type { ReactNode } from "react";
import { SectionHeader } from "../ui/section-header.js";

interface SettingsPageShellProps {
  /** 整个页面包装器的稳定 testid（如 "settings-page-policies"）。 */
  testId: string;
  /** 作为页面标题显示的名称 —— "设置" / "策略" / "日志" / "状态"。 */
  title: string;
  children: ReactNode;
}

export function SettingsPageShell({ testId, title, children }: SettingsPageShellProps) {
  return (
    <div
      data-testid={testId}
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">配置</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-on-surface mt-1">
          {title}
        </h1>
      </header>
      {children}
    </div>
  );
}
