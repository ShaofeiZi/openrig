// Slice-04（OPR.0.5.0.4）seam C1（resume）——getReadModel COLLECTION 接缝。它是基于注入输入
//（codex-auth metadata reader、跨工作组席位 lister 和时钟）的纯函数，因此无需实时后台服务/数据库
// 即可直接测试 production read-model 路径。它把 codex-auth profile 映射到 accounts[]
//（按 BR-3 validate-at-use，authState=`unknown`；绝不根据静态磁盘断言 active/needs_reauth），
// 将席位全集与 Codex seat registry 连接成 rawBindings[]（未注册/Claude 席位 → unbound，assembler
// 因而生成 seat_with_no_account），透传 signal（实时 signal collection 接线前为空），并把所有 anomaly
// 计算委托给 assembleFourBlock。

import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import { rollupHostUsage } from "./host-usage-rollup.js";
import { assembleFourBlock, type RawSeatBinding } from "./provider-read-model.js";
import { claudeStatuslineSignals } from "./provider-signals.js";
import type { FourBlockReadModel, ProviderAccount, ProviderSignal } from "./provider-types.js";
import type { NodeLifecycleState } from "../types.js";

/** fleet 中的一个席位（待绑定全集），来源于跨工作组的 node inventory。 */
export interface ProviderSeat {
  seatSession: string;
  rigName: string;
  runtime: string;
  lifecycleState: NodeLifecycleState;
}

export interface ProviderCollectDeps {
  /** 读取磁盘上的 codex-auth METADATA（profile 名 + seat registry），绝不读取 token 内容。 */
  readCodexAuth: () => CodexAuthMetadata;
  /** 当前席位全集，即所有工作组的 node inventory。 */
  listSeats: () => ProviderSeat[];
  /** signals[]；实时 Codex/Claude/reactive collection lane 接线前为空。 */
  collectSignals?: () => ProviderSignal[];
  /** 调用方提供的真实时钟，即 read model 的 asOf；anomaly 借用该值，绝不虚构。 */
  now: () => string;
}

export function collectFourBlockReadModel(deps: ProviderCollectDeps): FourBlockReadModel {
  const asOf = deps.now();
  const { profiles, seats } = deps.readCodexAuth();
  const seatUniverse = deps.listSeats();

  // accounts[]：每个已知 Codex profile 一行。BR-3：authState 为 `unknown`（validate-at-use）；
  // 静态磁盘存在只能证明 profile 存在，不能证明其 auth 当前有效。
  const accounts: ProviderAccount[] = profiles.map((name) => ({
    accountId: name,
    label: name,
    provider: "codex",
    authState: "unknown",
    profileRef: name,
    asOf,
  }));

  // 席位会话 → codex-auth registry 行；这是此接缝唯一的 binding source。
  const registryBySeat = new Map(seats.map((s) => [s.seat, s]));

  const rawBindings: RawSeatBinding[] = seatUniverse.map((seat) => {
    const reg = registryBySeat.get(seat.seatSession);
    // 运行时 identity gate：只有实时 inventory 席位确实是 Codex 席位时才绑定。Codex auth-seat-registry
    // 以会话名为 key，因此若 STALE 行的会话名已被 Claude 席位复用，绝不能把该 Claude 席位绑定到
    // Codex account；无论是否存在同会话 registry 行，Claude 席位都保持 unbound
    //（seat_with_no_account）。
    if (reg && seat.runtime === "codex") {
      return {
        accountId: reg.authProfile,
        seatSession: seat.seatSession,
        rigName: seat.rigName,
        boundAt: reg.updatedTs,
        bindingSource: "codex_auth_seat_registry",
      };
    }
    // 未注册/非 Codex（Claude 席位、无 registry 行的 Codex 席位）→ unbound。assembler 会附加必需的
    // seat_with_no_account anomaly；绝不虚构 sentinel account。
    return {
      accountId: null,
      seatSession: seat.seatSession,
      rigName: seat.rigName,
      boundAt: null,
      bindingSource: null,
    };
  });

  const liveClaudeSeats = new Set(
    seatUniverse
      .filter((seat) => seat.runtime === "claude-code" && seat.lifecycleState === "running")
      .map((seat) => seat.seatSession),
  );
  const signals = (deps.collectSignals ? [...deps.collectSignals()] : []).filter((signal) =>
    signal.provider !== "claude" || !signal.seatSession || liveClaudeSeats.has(signal.seatSession),
  );
  const signaledClaudeSeats = new Set(
    signals.filter((signal) => signal.provider === "claude" && signal.seatSession).map((signal) => signal.seatSession!),
  );
  // cache discovery 绝不是席位发现的权威来源。每个实时 Claude 席位即使尚未产生第一份 statusline
  // payload，或 cache 格式错误/缺失，也必须拥有一行。
  for (const seatSession of liveClaudeSeats) {
    if (signaledClaudeSeats.has(seatSession)) continue;
    signals.push(...claudeStatuslineSignals({ seatSession, cachePresent: false, asOf }));
  }
  const model = assembleFourBlock({ accounts, rawBindings, signals, asOf });
  // Slice-04 S-A：主机级 rollup 聚合本次 collection 产生的同一批 signal。Codex deployment
  // presence = 磁盘上的 auth profile；有 Codex account 但没有 meter 的主机必须显式呈现 unknown，
  // 绝不能省略整行。
  return {
    ...model,
    hostUsage: rollupHostUsage({ signals, codexProfilesPresent: profiles.length > 0, now: asOf }),
  };
}
