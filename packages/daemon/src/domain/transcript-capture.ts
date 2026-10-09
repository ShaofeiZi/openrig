import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import {
  startTranscriptRotation,
  getTranscriptRotationOptionsFromEnv,
} from "./transcript-rotation.js";

export async function startTmuxTranscriptCapture(
  tmuxAdapter: TmuxAdapter | null | undefined,
  transcriptStore: TranscriptStore | null | undefined,
  rigName: string,
  sessionName: string,
): Promise<{ started: boolean; reason?: string }> {
  if (!tmuxAdapter || !transcriptStore?.enabled) {
    return { started: false, reason: "transcript_capture_unavailable" };
  }

  if (!transcriptStore.ensureTranscriptDir(rigName)) {
    return { started: false, reason: "transcript_dir_unavailable" };
  }

  const transcriptPath = transcriptStore.getTranscriptPath(rigName, sessionName);
  // V1 预发布 CLI/daemon 项 1：有界尾部轮换取代 pipe-pane 无限增长文件。默认值来自环境变量 +
  // 1000 行 / 2 秒基线；rotation 内失败按 best-effort 静默处理，绝不阻塞 launch（此前 pipe-pane
  // 位置将 failure 视为 launch warning，而非 launch blocker，因此行为保持不变）。
  startTranscriptRotation(
    tmuxAdapter,
    sessionName,
    transcriptPath,
    getTranscriptRotationOptionsFromEnv(),
  );
  return { started: true };
}

interface RunningTranscriptSession {
  rig_name: string;
  session_name: string;
}

/** daemon restart 后恢复进程本地 rotation timer。 */
export async function resumeRunningTranscriptCaptures(
  db: Database.Database,
  tmuxAdapter: TmuxAdapter | null | undefined,
  transcriptStore: TranscriptStore | null | undefined,
): Promise<number> {
  if (!tmuxAdapter || !transcriptStore?.enabled) return 0;
  const rows = db.prepare(`
    SELECT r.name AS rig_name, s.session_name
    FROM sessions s
    JOIN nodes n ON n.id = s.node_id
    JOIN rigs r ON r.id = n.rig_id
    JOIN bindings b ON b.node_id = n.id
    WHERE s.status = 'running'
      AND s.id = (
        SELECT s2.id FROM sessions s2
        WHERE s2.node_id = n.id
        ORDER BY s2.id DESC
        LIMIT 1
      )
      AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
      AND b.tmux_session = s.session_name
  `).all() as RunningTranscriptSession[];

  let resumed = 0;
  for (const row of rows) {
    const result = await startTmuxTranscriptCapture(
      tmuxAdapter,
      transcriptStore,
      row.rig_name,
      row.session_name,
    );
    if (result.started) resumed += 1;
  }
  return resumed;
}
