import type { Context } from "hono";

/**
 * P21 发送方溯源瓶颈点——把 P18 内联 `/inbox/drop` 表单（b2437104）泛化到所有调用方身份站点的
 * 那个唯一共享路由辅助函数。执行席位的身份由 CLI 的 DaemonClient 从席位环境变量一次性盖戳的已认证
 * 传输头（X-OpenRig-Session）派生，行记录这次派生来自哪个纪元。
 *
 * P18「投递并标注」（创始人裁决，过度工程审计——那些拒绝都已删除）。本辅助函数过去抛出的两个
 * 拒绝都断言「此发送方不合法」，而当时唯一确知的只是「我在这个边界无法验证此发送方」。这是两个
 * 不同的主张，而系统却下了更自信的那个：
 *   - 401 `unattributable_sender`（头缺失）——已删除。头缺失意味着发送方在此边界无法被认证；
 *     诚实的做法是投递并记录更弱的纪元戳 `claimed:v1`。
 *   - 409 `identity_mismatch`（body 声明 ≠ 传输身份）——已删除（PM，2026-08-11，裁决 (A)：
 *     两个拒绝一起死，并入这一次清扫——早先那种「每个原子各一处」的拆分被作为不必要的仪式退役）。
 *     一个被认证的线路身份恰恰是当初拒绝错误的原因：线路决定执行者，body 从不决定，因此 body
 *     声明与之一致是待取代的噪声，不是拒绝的理由。按线路身份投递，标注 transport:v1；该差异不被
 *     持久化（不新增字段/schema）。下面 resolveActorWithDeferral 里那个字节相同的 409 也以同样方式
 *     退役，使两个兄弟辅助函数在取代规则上达成一致。
 *
 * 既无传输头也无 body actor 时，根本没有可记到台账行上的执行者，于是向调用方索要缺失参数
 * （400 `actor_required`）——正是 PM 在 queue.ts:215 裁决刻意保留的那个形状。索要一个本该存在
 * 却缺失的参数是诚实的帮助，不是对某个具名发送方的拒绝。
 *
 * 标注这一半不是新机制：下面的 `resolveRecordedProvenance` 已经把降级作为默认分支，
 * `resolveActorWithDeferral` 也已经在创始人可见表面做过「投递并标注」。这里只是把这个既有的、
 * 正确降级的模式扩展到过去会拒绝的那些站点。
 */
export const SENDER_IDENTITY_HEADER = "x-openrig-session";
export const ORIGIN_UNKNOWN_HEADER = "x-openrig-origin-unknown";

function transportProvenance(c: Context): Exclude<IdentityProvenance, "relay:v1"> {
  return c.req.header(ORIGIN_UNKNOWN_HEADER) === "true" ? "origin-unknown:v1" : "transport:v1";
}

export type SenderIdentity =
  // `provenance` 是非 relay 子集——本辅助函数永远只在本地派生：头在此处证明了就是
  // transport:v1，否则是 claimed:v1。relay:v1 属于跨主机转发，由 resolveRecordedProvenance 决定，
  // 永远不在此。
  | { ok: true; session: string; provenance: Exclude<IdentityProvenance, "relay:v1"> }
  | { ok: false; response: Response };

export function requireSenderIdentity(
  c: Context,
  opts?: { verb?: string; bodyClaim?: string | null },
): SenderIdentity {
  const verb = opts?.verb ?? "此操作";
  const session = c.req.header(SENDER_IDENTITY_HEADER)?.trim();
  const claim = opts?.bodyClaim?.trim();
  if (session) {
    // 传输路径——头已在这一跳证明了执行者。P18 清扫：线路取代任何 body 声明
    // （409 identity_mismatch 拒绝已退役）。一个不一致的 body actor 是待取代的噪声，不是要拒绝的攻击
    // ——线路决定执行者，body 从不决定。按传输席位身份投递，保留任何未知来源标记；差异不被持久化
    // （裁决 (A)——不新增字段/schema）。此路径上 `claim` 被有意忽略。
    return { ok: true, session, provenance: transportProvenance(c) };
  }
  // 没有传输身份：按 body 声明的执行者投递，诚实标注为 claimed 纪元。
  if (claim) return { ok: true, session: claim, provenance: "claimed:v1" };
  // 既无派生身份也无声明身份——没有可归因到行上的执行者。参数完整性，而非不信任。
  return {
    ok: false,
    response: c.json({
      error: "actor_required",
      message:
        `无法记录${verb}：没有已认证的传输身份（缺少 X-OpenRig-Session 头），请求体中也未指定执行者。` +
        "记录通道需要一个执行者来归因这一行——请指定一个，或从受管席位运行，让身份自动为你派生。",
    }, 400),
  };
}

/**
 * P21——盖在携带身份的行上的闭合纪元溯源联合类型（PM 批准的钉）。共享类型使每个生产者
 * （本辅助函数、转发重盖戳、已记录溯源判定器）都说同一套闭合字母表：
 *   - `transport:v1` —— 派生自传输瓶颈点（本地请求上的 X-OpenRig-Session）。
 *   - `origin-unknown:v1` —— 席位已知，来源实例不可用；跨跳原样携带。
 *   - `relay:v1`     —— 转发后台服务从自己的已认证上下文重盖戳（跨主机）。
 *   - `claimed:v1`   —— 创始人可见表面 UI/MCP 在尚未接通 principal 下的点按（具名延迟）；
 *                       对一个当下执行者的诚实「预验证」。
 * NULL/缺失刻意不作为成员——它保留给清扫前遗留/未盖戳的行，使一条遗留行今天仍可与
 *  `claimed:v1` 点按区分开（纪元边界）。转发必须保留 `claimed:v1`（绝不把它升级成
 * transport:v1/relay:v1——那会把未验证洗成已验证）。
 */
export type IdentityProvenance = "transport:v1" | "relay:v1" | "claimed:v1" | "origin-unknown:v1";

export type ActorWithDeferral =
  // provenance 是非 relay 子集：本辅助函数只产出 transport:v1（头在场）或
  // claimed:v1（延迟）；relay:v1 属于跨主机转发，不是本地路由派生。
  | { ok: true; session: string; provenance: Exclude<IdentityProvenance, "relay:v1"> }
  | { ok: false; response: Response };

/**
 * P21 §2 + 轨道附记 d00c468d —— requireSenderIdentity 的创始人可见表面变体。
 * 头在场 ⇒ 与传输派生完全相同（派生 + 线路取代不一致的 body 声明 + `transport:v1`）；
 * 早先的「不一致即 409」已退役（P18 裁决 A）——线路决定执行者，body 被取代，不是被拒绝。
 * 头缺失 ⇒ body 提供的执行者作为声明的 claimed 纪元变体 `claimed:v1` 记录
 * （在尚未接通 principal 下的一次当下次点按——诚实的「预验证」，区别于遗留 null 行）。
 * 这绝不静默接受——claimed:v1 纪元戳本身就是可见的缺口——也绝不静默中断。
 * body 执行者仍然必需（记录上必须有某个执行者）；它的验证是那个具名缺口，其所有者与接通路径
 * 按每个增量记录。仅用于 PM 裁决的、创始人可见流程会被破坏的表面（d00c468d：ui review
 * approve/resolve/refreeze + useFiles write）；其他一切用 requireSenderIdentity。P18 之后两个
 * 辅助函数共享「投递并标注」语义（都取代不一致 body，都在头缺失时按 claimed:v1 投递）；本辅助函数
 * 剩下的区别是表面范围，不是不同的拒绝行为。
 */
export function resolveActorWithDeferral(
  c: Context,
  opts?: { verb?: string; bodyClaim?: string | null },
): ActorWithDeferral {
  const verb = opts?.verb ?? "此操作";
  const session = c.req.header(SENDER_IDENTITY_HEADER)?.trim();
  const claim = opts?.bodyClaim?.trim();
  if (session) {
    // 传输路径（CLI/DaemonClient 已盖戳头）。P18 清扫：线路取代任何 body 声明——
    // 409 identity_mismatch 在此同样退役，使两个兄弟辅助函数一致：不一致的 body actor 是待取代的噪声，
    // 绝不是要拒绝的攻击。按传输席位身份投递，保留未知来源标记；差异不被持久化。
    return { ok: true, session, provenance: transportProvenance(c) };
  }
  // 头缺失 = 浏览器 UI / MCP 路径 → 具名延迟（绝不中断）：把 body 执行者记录为声明的 claimed
  // 纪元变体 `claimed:v1`（不是 null）。claimed 纪元执行者仍然必需。
  if (!claim) {
    return {
      ok: false,
      response: c.json({
        error: "actor_required",
        message:
          `拒绝${verb}：没有已认证的传输身份（缺少 X-OpenRig-Session 头），也没有可记录的 body 执行者。` +
          "记录通道至少需要一个 claimed 纪元的执行者。",
      }, 400),
    };
  }
  return { ok: true, session: claim, provenance: "claimed:v1" };
}

/**
 * 转发后台服务盖的线路头，携带它为自己正在重盖戳的执行者解析出的溯源，使来源跳记录该执行者
 * 验证情况的真相，而不是仅仅从一个重盖戳的 X-OpenRig-Session 的存在来推断。与存储用同一套 token
 * 字母表（IdentityProvenance）——绝不临时编造字符串。它的缺失是有意义的（见 resolveRecordedProvenance）。
 */
export const IDENTITY_PROVENANCE_HEADER = "x-openrig-provenance";
/** 由转发后台服务设置，标记「此请求经一跳 relay 到达」（执行者在别处派生）。 */
export const RELAY_HEADER = "x-openrig-relay";

/**
 * P21 §4——行上记录的溯源的唯一判定器（轨道 2：有且仅有一个地方能说出 `transport:v1`，且仅当
 * 传输确实在这一跳证明了它）。`identity` 是来自 resolveActorWithDeferral 的本地派生
 * （transport:v1 = 头在场；claimed:v1 = 延迟）。
 *
 * 直接请求（无 relay 跳）：按这一跳证明的原样记录——identity.provenance 原样。
 *
 * 转发请求（转发后台服务重盖了头）：绝不 `transport:v1`——执行者最多是一跳之外被验证的，因此最诚实
 * 的主张是 `relay:v1`，且仅当转发方明确携带了 `transport:v1` 标记。轨道 1——把降级作为默认分支：
 * 任何其他携带值，以及缺失标记（早于本接通的旧转发方），都记录 `claimed:v1`。
 * 注意诚实性的微妙处：缺失标记与转发方声明的 `claimed:v1` 在此不可区分，而这是对的——两者都是
 * 「在此边界未验证」。因此 relay 行上的 `claimed:v1` 意味着「未验证」，绝不意味着来源动作是一次
 * UI 点按。不确定性削弱主张，绝不能增强它——一个 claimed 纪元执行者绝不能跨跳被洗成已验证。
 */
export function resolveRecordedProvenance(
  c: Context,
  identity: { provenance: Exclude<IdentityProvenance, "relay:v1"> },
): IdentityProvenance {
  const relayed = !!c.req.header(RELAY_HEADER)?.trim();
  if (c.req.header(ORIGIN_UNKNOWN_HEADER) === "true") return "origin-unknown:v1";
  if (!relayed) return identity.provenance; // transport:v1（此处已证明）| claimed:v1（延迟）
  const carried = c.req.header(IDENTITY_PROVENANCE_HEADER)?.trim();
  return carried === "origin-unknown:v1" ? carried : carried === "transport:v1" ? "relay:v1" : "claimed:v1";
}
