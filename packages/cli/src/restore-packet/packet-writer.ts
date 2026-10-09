// packet-writer.ts — 组装 + 原子写入 v0 恢复包目录。
//
// 根据 M1 契约 § 1：发出 4 个必需文件（restore-instructions.md、
// transcript-latest.md、touched-files.md、restore-summary.json）加上
// 可选的 transcript.md（当完整转录材料可用时；与
// `full_transcript` 摘要键同步存在）。
//
// 通过临时目录后重命名实现原子发出：
// 1. 将所有文件写入同级临时目录（`<targetDir>.tmp-<rand>/`）。
// 2. 根据嵌入的 JSON Schema 验证临时目录的 restore-summary.json
//    （来自 schema-validator.ts 的 RESTORE_SUMMARY_SCHEMA）。
// 3. 如果有效：重命名临时目录 → targetDir（单次 fs.rename；
//    同一文件系统上原子）。
// 4. 如果验证失败或任何写入步骤失败：rmSync 临时目录；
//    传播错误。此情况下绝不创建 targetDir。
//
// 前置条件：targetDir 必须不存在（操作者必须提供新路径）。
// 否则以明确错误拒绝。

import { mkdirSync, writeFileSync, existsSync, renameSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import {
  validateRestoreSummary,
  type ValidationResult,
} from "./schema-validator.js";
import type { StructuredTranscript, SourceRuntime } from "./types.js";

const TRANSCRIPT_BOUND = 120;

export interface WritePacketOptions {
  /** 目标包目录的绝对路径。必须不存在。 */
  targetDir: string;
  /** 已解析的源结构化表示。 */
  structured: StructuredTranscript;
  /** 源席位的运行时类型。 */
  sourceRuntime: SourceRuntime;
  /** 目标工作组名（操作者提供）。 */
  targetRig: string;
  /** 目标运行时类型（操作者提供）。 */
  targetRuntime: SourceRuntime;
  /** 目标工作区根（绝对路径）。 */
  targetWorkspaceRoot: string;
  /** 默认目标仓库（绝对路径或 null）。 */
  defaultTargetRepo: string | null;
  /** 指向恢复席位角色指导的路径/URI。 */
  rolePointer: string;
  /** 当前工作的一段人类可读摘要。 */
  currentWorkSummary: string;
  /** 恢复席位下一步移交给谁；继续时为 "self"。 */
  nextOwner: string;
  /** 注意事项列表（跨运行时特性、脱敏说明等）。 */
  caveats: string[];
  /** 恢复席位权限的明确声明。 */
  authorityBoundaries: string;
  /** 有序的源信任排名（契约枚举的子集）。 */
  sourceTrustRanking: string[];
  /** 源会话 id。 */
  sourceSessionId: string;
  /**
   * 源工作组名。根据 M2c-CLI R2：由 CLI 适配器显式传入
   * （从解析的 session_meta `<seat>@<rig>` 拆分或操作者
   * --source-rig-override 计算）。写入器不从此派生
   * sourceSessionId——那个隐藏的派生就是 M2c-CLI R1 bug。
   */
  sourceRig: string;
  /** 源 cwd（绝对路径）。 */
  sourceCwd: string;
  /** 生成器版本标识符（例如 "rig-restore-packet@0.1.0"）。 */
  generatorVersion: string;
  /** 是否包含完整 transcript.md 文件。 */
  includeFullTranscript: boolean;
}

export interface WritePacketResult {
  targetDir: string;
  files: string[];
  summaryPath: string;
}

function transcriptMarkdownFromMessages(
  title: string,
  session: string,
  messages: StructuredTranscript["messages"],
  note: string,
): string {
  const body = messages
    .map((m, i) => {
      const ts = m.timestamp ? ` ${m.timestamp}` : "";
      return `## ${i + 1}. ${m.role}${ts}\n\n${m.text}\n`;
    })
    .join("\n");
  return `# ${title}\n\n源会话：\`${session}\`\n\n${note}\n\n${body}`;
}

function buildTranscriptLatest(
  structured: StructuredTranscript,
  sourceSessionId: string,
): string {
  const latest = structured.messages.slice(-TRANSCRIPT_BOUND);
  return transcriptMarkdownFromMessages(
    "有界最新转录",
    sourceSessionId,
    latest,
    `此有界转录包含用于正常恢复的最新 ${latest.length} 条提取消息。仅在需要更深入的取证恢复时使用 transcript.md。`,
  );
}

function buildTranscriptFull(
  structured: StructuredTranscript,
  sourceSessionId: string,
): string {
  return transcriptMarkdownFromMessages(
    "完整转录",
    sourceSessionId,
    structured.messages,
    "此转录包含从源提取的 developer/user/assistant 消息。推理记录、工具调用和工具输出按设计省略（见 restore-summary.json `omitted_classes`）。",
  );
}

function buildTouchedFiles(structured: StructuredTranscript): string {
  const rows = structured.paths.length > 0
    ? structured.paths.map((entry) => `- \`${entry.path}\`（${entry.count}）`).join("\n")
    : "- 在提取的消息或工具参数中未检测到路径。";
  return `# 已触及文件与路径清单\n\n来自消息和工具参数的尽力路径清单。这是分类辅助，不是所有已读或已写文件的完整证明。\n\n${rows}\n`;
}

function buildRestoreInstructions(opts: WritePacketOptions): string {
  return `# 恢复说明

你是 \`${opts.targetRig}\` 中的一个恢复席位。此包记录了从 \`${opts.sourceSessionId}\` 恢复工作的跨运行时上下文。

## 身份

1. 运行 \`rig whoami --json\`。
2. 信任当前工作组身份，优先于源会话转录。
3. 当前工作区根：\`${opts.targetWorkspaceRoot}\`。
4. 默认目标仓库：\`${opts.defaultTargetRepo ?? "(无)"}\`。
5. 角色指导指针：\`${opts.rolePointer}\`。

## 恢复步骤

1. 阅读本文件。
2. 阅读 \`touched-files.md\`。
3. 阅读 \`transcript-latest.md\` 获取有界当前上下文。
4. 仅在有界转录不足时使用 \`transcript.md\`。
5. 声明："从 ${opts.generatorVersion} 生成的包恢复；当前工作组是 ${opts.targetRig}；默认目标仓库是 ${opts.defaultTargetRepo ?? "无"}。"
6. 在恢复工作前说明任何注意事项。
7. 移交给下一个负责人：\`${opts.nextOwner}\`（或 "self" 继续）。

## 当前工作

${opts.currentWorkSummary}

## 权限边界

${opts.authorityBoundaries}

## 注意事项

${opts.caveats.length > 0 ? opts.caveats.map((c) => `- ${c}`).join("\n") : "-（无记录）"}

## 包统计

- 源运行时：\`${opts.sourceRuntime}\`
- 目标运行时：\`${opts.targetRuntime}\`
- 处理的 JSONL/转录行数：${opts.structured.lineCount}
- 提取的消息数：${opts.structured.messageCount}
- 压缩记录数：${opts.structured.compactedCount}
- 源 cwd：\`${opts.sourceCwd}\`
`;
}

function buildSummary(opts: WritePacketOptions): Record<string, unknown> {
  const omittedClassesActive: string[] = [];
  for (const k of ["reasoning_records", "raw_tool_outputs", "function_call_output", "redacted_secrets"] as const) {
    if (opts.structured.omittedCounts[k] > 0) omittedClassesActive.push(k);
  }
  const messageCount = Math.min(opts.structured.messages.length, TRANSCRIPT_BOUND);
  const summary: Record<string, unknown> = {
    source_session_id: opts.sourceSessionId,
    source_rig: opts.sourceRig,
    source_runtime: opts.sourceRuntime,
    source_cwd: opts.sourceCwd,
    target_rig: opts.targetRig,
    target_runtime: opts.targetRuntime,
    target_workspace_root: opts.targetWorkspaceRoot,
    default_target_repo: opts.defaultTargetRepo,
    role_pointer: opts.rolePointer,
    bounded_latest_transcript: {
      path: "transcript-latest.md",
      message_count: messageCount,
      bound: TRANSCRIPT_BOUND,
    },
    touched_files: {
      path: "touched-files.md",
      top_paths: opts.structured.paths.slice(0, 30),
    },
    durable_pointers: {
      queue_pointers: [],
      progress_pointers: [],
      field_note_pointers: [],
      artifact_pointers: [],
    },
    current_work_summary: opts.currentWorkSummary,
    next_owner: opts.nextOwner,
    caveats: opts.caveats,
    authority_boundaries: opts.authorityBoundaries,
    omitted_classes: omittedClassesActive,
    redaction_policy_id: "openrig-v0",
    source_trust_ranking: opts.sourceTrustRanking,
    generator_version: opts.generatorVersion,
    generated_at: new Date().toISOString(),
  };
  if (opts.includeFullTranscript) {
    summary.full_transcript = {
      path: "transcript.md",
      line_count: opts.structured.messages.length,
    };
  }
  return summary;
}

/**
 * 原子写入 v0 恢复包目录。
 *
 * 原子保证：如果任何步骤失败（包括 restore-summary.json 的 schema 验证），
 * targetDir 绝不被创建，任何中间临时目录被删除。操作者要么在
 * targetDir 看到完整的有效包，要么完全没有包。
 */
export async function writePacket(opts: WritePacketOptions): Promise<WritePacketResult> {
  if (existsSync(opts.targetDir)) {
    throw new Error(`恢复包写入：目标目录已存在：${opts.targetDir}`);
  }

  // 在创建任何磁盘状态之前构建所有文件内容。这样如果
  // 内存步骤抛异常（不太可能，但防御性），没有临时目录被创建。
  const summary = buildSummary(opts);
  const validation: ValidationResult = validateRestoreSummary(summary);
  if (!validation.valid) {
    const errSummary = validation.errors
      .slice(0, 5)
      .map((e) => `${e.field}: ${e.rule}`)
      .join("; ");
    throw new Error(
      `恢复包写入：原子重命名前 schema 验证失败：${errSummary}`,
    );
  }

  const restoreInstructions = buildRestoreInstructions(opts);
  const transcriptLatest = buildTranscriptLatest(opts.structured, opts.sourceSessionId);
  const touchedFiles = buildTouchedFiles(opts.structured);
  const transcriptFull = opts.includeFullTranscript
    ? buildTranscriptFull(opts.structured, opts.sourceSessionId)
    : null;

  // 使用 mkdtemp 在 targetDir 的同级创建临时目录，
  // 以获得无竞争的唯一名。dirname() 必须存在且可写；
  // 我们不为操作者 mkdir 父目录（操作者权限基石）。
  const parentDir = dirname(opts.targetDir);
  const tempPrefix = `${basename(opts.targetDir)}.tmp-restore-packet-`;
  const tempDir = mkdtempSync(join(parentDir, tempPrefix));

  try {
    writeFileSync(join(tempDir, "restore-instructions.md"), restoreInstructions, "utf-8");
    writeFileSync(join(tempDir, "transcript-latest.md"), transcriptLatest, "utf-8");
    writeFileSync(join(tempDir, "touched-files.md"), touchedFiles, "utf-8");
    writeFileSync(join(tempDir, "restore-summary.json"), JSON.stringify(summary, null, 2), "utf-8");
    if (transcriptFull !== null) {
      writeFileSync(join(tempDir, "transcript.md"), transcriptFull, "utf-8");
    }

    // 通过解析磁盘上的 summary 重新验证（往返自检）。
    // 这捕获 buildSummary 的内存形状和
    // JSON.stringify() 序列化之间的任何结构分歧。
    const onDisk = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (await import("node:fs")).readFileSync(join(tempDir, "restore-summary.json"), "utf-8"),
    );
    const recheck = validateRestoreSummary(onDisk);
    if (!recheck.valid) {
      throw new Error(
        `恢复包写入：磁盘上 schema 复查失败：${recheck.errors.slice(0, 5).map((e) => `${e.field}: ${e.rule}`).join("; ")}`,
      );
    }

    // 原子重命名临时目录 → targetDir。fs.rename 在源和目标
    // 在同一文件系统上时是原子的；我们保持它们同级以确保成立。
    renameSync(tempDir, opts.targetDir);
  } catch (err) {
    // 任何失败时清理临时目录；绝不留下部分包。
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 尽力清理；原始错误优先。
    }
    throw err;
  }

  const files = [
    "restore-instructions.md",
    "transcript-latest.md",
    "touched-files.md",
    "restore-summary.json",
  ];
  if (transcriptFull !== null) files.push("transcript.md");

  return {
    targetDir: opts.targetDir,
    files,
    summaryPath: join(opts.targetDir, "restore-summary.json"),
  };
}
