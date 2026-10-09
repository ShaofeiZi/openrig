// User Settings v0——后台服务侧 SettingsStore 测试。
//
// 固定后台服务 SettingsStore 与 CLI ConfigStore 保持同步：相同 VALID_KEYS、相同 env-map、相同
// env > file > default 解析和相同文件格式。二者漂移会导致后台服务 UI 路由显示与 CLI 不同的值。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SettingsStore,
  SETTINGS_VALID_KEYS,
  DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_CONTENT,
  defaultClaudeCompactionExtraInstructionFilePath,
  ensureDefaultClaudeCompactionFiles,
  parseNamedPairs,
} from "../src/domain/user-settings/settings-store.js";

const DEFAULT_PRE_COMPACT_INSTRUCTION_FRAGMENT = "阅读 claude-compaction-restore 技能";
const DEFAULT_RESTORE_INSTRUCTION_FRAGMENT = "阅读 claude-compaction-restore 技能";
const DEFAULT_AUDIT_INSTRUCTION_FRAGMENT = "必需阅读深度审计";
const DEFAULT_EXTRA_INSTRUCTION_FILE_SUFFIX = "compaction/post-compact-extra.md";

function clearEnv(): () => void {
  const keys = [
    "OPENRIG_PORT", "OPENRIG_HOST", "OPENRIG_DB",
    "OPENRIG_TRANSCRIPTS_ENABLED", "OPENRIG_TRANSCRIPTS_PATH",
    "OPENRIG_TRANSCRIPTS_LINES", "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS",
    "OPENRIG_WORKSPACE_ROOT", "OPENRIG_WORKSPACE_SLICES_ROOT",
    "OPENRIG_WORKSPACE_STEERING_PATH", "OPENRIG_WORKSPACE_FIELD_NOTES_ROOT",
    "OPENRIG_WORKSPACE_SPECS_ROOT", "OPENRIG_DOGFOOD_EVIDENCE_ROOT",
    "OPENRIG_WORKSPACE_PROJECTS_ROOT", "OPENRIG_WORKSPACE_CATALOG_PATH",
    "OPENRIG_CONTEXT_ROOT", "OPENRIG_CONTEXT_SYSTEM_WORLD", "OPENRIG_CONTEXT_PACKS_ROOT",
    "OPENRIG_HEALTH_CONTEXT_PRESSURE_WARNING_PERCENT",
    "OPENRIG_HEALTH_CONTEXT_PRESSURE_CRITICAL_PERCENT",
    "OPENRIG_SKILLS_ROOT",
    "OPENRIG_FILES_ALLOWLIST", "OPENRIG_PROGRESS_SCAN_ROOTS",
    "OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS",
    "OPENRIG_UI_PREVIEW_MAX_PINS", "OPENRIG_UI_PREVIEW_DEFAULT_LINES",
    "OPENRIG_RECOVERY_AUTO_DRIVE_PROVIDER_PROMPTS",
    "OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST",
    "OPENRIG_AGENTS_ADVISOR_SESSION", "OPENRIG_AGENTS_OPERATOR_SESSION",
    "OPENRIG_FEED_SUBSCRIPTIONS_ACTION_REQUIRED", "OPENRIG_FEED_SUBSCRIPTIONS_APPROVALS",
    "OPENRIG_FEED_SUBSCRIPTIONS_SHIPPED", "OPENRIG_FEED_SUBSCRIPTIONS_PROGRESS",
    "OPENRIG_FEED_SUBSCRIPTIONS_AUDIT_LOG",
    "OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED",
    // Slice 27——Claude 自动压缩 policy env-map。
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_ENABLED",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_INLINE",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_FILE_PATH",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION",
    "OPENRIG_POLICIES_IDLE_GATE_QITEM_SCAN_INTERVAL_SECONDS",
    "OPENRIG_POLICIES_IDLE_GATE_QITEM_ACTIVE_WAKE_INTERVAL_SECONDS",
    "RIGGED_PORT", "RIGGED_HOST", "RIGGED_DB",
    "RIGGED_TRANSCRIPTS_ENABLED", "RIGGED_TRANSCRIPTS_PATH",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k]!;
      else delete process.env[k];
    }
  };
}

describe("SettingsStore（User Settings v0）", () => {
  let tmpDir: string;
  let configPath: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "settings-store-"));
    configPath = join(tmpDir, "config.json");
    restoreEnv = clearEnv();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("SETTINGS_VALID_KEYS 与文档化的 settings key 集合一致", () => {
    expect([...SETTINGS_VALID_KEYS]).toEqual([
      "daemon.port", "daemon.host",
      // OPR.0.4.6.MH1 FR-1/FR-4——host-selection pointer + own-host name。
      "host.selected",
      "host.name",
      // OPR.0.4.6.WF5 FR-2——host 层 maturity-dial 默认值。
      "workflow.exception_routing",
      "db.path",
      "transcripts.enabled", "transcripts.path",
      // V1 预发布 CLI/daemon 第 1 项——capture-pane rotation 可调参数。
      "transcripts.lines", "transcripts.poll_interval_seconds",
      "workspace.root", "workspace.slices_root", "workspace.steering_path",
      "workspace.specs_root", "workspace.projects_root",
      "workspace.catalog_path",
      // OPR.0.5.3.6 D1——topology tree root（instance 位于顶层）。
      "topology.root",
      "context.root",
      "context.system_world",
      "skills.root",
      "onboarding.default_pack.enabled",
      "health.context_pressure.warning_percent",
      "health.context_pressure.critical_percent",
      "files.allowlist", "progress.scan_roots",
      "ui.preview.refresh_interval_seconds", "ui.preview.max_pins", "ui.preview.default_lines", "ui.timezone",
      // OPR.0.4.0.1——全局 live-terminal 上限。
      "ui.terminal.max_live_terminals",
      "recovery.auto_drive_provider_prompts",
      "recovery.provider_auth_env_allowlist",
      // V1 attempt-3 Phase 4——Advisor/Operator 占位符。
      "agents.advisor_session", "agents.operator_session",
      // V0.3.1 slice 05 kernel-rig-as-default——mission-control 读取层和两个 UI 位置读取的 operator
      // 席位名；默认为 `operator-${USER}@kernel`。
      "workspace.operator_seat_name",
      // V1 attempt-3 Phase 5 P5-3——For You feed 订阅开关。
      "feed.subscriptions.action_required",
      "feed.subscriptions.approvals",
      "feed.subscriptions.shipped",
      "feed.subscriptions.progress",
      "feed.subscriptions.audit_log",
      // plugin-primitive Phase 3a slice 3.5——Codex feature flag。
      "runtime.codex.hooks_enabled",
      // Slice 27——Claude 自动压缩 policy。SC-29 例外 #10。
      "policies.claude_compaction.enabled",
      "policies.claude_compaction.threshold_percent",
      "policies.claude_compaction.pre_compact_instruction",
      "policies.claude_compaction.compact_instruction",
      "policies.claude_compaction.message_inline",
      "policies.claude_compaction.message_file_path",
      "policies.claude_compaction.post_restore_audit_instruction",
      // OPR.0.5.1 51-06 W2c——可调后台服务自动注册 cadence。
      "policies.idle_gate_qitem.scan_interval_seconds",
      "policies.idle_gate_qitem.active_wake_interval_seconds",
      // B6 founder 裁定——自动注册默认不开启。
      "policies.idle_gate_qitem.auto_register",
      "policies.idle_gate_qitem.opt_in_sessions",
      "snapshots.periodic.enabled",
      "snapshots.periodic.interval_seconds",
      "snapshots.periodic.retention_keep",
      // OPR.0.4.6.02 S1——内部 tmux status-bar 启动默认值（静态 bool）。
      "terminal.status_bar",
      // OPR.0.4.6.FS-1 W2——queue-retention 维护参数。
      "retention.enabled",
      "retention.transitions_days",
      "retention.watchdog_days",
      "retention.usage_samples_days", // 51-08 A2 (plan-lock rev-1): the PM-ruled 14d telemetry window
      "retention.watchdog_keep_per_job",
      "retention.batch_size",
      "queue.pickup_stall_threshold_minutes",
      // S02——standing-stuck-sweep cadence + unclaimed-obligation age。
      "queue.stuck_sweep_interval_seconds",
      "queue.stuck_sweep_unclaimed_age_minutes",
      // S01——wake-or-escalate ladder 参数。
      "queue.wake_retry_interval_seconds",
      "queue.wake_retry_cap",
      "queue.wake_unconfirmed_window_minutes",
      "queue.wake_swap_grace_seconds",
    ]);
  });

  it("解析 context.root，并拒绝已移除的 key、文件字段和 env", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveOne("context.root")).toMatchObject({
      value: expect.stringMatching(/context$/),
      source: "default",
    });

    process.env["OPENRIG_CONTEXT_ROOT"] = join(tmpDir, "context-library");
    expect(store.resolveOne("context.root")).toMatchObject({ value: join(tmpDir, "context-library"), source: "env" });
    delete process.env["OPENRIG_CONTEXT_ROOT"];

    expect(() => store.set("context.packs_root", "/legacy")).toThrow(/已移除.*context\.root/i);
    writeFileSync(configPath, JSON.stringify({ context: { packsRoot: "/legacy" } }));
    expect(() => store.resolveConfig()).toThrow(/context\.packs_root.*context\.root/i);
    writeFileSync(configPath, "{}\n");
    process.env["OPENRIG_CONTEXT_PACKS_ROOT"] = "/legacy-env";
    expect(() => store.resolveOne("context.root")).toThrow(/OPENRIG_CONTEXT_PACKS_ROOT.*OPENRIG_CONTEXT_ROOT/i);
  });

  it("解析可变的 95/99 context-pressure 阈值，并拒绝无效顺序", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveContextPressurePolicy()).toEqual({ warningPercent: 95, criticalPercent: 99 });
    expect(store.resolveOne("health.context_pressure.warning_percent")).toMatchObject({
      value: 95,
      source: "default",
      defaultValue: 95,
    });

    store.set("health.context_pressure.critical_percent", "100");
    store.set("health.context_pressure.warning_percent", "99");
    expect(store.resolveContextPressurePolicy()).toEqual({ warningPercent: 99, criticalPercent: 100 });
    expect(() => store.set("health.context_pressure.critical_percent", "97")).toThrow(/warning.*critical/i);
    for (const raw of ["0", "101", "95.5", "95junk"]) {
      expect(() => store.set("health.context_pressure.warning_percent", raw)).toThrow(/整数/);
    }

    const persistedBeforeReset = readFileSync(configPath, "utf-8");
    expect(() => store.reset("health.context_pressure.critical_percent")).toThrow(/warning.*critical/i);
    expect(readFileSync(configPath, "utf-8")).toBe(persistedBeforeReset);
    expect(JSON.parse(persistedBeforeReset)).toMatchObject({
      health: { contextPressure: { warningPercent: 99, criticalPercent: 100 } },
    });
    expect(store.resolveOne("health.context_pressure.warning_percent")).toMatchObject({ value: 99, source: "file" });
    expect(store.resolveOne("health.context_pressure.critical_percent")).toMatchObject({ value: 100, source: "file" });

    store.reset("health.context_pressure.warning_percent");
    store.reset("health.context_pressure.critical_percent");
    expect(store.resolveContextPressurePolicy()).toEqual({ warningPercent: 95, criticalPercent: 99 });
  });

  it("通过 default、file 和 env provenance 解析 System World selector", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveOne("context.system_world")).toMatchObject({ value: "default", source: "default" });
    store.set("context.system_world", "operator/system-world.yaml");
    expect(store.resolveOne("context.system_world")).toMatchObject({ value: "operator/system-world.yaml", source: "file" });
    process.env["OPENRIG_CONTEXT_SYSTEM_WORLD"] = "disabled";
    expect(store.resolveConfig().systemWorld).toBe("disabled");
  });

  it("W2c idle-gate-qitem cadence 默认为 scan=60、active-wake=900", () => {
    const store = new SettingsStore(configPath);
    expect(() => store.resolveOne("policies.idle_gate_qitem.scan_interval_seconds"))
      .not.toThrow();
    expect(() => store.resolveOne("policies.idle_gate_qitem.active_wake_interval_seconds"))
      .not.toThrow();
    expect(store.resolveOne("policies.idle_gate_qitem.scan_interval_seconds"))
      .toMatchObject({ value: 60, source: "default", defaultValue: 60 });
    expect(store.resolveOne("policies.idle_gate_qitem.active_wake_interval_seconds"))
      .toMatchObject({ value: 900, source: "default", defaultValue: 900 });
  });

  it("queue 整数设置拒绝部分数字和小数字符串", () => {
    const store = new SettingsStore(configPath);
    for (const key of [
      "queue.pickup_stall_threshold_minutes",
      "queue.stuck_sweep_interval_seconds",
      "queue.stuck_sweep_unclaimed_age_minutes",
    ]) {
      for (const raw of ["3junk", "60.5"]) {
        expect(() => store.set(key, raw), `${key} must reject ${raw}`)
          .toThrow(/正整数/);
      }
    }
  });

  it("W2c idle-gate-qitem cadence 解析时 env 优先于 file", () => {
    const store = new SettingsStore(configPath);
    expect(() => store.set("policies.idle_gate_qitem.scan_interval_seconds", "120")).not.toThrow();
    expect(() => store.set("policies.idle_gate_qitem.active_wake_interval_seconds", "1800")).not.toThrow();
    expect(store.resolveOne("policies.idle_gate_qitem.scan_interval_seconds"))
      .toMatchObject({ value: 120, source: "file" });
    expect(store.resolveOne("policies.idle_gate_qitem.active_wake_interval_seconds"))
      .toMatchObject({ value: 1800, source: "file" });

    process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_SCAN_INTERVAL_SECONDS = "30";
    process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_ACTIVE_WAKE_INTERVAL_SECONDS = "450";
    expect(store.resolveOne("policies.idle_gate_qitem.scan_interval_seconds"))
      .toMatchObject({ value: 30, source: "env" });
    expect(store.resolveOne("policies.idle_gate_qitem.active_wake_interval_seconds"))
      .toMatchObject({ value: 450, source: "env" });
  });

  it("W2c idle-gate-qitem cadence 拒绝零、负数、小数和部分数字", () => {
    const store = new SettingsStore(configPath);
    for (const key of [
      "policies.idle_gate_qitem.scan_interval_seconds",
      "policies.idle_gate_qitem.active_wake_interval_seconds",
    ]) {
      for (const raw of ["0", "-1", "1.5", "60abc"]) {
        expect(() => store.set(key, raw), `${key} must reject ${raw}`)
          .toThrow(/正整数/);
      }
    }
  });

  it("resolveAllWithSource 返回每个 key 及 source + default", () => {
    const store = new SettingsStore(configPath);
    const all = store.resolveAllWithSource();
    for (const key of SETTINGS_VALID_KEYS) {
      expect(all[key]).toBeDefined();
      expect(["env", "file", "default"]).toContain(all[key].source);
    }
  });

  it("默认 onboarding pack 开启，解析时 env 优先于 file", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveOne("onboarding.default_pack.enabled"))
      .toMatchObject({ value: true, source: "default", defaultValue: true });

    store.set("onboarding.default_pack.enabled", "false");
    expect(store.resolveOne("onboarding.default_pack.enabled"))
      .toMatchObject({ value: false, source: "file", defaultValue: true });

    process.env.OPENRIG_ONBOARDING_DEFAULT_PACK_ENABLED = "true";
    expect(store.resolveOne("onboarding.default_pack.enabled"))
      .toMatchObject({ value: true, source: "env", defaultValue: true });
  });

  it("daemon.port 的优先级为 env > file > default", () => {
    const store = new SettingsStore(configPath);
    // 无 file 时使用 default。
    expect(store.resolveOne("daemon.port").source).toBe("default");
    expect(store.resolveOne("daemon.port").value).toBe(7433);

    // 有 file 时使用 file。
    store.set("daemon.port", "9999");
    expect(store.resolveOne("daemon.port").value).toBe(9999);
    expect(store.resolveOne("daemon.port").source).toBe("file");

    // Env 胜出。
    process.env["OPENRIG_PORT"] = "8888";
    try {
      expect(store.resolveOne("daemon.port").value).toBe(8888);
      expect(store.resolveOne("daemon.port").source).toBe("env");
    } finally {
      delete process.env["OPENRIG_PORT"];
    }
  });

  it("workspace.root 级联到逐子目录默认值", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.root", "/custom/ws");
    store.set("skills.root", join(tmpDir, "skills"));
    const cfg = store.resolveConfig();
    expect(cfg.workspaceRoot).toBe("/custom/ws");
    expect(cfg.workspaceSlicesRoot).toBe("/custom/ws/missions");
    expect(cfg.workspaceSteeringPath).toBe("/custom/ws/STEERING.md");
    expect(cfg.workspaceSpecsRoot).toBe("/custom/ws/specs");
    expect(cfg.workspaceProjectsRoot).toBe("/custom/ws/projects");
    expect(cfg.workspaceCatalogPath).toBe("/custom/ws/workspace.yaml");
    expect(cfg.skillsRoot).toBe(join(tmpDir, "skills"));
    expect(cfg.filesAllowlistRaw).toBe("workspace:/custom/ws");
    expect(cfg.progressScanRootsRaw).toBe("workspace:/custom/ws");
  });

  it("recovery.auto_drive_provider_prompts 默认为 false 并解析到后台服务配置", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveOne("recovery.auto_drive_provider_prompts").value).toBe(false);
    store.set("recovery.auto_drive_provider_prompts", "true");
    expect(store.resolveConfig().recoveryAutoDriveProviderPrompts).toBe(true);
  });

  it("recovery.provider_auth_env_allowlist 默认为空并解析到后台服务配置", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveOne("recovery.provider_auth_env_allowlist").value).toBe("");
    store.set("recovery.provider_auth_env_allowlist", "ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN");
    expect(store.resolveConfig().recoveryProviderAuthEnvAllowlistRaw).toBe("ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("逐子目录 override 优先于 workspace.root 级联", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.root", "/ws");
    store.set("workspace.slices_root", "/custom/slices");
    const cfg = store.resolveConfig();
    expect(cfg.workspaceSlicesRoot).toBe("/custom/slices");
    // 其他子目录仍从 workspace.root 级联：
    expect(cfg.workspaceProjectsRoot).toBe("/ws/projects");
    expect(cfg.workspaceCatalogPath).toBe("/ws/workspace.yaml");
  });

  it("workspace project 路径默认来自 workspace.root，并支持 env override", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.root", "/custom/ws");
    expect(store.resolveConfig().workspaceProjectsRoot).toBe("/custom/ws/projects");
    expect(store.resolveConfig().workspaceCatalogPath).toBe("/custom/ws/workspace.yaml");

    store.set("workspace.projects_root", "/configured/projects");
    store.set("workspace.catalog_path", "/configured/workspace.yaml");
    expect(store.resolveOne("workspace.projects_root")).toMatchObject({ value: "/configured/projects", source: "file" });
    expect(store.resolveOne("workspace.catalog_path")).toMatchObject({ value: "/configured/workspace.yaml", source: "file" });

    process.env["OPENRIG_WORKSPACE_PROJECTS_ROOT"] = "/project/worlds";
    process.env["OPENRIG_WORKSPACE_CATALOG_PATH"] = "/catalog/workspace.yaml";
    try {
      expect(store.resolveOne("workspace.projects_root")).toMatchObject({ value: "/project/worlds", source: "env" });
      expect(store.resolveOne("workspace.catalog_path")).toMatchObject({ value: "/catalog/workspace.yaml", source: "env" });
    } finally {
      delete process.env["OPENRIG_WORKSPACE_PROJECTS_ROOT"];
      delete process.env["OPENRIG_WORKSPACE_CATALOG_PATH"];
    }
  });

  it("把持久化的 legacy workspace 默认值视为默认派生值", () => {
    writeFileSync(configPath, JSON.stringify({
      workspace: {
        root: "/ws",
        slicesRoot: "/ws/slices",
        steeringPath: "/ws/steering/STEERING.md",
      },
    }));
    const store = new SettingsStore(configPath);
    const slices = store.resolveOne("workspace.slices_root");
    const steering = store.resolveOne("workspace.steering_path");
    expect(slices).toMatchObject({ value: "/ws/missions", source: "default" });
    expect(steering).toMatchObject({ value: "/ws/STEERING.md", source: "default" });
  });

  it("UEP env-var 提升：OPENRIG_FILES_ALLOWLIST 解析 files.allowlist", () => {
    const store = new SettingsStore(configPath);
    process.env["OPENRIG_FILES_ALLOWLIST"] = "ws:/Users/me";
    try {
      expect(store.resolveOne("files.allowlist").value).toBe("ws:/Users/me");
      expect(store.resolveOne("files.allowlist").source).toBe("env");
    } finally {
      delete process.env["OPENRIG_FILES_ALLOWLIST"];
    }
  });

  it("set + reset 通过文件格式往返", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.slices_root", "/custom/slices");
    expect(existsSync(configPath)).toBe(true);
    expect(store.resolveOne("workspace.slices_root").value).toBe("/custom/slices");

    store.reset("workspace.slices_root");
    expect(store.resolveOne("workspace.slices_root").source).toBe("default");

    store.reset();
    expect(existsSync(configPath)).toBe(false);
  });

  it("set 拒绝未知 key", () => {
    const store = new SettingsStore(configPath);
    expect(() => store.set("workspace.bogus", "x")).toThrow(/未知配置键/);
  });

  it("格式错误的 JSON 抛出带 reset 提示的错误", () => {
    writeFileSync(configPath, "{not json");
    const store = new SettingsStore(configPath);
    expect(() => store.resolveAllWithSource()).toThrow(/格式错误/);
  });

  it("文件格式与 CLI ConfigStore 一致：嵌套 key 以 JSON 持久化", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.slices_root", "/x");
    store.set("daemon.port", "1234");
    const raw = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
    expect(raw.workspace.slicesRoot).toBe("/x");
    expect(raw.daemon.port).toBe(1234);
  });

  // Slice 27——Claude 自动压缩 policy 解析。
  it("HG-5 + HG-10：无 file/env 时 resolveClaudeCompactionPolicy 返回默认值（opt-in 默认关闭）", () => {
    const store = new SettingsStore(configPath);
    const policy = store.resolveClaudeCompactionPolicy();
    expect(policy.enabled).toBe(false);
    expect(policy.thresholdPercent).toBe(80);
    expect(policy.preCompactInstruction).toContain(DEFAULT_PRE_COMPACT_INSTRUCTION_FRAGMENT);
    expect(policy.compactInstruction).toBe("");
    expect(policy.messageInline).toContain(DEFAULT_RESTORE_INSTRUCTION_FRAGMENT);
    expect(policy.messageFilePath).toMatch(/^\//);
    expect(policy.messageFilePath.endsWith(DEFAULT_EXTRA_INSTRUCTION_FILE_SUFFIX)).toBe(true);
    expect(policy.postRestoreAuditInstruction).toContain(DEFAULT_AUDIT_INSTRUCTION_FRAGMENT);
  });

  it("HG-10：无需重启后台服务即可读取 config.json 的直接编辑（单次 resolve 调用重读文件）", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveClaudeCompactionPolicy().enabled).toBe(false);

    writeFileSync(
      configPath,
      JSON.stringify({
        policies: {
          claudeCompaction: {
            enabled: true,
            thresholdPercent: 65,
            preCompactInstruction: "prepare the map",
            compactInstruction: "preserve current task and decisions",
            messageInline: "carry-forward note",
            messageFilePath: "",
            postRestoreAuditInstruction: "verify the reads",
          },
        },
      }),
    );

    const updated = store.resolveClaudeCompactionPolicy();
    expect(updated.enabled).toBe(true);
    expect(updated.thresholdPercent).toBe(65);
    expect(updated.preCompactInstruction).toBe("prepare the map");
    expect(updated.compactInstruction).toBe("preserve current task and decisions");
    expect(updated.messageInline).toBe("carry-forward note");
    expect(updated.messageFilePath.endsWith(DEFAULT_EXTRA_INSTRUCTION_FILE_SUFFIX)).toBe(true);
    expect(updated.postRestoreAuditInstruction).toBe("verify the reads");
  });

  it("Slice 27：ensureDefaultClaudeCompactionFiles 创建用户所有的额外 instruction 占位文件且不覆盖编辑", () => {
    const openrigHome = join(tmpDir, ".openrig-placeholder");
    const filePath = ensureDefaultClaudeCompactionFiles(openrigHome);
    expect(filePath).toBe(defaultClaudeCompactionExtraInstructionFilePath(openrigHome));
    expect(existsSync(filePath)).toBe(true);
    expect(require("node:fs").readFileSync(filePath, "utf-8")).toBe(
      DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_CONTENT,
    );

    writeFileSync(filePath, "operator edits\n", "utf-8");
    ensureDefaultClaudeCompactionFiles(openrigHome);
    expect(require("node:fs").readFileSync(filePath, "utf-8")).toBe("operator edits\n");
  });

  it("HG-1：每个 policy key 的 set/get 往返会持久化到磁盘并读回", () => {
    const store = new SettingsStore(configPath);

    store.set("policies.claude_compaction.enabled", "true");
    store.set("policies.claude_compaction.threshold_percent", "60");
    store.set("policies.claude_compaction.pre_compact_instruction", "prepare before compact");
    store.set("policies.claude_compaction.compact_instruction", "summarize with decisions first");
    store.set("policies.claude_compaction.message_inline", "rehydrate the agent");
    store.set("policies.claude_compaction.message_file_path", "/tmp/msg.txt");
    store.set("policies.claude_compaction.post_restore_audit_instruction", "audit reads");

    const raw = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
    expect(raw.policies.claudeCompaction.enabled).toBe(true);
    expect(raw.policies.claudeCompaction.thresholdPercent).toBe(60);
    expect(raw.policies.claudeCompaction.preCompactInstruction).toBe("prepare before compact");
    expect(raw.policies.claudeCompaction.compactInstruction).toBe("summarize with decisions first");
    expect(raw.policies.claudeCompaction.messageInline).toBe("rehydrate the agent");
    expect(raw.policies.claudeCompaction.messageFilePath).toBe("/tmp/msg.txt");
    expect(raw.policies.claudeCompaction.postRestoreAuditInstruction).toBe("audit reads");

    expect(store.resolveOne("policies.claude_compaction.enabled").value).toBe(true);
    expect(store.resolveOne("policies.claude_compaction.threshold_percent").value).toBe(60);
    expect(store.resolveOne("policies.claude_compaction.pre_compact_instruction").value).toBe("prepare before compact");
    expect(store.resolveOne("policies.claude_compaction.compact_instruction").value).toBe("summarize with decisions first");
    expect(store.resolveOne("policies.claude_compaction.message_inline").value).toBe("rehydrate the agent");
    expect(store.resolveOne("policies.claude_compaction.message_file_path").value).toBe("/tmp/msg.txt");
    expect(store.resolveOne("policies.claude_compaction.post_restore_audit_instruction").value).toBe("audit reads");
  });

  it("HG-1：coerceValue 拒绝无效阈值（非数字抛错）", () => {
    const store = new SettingsStore(configPath);
    expect(() => store.set("policies.claude_compaction.threshold_percent", "not-a-number")).toThrow(/应为数字/);
  });

  // Slice 27 BLOCKING-FIX-2——env + file 来源解析也必须拒绝无效阈值。否则 env override
  //（OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT=80abc）或手工编辑的 config.json 会
  // 污染 trigger 契约，因为写路径验证器被完全绕过。
  //
  // 错误输入行为：丢弃 override，向 stderr 告警，并回退到 file/default（env 层）或 default（file 层）。
  describe("BLOCKING-FIX-2：env + file 来源验证", () => {
    const reject = ["0", "101", "-1", "80abc", "80.5", "NaN", "Infinity"];

    for (const raw of reject) {
      it(`env=${JSON.stringify(raw)} 时 resolveOne 返回默认值 80（env 被拒绝而非强制转换）`, () => {
        process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = raw;
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const store = new SettingsStore(configPath);
          const resolved = store.resolveOne("policies.claude_compaction.threshold_percent");
          // 默认值为 80，source 回退为 "default"。
          expect(resolved.value).toBe(80);
          expect(resolved.source).toBe("default");
          // 已发出警告（操作员可见）。
          const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((c) => c.includes("env override for policies.claude_compaction.threshold_percent rejected"))).toBe(true);
        } finally {
          stderrSpy.mockRestore();
          delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
        }
      });
    }

    it("判别项：env=80abc（拒绝、source=default、有警告）与 env=80（接受、source=env、无警告）", () => {
      // 情况 A：拒绝 env。
      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "80abc";
      let stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const a = new SettingsStore(configPath).resolveOne("policies.claude_compaction.threshold_percent");
        expect(a.value).toBe(80);
        expect(a.source).toBe("default");
        const warnCount = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((c) => c.includes("env override for policies.claude_compaction.threshold_percent rejected"))
          .length;
        expect(warnCount).toBe(1);
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
      }

      // 情况 B：接受 env；解析值同为 80，但可观察结果不同：source=env 且无警告。这就是判别项。
      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "80";
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const b = new SettingsStore(configPath).resolveOne("policies.claude_compaction.threshold_percent");
        expect(b.value).toBe(80);
        expect(b.source).toBe("env");
        const warnCount = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((c) => c.includes("rejected"))
          .length;
        expect(warnCount).toBe(0);
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
      }
    });

    const fileReject: Array<{ name: string; written: unknown }> = [
      { name: "0", written: 0 },
      { name: "101", written: 101 },
      { name: "-1", written: -1 },
      { name: "80.5 (non-integer JSON number)", written: 80.5 },
      { name: '"80abc" (JSON string)', written: "80abc" },
    ];

    for (const { name, written } of fileReject) {
      it(`file thresholdPercent=${name} 时 resolveOne 返回默认值 80 并告警`, () => {
        writeFileSync(configPath, JSON.stringify({
          policies: { claudeCompaction: { thresholdPercent: written } },
        }));
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const resolved = new SettingsStore(configPath).resolveOne("policies.claude_compaction.threshold_percent");
          expect(resolved.value).toBe(80);
          expect(resolved.source).toBe("default");
          const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((c) => c.includes("file value for policies.claude_compaction.threshold_percent rejected"))).toBe(true);
        } finally {
          stderrSpy.mockRestore();
        }
      });
    }
  });

  // Slice 27 BLOCKING-FIX——threshold_percent 的严格接受/拒绝矩阵。按预存的
  // feedback_static_gates_mirror_runtime_validators，runtime validator 是事实来源；本测试调用后台服务
  // /api/config POST handler 使用的同一 `set()` 路径，使未来漂移在 CI 中暴露。
  describe("HG-1 严格阈值验证矩阵", () => {
    const cases = {
      accept: ["1", "2", "50", "80", "99", "100"],
      reject: [
        { raw: "0", reason: /必须在 \[1, 100\] 范围内/ },
        { raw: "101", reason: /必须在 \[1, 100\] 范围内/ },
        { raw: "-1", reason: /必须在 \[1, 100\] 范围内/ },
        { raw: "80abc", reason: /应为 \[1, 100\] 范围内的整数/ },
        { raw: "abc80", reason: /应为数字|应为 \[1, 100\] 范围内的整数/ },
        { raw: "80.5", reason: /应为 \[1, 100\] 范围内的整数/ },
        { raw: "", reason: /应为数字|应为 \[1, 100\] 范围内的整数/ },
        { raw: " ", reason: /应为数字|应为 \[1, 100\] 范围内的整数/ },
        { raw: "NaN", reason: /应为数字|应为 \[1, 100\] 范围内的整数/ },
        { raw: "Infinity", reason: /应为数字|应为 \[1, 100\] 范围内的整数/ },
      ],
    };

    for (const value of cases.accept) {
      it(`接受 ${JSON.stringify(value)}`, () => {
        const store = new SettingsStore(configPath);
        expect(() => store.set("policies.claude_compaction.threshold_percent", value)).not.toThrow();
        expect(store.resolveOne("policies.claude_compaction.threshold_percent").value).toBe(Number(value));
      });
    }

    for (const { raw, reason } of cases.reject) {
      it(`拒绝 ${JSON.stringify(raw)}`, () => {
        const store = new SettingsStore(configPath);
        expect(() => store.set("policies.claude_compaction.threshold_percent", raw)).toThrow(reason);
      });
    }
  });

  void existsSync;
});

describe("parseNamedPairs（后台服务副本）", () => {
  it("解码 name:path,name:path pair", () => {
    expect(parseNamedPairs("ws:/abs/a,docs:/abs/b")).toEqual([
      { name: "ws", path: "/abs/a" },
      { name: "docs", path: "/abs/b" },
    ]);
  });
  it("空值或纯空白返回空数组", () => {
    expect(parseNamedPairs("")).toEqual([]);
    expect(parseNamedPairs("  ")).toEqual([]);
  });
});
