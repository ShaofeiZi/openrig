// User Settings v0——后台服务侧设置存储。
//
// CLI 的 @openrig/cli ConfigStore 是规范写入表面（操作员与智能体通过 `zrig config` 编辑）。
// 后台服务也需要读写访问，供 UI 的 System 抽屉 Settings 面板与 /api/config HTTP 路由使用。
// 为避免依赖 CLI 包（这需要工作区 export 与 dist 构建），本模块复制少量稳定的解析与写入逻辑。
// 常量（VALID_KEYS、ENV_MAP、KEY_TO_PATH）通过跨包测试与 cli/src/config-store.ts 保持同步。
//
// 存储：共同的单一事实来源 ~/.openrig/config.json。
// 解析：共同的 env > file > default 优先级。解码辅助函数（parseNamedPairs / resolveAllowlist /
// resolveProgressScanRoots / resolveWorkspacePaths）把原始字符串投影为后台服务 UEP 路由与
// Slice Story View 消费的结构化数据。

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_CONFIG_PATH = path.join(
  process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig"),
  "config.json",
);

const DEFAULT_WORKSPACE_ROOT = path.join(
  process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig"),
  "workspace",
);

// OPR.0.5.3.6 D1/D2——拓扑树的派生默认值。实例层级位于此根目录顶部：
// <root>/<CHAIN>.md，然后是 <root>/rigs/<rig>/<CHAIN>.md，
// 再到 <root>/rigs/<rig>/seats/<seat>/<CHAIN>.md。
const DEFAULT_TOPOLOGY_ROOT = path.join(
  process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig"),
  "topology",
);

// OPR.0.5.9.5 Wave B——规范的可寻址上下文库。
const DEFAULT_CONTEXT_ROOT = path.join(
  process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig"),
  "context",
);

const DEFAULT_SKILLS_ROOT = path.join(
  process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig"),
  "skills",
);

/** OPR.0.5.3.6——旧版拓扑位置，已裁定为任意文件夹（founder，2026-08-14），但保持可读，
 * 使约定前的工作组能够迁移而无需一次性切换。解析到旧代码实际写入的位置：对应 codex 适配器的
 * shared-docs 先例（环境变量 OPENRIG_SHARED_DOCS_ROOT，否则为字面路径 ~/.openrig/shared-docs），
 * 而不是 $OPENRIG_HOME；使用非默认 home 的机器仍把旧版树放在 ~/.openrig/shared-docs。
 * 本辅助函数是该字面路径的唯一归属；walker 回退时调用它，读取解析到此处时必须发出具名提示。 */
export function resolveLegacyTopologyRigsRoot(): string {
  const sharedDocsRoot = process.env["OPENRIG_SHARED_DOCS_ROOT"]?.trim()
    || path.join(os.homedir(), ".openrig", "shared-docs");
  return path.join(sharedDocsRoot, "rigs");
}

export const SETTINGS_VALID_KEYS = [
  "daemon.port",
  "daemon.host",
  // OPR.0.4.6.MH1 FR-1——持久化主机选择指针，一个静态 key，与 cli/src/config-store.ts
  // VALID_KEYS 同步（孪生一致性测试固定两者）。默认为 "local"（未设置等同本地主机）。
  // 值的注册表校验位于 `zrig host select` verb。
  "host.selected",
  // OPR.0.4.6.MH1 FR-4——本机展示名称（架构裁定 1：归属 settings 孪生实现，绝不在 hosts.yaml）。
  // 默认为 "localhost"。
  "host.name",
  // OPR.0.4.6.WF5 FR-2——主机级成熟度拨盘默认值（架构配置裁定：MH-1 动态 key 模式类）。
  // 值为 "orchestrator" | "human_only"；未设置等同引擎默认的 orchestrator-first。
  // 仅在创建异常项时消费，拨盘变更绝不追溯生效。
  "workflow.exception_routing",
  "db.path",
  "transcripts.enabled",
  "transcripts.path",
  // V1 发布前 CLI/后台服务 Item 1——capture-pane 轮换可调参数。
  // SC-29 EXCEPTION #4 allowlist 子项，与 cli/src/config-store.ts 同步。
  "transcripts.lines",
  "transcripts.poll_interval_seconds",
  "workspace.root",
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.specs_root",
  "workspace.projects_root",
  "workspace.catalog_path",
  // OPR.0.5.3.6 D1——TOPOLOGY 树根（实例层级位于顶部，下方为 rigs/<rig>/seats/<seat>）。
  // 派生默认值为 $OPENRIG_HOME/topology；按 home 索引使 ~/.openrig 与 $OPENRIG_HOME 的分歧
  // 不再成为问题（一个机器有两个 home 就是两个实例，各有自己的拓扑树）。旧版 shared-docs/rigs
  // 仍可作为回退读取，但会附带具名提示；下方 resolveLegacyTopologyRigsRoot 是该字面路径的唯一归属，
  // walker 不携带它。与 CLI config-store 孪生实现同步（双方的一致性测试固定各自列表）。
  "topology.root",
  // OPR.0.5.9.5 Wave B——规范上下文库；旧 key 会被拒绝。
  "context.root",
  "context.system_world",
  "skills.root",
  "onboarding.default_pack.enabled",
  "health.context_pressure.warning_percent",
  "health.context_pressure.critical_percent",
  "files.allowlist",
  "progress.scan_roots",
  "ui.preview.refresh_interval_seconds",
  "ui.preview.max_pins",
  "ui.preview.default_lines",
  "ui.timezone",
  // OPR.0.4.0.1——同时活跃终端的全局上限（默认 2）。
  "ui.terminal.max_live_terminals",
  "recovery.auto_drive_provider_prompts",
  "recovery.provider_auth_env_allowlist",
  // V1 attempt-3 阶段 4——按 universal-shell.md L82–L84 设置 Advisor / Operator rail icon
  // V1 占位符。dispatch ACK §4 声明 SC-29 EXCEPTION：只编辑 allowlist，
  // 不新增迁移、端点或事件类型。
  "agents.advisor_session",
  "agents.operator_session",
  // 操作员显式覆盖；未设置时发现已注册人员。
  "workspace.operator_seat_name",
  // V1 attempt-3 阶段 5 P5-3——按 for-you-feed.md L144–L151 设置“为你推荐”feed 订阅开关。
  // 阶段 5 dispatch ACK §5 声明 SC-29 EXCEPTION（DRIFT P5-D2；范围与阶段 4 相同：
  // 只编辑 allowlist，不新增迁移、端点或事件类型）。UI 强制开启 action_required
  //（按 L145 不可切换）；该 key 为未来操作员覆盖保留，但 V1 不显示为开关。
  "feed.subscriptions.action_required",
  "feed.subscriptions.approvals",
  "feed.subscriptions.shipped",
  "feed.subscriptions.progress",
  "feed.subscriptions.audit_log",
  // plugin-primitive 阶段 3a slice 3.5——Codex 功能开关。为 true（默认）时，后台服务在启动时
  // 确保 ~/.codex/config.toml 中 `codex_hooks = true`，使插件附带的 hook 在 Codex 运行时触发。
  // 为 false 时，操作员独立管理 Codex 配置，后台服务不修改。
  "runtime.codex.hooks_enabled",
  // Slice 27——Claude 自动压缩策略。SC-29 EXCEPTION #10：7 个 key，
  // 与 cli/src/config-store.ts VALID_KEYS 同步。选择启用，默认关闭；后台服务 ContextMonitor
  // 读取 `enabled` 与 `threshold_percent`，决定何时发送压缩前准备与 /compact。
  // 后台服务将 usage 变量注入 `pre_compact_instruction`，把 `compact_instruction`
  // 作为 slash-command 参数传给实际压缩阶段，使用 `message_inline` 与 `message_file_path`
  // 提供压缩后恢复指引，再把 `post_restore_audit_instruction` 包装为阅读深度 nudge。
  "policies.claude_compaction.enabled",
  "policies.claude_compaction.threshold_percent",
  "policies.claude_compaction.pre_compact_instruction",
  "policies.claude_compaction.compact_instruction",
  "policies.claude_compaction.message_inline",
  "policies.claude_compaction.message_file_path",
  "policies.claude_compaction.post_restore_audit_instruction",
  "policies.idle_gate_qitem.scan_interval_seconds",
  "policies.idle_gate_qitem.active_wake_interval_seconds",
  // B6 创始人裁定：idle-gate 自动注册默认不启用。"off"（默认）不注册新 job；
  // "all" 恢复全队列注册。opt_in_sessions 是逗号分隔的规范会话名称列表，
  // mode 为 off 时这些会话仍获得 job。无论两个 key 如何设置，已有注册 job 始终保留并继续维护。
  "policies.idle_gate_qitem.auto_register",
  "policies.idle_gate_qitem.opt_in_sessions",
  "snapshots.periodic.enabled",
  "snapshots.periodic.interval_seconds",
  "snapshots.periodic.retention_keep",
  // OPR.0.4.6.02 S1——启动时应用到会话的内层 tmux 状态栏默认值。
  // 单一静态 boolean key（默认关闭），与 cli/src/config-store.ts VALID_KEYS 同步
  //（一致性测试固定两个孪生实现）。仅在创建会话时由 NodeLauncher 消费；
  // 开关变更只影响未来启动，绝不追溯生效（BR-1 never-retro）。
  "terminal.status_bar",
  // OPR.0.4.6.FS-1 W2——队列保留维护参数（架构 D3；闭集；架构安全默认值固化在
  // getDefaultValue，有界校验位于 KEY_CONSTRAINTS）。可由 CLI 设置的孪生实现与
  // cli/src/config-store.ts VALID_KEYS 同步（双方的精确相等一致性测试分别固定列表）。
  // 开关变更在下一个每日维护 tick 读取，绝不追溯影响正在执行的 sweep。
  "retention.enabled",
  "retention.transitions_days",
  "retention.watchdog_days",
  "retention.usage_samples_days",
  "retention.watchdog_keep_per_job",
  "retention.batch_size",
  // S04（OPR.0.5.5.4）——pickup-receipt 停滞阈值；全新 key，仅使用 OPENRIG_*，
  // 可由 CLI 设置的孪生实现与 cli/src/config-store.ts VALID_KEYS 同步。每次派生时重新读取；
  // 变更应用于下一次投影读取，绝不追溯生效。
  "queue.pickup_stall_threshold_minutes",
  // S02（OPR.0.5.5.2）——常驻 stuck sweep：执行频率与 A1 未认领义务年龄。
  // 与 pickup key 使用相同同步契约。
  "queue.stuck_sweep_interval_seconds",
  "queue.stuck_sweep_unclaimed_age_minutes",
  // S01（OPR.0.5.5.1）——唤醒或升级阶梯：重试频率与上限、F1 未确认窗口及 F2 切换后宽限期。
  // 使用相同同步契约。
  "queue.wake_retry_interval_seconds",
  "queue.wake_retry_cap",
  "queue.wake_unconfirmed_window_minutes",
  "queue.wake_swap_grace_seconds",
] as const;

export type SettingsValidKey = typeof SETTINGS_VALID_KEYS[number];

const ENV_MAP: Record<SettingsValidKey, { primary: string; legacy?: string }> = {
  // 只有原始运行时 key 为升级兼容保留 RIGGED_* 别名；新类型化 key 仅使用 OPENRIG_*。
  "daemon.port": { primary: "OPENRIG_PORT", legacy: "RIGGED_PORT" },
  "daemon.host": { primary: "OPENRIG_HOST", legacy: "RIGGED_HOST" },
  "db.path": { primary: "OPENRIG_DB", legacy: "RIGGED_DB" },
  "transcripts.enabled": { primary: "OPENRIG_TRANSCRIPTS_ENABLED", legacy: "RIGGED_TRANSCRIPTS_ENABLED" },
  "transcripts.path": { primary: "OPENRIG_TRANSCRIPTS_PATH", legacy: "RIGGED_TRANSCRIPTS_PATH" },
  "transcripts.lines": { primary: "OPENRIG_TRANSCRIPTS_LINES" },
  "transcripts.poll_interval_seconds": { primary: "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS" },
  "workspace.root": { primary: "OPENRIG_WORKSPACE_ROOT" },
  "workspace.slices_root": { primary: "OPENRIG_WORKSPACE_SLICES_ROOT" },
  "workspace.steering_path": { primary: "OPENRIG_WORKSPACE_STEERING_PATH" },
  "workspace.specs_root": { primary: "OPENRIG_WORKSPACE_SPECS_ROOT" },
  "workspace.projects_root": { primary: "OPENRIG_WORKSPACE_PROJECTS_ROOT" },
  "workspace.catalog_path": { primary: "OPENRIG_WORKSPACE_CATALOG_PATH" },
  "topology.root": { primary: "OPENRIG_TOPOLOGY_ROOT" },
  "context.root": { primary: "OPENRIG_CONTEXT_ROOT" },
  "context.system_world": { primary: "OPENRIG_CONTEXT_SYSTEM_WORLD" },
  "skills.root": { primary: "OPENRIG_SKILLS_ROOT" },
  "onboarding.default_pack.enabled": { primary: "OPENRIG_ONBOARDING_DEFAULT_PACK_ENABLED" },
  "health.context_pressure.warning_percent": { primary: "OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT" },
  "health.context_pressure.critical_percent": { primary: "OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT" },
  "files.allowlist": { primary: "OPENRIG_FILES_ALLOWLIST" },
  "progress.scan_roots": { primary: "OPENRIG_PROGRESS_SCAN_ROOTS" },
  "ui.preview.refresh_interval_seconds": { primary: "OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS" },
  "ui.preview.max_pins": { primary: "OPENRIG_UI_PREVIEW_MAX_PINS" },
  "ui.timezone": { primary: "OPENRIG_UI_TIMEZONE" },
  "ui.preview.default_lines": { primary: "OPENRIG_UI_PREVIEW_DEFAULT_LINES" },
  "ui.terminal.max_live_terminals": { primary: "OPENRIG_UI_TERMINAL_MAX_LIVE_TERMINALS" },
  "recovery.auto_drive_provider_prompts": { primary: "OPENRIG_RECOVERY_AUTO_DRIVE_PROVIDER_PROMPTS" },
  "recovery.provider_auth_env_allowlist": { primary: "OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST" },
  "agents.advisor_session": { primary: "OPENRIG_AGENTS_ADVISOR_SESSION" },
  "host.selected": { primary: "OPENRIG_HOST_SELECTED" },
  "host.name": { primary: "OPENRIG_HOST_NAME" },
  // OPR.0.4.6.WF5 FR-2——新 key，仅使用 OPENRIG_*。
  "workflow.exception_routing": { primary: "OPENRIG_WORKFLOW_EXCEPTION_ROUTING" },
  "agents.operator_session": { primary: "OPENRIG_AGENTS_OPERATOR_SESSION" },
  "workspace.operator_seat_name": { primary: "OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME" },
  "feed.subscriptions.action_required": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_ACTION_REQUIRED" },
  "feed.subscriptions.approvals": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_APPROVALS" },
  "feed.subscriptions.shipped": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_SHIPPED" },
  "feed.subscriptions.progress": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_PROGRESS" },
  "feed.subscriptions.audit_log": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_AUDIT_LOG" },
  // plugin-primitive 阶段 3a slice 3.5——重命名后的全新 key；按重命名后的 5-key 边界原则，
  // 只使用 OPENRIG_X 主 key（全新 key 不提供旧版 RIGGED_X）。
  "runtime.codex.hooks_enabled": { primary: "OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED" },
  // Slice 27——Claude 自动压缩策略。全新 key，仅使用 OPENRIG_X 主 key。
  "policies.claude_compaction.enabled": { primary: "OPENRIG_POLICIES_CLAUDE_COMPACTION_ENABLED" },
  "policies.claude_compaction.threshold_percent": { primary: "OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT" },
  "policies.claude_compaction.pre_compact_instruction": { primary: "OPENRIG_POLICIES_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION" },
  "policies.claude_compaction.compact_instruction": { primary: "OPENRIG_POLICIES_CLAUDE_COMPACTION_COMPACT_INSTRUCTION" },
  "policies.claude_compaction.message_inline": { primary: "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_INLINE" },
  "policies.claude_compaction.message_file_path": { primary: "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_FILE_PATH" },
  "policies.claude_compaction.post_restore_audit_instruction": { primary: "OPENRIG_POLICIES_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION" },
  "policies.idle_gate_qitem.scan_interval_seconds": { primary: "OPENRIG_POLICIES_IDLE_GATE_QITEM_SCAN_INTERVAL_SECONDS" },
  "policies.idle_gate_qitem.active_wake_interval_seconds": { primary: "OPENRIG_POLICIES_IDLE_GATE_QITEM_ACTIVE_WAKE_INTERVAL_SECONDS" },
  "policies.idle_gate_qitem.auto_register": { primary: "OPENRIG_POLICIES_IDLE_GATE_QITEM_AUTO_REGISTER" },
  "policies.idle_gate_qitem.opt_in_sessions": { primary: "OPENRIG_POLICIES_IDLE_GATE_QITEM_OPT_IN_SESSIONS" },
  "snapshots.periodic.enabled": { primary: "OPENRIG_SNAPSHOTS_PERIODIC_ENABLED" },
  "snapshots.periodic.interval_seconds": { primary: "OPENRIG_SNAPSHOTS_PERIODIC_INTERVAL_SECONDS" },
  "snapshots.periodic.retention_keep": { primary: "OPENRIG_SNAPSHOTS_PERIODIC_RETENTION_KEEP" },
  // OPR.0.4.6.02 S1——全新 key；仅使用 OPENRIG_* 主 key，不提供旧版 RIGGED_*。
  "terminal.status_bar": { primary: "OPENRIG_TERMINAL_STATUS_BAR" },
  // OPR.0.4.6.FS-1 W2——保留参数；全新 key，仅使用 OPENRIG_* 主 key。
  "retention.enabled": { primary: "OPENRIG_RETENTION_ENABLED" },
  "retention.transitions_days": { primary: "OPENRIG_RETENTION_TRANSITIONS_DAYS" },
  "retention.watchdog_days": { primary: "OPENRIG_RETENTION_WATCHDOG_DAYS" },
  "retention.usage_samples_days": { primary: "OPENRIG_RETENTION_USAGE_SAMPLES_DAYS" },
  "retention.watchdog_keep_per_job": { primary: "OPENRIG_RETENTION_WATCHDOG_KEEP_PER_JOB" },
  "retention.batch_size": { primary: "OPENRIG_RETENTION_BATCH_SIZE" },
  // S04——全新 key，仅使用 OPENRIG_* 主 key。
  "queue.pickup_stall_threshold_minutes": { primary: "OPENRIG_QUEUE_PICKUP_STALL_THRESHOLD_MINUTES" },
  "queue.stuck_sweep_interval_seconds": { primary: "OPENRIG_QUEUE_STUCK_SWEEP_INTERVAL_SECONDS" },
  "queue.stuck_sweep_unclaimed_age_minutes": { primary: "OPENRIG_QUEUE_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES" },
  "queue.wake_retry_interval_seconds": { primary: "OPENRIG_QUEUE_WAKE_RETRY_INTERVAL_SECONDS" },
  "queue.wake_retry_cap": { primary: "OPENRIG_QUEUE_WAKE_RETRY_CAP" },
  "queue.wake_unconfirmed_window_minutes": { primary: "OPENRIG_QUEUE_WAKE_UNCONFIRMED_WINDOW_MINUTES" },
  "queue.wake_swap_grace_seconds": { primary: "OPENRIG_QUEUE_WAKE_SWAP_GRACE_SECONDS" },
};

const KEY_TO_PATH: Record<SettingsValidKey, string[]> = {
  "daemon.port": ["daemon", "port"],
  "daemon.host": ["daemon", "host"],
  "db.path": ["db", "path"],
  "transcripts.enabled": ["transcripts", "enabled"],
  "transcripts.path": ["transcripts", "path"],
  "transcripts.lines": ["transcripts", "lines"],
  "transcripts.poll_interval_seconds": ["transcripts", "pollIntervalSeconds"],
  "workspace.root": ["workspace", "root"],
  "workspace.slices_root": ["workspace", "slicesRoot"],
  "workspace.steering_path": ["workspace", "steeringPath"],
  "workspace.specs_root": ["workspace", "specsRoot"],
  "workspace.projects_root": ["workspace", "projectsRoot"],
  "workspace.catalog_path": ["workspace", "catalogPath"],
  "topology.root": ["topology", "root"],
  "context.root": ["context", "root"],
  "context.system_world": ["context", "systemWorld"],
  "skills.root": ["skills", "root"],
  "onboarding.default_pack.enabled": ["onboarding", "defaultPack", "enabled"],
  "health.context_pressure.warning_percent": ["health", "contextPressure", "warningPercent"],
  "health.context_pressure.critical_percent": ["health", "contextPressure", "criticalPercent"],
  "files.allowlist": ["files", "allowlist"],
  "progress.scan_roots": ["progress", "scanRoots"],
  "ui.preview.refresh_interval_seconds": ["ui", "preview", "refreshIntervalSeconds"],
  "ui.preview.max_pins": ["ui", "preview", "maxPins"],
  "ui.timezone": ["ui", "timezone"],
  "ui.preview.default_lines": ["ui", "preview", "defaultLines"],
  "ui.terminal.max_live_terminals": ["ui", "terminal", "maxLiveTerminals"],
  "recovery.auto_drive_provider_prompts": ["recovery", "autoDriveProviderPrompts"],
  "recovery.provider_auth_env_allowlist": ["recovery", "providerAuthEnvAllowlist"],
  "agents.advisor_session": ["agents", "advisorSession"],
  "host.selected": ["host", "selected"],
  "host.name": ["host", "name"],
  "workflow.exception_routing": ["workflow", "exceptionRouting"],
  "agents.operator_session": ["agents", "operatorSession"],
  "workspace.operator_seat_name": ["workspace", "operatorSeatName"],
  "feed.subscriptions.action_required": ["feed", "subscriptions", "actionRequired"],
  "feed.subscriptions.approvals": ["feed", "subscriptions", "approvals"],
  "feed.subscriptions.shipped": ["feed", "subscriptions", "shipped"],
  "feed.subscriptions.progress": ["feed", "subscriptions", "progress"],
  "feed.subscriptions.audit_log": ["feed", "subscriptions", "auditLog"],
  "runtime.codex.hooks_enabled": ["runtime", "codex", "hooksEnabled"],
  "policies.claude_compaction.enabled": ["policies", "claudeCompaction", "enabled"],
  "policies.claude_compaction.threshold_percent": ["policies", "claudeCompaction", "thresholdPercent"],
  "policies.claude_compaction.pre_compact_instruction": ["policies", "claudeCompaction", "preCompactInstruction"],
  "policies.claude_compaction.compact_instruction": ["policies", "claudeCompaction", "compactInstruction"],
  "policies.claude_compaction.message_inline": ["policies", "claudeCompaction", "messageInline"],
  "policies.claude_compaction.message_file_path": ["policies", "claudeCompaction", "messageFilePath"],
  "policies.claude_compaction.post_restore_audit_instruction": ["policies", "claudeCompaction", "postRestoreAuditInstruction"],
  "policies.idle_gate_qitem.scan_interval_seconds": ["policies", "idleGateQitem", "scanIntervalSeconds"],
  "policies.idle_gate_qitem.active_wake_interval_seconds": ["policies", "idleGateQitem", "activeWakeIntervalSeconds"],
  "policies.idle_gate_qitem.auto_register": ["policies", "idleGateQitem", "autoRegister"],
  "policies.idle_gate_qitem.opt_in_sessions": ["policies", "idleGateQitem", "optInSessions"],
  "snapshots.periodic.enabled": ["snapshots", "periodic", "enabled"],
  "snapshots.periodic.interval_seconds": ["snapshots", "periodic", "intervalSeconds"],
  "snapshots.periodic.retention_keep": ["snapshots", "periodic", "retentionKeep"],
  "terminal.status_bar": ["terminal", "statusBar"],
  "retention.enabled": ["retention", "enabled"],
  "retention.transitions_days": ["retention", "transitionsDays"],
  "retention.watchdog_days": ["retention", "watchdogDays"],
  "retention.usage_samples_days": ["retention", "usageSamplesDays"],
  "retention.watchdog_keep_per_job": ["retention", "watchdogKeepPerJob"],
  "retention.batch_size": ["retention", "batchSize"],
  "queue.pickup_stall_threshold_minutes": ["queue", "pickupStallThresholdMinutes"],
  "queue.stuck_sweep_interval_seconds": ["queue", "stuckSweepIntervalSeconds"],
  "queue.stuck_sweep_unclaimed_age_minutes": ["queue", "stuckSweepUnclaimedAgeMinutes"],
  "queue.wake_retry_interval_seconds": ["queue", "wakeRetryIntervalSeconds"],
  "queue.wake_retry_cap": ["queue", "wakeRetryCap"],
  "queue.wake_unconfirmed_window_minutes": ["queue", "wakeUnconfirmedWindowMinutes"],
  "queue.wake_swap_grace_seconds": ["queue", "wakeSwapGraceSeconds"],
};

export type SettingSource = "env" | "file" | "default";

export interface ResolvedSetting {
  value: string | number | boolean;
  source: SettingSource;
  defaultValue: string | number | boolean;
}

export function isSettingsValidKey(key: string): key is SettingsValidKey {
  return (SETTINGS_VALID_KEYS as readonly string[]).includes(key);
}

const REMOVED_CONTEXT_KEY = "context.packs_root";
const REMOVED_CONTEXT_ENV = "OPENRIG_CONTEXT_PACKS_ROOT";

export function removedContextSettingMessage(key: string): string | null {
  return key === REMOVED_CONTEXT_KEY
    ? '配置键 "context.packs_root" 已移除；请改用 "context.root"。'
    : null;
}

function assertNoRemovedContextSetting(fileConfig: Record<string, unknown>): void {
  if (process.env[REMOVED_CONTEXT_ENV]?.trim()) {
    throw new Error(
      "OPENRIG_CONTEXT_PACKS_ROOT 已移除；请改用 OPENRIG_CONTEXT_ROOT（配置键 context.root）。",
    );
  }
  if (getNestedValue(fileConfig, ["context", "packsRoot"]) !== undefined) {
    throw new Error(
      '配置文件包含已移除的键 "context.packs_root"（context.packsRoot）；请替换为 "context.root"（context.root）。',
    );
  }
}

// ── OPR.0.4.4.15（guard G15-P1 合并，架构认可）─────────────────────────
// 唯一注册的动态 key 类，不是通用动态 key 机制：
// `feed.subscriptions.<hostId>.enabled`（boolean；v1 逐主机 key 集闭合为 {enabled}）。
// 闭集纪律作用于存储的 key 语法：除 SETTINGS_VALID_KEYS 外只接受此模式；其他未知 key
// 逐字节保留现有的明确拒绝行为。hostId 段为 [A-Za-z0-9_-]+；带点主机 id 无法用点分 key 表达，
// 写入守卫会按未知 key 拒绝，读取方提示并忽略。保留段（扁平开关尾部加 'enabled'）绝不解析为
// 主机 id，因此扁平 key 与动态类不会冲突。v1 不为动态类提供环境变量映射，只支持文件/API。
// 孪生实现 packages/cli/src/config-store.ts 携带同一类（一致性测试固定两者，遵循主机注册表孪生纪律）。
const FEED_HOST_KEY_RE = /^feed\.subscriptions\.([A-Za-z0-9_-]+)\.enabled$/;
// 两种拼写都保留：key 层 snake_case 开关尾部，以及文件层 camelCase 叶名称
//（KEY_TO_PATH 把 audit_log 映射为 auditLog 等），使主机 id 在任一层都无法遮蔽扁平开关。
export const FEED_HOST_RESERVED_SEGMENTS = new Set([
  "action_required",
  "actionRequired",
  "approvals",
  "shipped",
  "progress",
  "audit_log",
  "auditLog",
  "enabled",
]);

export function parseFeedHostSubscriptionKey(key: string): { hostId: string } | null {
  const m = key.match(FEED_HOST_KEY_RE);
  if (!m) return null;
  const hostId = m[1]!;
  if (FEED_HOST_RESERVED_SEGMENTS.has(hostId)) return null;
  return { hostId };
}

function coerceFeedHostSubscriptionValue(key: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`${key} 的值无效：应为 "true" 或 "false"，实际为 "${raw}"`);
}

function readEnv(primary: string, legacy?: string): string | undefined {
  const p = process.env[primary];
  if (p !== undefined && p !== "") return p;
  if (legacy) {
    const l = process.env[legacy];
    if (l !== undefined && l !== "") return l;
  }
  return undefined;
}

function getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function deriveWorkspaceDefault(key: SettingsValidKey, workspaceRoot: string): string {
  switch (key) {
    case "workspace.slices_root":      return path.join(workspaceRoot, "missions");
    case "workspace.steering_path":    return path.join(workspaceRoot, "STEERING.md");
    case "workspace.specs_root":       return path.join(workspaceRoot, "specs");
    case "workspace.projects_root":    return path.join(workspaceRoot, "projects");
    case "workspace.catalog_path":     return path.join(workspaceRoot, "workspace.yaml");
    case "files.allowlist":            return `workspace:${workspaceRoot}`;
    case "progress.scan_roots":        return `workspace:${workspaceRoot}`;
    default: return "";
  }
}

function deriveLegacyWorkspaceDefault(key: SettingsValidKey, workspaceRoot: string): string | null {
  switch (key) {
    case "workspace.slices_root": return path.join(workspaceRoot, "slices");
    case "workspace.steering_path": return path.join(workspaceRoot, "steering", "STEERING.md");
    default: return null;
  }
}

const WORKSPACE_DERIVED_KEYS: ReadonlySet<SettingsValidKey> = new Set([
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.specs_root",
  "workspace.projects_root",
  "workspace.catalog_path",
  "files.allowlist",
  "progress.scan_roots",
]);

const DEFAULT_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION =
  "阅读 claude-compaction-restore 技能，并遵循其中的‘即将压缩时’协议。压缩前创建或更新心智模型恢复图。如果正在完成一个很小的原子步骤，请先完成该步骤；否则优先执行此准备工作。";

const DEFAULT_CLAUDE_COMPACTION_COMPACT_INSTRUCTION = "";

const DEFAULT_CLAUDE_COMPACTION_RESTORE_INSTRUCTION =
  "阅读 claude-compaction-restore 技能，并遵循其中的‘刚完成压缩时’协议。";

const DEFAULT_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION =
  "阅读 claude-compaction-restore 技能，并遵循其中的‘必需阅读深度审计’协议。";

const DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_RELATIVE_PATH = path.join(
  "compaction",
  "post-compact-extra.md",
);

export const DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_CONTENT = `# zrig 压缩后附加指令

尚未配置任务专用的附加恢复指令。

当本会话需要的上下文超出规范 claude-compaction-restore 技能所提供的内容时，
请在此添加额外文件路径、阅读清单或任务专用恢复说明。
`;

export function defaultClaudeCompactionExtraInstructionFilePath(openrigHome = path.dirname(DEFAULT_CONFIG_PATH)): string {
  return path.join(openrigHome, DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_RELATIVE_PATH);
}

export function ensureDefaultClaudeCompactionFiles(openrigHome = path.dirname(DEFAULT_CONFIG_PATH)): string {
  const filePath = defaultClaudeCompactionExtraInstructionFilePath(openrigHome);
  if (!existsSync(filePath)) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_CONTENT, "utf-8");
  }
  return filePath;
}

function getDefaultValue(key: SettingsValidKey, workspaceRoot: string): string | number | boolean {
  if (WORKSPACE_DERIVED_KEYS.has(key)) {
    return deriveWorkspaceDefault(key, workspaceRoot);
  }
  switch (key) {
    case "daemon.port": return 7433;
    case "daemon.host": return "127.0.0.1";
    case "db.path": return path.join(path.dirname(DEFAULT_CONFIG_PATH), "openrig.sqlite");
    case "transcripts.enabled": return true;
    case "transcripts.path": return path.join(path.dirname(DEFAULT_CONFIG_PATH), "transcripts");
    // V1 发布前 CLI/后台服务 Item 1——capture-pane 轮换默认值。
    case "transcripts.lines": return 1000;
    case "transcripts.poll_interval_seconds": return 2;
    case "workspace.operator_seat_name": return ""; // unset: discover a registered human, never invent a kernel seat
    // OPR.0.4.6.MH1 FR-1——"local" 等同未选择远程主机（LOCAL_HOST_ID）；
    // 结构上保证 FR-2 零回归姿态。
    case "host.selected": return "local";
    // OPR.0.4.6.MH1 FR-4——本机展示名称默认值（PRD 指定）。
    case "host.name": return "localhost";
    case "workspace.root": return DEFAULT_WORKSPACE_ROOT;
    // OPR.0.5.3.6 D1——在 $OPENRIG_HOME 下派生，绝不使用 shared-docs 字面路径。
    case "topology.root": return DEFAULT_TOPOLOGY_ROOT;
    case "context.root": return DEFAULT_CONTEXT_ROOT;
    case "context.system_world": return "default";
    case "skills.root": return DEFAULT_SKILLS_ROOT;
    case "onboarding.default_pack.enabled": return true;
    case "health.context_pressure.warning_percent": return 95;
    case "health.context_pressure.critical_percent": return 99;
    // Preview Terminal v0（PL-018）默认值，与 cli/src/config-store.ts 一致。
    case "ui.preview.refresh_interval_seconds": return 3;
    case "ui.preview.max_pins": return 4;
    case "ui.preview.default_lines": return 50;
    case "ui.timezone": return "America/Los_Angeles";
    case "recovery.auto_drive_provider_prompts": return false;
    case "recovery.provider_auth_env_allowlist": return "";
    // V1 阶段 4——Advisor 默认值遵循 universal-shell.md L83；
    // Operator 按 L84 默认为空（"not configured"）。
    case "agents.advisor_session": return "advisor-lead@openrig-velocity";
    case "agents.operator_session": return "";
    // V1 阶段 5 P5-3——“为你推荐”feed 订阅默认值遵循 for-you-feed.md L144–L151。
    // UI 强制开启 action_required（按 L145 不可关闭，它承载关键 human-gate 项）；
    // approvals/shipped/progress 默认开启，audit_log 默认关闭（输出详细，排障时选择启用）。
    case "feed.subscriptions.action_required": return true;
    case "feed.subscriptions.approvals": return true;
    case "feed.subscriptions.shipped": return true;
    case "feed.subscriptions.progress": return true;
    case "feed.subscriptions.audit_log": return false;
    // plugin-primitive 阶段 3a slice 3.5——Codex 功能开关默认开启。
    // 除非操作员显式设为 false，否则后台服务在启动时确保 ~/.codex/config.toml 中
    // `codex_hooks = true`。
    case "runtime.codex.hooks_enabled": return true;
    // Slice 27——Claude 自动压缩策略默认值。选择启用，默认关闭；按 spec 阈值为 80%。
    // 压缩前后默认值指向规范恢复 skill；compact_instruction 有意留空，因为 Claude 原生
    // 压缩摘要不如显式的压缩前和压缩后用户通道流程可靠。
    case "policies.claude_compaction.enabled": return false;
    case "policies.claude_compaction.threshold_percent": return 80;
    case "policies.claude_compaction.pre_compact_instruction": return DEFAULT_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION;
    case "policies.claude_compaction.compact_instruction": return DEFAULT_CLAUDE_COMPACTION_COMPACT_INSTRUCTION;
    case "policies.claude_compaction.message_inline": return DEFAULT_CLAUDE_COMPACTION_RESTORE_INSTRUCTION;
    case "policies.claude_compaction.message_file_path": return defaultClaudeCompactionExtraInstructionFilePath();
    case "policies.claude_compaction.post_restore_audit_instruction": return DEFAULT_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION;
    case "policies.idle_gate_qitem.scan_interval_seconds": return 60;
    case "policies.idle_gate_qitem.active_wake_interval_seconds": return 900;
    // B6——按创始人裁定默认不开启；"all" 是全队列显式选择启用。
    case "policies.idle_gate_qitem.auto_register": return "off";
    case "policies.idle_gate_qitem.opt_in_sessions": return "";
    case "snapshots.periodic.enabled": return true;
    case "snapshots.periodic.interval_seconds": return 300;
    case "snapshots.periodic.retention_keep": return 10;
    // OPR.0.4.6.02 S1——启动时默认关闭内层 tmux 状态栏；Herdr 窗格标签已携带身份，
    // 内层 tmux 状态栏属于重复 chrome。操作员开关只影响未来启动。
    case "terminal.status_bar": return false;
    // OPR.0.4.6.FS-1 W2——保留默认值（架构 D3 安全值：归档超过 30 天的终态旧 transition；
    // 清理超过 14 天的 watchdog_history，每个 job 保留 50 条；每个有界批次 500 行/qitem；默认启用）。
    case "retention.enabled": return true;
    case "retention.transitions_days": return 30;
    case "retention.watchdog_days": return 14;
    case "retention.usage_samples_days": return 14;
    case "retention.watchdog_keep_per_job": return 50;
    case "retention.batch_size": return 500;
    case "queue.pickup_stall_threshold_minutes": return 3;
    case "queue.stuck_sweep_interval_seconds": return 300;
    case "queue.stuck_sweep_unclaimed_age_minutes": return 60;
    case "queue.wake_retry_interval_seconds": return 300;
    case "queue.wake_retry_cap": return 3;
    case "queue.wake_unconfirmed_window_minutes": return 30;
    case "queue.wake_swap_grace_seconds": return 180;
    default: return "";
  }
}

function coerceValue(key: SettingsValidKey, raw: string, workspaceRoot: string): string | number | boolean {
  const def = getDefaultValue(key, workspaceRoot);
  if (typeof def === "number") {
    const n = parseInt(raw, 10);
    if (isNaN(n)) throw new Error(`${key} 的值无效：应为数字，实际为 "${raw}"`);
    return n;
  }
  if (typeof def === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new Error(`${key} 的值无效：应为 true/false，实际为 "${raw}"`);
  }
  return raw;
}

// Slice 27——`set()` 中在 coerceValue 之后应用的严格逐 key 约束校验器。
// 与 cli/src/config-store.ts KEY_CONSTRAINTS 同步，使后台服务 HTTP 写入表面
//（/api/config POST）拒绝与 CLI 相同的输入。
function positiveIntegerConstraint(key: string) {
  return (raw: string, coerced: string | number | boolean): void => {
    if (!/^\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced <= 0) {
      throw new Error(`${key} 的值无效：必须为正整数，实际为 "${raw}"`);
    }
  };
}

function percentageConstraint(key: string) {
  return (raw: string, coerced: string | number | boolean): void => {
    if (!/^\d+$/.test((raw ?? "").trim())
      || typeof coerced !== "number"
      || !Number.isInteger(coerced)
      || coerced < 1
      || coerced > 100) {
      throw new Error(`${key} 的值无效：必须为 [1, 100] 范围内的整数，实际为 "${raw}"`);
    }
  };
}

const KEY_CONSTRAINTS: Partial<Record<SettingsValidKey, (raw: string, coerced: string | number | boolean) => void>> = {
  "ui.timezone": (_raw, value) => {
    try {
      if (typeof value !== "string" || !value || /^[+-]/.test(value)) throw new Error();
      new Intl.DateTimeFormat("en-US", { timeZone: value });
    } catch { throw new Error("ui.timezone 无效：请使用 IANA 时区，例如 America/Los_Angeles 或 Europe/London"); }
  },
  "health.context_pressure.warning_percent": percentageConstraint("health.context_pressure.warning_percent"),
  "health.context_pressure.critical_percent": percentageConstraint("health.context_pressure.critical_percent"),
  "policies.idle_gate_qitem.scan_interval_seconds": positiveIntegerConstraint("policies.idle_gate_qitem.scan_interval_seconds"),
  "policies.idle_gate_qitem.active_wake_interval_seconds": positiveIntegerConstraint("policies.idle_gate_qitem.active_wake_interval_seconds"),
  "policies.idle_gate_qitem.auto_register": (raw) => {
    const v = (raw ?? "").trim();
    if (v !== "off" && v !== "all") {
      throw new Error(`policies.idle_gate_qitem.auto_register 的值无效：必须为 "off" 或 "all"，实际为 "${raw}"`);
    }
  },
  // 策略阈值：范围 [1, 100] 的整数，契约见 slice 27 README。parseInt 的宽松转换
  //（"80abc" → 80；"80.5" → 80）不适用于后台服务压缩触发器每次轮询都会读取的 key；
  // 按既有 feedback_static_gates_mirror_runtime_validators，运行时校验器拒绝契约禁止的输入。
  "policies.claude_compaction.threshold_percent": (raw, coerced) => {
    const trimmed = (raw ?? "").trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `policies.claude_compaction.threshold_percent 的值无效：应为 [1, 100] 范围内的整数，实际为 "${raw}"`,
      );
    }
    if (typeof coerced !== "number" || !Number.isInteger(coerced)) {
      throw new Error(
        `policies.claude_compaction.threshold_percent 的值无效：应为 [1, 100] 范围内的整数，实际为 "${raw}"`,
      );
    }
    if (coerced < 1 || coerced > 100) {
      throw new Error(
        `policies.claude_compaction.threshold_percent 的值无效：必须在 [1, 100] 范围内，实际为 ${coerced}`,
      );
    }
  },
  "snapshots.periodic.interval_seconds": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim())) {
      throw new Error(
        `snapshots.periodic.interval_seconds 的值无效：应为大于等于 60 的整数，实际为 "${raw}"`,
      );
    }
    if (typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 60) {
      throw new Error(
        `snapshots.periodic.interval_seconds 的值无效：必须大于等于 60，实际为 ${raw}`,
      );
    }
  },
  "snapshots.periodic.retention_keep": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim())) {
      throw new Error(
        `snapshots.periodic.retention_keep 的值无效：应为大于等于 1 的整数，实际为 "${raw}"`,
      );
    }
    if (typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(
        `snapshots.periodic.retention_keep 的值无效：必须大于等于 1，实际为 ${raw}`,
      );
    }
  },
  // OPR.0.4.6.FS-1 W2——保留数值边界（架构 D3）。与 cli/src/config-store.ts
  // KEY_CONSTRAINTS 孪生实现同步，使后台服务 HTTP 写入表面精确拒绝 CLI 所拒绝的输入。
  // `retention.enabled` 是 boolean（coerceValue 强制 true/false），无需约束条目。
  "retention.transitions_days": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(`retention.transitions_days 的值无效：必须为大于等于 1 的整数，实际为 "${raw}"`);
    }
  },
  "retention.watchdog_days": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(`retention.watchdog_days 的值无效：必须为大于等于 1 的整数，实际为 "${raw}"`);
    }
  },
  "retention.usage_samples_days": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(`retention.usage_samples_days 的值无效：必须为大于等于 1 的整数，实际为 "${raw}"`);
    }
  },
  "retention.watchdog_keep_per_job": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 0) {
      throw new Error(`retention.watchdog_keep_per_job 的值无效：必须为大于等于 0 的整数，实际为 "${raw}"`);
    }
  },
  "retention.batch_size": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(`retention.batch_size 的值无效：必须为大于等于 1 的整数，实际为 "${raw}"`);
    }
  },
  "queue.pickup_stall_threshold_minutes": positiveIntegerConstraint("queue.pickup_stall_threshold_minutes"),
  "queue.stuck_sweep_interval_seconds": positiveIntegerConstraint("queue.stuck_sweep_interval_seconds"),
  "queue.stuck_sweep_unclaimed_age_minutes": positiveIntegerConstraint("queue.stuck_sweep_unclaimed_age_minutes"),
  // S01——唤醒或升级阶梯参数（同一正整数契约）。
  "queue.wake_retry_interval_seconds": positiveIntegerConstraint("queue.wake_retry_interval_seconds"),
  "queue.wake_retry_cap": positiveIntegerConstraint("queue.wake_retry_cap"),
  "queue.wake_unconfirmed_window_minutes": positiveIntegerConstraint("queue.wake_unconfirmed_window_minutes"),
  "queue.wake_swap_grace_seconds": positiveIntegerConstraint("queue.wake_swap_grace_seconds"),
};

function validateKeyConstraints(key: SettingsValidKey, raw: string, coerced: string | number | boolean): void {
  const check = KEY_CONSTRAINTS[key];
  if (check) check(raw, coerced);
}

// Slice 27 BLOCKING-FIX-2——共享转换与校验。由 set()（后台服务写入路径）、resolveOne
// 环境变量来源分支，以及 resolveOne 文件来源分支经 validateTypedFileValue 使用。
// 与 cli/src/config-store.ts 同步，使每个输入层都按既有
// feedback_audit_every_layer_function_and_module_constants 应用同一契约。
function coerceAndValidate(key: SettingsValidKey, raw: string, workspaceRoot: string): string | number | boolean {
  const coerced = coerceValue(key, raw, workspaceRoot);
  validateKeyConstraints(key, raw, coerced);
  return coerced;
}

function validateTypedFileValue(key: SettingsValidKey, value: string | number | boolean): void {
  const check = KEY_CONSTRAINTS[key];
  if (!check) return;
  const raw = typeof value === "string" ? value : String(value);
  check(raw, value);
}

/**
 * Slice 27——投影后的 Claude 自动压缩策略。ContextMonitor 每次轮询都消费此快照；
 * PreCompact hook 通过直接读取 config.json 使用同一结构，无需依赖后台服务。
 */
export interface ClaudeCompactionPolicy {
  enabled: boolean;
  thresholdPercent: number;
  preCompactInstruction: string;
  compactInstruction: string;
  messageInline: string;
  messageFilePath: string;
  postRestoreAuditInstruction: string;
}

export interface ContextPressurePolicy {
  warningPercent: number;
  criticalPercent: number;
}

export interface ResolvedConfig {
  skillsRoot: string;
  contextRoot: string;
  systemWorld: string;
  topologyRoot: string;
  workspaceRoot: string;
  workspaceSlicesRoot: string;
  workspaceSteeringPath: string;
  workspaceSpecsRoot: string;
  workspaceProjectsRoot: string;
  workspaceCatalogPath: string;
  // 操作员显式选择；为空时由消费方发现身份。
  workspaceOperatorSeatName: string;
  filesAllowlistRaw: string;
  progressScanRootsRaw: string;
  // Preview Terminal v0（PL-018）——UI 预览偏好。
  uiPreviewRefreshIntervalSeconds: number;
  uiPreviewMaxPins: number;
  uiPreviewDefaultLines: number;
  recoveryAutoDriveProviderPrompts: boolean;
  recoveryProviderAuthEnvAllowlistRaw: string;
}

export class SettingsStore {
  readonly configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? DEFAULT_CONFIG_PATH;
  }

  resolveOne(key: SettingsValidKey, fileConfig?: Record<string, unknown>, workspaceRoot?: string): ResolvedSetting {
    const fc = fileConfig ?? this.readConfigFile();
    assertNoRemovedContextSetting(fc);
    const wr = workspaceRoot ?? this.resolveWorkspaceRootRaw(fc);
    if (key === "health.context_pressure.warning_percent" || key === "health.context_pressure.critical_percent") {
      return this.resolveContextPressurePair(fc, wr)[key];
    }
    return this.resolveOneUnpaired(key, fc, wr);
  }

  private resolveContextPressurePair(
    fileConfig: Record<string, unknown>,
    workspaceRoot: string,
  ): Record<"health.context_pressure.warning_percent" | "health.context_pressure.critical_percent", ResolvedSetting> {
    const warningKey = "health.context_pressure.warning_percent" as const;
    const criticalKey = "health.context_pressure.critical_percent" as const;
    const warning = this.resolveOneUnpaired(warningKey, fileConfig, workspaceRoot);
    const critical = this.resolveOneUnpaired(criticalKey, fileConfig, workspaceRoot);
    if ((warning.value as number) < (critical.value as number)) {
      return { [warningKey]: warning, [criticalKey]: critical };
    }
    process.stderr.write(
      `[openrig-settings] context-pressure policy rejected: warning (${warning.value}) must be less than critical (${critical.value}); falling back to 95/99 defaults\n`,
    );
    return {
      [warningKey]: { value: 95, source: "default", defaultValue: 95 },
      [criticalKey]: { value: 99, source: "default", defaultValue: 99 },
    };
  }

  private resolveOneUnpaired(key: SettingsValidKey, fc: Record<string, unknown>, wr: string): ResolvedSetting {
    const defaultValue = getDefaultValue(key, wr);
    // Slice 27 BLOCKING-FIX-2——校验环境变量覆盖；环境变量无效时丢弃覆盖并提示，
    // 使操作员能在后台服务 stderr（由 capture-pane / log 呈现）看到错误配置。
    // 错误环境变量绝不污染解析值。
    const envVal = readEnv(ENV_MAP[key].primary, ENV_MAP[key].legacy);
    if (envVal !== undefined && envVal !== "") {
      try {
        return { value: coerceAndValidate(key, envVal, wr), source: "env", defaultValue };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[openrig-settings] env override for ${key} rejected: ${reason}; falling back to file/default\n`,
        );
      }
    }
    const fileVal = getNestedValue(fc, KEY_TO_PATH[key]);
    if (fileVal !== undefined && fileVal !== null && fileVal !== "") {
      const legacyDefault = deriveLegacyWorkspaceDefault(key, wr);
      if (legacyDefault !== null && fileVal === legacyDefault) {
        return { value: defaultValue, source: "default", defaultValue };
      }
      // 同样校验文件来源值。手工编辑的 config.json 若包含错误阈值
      //（0、"80abc"、80.5 等），则回退默认值，而不是污染触发契约。
      try {
        validateTypedFileValue(key, fileVal as string | number | boolean);
        return { value: fileVal as string | number | boolean, source: "file", defaultValue };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[openrig-settings] file value for ${key} rejected: ${reason}; falling back to default\n`,
        );
      }
    }
    return { value: defaultValue, source: "default", defaultValue };
  }

  resolveAllWithSource(): Record<SettingsValidKey, ResolvedSetting> {
    const fc = this.readConfigFile();
    const wr = this.resolveWorkspaceRootRaw(fc);
    const out = {} as Record<SettingsValidKey, ResolvedSetting>;
    for (const key of SETTINGS_VALID_KEYS) {
      out[key] = this.resolveOne(key, fc, wr);
    }
    return out;
  }

  /** 把原始解析结果投影为供后台服务消费方使用的扁平配置结构。 */
  resolveConfig(): ResolvedConfig {
    const fc = this.readConfigFile();
    const wr = this.resolveWorkspaceRootRaw(fc);
    return {
      skillsRoot: this.resolveOne("skills.root", fc, wr).value as string,
      contextRoot: this.resolveOne("context.root", fc, wr).value as string,
      systemWorld: this.resolveOne("context.system_world", fc, wr).value as string,
      topologyRoot: this.resolveOne("topology.root", fc, wr).value as string,
      workspaceRoot: wr,
      workspaceSlicesRoot: this.resolveOne("workspace.slices_root", fc, wr).value as string,
      workspaceSteeringPath: this.resolveOne("workspace.steering_path", fc, wr).value as string,
      workspaceSpecsRoot: this.resolveOne("workspace.specs_root", fc, wr).value as string,
      workspaceProjectsRoot: this.resolveOne("workspace.projects_root", fc, wr).value as string,
      workspaceCatalogPath: this.resolveOne("workspace.catalog_path", fc, wr).value as string,
      workspaceOperatorSeatName: this.resolveOne("workspace.operator_seat_name", fc, wr).value as string,
      filesAllowlistRaw: this.resolveOne("files.allowlist", fc, wr).value as string,
      progressScanRootsRaw: this.resolveOne("progress.scan_roots", fc, wr).value as string,
      uiPreviewRefreshIntervalSeconds: this.resolveOne("ui.preview.refresh_interval_seconds", fc, wr).value as number,
      uiPreviewMaxPins: this.resolveOne("ui.preview.max_pins", fc, wr).value as number,
      uiPreviewDefaultLines: this.resolveOne("ui.preview.default_lines", fc, wr).value as number,
      recoveryAutoDriveProviderPrompts: this.resolveOne("recovery.auto_drive_provider_prompts", fc, wr).value as boolean,
      recoveryProviderAuthEnvAllowlistRaw: this.resolveOne("recovery.provider_auth_env_allowlist", fc, wr).value as string,
    };
  }

  /**
   * Slice 27——把 Claude 自动压缩策略读取为类型化快照。ContextMonitor 每次轮询时调用，
   * 使对 ~/.openrig/config.json 的实时编辑无需重启后台服务，即可在一个轮询周期内生效。
   */
  resolveClaudeCompactionPolicy(): ClaudeCompactionPolicy {
    const fc = this.readConfigFile();
    const wr = this.resolveWorkspaceRootRaw(fc);
    return {
      enabled: this.resolveOne("policies.claude_compaction.enabled", fc, wr).value as boolean,
      thresholdPercent: this.resolveOne("policies.claude_compaction.threshold_percent", fc, wr).value as number,
      preCompactInstruction: this.resolveOne("policies.claude_compaction.pre_compact_instruction", fc, wr).value as string,
      compactInstruction: this.resolveOne("policies.claude_compaction.compact_instruction", fc, wr).value as string,
      messageInline: this.resolveOne("policies.claude_compaction.message_inline", fc, wr).value as string,
      messageFilePath: this.resolveOne("policies.claude_compaction.message_file_path", fc, wr).value as string,
      postRestoreAuditInstruction: this.resolveOne("policies.claude_compaction.post_restore_audit_instruction", fc, wr).value as string,
    };
  }

  /** 每次重新读取上下文压力检测策略；变更在下一次投影时生效。 */
  resolveContextPressurePolicy(): ContextPressurePolicy {
    const fc = this.readConfigFile();
    const wr = this.resolveWorkspaceRootRaw(fc);
    const pair = this.resolveContextPressurePair(fc, wr);
    return {
      warningPercent: pair["health.context_pressure.warning_percent"].value as number,
      criticalPercent: pair["health.context_pressure.critical_percent"].value as number,
    };
  }

  // GHOST-STAGE (d) CLI ConfigStore 守卫的孪生实现：回读校验并明确失败。写入后重新读取
  // this.configPath（规范配置），确认值已持久化；不匹配表示写入静默失败，应明确拒绝而不是报告
  // 虚假成功（config-set-success-without-persist）。后台服务已经写入规范位置
  //（DEFAULT_CONFIG_PATH），因此这是成对修复中的纵深防御部分。
  private verifyPersisted(keyPath: string[], expected: unknown): void {
    let reread: Record<string, unknown>;
    try {
      reread = JSON.parse(readFileSync(this.configPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `配置写入未持久化：无法从 ${this.configPath} 读回（${(e as Error).message}）。拒绝报告成功。`,
      );
    }
    const got = getNestedValue(reread, keyPath);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error(
        `配置写入未持久化到 ${this.configPath}：[${keyPath.join(".")}] 仍为 ${JSON.stringify(got)}（预期 ${JSON.stringify(expected)}）。拒绝报告虚假成功。`,
      );
    }
  }

  set(key: string, value: string): void {
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) throw new Error(removedMessage);
    // OPR.0.4.4.15：此处接受唯一注册的动态类；其他所有未知 key 逐字节保持下方明确拒绝行为。
    const feedHost = parseFeedHostSubscriptionKey(key);
    if (feedHost) {
      const coercedDyn = coerceFeedHostSubscriptionValue(key, value);
      const fcDyn = this.readConfigFile();
      setNestedValue(fcDyn, ["feed", "subscriptions", feedHost.hostId, "enabled"], coercedDyn);
      mkdirSync(path.dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(fcDyn, null, 2) + "\n", "utf-8");
      this.verifyPersisted(["feed", "subscriptions", feedHost.hostId, "enabled"], coercedDyn);
      return;
    }
    if (!isSettingsValidKey(key)) {
      throw new Error(`未知配置键 "${key}"。有效键：${SETTINGS_VALID_KEYS.join(", ")}`);
    }
    const fc = this.readConfigFile();
    const wr = this.resolveWorkspaceRootRaw(fc);
    const coerced = coerceAndValidate(key, value, wr);
    setNestedValue(fc, KEY_TO_PATH[key], coerced);
    if (key === "health.context_pressure.warning_percent" || key === "health.context_pressure.critical_percent") {
      const warning = getNestedValue(fc, KEY_TO_PATH["health.context_pressure.warning_percent"])
        ?? getDefaultValue("health.context_pressure.warning_percent", wr);
      const critical = getNestedValue(fc, KEY_TO_PATH["health.context_pressure.critical_percent"])
        ?? getDefaultValue("health.context_pressure.critical_percent", wr);
      if ((warning as number) >= (critical as number)) {
        throw new Error(`上下文压力策略无效：warning (${warning}) 必须小于 critical (${critical})`);
      }
    }
    mkdirSync(path.dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(fc, null, 2) + "\n", "utf-8");
    this.verifyPersisted(KEY_TO_PATH[key], coerced);
  }

  /** OPR.0.4.4.15——解析一个动态 feed-host 订阅 key。只支持文件或默认值
   *（v1 不为动态类提供环境变量映射）；默认 false 表示未订阅。
   * 不属于已注册类的 key 返回 null。 */
  resolveFeedHostSubscription(key: string): ResolvedSetting | null {
    const feedHost = parseFeedHostSubscriptionKey(key);
    if (!feedHost) return null;
    const fc = this.readConfigFile();
    const fileVal = getNestedValue(fc, ["feed", "subscriptions", feedHost.hostId, "enabled"]);
    if (typeof fileVal === "boolean") return { value: fileVal, source: "file", defaultValue: false };
    return { value: false, source: "default", defaultValue: false };
  }

  /** OPR.0.4.4.15——枚举持久化的逐主机订阅（聚合器读取）。保留段与不合规结构会收到提示并被忽略；
   * 这是已批准的守卫：操作员错误明确可见，绝不误解析，也绝不拒绝整个配置。 */
  listFeedHostSubscriptions(): Array<{ hostId: string; enabled: boolean }> {
    const fc = this.readConfigFile();
    const subs = getNestedValue(fc, ["feed", "subscriptions"]);
    if (subs === null || subs === undefined || typeof subs !== "object" || Array.isArray(subs)) return [];
    const out: Array<{ hostId: string; enabled: boolean }> = [];
    for (const [segment, node] of Object.entries(subs as Record<string, unknown>)) {
      if (node === null || typeof node !== "object" || Array.isArray(node)) continue; // 扁平开关叶节点，不是主机节点
      if (FEED_HOST_RESERVED_SEGMENTS.has(segment) || !/^[A-Za-z0-9_-]+$/.test(segment)) {
        process.stderr.write(
          `[openrig-settings] feed.subscriptions.${segment} ignored as a host subscription: segment is ${FEED_HOST_RESERVED_SEGMENTS.has(segment) ? "a reserved toggle name" : "not a valid host id segment ([A-Za-z0-9_-]+)"}\n`,
        );
        continue;
      }
      const enabled = (node as Record<string, unknown>)["enabled"];
      if (typeof enabled !== "boolean") {
        process.stderr.write(`[openrig-settings] feed.subscriptions.${segment}.enabled ignored: expected boolean, got ${JSON.stringify(enabled)}\n`);
        continue;
      }
      out.push({ hostId: segment, enabled });
    }
    return out;
  }

  reset(key?: string): void {
    if (key === undefined) {
      try { unlinkSync(this.configPath); } catch { /* 文件不存在也正常 */ }
      return;
    }
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) throw new Error(removedMessage);
    // OPR.0.4.4.15：重置动态类时移除整个主机节点，取消订阅不留残余。
    const feedHost = parseFeedHostSubscriptionKey(key);
    if (feedHost) {
      if (!existsSync(this.configPath)) return;
      const fcDyn = this.readConfigFile();
      const parent = getNestedValue(fcDyn, ["feed", "subscriptions"]) as Record<string, unknown> | undefined;
      if (parent && feedHost.hostId in parent) delete parent[feedHost.hostId];
      writeFileSync(this.configPath, JSON.stringify(fcDyn, null, 2) + "\n", "utf-8");
      return;
    }
    if (!isSettingsValidKey(key)) {
      throw new Error(`未知配置键 "${key}"。有效键：${SETTINGS_VALID_KEYS.join(", ")}`);
    }
    if (!existsSync(this.configPath)) return;
    const fc = this.readConfigFile();
    const parts = KEY_TO_PATH[key];
    const parent = getNestedValue(fc, parts.slice(0, -1)) as Record<string, unknown> | undefined;
    if (parent && parts[parts.length - 1]! in parent) {
      delete parent[parts[parts.length - 1]!];
      if (key === "health.context_pressure.warning_percent" || key === "health.context_pressure.critical_percent") {
        const workspaceRoot = this.resolveWorkspaceRootRaw(fc);
        const warning = getNestedValue(fc, KEY_TO_PATH["health.context_pressure.warning_percent"])
          ?? getDefaultValue("health.context_pressure.warning_percent", workspaceRoot);
        const critical = getNestedValue(fc, KEY_TO_PATH["health.context_pressure.critical_percent"])
          ?? getDefaultValue("health.context_pressure.critical_percent", workspaceRoot);
        if ((warning as number) >= (critical as number)) {
          throw new Error(`上下文压力策略无效：warning (${warning}) 必须小于 critical (${critical})`);
        }
      }
    }
    writeFileSync(this.configPath, JSON.stringify(fc, null, 2) + "\n", "utf-8");
  }

  private resolveWorkspaceRootRaw(fileConfig: Record<string, unknown>): string {
    const envVal = readEnv(ENV_MAP["workspace.root"].primary, ENV_MAP["workspace.root"].legacy);
    if (envVal) return envVal;
    const fileVal = getNestedValue(fileConfig, KEY_TO_PATH["workspace.root"]) as string | undefined;
    if (fileVal) return fileVal;
    return DEFAULT_WORKSPACE_ROOT;
  }

  private readConfigFile(): Record<string, unknown> {
    let parsed: Record<string, unknown> = {};
    if (existsSync(this.configPath)) {
      const raw = readFileSync(this.configPath, "utf-8");
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(
          `${this.configPath} 中的配置文件格式错误。请修复 JSON，或运行：zrig config reset`,
        );
      }
    }
    assertNoRemovedContextSetting(parsed);
    return parsed;
  }
}

// --- User Settings v0：共享解码器 ---

export interface NamedPair {
  name: string;
  path: string;
}

export function parseNamedPairs(raw: string): NamedPair[] {
  if (!raw || !raw.trim()) return [];
  const out = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const rawPath = trimmed.slice(colon + 1).trim();
    if (!name || !rawPath) continue;
    out.set(name, rawPath);
  }
  return Array.from(out.entries()).map(([name, path]) => ({ name, path }));
}
