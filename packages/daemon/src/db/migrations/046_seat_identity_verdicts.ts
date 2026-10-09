import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.3.19——席位活性 PID/身份判定（不误报 running）。
 *
 * 持久化的逐节点身份判定，用于协调当前 tmux pane 的 PID/命令与已注册托管席位。它是第三条
 * 活性轴的持久化存储（与 slice-15 的 `terminalActive` 和 `hasAssignedWork` 正交）：席位已注册
 * pane 中的进程是否仍与我们报告为 `running`/`active` 的席位匹配？
 *
 * 判定由周期性 SeatIdentityReconciler 写入（镜像 SeatActivityService 的轮询节奏），
 * node-inventory 在投影时低成本读取。持久化判定，而非读取时计算或只保存在瞬态内存中，
 * 可使 `getNodeInventory` 保持同步且低成本，并依据 dev-guard 计划评审警示明确持久活性事实。
 *
 * 列：
 * - `node_id`（主键）——托管节点；跨 session 变动保持稳定。
 * - `verdict`——verified | mismatch | pane_missing | binding_absent | tmux_unavailable。
 *   只有 `mismatch` 和 `pane_missing` 会下调 `running` 投影；`verified`、`binding_absent`
 *   （目标 session 存活但绑定 pane 缺失）和 `tmux_unavailable`（瞬态/未知观察）保持投影不变；
 *   ABSENT 行（从未轮询）也保持不变（未知时开放失败——绝不因缺少观察而把实时 fleet 变成非绿色）。
 * - `evidence_source`——pane_process | tmux_session（产生判定的轴）。
 * - `reason`——process_identity_mismatch | pane_pid_gone | binding_pane_missing |
 *   session_missing | tmux_unavailable。镜像 AgentActivity 证据词汇，使消费者保持一致。
 * - `registered_pane`/`observed_pid`/`observed_command`/`matched_layer`——证据 payload
 *   （参见 FingerprintEvidence）。
 * - `session_name`——计算判定时对应的 session。
 * - `observed_at`——观察的 ISO 时间戳。
 *
 * 不设指向 `nodes` 的外键：已删除节点的陈旧行无害（node-inventory 只读取正在投影节点的判定），
 * reconciler 每次轮询都会清理不再运行的节点行。编号使用 045_resume_verification.ts 之后的
 * 下一个可用值。
 */
export const seatIdentityVerdictsSchema: Migration = {
  name: "046_seat_identity_verdicts.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS seat_identity_verdicts (
      node_id TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      evidence_source TEXT,
      reason TEXT,
      registered_pane TEXT,
      observed_pid INTEGER,
      observed_command TEXT,
      matched_layer INTEGER,
      session_name TEXT,
      observed_at TEXT NOT NULL
    );
  `,
};
