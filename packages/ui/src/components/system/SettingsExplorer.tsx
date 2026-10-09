// Slice 26——设置目的地 Explorer 侧边栏。
//
// 把 4 个设置目的地渲染成扁平侧边栏列表（与 Topology / Project / Library / For-You
// 目的地按 dispatch 同级）。每项是指向其子路由的 TanStack Router Link。活动项由当前路由
// pathname 派生，因此无论用户如何导航，侧边栏都保持同步。

import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";

interface SettingsExplorerItem {
  id: "settings" | "policies" | "log" | "status";
  label: string;
  href: string;
  /**
   * 把当前 pathname 匹配为“活动”状态的谓词。
   * 设置根是精确匹配 `/settings`；子路由匹配其完整路径。
   */
  isActive: (pathname: string) => boolean;
}

const SETTINGS_ITEMS: SettingsExplorerItem[] = [
  {
    id: "settings",
    label: "设置",
    href: "/settings",
    // 仅对裸 /settings 活动——不对 /settings/<sub>。
    isActive: (path) => path === "/settings",
  },
  {
    id: "policies",
    label: "策略",
    href: "/settings/policies",
    isActive: (path) => path.startsWith("/settings/policies"),
  },
  {
    id: "log",
    label: "日志",
    href: "/settings/log",
    isActive: (path) => path.startsWith("/settings/log"),
  },
  {
    id: "status",
    label: "状态",
    href: "/settings/status",
    isActive: (path) => path.startsWith("/settings/status"),
  },
];

export function SettingsExplorer() {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  return (
    <div data-testid="settings-explorer" className="flex-1 overflow-y-auto py-2">
      <div className="px-2 mb-2">
        <span
          data-testid="settings-explorer-heading"
          className="block font-mono text-[11px] uppercase tracking-wide text-on-surface px-2 py-1"
        >
          {"> "}设置
        </span>
      </div>
      <ul className="px-2 space-y-0.5">
        {SETTINGS_ITEMS.map((item) => {
          const active = item.isActive(pathname);
          return (
            <li key={item.id}>
              <Link
                to={item.href}
                data-testid={`settings-explorer-item-${item.id}`}
                data-active={active}
                className={cn(
                  "block font-mono text-[11px] uppercase tracking-wide px-2 py-1",
                  active
                    ? "bg-inverse-surface text-background"
                    : "text-on-surface hover:text-on-surface hover:bg-surface-low",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
