import type { AgentActivity } from "../types.js";
import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import { reactiveEventSignal, type ReactiveEventKind } from "./provider-signals.js";
import type { ProviderSignal } from "./provider-types.js";

interface ReactiveSeat {
  seatSession: string;
  runtime: string;
}

interface ReactiveActivityReader {
  getLatestForNode(input: { sessionName: string; now: Date }): AgentActivity | null;
}

export interface ReactiveTapDeps {
  seats: readonly ReactiveSeat[];
  auth: CodexAuthMetadata;
  activity: ReactiveActivityReader;
  now: string;
  freshnessMs: number;
}

export type ReactiveVerificationReason =
  | "generation_unverifiable"
  | "generation_unresolvable"
  | "generation_resolver_error";

export interface ReactiveVerificationTrigger {
  kind: "verification_required";
  provider: "codex";
  seatSession: string;
  accountRef: string;
  activityReason: ReactiveVerificationReason;
  blockedBy: "provider_probe_unavailable";
}

export type ReactiveDiscard = {
  kind: "discarded";
  provider: "codex";
  seatSession: string;
  accountRef: string;
  reason: "generation_mismatch" | "malformed_generation_verdict";
};

export interface ReactiveTapResult {
  signals: ProviderSignal[];
  triggers: ReactiveVerificationTrigger[];
  discards: ReactiveDiscard[];
}

const EVENT_KINDS: Readonly<Record<string, ReactiveEventKind>> = {
  at_limit: "at_limit",
  rate_limit: "at_limit",
  rate_limited: "at_limit",
  stream_failure: "stream_failure",
  stream_fail: "stream_failure",
  stop_error: "stop_error",
};

const VERIFICATION_REASONS = new Set<ReactiveVerificationReason>([
  "generation_unverifiable",
  "generation_unresolvable",
  "generation_resolver_error",
]);

/**
 * 将每个已诚实识别的 Codex 席位当前结构化 activity 映射为 reactive provider 行。通用
 * needs-input activity 有意不足以触发：权限提示同样会阻塞席位，但并不属于 provider interruption。
 * 仅接受上方精确的类型化词表，raw subtype 优先于 raw event 和 normalized reason。
 */
export function collectReactiveEventSignals(deps: ReactiveTapDeps): ReactiveTapResult {
  const empty = (): ReactiveTapResult => ({ signals: [], triggers: [], discards: [] });
  const nowMs = Date.parse(deps.now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(deps.freshnessMs) || deps.freshnessMs <= 0) return empty();

  // 集中式诚实 reactive eligibility。account ref 必须指向已知 auth profile
  //（auth-profiles/ 中的文件），不能只是非空 registry token。指向缺失 profile 的 registry 行没有
  // account identity，绝不能生成 actionable 行（显式 unknown，绝不虚构 account）。
  const knownProfiles = new Set(deps.auth.profiles);
  const accountBySeat = new Map(
    deps.auth.seats
      .filter((seat) => seat.runtime === "codex" && knownProfiles.has(seat.authProfile.trim()))
      .map((seat) => [seat.seat, seat.authProfile] as const),
  );
  const signals: ProviderSignal[] = [];
  const triggers: ReactiveVerificationTrigger[] = [];
  const discards: ReactiveDiscard[] = [];

  for (const seat of deps.seats) {
    if (seat.runtime !== "codex") continue;
    const accountRef = accountBySeat.get(seat.seatSession);
    if (!accountRef) continue;

    const event = deps.activity.getLatestForNode({
      sessionName: seat.seatSession,
      now: new Date(nowMs),
    });
    if (!event) continue;
    // 已持久化 activity 的 runtime 自身必须是 Codex。附着在 Codex inventory/registry 席位上的
    // claude-code activity 不是 Codex provider evidence，绝不能重新标记为 Codex；eligibility
    // 以 event 为准，而不只看席位。
    if (event.runtime !== "codex") continue;

    const kind = eventKind(event);
    const eventAt = event.eventAt;
    if (!kind || typeof eventAt !== "string") continue;
    const eventAtMs = Date.parse(eventAt);
    if (!Number.isFinite(eventAtMs)) continue;

    // W2a tap——generation routing 位于所有既有 provider-event eligibility gate 之后，
    // 但在通用 staleness 检查之前；unresolved 和 mismatch 行有意保持 stale。
    if (event.generationProvenance === "unresolved") {
      if (isVerificationReason(event.reason)) {
        triggers.push({
          kind: "verification_required",
          provider: "codex",
          seatSession: seat.seatSession,
          accountRef,
          activityReason: event.reason,
          blockedBy: "provider_probe_unavailable",
        });
      } else {
        discards.push(discard(seat.seatSession, accountRef, "malformed_generation_verdict"));
      }
      continue;
    }

    if (event.generationProvenance !== "resolved") {
      discards.push(discard(seat.seatSession, accountRef, "malformed_generation_verdict"));
      continue;
    }

    if (event.reason === "generation_mismatch") {
      discards.push(discard(seat.seatSession, accountRef, "generation_mismatch"));
      continue;
    }
    if (isVerificationReason(event.reason)) {
      discards.push(discard(seat.seatSession, accountRef, "malformed_generation_verdict"));
      continue;
    }
    if (event.stale) continue;

    const staleAfterMs = eventAtMs + deps.freshnessMs;
    // BR-2 过期边界为包含关系：到达边界时 event 已经 stale。
    if (nowMs >= staleAfterMs) continue;

    signals.push(reactiveEventSignal({
      provider: "codex",
      accountRef,
      kind,
      asOf: eventAt,
      staleAfter: new Date(staleAfterMs).toISOString(),
    }));
  }

  return { signals, triggers, discards };
}

function isVerificationReason(reason: string | undefined): reason is ReactiveVerificationReason {
  return typeof reason === "string" && VERIFICATION_REASONS.has(reason as ReactiveVerificationReason);
}

function discard(
  seatSession: string,
  accountRef: string,
  reason: ReactiveDiscard["reason"],
): ReactiveDiscard {
  return { kind: "discarded", provider: "codex", seatSession, accountRef, reason };
}

// Classification 绑定到结构化 provider-interruption PRODUCER CLASS，即 event class 本身
//（`rawEvent`），并与已声明 interruption 词表精确匹配。managed hook relay 会把 tool_name 映射到
// `rawSubtype`，因此通用 lifecycle event（例如 tool-name subtype 为 `rate_limit` 的
// `PermissionRequest`）属于权限阻塞，绝不是额度耗尽；normalized `reason` 是派生字段，不是 producer。
// 只有 class 明确属于 interruption producer 的 event 才可执行；未经证明的 producer 不生成任何行
//（失败可见，绝不虚构）。
function eventKind(activity: AgentActivity): ReactiveEventKind | null {
  const eventClass = activity.rawEvent;
  if (typeof eventClass !== "string") return null;
  return EVENT_KINDS[eventClass] ?? null;
}
