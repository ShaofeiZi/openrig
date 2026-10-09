import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ExecFn } from "../adapters/tmux.js";
import type { ExternalInstallAction } from "./external-install-planner.js";

/** 带批准决策的已标记 action。 */
export interface TaggedAction {
  action: ExternalInstallAction;
  approved: boolean;
}

/** 执行单个 action 的结果。 */
export interface ExecutionResult {
  actionId: string;
  requirementName: string;
  status: "completed" | "failed" | "skipped";
  command: string | null;
  stdout: string | null;
  errorMessage: string | null;
  durationMs: number;
}

/** 所有已执行 action 的汇总。 */
export interface ExecutionSummary {
  results: ExecutionResult[];
  completed: ExecutionResult[];
  failed: ExecutionResult[];
  skipped: ExecutionResult[];
}

/**
 * 通过注入的 ExecFn 执行已批准的外部安装 action。
 * 把所有内容记录到 bootstrap_actions 表。
 * 失败时标记 failed 并继续下一项（不全局中止）。
 * 不自动回滚卸载。
 */
export class ExternalInstallExecutor {
  private exec: ExecFn;
  readonly db: Database.Database;

  constructor(deps: { exec: ExecFn; db: Database.Database }) {
    this.exec = deps.exec;
    this.db = deps.db;
  }

  /**
   * 执行已标记 action。所有 action（包括 skipped）都会记入 journal。
   * @param bootstrapId - 将 journal 条目关联到一次 bootstrap 运行
   * @param taggedActions - 带批准决策的完整 action 集合
   */
  async execute(bootstrapId: string, taggedActions: TaggedAction[], startSeq: number = 1): Promise<ExecutionSummary> {
    const results: ExecutionResult[] = [];

    for (let i = 0; i < taggedActions.length; i++) {
      const { action, approved } = taggedActions[i]!;
      const seq = startSeq + i;
      const actionId = ulid();

      // 跳过：未批准、manual_only（纵深防御）或没有命令。
      if (!approved || action.classification === "manual_only" || !action.commandPreview) {
        const result: ExecutionResult = {
          actionId,
          requirementName: action.requirementName,
          status: "skipped",
          command: action.commandPreview,
          stdout: null,
          errorMessage: null,
          durationMs: 0,
        };
        this.journal(actionId, bootstrapId, seq, action, "skipped", { stdout: null, errorMessage: null, durationMs: 0 });
        results.push(result);
        continue;
      }

      // 执行。
      const start = Date.now();
      try {
        const stdout = await this.exec(action.commandPreview);
        const durationMs = Date.now() - start;
        const result: ExecutionResult = {
          actionId,
          requirementName: action.requirementName,
          status: "completed",
          command: action.commandPreview,
          stdout: stdout ?? null,
          errorMessage: null,
          durationMs,
        };
        this.journal(actionId, bootstrapId, seq, action, "completed", { stdout: stdout ?? null, errorMessage: null, durationMs });
        results.push(result);
      } catch (err) {
        const durationMs = Date.now() - start;
        const errorMessage = (err as Error).message ?? "unknown error";
        const result: ExecutionResult = {
          actionId,
          requirementName: action.requirementName,
          status: "failed",
          command: action.commandPreview,
          stdout: null,
          errorMessage,
          durationMs,
        };
        this.journal(actionId, bootstrapId, seq, action, "failed", { stdout: null, errorMessage, durationMs });
        results.push(result);
        // 继续下一项，不中止。
      }
    }

    return {
      results,
      completed: results.filter((r) => r.status === "completed"),
      failed: results.filter((r) => r.status === "failed"),
      skipped: results.filter((r) => r.status === "skipped"),
    };
  }

  private journal(
    id: string,
    bootstrapId: string,
    seq: number,
    action: ExternalInstallAction,
    status: string,
    detail: { stdout: string | null; errorMessage: string | null; durationMs: number },
  ): void {
    this.db.prepare(
      `INSERT INTO bootstrap_actions (id, bootstrap_id, seq, action_kind, subject_type, subject_name, provider, command_preview, status, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      bootstrapId,
      seq,
      "external_install",
      action.kind,
      action.requirementName,
      action.provider,
      action.commandPreview,
      status,
      JSON.stringify(detail),
    );
  }
}
