import type { TmuxAdapter } from "../adapters/tmux.js";

/** 扫描期间观测到的单个 pane。 */
export interface ScannedPane {
  tmuxSession: string;
  tmuxWindow: string;
  tmuxPane: string;
  pid: number | null;
  cwd: string | null;
  activeCommand: string | null;
}

/** 完整 tmux 扫描的结果。 */
export interface ScanResult {
  panes: ScannedPane[];
  scannedAt: string;
}

/**
 * 枚举全部 tmux 会话、window 与 pane，并解析每个 pane 的 PID、cwd 和活动前台命令。
 * 通过 TmuxAdapter 执行，领域代码中不出现原始 tmux CLI 字符串。
 */
export class TmuxDiscoveryScanner {
  private tmux: TmuxAdapter;

  constructor(deps: { tmuxAdapter: TmuxAdapter }) {
    this.tmux = deps.tmuxAdapter;
  }

  /** 扫描全部 tmux pane 并解析 metadata。 */
  async scan(): Promise<ScanResult> {
    const panes: ScannedPane[] = [];
    const scannedAt = new Date().toISOString();

    const sessions = await this.tmux.listSessions();

    for (const session of sessions) {
      const windows = await this.tmux.listWindows(session.name);

      for (const window of windows) {
        const target = `${session.name}:${window.index}`;
        const tmuxPanes = await this.tmux.listPanes(target);

        for (const pane of tmuxPanes) {
          let pid: number | null = null;
          let activeCommand: string | null = null;

          try {
            pid = await this.tmux.getPanePid(pane.id);
          } catch {
            // pane metadata 查询失败，保留 null 后继续。
          }

          try {
            activeCommand = await this.tmux.getPaneCommand(pane.id);
          } catch {
            // pane metadata 查询失败，保留 null 后继续。
          }

          panes.push({
            tmuxSession: session.name,
            tmuxWindow: `${window.index}`,
            tmuxPane: pane.id,
            pid,
            cwd: pane.cwd || null,
            activeCommand,
          });
        }
      }
    }

    return { panes, scannedAt };
  }
}
