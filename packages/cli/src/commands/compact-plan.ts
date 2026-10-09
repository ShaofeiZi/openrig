import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

export interface CompactPlanDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => DaemonClient;
}

interface RigEntry {
  rigId: string;
  name: string;
}

interface NodeEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  contextUsage?: {
    usedPercentage: number | null;
    remainingPercentage: number | null;
    contextWindowSize: number | null;
    source: string | null;
    availability: string | null;
    sampledAt: string | null;
    fresh: boolean;
  };
}

interface BasePlanEntry {
  session: string | null;
  rig: string;
  logicalId: string;
  runtime: string;
  usedPercentage: number | null;
  contextWindowSize: number | null;
  estimatedUsedTokens: number | null;
  contextFreshness: "fresh" | "stale" | "unknown";
  sessionStatus: string | null;
  startupStatus: string | null;
}

interface CompactPlanThresholds {
  thresholdTokens: number;
  thresholdPercent: number;
}

interface CompactPlanSeatPolicy {
  oneSeatAtATime: true;
  autoCompactAllowed: false;
  explicitAuthorizationRequired: true;
}

interface NotificationPacket {
  recipient: string | null;
  subject: string;
  text: string;
}

interface CandidateEntry extends BasePlanEntry {
  status: "candidate_with_caveats";
  thresholdReason: string;
  reasons: string[];
  missingEvidence: string[];
  precompactRequirements: string[];
  seatPolicy: CompactPlanSeatPolicy;
  notificationPacket: NotificationPacket;
  nextAction: string;
}

interface BlockedEntry extends BasePlanEntry {
  status: "blocked";
  thresholdReason: string | null;
  reasons: string[];
  missingEvidence: string[];
  precompactRequirements: string[];
  seatPolicy: CompactPlanSeatPolicy;
  notificationPacket: NotificationPacket;
  nextAction: string;
}

interface SkippedEntry extends BasePlanEntry {
  status: "skipped";
  reason: string;
}

interface CompactPlanResult {
  summary: {
    totalSeats: number;
    claudeSeats: number;
    candidateCount: number;
    blockedCount: number;
    skippedCount: number;
    requiresAuthorization: true;
  };
  policy: {
    mode: "read_only_plan";
    defaultThresholdTokens: number;
    defaultThresholdPercent: number;
    thresholdTokens: number;
    thresholdPercent: number;
    oneSeatAtATime: true;
    autoCompactAllowed: false;
    explicitAuthorizationRequired: true;
  };
  recommendedOrder: string[];
  candidates: CandidateEntry[];
  blocked: BlockedEntry[];
  skipped: SkippedEntry[];
}

const DEFAULT_THRESHOLD_TOKENS = 400_000;
const PERCENT_FALLBACK_THRESHOLD = 80;
const FRESHNESS_THRESHOLD_S = 600;
const PRECOMPACT_REQUIREMENTS = [
  "fresh_context_sample",
  "checkpoint_or_restore_packet_verification",
  "explicit_operator_authorization",
  "one_seat_at_a_time_only",
  "post_compaction_restore_audit",
];
const SEAT_POLICY: CompactPlanSeatPolicy = {
  oneSeatAtATime: true,
  autoCompactAllowed: false,
  explicitAuthorizationRequired: true,
};

function defaultThresholds(): CompactPlanThresholds {
  return {
    thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
    thresholdPercent: PERCENT_FALLBACK_THRESHOLD,
  };
}

function estimateUsedTokens(usedPercentage: number | null, contextWindowSize: number | null): number | null {
  if (usedPercentage == null || contextWindowSize == null) return null;
  return Math.round(contextWindowSize * usedPercentage / 100);
}

function computeFreshness(contextUsage: NodeEntry["contextUsage"]): "fresh" | "stale" | "unknown" {
  if (!contextUsage || contextUsage.usedPercentage == null) return "unknown";
  if (contextUsage.sampledAt) {
    const ageSeconds = (Date.now() - new Date(contextUsage.sampledAt).getTime()) / 1000;
    return ageSeconds <= FRESHNESS_THRESHOLD_S ? "fresh" : "stale";
  }
  if (contextUsage.fresh) return "fresh";
  return "unknown";
}

function baseEntry(node: NodeEntry): BasePlanEntry {
  const usedPercentage = node.contextUsage?.usedPercentage ?? null;
  const contextWindowSize = node.contextUsage?.contextWindowSize ?? null;
  return {
    session: node.canonicalSessionName,
    rig: node.rigName,
    logicalId: node.logicalId,
    runtime: node.runtime ?? "unknown",
    usedPercentage,
    contextWindowSize,
    estimatedUsedTokens: estimateUsedTokens(usedPercentage, contextWindowSize),
    contextFreshness: computeFreshness(node.contextUsage),
    sessionStatus: node.sessionStatus,
    startupStatus: node.startupStatus,
  };
}

function isClaude(node: NodeEntry): boolean {
  return node.runtime === "claude-code";
}

function isSeatRunningReady(node: NodeEntry): boolean {
  return node.sessionStatus === "running" && node.startupStatus === "ready";
}

function candidateSortScore(candidate: CandidateEntry): number {
  return candidate.estimatedUsedTokens ?? ((candidate.usedPercentage ?? 0) * 1_000);
}

function notificationPacket(node: NodeEntry, status: "candidate_with_caveats" | "blocked", reasons: string[], missingEvidence: string[]): NotificationPacket {
  const recipient = node.canonicalSessionName;
  const subject = status === "candidate_with_caveats"
    ? `compact-plan 集结检查：${node.logicalId}`
    : `compact-plan 证据缺失：${node.logicalId}`;
  const session = recipient ?? node.logicalId;
  const text = status === "candidate_with_caveats"
    ? [
      `只读 compact-plan 已把 ${session} 标记为逐席位 Claude 连续性集结分诊候选。`,
      `原因：${reasons.join(", ")}。`,
      `在任何压缩之前：核对 checkpoint/restore 证据、取得操作人员显式授权、只压缩这一个席位，并在原地压缩后审计恢复。`,
      `未执行任何自动压缩。`,
    ].join(" ")
    : [
      `只读 compact-plan 暂时无法安全地为 ${session} 做规划。`,
      `阻塞项：${reasons.join(", ")}。`,
      `缺失证据：${missingEvidence.join(", ") || "无"}。`,
      `在申请逐席位压缩授权之前先解决这些问题。`,
    ].join(" ");
  return { recipient, subject, text };
}

function thresholdReason(base: BasePlanEntry, thresholds: CompactPlanThresholds): string | null {
  if (base.estimatedUsedTokens != null && base.estimatedUsedTokens >= thresholds.thresholdTokens) {
    return "above_token_threshold";
  }
  if (base.estimatedUsedTokens == null && (base.usedPercentage ?? 0) >= thresholds.thresholdPercent) {
    return "above_percent_threshold_missing_window";
  }
  return null;
}

function analyzeNode(node: NodeEntry, thresholds: CompactPlanThresholds): CandidateEntry | BlockedEntry | SkippedEntry {
  const base = baseEntry(node);

  if (!isClaude(node)) {
    return {
      ...base,
      status: "skipped",
      reason: node.runtime === "codex" ? "codex_not_managed_by_claude_compact_in_place" : "non_claude_runtime",
    };
  }

  const blockedReasons: string[] = [];
  const blockedMissingEvidence: string[] = [];
  if (!node.canonicalSessionName) {
    blockedReasons.push("missing_canonical_session");
    blockedMissingEvidence.push("canonical_session_name");
  }
  if (!isSeatRunningReady(node)) {
    blockedReasons.push("seat_not_running_or_ready");
  }
  if (base.usedPercentage == null) {
    blockedReasons.push("context_unknown");
    blockedMissingEvidence.push("context_usage");
  }

  if (blockedReasons.length > 0) {
    return {
      ...base,
      status: "blocked",
      thresholdReason: thresholdReason(base, thresholds),
      reasons: blockedReasons,
      missingEvidence: blockedMissingEvidence,
      precompactRequirements: PRECOMPACT_REQUIREMENTS,
      seatPolicy: SEAT_POLICY,
      notificationPacket: notificationPacket(node, "blocked", blockedReasons, blockedMissingEvidence),
      nextAction: "先解决被阻塞的席位状态并采集新鲜上下文，再把该席位加入集结分诊。",
    };
  }

  const reason = thresholdReason(base, thresholds);
  if (!reason) {
    return {
      ...base,
      status: "skipped",
      reason: "below_threshold",
    };
  }

  const reasons = [
    reason,
    "authorization_required",
  ];
  const missingEvidence = ["checkpoint_or_restore_packet_verification"];

  if (base.contextWindowSize == null) {
    missingEvidence.push("context_window_size");
  }
  if (base.contextFreshness === "stale") {
    reasons.push("context_stale");
    missingEvidence.push("fresh_context_sample");
  } else if (base.contextFreshness === "unknown") {
    reasons.push("context_freshness_unknown");
    missingEvidence.push("fresh_context_sample");
  }
  if (!node.tmuxAttachCommand && !node.resumeCommand) {
    missingEvidence.push("attach_or_resume_evidence");
  }

  return {
    ...base,
    status: "candidate_with_caveats",
    thresholdReason: reason,
    reasons,
    missingEvidence,
    precompactRequirements: PRECOMPACT_REQUIREMENTS,
    seatPolicy: SEAT_POLICY,
    notificationPacket: notificationPacket(node, "candidate_with_caveats", reasons, missingEvidence),
    nextAction: "核对 checkpoint/restore 证据、取得显式授权、压缩一个 Claude 席位，再用 claude-compact-in-place 审计恢复。",
  };
}

function buildPlan(nodes: NodeEntry[], thresholds = defaultThresholds()): CompactPlanResult {
  const candidates: CandidateEntry[] = [];
  const blocked: BlockedEntry[] = [];
  const skipped: SkippedEntry[] = [];

  for (const node of nodes) {
    const entry = analyzeNode(node, thresholds);
    if (entry.status === "candidate_with_caveats") candidates.push(entry);
    else if (entry.status === "blocked") blocked.push(entry);
    else skipped.push(entry);
  }

  candidates.sort((a, b) => {
    const score = candidateSortScore(b) - candidateSortScore(a);
    if (score !== 0) return score;
    return (a.session ?? a.logicalId).localeCompare(b.session ?? b.logicalId);
  });

  return {
    summary: {
      totalSeats: nodes.length,
      claudeSeats: nodes.filter(isClaude).length,
      candidateCount: candidates.length,
      blockedCount: blocked.length,
      skippedCount: skipped.length,
      requiresAuthorization: true,
    },
    policy: {
      mode: "read_only_plan",
      defaultThresholdTokens: DEFAULT_THRESHOLD_TOKENS,
      defaultThresholdPercent: PERCENT_FALLBACK_THRESHOLD,
      thresholdTokens: thresholds.thresholdTokens,
      thresholdPercent: thresholds.thresholdPercent,
      oneSeatAtATime: true,
      autoCompactAllowed: false,
      explicitAuthorizationRequired: true,
    },
    recommendedOrder: candidates
      .map((candidate) => candidate.session)
      .filter((session): session is string => Boolean(session)),
    candidates,
    blocked,
    skipped,
  };
}

function printHuman(plan: CompactPlanResult): void {
  console.log("只读规划——不做任何压缩");
  console.log("策略：read_only_plan；逐席位集结分诊；autoCompactAllowed=false；需要显式授权。");
  console.log(`阈值：${plan.policy.thresholdTokens} 估算 token；上下文窗口大小缺失时按 ${plan.policy.thresholdPercent}%。`);
  console.log(`汇总：${plan.summary.candidateCount} 个候选 | ${plan.summary.blockedCount} 个被阻塞 | ${plan.summary.skippedCount} 个跳过`);
  console.log();

  if (plan.recommendedOrder.length > 0) {
    console.log("建议的逐席位集结分诊顺序：");
    for (const [index, session] of plan.recommendedOrder.entries()) {
      console.log(`  ${index + 1}. ${session}`);
    }
  } else {
    console.log("建议的逐席位集结分诊顺序：无");
  }

  if (plan.candidates.length > 0) {
    console.log();
    console.log("带注意事项的候选：");
    for (const candidate of plan.candidates) {
      const estimate = candidate.estimatedUsedTokens == null ? "未知 token" : `估算 ${candidate.estimatedUsedTokens} token`;
      console.log(`  - ${candidate.session}：${estimate}；触发阈值=${candidate.thresholdReason}；原因=${candidate.reasons.join(", ")}；缺失=${candidate.missingEvidence.join(", ")}`);
      console.log(`    通知：${candidate.notificationPacket.text}`);
    }
  }

  if (plan.blocked.length > 0) {
    console.log();
    console.log("被阻塞 / 无法安全规划：");
    for (const blocked of plan.blocked) {
      console.log(`  - ${blocked.session ?? blocked.logicalId}：原因=${blocked.reasons.join(", ")}；缺失=${blocked.missingEvidence.join(", ") || "无"}`);
      console.log(`    通知：${blocked.notificationPacket.text}`);
    }
  }

  console.log();
  console.log("下一步：核对 checkpoint/restore 证据、取得显式授权、只压缩一个 Claude 席位，再用 claude-compact-in-place 审计恢复。");
}

export function compactPlanCommand(depsOverride?: CompactPlanDeps): Command {
  const cmd = new Command("compact-plan")
    .description("在不做任何压缩的前提下规划 Claude 原地压缩候选")
    .addHelpText("after", `
示例：
  zrig compact-plan                    展示只读的 Claude 压缩分诊规划
  zrig compact-plan --rig openrig-pm   只规划一个工作组
  zrig compact-plan --refresh          规划前重新采样上下文
  zrig compact-plan --json             供智能体使用的 JSON 输出`);

  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "供智能体使用的 JSON 输出")
    .option("--rig <name>", "只规划一个工作组")
    .option("--refresh", "规划前重新采样上下文用量")
    .option("--threshold-tokens <n>", "Claude compact-plan 候选的已用 token 估算阈值")
    .option("--threshold-percent <0-100>", "上下文窗口大小缺失时的已用百分比阈值")
    .action(async (opts: { json?: boolean; rig?: string; refresh?: boolean; thresholdTokens?: string; thresholdPercent?: string }) => {
      const deps = getDepsF();
      const thresholds = parseThresholdOptions(opts);
      if (!thresholds.ok) {
        console.error(thresholds.error);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("后台服务未运行。启动：zrig daemon start");
        console.error("没有当前的只读工作组清单就无法构建 compact-plan。");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      try {
        const psResult = await client.get<RigEntry[]>("/api/ps");
        const rigs = psResult.data ?? [];
        const targetRigs = opts.rig ? rigs.filter((rig) => rig.name === opts.rig) : rigs;

        if (opts.rig && targetRigs.length === 0) {
          console.error(`未找到工作组 "${opts.rig}"。列出工作组：zrig ps`);
          process.exitCode = 1;
          return;
        }

        if (opts.refresh && targetRigs.length > 0) {
          const firstRig = targetRigs[0]!;
          try {
            const refreshResult = await client.get(`/api/rigs/${firstRig.rigId}/nodes?refresh=true`);
            if (refreshResult.status >= 400) {
              console.error("compact-plan 刷新失败。数据可能已过期。");
              console.error(`详情：${JSON.stringify(refreshResult.data)}`);
              console.error("修复：不带 --refresh 重试以查看过期数据，或查看后台服务日志。");
              process.exitCode = 2;
              return;
            }
          } catch (refreshErr) {
            console.error("compact-plan 刷新失败。数据可能已过期。");
            console.error(`详情：${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`);
            console.error("修复：不带 --refresh 重试以查看过期数据，或查看后台服务日志。");
            process.exitCode = 2;
            return;
          }
        }

        const allNodes: NodeEntry[] = [];
        for (const rig of targetRigs) {
          const nodesResult = await client.get<NodeEntry[]>(`/api/rigs/${rig.rigId}/nodes`);
          if (Array.isArray(nodesResult.data)) {
            allNodes.push(...nodesResult.data);
          }
        }

        const plan = buildPlan(allNodes, thresholds.value);
        if (opts.json) {
          console.log(JSON.stringify(plan, null, 2));
        } else {
          printHuman(plan);
        }
      } catch (err) {
        console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
        console.error("修复：用 zrig daemon status 检查后台服务状态。");
        process.exitCode = 2;
      }
    });

  return cmd;
}

function parseThresholdOptions(opts: { thresholdTokens?: string; thresholdPercent?: string }): { ok: true; value: CompactPlanThresholds } | { ok: false; error: string } {
  const thresholds = defaultThresholds();

  if (opts.thresholdTokens != null) {
    const value = Number(opts.thresholdTokens);
    if (!Number.isInteger(value) || value <= 0) {
      return { ok: false, error: "--threshold-tokens 必须是正整数" };
    }
    thresholds.thresholdTokens = value;
  }

  if (opts.thresholdPercent != null) {
    const value = Number(opts.thresholdPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return { ok: false, error: "--threshold-percent 必须是 0 到 100 之间的数字" };
    }
    thresholds.thresholdPercent = value;
  }

  return { ok: true, value: thresholds };
}
