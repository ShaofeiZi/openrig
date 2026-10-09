/**
 * OPR.0.4.6.WF3 FR-5 — 对后台服务具名拒绝的"是什么/为什么/怎么修"三段式渲染
 * （本项目的三段式结构；遵循 clig.dev 的"为人类改写"原则）。仅作用于人类
 * 阅读模式：`--json` 原样保留后台服务的原始报文，字节不变，脚本仍可依赖稳定
 * 错误码；退出码不变（1=4xx / 2=5xx，外加 FR-1 的结果码）。
 *
 * 无法识别的错误报文回退为原始 JSON 渲染——本模块只改写它真正理解的部分。
 */

export interface ThreePartRejection {
  fact: string;
  consequence: string;
  action: string;
}

interface RejectionBody {
  error?: string;
  message?: string;
  instanceId?: string;
  expectedVersion?: number;
  actualVersion?: number;
  allowedExits?: string[];
  [key: string]: unknown;
}

/**
 * 把可识别的后台服务拒绝映射为三段式结构；报文不是具名拒绝时返回 null
 * （调用方回退为原始 JSON）。
 */
export function describeDaemonRejection(body: unknown, instanceHint?: string): ThreePartRejection | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as RejectionBody;
  if (typeof b.error !== "string") return null;
  const instance = typeof b.instanceId === "string" ? b.instanceId : instanceHint;
  const traceCmd = instance ? `zrig workflow trace ${instance}` : "zrig workflow trace <instance>";
  const showCmd = instance ? `zrig workflow show ${instance}` : "zrig workflow show <instance>";

  switch (b.error) {
    case "packet_not_on_frontier":
      return {
        fact: `该数据包不在实例前沿上${b.message ? `（${b.message}）` : ""}。`,
        consequence:
          "它所属的步骤已经关闭、重放或改路——前沿已经越过它，因此本次关闭无法生效。",
        action: `查看实例当前真实位置：${traceCmd}`,
      };
    case "instance_not_active": {
      const state = typeof b.message === "string" && b.message.length > 0 ? b.message : "未激活";
      return {
        fact: `实例当前为"${state}"状态。`,
        consequence: "只有激活状态的实例才能继续推进；终态与等待状态都会拒绝投影。",
        // OPR.0.4.6.WF5 FR-4：承诺过的指针升级——resume 现在是真的。
        // 失败的实例可重新驱动；其他终态仍要求先查看。
        action: `若处于失败状态，可重新驱动：zrig workflow resume <instanceId> --actor-session <你的会话>。否则先查看：${showCmd}`,
      };
    }
    case "instance_not_failed":
      return {
        fact: "实例当前不在失败状态。",
        consequence: "resume 只重新驱动失败状态的实例——激活状态无需 resume，等待状态会通过其保留的前沿数据包（project）继续，而不是重新驱动。",
        action: `先查看真实状态：${showCmd}`,
      };
    case "resume_step_unrecoverable":
      return {
        fact: "该实例没有记录可重新绑定的失败步骤。",
        consequence: "这是 R2 之前的数据行，没有持久化的步骤绑定；重新驱动没有锚点。",
        action: "重新实例化一次新的工作流运行（本实例的轨迹会保留备查）。",
      };
    case "resume_step_missing_from_spec":
      return {
        fact: "失败步骤在已缓存的工作流规格中已不存在。",
        consequence: "该实例失败后规格发生了漂移；重新绑定会路由到工作流已不再声明的步骤。",
        action: "在规格中恢复该步骤（重新校验以刷新缓存），或实例化新的运行。",
      };
    case "instance_version_conflict":
      return {
        fact: `有并发写入方先推进了该实例（期望版本 ${b.expectedVersion ?? "?"}，实际 ${b.actualVersion ?? "?"}）。`,
        consequence: "本次投影已整体回滚，没有写入任何部分状态。",
        action: `重新读取当前状态（${traceCmd}），再基于它重试。`,
      };
    case "exit_not_allowed": {
      const allowed = Array.isArray(b.allowedExits) && b.allowedExits.length > 0 ? b.allowedExits.join(" | ") : null;
      return {
        fact: `该出口不被此步骤允许${b.message ? `（${b.message}）` : ""}。`,
        consequence: "步骤声明了它接受哪些出口；后台服务在任何状态变更之前就拒绝了本次关闭。",
        action: allowed ? `可选其一：${allowed}。` : `在规格中查看该步骤允许的出口，然后重新关闭：${traceCmd}`,
      };
    }
    case "no_next_step":
      return {
        fact: `工作流在该出口下没有下一步${b.message ? `（${b.message}）` : ""}。`,
        consequence: "这次交接没有可路由的去向；关闭被整体拒绝。",
        action: `检查规格中该步骤的路由，或以终态关闭（--exit done | failed）。查看：${traceCmd}`,
      };
    case "next_owner_unresolved":
      return {
        fact: `无法解析下一步的负责人${b.message ? `（${b.message}）` : ""}。`,
        consequence: "投影数据包需要一个目标席位；当前没有任何路由。",
        action: "传入 --next-owner <会话>，或修正规格中该步骤的 suggested_roles。",
      };
    case "instance_not_found":
      return {
        fact: `没有该工作流实例${instance ? `：${instance}` : ""}。`,
        consequence: "未读取或修改任何内容。",
        action: "列出实例：zrig workflow list",
      };
    default:
      return null;
  }
}

/** 把三段式结构渲染为 stderr 行（emit3PartError 结构）。 */
export function formatThreePart(rej: ThreePartRejection): string[] {
  return [`错误：${rej.fact}`, rej.consequence, rej.action];
}
