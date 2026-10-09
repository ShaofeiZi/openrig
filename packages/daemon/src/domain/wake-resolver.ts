/**
 * L3b——基于当前已有存储（裁决 A），将 seat[@generation] 解析为唤醒所需的恢复 token：
 * 即该席位 session_name 对应的 `sessions` 行，按最新优先排列。目前尚无专用任期台账
 *（它属于集中启动捕获原子）；在其落地前，“有哪些任期”等同于 sessions 行。无法解析的
 * 唤醒目标会拒绝执行并列出可选项——允许显式原始 token，绝不猜测 token。
 */

export interface WakeSessionRow {
  id: number;
  sessionName: string;
  resumeToken: string | null;
  runtime: string | null;
  createdAt: string;
}

export interface WakeResolveInput {
  seat: string;
  /** 1 = 最新任期（默认），2 = 再前一个任期，依此类推。 */
  generation?: number;
}

export interface KnownTenure {
  generation: number;
  sessionId: number;
  tokenPresent: boolean;
  createdAt: string;
}

export type WakeResolution =
  | { resolved: true; token: string; runtime: "claude" | "codex"; sessionId: number }
  | { resolved: false; reason: string; known: KnownTenure[] };

/**
 * @param rows 席位 session_name 对应的 sessions，按最新优先排列（id DESC）。
 */
export function resolveWakeTarget(rows: WakeSessionRow[], input: WakeResolveInput): WakeResolution {
  const known: KnownTenure[] = rows.map((r, i) => ({
    generation: i + 1,
    sessionId: r.id,
    tokenPresent: !!r.resumeToken,
    createdAt: r.createdAt,
  }));

  if (rows.length === 0) {
    return {
      resolved: false,
      reason: `席位 '${input.seat}' 没有已知会话。它可能从未在此主机上运行，或其会话早于恢复 token 捕获功能。`,
      known,
    };
  }

  const gen = input.generation ?? 1;
  if (gen < 1 || gen > rows.length) {
    return {
      resolved: false,
      reason: `席位 '${input.seat}' 不存在第 ${gen} 代——仅记录了 ${rows.length} 个任期。请选择 1..${rows.length}（1 = 最新）。`,
      known,
    };
  }

  const row = rows[gen - 1]!;
  if (!row.resumeToken) {
    return {
      resolved: false,
      reason: `席位 '${input.seat}' 的第 ${gen} 个任期没有捕获到恢复 token（不可恢复）。请尝试其他代，或向 --wake 传入原始 token。`,
      known,
    };
  }

  const runtime: "claude" | "codex" = row.runtime === "codex" ? "codex" : "claude";
  return { resolved: true, token: row.resumeToken, runtime, sessionId: row.id };
}
