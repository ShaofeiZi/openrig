import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  RegisterWatchdogJobInput,
  WatchdogJob,
} from "./watchdog-jobs-repository.js";
import {
  buildWidthRecoveryReceipt,
  renderRung1IncumbentNotice,
  renderRung2Baton,
  type ContinuitySeatIdentity,
} from "./continuity-stack-packets.js";

export type CompactionStrategy =
  | "default-compaction"
  | "managed-compaction"
  | "handover"
  | "apprentice-handover";

const DECIMAL_MEGABYTE = 1_000_000;
const DEFAULT_DENSE_SESSION_TOKENS_PER_MB = 153_000;
const PREPARE_TARGET_TOKENS = 600_000;
const CUTOVER_TARGET_TOKENS = 900_000;

export const CONTINUITY_POLICY_DOC = [
  "转录字节数是经过校准的替代指标，不等于 token：此 VM 上测得的密度为每 MB 113K–153K token，并会随会话形态变化。",
  "保守默认值取该范围的高密度端；席位在物化自身注册项时可以提供实测密度。",
  "请根据该席位实测的转录密度样本重新调整 threshold_bytes；绝不要跨会话形态盲目复制默认值。",
  "余量就是保护：采样发生在轮次边界，因此若阈值贴近上下文上限，触发时安全窗口可能已经消失。",
  "首次走通产品路径仍需单独的采用回执；手工运行 hook 只能作为设计证据，绝不能证明此路径已经执行。",
].join(" ");

export interface ContinuityPolicyMaterializationInput {
  compactionStrategy: CompactionStrategy;
  runtime: string;
  targetSession: string;
  watchedFilePath: string | null;
  /** 显式切换执行者；仅 apprentice-handover 需要。 */
  mechanic?: string;
  tokensPerMegabyte?: number;
  registeredBySession?: string;
  seatIdentity?: Partial<ContinuitySeatIdentity>;
}

export interface ContinuityWatchdogPlan extends RegisterWatchdogJobInput {
  key: "prepare" | "cutover";
  requiresKey: "prepare" | null;
}

export interface ContinuityPolicyPlan {
  jobs: ContinuityWatchdogPlan[];
  docText: string;
}

type StoredContinuityJob = Pick<
  WatchdogJob,
  "jobId" | "state" | "specYaml" | "requiresJobId"
> & Partial<Pick<
  WatchdogJob,
  | "watchedFilePath"
  | "thresholdBytes"
  | "intervalSeconds"
  | "activeWakeIntervalSeconds"
  | "scanIntervalSeconds"
  | "registeredBySession"
  | "terminalReason"
  | "watchedFileGeneration"
  | "lastFiredGeneration"
>>;

export interface ContinuityJobsRegistrar {
  register(input: RegisterWatchdogJobInput): Pick<WatchdogJob, "jobId">;
  markTerminal?(jobId: string, reason: string): void;
  listExactTuple?(
    policy: string,
    targetSession: string,
    targetGenerationUuid: string | null,
  ): StoredContinuityJob[];
}

export interface ContinuityCutoverAction {
  type: "create-cutover-baton";
  jobId: string;
  occupantGeneration: string;
  sourceSession: string;
  destination: string;
  body: string;
}

export interface ContinuityQueueWriter {
  create(input: {
    qitemId: string;
    sourceSession: string;
    destinationSession: string;
    body: string;
    nudge?: boolean;
  }): Promise<{ qitemId: string }>;
}

export interface ContinuityHistoryWriter {
  record(input: {
    jobId: string;
    evaluatedAt: string;
    outcome: "skipped";
    skipReason: string;
    evaluationNotes: Record<string, unknown>;
  }): unknown;
}

function thresholdBytes(targetTokens: number, tokensPerMegabyte: number): number {
  if (!Number.isFinite(tokensPerMegabyte) || tokensPerMegabyte <= 0) {
    throw new Error("tokensPerMegabyte 必须是经过校准的正数");
  }
  return Math.floor((targetTokens / tokensPerMegabyte) * DECIMAL_MEGABYTE);
}

function seatIdentity(input: ContinuityPolicyMaterializationInput): ContinuitySeatIdentity {
  return {
    sessionName: input.targetSession,
    successorSessionName: input.seatIdentity?.successorSessionName ?? "<staged-successor>",
    predecessorResumeHandle: input.seatIdentity?.predecessorResumeHandle ?? "<verbatim-resume-handle>",
    mechanicDestination: input.mechanic!,
  };
}

function watchdogSpec(input: {
  message: string;
  targetSession: string;
  threshold: number;
  continuityMode: CompactionStrategy;
  continuityAction?: { destination: string; body: string };
}): string {
  const inlineMessage = input.message.replace(/\s+/g, " ").trim();
  return [
    "policy: context-usage-threshold",
    "generated_by: continuity-policy-materializer",
    `continuity_mode: ${input.continuityMode}`,
    "target:",
    `  session: ${input.targetSession}`,
    `threshold_bytes: ${input.threshold}`,
    `message: ${JSON.stringify(inlineMessage)}`,
    ...(input.continuityAction
      ? [
          "context:",
          "  continuity_action:",
          "    type: create-cutover-baton",
          `    destination: ${JSON.stringify(input.continuityAction.destination)}`,
          `    body: ${JSON.stringify(input.continuityAction.body.replace(/\s+/g, " ").trim())}`,
        ]
      : []),
    "",
  ].join("\n");
}

function materializesContinuityJobs(
  input: Pick<ContinuityPolicyMaterializationInput, "runtime" | "compactionStrategy">,
): boolean {
  return input.runtime === "claude-code" &&
    (input.compactionStrategy === "apprentice-handover" || input.compactionStrategy === "managed-compaction");
}

export function materializeContinuityPolicy(
  input: ContinuityPolicyMaterializationInput,
): ContinuityPolicyPlan {
  if (!materializesContinuityJobs(input)) {
    return { jobs: [], docText: CONTINUITY_POLICY_DOC };
  }
  if (input.compactionStrategy === "apprentice-handover" && !input.mechanic) {
    throw new Error(
      "apprentice-handover 必须提供 mechanic；请在 spec-default、profile 或成员生命周期层声明规范 seat@rig，然后遵循 continuity/apprentice-cutover.md",
    );
  }
  const density = input.tokensPerMegabyte ?? DEFAULT_DENSE_SESSION_TOKENS_PER_MB;
  const prepareThreshold = thresholdBytes(PREPARE_TARGET_TOKENS, density);
  const watchedFilePath = input.watchedFilePath?.trim() || null;
  const common = {
    policy: "context-usage-threshold",
    targetSession: input.targetSession,
    intervalSeconds: 60,
    scanIntervalSeconds: 60,
    activeWakeIntervalSeconds: null,
    registeredBySession: input.registeredBySession ?? "daemon@kernel",
    watchedFilePath,
  };
  if (input.compactionStrategy === "managed-compaction") {
    const prepareMessage = [
      `${input.targetSession} 已超过托管压缩准备阈值。`,
      "请在 enforcer 达到压缩阈值前立即运行 zrig context recap-write 保存连续性上下文；本次提醒只做准备，不会执行压缩。",
      CONTINUITY_POLICY_DOC,
    ].join("\n\n");
    return {
      docText: CONTINUITY_POLICY_DOC,
      jobs: [{
        ...common,
        key: "prepare",
        requiresKey: null,
        thresholdBytes: prepareThreshold,
        requiresJobId: null,
        specYaml: watchdogSpec({
          message: prepareMessage,
          targetSession: input.targetSession,
          threshold: prepareThreshold,
          continuityMode: input.compactionStrategy,
        }),
      }],
    };
  }
  const cutoverThreshold = thresholdBytes(CUTOVER_TARGET_TOKENS, density);
  const identity = seatIdentity(input);
  const prepareMessage = `${renderRung1IncumbentNotice(identity)}\n\n${CONTINUITY_POLICY_DOC}`;
  const cutoverBaton = renderRung2Baton(identity);
  const cutoverMessage = [
    `${input.targetSession} 已超过连续性切换阈值。`,
    cutoverBaton.template,
  ].join("\n\n");
  return {
    docText: CONTINUITY_POLICY_DOC,
    jobs: [
      {
        ...common,
        key: "prepare",
        requiresKey: null,
        thresholdBytes: prepareThreshold,
        requiresJobId: null,
        specYaml: watchdogSpec({
          message: prepareMessage,
          targetSession: input.targetSession,
          threshold: prepareThreshold,
          continuityMode: input.compactionStrategy,
        }),
      },
      {
        ...common,
        key: "cutover",
        requiresKey: "prepare",
        thresholdBytes: cutoverThreshold,
        requiresJobId: null,
        specYaml: watchdogSpec({
          message: cutoverMessage,
          targetSession: input.targetSession,
          threshold: cutoverThreshold,
          continuityMode: input.compactionStrategy,
          continuityAction: {
            destination: cutoverBaton.destination,
            body: cutoverBaton.template,
          },
        }),
      },
    ],
  };
}

export function armContinuityPolicy(
  input: ContinuityPolicyMaterializationInput,
  registrar: ContinuityJobsRegistrar,
): Array<Pick<WatchdogJob, "jobId">> {
  const plan = materializeContinuityPolicy(input);
  const existing = (registrar.listExactTuple?.(
    "context-usage-threshold",
    input.targetSession,
    null,
  ) ?? []).filter(
    (job) =>
      job.state !== "terminal" &&
      job.specYaml.includes("generated_by: continuity-policy-materializer"),
  );

  const retireUnexpected = (keep: Set<string>): void => {
    const stale = existing.filter((job) => !keep.has(job.jobId));
    if (stale.length > 0 && !registrar.markTerminal) {
      throw new Error(`continuity_policy_reconciliation_unsupported: ${input.targetSession}`);
    }
    for (const job of stale) {
      registrar.markTerminal!(job.jobId, "continuity_policy_reconciled");
    }
  };
  const matches = (
    job: StoredContinuityJob,
    desired: ContinuityWatchdogPlan,
    requiresJobId: string | null,
  ): boolean =>
    job.specYaml === desired.specYaml &&
    job.requiresJobId === requiresJobId &&
    job.watchedFilePath === (desired.watchedFilePath ?? null) &&
    job.thresholdBytes === (desired.thresholdBytes ?? null) &&
    job.intervalSeconds === desired.intervalSeconds &&
    job.activeWakeIntervalSeconds === (desired.activeWakeIntervalSeconds ?? null) &&
    job.scanIntervalSeconds === (desired.scanIntervalSeconds ?? null) &&
    job.registeredBySession === desired.registeredBySession;
  const isCurrentShapeCandidate = (job: StoredContinuityJob): boolean =>
    job.state === "active" ||
    (job.state === "stopped" &&
      job.terminalReason !== "continuity_policy_reconciled" &&
      job.terminalReason !== "registering generation retired (seat handover)");

  if (plan.jobs.length === 0) {
    retireUnexpected(new Set());
    return [];
  }

  if (plan.jobs.length === 1) {
    const exact = existing
      .filter((job) => isCurrentShapeCandidate(job) && matches(job, plan.jobs[0]!, null))
      .sort((a, b) => Number(b.state === "stopped") - Number(a.state === "stopped"))[0];
    if (exact) {
      retireUnexpected(new Set([exact.jobId]));
      return [exact];
    }
  } else {
    const exactPairs = existing
      .filter((job) => isCurrentShapeCandidate(job) && matches(job, plan.jobs[0]!, null))
      .flatMap((prepare) => {
        const cutover = existing.find((job) =>
          isCurrentShapeCandidate(job) && matches(job, plan.jobs[1]!, prepare.jobId)
        );
        return cutover ? [{ prepare, cutover }] : [];
      })
      .sort((a, b) =>
        Number(b.prepare.state === "stopped" || b.cutover.state === "stopped") -
        Number(a.prepare.state === "stopped" || a.cutover.state === "stopped")
      );
    const exact = exactPairs[0];
    if (exact) {
      retireUnexpected(new Set([exact.prepare.jobId, exact.cutover.jobId]));
      return [exact.prepare, exact.cutover];
    }
  }

  retireUnexpected(new Set());
  const registered = new Map<string, Pick<WatchdogJob, "jobId">>();
  for (const job of plan.jobs) {
    const requiresJobId = job.requiresKey
      ? registered.get(job.requiresKey)?.jobId ?? null
      : null;
    const { key: _key, requiresKey: _requiresKey, ...registration } = job;
    const result = registrar.register({ ...registration, requiresJobId });
    registered.set(job.key, result);
  }
  return [...registered.values()];
}

function continuityBatonQitemId(action: ContinuityCutoverAction): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9-]/g, "-");
  return `qitem-continuity-${safe(action.jobId)}-${safe(action.occupantGeneration)}`;
}

/** 既有 QueueRepository.create 是唯一的托管权写入器；确定性 ID 保证重试身份一致。 */
export async function createContinuityCutoverBaton(
  action: ContinuityCutoverAction,
  queue: ContinuityQueueWriter,
): Promise<{ qitemId: string }> {
  return queue.create({
    qitemId: continuityBatonQitemId(action),
    sourceSession: action.sourceSession,
    destinationSession: action.destination,
    body: action.body,
    nudge: true,
  });
}

/** 将恢复后的宽度回执追加到该占用者唯一的托管准备任务。 */
export function recordManagedWidthReceipt(
  input: {
    sessionName: string;
    occupantGeneration: string | null;
    postRestoreUsedPercentage: number;
    saturationBoundPercentage: number;
    evaluatedAt?: string;
  },
  jobs: ContinuityJobsRegistrar,
  history: ContinuityHistoryWriter,
): { jobId: string; receipt: ReturnType<typeof buildWidthRecoveryReceipt> } | null {
  if (!input.occupantGeneration) {
    throw new Error(`continuity_width_receipt_generation_unresolved: ${input.sessionName}`);
  }
  const managed = (jobs.listExactTuple?.(
    "context-usage-threshold",
    input.sessionName,
    null,
  ) ?? []).filter((job) =>
    job.state !== "terminal" &&
    job.specYaml.includes("generated_by: continuity-policy-materializer") &&
    job.specYaml.includes("continuity_mode: managed-compaction")
  );
  // 共享 enforcer 也服务手动/默认模式压缩。没有托管注册表示此回调不属于 A9，
  // 因此刻意不写入任何内容。
  if (managed.length === 0) return null;
  if (managed.length !== 1) {
    throw new Error(
      `continuity_width_receipt_job_ambiguous: ${input.sessionName} 应有一个托管准备任务，实际找到 ${managed.length} 个` ,
    );
  }
  const job = managed[0]!;
  if (
    job.watchedFileGeneration != null &&
    job.watchedFileGeneration !== input.occupantGeneration
  ) {
    throw new Error(
      `continuity_width_receipt_generation_mismatch: ${job.jobId} 绑定到 ${job.watchedFileGeneration}，而不是 ${input.occupantGeneration}`,
    );
  }
  const receipt = buildWidthRecoveryReceipt({
    usedPercentage: input.postRestoreUsedPercentage,
    maximumUsablePercentage: input.saturationBoundPercentage,
  });
  history.record({
    jobId: job.jobId,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    outcome: "skipped",
    skipReason: "post_restore_width_receipt",
    evaluationNotes: {
      occupantGeneration: input.occupantGeneration,
      ...receipt,
    },
  });
  return { jobId: job.jobId, receipt };
}

export function findClaudeTranscriptByToken(projectsRoot: string, token: string): string | null {
  if (!token.trim() || !existsSync(projectsRoot)) return null;
  let directories: string[];
  try {
    directories = readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
  for (const directory of directories) {
    const candidate = join(projectsRoot, directory, `${token}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class ContinuityPolicyMaterializer {
  constructor(
    private readonly jobsRepository: ContinuityJobsRegistrar,
    private readonly resolveWatchedFilePath: (input: {
      sessionId: string;
      targetSession: string;
    }) => string | null,
  ) {}

  arm(input: Omit<ContinuityPolicyMaterializationInput, "watchedFilePath"> & { sessionId: string }): Array<Pick<WatchdogJob, "jobId">> {
    const watchedFilePath = materializesContinuityJobs(input)
      ? this.resolveWatchedFilePath(input)
      : null;
    return armContinuityPolicy({ ...input, watchedFilePath }, this.jobsRepository);
  }
}
