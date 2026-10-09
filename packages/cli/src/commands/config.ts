import { Command } from "commander";
import { ConfigStore, VALID_KEYS, type ResolvedSetting, type ValidKey } from "../config-store.js";
import { initWorkspaceCommand } from "./config-init-workspace.js";

function formatRow(key: string, value: unknown): string {
  return `${key.padEnd(28)} ${value}`;
}

function summarizeSettings(store: ConfigStore): Record<ValidKey, ResolvedSetting> {
  return store.resolveAllWithSource();
}

// SWEEP-c（shape f2576102）——这些键只在后台服务启动时读取：运行中设置的值
// 要到重启后才生效；诚实的底线是大声提示（热加载是独立架构事项，不在此处实现）。
const BOOT_ONLY_KEYS = ["daemon.port", "daemon.host", "db.path"];
const BOOT_ONLY_PREFIXES = ["transcripts."];

function isBootOnlyKey(key: string): boolean {
  return BOOT_ONLY_KEYS.includes(key) || BOOT_ONLY_PREFIXES.some((p) => key.startsWith(p));
}

export function configCommand(
  configPath?: string,
  deps?: {
    /** SWEEP-c 测试缝：当前是否有后台服务在运行？生产环境探测 healthz。 */
    probeDaemonRunning?: () => Promise<boolean>;
  },
): Command {
  const cmd = new Command("config").description("查看并修改 zrig 配置");
  const store = new ConfigStore(configPath);
  const probeDaemonRunning = deps?.probeDaemonRunning ?? (async () => {
    try {
      const { getDaemonStatus } = await import("../daemon-lifecycle.js");
      const { realDeps } = await import("./daemon.js");
      const status = await getDaemonStatus(realDeps());
      return status.state === "running";
    } catch {
      return false; // 探测失败=不提示（绝不误报）
    }
  });

  cmd
    .option("--json", "供智能体使用的 JSON 输出（解析后的 RiggedConfig）")
    .option("--with-source", "附带每个键的来源/默认值（如实标注出处）")
    .addHelpText("after", `
示例：
  zrig config                                 # 显示全部已解析配置
  zrig config --json                          # JSON RiggedConfig（结构化）
  zrig config --json --with-source            # JSON：每个键附带来源 + 默认值
  zrig config get daemon.port                 # 读取单个键
  zrig config get workspace.slices_root --show-source
  zrig config set daemon.port 7434            # 修改值
  zrig config set workspace.slices_root /path # 配置工作区路径
  zrig config reset                           # 删除配置文件，全部恢复默认
  zrig config reset workspace.slices_root     # 清空单个键，恢复默认
  zrig config init-workspace                  # 脚手架化生成可入库的项目工作区

配置键：
  daemon.*               port, host
  db.path
  transcripts.*          enabled, path, lines, poll_interval_seconds
                         （lines/poll_interval 设置回滚捕获深度与频率。
                         瘦版 CLAUDE transcripts 通常不是这些——它们指席位的
                         全屏渲染器，其备用屏幕不产生回滚。zrig 默认以
                         CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 启动 Claude；
                         设置 OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0 可退回全屏。）
  workspace.*            root, slices_root, steering_path, specs_root,
                         projects_root, catalog_path, operator_seat_name
  topology.root          拓扑树根（最顶层实例高度；默认 $OPENRIG_HOME/topology）
  context.root           'rig context add' 可寻址的上下文库（默认 $OPENRIG_HOME/context）
  context.system_world   默认 System World，替换清单路径，或 disabled
  skills.root            带版本的技能目录（默认 $OPENRIG_HOME/skills）
  onboarding.default_pack.enabled  交付两部分的新席位心智模型包（默认开启）
  health.context_pressure.*        上下文压力 warning/critical 百分比（默认 95/99）
  files.allowlist        name:/abs/path,name:/abs/path
  progress.scan_roots    name:/abs/path,name:/abs/path
  ui.timezone            TUI IANA 时区（默认 America/Los_Angeles；修改后需重开 TUI）
  ui.preview.*           refresh_interval_seconds, max_pins, default_lines
  recovery.*             auto_drive_provider_prompts, provider_auth_env_allowlist
  agents.*               advisor_session, operator_session
  feed.subscriptions.*   action_required, approvals, shipped, progress, audit_log
  runtime.codex.*        hooks_enabled
  workflow.*             exception_routing（orchestrator | human_only——成熟度调节宿主默认）
  policies.claude_compaction.*
                         enabled, threshold_percent, compact_instruction,
                         message_inline, message_file_path
  policies.idle_gate_qitem.scan_interval_seconds
  policies.idle_gate_qitem.active_wake_interval_seconds
  snapshots.periodic.*   enabled, interval_seconds, retention_keep
  queue.*                pickup_stall_threshold_minutes（S04 领取回执停滞阈值），
                         stuck_sweep_interval_seconds, stuck_sweep_unclaimed_age_minutes（S02 常驻卡死扫描），
                         wake_retry_interval_seconds, wake_retry_cap, wake_unconfirmed_window_minutes,
                         wake_swap_grace_seconds（S01 唤醒/升级阶梯）
  retention.*            enabled, transitions_days, watchdog_days,
                         watchdog_keep_per_job, batch_size
  terminal.status_bar    启动时显示内层 tmux 状态栏（默认关闭）

优先级：CLI 标志 > 环境变量 > 配置文件 > 默认值`)
    .action((opts: { json?: boolean; withSource?: boolean }) => {
      try {
        if (opts.withSource) {
          const all = summarizeSettings(store);
          if (opts.json) {
            console.log(JSON.stringify(all, null, 2));
          } else {
            for (const key of VALID_KEYS) {
              const r = all[key];
              console.log(formatRow(key, `${r.value}  （来源：${r.source}）`));
            }
          }
          return;
        }
        // 默认：结构化 RiggedConfig 输出（保留 v0 前裸 action 的形态，
        // 使既有脚本/测试继续工作）。
        const config = store.resolve();
        if (opts.json) {
          console.log(JSON.stringify(config, null, 2));
        } else {
          const all = summarizeSettings(store);
          for (const key of VALID_KEYS) {
            const r = all[key];
            console.log(formatRow(key, `${r.value}  （来源：${r.source}）`));
          }
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  const getCmd = new Command("get")
    .argument("<key>", "配置键（例如 daemon.port）")
    .option("--json", "含值 + 来源 + 默认值的 JSON 输出")
    .option("--show-source", "在同一行打印值 + 来源")
    .description("读取单个配置值")
    .action((key: string, opts: { json?: boolean; showSource?: boolean }) => {
      try {
        if (opts.json || cmd.opts<{ json?: boolean }>().json) {
          console.log(JSON.stringify(store.resolveWithSource(key), null, 2));
          return;
        }
        if (opts.showSource) {
          const r = store.resolveWithSource(key);
          console.log(`${r.value}\t（来源：${r.source}）`);
          return;
        }
        console.log(String(store.get(key)));
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  const setCmd = new Command("set")
    .argument("<key>", "配置键（例如 daemon.port）")
    .argument("<value>", "要设置的值")
    .description("设置配置值")
    .action(async (key: string, value: string) => {
      try {
        store.set(key, value);
        console.log(`${key} = ${store.get(key)}`);
        // SWEEP-c：仅启动时读取的键 + 后台服务正在运行 = 重启前不生效；明确提示。
        if (isBootOnlyKey(key) && (await probeDaemonRunning())) {
          console.error(`注意：'${key}' 只在后台服务启动时读取——运行中的后台服务仍使用当前值；下次重启后台服务后生效（zrig daemon stop && zrig daemon start）。`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  const resetCmd = new Command("reset")
    .argument("[key]", "可选：要重置的配置键（省略则重置整个文件）")
    .description("清空配置覆盖（未提供键时删除整个文件）")
    .action((key: string | undefined) => {
      try {
        store.reset(key);
        if (key) {
          console.log(`${key} 已重置为默认值（${store.get(key)}）。`);
        } else {
          console.log("配置已重置为默认值。");
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.addCommand(getCmd);
  cmd.addCommand(setCmd);
  cmd.addCommand(resetCmd);
  cmd.addCommand(initWorkspaceCommand(configPath));

  return cmd;
}
