export interface TmuxProbeResult {
  installed: boolean;
  available: boolean;
  version: string | null;
  detail: string | null;
  code: "available" | "no_server" | "not_installed" | "unhealthy";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isTmuxNoServerMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("no server running")
    || normalized.includes("failed to connect to server")
    || (normalized.includes("error connecting to") && normalized.includes("no such file or directory"));
}

export function buildTmuxControlFailure(message: string): { message: string; reason: string; fix: string } {
  return {
    message: "tmux 已安装，但默认控制套接字不健康。",
    reason: `zrig 使用 tmux 控制命令来启动、查看和管理智能体会话。默认 tmux 套接字当前返回：${message}`,
    fix: "先从可见的 tmux 窗格中保存好所需状态，再重启默认 tmux 服务后重试 zrig。若这是在机器恢复后出现的，应将其视为“待关注”，而非健康运行状态。",
  };
}

export function probeTmuxControl(exec: (cmd: string) => string): TmuxProbeResult {
  let version: string;
  try {
    version = exec("tmux -V").trim();
  } catch (err) {
    return {
      installed: false,
      available: false,
      version: null,
      detail: errorMessage(err),
      code: "not_installed",
    };
  }

  try {
    exec("tmux list-sessions");
    return {
      installed: true,
      available: true,
      version,
      detail: null,
      code: "available",
    };
  } catch (err) {
    const detail = errorMessage(err).trim();
    if (isTmuxNoServerMessage(detail)) {
      return {
        installed: true,
        available: true,
        version,
        detail,
        code: "no_server",
      };
    }
    return {
      installed: true,
      available: false,
      version,
      detail,
      code: "unhealthy",
    };
  }
}

export async function probeTmuxControlAsync(exec: (cmd: string) => Promise<string>): Promise<TmuxProbeResult> {
  let version: string;
  try {
    version = (await exec("tmux -V")).trim();
  } catch (err) {
    return {
      installed: false,
      available: false,
      version: null,
      detail: errorMessage(err),
      code: "not_installed",
    };
  }

  try {
    await exec("tmux list-sessions");
    return {
      installed: true,
      available: true,
      version,
      detail: null,
      code: "available",
    };
  } catch (err) {
    const detail = errorMessage(err).trim();
    if (isTmuxNoServerMessage(detail)) {
      return {
        installed: true,
        available: true,
        version,
        detail,
        code: "no_server",
      };
    }
    return {
      installed: true,
      available: false,
      version,
      detail,
      code: "unhealthy",
    };
  }
}
