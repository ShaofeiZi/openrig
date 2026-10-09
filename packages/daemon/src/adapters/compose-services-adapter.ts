import type { ExecFn } from "./tmux.js";

// -- 结果类型 --

export type ComposeResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface ComposeServiceStatus {
  name: string;
  state: string;
  status: string;
  health: string | null;
}

export interface ComposeStatusResult {
  ok: boolean;
  services: ComposeServiceStatus[];
  error?: string;
}

export interface ComposeLogsResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** 使用单引号为字符串添加 shell 引号（POSIX 安全）。 */
function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function formatExecError(err: unknown): string {
  if (err instanceof Error) {
    const execErr = err as Error & { stdout?: unknown; stderr?: unknown };
    const stdout = typeof execErr.stdout === "string"
      ? execErr.stdout.trim()
      : "";
    const stderr = typeof execErr.stderr === "string"
      ? execErr.stderr.trim()
      : "";
    const details = [stdout, stderr].filter(Boolean).join("\n");
    if (details && !err.message.includes(details)) {
      return `${err.message}\n${details}`;
    }
    return err.message;
  }
  return String(err);
}

// -- 适配器 --

/**
 * Docker Compose 的 I/O 适配器。通过 shell 调用 `docker compose`。与 tmux.ts 一同位于
 * adapters/——这是基础设施 I/O，不是领域逻辑。
 */
export class ComposeServicesAdapter {
  private exec: ExecFn;

  constructor(exec: ExecFn) {
    this.exec = exec;
  }

  /** 使用 docker compose up -d 启动服务。就绪性由 services-readiness 处理，而非 --wait。 */
  async up(opts: {
    composeFile: string;
    projectName: string;
    profiles?: string[];
  }): Promise<ComposeResult> {
    const args = this.baseArgs(opts.composeFile, opts.projectName, opts.profiles);
    const cmd = `docker compose ${args} up -d 2>&1`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "compose_up_failed", message: formatExecError(err) };
    }
  }

  /** 根据 down 策略停止服务。 */
  async down(opts: {
    composeFile: string;
    projectName: string;
    profiles?: string[];
    policy: "leave_running" | "down" | "down_and_volumes";
  }): Promise<ComposeResult> {
    if (opts.policy === "leave_running") {
      return { ok: true }; // 有意为空操作。
    }

    const args = this.baseArgs(opts.composeFile, opts.projectName, opts.profiles);
    const volumeFlag = opts.policy === "down_and_volumes" ? " --volumes" : "";
    const cmd = `docker compose ${args} down${volumeFlag} 2>&1`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "compose_down_failed", message: formatExecError(err) };
    }
  }

  /** 通过 docker compose ps --format json 获取服务状态。 */
  async status(opts: {
    composeFile: string;
    projectName: string;
    profiles?: string[];
  }): Promise<ComposeStatusResult> {
    const args = this.baseArgs(opts.composeFile, opts.projectName, opts.profiles);
    const cmd = `docker compose ${args} ps --format json 2>&1`;
    try {
      const output = await this.exec(cmd);
      const parseInput = this.extractComposePsPayload(output);
      const services = this.parseComposePs(parseInput);
      if (parseInput !== "" && services.length === 0) {
        return { ok: false, services: [], error: "docker compose ps 返回了无法解析的 JSON 输出" };
      }
      return { ok: true, services };
    } catch (err) {
      return { ok: false, services: [], error: formatExecError(err) };
    }
  }

  /** 获取指定服务或全部服务的日志。 */
  async logs(opts: {
    composeFile: string;
    projectName: string;
    profiles?: string[];
    service?: string;
    tail?: number;
  }): Promise<ComposeLogsResult> {
    const args = this.baseArgs(opts.composeFile, opts.projectName, opts.profiles);
    const serviceArg = opts.service ? ` ${sq(opts.service)}` : "";
    const tailArg = opts.tail ? ` --tail ${opts.tail}` : "";
    const cmd = `docker compose ${args} logs${tailArg}${serviceArg} 2>&1`;
    try {
      const output = await this.exec(cmd);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: "", error: formatExecError(err) };
    }
  }

  /** 运行 checkpoint 导出命令。 */
  async runCheckpointExport(command: string): Promise<ComposeResult> {
    try {
      await this.exec(command);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "checkpoint_export_failed", message: formatExecError(err) };
    }
  }

  /** 运行 checkpoint 导入命令。 */
  async runCheckpointImport(command: string): Promise<ComposeResult> {
    try {
      await this.exec(command);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "checkpoint_import_failed", message: formatExecError(err) };
    }
  }

  /** 探测 HTTP 等待目标。URL 返回 2xx 时为 true。 */
  async probeHttp(url: string, timeoutMs: number = 5000): Promise<boolean> {
    try {
      const cmd = `curl -sf -o /dev/null -w '%{http_code}' --max-time ${Math.ceil(timeoutMs / 1000)} ${sq(url)} 2>/dev/null`;
      const output = await this.exec(cmd);
      const code = parseInt(output.trim(), 10);
      return code >= 200 && code < 400;
    } catch {
      return false;
    }
  }

  /** 探测 TCP 等待目标。端口开放时为 true。 */
  async probeTcp(target: string, timeoutMs: number = 5000): Promise<boolean> {
    try {
      const [host, portStr] = target.split(":");
      if (!host || !portStr) return false;
      const cmd = `nc -z -w ${Math.ceil(timeoutMs / 1000)} ${sq(host)} ${sq(portStr)} 2>/dev/null`;
      await this.exec(cmd);
      return true;
    } catch {
      return false;
    }
  }

  // -- 私有辅助函数 --

  private baseArgs(composeFile: string, projectName: string, profiles?: string[]): string {
    const parts = [`-f ${sq(composeFile)}`, `-p ${sq(projectName)}`];
    if (profiles && profiles.length > 0) {
      for (const p of profiles) {
        parts.push(`--profile ${sq(p)}`);
      }
    }
    return parts.join(" ");
  }

  private extractComposePsPayload(output: string): string {
    const trimmed = output.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

    const jsonLines = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") || line.startsWith("["));

    return jsonLines.join("\n");
  }

  /** 解析 docker compose ps --format json；同时支持逐行单对象和 JSON 数组格式。 */
  private parseComposePs(output: string): ComposeServiceStatus[] {
    const trimmed = output.trim();
    if (!trimmed) return [];

    // 先尝试 JSON 数组。
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
        return arr.map((obj) => this.mapServiceStatus(obj));
      } catch { /* 回退到逐行解析。 */ }
    }

    // 每行一个 JSON 对象。
    const results: ComposeServiceStatus[] = [];
    for (const line of trimmed.split("\n")) {
      const l = line.trim();
      if (!l || !l.startsWith("{")) continue;
      try {
        const obj = JSON.parse(l) as Record<string, unknown>;
        results.push(this.mapServiceStatus(obj));
      } catch { /* 跳过格式错误的行。 */ }
    }
    return results;
  }

  private mapServiceStatus(obj: Record<string, unknown>): ComposeServiceStatus {
    return {
      name: String(obj["Service"] ?? obj["Name"] ?? ""),
      state: String(obj["State"] ?? ""),
      status: String(obj["Status"] ?? ""),
      health: typeof obj["Health"] === "string" ? obj["Health"] : null,
    };
  }
}
