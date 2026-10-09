/**
 * Test-A 预检阻断项 3，第 6/7 轮——`run-evals.mjs --provider rig` 背后的实时 runner
 * 接线。review-r2 第 6 轮 HIGH-1：当前代记录读取器必须接入随附入口，不能只在测试中注入，
 * 否则 runner 会在第一条 Test-A 提示前拒绝。本模块从 run-evals.mjs 中提取 runner 的
 * rig-provider 构造，使公开接缝——读取器注入 + 单次自然发送 + 当前代后缀捕获——由单元测试固定。
 *
 * 边界是席位当前代、仅追加的 Claude 对话记录（desk 裁定选项 B）。通过
 * ContextUsageStore.readAndNormalize，从席位的状态行 sidecar 权威解析代身份与仅追加 JSONL
 * 路径（与后台服务读取同一记录）；代已滚动或记录缺失时明确拒绝（滚动/前缀触发线位于
 * 会话辅助模块）。
 */

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { ContextUsageStore } from "../../src/domain/context-usage-store.js";
import { createRigCliSession, type RigExec } from "./eval-rig-session.js";
import type { RigSeatSession } from "./eval-rig-provider.js";

export interface GenerationRecord { generationId: string; content: string }
export type GenerationRecordReader = (seat: string) => Promise<GenerationRecord>;

export interface RunnerReaderDeps {
  /** OpenRig 状态目录（默认：$OPENRIG_HOME）；sidecar 位于 <stateDir>/context/<seat>.json。 */
  stateDir?: string;
  /** 读取转录文件（默认：fs.readFileSync utf-8）——可为入口判别项注入。 */
  readFile?: (path: string) => string;
}

/**
 * 实时 runner 的权威当前代记录读取器。从状态行 sidecar 解析席位当前 Claude 对话记录
 *（ContextUsageStore.readAndNormalize：sessionId 是代身份，transcriptPath 是仅追加 JSONL），
 * 随后读取该 JSONL。无法解析当前代记录（Codex 席位、未预热席位或 sidecar 缺失）时明确
 * 拒绝——绝不静默降级，也绝不回退到有界 pane。读取路径基于 stateDir 文件；读取不使用
 * 数据库，因此一次性内存句柄即可满足构造器，无需存活的后台服务数据库。
 */
export function defaultRunnerGenerationReader(deps: RunnerReaderDeps = {}): GenerationRecordReader {
  const stateDir = deps.stateDir ?? process.env.OPENRIG_HOME;
  if (!stateDir) {
    return async () => {
      throw new Error("run-evals --provider rig: OPENRIG_HOME is unset — cannot resolve the seat's current-generation conversation record");
    };
  }
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const store = new ContextUsageStore(new Database(":memory:"), { stateDir });
  return async (seat: string): Promise<GenerationRecord> => {
    const usage = store.readAndNormalize(seat);
    if (!usage.sessionId || !usage.transcriptPath) {
      throw new Error(
        `run-evals --provider rig: seat '${seat}' has no current-generation Claude conversation record ` +
          `(sidecar sessionId/transcriptPath unresolved) — observation refused. Round-6 Option B requires an ` +
          `append-only generation JSONL; a Codex seat or an unprimed seat is unsupported.`,
      );
    }
    let content: string;
    try {
      content = readFile(usage.transcriptPath);
    } catch (err) {
      throw new Error(`run-evals --provider rig: cannot read the current-generation transcript for '${seat}' at ${usage.transcriptPath}: ${(err as Error).message}`);
    }
    return { generationId: usage.sessionId, content };
  };
}

/**
 * 构建 runner 驱动的持久 RigSeatSession：连接一次（--seat）或生成一次（--seat-spec），
 * 将带外边界绑定到当前代记录读取器（默认使用真实实现；入口判别项可注入）。这是 r2
 * HIGH-1 要求接线的公开 runner 接缝。
 */
export function buildRigProviderSession(opts: {
  seat?: string | null;
  spec?: string | null;
  exec?: RigExec;
  readGenerationRecord?: GenerationRecordReader;
  stateDir?: string;
  readFile?: (path: string) => string;
  /** 会话计时透传（生产环境使用默认值；测试中缩短时间）。 */
  session?: { pollMs?: number; stablePolls?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> };
}): { spawn: () => Promise<RigSeatSession> } {
  const readGenerationRecord = opts.readGenerationRecord ?? defaultRunnerGenerationReader({ stateDir: opts.stateDir, readFile: opts.readFile });
  const base = opts.seat != null ? { seat: opts.seat } : { spec: opts.spec! };
  return createRigCliSession({
    ...base,
    ...(opts.exec ? { exec: opts.exec } : {}),
    ...(opts.session ?? {}),
    readGenerationRecord,
  });
}
