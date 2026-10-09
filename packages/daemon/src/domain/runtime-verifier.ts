import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ExecFn } from "../adapters/tmux.js";
import type { RuntimeVerification, RuntimeStatus } from "./bootstrap-types.js";

interface RuntimeVerifierDeps {
  exec: ExecFn;
  db: Database.Database;
}

// OPR.0.4.6.PI1——Pi 文档声明的 Node 引擎最低版本（package.json engines）。
export const PI_NODE_ENGINE_FLOOR = "22.19.0";

export function meetsPiNodeEngineFloor(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".").map((p) => parseInt(p, 10));
  const floor = PI_NODE_ENGINE_FLOOR.split(".").map((p) => parseInt(p, 10));
  for (let i = 0; i < floor.length; i++) {
    const have = parts[i] ?? 0;
    const need = floor[i]!;
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

/**
 * 验证运行时确实可用，而不只是存在于 PATH。结果自动持久化到
 * runtime_verifications 表。
 */
export class RuntimeVerifier {
  readonly db: Database.Database;
  private exec: ExecFn;

  constructor(deps: RuntimeVerifierDeps) {
    this.db = deps.db;
    this.exec = deps.exec;
  }

  /** 验证 tmux：执行 `tmux -V` 并从输出解析版本。 */
  async verifyTmux(): Promise<RuntimeVerification> {
    const result = await this.runProbe("tmux", async () => {
      const output = await this.exec("tmux -V");
      const version = this.parseVersion(output);
      if (!version) {
        return { status: "error" as RuntimeStatus, version: null, capabilitiesJson: null, error: "unparseable version output" };
      }
      return { status: "verified" as RuntimeStatus, version, capabilitiesJson: null, error: null };
    });
    this.persist(result);
    return result;
  }

  /** 验证 cmux：执行 `cmux capabilities --json` 并解析能力。 */
  async verifyCmux(): Promise<RuntimeVerification> {
    const result = await this.runProbe("cmux", async () => {
      const output = await this.exec("cmux capabilities --json");
      const trimmed = output.trim();
      try {
        const parsed = JSON.parse(trimmed);
        const capsJson = JSON.stringify(parsed);
        return { status: "verified" as RuntimeStatus, version: null, capabilitiesJson: capsJson, error: null };
      } catch {
        return { status: "error" as RuntimeStatus, version: null, capabilitiesJson: null, error: "capabilities JSON 无效" };
      }
    }, "degraded");
    this.persist(result);
    return result;
  }

  /** 验证 Claude Code：执行 `claude --version`，失败时回退到 `claude --help`。 */
  async verifyClaude(): Promise<RuntimeVerification> {
    const result = await this.verifyVersionOrHelp("claude", "claude-code");
    this.persist(result);
    return result;
  }

  /** 验证 Codex：执行 `codex --version`，失败时回退到 `codex --help`。 */
  async verifyCodex(): Promise<RuntimeVerification> {
    const result = await this.verifyVersionOrHelp("codex", "codex");
    this.persist(result);
    return result;
  }

  /** OPR.0.4.6.PI1 FR-1——验证 Pi：执行 `pi --version`（回退为 `pi --help`），
   *  并检查 Pi 要求的 Node 引擎最低版本（>= 22.19.0）。provider/model
   *  可解析性属于成员作用域，在启动时校验，不在此处理。 */
  async verifyPi(): Promise<RuntimeVerification> {
    let result = await this.verifyVersionOrHelp("pi", "pi");
    if (result.status === "verified") {
      try {
        const nodeVersion = this.parseVersion(await this.exec("node --version"));
        if (nodeVersion && !meetsPiNodeEngineFloor(nodeVersion)) {
          result = this.buildVerification(
            "pi",
            "error",
            result.version,
            null,
            `Pi 要求 Node >= ${PI_NODE_ENGINE_FLOOR}；当前为 ${nodeVersion}。请升级 Node 后再运行 Pi 席位。`,
          );
        }
      } catch {
        // 后台服务执行上下文无法解析 `node`——保留二进制验证结果；启动时会再次检查引擎下限。
      }
    }
    this.persist(result);
    return result;
  }

  /**
   * 验证多个运行时，按输入顺序返回结果。
   * @param runtimes - 权威运行时名称：'tmux'、'cmux'、'claude-code'、'codex'、'pi'
   */
  async verifyAll(runtimes: string[]): Promise<RuntimeVerification[]> {
    const results: RuntimeVerification[] = [];
    for (const runtime of runtimes) {
      switch (runtime) {
        case "tmux": results.push(await this.verifyTmux()); break;
        case "cmux": results.push(await this.verifyCmux()); break;
        case "claude-code": results.push(await this.verifyClaude()); break;
        case "codex": results.push(await this.verifyCodex()); break;
        case "pi": results.push(await this.verifyPi()); break;
        default: {
          const v = this.buildVerification(runtime, "not_found", null, null, `未知运行时：${runtime}`);
          this.persist(v);
          results.push(v);
        }
      }
    }
    return results;
  }

  /**
   * 共享辅助函数：先尝试 `{binary} --version`，再回退到 `{binary} --help`。
   * 由 verifyClaude 与 verifyCodex 共用。
   */
  private async verifyVersionOrHelp(binary: string, canonicalName: string): Promise<RuntimeVerification> {
    // 先尝试 --version。
    try {
      const output = await this.exec(`${binary} --version`);
      const version = this.parseVersion(output);
      return this.buildVerification(canonicalName, "verified", version ?? null, null, null);
    } catch {
      // 回退到 --help。
      try {
        await this.exec(`${binary} --help`);
        return this.buildVerification(canonicalName, "verified", null, null, null);
      } catch {
        return this.buildVerification(canonicalName, "not_found", null, null, `未找到 ${binary}`);
      }
    }
  }

  /**
   * 运行探针并处理错误。执行失败时返回 failStatus（默认 not_found）。
   */
  private async runProbe(
    runtime: string,
    fn: () => Promise<{ status: RuntimeStatus; version: string | null; capabilitiesJson: string | null; error: string | null }>,
    failStatus: RuntimeStatus = "not_found",
  ): Promise<RuntimeVerification> {
    try {
      const { status, version, capabilitiesJson, error } = await fn();
      return this.buildVerification(runtime, status, version, capabilitiesJson, error);
    } catch (err) {
      return this.buildVerification(runtime, failStatus, null, null, (err as Error).message);
    }
  }

  private buildVerification(
    runtime: string,
    status: RuntimeStatus,
    version: string | null,
    capabilitiesJson: string | null,
    error: string | null,
  ): RuntimeVerification {
    return {
      id: ulid(),
      runtime,
      version,
      capabilitiesJson,
      verifiedAt: new Date().toISOString(),
      status,
      error,
    };
  }

  /** 从输出解析类似 semver 的版本，例如 "tmux 3.4" -> "3.4"。 */
  private parseVersion(output: string): string | undefined {
    const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[a-z])?)/);
    return match?.[1];
  }

  /** 将验证结果持久化到 runtime_verifications 表，按运行时名称 upsert。 */
  private persist(v: RuntimeVerification): void {
    const existing = this.db
      .prepare("SELECT id FROM runtime_verifications WHERE runtime = ?")
      .get(v.runtime) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(
        "UPDATE runtime_verifications SET version = ?, capabilities_json = ?, verified_at = ?, status = ?, error = ? WHERE runtime = ?"
      ).run(v.version, v.capabilitiesJson, v.verifiedAt, v.status, v.error, v.runtime);
      v.id = existing.id;
    } else {
      this.db.prepare(
        "INSERT INTO runtime_verifications (id, runtime, version, capabilities_json, verified_at, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(v.id, v.runtime, v.version, v.capabilitiesJson, v.verifiedAt, v.status, v.error);
    }
  }
}
