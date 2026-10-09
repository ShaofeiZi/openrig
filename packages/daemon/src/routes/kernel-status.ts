// V0.3.1 slice 05 内核工作组即默认 —— forward-fix #3 架构。
//
// GET /api/kernel/status —— 后台内核启动的只读可观测表面。
// 与 kernel-boot-tracker.ts 中的架构解配配对：healthz 提前绑定；本路由让
// 操作员（以及 CLI 的 `--wait-for-kernel`）独立于 HTTP 健康状态观察内核智能体就绪情况。
//
// 返回两种形态之一：
//
//   200 { kernel_state, agents[], first_unready_since, variant, detail }
//     —— tracker 已接线（标准后台服务组装）。
//
//   503 { error: 'kernel_boot_tracker_unavailable', message: ... }
//     —— AppDeps 构造时没有 tracker（测试夹具或自定义后台服务组装）。
//     给出清晰提示而非 500。

import { Hono } from "hono";
import type { KernelBootTracker } from "../domain/kernel-boot-tracker.js";

export const kernelStatusRoutes = new Hono();

kernelStatusRoutes.get("/status", (c) => {
  const tracker = c.get("kernelBootTracker" as never) as KernelBootTracker | undefined;
  if (!tracker) {
    return c.json(
      {
        error: "kernel_boot_tracker_unavailable",
        message:
          "内核启动 tracker 未接入此后台服务。使用 --no-kernel，或查看启动日志中导致 tracker 无法构建的内核启动失败。",
      },
      503,
    );
  }
  const status = tracker.getStatus();
  return c.json({
    kernel_state: status.kernelState,
    agents: status.agents.map((a) => ({
      session_name: a.sessionName,
      runtime: a.runtime,
      startup_status: a.startupStatus,
    })),
    first_unready_since: status.firstUnreadySince,
    variant: status.variant,
    detail: status.detail,
  });
});
