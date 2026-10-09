// 故障诊断 C3 —— `rig crash-cart --json` 输出的 TUI 本地契约类型。该动词是
// SSOT（它运行检测器 + C2 读取并打印一个 JSON）；这些类型镜像该 JSON，使 TUI
// 无需依赖 @openrig/daemon 即可解析和渲染（轻量 TUI 围栏）。后台服务侧
// 动词拥有匹配的形状；此文件是 TUI 读取的文档化解析目标。

export type DaemonState = "up" | "down" | "unverified";

/** UNVERIFIED（无法确认已停止）屏幕的逐字证据。 */
export interface DaemonUnverifiedEvidence {
  pidState: string;
  probeResult: string;
  failedSignal: string;
}
