// restore-packet.ts——`rig restore-packet {write,read,validate}` CLI 命令。
//
// M2a：命令形状 + 互斥 + read/validate 桩。
// M2b：source-adapter 接线（codex-jsonl-parser、claude-transcript-parser、
//      runtime-detect、redaction、omitted-records）。
// M2c-CLI：用 packet-writer.ts 完整实现 write 动作；--source-jsonl
//          + --source-session adapter 接线；CLI 标志默认值，用于 parser
//          推导不出的约 11 个契约必需字段。
// M2c-Daemon：full-read transcript 路由 + auth + redaction + 测试。
// M3：用真实的 read + validate 实现替换桩。

import { Command } from "commander";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import { detectRuntime } from "../restore-packet/runtime-detect.js";
import { parseSessionName } from "../session-name.js";
import { parseCodexJsonl } from "../restore-packet/codex-jsonl-parser.js";
import { parseClaudeTranscript } from "../restore-packet/claude-transcript-parser.js";
import { writePacket, type WritePacketOptions } from "../restore-packet/packet-writer.js";
import {
  validateRestoreSummary,
  type ValidationError,
} from "../restore-packet/schema-validator.js";
import type { SourceRuntime, StructuredTranscript } from "../restore-packet/types.js";

// 按 M1 契约 § 1：4 个必需 packet 文件。validate 的 packet-shape 检查与
// read 的 transcript 存在性检测都用它。
const REQUIRED_PACKET_FILES = [
  "restore-instructions.md",
  "transcript-latest.md",
  "touched-files.md",
  "restore-summary.json",
] as const;

export interface RestorePacketDeps {
  lifecycleDeps?: LifecycleDeps;
  clientFactory?: (url: string) => DaemonClient;
}

interface WriteOptions {
  sourceSession?: string;
  sourceJsonl?: string;
  sourceRuntime?: string;
  /**
   * R2：操作人员对 source_session_id 的显式覆盖。优先于解析出的
   * session_meta 和 --source-session 参数。当 JSONL 没有 session_meta
   * 记录时必需。
   */
  sourceSessionIdOverride?: string;
  /**
   * R2：操作人员对 source_rig 的显式覆盖。优先于 <seat>@<rig>
   * 推导。当 canonical source_session_id 是裸的（没有 @）且操作人员
   * 没有提供带 @ 形状的 --source-session-id-override 时必需。
   */
  sourceRigOverride?: string;
  target: string;
  targetRig?: string;
  targetRuntime?: string;
  targetWorkspaceRoot?: string;
  defaultTargetRepo?: string;
  rolePointer?: string;
  currentWorkSummary?: string;
  nextOwner?: string;
  caveat?: string[];
  authorityBoundaries?: string;
  sourceTrustRanking?: string;
  generatorVersion?: string;
}

/**
 * R2：按 honest-fallback 策略推导 canonical (source_session_id, source_rig)。
 * 覆盖标志 > 解析出的 session_meta（jsonl）> 提供的 --source-session。
 *
 * 返回推导的 pair（不抛异常），或抛出带显式操作人员指引消息的 Error。
 * 动作调用方捕获并路由到 reportFailure()。
 */
function deriveProvenance(
  opts: WriteOptions,
  parsedSessionId: string | null,
  hasJsonl: boolean,
): { sourceSessionId: string; sourceRig: string } {
  // Step 1：source_session_id——覆盖 > 解析 > --source-session 参数。
  let sourceSessionId: string;
  if (typeof opts.sourceSessionIdOverride === "string" && opts.sourceSessionIdOverride.length > 0) {
    sourceSessionId = opts.sourceSessionIdOverride;
  } else if (hasJsonl) {
    if (!parsedSessionId) {
      throw new Error(
        "源 JSONL 中没有 session_meta 记录；请显式提供 --source-session-id-override <id> 和 --source-rig-override <rig> 来设置 provenance。不允许静默回退为 file-path-as-session-id（M2c-CLI R2 honest-provenance 策略）。",
      );
    }
    sourceSessionId = parsedSessionId;
  } else {
    // hasSession 路径：操作人员命名的会话为准。
    sourceSessionId = opts.sourceSession!;
  }

  // Step 2：source_rig——覆盖 > <seat>@<rig> 拆分。
  let sourceRig: string;
  if (typeof opts.sourceRigOverride === "string" && opts.sourceRigOverride.length > 0) {
    sourceRig = opts.sourceRigOverride;
  } else {
    // OPR.0.4.6.MH1 FR-8 + rev1-r2 B2：共用解析契约，外加本站点自己的严格性。
    // 契约里的贪心 rig 是 QUEUE GATE 的形状——那里 in-band host 会响亮地
    // 触发注册表查找失败。本站点持久化 provenance 时不做查找，所以多 @ 的
    // rig 会被静默记录（BR-1 把 host 挡在 session 字符串之外；
    // honest-provenance 策略禁止静默接受）。带 PLAIN rig 的 canonical
    // member@rig 可推导；其他都抛下面的显式覆盖错误。
    const parsedSource = parseSessionName(sourceSessionId);
    const captured = parsedSource.kind === "canonical" && !parsedSource.rig.includes("@")
      ? parsedSource.rig
      : undefined;
    if (!captured) {
      throw new Error(
        `无法从会话 id '${sourceSessionId}' 推导 source_rig（不匹配 <seat>@<rig> 形状）；请显式提供 --source-rig-override <rig>。不允许静默回退为 source_rig:"unknown"（M2c-CLI R2 honest-provenance 策略）。`,
      );
    }
    sourceRig = captured;
  }

  return { sourceSessionId, sourceRig };
}

function reportFailure(message: string): void {
  console.error(`zrig restore-packet write：${message}`);
  process.exitCode = 2;
}

function isValidRuntime(value: string | undefined): value is SourceRuntime {
  return value === "codex" || value === "claude-code";
}

async function fetchSourceTranscriptViaDaemon(
  session: string,
  deps: RestorePacketDeps | undefined,
): Promise<{ content: string; sourceCwd: string | null }> {
  const lifecycleDeps = deps?.lifecycleDeps ?? realDeps();
  const status = await getDaemonStatus(lifecycleDeps);
  if (status.state !== "running" || typeof status.port !== "number") {
    throw new Error("后台服务未运行；用以下命令启动：zrig daemon start");
  }
  const url = getDaemonUrl(status);
  const client = (deps?.clientFactory ?? ((u: string) => new DaemonClient(u)))(url);
  // M2c-Daemon 会定义这条路由。M2c-CLI 调用它；M2c-CLI 测试 mock 后台服务
  //（compact-plan.test.ts:166-176 模式）。路径是草案——M2c-Daemon 可能选
  // 不同的命名约定；如果那样，M2c-Daemon 会在加后台服务路由的同一提交里
  // 把改动落到 restore-packet.ts。
  const path = `/api/transcripts/${encodeURIComponent(session)}/full`;
  const response = await client.get<{ content: string; cwd?: string | null }>(path);
  if (response.status >= 400 || !response.data) {
    throw new Error(
      `后台服务 transcript 抓取失败：HTTP ${response.status}：${
        typeof response.data === "object" && response.data !== null
          ? JSON.stringify(response.data)
          : "（无 body）"
      }`,
    );
  }
  return {
    content: response.data.content ?? "",
    sourceCwd: response.data.cwd ?? null,
  };
}

function buildWritePacketOptions(
  opts: WriteOptions,
  structured: StructuredTranscript,
  sourceRuntime: SourceRuntime,
  sourceCwdFallback: string,
  sourceSessionId: string,
  sourceRig: string,
): WritePacketOptions {
  const trustRankingDefault = "rig_whoami,bounded_latest_transcript";
  const trustRankingRaw = opts.sourceTrustRanking ?? trustRankingDefault;
  const trustRanking = trustRankingRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    targetDir: resolvePath(opts.target),
    structured,
    sourceRuntime,
    targetRig: opts.targetRig ?? "openrig-velocity",
    targetRuntime: isValidRuntime(opts.targetRuntime) ? opts.targetRuntime : "claude-code",
    targetWorkspaceRoot: opts.targetWorkspaceRoot ?? structured.sessionMeta?.cwd ?? sourceCwdFallback,
    defaultTargetRepo: opts.defaultTargetRepo ?? null,
    rolePointer: opts.rolePointer ?? `rigs/${opts.targetRig ?? "openrig-velocity"}/state/velocity/role.md`,
    currentWorkSummary: opts.currentWorkSummary ?? "由 zrig restore-packet write 生成的跨运行时恢复包。",
    nextOwner: opts.nextOwner ?? "self",
    caveats: opts.caveat ?? [],
    authorityBoundaries: opts.authorityBoundaries ?? "按源会话角色恢复席位权限。",
    sourceTrustRanking: trustRanking,
    sourceSessionId,
    sourceRig,
    sourceCwd: structured.sessionMeta?.cwd ?? sourceCwdFallback,
    generatorVersion: opts.generatorVersion ?? "rig-restore-packet@0.1.0",
    includeFullTranscript: structured.messages.length > 0,
  };
}

export function restorePacketCommand(depsOverride?: RestorePacketDeps): Command {
  const cmd = new Command("restore-packet")
    .description(
      "按 v0 标准生成、读取并校验跨运行时恢复包",
    );

  cmd.command("write")
    .description(
      "从源会话或 JSONL 文件生成恢复包",
    )
    .option("--source-session <session>", "源会话名（后台服务支持）")
    .option(
      "--source-jsonl <path>",
      "源 Codex/Claude JSONL transcript 文件（直接）",
    )
    .option(
      "--source-runtime <runtime>",
      "强制指定源运行时（claude-code | codex）；省略时自动检测",
    )
    .requiredOption(
      "--target <dir>",
      "目标 packet 目录（必须不存在；原子创建）",
    )
    .option("--target-rig <rig>", "恢复席位的目标工作组名")
    .option(
      "--target-runtime <runtime>",
      "目标运行时（claude-code | codex）",
    )
    .option(
      "--target-workspace-root <path>",
      "目标工作区根目录绝对路径",
    )
    .option(
      "--default-target-repo <path>",
      "默认目标仓库绝对路径或 null",
    )
    .option(
      "--role-pointer <path>",
      "恢复席位的角色指引指针路径或 URI",
    )
    .option(
      "--current-work-summary <text>",
      "源席位当前工作的一段话摘要",
    )
    .option(
      "--next-owner <name>",
      '恢复席位下一步交给谁（默认："self"）',
    )
    .option(
      "--caveat <text>",
      "要包含在 packet 里的注意事项（可重复）",
      (value: string, prev: string[] = []) => prev.concat([value]),
      [] as string[],
    )
    .option(
      "--authority-boundaries <text>",
      "恢复席位权限的显式声明",
    )
    .option(
      "--source-trust-ranking <csv>",
      "逗号分隔的源信任排序；默认：rig_whoami,bounded_latest_transcript",
    )
    .option(
      "--generator-version <version>",
      '生成器版本标识（默认："rig-restore-packet@0.1.0"）',
    )
    .option(
      "--source-session-id-override <id>",
      "操作人员对 source_session_id 的覆盖（R2；JSONL 没有 session_meta 记录时必需）",
    )
    .option(
      "--source-rig-override <rig>",
      "操作人员对 source_rig 的覆盖（R2；canonical 会话 id 是裸的、没有 <seat>@<rig> 形状时必需）",
    )
    .action(async (opts: WriteOptions) => {
      const hasSession = typeof opts.sourceSession === "string" && opts.sourceSession.length > 0;
      const hasJsonl = typeof opts.sourceJsonl === "string" && opts.sourceJsonl.length > 0;
      if (hasSession && hasJsonl) {
        reportFailure(
          "--source-session 与 --source-jsonl 互斥；请恰好提供一个。",
        );
        return;
      }
      if (!hasSession && !hasJsonl) {
        reportFailure(
          "--source-session 与 --source-jsonl 二者恰需其一。",
        );
        return;
      }

      try {
        let content: string;
        let sourceCwdFallback: string;
        if (hasJsonl) {
          const jsonlPath = resolvePath(opts.sourceJsonl!);
          content = readFileSync(jsonlPath, "utf-8");
          sourceCwdFallback = "/";
        } else {
          const session = opts.sourceSession!;
          const fetched = await fetchSourceTranscriptViaDaemon(session, depsOverride);
          content = fetched.content;
          sourceCwdFallback = fetched.sourceCwd ?? "/";
        }

        let runtime: SourceRuntime | null = null;
        if (isValidRuntime(opts.sourceRuntime)) {
          runtime = opts.sourceRuntime;
        } else if (typeof opts.sourceRuntime === "string" && opts.sourceRuntime.length > 0) {
          reportFailure(
            `--source-runtime 必须是 'codex' 或 'claude-code'；收到 '${opts.sourceRuntime}'。`,
          );
          return;
        } else {
          runtime = detectRuntime(content);
          if (runtime === null) {
            reportFailure(
              "无法自动检测源运行时；请显式传 --source-runtime <claude-code|codex>。",
            );
            return;
          }
        }

        const structured = runtime === "codex"
          ? parseCodexJsonl(content)
          : parseClaudeTranscript(content);

        // R2：诚实地推导 (source_session_id, source_rig)。
        // 覆盖标志 > 解析出的 session_meta（jsonl）> 提供的 --source-session
        // 参数。honest-provenance 策略无法满足时抛带显式操作人员指引的 Error。
        let provenance: { sourceSessionId: string; sourceRig: string };
        try {
          provenance = deriveProvenance(opts, structured.sessionMeta?.sessionId ?? null, hasJsonl);
        } catch (err) {
          reportFailure((err as Error).message);
          return;
        }

        const writeOpts = buildWritePacketOptions(
          opts,
          structured,
          runtime,
          sourceCwdFallback,
          provenance.sourceSessionId,
          provenance.sourceRig,
        );
        const result = await writePacket(writeOpts);

        // 按 Quality Lesson v9：只记录元数据，不记录 transcript 内容。
        console.log(`packet：${result.targetDir}`);
        console.log(`文件：${result.files.length}`);
        for (const f of result.files) {
          console.log(`  - ${f}`);
        }
        console.log(`消息：${structured.messageCount}`);
        console.log(`省略类别：${Object.entries(structured.omittedCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(",") || "（无）"}`);
      } catch (err) {
        reportFailure((err as Error).message);
      }
    });

  cmd.command("read")
    .description("渲染恢复包内容（人类可读或 --json）")
    .argument("<packet-dir>", "packet 目录路径")
    .option("--json", "输出机器可读 JSON")
    .action(async (packetDir: string, opts: { json?: boolean }) => {
      const dir = resolvePath(packetDir);
      const summaryPath = joinPath(dir, "restore-summary.json");
      if (!existsSync(summaryPath)) {
        console.error(
          `zrig restore-packet read：在 ${summaryPath} 未找到 restore-summary.json。`,
        );
        process.exitCode = 2;
        return;
      }
      let summary: Record<string, unknown>;
      try {
        summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
      } catch (err) {
        console.error(
          `zrig restore-packet read：restore-summary.json 不是合法 JSON：${(err as Error).message}。`,
        );
        process.exitCode = 2;
        return;
      }

      if (opts.json) {
        // 按 IMPL § M3：--json 原样输出 restore-summary.json 内容；
        // 可 round-trip。
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      // 人类输出：restore-instructions 正文 + 摘要元数据 + transcript 摘要。
      const instructionsPath = joinPath(dir, "restore-instructions.md");
      if (existsSync(instructionsPath)) {
        console.log(readFileSync(instructionsPath, "utf-8"));
      } else {
        console.log("（packet 目录中缺少 restore-instructions.md）");
      }
      console.log("--- 摘要元数据 ---");
      const metadataKeys = [
        "source_session_id",
        "source_rig",
        "source_cwd",
        "source_runtime",
        "target_rig",
        "target_runtime",
        "generator_version",
      ];
      for (const k of metadataKeys) {
        const v = summary[k];
        console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
      }
      const blt = summary.bounded_latest_transcript as { bound?: number; message_count?: number } | undefined;
      if (blt) {
        console.log(`有界最新会话记录上限：${blt.bound}`);
        console.log(`有界最新会话记录消息数：${blt.message_count}`);
      }
      const omittedClasses = summary.omitted_classes;
      console.log(`已省略类别：${Array.isArray(omittedClasses) ? omittedClasses.join(",") || "（无）" : "（未知）"}`);

      // Transcript 摘要行（按 IMPL § M3 + 契约 § 1 对等规则）。
      const transcriptPath = joinPath(dir, "transcript.md");
      const hasFullTranscriptKey = Object.prototype.hasOwnProperty.call(summary, "full_transcript");
      if (existsSync(transcriptPath)) {
        const sz = statSync(transcriptPath).size;
        console.log(`transcript.md：${sz} 字节`);
        if (!hasFullTranscriptKey) {
          console.log("（对等警告：transcript.md 存在但 summary 缺 full_transcript 键）");
        }
      } else {
        if (hasFullTranscriptKey) {
          console.log("（对等警告：summary 有 full_transcript 键但缺 transcript.md）");
        } else {
          console.log("缺 transcript.md（summary 也缺 full_transcript 键；按对等规则合法）");
        }
      }
    });

  cmd.command("validate")
    .description("按 v0 schema 校验恢复包")
    .argument("<packet-dir>", "packet 目录路径")
    .option("--json", "输出机器可读校验报告")
    .action(async (packetDir: string, opts: { json?: boolean }) => {
      const dir = resolvePath(packetDir);
      const errors: ValidationError[] = [];

      // Packet-shape 检查：按契约 § 1 需要 4 个文件。
      for (const required of REQUIRED_PACKET_FILES) {
        const p = joinPath(dir, required);
        if (!existsSync(p)) {
          errors.push({
            field: required,
            value: "<缺失>",
            rule: `packet-shape：在 ${p} 缺少必需文件`,
            severity: "error",
          });
        }
      }

      // 如果 restore-summary.json 存在，做 schema 校验。
      let summary: Record<string, unknown> | null = null;
      const summaryPath = joinPath(dir, "restore-summary.json");
      if (existsSync(summaryPath)) {
        try {
          summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          errors.push({
            field: "restore-summary.json",
            value: "<非法 JSON>",
            rule: `restore-summary.json 解析失败：${(err as Error).message}`,
            severity: "error",
          });
        }
        if (summary) {
          const schemaResult = validateRestoreSummary(summary);
          for (const e of schemaResult.errors) errors.push(e);
        }
      }

      // 对等检查（按契约 § 1 + § 8）：full_transcript summary 键
      // ↔ transcript.md 存在性。
      if (summary) {
        const hasFullTranscriptKey = Object.prototype.hasOwnProperty.call(summary, "full_transcript");
        const transcriptExists = existsSync(joinPath(dir, "transcript.md"));
        if (hasFullTranscriptKey && !transcriptExists) {
          errors.push({
            field: "full_transcript",
            value: "<键在文件缺>",
            rule: "对等：summary 有 full_transcript 键但 packet 目录缺 transcript.md",
            severity: "error",
          });
        }
        if (!hasFullTranscriptKey && transcriptExists) {
          errors.push({
            field: "transcript.md",
            value: "<文件在键缺>",
            rule: "对等：transcript.md 存在但 summary 缺 full_transcript 键",
            severity: "error",
          });
        }
      }

      const hasErrorSeverity = errors.some((e) => e.severity === "error");
      const valid = !hasErrorSeverity;

      if (opts.json) {
        console.log(JSON.stringify({ valid, errors }, null, 2));
      } else {
        if (errors.length === 0) {
          console.log(`合法：位于 ${dir} 的 packet 通过所有检查。`);
        } else {
          console.log(`${valid ? "合法（带警告）" : "非法"}：${dir} 有 ${errors.length} 个问题`);
          for (const e of errors) {
            const tag = e.severity === "warning" ? "警告" : "错误";
            console.log(`  [${tag}] ${e.field}：${e.rule}（值：${e.value}）`);
          }
        }
      }

      // 按契约 § 8：必需字段违规 / 对等违规 → 非零退出。
      // 可选字段警告 → 退出 0。
      if (hasErrorSeverity) {
        process.exitCode = 2;
      }
    });

  return cmd;
}
