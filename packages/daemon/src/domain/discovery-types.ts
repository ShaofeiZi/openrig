/** 根据指纹识别得到的 runtime 提示。 */
export type RuntimeHint = "claude-code" | "codex" | "pi" | "terminal" | "unknown";

/** runtime 检测结果的置信级别。 */
export type Confidence = "highest" | "high" | "medium" | "low";

/** 发现态 session 的生命周期状态。 */
export type DiscoveryStatus = "active" | "vanished" | "claimed";

/** 受管 session 的来源。 */
export type SessionOrigin = "launched" | "claimed";

/** 已发现但尚未纳管的 tmux session。 */
export interface DiscoveredSession {
  id: string;
  tmuxSession: string;
  tmuxWindow: string | null;
  tmuxPane: string | null;
  pid: number | null;
  cwd: string | null;
  activeCommand: string | null;
  runtimeHint: RuntimeHint;
  confidence: Confidence;
  evidenceJson: string | null;
  configJson: string | null;
  status: DiscoveryStatus;
  claimedNodeId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
