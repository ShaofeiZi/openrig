import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  getDefaultOpenRigPath,
  readOpenRigEnv,
} from "./openrig-compat.js";

// 用户设置 v0——为现有 ConfigStore 增加命名空间（workspace.*、files.*、progress.*），
// 不改变原有 5 个 daemon/db/transcripts 键的行为。存储仍以 ~/.openrig/config.json
// 为唯一事实来源；解析优先级仍为 env > file > default。

export interface RiggedConfig {
  daemon: { port: number; host: string };
  // OPR.0.4.6.MH1 FR-1——持久化的主机选择指针。
  // OPR.0.4.6.MH1 FR-4——本机展示名（默认 `localhost`）。
  host: { selected: string; name: string };
  db: { path: string };
  transcripts: {
    enabled: boolean;
    path: string;
    // V1 预发布 CLI/daemon 第 1 项——capture-pane 轮转调节项。
    // 预发布 ACK §5 声明的 SC-29 例外 #4：与阶段 4/阶段 5 的先前例外采用相同白名单形态。
    lines: number;
    pollIntervalSeconds: number;
  };
  // 用户设置 v0——工作区路径。由操作者显式选择；未设置时把人工发现委托给注册表。
  workspace: {
    root: string;
    slicesRoot: string;
    steeringPath: string;
    specsRoot: string;
    projectsRoot: string;
    catalogPath: string;
    operatorSeatName: string;
  };
  // OPR.0.5.3.6 D1——拓扑树根（另一棵树以 instance 为顶层，下面是
  // rigs/<rig>/seats/<seat>）。与后台服务 settings-store 孪生。
  topology: {
    root: string;
  };
  // OPR.0.5.9.5 波次 B——可寻址上下文库根（`rig context add` 安装到此处）。
  // 已移除的 packsRoot 形态会被拒绝，绝不桥接。
  context: {
    root: string;
    systemWorld: string;
  };
  skills: {
    root: string;
  };
  onboarding: {
    defaultPack: {
      enabled: boolean;
    };
  };
  health: {
    contextPressure: {
      warningPercent: number;
      criticalPercent: number;
    };
  };
  // 用户设置 v0——UEP 环境变量转正。值以原始具名对字符串
  //（`name:/abs/path,...`）存储，与 OPENRIG_FILES_ALLOWLIST /
  // OPENRIG_PROGRESS_SCAN_ROOTS 格式一致；解析辅助函数 parseNamedPairs
  // 将其转换为结构化数组。
  files: {
    allowlist: string;
  };
  progress: {
    scanRoots: string;
  };
  // 终端预览 v0（PL-018）——实时终端预览 pane 的 UI 侧偏好。
  ui: {
    timezone: string;
    preview: {
      refreshIntervalSeconds: number;
      maxPins: number;
      defaultLines: number;
    };
  };
  recovery: {
    autoDriveProviderPrompts: boolean;
    providerAuthEnvAllowlist: string;
  };
  // V1 第三次尝试阶段 4——按 universal-shell.md L82–L84 提供顾问/操作者导轨图标的
  // V1 占位项。SC-29 例外：只增加白名单，不增加 schema 迁移、新端点或事件类型。
  agents: {
    advisorSession: string;
    operatorSession: string;
  };
  // V1 第三次尝试阶段 5 P5-3——按 for-you-feed.md L144–L151 提供“为你推荐”动态
  // 订阅开关。阶段 5 派发 ACK §5 DRIFT P5-D2 声明的 SC-29 例外：范围与阶段 4
  // 相同，只增加白名单，不增加迁移、新端点或事件类型。
  feed: {
    subscriptions: {
      actionRequired: boolean;
      approvals: boolean;
      shipped: boolean;
      progress: boolean;
      auditLog: boolean;
    };
  };
  // plugin-primitive 阶段 3a slice 3.5——运行时功能标志。当前只有 Codex 一个标志；
  // 若累积到 3 个以上，按 DESIGN.md §5.8 抽成独立原语工作区。
  runtime: {
    codex: {
      hooksEnabled: boolean;
    };
  };
  // Slice 27——Claude 自动压缩策略。操作者可配置压缩前触发器：Claude 席位上下文
  // 用量越过 `thresholdPercent` 时，后台服务先发送压缩准备提示，再通过 SessionTransport
  // 发送 /compact，并把 `compactInstruction` 作为斜杠命令参数传给实际压缩阶段。现有
  // PreCompact hook 会把 `messageInline` 与 `messageFilePath` 的内容连同标准恢复指令一起
  // 写入压缩后标记/上下文；之后后台服务发送 `postRestoreAuditInstruction` 作为可编辑的
  // 阅读深度提醒。
  //
  // 默认选择加入且关闭（enabled=false）。压缩指令以内联文本交付。压缩后恢复提示默认
  // 加载规范恢复技能，并读取用户拥有的附加指令文件路径，用于任务专用阅读清单。
  policies: {
    claudeCompaction: {
      enabled: boolean;
      thresholdPercent: number;
      preCompactInstruction: string;
      compactInstruction: string;
      messageInline: string;
      messageFilePath: string;
      postRestoreAuditInstruction: string;
    };
    idleGateQitem: {
      scanIntervalSeconds: number;
      activeWakeIntervalSeconds: number;
      autoRegister: string;
      optInSessions: string;
    };
  };
  snapshots: {
    periodic: {
      enabled: boolean;
      intervalSeconds: number;
      retentionKeep: number;
    };
  };
  // OPR.0.4.6.02 S1——会话启动时内部 tmux 状态栏的默认值。静态布尔值，默认关闭；
  // 与后台服务 settings-store 孪生实现保持同步。由后台服务 NodeLauncher 消费；CLI
  // 携带它以支持 `rig config get/set terminal.status_bar` 界面和孪生一致性。
  terminal: {
    statusBar: boolean;
  };
  // OPR.0.4.6.FS-1 W2——队列保留维护旋钮（后台服务 settings-store 的孪生实现）：
  // enabled 加四个有界数值调节项。
  retention: {
    enabled: boolean;
    transitionsDays: number;
    watchdogDays: number;
    watchdogKeepPerJob: number;
    batchSize: number;
  };
  // S04（OPR.0.5.5.4）——领取回执停滞阈值（后台服务 settings-store 的孪生实现）。
  // S02（OPR.0.5.5.2）——常驻卡住扫描频率与未领取义务时长（同一孪生实现）。
  queue: {
    pickupStallThresholdMinutes: number;
    stuckSweepIntervalSeconds: number;
    stuckSweepUnclaimedAgeMinutes: number;
    wakeRetryIntervalSeconds: number;
    wakeRetryCap: number;
    wakeUnconfirmedWindowMinutes: number;
    wakeSwapGraceSeconds: number;
  };
}

const DEFAULT_WORKSPACE_ROOT = getDefaultOpenRigPath("workspace");

/** OPR.0.5.3.6——后台服务 settings-store 辅助函数的孪生实现。保留旧拓扑位置的
 *  可读性（以发出建议的回退形式），使采用旧约定的工作组能迁移，而不要求一次性切换。
 *  解析旧代码真正写入的位置：遵循 Codex 适配器的 shared-docs 先例，优先
 *  OPENRIG_SHARED_DOCS_ROOT 环境变量，否则为字面路径 ~/.openrig/shared-docs，而不是
 *  $OPENRIG_HOME。使用非默认 home 的机器仍把旧树放在 ~/.openrig/shared-docs。
 *  这是 CLI 中该字面量的唯一归属；遍历器导入它，不再各自携带。 */
export function resolveLegacyTopologyRigsRoot(): string {
  const sharedDocsRoot = process.env["OPENRIG_SHARED_DOCS_ROOT"]?.trim()
    || join(homedir(), ".openrig", "shared-docs");
  return join(sharedDocsRoot, "rigs");
}

const DEFAULT_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION =
  "阅读 claude-compaction-restore 技能，并遵循其中的‘即将压缩时’协议。压缩前创建或更新心智模型恢复图。如果正在完成一个很小的原子步骤，请先完成该步骤；否则优先执行此准备工作。";

const DEFAULT_CLAUDE_COMPACTION_COMPACT_INSTRUCTION = "";

const DEFAULT_CLAUDE_COMPACTION_RESTORE_INSTRUCTION =
  "阅读 claude-compaction-restore 技能，并遵循其中的‘刚完成压缩时’协议。";

const DEFAULT_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION =
  "阅读 claude-compaction-restore 技能，并遵循其中的‘必需阅读深度审计’协议。";

const DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_PATH = getDefaultOpenRigPath(
  "compaction/post-compact-extra.md",
);

const DEFAULTS = {
  daemon: { port: 7433, host: "127.0.0.1" },
  // OPR.0.4.6.MH1 FR-1——`local` 等同于未选择远端主机（LOCAL_HOST_ID）。
  // FR-4——本机展示名，默认 `localhost`（PRD 指定）。
  host: { selected: "local", name: "localhost" },
  db: { path: getDefaultOpenRigPath("openrig.sqlite") },
  transcripts: { enabled: true, path: getDefaultOpenRigPath("transcripts"), lines: 1000, pollIntervalSeconds: 2 },
  workspace: {
    root: DEFAULT_WORKSPACE_ROOT,
    slicesRoot: "",
    steeringPath: "",
    specsRoot: "",
    projectsRoot: "",
    catalogPath: "",
    // 不生成基于用户名的虚构人工地址。
    operatorSeatName: "",
  },
  // OPR.0.5.3.6 D1——从 OpenRig home 派生，绝不使用 shared-docs 字面路径。
  topology: { root: getDefaultOpenRigPath("topology") },
  // OPR.0.5.9.5 波次 B——规范的可寻址上下文库。
  context: { root: getDefaultOpenRigPath("context"), systemWorld: "default" },
  skills: { root: getDefaultOpenRigPath("skills") },
  onboarding: { defaultPack: { enabled: true } },
  health: { contextPressure: { warningPercent: 95, criticalPercent: 99 } },
  files: { allowlist: "" },
  progress: { scanRoots: "" },
  ui: {
    timezone: "America/Los_Angeles",
    preview: {
      refreshIntervalSeconds: 3,
      maxPins: 4,
      defaultLines: 50,
    },
  },
  recovery: {
    autoDriveProviderPrompts: false,
    providerAuthEnvAllowlist: "",
  },
  // V1 阶段 4——顾问默认值遵循 universal-shell.md L83；操作者按 L84 默认为空
  //（“未配置”）。
  agents: {
    advisorSession: "advisor-lead@openrig-velocity",
    operatorSession: "",
  },
  // V1 阶段 5 P5-3——动态订阅默认值遵循 for-you-feed.md L144–L151。UI 强制开启
  // action_required（L145 的承重人工门控条目，不可关闭）；approvals/shipped/progress
  // 默认开启；audit_log 因内容较多而默认关闭，排障运行时选择加入。
  feed: {
    subscriptions: {
      actionRequired: true,
      approvals: true,
      shipped: true,
      progress: true,
      auditLog: false,
    },
  },
  // plugin-primitive 阶段 3a slice 3.5——Codex 功能标志默认开启。
  runtime: {
    codex: {
      hooksEnabled: true,
    },
  },
  // Slice 27——选择加入且默认关闭；阈值按规范默认为 80%。
  policies: {
    claudeCompaction: {
      enabled: false,
      thresholdPercent: 80,
      preCompactInstruction: DEFAULT_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION,
      compactInstruction: DEFAULT_CLAUDE_COMPACTION_COMPACT_INSTRUCTION,
      messageInline: DEFAULT_CLAUDE_COMPACTION_RESTORE_INSTRUCTION,
      messageFilePath: DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_PATH,
      postRestoreAuditInstruction: DEFAULT_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION,
    },
    idleGateQitem: {
      scanIntervalSeconds: 60,
      activeWakeIntervalSeconds: 900,
      autoRegister: "off",
      optInSessions: "",
    },
  },
  snapshots: {
    periodic: {
      enabled: true,
      intervalSeconds: 300,
      retentionKeep: 10,
    },
  },
  // OPR.0.4.6.02 S1——启动时内部 tmux 状态栏默认关闭。
  terminal: {
    statusBar: false,
  },
  // OPR.0.4.6.FS-1 W2——保留策略默认值，与后台服务 getDefaultValue 孪生。
  retention: {
    enabled: true,
    transitionsDays: 30,
    watchdogDays: 14,
    watchdogKeepPerJob: 50,
    batchSize: 500,
  },
  // S04——领取回执停滞阈值默认值，与后台服务 getDefaultValue 孪生。
  queue: {
    pickupStallThresholdMinutes: 3,
    stuckSweepIntervalSeconds: 300,
    stuckSweepUnclaimedAgeMinutes: 60,
    wakeRetryIntervalSeconds: 300,
    wakeRetryCap: 3,
    wakeUnconfirmedWindowMinutes: 30,
    wakeSwapGraceSeconds: 180,
  },
} as const;

export const VALID_KEYS = [
  "daemon.port",
  "daemon.host",
  // OPR.0.4.6.MH1 FR-1——持久化的主机选择指针，形态类似 kubectl current-context。
  // 这是与后台服务 settings-store 孪生实现严格同步的唯一静态键，由一致性测试同时锁定。
  // 值是否属于注册表在 `rig host select` 命令层校验，存储层不理解值；后台服务配置写入
  // 是唯一写路径，CLI 命令只是薄客户端。默认 `local`，未设置即本地主机，构造上保证
  // FR-2 零回归姿态。
  "host.selected",
  // OPR.0.4.6.MH1 FR-4——本机展示名。按架构裁定 1，其归属是 settings 孪生实现，
  // 绝不是 hosts.yaml。只存一个名称，所有界面（dashboard/explorer/ls/whoami）读取它。
  // 写路径为 `rig host rename` 经后台服务配置写入，与 select 一样是薄客户端。
  "host.name",
  // OPR.0.4.6.WF5 FR-2——主机级成熟度旋钮默认值，与后台服务设置孪生实现同步。
  // 允许 `orchestrator` 或 `human_only`；未设置等同于编排器优先。
  "workflow.exception_routing",
  "db.path",
  "transcripts.enabled",
  "transcripts.path",
  // V1 预发布 CLI/daemon 第 1 项——SC-29 例外 #4 的白名单子项：
  // 转录轮转调节项（行数与轮询间隔）。
  "transcripts.lines",
  "transcripts.poll_interval_seconds",
  "workspace.root",
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.specs_root",
  "workspace.projects_root",
  "workspace.catalog_path",
  // OPR.0.5.3.6 D1——拓扑树根，与后台服务 settings-store 孪生实现同步。
  // 默认从 $OPENRIG_HOME/topology 派生；旧 shared-docs/rigs 位置继续通过后台服务的
  // resolveLegacyTopologyRigsRoot 回退可读，并发出建议。
  "topology.root",
  // OPR.0.5.9.5 波次 B——规范上下文库；旧键会被拒绝。
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
  "recovery.auto_drive_provider_prompts",
  "recovery.provider_auth_env_allowlist",
  // V1 阶段 4 SC-29 例外——只增加白名单。
  "agents.advisor_session",
  "agents.operator_session",
  // 操作者显式覆盖（仅 OPENRIG_*，无旧别名）。
  "workspace.operator_seat_name",
  // V1 阶段 5 P5-3 SC-29 例外——只增加白名单。
  "feed.subscriptions.action_required",
  "feed.subscriptions.approvals",
  "feed.subscriptions.shipped",
  "feed.subscriptions.progress",
  "feed.subscriptions.audit_log",
  // plugin-primitive 阶段 3a slice 3.5——Codex 功能标志。
  "runtime.codex.hooks_enabled",
  // Slice 27——Claude 自动压缩策略。SC-29 例外 #10：7 个 ConfigStore 键，
  // 与后台服务 SETTINGS_VALID_KEYS 同步。
  "policies.claude_compaction.enabled",
  "policies.claude_compaction.threshold_percent",
  "policies.claude_compaction.pre_compact_instruction",
  "policies.claude_compaction.compact_instruction",
  "policies.claude_compaction.message_inline",
  "policies.claude_compaction.message_file_path",
  "policies.claude_compaction.post_restore_audit_instruction",
  "policies.idle_gate_qitem.scan_interval_seconds",
  "policies.idle_gate_qitem.active_wake_interval_seconds",
  // B6 创建者裁定——idle-gate 自动注册默认不启用；与后台服务 settings-store 键孪生，
  // 语义见对应实现。
  "policies.idle_gate_qitem.auto_register",
  "policies.idle_gate_qitem.opt_in_sessions",
  "snapshots.periodic.enabled",
  "snapshots.periodic.interval_seconds",
  "snapshots.periodic.retention_keep",
  // OPR.0.4.6.02 S1——内部 tmux 状态栏的启动默认值。唯一静态布尔值，默认关闭；
  // 与后台服务 settings-store 孪生实现同步（一致性测试锁定两者）。切换只影响未来启动（BR-1）。
  "terminal.status_bar",
  // OPR.0.4.6.FS-1 W2——队列保留维护旋钮；CLI 可设置的孪生实现，与后台服务
  // settings-store SETTINGS_VALID_KEYS 同步。
  "retention.enabled",
  "retention.transitions_days",
  "retention.watchdog_days",
  "retention.watchdog_keep_per_job",
  "retention.batch_size",
  // S04——领取回执停滞阈值；与后台服务 settings-store 孪生实现同步。
  "queue.pickup_stall_threshold_minutes",
  // S02——常驻卡住扫描频率与未领取义务时长；同样保持同步。
  "queue.stuck_sweep_interval_seconds",
  "queue.stuck_sweep_unclaimed_age_minutes",
  // S01——唤醒或升级阶梯：重试频率与上限、F1 窗口、F2 替换宽限期。
  "queue.wake_retry_interval_seconds",
  "queue.wake_retry_cap",
  "queue.wake_unconfirmed_window_minutes",
  "queue.wake_swap_grace_seconds",
] as const;

export type ValidKey = typeof VALID_KEYS[number];

export const ENV_MAP: Record<ValidKey, { primary: string; legacy?: string }> = {
  // 只有原有运行时键为升级兼容保留 RIGGED_* 别名；新类型化键只使用 OPENRIG_*。
  "daemon.port": { primary: "OPENRIG_PORT", legacy: "RIGGED_PORT" },
  // OPR.0.4.6.MH1 FR-1/FR-4——新键只使用 OPENRIG_*，没有旧 RIGGED_* 别名。
  "host.selected": { primary: "OPENRIG_HOST_SELECTED" },
  "host.name": { primary: "OPENRIG_HOST_NAME" },
  // OPR.0.4.6.WF5 FR-2——新键只使用 OPENRIG_*。
  "workflow.exception_routing": { primary: "OPENRIG_WORKFLOW_EXCEPTION_ROUTING" },
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
  // UEP 环境变量转正：现有 OPENRIG_FILES_ALLOWLIST / OPENRIG_PROGRESS_SCAN_ROOTS
  // 成为新类型化键的环境覆盖，不引入破坏性变更。
  "files.allowlist": { primary: "OPENRIG_FILES_ALLOWLIST" },
  "progress.scan_roots": { primary: "OPENRIG_PROGRESS_SCAN_ROOTS" },
  "ui.preview.refresh_interval_seconds": { primary: "OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS" },
  "ui.preview.max_pins": { primary: "OPENRIG_UI_PREVIEW_MAX_PINS" },
  "ui.timezone": { primary: "OPENRIG_UI_TIMEZONE" },
  "ui.preview.default_lines": { primary: "OPENRIG_UI_PREVIEW_DEFAULT_LINES" },
  "recovery.auto_drive_provider_prompts": { primary: "OPENRIG_RECOVERY_AUTO_DRIVE_PROVIDER_PROMPTS" },
  "recovery.provider_auth_env_allowlist": { primary: "OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST" },
  "agents.advisor_session": { primary: "OPENRIG_AGENTS_ADVISOR_SESSION" },
  "agents.operator_session": { primary: "OPENRIG_AGENTS_OPERATOR_SESSION" },
  "workspace.operator_seat_name": { primary: "OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME" },
  "feed.subscriptions.action_required": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_ACTION_REQUIRED" },
  "feed.subscriptions.approvals": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_APPROVALS" },
  "feed.subscriptions.shipped": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_SHIPPED" },
  "feed.subscriptions.progress": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_PROGRESS" },
  "feed.subscriptions.audit_log": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_AUDIT_LOG" },
  // 重命名后新增的键：按五键边界原则，只使用 OPENRIG_X 主名称；新增键没有 RIGGED_X 旧别名。
  "runtime.codex.hooks_enabled": { primary: "OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED" },
  // Slice 27——Claude 自动压缩策略。只使用 OPENRIG_X 主名称；均为新增键，无旧别名。
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
  // OPR.0.4.6.02 S1——新增键只使用 OPENRIG_* 主名称，无 RIGGED_* 旧别名。
  "terminal.status_bar": { primary: "OPENRIG_TERMINAL_STATUS_BAR" },
  // OPR.0.4.6.FS-1 W2——保留旋钮均为新增键，只使用 OPENRIG_* 主名称。
  "retention.enabled": { primary: "OPENRIG_RETENTION_ENABLED" },
  "retention.transitions_days": { primary: "OPENRIG_RETENTION_TRANSITIONS_DAYS" },
  "retention.watchdog_days": { primary: "OPENRIG_RETENTION_WATCHDOG_DAYS" },
  "retention.watchdog_keep_per_job": { primary: "OPENRIG_RETENTION_WATCHDOG_KEEP_PER_JOB" },
  "retention.batch_size": { primary: "OPENRIG_RETENTION_BATCH_SIZE" },
  "queue.pickup_stall_threshold_minutes": { primary: "OPENRIG_QUEUE_PICKUP_STALL_THRESHOLD_MINUTES" },
  "queue.stuck_sweep_interval_seconds": { primary: "OPENRIG_QUEUE_STUCK_SWEEP_INTERVAL_SECONDS" },
  "queue.stuck_sweep_unclaimed_age_minutes": { primary: "OPENRIG_QUEUE_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES" },
  "queue.wake_retry_interval_seconds": { primary: "OPENRIG_QUEUE_WAKE_RETRY_INTERVAL_SECONDS" },
  "queue.wake_retry_cap": { primary: "OPENRIG_QUEUE_WAKE_RETRY_CAP" },
  "queue.wake_unconfirmed_window_minutes": { primary: "OPENRIG_QUEUE_WAKE_UNCONFIRMED_WINDOW_MINUTES" },
  "queue.wake_swap_grace_seconds": { primary: "OPENRIG_QUEUE_WAKE_SWAP_GRACE_SECONDS" },
};

// 把点分配置键映射到 camelCase RiggedConfig 路径。工作区子目录键在磁盘上以
// `workspace.slices_root`（snake）存储，在 RiggedConfig 中按 TypeScript 约定公开为
// `workspace.slicesRoot`（camel）。
const KEY_TO_PATH: Record<ValidKey, string[]> = {
  "daemon.port": ["daemon", "port"],
  "host.selected": ["host", "selected"],
  "host.name": ["host", "name"],
  "workflow.exception_routing": ["workflow", "exceptionRouting"],
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
  "recovery.auto_drive_provider_prompts": ["recovery", "autoDriveProviderPrompts"],
  "recovery.provider_auth_env_allowlist": ["recovery", "providerAuthEnvAllowlist"],
  "agents.advisor_session": ["agents", "advisorSession"],
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

function isValidKey(key: string): key is ValidKey {
  return (VALID_KEYS as readonly string[]).includes(key);
}

const REMOVED_CONTEXT_KEY = "context.packs_root";
const REMOVED_CONTEXT_ENV = "OPENRIG_CONTEXT_PACKS_ROOT";

export function removedContextSettingMessage(key: string): string | null {
  return key === REMOVED_CONTEXT_KEY
    ? '配置键 "context.packs_root" 已移除；请使用 "context.root"。'
    : null;
}

function assertNoRemovedContextSetting(fileConfig: Record<string, unknown>): void {
  if (process.env[REMOVED_CONTEXT_ENV]?.trim()) {
    throw new Error(
      "OPENRIG_CONTEXT_PACKS_ROOT 已移除；请使用 OPENRIG_CONTEXT_ROOT（配置键 context.root）。",
    );
  }
  if (getNestedValue(fileConfig, ["context", "packsRoot"]) !== undefined) {
    throw new Error(
      '配置文件包含已移除的键 "context.packs_root"（context.packsRoot）；请替换为 "context.root"（context.root）。',
    );
  }
}

// ── OPR.0.4.4.15（G15-P1）——后台服务 settings-store 唯一注册动态键类的孪生实现：
// `feed.subscriptions.<hostId>.enabled`（布尔值；v1 逐主机键集合封闭为 {enabled}；
// 无环境映射）。与 packages/daemon/src/domain/user-settings/settings-store.ts 严格同步，
// 一致性测试锁定两个孪生实现。保留段同时覆盖键级 snake_case 和文件级 camelCase 开关名，
// 使主机 ID 不会在任一层遮蔽扁平开关。其他未知键继续明确拒绝。
const FEED_HOST_KEY_RE = /^feed\.subscriptions\.([A-Za-z0-9_-]+)\.enabled$/;
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
  throw new Error(`${key} 的值无效：期望 "true" 或 "false"，收到 "${raw}"`);
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

// 各子目录默认值从 workspace.root 派生；Steering 是文件路径。切片发现默认遵循
// 任务感知的 workspace/missions 契约；操作者显式设置 workspace.slices_root 时，索引器
// 仍向后兼容扁平切片根。Files 和 Progress 默认覆盖整个工作区，使全新
// `rig config init-workspace` 安装无需额外环境接线即可浏览。
export function deriveWorkspaceDefault(key: ValidKey, workspaceRoot: string): string {
  switch (key) {
    case "workspace.slices_root":      return join(workspaceRoot, "missions");
    case "workspace.steering_path":    return join(workspaceRoot, "STEERING.md");
    case "workspace.specs_root":       return join(workspaceRoot, "specs");
    case "workspace.projects_root":    return join(workspaceRoot, "projects");
    case "workspace.catalog_path":     return join(workspaceRoot, "workspace.yaml");
    case "files.allowlist":            return `workspace:${workspaceRoot}`;
    case "progress.scan_roots":        return `workspace:${workspaceRoot}`;
// 与后台服务设置存储使用相同的未设置默认值。
    case "workspace.operator_seat_name": return ""; // unset: discover a registered human, never invent a kernel seat
    default: return "";
  }
}

function deriveLegacyWorkspaceDefault(key: ValidKey, workspaceRoot: string): string | null {
  switch (key) {
    case "workspace.slices_root": return join(workspaceRoot, "slices");
    case "workspace.steering_path": return join(workspaceRoot, "steering", "STEERING.md");
    default: return null;
  }
}

const WORKSPACE_DERIVED_KEYS: ReadonlySet<ValidKey> = new Set([
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.specs_root",
  "workspace.projects_root",
  "workspace.catalog_path",
  "files.allowlist",
  "progress.scan_roots",
  "workspace.operator_seat_name",
]);

function getDefaultValue(key: ValidKey, workspaceRoot: string): string | number | boolean {
  if (WORKSPACE_DERIVED_KEYS.has(key)) {
    return deriveWorkspaceDefault(key, workspaceRoot);
  }
  return getNestedValue(DEFAULTS as unknown as Record<string, unknown>, KEY_TO_PATH[key]) as string | number | boolean;
}

function coerceValue(key: ValidKey, raw: string, workspaceRoot: string): string | number | boolean {
  const defaultVal = getDefaultValue(key, workspaceRoot);
  if (typeof defaultVal === "number") {
    const n = parseInt(raw, 10);
    if (isNaN(n)) throw new Error(`${key} 的值无效：期望数字，收到 "${raw}"`);
    return n;
  }
  if (typeof defaultVal === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new Error(`${key} 的值无效：期望 true/false，收到 "${raw}"`);
  }
  return raw;
}

// Slice 27——`set()` 中在 coerceValue 之后应用严格的逐键约束校验器。通用转换使用
// parseInt，它会接受部分解析（如 `80abc` → 80）并截断小数（`80.5` → 80）；对有明确
// 范围/整数契约的键并不安全。按已归档的
// feedback_static_gates_mirror_runtime_validators，运行时校验器是事实来源，必须拒绝
// 契约禁止的输入。
function positiveIntegerConstraint(key: string) {
  return (raw: string, coerced: string | number | boolean): void => {
    if (!/^\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced <= 0) {
      throw new Error(`${key} 的值无效：必须是正整数，收到 "${raw}"`);
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
      throw new Error(`${key} 的值无效：必须是 [1, 100] 范围内的整数，收到 "${raw}"`);
    }
  };
}

const KEY_CONSTRAINTS: Partial<Record<ValidKey, (raw: string, coerced: string | number | boolean) => void>> = {
  "ui.timezone": (_raw, value) => {
    try {
      if (typeof value !== "string" || !value || /^[+-]/.test(value)) throw new Error();
      new Intl.DateTimeFormat("en-US", { timeZone: value });
    } catch { throw new Error("无效的 ui.timezone：请使用 IANA 时区，例如 America/Los_Angeles 或 Europe/London"); }
  },
  "health.context_pressure.warning_percent": percentageConstraint("health.context_pressure.warning_percent"),
  "health.context_pressure.critical_percent": percentageConstraint("health.context_pressure.critical_percent"),
  "policies.idle_gate_qitem.scan_interval_seconds": positiveIntegerConstraint("policies.idle_gate_qitem.scan_interval_seconds"),
  "policies.idle_gate_qitem.active_wake_interval_seconds": positiveIntegerConstraint("policies.idle_gate_qitem.active_wake_interval_seconds"),
  "policies.idle_gate_qitem.auto_register": (raw) => {
    const v = (raw ?? "").trim();
    if (v !== "off" && v !== "all") {
      throw new Error(`policies.idle_gate_qitem.auto_register 的值无效：必须是 "off" 或 "all"，收到 "${raw}"`);
    }
  },
  // 策略阈值：范围 [1, 100] 的整数。契约来自 slice 27 README 的
  // “What the operator gets”；操作者可降到例如 50，以更早压缩。0 会在每次轮询 tick
  // 触发 /compact，在没有默认关闭兜底时会造成灾难。
  "policies.claude_compaction.threshold_percent": (raw, coerced) => {
    const trimmed = (raw ?? "").trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `policies.claude_compaction.threshold_percent 的值无效：期望 [1, 100] 范围内的整数，收到 "${raw}"`,
      );
    }
    if (typeof coerced !== "number" || !Number.isInteger(coerced)) {
      throw new Error(
        `policies.claude_compaction.threshold_percent 的值无效：期望 [1, 100] 范围内的整数，收到 "${raw}"`,
      );
    }
    if (coerced < 1 || coerced > 100) {
      throw new Error(
        `policies.claude_compaction.threshold_percent 的值无效：必须在 [1, 100] 范围内，收到 ${coerced}`,
      );
    }
  },
  "snapshots.periodic.interval_seconds": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim())) {
      throw new Error(
        `snapshots.periodic.interval_seconds 的值无效：期望 >= 60 的整数，收到 "${raw}"`,
      );
    }
    if (typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 60) {
      throw new Error(
        `snapshots.periodic.interval_seconds 的值无效：必须 >= 60，收到 ${raw}`,
      );
    }
  },
  "snapshots.periodic.retention_keep": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim())) {
      throw new Error(
        `snapshots.periodic.retention_keep 的值无效：期望 >= 1 的整数，收到 "${raw}"`,
      );
    }
    if (typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(
        `snapshots.periodic.retention_keep 的值无效：必须 >= 1，收到 ${raw}`,
      );
    }
  },
  // OPR.0.4.6.FS-1 W2——保留策略数值边界。与后台服务 settings-store 的
  // KEY_CONSTRAINTS 孪生实现同步，消息和边界一致。retention.enabled 是布尔值，
  // coerceValue 已强制 true/false，因此不需要约束条目。
  "retention.transitions_days": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(`retention.transitions_days 的值无效：必须是 >= 1 的整数，收到 "${raw}"`);
    }
  },
  "retention.watchdog_days": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(`retention.watchdog_days 的值无效：必须是 >= 1 的整数，收到 "${raw}"`);
    }
  },
  "retention.watchdog_keep_per_job": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 0) {
      throw new Error(`retention.watchdog_keep_per_job 的值无效：必须是 >= 0 的整数，收到 "${raw}"`);
    }
  },
  "retention.batch_size": (raw, coerced) => {
    if (!/^-?\d+$/.test((raw ?? "").trim()) || typeof coerced !== "number" || !Number.isInteger(coerced) || coerced < 1) {
      throw new Error(`retention.batch_size 的值无效：必须是 >= 1 的整数，收到 "${raw}"`);
    }
  },
  "queue.pickup_stall_threshold_minutes": positiveIntegerConstraint("queue.pickup_stall_threshold_minutes"),
  "queue.stuck_sweep_interval_seconds": positiveIntegerConstraint("queue.stuck_sweep_interval_seconds"),
  "queue.stuck_sweep_unclaimed_age_minutes": positiveIntegerConstraint("queue.stuck_sweep_unclaimed_age_minutes"),
  // S01——唤醒或升级阶梯旋钮，使用相同的正整数契约。
  "queue.wake_retry_interval_seconds": positiveIntegerConstraint("queue.wake_retry_interval_seconds"),
  "queue.wake_retry_cap": positiveIntegerConstraint("queue.wake_retry_cap"),
  "queue.wake_unconfirmed_window_minutes": positiveIntegerConstraint("queue.wake_unconfirmed_window_minutes"),
  "queue.wake_swap_grace_seconds": positiveIntegerConstraint("queue.wake_swap_grace_seconds"),
};

function validateKeyConstraints(key: ValidKey, raw: string, coerced: string | number | boolean): void {
  const check = KEY_CONSTRAINTS[key];
  if (check) check(raw, coerced);
}

// Slice 27 BLOCKING-FIX-2——共享的转换与校验，供所有把操作者输入转换为类型化配置值的
// 界面使用：set()（CLI 与后台服务写路径）、resolveOne 的环境来源分支，以及经
// validateTypedValue 间接处理的 resolveOne 文件来源分支。按已归档的
// feedback_audit_every_layer_function_and_module_constants，校验必须在每个接收不可信输入
// 的层级执行，而不能只在写入时执行。
function coerceAndValidate(key: ValidKey, raw: string, workspaceRoot: string): string | number | boolean {
  const coerced = coerceValue(key, raw, workspaceRoot);
  validateKeyConstraints(key, raw, coerced);
  return coerced;
}

// 文件来源值到达时已经类型化（由 JSON 解析）。约束闭包还需要 (raw, coerced) 驱动
// 正则检查，因此传入字符串化的值，使直接写入 config.json 的字符串值（如 `80abc`）
// 仍会触发正则拒绝。
function validateTypedFileValue(key: ValidKey, value: string | number | boolean): void {
  const check = KEY_CONSTRAINTS[key];
  if (!check) return;
  const raw = typeof value === "string" ? value : String(value);
  check(raw, value);
}

export type SettingSource = "env" | "file" | "default";

export interface ResolvedSetting {
  value: string | number | boolean;
  source: SettingSource;
  defaultValue: string | number | boolean;
}

export class ConfigStore {
  readonly configPath: string;

  constructor(configPath?: string) {
    // GHOST-STAGE（d）：配置默认写入目标必须是后台服务读取的规范路径
    //（getOpenRigHome/config.json），而不是基于存在性、在规范路径缺失时偏好旧
    // ~/.rigged/config.json 的 getCompatibleOpenRigPath。该分歧曾让 `rig config set` 在写入
    // 后台服务永不读取的陈旧操作者 sidecar 时仍报告成功，属于接受后丢弃类。读取也与规范
    // 路径对齐；后台服务已经忽略 ~/.rigged。
    this.configPath = configPath ?? getDefaultOpenRigPath("config.json");
  }

  // GHOST-STAGE（d）：写后读回校验并明确失败。写入后重新读取实际写入文件
  //（this.configPath），确认值确实持久化。对默认存储，此路径就是后台服务读取的规范配置
  // getOpenRigHome/config.json；构造器不再解析旧 ~/.rigged sidecar。因此这里读到持久化值
  // 就能证明后台服务可见。读回不匹配表示写入静默失败；应明确拒绝，不能报告虚假成功
  //（接受后丢弃 / config-set-success-without-persist 类）。
  private verifyPersisted(keyPath: string[], expected: unknown): void {
    let reread: Record<string, unknown>;
    try {
      reread = JSON.parse(readFileSync(this.configPath, "utf-8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(
        `配置写入未持久化：无法在 ${this.configPath} 读回（${(e as Error).message}）。` +
          `拒绝报告成功——更改未生效。`,
      );
    }
    const got = getNestedValue(reread, keyPath);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error(
        `配置写入未持久化到 ${this.configPath}：` +
          `[${keyPath.join(".")}] 仍显示 ${JSON.stringify(got)}（期望 ${JSON.stringify(expected)}）。拒绝报告虚假成功。`,
      );
    }
  }

  resolve(): RiggedConfig {
    const fileConfig = this.readConfigFile();

    // 必须先解析工作区根，供各子目录派生默认值使用。
    const workspaceRoot = this.resolveOne("workspace.root", fileConfig, DEFAULT_WORKSPACE_ROOT).value as string;

    const v = (key: ValidKey) =>
      this.resolveOne(key, fileConfig, workspaceRoot).value;

    return {
      daemon: {
        port: v("daemon.port") as number,
        host: v("daemon.host") as string,
      },
      host: {
        selected: v("host.selected") as string,
        name: v("host.name") as string,
      },
      db: {
        path: v("db.path") as string,
      },
      transcripts: {
        enabled: v("transcripts.enabled") as boolean,
        path: v("transcripts.path") as string,
        lines: v("transcripts.lines") as number,
        pollIntervalSeconds: v("transcripts.poll_interval_seconds") as number,
      },
      workspace: {
        root: workspaceRoot,
        slicesRoot: v("workspace.slices_root") as string,
        steeringPath: v("workspace.steering_path") as string,
        specsRoot: v("workspace.specs_root") as string,
        projectsRoot: v("workspace.projects_root") as string,
        catalogPath: v("workspace.catalog_path") as string,
        operatorSeatName: v("workspace.operator_seat_name") as string,
      },
      topology: {
        root: v("topology.root") as string,
      },
      context: {
        root: v("context.root") as string,
        systemWorld: v("context.system_world") as string,
      },
      skills: {
        root: v("skills.root") as string,
      },
      onboarding: {
        defaultPack: {
          enabled: v("onboarding.default_pack.enabled") as boolean,
        },
      },
      health: {
        contextPressure: {
          warningPercent: v("health.context_pressure.warning_percent") as number,
          criticalPercent: v("health.context_pressure.critical_percent") as number,
        },
      },
      files: {
        allowlist: v("files.allowlist") as string,
      },
      progress: {
        scanRoots: v("progress.scan_roots") as string,
      },
      ui: {
        timezone: v("ui.timezone") as string,
        preview: {
          refreshIntervalSeconds: v("ui.preview.refresh_interval_seconds") as number,
          maxPins: v("ui.preview.max_pins") as number,
          defaultLines: v("ui.preview.default_lines") as number,
        },
      },
      recovery: {
        autoDriveProviderPrompts: v("recovery.auto_drive_provider_prompts") as boolean,
        providerAuthEnvAllowlist: v("recovery.provider_auth_env_allowlist") as string,
      },
      agents: {
        advisorSession: v("agents.advisor_session") as string,
        operatorSession: v("agents.operator_session") as string,
      },
      feed: {
        subscriptions: {
          actionRequired: v("feed.subscriptions.action_required") as boolean,
          approvals: v("feed.subscriptions.approvals") as boolean,
          shipped: v("feed.subscriptions.shipped") as boolean,
          progress: v("feed.subscriptions.progress") as boolean,
          auditLog: v("feed.subscriptions.audit_log") as boolean,
        },
      },
      runtime: {
        codex: {
          hooksEnabled: v("runtime.codex.hooks_enabled") as boolean,
        },
      },
      policies: {
        claudeCompaction: {
          enabled: v("policies.claude_compaction.enabled") as boolean,
          thresholdPercent: v("policies.claude_compaction.threshold_percent") as number,
          preCompactInstruction: v("policies.claude_compaction.pre_compact_instruction") as string,
          compactInstruction: v("policies.claude_compaction.compact_instruction") as string,
          messageInline: v("policies.claude_compaction.message_inline") as string,
          messageFilePath: v("policies.claude_compaction.message_file_path") as string,
          postRestoreAuditInstruction: v("policies.claude_compaction.post_restore_audit_instruction") as string,
        },
        idleGateQitem: {
          scanIntervalSeconds: v("policies.idle_gate_qitem.scan_interval_seconds") as number,
          activeWakeIntervalSeconds: v("policies.idle_gate_qitem.active_wake_interval_seconds") as number,
          autoRegister: v("policies.idle_gate_qitem.auto_register") as string,
          optInSessions: v("policies.idle_gate_qitem.opt_in_sessions") as string,
        },
      },
      snapshots: {
        periodic: {
          enabled: v("snapshots.periodic.enabled") as boolean,
          intervalSeconds: v("snapshots.periodic.interval_seconds") as number,
          retentionKeep: v("snapshots.periodic.retention_keep") as number,
        },
      },
      terminal: {
        statusBar: v("terminal.status_bar") as boolean,
      },
      retention: {
        enabled: v("retention.enabled") as boolean,
        transitionsDays: v("retention.transitions_days") as number,
        watchdogDays: v("retention.watchdog_days") as number,
        watchdogKeepPerJob: v("retention.watchdog_keep_per_job") as number,
        batchSize: v("retention.batch_size") as number,
      },
      queue: {
        pickupStallThresholdMinutes: v("queue.pickup_stall_threshold_minutes") as number,
        stuckSweepIntervalSeconds: v("queue.stuck_sweep_interval_seconds") as number,
        stuckSweepUnclaimedAgeMinutes: v("queue.stuck_sweep_unclaimed_age_minutes") as number,
        wakeRetryIntervalSeconds: v("queue.wake_retry_interval_seconds") as number,
        wakeRetryCap: v("queue.wake_retry_cap") as number,
        wakeUnconfirmedWindowMinutes: v("queue.wake_unconfirmed_window_minutes") as number,
        wakeSwapGraceSeconds: v("queue.wake_swap_grace_seconds") as number,
      },
    };
  }

  /** 解析单个键及其来源。供后台服务 HTTP 路由与 UI 设置面板如实展示来源
   *（env / file / default）。 */
  resolveWithSource(key: string): ResolvedSetting {
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) throw new Error(removedMessage);
    // OPR.0.4.4.15：动态键类从文件或默认值解析；v1 不支持环境来源。
    const feedHost = parseFeedHostSubscriptionKey(key);
    if (feedHost) {
      const fcDyn = this.readConfigFile();
      const fileVal = getNestedValue(fcDyn, ["feed", "subscriptions", feedHost.hostId, "enabled"]);
      if (typeof fileVal === "boolean") return { value: fileVal, source: "file", defaultValue: false };
      return { value: false, source: "default", defaultValue: false };
    }
    if (!isValidKey(key)) {
      throw new Error(`未知配置键 "${key}"。有效键：${VALID_KEYS.join(", ")}`);
    }
    const fileConfig = this.readConfigFile();
    const workspaceRoot = this.resolveOne("workspace.root", fileConfig, DEFAULT_WORKSPACE_ROOT).value as string;
    return this.resolveOne(key, fileConfig, workspaceRoot);
  }

  /** 解析所有有效键及其来源，供 UI 便捷使用。 */
  resolveAllWithSource(): Record<ValidKey, ResolvedSetting> {
    const fileConfig = this.readConfigFile();
    const workspaceRoot = this.resolveOne("workspace.root", fileConfig, DEFAULT_WORKSPACE_ROOT).value as string;
    const out = {} as Record<ValidKey, ResolvedSetting>;
    for (const key of VALID_KEYS) {
      out[key] = this.resolveOne(key, fileConfig, workspaceRoot);
    }
    return out;
  }

  private resolveOne(key: ValidKey, fileConfig: Record<string, unknown>, workspaceRoot: string): ResolvedSetting {
    if (key === "health.context_pressure.warning_percent" || key === "health.context_pressure.critical_percent") {
      return this.resolveContextPressurePair(fileConfig, workspaceRoot)[key];
    }
    return this.resolveOneUnpaired(key, fileConfig, workspaceRoot);
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
      `[openrig-config] 上下文压力策略被拒绝：warning（${warning.value}）必须小于 critical（${critical.value}）；回退到 95/99 默认值\n`,
    );
    return {
      [warningKey]: { value: 95, source: "default", defaultValue: 95 },
      [criticalKey]: { value: 99, source: "default", defaultValue: 99 },
    };
  }

  private resolveOneUnpaired(key: ValidKey, fileConfig: Record<string, unknown>, workspaceRoot: string): ResolvedSetting {
    const defaultValue = getDefaultValue(key, workspaceRoot);
    // 1. 环境变量——先校验。无效时丢弃覆盖并落入文件/默认值，这比崩溃或接受坏值
    //    更安全；同时在 stderr 警告，让操作者看见错误配置。
    const envVal = readOpenRigEnv(ENV_MAP[key].primary, ENV_MAP[key].legacy);
    if (envVal !== undefined && envVal !== "") {
      try {
        return { value: coerceAndValidate(key, envVal, workspaceRoot), source: "env", defaultValue };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[openrig-config] ${key} 的环境变量覆盖被拒绝：${reason}；回退到文件/默认值\n`,
        );
      }
    }
    // 2. 配置文件。
    const fileVal = getNestedValue(fileConfig, KEY_TO_PATH[key]);
    if (fileVal !== undefined && fileVal !== null && fileVal !== "") {
      const legacyDefault = deriveLegacyWorkspaceDefault(key, workspaceRoot);
      if (legacyDefault !== null && fileVal === legacyDefault) {
        return { value: defaultValue, source: "default", defaultValue };
      }
      // 同样校验文件来源值。手工编辑 config.json 写入坏阈值（例如 thresholdPercent: 0
      // 或 `80abc`）时回退到默认值，而不是污染触发契约。
      try {
        validateTypedFileValue(key, fileVal as string | number | boolean);
        return { value: fileVal as string | number | boolean, source: "file", defaultValue };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[openrig-config] ${key} 的文件值被拒绝：${reason}；回退到默认值\n`,
        );
      }
    }
    // 3. 默认值。
    return { value: defaultValue, source: "default", defaultValue };
  }

  get(key: string): string | number | boolean {
    return this.resolveWithSource(key).value;
  }

  set(key: string, value: string): void {
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) throw new Error(removedMessage);
    // OPR.0.4.4.15：接受已注册动态键类；其他未知键保持下方逐字节一致的明确拒绝行为。
    const feedHost = parseFeedHostSubscriptionKey(key);
    if (feedHost) {
      const coercedDyn = coerceFeedHostSubscriptionValue(key, value);
      const fcDyn = this.readConfigFile();
      setNestedValue(fcDyn, ["feed", "subscriptions", feedHost.hostId, "enabled"], coercedDyn);
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(fcDyn, null, 2) + "\n", "utf-8");
      this.verifyPersisted(["feed", "subscriptions", feedHost.hostId, "enabled"], coercedDyn);
      return;
    }
    if (!isValidKey(key)) {
      throw new Error(`未知配置键 "${key}"。有效键：${VALID_KEYS.join(", ")}`);
    }
    const fileConfig = this.readConfigFile();
    const workspaceRoot = (getNestedValue(fileConfig, KEY_TO_PATH["workspace.root"]) as string | undefined)
      || readOpenRigEnv(ENV_MAP["workspace.root"].primary, ENV_MAP["workspace.root"].legacy)
      || DEFAULT_WORKSPACE_ROOT;
    const coerced = coerceAndValidate(key, value, workspaceRoot);
    setNestedValue(fileConfig, KEY_TO_PATH[key], coerced);
    if (key === "health.context_pressure.warning_percent" || key === "health.context_pressure.critical_percent") {
      const warning = getNestedValue(fileConfig, KEY_TO_PATH["health.context_pressure.warning_percent"])
        ?? getDefaultValue("health.context_pressure.warning_percent", workspaceRoot);
      const critical = getNestedValue(fileConfig, KEY_TO_PATH["health.context_pressure.critical_percent"])
        ?? getDefaultValue("health.context_pressure.critical_percent", workspaceRoot);
      if ((warning as number) >= (critical as number)) {
        throw new Error(`无效的上下文压力策略：warning（${warning}）必须小于 critical（${critical}）`);
      }
    }
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
    this.verifyPersisted(KEY_TO_PATH[key], coerced);
  }

  /**
   * 清除覆盖值。不传键时删除整个配置文件，恢复全部默认值；传入键时只从配置文件
   * 删除该键。
   */
  reset(key?: string): void {
    if (key === undefined) {
      try { unlinkSync(this.configPath); } catch { /* 文件不存在也视为成功。 */ }
      return;
    }
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) throw new Error(removedMessage);
    // OPR.0.4.4.15：重置动态键类时移除整个主机节点。
    const feedHost = parseFeedHostSubscriptionKey(key);
    if (feedHost) {
      if (!existsSync(this.configPath)) return;
      const fcDyn = this.readConfigFile();
      const subsParent = getNestedValue(fcDyn, ["feed", "subscriptions"]) as Record<string, unknown> | undefined;
      if (subsParent && feedHost.hostId in subsParent) delete subsParent[feedHost.hostId];
      writeFileSync(this.configPath, JSON.stringify(fcDyn, null, 2) + "\n", "utf-8");
      return;
    }
    if (!isValidKey(key)) {
      throw new Error(`未知配置键 "${key}"。有效键：${VALID_KEYS.join(", ")}`);
    }
    if (!existsSync(this.configPath)) return;
    const fileConfig = this.readConfigFile();
    const parts = KEY_TO_PATH[key];
    const parentParts = parts.slice(0, -1);
    const leaf = parts[parts.length - 1]!;
    const parent = getNestedValue(fileConfig, parentParts) as Record<string, unknown> | undefined;
    if (parent && leaf in parent) {
      delete parent[leaf];
      if (key === "health.context_pressure.warning_percent" || key === "health.context_pressure.critical_percent") {
        const workspaceRoot = (getNestedValue(fileConfig, KEY_TO_PATH["workspace.root"]) as string | undefined)
          || readOpenRigEnv(ENV_MAP["workspace.root"].primary, ENV_MAP["workspace.root"].legacy)
          || DEFAULT_WORKSPACE_ROOT;
        const warning = getNestedValue(fileConfig, KEY_TO_PATH["health.context_pressure.warning_percent"])
          ?? getDefaultValue("health.context_pressure.warning_percent", workspaceRoot);
        const critical = getNestedValue(fileConfig, KEY_TO_PATH["health.context_pressure.critical_percent"])
          ?? getDefaultValue("health.context_pressure.critical_percent", workspaceRoot);
        if ((warning as number) >= (critical as number)) {
          throw new Error(`无效的上下文压力策略：warning（${warning}）必须小于 critical（${critical}）`);
        }
      }
    }
    writeFileSync(this.configPath, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
  }

  private readConfigFile(): Record<string, unknown> {
    let parsed: Record<string, unknown> = {};
    if (existsSync(this.configPath)) {
      const raw = readFileSync(this.configPath, "utf-8");
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(
          `位于 ${this.configPath} 的配置文件格式错误。请修复 JSON 或用以下命令重置：zrig config reset`
        );
      }
    }
    assertNoRemovedContextSetting(parsed);
    return parsed;
  }
}

// --- 用户设置 v0：具名对解析器 ---
//
// `files.allowlist` 和 `progress.scan_roots` 以 UEP 通过环境变量引入的相同逗号分隔
// `name:/abs/path` 字符串存储。此辅助函数把原始字符串解析为结构化对。按 UEP 约定，
// 无效条目（没有冒号、名称或路径为空）会静默跳过；名称重复时以后者为准。

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
