// Fork Primitive + Starter Agent Images v0（PL-016）——按运行时发现恢复 token。
//
// 给定规范会话名，返回运行时用于 fork/resume 的原生会话 ID。SnapshotCapturer
//（捕获到镜像）与 /api/agent-images/fork 路由（不产生快照副作用的一次性 fork）共用此逻辑。
//
// 诚实失败：没有可用 token 时返回 null，绝不伪造
//（docs/as-built/architecture/adapters-and-runtimes.md § 续接真实性）。

import type Database from "better-sqlite3";

export type DiscoveryRuntime = "claude-code" | "codex";

export interface DiscoveryResult {
  runtime: DiscoveryRuntime;
  /** 原生会话 ID（Claude resume_token / Codex thread_id；外部 CLI Codex 席位使用
   * external_session_name）。后台服务尚无法提供时为 null。 */
  nativeId: string | null;
  /** PL-016 source-cwd 行为：从 nodes 表取得源席位解析后的 cwd。在此一并捕获，
   * 使 SnapshotCapturer（以及未来的 fork 路由）无需额外查询即可将其写入 manifest。
   * 源节点没有记录 cwd 时为 null。 */
  nodeCwd: string | null;
}

export interface DiscoveryFailure {
  code: "session_not_found" | "runtime_unsupported";
  message: string;
}

export type DiscoveryOutcome = { ok: true; result: DiscoveryResult } | { ok: false; failure: DiscoveryFailure };

export function discoverResumeToken(db: Database.Database, sourceSession: string): DiscoveryOutcome {
  const sessionRow = db
    .prepare("SELECT id, node_id, resume_token FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
    .get(sourceSession) as { id: string; node_id: string; resume_token: string | null } | undefined;
  if (!sessionRow) {
    return {
      ok: false,
      failure: {
        code: "session_not_found",
        message: `未找到源会话 '${sourceSession}'。运行 'zrig ps --nodes' 查看正在运行的内容。`,
      },
    };
  }
  const nodeRow = db
    .prepare("SELECT runtime, cwd FROM nodes WHERE id = ?")
    .get(sessionRow.node_id) as { runtime: string | null; cwd: string | null } | undefined;
  const runtime = nodeRow?.runtime ?? null;
  const nodeCwd = nodeRow?.cwd ?? null;
  if (runtime !== "claude-code" && runtime !== "codex") {
    return {
      ok: false,
      failure: {
        code: "runtime_unsupported",
        message: `源会话 '${sourceSession}' 的运行时为 '${runtime ?? "（未知）"}'，没有原生 fork 能力。只有 claude-code 和 codex 会话可以 fork。`,
      },
    };
  }
  if (runtime === "claude-code") {
    const contextSessionId = discoverClaudeContextSessionId(db, sessionRow.node_id, sourceSession);
    return {
      ok: true,
      result: { runtime, nativeId: contextSessionId ?? sessionRow.resume_token ?? null, nodeCwd },
    };
  }
  // Codex 托管 tmux 席位会在启动后把捕获的原生 thread id 持久化到 sessions 行；
  // 镜像捕获/fork 可直接使用。
  if (sessionRow.resume_token) {
    return { ok: true, result: { runtime, nativeId: sessionRow.resume_token, nodeCwd } };
  }
  // Codex external_cli 席位可能没有 sessions.resume_token；binding 行上的
  // external_session_name 保存原生会话 ID。
  const bindingRow = db
    .prepare("SELECT external_session_name, attachment_type FROM bindings WHERE node_id = ?")
    .get(sessionRow.node_id) as { external_session_name: string | null; attachment_type: string | null } | undefined;
  if (bindingRow?.attachment_type === "external_cli" && bindingRow.external_session_name) {
    return { ok: true, result: { runtime, nativeId: bindingRow.external_session_name, nodeCwd } };
  }
  return { ok: true, result: { runtime, nativeId: null, nodeCwd } };
}

function discoverClaudeContextSessionId(
  db: Database.Database,
  nodeId: string,
  sourceSession: string,
): string | null {
  try {
    const row = db
      .prepare(`
        SELECT session_id, session_name
        FROM context_usage
        WHERE node_id = ?
        LIMIT 1
      `)
      .get(nodeId) as { session_id: string | null; session_name: string | null } | undefined;

    if (!row) return null;
    if (row.session_name && row.session_name !== sourceSession) return null;
    const nativeId = row.session_id?.trim();
    return nativeId ? nativeId : null;
  } catch {
    // 兼容最小测试数据库和旧存储：回退到已持久化的 sessions.resume_token，
    // 不让发现流程直接失败。
    return null;
  }
}
