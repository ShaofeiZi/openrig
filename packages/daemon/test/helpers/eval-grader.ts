/**
 * slice-07 R6——live-model eval GRADER（确定性 DOOR）。
 *
 * 这是与 scenario runner 不同的 gate：scenario 用 stub 席位询问“结构是否成立？”，eval 则询问
 * “真实席位是否拉取正确 context entry 并遵循它？”此处 DOOR grade 无判断且确定：对捕获 transcript
 * 匹配 expected/forbidden command pattern，并在 loading 时检查 get 先于 action。每个 case 携带已编写
 * 的 1–5 rubric，由可选、延后的 LLM judge 评分，绝不由 grade() 评分（本文件镜像 scenario runner
 * “判断属于 L3，绝不在此”的分层）。
 */

// OPR.0.5.3.5 Q3 bridge（mini-req 8）："behavior" 是 slice-05 的 case kind；delivery 后行为
// probe 在同一 runner 中由同一 door 评分。
export type EvalCategory = "selection" | "loading" | "behavior";

export interface EvalOrder {
  /** 席位必须运行的 context 拉取（正则源码）。 */
  getPattern: string;
  /** context 拉取必须先于的 domain action（正则源码）。 */
  actionPattern: string;
}

export interface EvalCase {
  id: string;
  name: string;
  category: EvalCategory;
  /** 自然语言 prompt，不点名任何动词。 */
  prompt: string;
  /** 必须全部匹配已捕获 transcript 的正则源码。 */
  expectedPatterns: string[];
  /** 绝不能匹配的正则源码。 */
  forbiddenPatterns?: string[];
  /** 仅 loading：get 必须先于 action，且没有先行 get 时不得发生 action。 */
  order?: EvalOrder;
  /** 已编写的 1–5 rubric 文本；可选、延后评判，绝不由 grade() 评判。 */
  rubric?: string;
}

export interface PatternResult {
  pattern: string;
  matched: boolean;
  type: "expected" | "forbidden";
}

export interface OrderResult {
  getIndex: number;
  actionIndex: number;
  ok: boolean;
  reason?: string;
}

export interface GradeResult {
  caseId: string;
  category: EvalCategory;
  /** 确定性 DOOR grade（CE-08 thinning 消费的结果）。 */
  pass: boolean;
  patternResults: PatternResult[];
  order?: OrderResult;
}

/** 正则源码在 transcript 中首次匹配的索引；不存在时为 -1。 */
function firstIndex(source: string, transcript: string): number {
  const m = new RegExp(source).exec(transcript);
  return m ? m.index : -1;
}

/**
 * 根据捕获的 agent transcript 对一个 case 评分。纯且确定，即 DOOR。
 *
 * Selection door = 每个 expectedPattern 都匹配，且没有 forbiddenPattern 匹配。Loading door 还要求
 * get-before-action 顺序：get 必须已发生，任何 domain action 都必须位于其后（没有先行 get 的 action
 * 属于“未加载便行动”失败）。此处绝不为 1–5 rubric 评分。
 */
export function grade(evalCase: EvalCase, transcript: string): GradeResult {
  const patternResults: PatternResult[] = [];

  let allExpectedMatched = true;
  for (const source of evalCase.expectedPatterns) {
    const matched = new RegExp(source).test(transcript);
    patternResults.push({ pattern: source, matched, type: "expected" });
    if (!matched) allExpectedMatched = false;
  }

  let noForbiddenMatched = true;
  for (const source of evalCase.forbiddenPatterns ?? []) {
    const matched = new RegExp(source).test(transcript);
    patternResults.push({ pattern: source, matched, type: "forbidden" });
    if (matched) noForbiddenMatched = false;
  }

  const patternsOk = allExpectedMatched && noForbiddenMatched;

  let order: OrderResult | undefined;
  let orderOk = true;
  if (evalCase.order) {
    const getIndex = firstIndex(evalCase.order.getPattern, transcript);
    const actionIndex = firstIndex(evalCase.order.actionPattern, transcript);
    orderOk = getIndex !== -1 && (actionIndex === -1 || getIndex < actionIndex);
    const reason = orderOk
      ? undefined
      : getIndex === -1
        ? "执行 domain action 前未运行 `rig context get`"
        : "domain action 早于 context get";
    order = { getIndex, actionIndex, ok: orderOk, reason };
  }

  return {
    caseId: evalCase.id,
    category: evalCase.category,
    pass: patternsOk && orderOk,
    patternResults,
    order,
  };
}
