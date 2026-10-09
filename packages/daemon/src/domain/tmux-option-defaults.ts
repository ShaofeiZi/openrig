import { spawnSync } from "node:child_process";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { runSyncSite } from "./sync-site-wrap.js";

export interface TmuxOptionDefaultsDeps {
  tmuxAdapter: TmuxAdapter;
  /**
   * OPR.0.4.6.02 S1——在应用时读取后台服务的 tmux 选项默认值。每次调用都从启动阶段的
   * SettingsStore 重新解析，使操作员切换 `terminal.status_bar` 时只影响未来启动。
   * 省略时默认为 `statusBar: false`（隐藏状态栏）。
   */
  readTmuxOptionDefaults?: () => { statusBar: boolean };
  /**
   * OPR.0.4.6.02 S1——服务端范围 `copy-command` 表的平台选择器。默认为
   * `process.platform`，可在范围测试中注入。
   */
  platform?: NodeJS.Platform;
  /**
   * OPR.0.4.6.02 S1——Linux copy-command 回退链使用的轻量 `command -v <bin>` 探测。
   * 默认为真实 shell 探测，可在确定性测试中注入。
   */
  hasCommand?: (bin: string) => boolean;
}

/**
 * OPR.0.4.6.02 S1——把后台服务的 tmux 选项默认值应用到新建会话。
 * `NodeLauncher`（启动路径）与 `SuccessorSessionLauncher`（全新席位移交后继路径）共享此逻辑，
 * 使每个新操作员/智能体席位获得一致的 mouse/status/clipboard 默认值
 *（orch C1 范围裁定：通过同一个辅助函数纳入全新后继）。
 *
 * 范围纪律（guard b2）：会话范围选项（`mouse`、`status`）只应用到传入的刚创建会话名，
 * 绝不作用于既有/发现的会话，从而守住“不追溯翻转”规则（BR-1），让
 * `terminal.status_bar` 变更只影响未来启动。服务端范围选项（`set-clipboard`、
 * `copy-command`）通过此单例上的共享记忆，在每次后台服务生命周期中只断言一次；
 * 后台服务重启后会由新的应用器重新断言。调用方必须仅在新会话成功执行
 * `createSession` 后调用此函数。
 */
export class TmuxOptionDefaultsApplier {
  private tmuxAdapter: TmuxAdapter;
  private readTmuxOptionDefaults: () => { statusBar: boolean };
  private platform: NodeJS.Platform;
  private hasCommand: (bin: string) => boolean;
  private serverDefaultsAsserted = false;

  constructor(deps: TmuxOptionDefaultsDeps) {
    this.tmuxAdapter = deps.tmuxAdapter;
    this.readTmuxOptionDefaults = deps.readTmuxOptionDefaults ?? (() => ({ statusBar: false }));
    this.platform = deps.platform ?? process.platform;
    this.hasCommand = deps.hasCommand ?? defaultHasCommand;
  }

  /**
   * 把选项默认值应用到刚创建的会话。`mouse` 始终开启；内部状态栏跟随
   * `terminal.status_bar` 配置键（默认关闭），并在应用时读取，因此切换只影响未来启动
   *（只触碰 `sessionName`）。随后在每次后台服务生命周期中断言一次服务端范围默认值。
   *
   * 返回非致命警告列表；全部设置成功时为空，调用方可将其并入自身启动警告通道。
   * 选项设置失败绝不抛错——没有鼠标滚动的席位只是降级而非失效，移交后继也不能因
   * 外观选项失败而让移交整体失败。
   */
  async applyToFreshSession(sessionName: string): Promise<string[]> {
    const warnings: string[] = [];

    const mouse = await this.tmuxAdapter.setSessionOption(sessionName, "mouse", "on");
    if (!mouse.ok) {
      warnings.push(`未能为 ${sessionName} 设置 tmux "mouse" 选项：${mouse.message}`);
    }

    let statusBar = false;
    try {
      statusBar = this.readTmuxOptionDefaults().statusBar === true;
    } catch {
      statusBar = false;
    }
    const status = await this.tmuxAdapter.setSessionOption(sessionName, "status", statusBar ? "on" : "off");
    if (!status.ok) {
      warnings.push(`未能为 ${sessionName} 设置 tmux "status" 选项：${status.message}`);
    }

    await this.ensureServerDefaults(warnings);
    return warnings;
  }

  /**
   * 在后台服务自己的 tmux server 上断言服务端范围默认值（`set-clipboard on` +
   * 各平台 `copy-command`），每次后台服务生命周期只执行一次。仅通过
   * `setServerOption`（`set-option -s`）写入，绝不使用 `-t` 会话目标
   *（guard b2 范围契约）。
   *
   * 逐进程记忆意味着后台服务重启时会由新应用器重新断言：操作员手动覆盖的
   * `copy-command` / `set-clipboard` 不会跨重启保留，具名关闭开关的后续实现才是
   * 定制路径。重复执行不会造成问题（幂等设置相同值）；该记忆只是优化，不是正确性门禁。
   */
  private async ensureServerDefaults(warnings: string[]): Promise<void> {
    if (this.serverDefaultsAsserted) return;
    // 先置位，避免并发 apply 重复断言；即使重复，设置本身也是幂等的。
    this.serverDefaultsAsserted = true;

    const clip = await this.tmuxAdapter.setServerOption("set-clipboard", "on");
    if (!clip.ok) {
      warnings.push(`未能设置 tmux server 选项 "set-clipboard"：${clip.message}`);
    }

    const copyCommand = resolveCopyCommand(this.platform, this.hasCommand);
    if (copyCommand !== null) {
      const cc = await this.tmuxAdapter.setServerOption("copy-command", copyCommand);
      if (!cc.ok) {
        warnings.push(`未能设置 tmux server 选项 "copy-command"：${cc.message}`);
      }
    }
  }
}

/**
 * OPR.0.4.6.02 S1——各平台 tmux `copy-command` 表（架构轨 b）。参考 tmux
 * “Clipboard” wiki：`copy-command` 是 tmux 将复制模式选区通过管道传给系统剪贴板的
 * shell 命令。
 *  - darwin → `pbcopy`
 *  - linux  → 存在 `wl-copy` 时使用它，否则用 `xclip -selection clipboard -i`；
 *             都不存在则不设置（null），回退到 `set-clipboard on` OSC 52。
 *  - 其他平台 → 不设置（null）。
 * 纯逻辑：输入 platform 与 `command -v` 探测，输出命令字符串或 null。单一表、无副作用，
 * 是否写入由应用器决定。
 */
export function resolveCopyCommand(
  platform: NodeJS.Platform,
  hasCommand: (bin: string) => boolean,
): string | null {
  if (platform === "darwin") return "pbcopy";
  if (platform === "linux") {
    if (hasCommand("wl-copy")) return "wl-copy";
    if (hasCommand("xclip")) return "xclip -selection clipboard -i";
    return null;
  }
  return null;
}

/**
 * OPR.0.4.6.02 S1——默认的 `command -v <bin>` 探测（POSIX shell 内建命令）。
 * 二进制可从 PATH 解析时返回 true。该探测轻量且尽力而为；任何失败
 *（spawn 错误、非 shell 环境）都视为不存在。
 */
function defaultHasCommand(bin: string): boolean {
  try {
    const r = runSyncSite("tmux_options.command_v", () =>
      spawnSync(`command -v ${bin}`, { shell: true, stdio: "ignore" })
    );
    return r.status === 0;
  } catch {
    return false;
  }
}
