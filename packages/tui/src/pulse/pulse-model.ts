import { isHumanSeatSessionRef } from "@openrig/daemon/attention";
// PULSE 视图数据模型（5.2 Wave B）。可复用的视图局部模型，使 PULSE
// 行/分区渲染器（pulse/render-pulse.ts）可共享——故障诊断复用
// 相同渲染器（plan §crash-cart-pre-work）。增量 1 从
// 静态演示夹具填充此模型，复现批准 mock 的确切行；增量
// 2-3 从已交付后台服务读取构建（无新表面）。
import type { Token } from "../theme.js";
import type { Action, FleetSnapshot, QueueRead, SeatActivitySummary } from "../types.js";
import { findAgentBySession } from "../state.js";

/** 一行异常：强调字形 + 粗体主体 + 普通声明 + 暗色元数据。 */
export interface PulseException {
  glyph: string; // ● / ◌ / ⧗ 按 mock
  token: Token; // 行强调（见 PULSE_SECTION_TOKENS）
  subject: string; // 粗体主体（mock <b>）
  claim: string; // 普通声明文本
  meta: string; // 暗色尾部元数据（年龄 / 提示）
}

export interface PulseExceptionSection {
  glyph: string; // ▲ / ◌ / ⧗ 头部字形
  token: Token;
  label: string; // 需要你 / 停驻待接力 / 被智能体阻塞
  rows: PulseException[];
  /** 延迟（尚未服务）读取的诚实底线占位：设置时，
   * 分区渲染其头部不带 (n) 计数和一行暗色行
   * 携带此文本——显式"读取挂起"过渡态形式，
   * 而非运行联接（其零结果为静默）。见 buildPulseModel 停驻。 */
  pending?: string;
}

export interface PulseLaneRow {
  glyph: string; // ● / ✓ / ○
  token: Token;
  time?: string; // 暗色时间（刚完成）
  label: string; // 席位+工作 / 标签
  selected?: boolean; // mock .sel 行
  /** incr-5 动作预算：此 NOW 席位在
   * 一次性闪烁窗口内产生新窗格输出（已服务 terminalActive false→true 起始，键于
   * 表行闪烁所用的相同智能体键）。由 renderPulseScreen 从
   * 刷新拥有者的 rowFlashes 设置；逐格绘制（仅此格反显，
   * 绝不压缩兄弟格）。减弱动作 / 窗口过期清除它。 */
  flashed?: boolean;
  /** incr-4 钻入：此行上回车/点击派发的动作。出现在
   * 每个真实泳道行（不在 "…" 溢出标记上，后者非实体）。
   * 关于拓扑中可解析席位的行钻取到该智能体
   * （恢复紧凑泳道标签丢弃的完整身份）；不可解析
   * 席位降级为通知，揭示完整身份——诚实，绝不
   * 死键。无动作的行不注册为选择目标。 */
  action?: Action;
}

export interface PulseLane {
  label: string; // 现在 / 刚完成 / 下一个
  count: number; // 头部 (n)——必须等于 rows.length 所指（诚实底线）
  rows: PulseLaneRow[];
}

export interface PulseModel {
  exceptions: PulseExceptionSection[]; // 空分区完全省略（空条即静默）
  lanes: [PulseLane, PulseLane, PulseLane]; // 现在，刚完成，下一个
  footer: { active: number; parked: number; waitingYou: number; updatedAgo: string };
}

// mock 分区强调（▲ 错 / ◌ 警 / ⧗ 信息）。D4 已解决（锁定拥有者，
// 2026-08-06，选项 (a)）：承载 mock
// 确切 #8fb8d8 的 info 类语义标记已加入主题（info 类，可复用——非受阻蓝），
// 使 `⧗ 阻塞` 直接渲染 mock 蓝。字形/标签/顺序最终确定。
export const PULSE_INFO_TOKEN: Token = "info";

/** 增量-1 静态夹具——批准 mock 的确切行（渲染契约）。 */
export function demoPulseModel(): PulseModel {
  return {
    exceptions: [
      {
        glyph: "▲",
        token: "error",
        label: "需要你",
        rows: [
          { glyph: "●", token: "error", subject: "push-go", claim: " — 0.5.0 裁剪包就绪 · 等待你", meta: " · 22 分钟" },
          { glyph: "●", token: "warn", subject: "样式裁决", claim: " — slice-20 路由像素 · 等待你", meta: " · 3 小时" },
        ],
      },
      {
        glyph: "◌",
        token: "warn",
        label: "停驻待接力",
        rows: [
          { glyph: "◌", token: "warn", subject: "dev.qa", claim: " · qitem 8f3a… 进行中 47 分钟空闲，无交接", meta: " → 回车：转录检查" },
        ],
      },
      {
        glyph: "⧗",
        token: PULSE_INFO_TOKEN,
        label: "被智能体阻塞",
        rows: [
          { glyph: "⧗", token: PULSE_INFO_TOKEN, subject: "dev50.driver", claim: " 被 review-r1 阻塞 · \"51209941 的终端裁决\"", meta: " · 1 小时" },
        ],
      },
    ],
    lanes: [
      {
        label: "现在",
        count: 4,
        rows: [
          { glyph: "●", token: "ok", label: "dev.impl  slice 51-01 桩" },
          { glyph: "●", token: "ok", label: "orch.lead 折叠收据" },
          { glyph: "●", token: "ok", label: "qa.seat   矩阵腿 B" },
          { glyph: "●", token: "ok", label: "oversight.watch  令牌清扫", selected: true },
        ],
      },
      {
        label: "刚完成",
        count: 3,
        rows: [
          { glyph: "✓", token: "ok", time: "14:02", label: "slice-03 收尾" },
          { glyph: "✓", token: "ok", time: "13:44", label: "修复折叠" },
          { glyph: "✓", token: "ok", time: "13:10", label: "终端清除" },
        ],
      },
      {
        label: "下一个",
        count: 5,
        rows: [
          { glyph: "○", token: "dim", label: "51-02 场景运行器" },
          { glyph: "○", token: "dim", label: "RM 仪式" },
          { glyph: "○", token: "dim", label: "51-03 种子场景" },
          { glyph: "○", token: "dim", label: "…" },
        ],
      },
    ],
    footer: { active: 4, parked: 1, waitingYou: 2, updatedAgo: "2 秒前" },
  };
}

// 与队列选择共享；网关注入仍是独立决策。
export function isHumanSeatSession(value: string | null | undefined): boolean {
  return typeof value === "string" && isHumanSeatSessionRef(value);
}

/** 异常行暗色元数据的粗略人类年龄。从已服务
 * 时间戳派生，相对于调用者时钟；缺失/不可解析戳渲染
 * 为 ""（诚实未知——绝不伪造年龄）。 */
function ageLabel(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  return `${Math.floor(hr / 24)} 天`;
}

/** 正文首个非空行，修剪——需要你主体回退。 */
function bodyHead(body: string): string {
  return (body.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}

/** mock 需要你行所用的主体/详情边界："<谁/什么> — <详情>"
 * （空格，EM DASH U+2014，空格）。创建者 Option-1 口味裁决：谁/什么
 * 主体以粗体在前，详情在后普通。 */
const NEEDS_SUBJECT_SEP = " — ";

/** ▲ 需要你行——待关注读取即人类面向集合（后台服务过滤）；
 * 主体来自摘要，回退正文首行；年龄来自 claimedAt（回退 tsUpdated）。
 *
 * 创建者 Option-1 口味裁决（解决 incr-2 粗体/普通披露）：
 * 谁/什么主体以粗体在前，详情在后普通。我们按已服务摘要
 * 提供的 " — " 边界分割（mock 自身的主体/详情约定）——
 * 主体 = 之前（粗体经 renderExceptionSection），声明 = 之后
 * （普通，保留分隔符使阅读自然）。不带
 * 边界的摘要整体渲染为主体：诚实，无扁平摘要
 * 不支持的合成。（每行保证主体需要已服务主体字段或
 * 撰写摘要约定——已服务数据问题，非此增量。） */
function needsRows(attention: QueueRead[], nowMs: number): PulseException[] {
  return attention.map((q) => {
    const age = ageLabel(q.claimedAt ?? q.tsUpdated, nowMs);
    const full = q.summary ?? (bodyHead(q.body) || q.destinationSession);
    const sep = full.indexOf(NEEDS_SUBJECT_SEP);
    return {
      glyph: "●",
      token: "error" as Token,
      subject: sep > 0 ? full.slice(0, sep) : full,
      claim: sep > 0 ? full.slice(sep) : "",
      meta: age ? ` · ${age}` : "",
    };
  });
}

/** ⧗ 被智能体阻塞行——过滤 state=blocked 读取为非人类
 * 阻塞者（人类阻塞已出现在需要你下），然后命名阻塞
 * 智能体。blockedOn 是智能体阻塞的 qitem 指针（人类停驻仅为
 * 会话），因此智能体是阻塞 qitem 的拥有者——hydrate 解析它
 * 为 blockerSession（标签==所指，创建者捕获类）。回退到
 * 未解析时的原始 blockedOn（门名 / 查找未命中）——诚实，绝不
 * 伪造。渲染：被阻塞席位 · "被"智能体"阻塞" · 暗色（原因）· 年龄。 */
function blockedRows(blocked: QueueRead[], nowMs: number): PulseException[] {
  return blocked
    // 排除人类停驻，无论它在 blockedOn 中命名人类（会话形式）
    // 还是解析为人类拥有者——那些属于需要你。
    .filter((q) => !isHumanSeatSession(q.blockedOn) && !isHumanSeatSession(q.blockerSession))
    .map((q) => {
      const age = ageLabel(q.claimedAt ?? q.tsUpdated, nowMs);
      const reason = q.summary ?? bodyHead(q.body);
      const meta = [reason, age].filter(Boolean).join(" · ");
      const blocker = q.blockerSession ?? q.blockedOn ?? "—";
      return {
        glyph: "⧗",
        token: PULSE_INFO_TOKEN,
        subject: q.destinationSession,
        claim: ` 被 ${blocker} 阻塞`,
        meta: meta ? ` · ${meta}` : "",
      };
    });
}

/** 停驻行的短 qitem 引用——尾部 id 段，4 字符 +
 * 省略号（mock "8f3a…"）。绝不用完整指针（标签==所指诚实）。 */
function qitemShort(qitemId: string): string {
  const tail = qitemId.split("-").pop() ?? qitemId;
  return `${tail.slice(0, 4)}…`;
}

/** ◌ 停驻待接力行——过早停驻联接（IMPL-PLAN §exceptions：
 * 进行中 qitem ∧ 空闲拥有者 ∧ 无交接——队列 ⋈ ps/活动）。"空闲
 * 拥有者"是已交付 ps/活动空闲布尔（terminalActive===false）；
 * null 信号是诚实未知并排除（绝不假定空闲）。空闲
 * 时长是视图在此从拥有者原始 lastActivityAt（arch
 * 3a947fb1）+ 读取者时钟（nowMs）派生——渲染器侧测试时钟接缝，
 * 区别于 .cjs OPENRIG_TEST_CLOCK_NEV 环境时钟。渲染：拥有者 ·
 * qitem-短 · 空闲时长 · 无交接 · 钻取提示。 */
function parkedRows(
  inProgress: QueueRead[],
  seatBySession: Map<string, SeatActivitySummary>,
  nowMs: number,
): PulseException[] {
  const out: PulseException[] = [];
  for (const q of inProgress) {
    if (q.state !== "in-progress") continue;       // 防御：读取已是 state=in-progress
    if (q.handedOffTo != null) continue;           // 已交接 → 非搁浅接力棒
    const seat = seatBySession.get(q.destinationSession);
    if (!seat || seat.terminalActive !== false) continue; // 仅空闲拥有者（null ≠ 空闲——诚实未知）
    const idle = ageLabel(seat.lastActivityAt, nowMs);
    // r1 带（incr-3）：假活跃席位携带记录，因此携带
    // lastActivityAt（同观测梯）→ 此回退在折叠后不可达，
    // 纯粹防御若年龄
    // 缺失/不可解析时的裸 "in-progress  空闲"——绝不伪造时长。
    const idleText = idle ? `${idle}空闲` : "空闲（年龄未知）";
    out.push({
      glyph: "◌",
      token: "warn",
      subject: q.destinationSession,
      claim: ` · qitem ${qitemShort(q.qitemId)} 进行中 ${idleText}，无交接`,
      meta: " → 回车：转录检查",
    });
  }
  return out;
}

/** 每泳道显示上限。泳道绝不倾倒无界集；超过
 * 上限的溢出显式信号（下一个渲染 "…" 标记并带真实总数
 * 在头部）——绝不静默截断（见 [[pagination-terminates-on-data-not-budgets]]）。 */
const LANE_ROW_CAP = 5;

/** 刚完成转换时间的绝对 UTC 时钟标签（如 "11:44"）。
 * UTC 保持确定性 + 时区无关；不可解析戳渲染 ""。 */
function hhmm(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 以席位会话为键的泳道行钻入动作。可解析
 * 在拓扑中的席位钻取到该智能体（已交付智能体钻取——恢复
 * 紧凑泳道标签丢弃的完整身份，与点击智能体
 * 任意位置同等）；不可解析席位（远程/本地拓扑缺失）降级
 * 为通知仍揭示完整身份——诚实，绝不死键。
 * 仅已交付读取：无发明 qitem-detail 端点（缺失 detail 读取是
 * 路由发现，非即兴表面）。 */
function seatRowAction(snap: FleetSnapshot, session: string, fullDetail: string): Action {
  const found = findAgentBySession(snap, session);
  if (found) return { type: "drill", resource: "agent", name: found.agent.name, target: { host: found.host.name, rig: found.rig.name, pod: found.pod.name } };
  return { type: "notice", message: fullDetail };
}

/** ● 现在行——运行中席位有活跃工作：每个活跃席位
 * （terminalActive===true）联接其进行中 qitem（IMPL-PLAN §lanes）。
 * null/false-活动拥有者在此排除（空闲 → 停驻；null → 诚实
 * 未知）。无进行中 qitem 的活跃席位仍运行，因此
 * 裸显示（席位是承重所指；其工作是上下文）。
 * 泳道标签是席位的紧凑 logicalId（r1 mock 权威裁决——短
 * 规范形式在泳道，完整会话在异常）；完整会话
 * 通过行动作在钻入时恢复。两个输入已乘 incr-2b 的
 * 快照——无新读取。 */
function nowRows(seatActivity: SeatActivitySummary[], inProgress: QueueRead[], snap: FleetSnapshot): PulseLaneRow[] {
  const workBySession = new Map<string, QueueRead>();
  for (const q of inProgress) if (!workBySession.has(q.destinationSession)) workBySession.set(q.destinationSession, q);
  const out: PulseLaneRow[] = [];
  for (const seat of seatActivity) {
    if (seat.terminalActive !== true) continue; // 仅活跃（null ≠ 活跃——诚实未知）
    const q = workBySession.get(seat.session);
    const work = q ? (q.summary ?? bodyHead(q.body)) : "";
    // 紧凑标签 = logicalId；完整会话在钻取动作中。
    const label = work ? `${seat.logicalId}  ${work}` : seat.logicalId;
    const fullDetail = work ? `${seat.session} · ${work}` : seat.session;
    out.push({ glyph: "●", token: "ok", label, action: seatRowAction(snap, seat.session, fullDetail) });
  }
  return out;
}

/** ✓ 刚完成行——近期终端转换，最新完成在前。
 * 已交付 /list 读取服务 ts_created 顺序，因此我们按 tsUpdated
 * 降序重排（完成时间）并上限到近期窗口（计数 == 渲染——这是
 * 本质上窗口，非总数）。时间 = 转换的 tsUpdated（HH:MM）。 */
function finishedRows(recent: QueueRead[], cap: number, snap: FleetSnapshot): PulseLaneRow[] {
  return [...recent]
    .sort((a, b) => Date.parse(b.tsUpdated) - Date.parse(a.tsUpdated))
    .slice(0, cap)
    .map((q) => {
      const label = q.summary ?? bodyHead(q.body);
      // 钻取到完成它的席位（destinationSession → 智能体）。
      return { glyph: "✓", token: "ok" as Token, time: hhmm(q.tsUpdated), label, action: seatRowAction(snap, q.destinationSession, `${q.destinationSession} · ${label}`) };
    });
}

/** ○ 下一个泳道——未认领待办积压。以后台服务的
 * 已服务顺序携带（ts_created 降序——逐字；按已服务优先级
 * 重排后台服务不服务的发明优先级正是禁止的客户端
 * 合成）。超过显示上限后最后一行是 "…" 溢出标记，
 * 头部计数是真实总数（诚实底线——计数是所指
 * 总数，行是渲染子集）。 */
function upNextLane(pending: QueueRead[], cap: number, snap: FleetSnapshot): PulseLane {
  const unclaimed = pending.filter((q) => q.claimedAt == null); // 仅未认领（claimedAt null）
  const toRow = (q: QueueRead): PulseLaneRow => {
    const label = q.summary ?? bodyHead(q.body);
    // 钻取到工作目的地席位（destinationSession → 智能体）。
    return { glyph: "○", token: "dim", label, action: seatRowAction(snap, q.destinationSession, `${q.destinationSession} · ${label}`) };
  };
  // 溢出标记非实体 → 它不带动作（绝不选择目标）。
  const rows = unclaimed.length > cap
    ? [...unclaimed.slice(0, cap - 1).map(toRow), { glyph: "○", token: "dim" as Token, label: "…" }]
    : unclaimed.map(toRow);
  return { label: "下一个", count: unclaimed.length, rows };
}

/** 增量-3 实时构建器——异常分区（incr 2/2b）加三个
 * 泳道 + 页脚，全部来自水合快照的已服务读取。实时联接
 * 对异常分区遵守空条即静默（产生零的运行联接
 * 省略）；泳道始终渲染（零行泳道是诚实
 * "(0)"，非静默——空积压即信息）。页脚计数
 * 从构建模型派生，使头部数字绝不偏离其
 * 所指集（标签==所指）。demoPulseModel 仅保留为静态
 * 渲染器夹具（空间契约测试），不再是此构建器的源。 */
export function buildPulseModel(snap: FleetSnapshot, nowMs: number = Date.now()): PulseModel {
  const exceptions: PulseExceptionSection[] = [];

  const needs = needsRows(snap.attention, nowMs);
  // 空条即静默：零项运行联接省略（静默 == 零）
  if (needs.length > 0) exceptions.push({ glyph: "▲", token: "error", label: "需要你", rows: needs });

  // ◌ 停驻待接力——现在是实时运行联接（arch 3a947fb1 落地拥有者
  // 空闲年龄事实）：进行中 qitem 其拥有者空闲且未交接，
  // 空闲时长在渲染器派生。零停驻 = 静默（省略），如
  // 其他实时联接——incr-2 "读取挂起"占位已退役。
  const seatBySession = new Map(snap.seatActivity.map((s) => [s.session, s]));
  const parked = parkedRows(snap.inProgress, seatBySession, nowMs);
  if (parked.length > 0) exceptions.push({ glyph: "◌", token: "warn", label: "停驻待接力", rows: parked });

  const blocked = blockedRows(snap.blocked, nowMs);
  if (blocked.length > 0) exceptions.push({ glyph: "⧗", token: PULSE_INFO_TOKEN, label: "被智能体阻塞", rows: blocked });

  const now = nowRows(snap.seatActivity, snap.inProgress, snap);
  const finished = finishedRows(snap.recentlyFinished, LANE_ROW_CAP, snap);
  const lanes: [PulseLane, PulseLane, PulseLane] = [
    { label: "现在", count: now.length, rows: now },
    { label: "刚完成", count: finished.length, rows: finished },
    upNextLane(snap.pending, LANE_ROW_CAP, snap),
  ];

  // 页脚计数即构建的所指集（标签==所指——绝不第二
  // 事实源）。"已更新"新鲜度来自 TUI 自身水合戳；
  // 缺失（首次水合前）→ 诚实 "—"，绝不伪造年龄。
  const parkedCount = exceptions.find((s) => s.label === "停驻待接力")?.rows.length ?? 0;
  const waitingYou = exceptions.find((s) => s.label === "需要你")?.rows.length ?? 0;
  const ago = ageLabel(snap.hydratedAt, nowMs);
  const footer = { active: now.length, parked: parkedCount, waitingYou, updatedAgo: ago ? `${ago}前` : "—" };

  return { exceptions, lanes, footer };
}
