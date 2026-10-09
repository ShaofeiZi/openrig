// OPR.0.4.3.21 —— 挂载唯一的后台服务健康轮询，并把派生信号发布到 DaemonHealthContext，
// 使下方任一 FocusedTerminal 能区分“终端代理不可用”这种普通关闭，与控制面确实不健康的情况。
// 置于应用根的 QueryClientProvider 之下。

import type { ReactNode } from "react";
import { DaemonHealthContext, useDaemonHealth } from "../hooks/useDaemonHealth.js";

export function DaemonHealthProvider({ children }: { children: ReactNode }) {
  const { signal } = useDaemonHealth();
  return <DaemonHealthContext.Provider value={signal}>{children}</DaemonHealthContext.Provider>;
}
