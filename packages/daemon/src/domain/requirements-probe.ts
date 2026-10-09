import type { ExecFn } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** 探测结果状态，与 Phase 5 spec 一致。 */
export type ProbeStatus = "installed" | "missing" | "unsupported" | "unknown";

/** 单项待探测 requirement 的输入规范。 */
export interface RequirementSpec {
  name: string;
  kind: "cli_tool" | "system_package";
  installHints?: Record<string, string>;
}

/** 单项 requirement 的探测结果。 */
export interface ProbeResult {
  name: string;
  kind: "cli_tool" | "system_package";
  status: ProbeStatus;
  /** provider 报告的版本字符串（例如 brew）；cli_tool 探测时为 null。 */
  version: string | null;
  /** `command -v` 解析出的 binary 路径；非 CLI 探测或工具缺失时为 null。 */
  detectedPath: string | null;
  /** 探测使用的 provider（例如 'homebrew'）；通用 CLI 探测时为 null。 */
  provider: string | null;
  /** 实际执行的精确命令；未执行探测（unsupported）时为 null。 */
  command: string | null;
  /** manifest 中的安装提示，只用于展示，绝不执行。 */
  installHints: Record<string, string> | null;
  /** 探测失败或超时时的错误消息。 */
  error: string | null;
}

interface ProbeOptions {
  timeoutMs?: number;
  platform?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 由 provider 支撑的 CLI 工具与系统 package 探测 registry。使用注入的 ExecFn，测试中不执行
 * 真实 shell。
 */
export class RequirementsProbeRegistry {
  private exec: ExecFn;
  private timeoutMs: number;
  private platform: string;

  constructor(exec: ExecFn, opts?: ProbeOptions) {
    this.exec = exec;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.platform = opts?.platform ?? process.platform;
  }

  /**
   * 通过 `command -v` 探测 CLI 工具。解析出的 binary 路径写入 detectedPath，version 保持 null。
   */
  async probeCli(name: string): Promise<ProbeResult> {
    const cmd = `command -v ${shellQuote(name)}`;
    try {
      const stdout = await this.execWithTimeout(cmd);
      const detectedPath = stdout.trim() || null;
      return {
        name,
        kind: "cli_tool",
        status: detectedPath ? "installed" : "missing",
        version: null,
        detectedPath,
        provider: null,
        command: cmd,
        installHints: null,
        error: null,
      };
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("timed out")) {
        return {
          name, kind: "cli_tool", status: "unknown", version: null,
          detectedPath: null, provider: null, command: cmd,
          installHints: null, error: "探测超时",
        };
      }
      // 只有 "not found" / exit-code 错误才视为确实缺失。EACCES 等其他错误属于 unknown，
      // 不得变成 auto_approvable。
      if (msg.includes("not found") || msg.includes("No such") || msg.includes("exit code")) {
        return {
          name, kind: "cli_tool", status: "missing", version: null,
          detectedPath: null, provider: null, command: cmd,
          installHints: null, error: null,
        };
      }
      return {
        name, kind: "cli_tool", status: "unknown", version: null,
        detectedPath: null, provider: null, command: cmd,
        installHints: null, error: msg,
      };
    }
  }

  /**
   * 通过 Homebrew（`brew list --versions`）探测系统 package，并在输出可用时解析版本。
   */
  async probeBrew(name: string): Promise<ProbeResult> {
    const cmd = `brew list --versions ${shellQuote(name)}`;
    try {
      const stdout = await this.execWithTimeout(cmd);
      const trimmed = stdout.trim();
      // brew list --versions 输出 "name 1.2.3" 或 "name 1.2.3 1.2.4"。
      const parts = trimmed.split(/\s+/);
      const version = parts.length > 1 ? parts[parts.length - 1]! : null;
      return {
        name,
        kind: "system_package",
        status: "installed",
        version,
        detectedPath: null,
        provider: "homebrew",
        command: cmd,
        installHints: null,
        error: null,
      };
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("timed out")) {
        return {
          name, kind: "system_package", status: "unknown", version: null,
          detectedPath: null, provider: "homebrew", command: cmd,
          installHints: null, error: "探测超时",
        };
      }
      if (msg.includes("No such keg") || msg.includes("not found") || msg.includes("exit code")) {
        return {
          name, kind: "system_package", status: "missing", version: null,
          detectedPath: null, provider: "homebrew", command: cmd,
          installHints: null, error: null,
        };
      }
      return {
        name, kind: "system_package", status: "unknown", version: null,
        detectedPath: null, provider: "homebrew", command: cmd,
        installHints: null, error: msg,
      };
    }
  }

  /**
   * 探测单项 requirement，路由到合适的 provider，并把 spec 中的 installHints 保留到结果中。
   */
  async probeRequirement(spec: RequirementSpec): Promise<ProbeResult> {
    let result: ProbeResult;

    if (spec.kind === "cli_tool") {
      result = await this.probeCli(spec.name);
    } else if (spec.kind === "system_package") {
      if (this.platform !== "darwin") {
        result = {
          name: spec.name,
          kind: "system_package",
          status: "unsupported",
          version: null,
          detectedPath: null,
          provider: null,
          command: null,
          installHints: null,
          error: null,
        };
      } else {
        result = await this.probeBrew(spec.name);
      }
    } else {
      result = {
        name: spec.name,
        kind: spec.kind,
        status: "unsupported",
        version: null,
        detectedPath: null,
        provider: null,
        command: null,
        installHints: null,
        error: null,
      };
    }

    // 保留 spec 中的 installHints，只展示，绝不执行。
    if (spec.installHints) {
      result.installHints = spec.installHints;
    }

    return result;
  }

  /**
   * 依次探测所有 requirement，并按输入顺序返回结果。
   */
  async probeAll(specs: RequirementSpec[]): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    for (const spec of specs) {
      results.push(await this.probeRequirement(spec));
    }
    return results;
  }

  private async execWithTimeout(cmd: string): Promise<string> {
    return Promise.race([
      this.exec(cmd),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("探测超时")), this.timeoutMs)
      ),
    ]);
  }
}
