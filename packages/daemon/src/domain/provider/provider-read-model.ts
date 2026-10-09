// Slice-04（OPR.0.5.0.4）——四块 ASSEMBLY（packet 3ffa3c22 §1，证明项 4）。基于已收集输入的
// 纯 assembler（无 CLI/auth I/O，收集是独立接缝）。它输出真实 bound 行和显式 unbound 行
//（seat_with_no_account），只根据重复的真实 account ID 计算 same_account_on_n_seats，确定性附加
// anomaly，原样保留 signal，且不虚构 ID/boundAt/asOf。

import type {
  BindingAnomaly,
  FourBlockReadModel,
  ProviderAccount,
  ProviderBinding,
  ProviderSignal,
  SameAccountOnNSeatsAnomaly,
  SeatWithNoAccountAnomaly,
} from "./provider-types.js";

/**
 * 收集到的 seat↔account 事实——基于真实字段集合的判别式 bound/unbound union（不含 anomaly，
 * 由 assembler 计算）。镜像 ProviderBinding，使 collector 无需为 unbound 席位伪造 account/binding 数据。
 */
export type RawSeatBinding =
  | { accountId: string; seatSession: string; rigName: string; boundAt: string; bindingSource: string }
  | { accountId: null; seatSession: string; rigName: string; boundAt: null; bindingSource: null };

export interface AssembleInput {
  accounts: ProviderAccount[];
  rawBindings: RawSeatBinding[];
  signals: ProviderSignal[];
  /** read model 的 asOf——调用方提供的真实时间戳；anomaly 借用该值而非虚构。 */
  asOf: string;
}

export function assembleFourBlock(input: AssembleInput): FourBlockReadModel {
  const { accounts, rawBindings, signals, asOf } = input;

  // 按真实 account id 对不同 seat session 分组（unbound/null-account 席位绝不参与）。使用 Set，
  // 避免同一 account+seat 的重复原始行抬高计数。
  const seatsByAccount = new Map<string, Set<string>>();
  for (const rb of rawBindings) {
    if (rb.accountId === null) continue;
    const set = seatsByAccount.get(rb.accountId) ?? new Set<string>();
    set.add(rb.seatSession);
    seatsByAccount.set(rb.accountId, set);
  }

  // 每个确实由两个以上不同席位共享的 account 产生一个 same_account_on_n_seats anomaly。
  const sharedAnomalyByAccount = new Map<string, SameAccountOnNSeatsAnomaly>();
  for (const [accountId, seats] of seatsByAccount) {
    if (seats.size < 2) continue;
    const sortedSeats = [...seats].sort(); // deterministic
    sharedAnomalyByAccount.set(accountId, {
      kind: "same_account_on_n_seats",
      count: sortedSeats.length,
      seats: sortedSeats,
      evidence: `账户 ${accountId} 绑定到 ${sortedSeats.length} 个席位：${sortedSeats.join(", ")}`,
      asOf,
    });
  }

  const bindings: ProviderBinding[] = rawBindings.map((rb) => {
    if (rb.accountId === null) {
      const anomaly: SeatWithNoAccountAnomaly = {
        kind: "seat_with_no_account",
        seat: rb.seatSession,
        evidence: `工作组 ${rb.rigName} 中的席位 ${rb.seatSession} 没有绑定账户`,
        asOf,
      };
      // 非空 tuple：seat_with_no_account anomaly 必填且始终位于首位。
      return {
        accountId: null,
        seatSession: rb.seatSession,
        rigName: rb.rigName,
        boundAt: null,
        bindingSource: null,
        anomalies: [anomaly],
      };
    }
    const shared = sharedAnomalyByAccount.get(rb.accountId);
    const anomalies: BindingAnomaly[] = shared ? [shared] : [];
    return {
      accountId: rb.accountId,
      seatSession: rb.seatSession,
      rigName: rb.rigName,
      boundAt: rb.boundAt,
      bindingSource: rb.bindingSource,
      anomalies,
    };
  });

  return {
    accounts,
    bindings,
    signals, // 原样保留。
    asOf,
  };
}
