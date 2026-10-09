// V1 第三次尝试阶段 2——视口检测钩子（按 code-map，位于树之后）。
//
// V1 第三次尝试阶段 5 P5-9：抽成独立钩子，使非 AppShell 表面
//（TopologyTerminalView、topology ScopePages）在移动端优雅降级，而不必从 AppShell
// 逐层传递 isWideLayout。使用与 AppShell 相同的 WIDE_LAYOUT_BREAKPOINT（1024px），
// 保证所有消费者的断点同步。

import { useEffect, useState } from "react";

const WIDE_LAYOUT_BREAKPOINT = 1024;

export interface ShellViewport {
  /** window.innerWidth >= 1024px（Tailwind lg 断点）时为 true。 */
  isWideLayout: boolean;
  /** 实时 innerWidth，单位 px；用于中间区间决策，例如移动端与桌面端之间的
   *  768px iPad 竖屏断点。 */
  innerWidth: number;
}

export function useShellViewport(): ShellViewport {
  const [state, setState] = useState<ShellViewport>(() => {
    if (typeof window === "undefined") {
      return { isWideLayout: true, innerWidth: WIDE_LAYOUT_BREAKPOINT };
    }
    return {
      isWideLayout: window.innerWidth >= WIDE_LAYOUT_BREAKPOINT,
      innerWidth: window.innerWidth,
    };
  });

  useEffect(() => {
    const handleResize = () => {
      setState({
        isWideLayout: window.innerWidth >= WIDE_LAYOUT_BREAKPOINT,
        innerWidth: window.innerWidth,
      });
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return state;
}
