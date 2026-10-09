#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { daemonCommand } from "./commands/daemon.js";
import { statusCommand, type StatusDeps } from "./commands/status.js";
import { crashCartCommand } from "./commands/crash-cart.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { restoreCommand } from "./commands/restore.js";
import { exportCommand, type ExportDeps } from "./commands/export.js";
import { importCommand, type ImportDeps } from "./commands/import.js";
import { uiCommand, type UiDeps } from "./commands/ui.js";
import { tuiCommand } from "./commands/tui.js";
import { packageCommand } from "./commands/package.js";
import { bootstrapCommand } from "./commands/bootstrap.js";
import { requirementsCommand } from "./commands/requirements.js";
import { discoverCommand } from "./commands/discover.js";
import { attachCommand } from "./commands/attach.js";
import { bindCommand } from "./commands/bind.js";
import { adoptCommand, type AdoptDeps } from "./commands/adopt.js";
import { bundleCommand } from "./commands/bundle.js";
import { scopeCommand } from "./commands/scope.js";
import { proofCommand } from "./commands/proof.js";
import { upCommand } from "./commands/up.js";
import { downCommand } from "./commands/down.js";
import { archiveCommand } from "./commands/archive.js";
import { unarchiveCommand } from "./commands/unarchive.js";
import { psCommand } from "./commands/ps.js";
import { hostCommand } from "./commands/host.js";
import { gatewayCommand } from "./commands/gateway.js";
import type { GatewayCommandDeps } from "./commands/gateway.js";
import { parkedCommand } from "./commands/parked.js";
import { mcpCommand } from "./commands/mcp.js";
import { agentCommand, type AgentDeps } from "./commands/agent.js";
import { rigCommand, type RigDeps } from "./commands/rig.js";
import { transcriptCommand } from "./commands/transcript.js";
import { sendCommand } from "./commands/send.js";
import { streamCommand, type StreamDeps } from "./commands/stream.js";
import { queueCommand, type QueueDeps } from "./commands/queue.js";
import { slackCommand, type SlackDeps } from "./commands/slack.js";
import { projectCommand, type ProjectDeps } from "./commands/project.js";
import { viewCommand, type ViewDeps } from "./commands/view.js";
import { terminalCommand, type TerminalDeps } from "./commands/terminal.js";
import { watchdogCommand, type WatchdogDeps } from "./commands/watchdog.js";
import { workflowCommand, type WorkflowDeps } from "./commands/workflow.js";
import { startCommand, type StartDeps } from "./commands/start.js";
import { captureCommand } from "./commands/capture.js";
import { broadcastCommand } from "./commands/broadcast.js";
import { walkCommand } from "./commands/walk.js";
import { configCommand } from "./commands/config.js";
import { fileCommand } from "./commands/file.js";
import { preflightCommand } from "./commands/preflight.js";
import { authCommand } from "./commands/auth.js";
import { providerCommand } from "./commands/provider.js";
import { usageCommand } from "./commands/usage.js";
import { healthCommand, type HealthDeps } from "./commands/health.js";
import { doctorCommand } from "./commands/doctor.js";
import { expandCommand } from "./commands/expand.js";
import { addMemberCommand } from "./commands/add.js";
import { createCommand } from "./commands/create.js";
import { growCommand } from "./commands/grow.js";
import { reconcileSessionCommand } from "./commands/reconcile-session.js";
import { envCommand } from "./commands/env.js";
import { askCommand } from "./commands/ask.js";
import { chatroomCommand } from "./commands/chatroom.js";
import { specsCommand } from "./commands/specs.js";
import { contextCommand } from "./commands/context.js";
import { pluginCommand } from "./commands/plugin.js";
import { skillCommand } from "./commands/skill.js";
import { agentImageCommand } from "./commands/agent-image.js";
import { forkCommand } from "./commands/fork.js";
import { workspaceCommand, type WorkspaceDeps } from "./commands/workspace.js";
import { whoamiCommand } from "./commands/whoami.js";
import { unclaimCommand } from "./commands/unclaim.js";
import { releaseCommand } from "./commands/release.js";
import { launchCommand } from "./commands/launch.js";
import { removeCommand } from "./commands/remove.js";
import { shrinkCommand } from "./commands/shrink.js";
import { destroyCommand, type DestroyCommandDeps } from "./commands/destroy.js";
import { setupCommand } from "./commands/setup.js";
import { restoreCheckCommand } from "./commands/restore-check.js";
import { restorePacketCommand, type RestorePacketDeps } from "./commands/restore-packet.js";
import { compactPlanCommand, type CompactPlanDeps } from "./commands/compact-plan.js";
import { compactCommand, type CompactDeps } from "./commands/compact.js";
import { heartbeatCommand, type HeartbeatDeps } from "./commands/heartbeat.js";
import { seatCommand, handoverCommand, type SeatDeps } from "./commands/seat.js";
import { rigModeCommand, type RigModeDeps } from "./commands/rig-mode.js";
import { policyCommand } from "./commands/policy.js";
import { startupProofCommand, type StartupProofDeps } from "./commands/startup-proof.js";
import type { LifecycleDeps } from "./daemon-lifecycle.js";
import { CLI_VERSION } from "./version.js";

export interface ProgramDeps {
  daemonDeps?: LifecycleDeps;
  statusDeps?: StatusDeps;
  snapshotDeps?: StatusDeps;
  restoreDeps?: StatusDeps;
  uiDeps?: UiDeps;
  exportDeps?: ExportDeps;
  importDeps?: ImportDeps;
  packageDeps?: StatusDeps;
  bootstrapDeps?: StatusDeps;
  requirementsDeps?: StatusDeps;
  discoverDeps?: StatusDeps;
  attachDeps?: StatusDeps;
  bindDeps?: StatusDeps;
  adoptDeps?: AdoptDeps;
  bundleDeps?: StatusDeps;
  upDeps?: StatusDeps;
  downDeps?: StatusDeps;
  archiveDeps?: StatusDeps;
  unarchiveDeps?: StatusDeps;
  psDeps?: StatusDeps;
  mcpDeps?: StatusDeps;
  agentDeps?: AgentDeps;
  rigDeps?: RigDeps;
  transcriptDeps?: StatusDeps;
  sendDeps?: StatusDeps;
  streamDeps?: StreamDeps;
  queueDeps?: QueueDeps;
  gatewayDeps?: GatewayCommandDeps;
  slackDeps?: SlackDeps;
  projectDeps?: ProjectDeps;
  viewDeps?: ViewDeps;
  terminalDeps?: TerminalDeps;
  watchdogDeps?: WatchdogDeps;
  workflowDeps?: WorkflowDeps;
  captureDeps?: StatusDeps;
  broadcastDeps?: StatusDeps;
  walkDeps?: StatusDeps;
  askDeps?: StatusDeps;
  chatroomDeps?: StatusDeps;
  specsDeps?: StatusDeps;
  contextDeps?: StatusDeps;
  pluginDeps?: StatusDeps;
  skillDeps?: StatusDeps;
  agentImageDeps?: StatusDeps;
  forkDeps?: StatusDeps;
  workspaceDeps?: WorkspaceDeps;
  whoamiDeps?: StatusDeps;
  expandDeps?: StatusDeps;
  addDeps?: StatusDeps;
  createDeps?: StatusDeps;
  growDeps?: StatusDeps;
  reconcileSessionDeps?: StatusDeps;
  envDeps?: StatusDeps;
  unclaimDeps?: StatusDeps;
  releaseDeps?: StatusDeps;
  launchDeps?: StatusDeps;
  removeDeps?: StatusDeps;
  shrinkDeps?: StatusDeps;
  destroyDeps?: DestroyCommandDeps;
  restorePacketDeps?: RestorePacketDeps;
  compactPlanDeps?: CompactPlanDeps;
  compactDeps?: CompactDeps;
  heartbeatDeps?: HeartbeatDeps;
  seatDeps?: SeatDeps;
  rigModeDeps?: RigModeDeps;
  startupProofDeps?: StartupProofDeps;
  healthDeps?: HealthDeps;
  startDeps?: StartDeps;
  configPath?: string;
}

/**
 * Commander 帮助面板的中文标题映射。
 * styleTitle 只会收到 Commander 自身的固定标题（'Usage:' 等），
 * 这里做白名单替换，绝不触碰守护进程/用户数据文本。
 */
const HELP_TITLE_ZH: Record<string, string> = {
  "Usage:": "用法：",
  "Options:": "选项：",
  "Commands:": "命令：",
  "Arguments:": "参数：",
  "Global Options:": "全局选项：",
};

/**
 * 递归地把整条命令树的帮助面板本地化为简体中文。
 * Commander 的帮助配置不会自动从父命令继承到子命令，因此需要逐节点应用
 * （与 applyExitOverride 同样的遍历方式）。只改展示文案，不改命令标识与行为。
 */
function localizeCliHelp(cmd: Command): void {
  cmd.configureHelp({
    styleTitle: (title: string) => HELP_TITLE_ZH[title] ?? title,
    // 命令列表里子命令项后缀的 `[options]` 占位词本地化；保留命令名与 <arg> 参数。
    subcommandTerm: (command: Command): string => {
      const name = (command as unknown as { _name: string })._name;
      const aliases = (command as unknown as { _aliases: string[] })._aliases;
      const args = (command.registeredArguments as unknown as Array<{ name(): string; required: boolean; variadic: boolean }>)
        .map((arg) => {
          const n = arg.name() + (arg.variadic ? "..." : "");
          return arg.required ? `<${n}>` : `[${n}]`;
        })
        .join(" ");
      return (
        name +
        (aliases[0] ? `|${aliases[0]}` : "") +
        (command.options.length ? " [选项]" : "") +
        (args ? ` ${args}` : "")
      );
    },
    // 把用法行里 Commander 固定追加的占位词 [options]/[command] 本地化为中文，
    // 但复用 cmd.usage() 的默认输出（含各命令自己的 <arg> 参数占位），
    // 仅做整词替换，绝不触碰 <rigId>/<path> 等参数占位与命令名。
    commandUsage: (command: Command): string => {
      let cmdName: string = (command as unknown as { _name: string })._name;
      const aliases = (command as unknown as { _aliases: string[] })._aliases;
      if (aliases[0]) cmdName = `${cmdName}|${aliases[0]}`;
      let ancestorCmdNames = "";
      for (let a = command.parent; a; a = a.parent) {
        ancestorCmdNames = `${a.name()} ${ancestorCmdNames}`;
      }
      const tail = command
        .usage()
        .replace(/\[options\]/g, "[选项]")
        .replace(/\[command\]/g, "[命令]");
      return `${ancestorCmdNames}${cmdName} ${tail}`;
    },
  });
  // Commander 自动注册的 -h/--help 默认描述是英文“display help for command”，
  // 统一替换为中文。本仓库没有任何命令自定义帮助选项，因此直接覆盖安全。
  cmd.helpOption("-h, --help", "显示帮助信息");
  // Commander 自动注册的内置 help 子命令，默认描述也是英文“display help for command”，
  // 这里只改其展示描述；命令名 `help` 与参数 `[command]` 保持可输入原样。
  cmd.helpCommand("help [command]", "显示命令帮助");
  for (const sub of cmd.commands) localizeCliHelp(sub);
}

/**
 * 解析帮助/版本展示用的程序品牌名。
 *
 * 入口包装器（bin-wrapper）会把被调用的可执行链接名通过 OPENRIG_INVOKED_AS
 * 传进来（zrig / rig / openrig），仅用于帮助与版本的展示。这里只接受已知品牌名，
 * 其余情况（包括直接 node 运行、测试 import）一律默认中文品牌 zrig。
 * 该值只影响展示，不改变任何协议、环境变量、socket 或子命令行为。
 */
const KNOWN_INVOKED_AS = new Set(["zrig", "rig", "openrig"]);
function resolveDisplayName(): string {
  const as = process.env["OPENRIG_INVOKED_AS"];
  return as && KNOWN_INVOKED_AS.has(as) ? as : "zrig";
}

export function createProgram(depsOverride?: ProgramDeps): Command {
  const program = new Command();

  program
    .name(resolveDisplayName())
    .description("zrig 本地控制平面命令行")
    .version(CLI_VERSION, "-V, --version", "输出版本号");

  // 挂载完所有子命令后再统一本地化帮助（此时命令树已完整）。
  const root = program;
  program.addCommand(startCommand(depsOverride?.startDeps));
  program.addCommand(daemonCommand(depsOverride?.daemonDeps));
  program.addCommand(statusCommand(depsOverride?.statusDeps));
  program.addCommand(snapshotCommand(depsOverride?.snapshotDeps));
  program.addCommand(restoreCommand(depsOverride?.restoreDeps));
  program.addCommand(crashCartCommand());
  program.addCommand(gatewayCommand(depsOverride?.gatewayDeps));
  program.addCommand(parkedCommand());
  program.addCommand(exportCommand(depsOverride?.exportDeps));
  program.addCommand(importCommand(depsOverride?.importDeps));
  program.addCommand(uiCommand(depsOverride?.uiDeps));
  program.addCommand(tuiCommand());
  program.addCommand(packageCommand(depsOverride?.packageDeps));
  program.addCommand(bootstrapCommand(depsOverride?.bootstrapDeps));
  program.addCommand(requirementsCommand(depsOverride?.requirementsDeps));
  program.addCommand(discoverCommand(depsOverride?.discoverDeps));
  program.addCommand(attachCommand(depsOverride?.attachDeps));
  program.addCommand(bindCommand(depsOverride?.bindDeps));
  program.addCommand(adoptCommand(depsOverride?.adoptDeps));
  program.addCommand(bundleCommand(depsOverride?.bundleDeps));
  program.addCommand(upCommand(depsOverride?.upDeps));
  program.addCommand(downCommand(depsOverride?.downDeps));
  // OPR.0.3.3.19 — rig 归档入口（软操作、可撤销；不是删除）。
  program.addCommand(archiveCommand(depsOverride?.archiveDeps));
  program.addCommand(unarchiveCommand(depsOverride?.unarchiveDeps));
  program.addCommand(hostCommand());
  program.addCommand(psCommand(depsOverride?.psDeps));
  program.addCommand(mcpCommand(depsOverride?.mcpDeps));
  program.addCommand(agentCommand(depsOverride?.agentDeps));
  program.addCommand(rigCommand(depsOverride?.rigDeps));
  program.addCommand(transcriptCommand(depsOverride?.transcriptDeps));
  program.addCommand(sendCommand(depsOverride?.sendDeps));
  program.addCommand(streamCommand(depsOverride?.streamDeps));
  program.addCommand(queueCommand(depsOverride?.queueDeps));
  program.addCommand(slackCommand(depsOverride?.slackDeps));
  program.addCommand(projectCommand(depsOverride?.projectDeps));
  program.addCommand(viewCommand(depsOverride?.viewDeps));
  program.addCommand(terminalCommand(depsOverride?.terminalDeps));
  program.addCommand(watchdogCommand(depsOverride?.watchdogDeps));
  program.addCommand(workflowCommand(depsOverride?.workflowDeps));
  program.addCommand(captureCommand(depsOverride?.captureDeps));
  program.addCommand(broadcastCommand(depsOverride?.broadcastDeps));
  program.addCommand(walkCommand(depsOverride?.walkDeps));
  program.addCommand(askCommand(depsOverride?.askDeps));
  program.addCommand(chatroomCommand(depsOverride?.chatroomDeps));
  program.addCommand(specsCommand(depsOverride?.specsDeps));
  program.addCommand(contextCommand(depsOverride?.contextDeps));
  program.addCommand(pluginCommand(depsOverride?.pluginDeps));
  program.addCommand(skillCommand(depsOverride?.skillDeps));
  program.addCommand(agentImageCommand(depsOverride?.agentImageDeps));
  program.addCommand(forkCommand(depsOverride?.forkDeps));
  program.addCommand(workspaceCommand(depsOverride?.workspaceDeps));
  program.addCommand(rigModeCommand(depsOverride?.rigModeDeps));
  // B7 — 重新引入的权限策略动词（上面的上下文模式动词现为 `rig mode`）。
  program.addCommand(policyCommand());
  program.addCommand(whoamiCommand(depsOverride?.whoamiDeps));
  program.addCommand(configCommand(depsOverride?.configPath));
  program.addCommand(fileCommand());
  program.addCommand(preflightCommand());
  program.addCommand(authCommand());
  program.addCommand(providerCommand());
  program.addCommand(usageCommand());
  program.addCommand(healthCommand(depsOverride?.healthDeps));
  program.addCommand(doctorCommand());
  program.addCommand(expandCommand(depsOverride?.expandDeps));
  program.addCommand(addMemberCommand(depsOverride?.addDeps));
  program.addCommand(createCommand(depsOverride?.createDeps));
  program.addCommand(growCommand(depsOverride?.growDeps));
  program.addCommand(reconcileSessionCommand(depsOverride?.reconcileSessionDeps));
  program.addCommand(envCommand(depsOverride?.envDeps));
  program.addCommand(unclaimCommand(depsOverride?.unclaimDeps));
  program.addCommand(releaseCommand(depsOverride?.releaseDeps));
  program.addCommand(launchCommand(depsOverride?.launchDeps));
  program.addCommand(removeCommand(depsOverride?.removeDeps));
  program.addCommand(shrinkCommand(depsOverride?.shrinkDeps));
  program.addCommand(destroyCommand(depsOverride?.destroyDeps));
  program.addCommand(setupCommand());
  program.addCommand(restoreCheckCommand());
  program.addCommand(restorePacketCommand(depsOverride?.restorePacketDeps));
  program.addCommand(compactPlanCommand(depsOverride?.compactPlanDeps));
  program.addCommand(compactCommand(depsOverride?.compactDeps));
  program.addCommand(heartbeatCommand(depsOverride?.heartbeatDeps));
  program.addCommand(seatCommand(depsOverride?.seatDeps));
  program.addCommand(handoverCommand(depsOverride?.seatDeps));
  program.addCommand(startupProofCommand(depsOverride?.startupProofDeps));
  // release-0.3.2 slice 12 — rig scope CLI 原语。
  program.addCommand(scopeCommand());
  // OPR.0.4.4.19 FR-8 — rig proof：C1 proof-drop 写入路径。
  program.addCommand(proofCommand());

  // 命令树挂载完成，统一本地化帮助标题与 -h/--help 描述。
  localizeCliHelp(root);

  return root;
}

export function isDirectRun(argv1 = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argv1) return false;

  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Slice 15 —— 共享的 CLI 错误/退出路径（为 bin-wrapper 与测试而重新导出）。
export { runProgram, wantsJsonOutput } from "./cli-error.js";
// Slice 17 —— 裸 rig 前门（重新导出，使公开的 bin-wrapper
// 路径也能负责裸 TTY 调用，而不仅是直接入口运行）。
export { runFrontDoor } from "./front-door.js";

// 仅在被直接执行时才解析命令行（被测试 import 时不执行）
if (isDirectRun()) {
  // Slice-17 mini-req 7 —— 真实终端里裸 `rig` 会打开 TUI；
  // 带任何参数或非 TTY 流时则照常回落到普通程序。
  const { runFrontDoor } = await import("./front-door.js");
  const owned = await runFrontDoor(process.argv);
  if (!owned) {
    const { runProgram: runProgramDirect } = await import("./cli-error.js");
    await runProgramDirect(createProgram(), process.argv);
  }
}
