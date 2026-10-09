/**
 * 人类路由强制规则（OPR.0.4.4.19 FR-4 + FR-5；约定 C6 + C3）。
 *
 * 与 hot-potato-enforcer.ts 并列：这是接在 QueueRepository 写路径上的纯 domain validator，
 * 覆盖 create、handoff、handoff-and-complete 以及 FR-6 park transition，让 CLI、HTTP 和未来
 * UI 都继承同一保证。规则不在 route 层执行，也不在 CLI 层执行。
 *
 * 唯一作用域谓词（PRD §5 的完整触发列表，BR-1）：
 *
 *   tier = 'human-gate'
 *   OR is_human_seat_session(destination_session)
 *   OR (state = 'blocked' AND is_human_seat_session(blocked_on))   [FR-6]
 *
 * 谓词为 FALSE 时，本模块不执行任何校验：普通智能体间队列流量不会新增必填字段、拒绝路径或
 * warning（BR-1 零摩擦边界）。不得仅凭 destination tag、body 文本或 state 扩大触发范围。
 */

/**
 * 精确的人类席位正则，也是唯一 TypeScript 真源。QueueRepository 在构造器中把同一 pattern
 * 注册为 SQLite `is_human_seat_session` 函数，使 SQL 侧与 TS 侧校验无法漂移；同时镜像 UI
 * feed-classifier 的 isHumanSeat。
 */
export const HUMAN_SEAT_SESSION_PATTERN = /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/;

export function isHumanSeatSession(value: unknown): boolean {
  return typeof value === "string" && HUMAN_SEAT_SESSION_PATTERN.test(value);
}

export interface HumanRouteRequest {
  tier: string | null | undefined;
  destinationSession: string;
  summary: string | null | undefined;
  evidenceRef: string | null | undefined;
}

export interface HumanRouteValidationOk {
  ok: true;
  /** §5 谓词命中（item 路由给人类）时为 true。 */
  humanRouted: boolean;
}

export interface HumanRouteValidationErr {
  ok: false;
  code: "human_route_fields_required";
  message: string;
  missingFields: string[];
}

export type HumanRouteValidation = HumanRouteValidationOk | HumanRouteValidationErr;

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

/**
 * 校验新 qitem（create 或 handoff 新建侧）的 C6/C3 结构。只有 item 经 §5 谓词第 1–2 条
 *（human-gate tier、human-seat destination）路由给人类时才触发。park 分支（blocked_on
 * 人类席位）由 blocked-transition 写路径中的 {@link validateHumanPark} 校验。
 */
export function validateHumanRoute(req: HumanRouteRequest): HumanRouteValidation {
  return validateRequiredFields(
    req.tier === "human-gate" || isHumanSeatSession(req.destinationSession),
    req.summary,
    req.evidenceRef,
    "路由给人类的队列 item",
    "请提供 --summary / --evidence-ref（普通智能体间 item 不受影响）。",
  );
}

export interface HumanParkRequest {
  /** item 停放等待的 blocker（qitem id 或 human-seat session）。 */
  blockedOn: string | null | undefined;
  /** park 时的生效值：优先使用 park 调用提供的值，否则回退到 item 已携带的值。 */
  summary: string | null | undefined;
  evidenceRef: string | null | undefined;
}

/**
 * OPR.0.4.4.19 FR-6——第 1 阶段 park 强制规则（§5 谓词第 3 条）。只在 blocker 为人类
 * 席位时触发；阻塞于另一个 qitem（当前正式用法）不新增要求。被 park 的 qitem 自身——id、
 * slice tag、summary——就是“解除后会放行什么”（架构裁定：没有 decision_descriptor 字段）。
 * 强制规则保持对称：正如 FR-7 resolve 要求非空 decision 文本，park 要求 summary + evidence_ref。
 */
export function validateHumanPark(req: HumanParkRequest): HumanRouteValidation {
  return validateRequiredFields(
    isHumanSeatSession(req.blockedOn),
    req.summary,
    req.evidenceRef,
    "把 qitem 停放到人类席位",
    "请在 park 时（zrig queue block --summary --evidence-ref）提供这些字段，或预先写入 item；阻塞于另一个 qitem 不新增要求。",
  );
}

function validateRequiredFields(
  predicateFired: boolean,
  summary: string | null | undefined,
  evidenceRef: string | null | undefined,
  subject: string,
  remedy: string,
): HumanRouteValidation {
  if (!predicateFired) {
    return { ok: true, humanRouted: false };
  }
  const missing: string[] = [];
  if (isBlank(summary)) missing.push("summary");
  if (isBlank(evidenceRef)) missing.push("evidence_ref");
  if (missing.length === 0) {
    return { ok: true, humanRouted: true };
  }
  const why: string[] = [];
  if (missing.includes("summary")) {
    why.push("summary：供人类阅读的 decision 必须使用自然语言（约定 C6）");
  }
  if (missing.includes("evidence_ref")) {
    why.push("evidence_ref：必须向人类提供可持久引用的 artifact 以供判断（约定 C3）");
  }
  return {
    ok: false,
    code: "human_route_fields_required",
    message: `${subject} require${subject.endsWith("s") ? "" : "s"} ${missing.join(" + ")} — ${why.join("; ")}. ${remedy}`,
    missingFields: missing,
  };
}
