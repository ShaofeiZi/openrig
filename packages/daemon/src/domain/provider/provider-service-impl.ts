// Slice-04（OPR.0.5.0.4）C1（恢复）——生产 ProviderService。getReadModel 已完整接入
// 采集接缝（真实 codex-auth 读取器 + 跨工作组 node-inventory + 时钟）。precheck 组合纯函数
// precheckSwitch 门禁（按 BR-3，对未知认证采取失败关闭）。switch 受 precheck 门禁约束，
// 绝不伪造成功——切换执行 + BR-1 动作记录路径属于 D 接缝；在其落地前，switch 会如实
// 返回 failed_safely 并附带操作原因。

import type Database from "better-sqlite3";
import {
  AGENT_ACTIVITY_FRESHNESS_MS,
  type AgentActivityStore,
} from "../agent-activity-store.js";
import { getNodeInventory } from "../node-inventory.js";
import { readCodexAuthMetadata, type CodexAuthMetadata } from "./codex-auth-reader.js";
import { collectFourBlockReadModel, type ProviderSeat } from "./provider-collect.js";
import { precheckSwitch } from "./provider-policy.js";
import { collectReactiveEventSignals } from "./reactive-tap.js";
import type {
  ProviderService,
  ProviderPrecheckInput,
  ProviderSwitchInput,
  ProviderSwitchResult,
} from "./provider-service.js";
import type { FourBlockReadModel, PrecheckResult, ProviderSignal } from "./provider-types.js";

export interface ProviderServiceImplDeps {
  db: Database.Database;
  /** 工作组全集（rigRepo.listRigs()）——每个工作组的 node-inventory 提供席位。 */
  listRigs: () => Array<{ id: string }>;
  /** Slice-04 C3：Claude 状态栏 provider_usage 信号源（undefined → signals []）。 */
  collectClaudeSignals?: () => ProviderSignal[];
  /** Slice-04 C4：已发布的结构化活动检测器。undefined 会保持响应式泳道为空。 */
  agentActivityStore?: Pick<AgentActivityStore, "getLatestForNode">;
  /** W2a tap：操作者可见的处置输出。仅用于可观测性，绝不产生验证结论。 */
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class ProviderServiceImpl implements ProviderService {
  constructor(private readonly deps: ProviderServiceImplDeps) {}

  async getReadModel(): Promise<FourBlockReadModel> {
    const env = this.deps.env ?? process.env;
    const asOf = (this.deps.now ?? (() => new Date().toISOString()))();
    let auth: CodexAuthMetadata | undefined;
    let seats: ProviderSeat[] | undefined;
    const readAuth = () => auth ??= readCodexAuthMetadata(env);
    const listSeats = () => seats ??= this.listSeats();
    const collectReactiveSignals = (): ProviderSignal[] => {
      if (!this.deps.agentActivityStore) return [];
      const result = collectReactiveEventSignals({
        seats: listSeats(),
        auth: readAuth(),
        activity: this.deps.agentActivityStore,
        now: asOf,
        freshnessMs: AGENT_ACTIVITY_FRESHNESS_MS,
      });
      const warn = this.deps.warn ?? ((message: string) => console.warn(message));
      for (const disposition of [...result.triggers, ...result.discards]) {
        warn(`[provider-reactive-tap] ${JSON.stringify(disposition)}`);
      }
      return result.signals;
    };
    return collectFourBlockReadModel({
      readCodexAuth: readAuth,
      listSeats,
      collectSignals: () => [
        ...(this.deps.collectClaudeSignals?.() ?? []),
        ...collectReactiveSignals(),
      ],
      now: () => asOf,
    });
  }

  private listSeats(): ProviderSeat[] {
    const seats: ProviderSeat[] = [];
    for (const rig of this.deps.listRigs()) {
      for (const entry of getNodeInventory(this.deps.db, rig.id)) {
        if (!entry.canonicalSessionName) continue;
        seats.push({
          seatSession: entry.canonicalSessionName,
          rigName: entry.rigName ?? "",
          runtime: entry.runtime ?? "unknown",
          lifecycleState: entry.lifecycleState,
        });
      }
    }
    return seats;
  }

  async precheck(input: ProviderPrecheckInput): Promise<PrecheckResult> {
    const model = await this.getReadModel();
    const target = model.accounts.find((a) => a.accountId === input.toAccount);
    // 使用时校验：目标未知或认证状态未知时均失败关闭（BR-3——磁盘上存在凭据不代表已激活）。
    // 实时会话状态尚未接入（C2 活动接缝），因此保守地按会话仍存活处理，避免静默搁置会话。
    // 这是手动 precheck 变体（没有 triggeringSignal；该字段用于策略驱动的自动切换）。
    return precheckSwitch({
      targetProvider: target?.provider ?? "codex",
      targetAuthState: target?.authState ?? "unknown",
      seatHasLiveConversation: true,
    });
  }

  async switchAccount(input: ProviderSwitchInput): Promise<ProviderSwitchResult> {
    // Precheck 门禁：除非显式强制，否则绝不越过不安全判决执行切换。
    const verdict = await this.precheck({ seat: input.seat, toAccount: input.toAccount });
    if (verdict.safe === false && !input.forceUnsafe) {
      const reasons = verdict.reasons.length > 0 ? verdict.reasons : ["precheck_unsafe"];
      return { outcome: "failed_safely", reasons: reasons as [string, ...string[]] };
    }
    // D 接缝（组合 rig-auth Codex 切换 + BR-1 持久动作记录）尚未接入。
    // 如实返回操作失败，绝不伪造 succeeded/rebind_in_progress 结果。
    return { outcome: "failed_safely", reasons: ["switch_execution_not_yet_wired"] };
  }
}
