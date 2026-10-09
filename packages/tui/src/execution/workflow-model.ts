import { DEFAULT_TIME_ZONE, displayTime } from "../time.js";
import { strWidth } from "../text-width.js";
import { fieldLine, listItem, sectionRule, wrapDetailLines, type ContentLine } from "../detail.js";
import type { Action } from "../types.js";
import type { ExecutionViewSnap } from "./execution-model.js";

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
const LIFECYCLE_WORD: Record<string, string> = { waiting: "等待", active: "活跃", done: "完成", aborted: "已中止", failed: "失败", pending: "待处理", completed: "已完成" };
// 收据状态仅做展示层中文映射，底层枚举值保持不变
const RECEIPT_WORD: Record<string, string> = { recorded: "已记录", missing: "缺失", "not-required": "无需" };
const text = (v: unknown, missing = "未记录"): string => {
  if (typeof v === "string" && v.length) return LIFECYCLE_WORD[v] ?? v;
  return v == null ? missing : JSON.stringify(v);
};
const open = (key: string): Action => ({ type: "execution-open", key });
const words = (v: unknown) => text(v, "未知步骤").replaceAll("-", " ");
const packets = (instance: Row) => rows(instance.frontier_packets);
const title = (instance: Row) => text(instance.description, "任务目标生命周期");
const field = (label: string, value: unknown, link?: Action) => fieldLine({ label, value: text(value), ...(link ? { link } : {}) });

export function workflowOverview(execution: ExecutionViewSnap, width: number): ContentLine[] {
  const instances = execution.lifecycle_instances;
  if (!instances?.length) return [{ text: "" }, { text: instances ? "  工作流：此任务目标未绑定" : "  工作流：投影不可用" }];
  const lines: ContentLine[] = [{ text: "" }, sectionRule("工作流", width)];
  for (const instance of [...instances].sort((a, b) => Number(["completed", "aborted"].includes(text(a.status))) - Number(["completed", "aborted"].includes(text(b.status))))) {
    lines.push(listItem(`${title(instance)} · ${text(instance.status, "未知")}`, open(`workflow:${instance.instance_id}`)));
    for (const packet of packets(instance)) {
      lines.push(listItem(`${words(packet.step_id)} · ${text(packet.queue_state)} · ${text(packet.owner)}`, open(`packet:${packet.packet_id}`), 4));
      const transition = row(packet.latest_transition);
      if (packet.queue_state === "blocked") lines.push({ text: `      等待：${text(row(packet.blocker).summary ?? transition.transition_note, "原因未记录；打开阻塞者的工作并唤醒")}` });
    }
  }
  return wrapDetailLines(lines, width);
}

/** 所有认领都是服务状态或归因记录。此处不裁决任何收据。 */
export function workflowDetail(execution: ExecutionViewSnap, key: string, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] | null {
  const instances = execution.lifecycle_instances ?? [];
  const packetId = key.startsWith("packet:") ? key.slice(7) : null;
  const instance = packetId ? instances.find((i) => packets(i).some((p) => p.packet_id === packetId)) : instances.find((i) => `workflow:${i.instance_id}` === key);
  if (!instance) return null;
  const identity = row(instance.identity);
  const packet = packetId ? packets(instance).find((p) => p.packet_id === packetId)! : null;
  const lines: ContentLine[] = [
    { text: packet ? `工作 · ${words(packet.step_id)}` : `${title(instance)} · ${text(instance.status)}` },
    field("任务目标", execution.mission, { type: "scopes-mission-open", mission: execution.mission }),
    field("项目", identity.project),
    field("截至", displayTime(execution.derived_at, timeZone)),
  ];
  if (packet) {
    const transition = row(packet.latest_transition);
    const wake = row(packet.wake);
    const schedule = row(packet.wake_schedule);
    lines.push(field("目的", packet.objective), field("摘要", packet.summary), field("状态", packet.queue_state));
    // 渲染的所有者保持规范地址；导航使用现有
    // 解析器，它命名不可用/歧义席位而非选择双胞胎。
    lines.push(field("所有者", packet.owner, { type: "drill", resource: "agent", name: text(packet.owner) }));
    lines.push(sectionRule("等待和继续", width), field("最后更改", transition.transition_note), field("记录者", transition.actor_session), field("于", displayTime(transition.ts, timeZone)));
    if (packet.blocked_on) lines.push(field("阻塞于", packet.blocked_on));
    if (packet.blocker) {
      const blocker = row(packet.blocker);
      lines.push(field("等待", blocker.summary), field("阻塞者状态", blocker.state), field("阻塞者所有者", blocker.destination_session), field("证据", blocker.evidence_ref));
    }
    lines.push(field("唤醒", packet.wake ? `${text(wake.kind)} · ${text(wake.phase)} · ${wake.live ? "实时" : "非实时"}${wake.unconsumed ? " · 触发但未拾取" : ""}` : "无记录"));
    if (packet.wake) lines.push(field("唤醒引用", wake.ref), field("投递", wake.deliveryStatus));
    if (wake.expiresAt) lines.push(field("到期", displayTime(wake.expiresAt, timeZone)));
    if (packet.wake_schedule) lines.push(field("策略", schedule.policy), field("节奏", `${text(schedule.interval_seconds)} 秒（检查，非保证投递）`), field("上次检查", displayTime(schedule.last_evaluation_at, timeZone)));
    lines.push(sectionRule("下一步动作", width), ...actionLines(text(packet.targeted_action), width));
    if (packet.gate) lines.push(field("门控", packet.gate));
    if (packet.acceptance) lines.push(field("决定", packet.acceptance));
    lines.push(field("证据", packet.evidence_ref), field("包", packet.packet_id), listItem("工作流、义务和绑定来源", open(`workflow:${instance.instance_id}`)));
  } else {
    lines.push(sectionRule("当前工作", width));
    for (const current of packets(instance)) lines.push(listItem(`${words(current.step_id)} · ${text(current.queue_state)} · ${text(current.owner)}`, open(`packet:${current.packet_id}`)));
    if (!packets(instance).length) lines.push({ text: `  无当前工作包 · 工作流 ${text(instance.status)}。这是生命周期状态，非产品验收。` });
    const steps = rows(instance.steps);
    const obligations = rows(instance.boundary_obligations);
    const hasBoundary = obligations.some((o) => o.stepId === "release-boundary");
    lines.push(sectionRule(hasBoundary ? "发布仪式和发布后整理" : "义务", width), { text: "  已记录收据意味着已记录归因证据引用；它不建立验收。" });
    for (const obligation of obligations) {
      const label = obligation.stepId === "release-boundary" ? "发布后整理 · 发布边界" : obligation.stepId === "activate-successor" ? "可选后继 · 激活后继" : words(obligation.stepId);
      lines.push({ text: `  ${label} · ${obligation.required ? "必需" : "扩展"} · ${text(obligation.state)} · 收据 ${RECEIPT_WORD[text(obligation.receiptState)] ?? text(obligation.receiptState)}` });
      const step = steps.find((s) => s.id === obligation.stepId);
      if (step?.objective) lines.push({ text: `    ${text(step.objective)}` });
      const receipt = row(obligation.receipt);
      if (obligation.receipt) lines.push(field("证据", receipt.evidenceRef), field("记录者", receipt.actorSession), field("于", displayTime(receipt.closedAt, timeZone)));
    }
    const dependencies = rows(instance.dependencies);
    // 不从任意步骤名推断后继语义。显示
    // 编译器声明的依赖图和当前工作流末尾。
    lines.push(sectionRule("继续", width));
    if (hasBoundary) lines.push({ text: obligations.some((o) => o.stepId === "activate-successor") ? "  后继激活在发布边界后编写。" : "  无后继激活步骤绑定。此工作流在其自己的发布边界后结束。" });
    for (const dependency of dependencies) lines.push(field(words(dependency.stepId), dependency.dependsOn));
    lines.push({ text: "  可选后继独立于此工作流的完成；仅上面编写的步骤是义务。" });
    lines.push(sectionRule("绑定图和来源", width), field("工作流", instance.workflow_name), field("版本", instance.workflow_version), field("图", instance.graph_source), { text: instance.reconciliation ? "  绑定来源收据已保留；下面的编写/运行比较解释当前更改。" : "  来源在编译时绑定。当前源字节尚未比较。" });
    for (const source of rows(instance.sources)) {
      if (source.kind === "slice" && typeof source.path === "string") {
        const parts = source.path.split("/");
        const slice = parts.at(-2);
        if (slice) lines.push(listItem(`切片 ${slice}`, { type: "scopes-open", mission: execution.mission, slice }));
      }
      for (const [label, value] of Object.entries(source)) lines.push(field(label, value));
    }
    const comparison = row(instance.reconciliation);
    if (instance.reconciliation) {
      lines.push(sectionRule("已编写和运行计划", width), field("比较", comparison.status),
        field("绑定输入", comparison.boundDigest), field("编写输入", comparison.proposedDigest),
        field("组合", row(comparison.composition).explanation));
      if (comparison.status === "source-only") lines.push({ text: "  源字节已更改；可执行步骤/策略不变。无已完成工作需要重放。" });
      for (const reason of Array.isArray(comparison.reasons) ? comparison.reasons : []) lines.push(field("原因", reason));
      lines.push(...actionLines(text(comparison.nextAction), width));
      if (comparison.applyCommand) lines.push(...actionLines(text(comparison.applyCommand), width));
      lines.push({ text: "  先检查；计划可能更改。丢失的响应可用 zrig workflow operation <键> 恢复。" });
    }
    lines.push(field("输入摘要", instance.compiled_input_digest));
    for (const failure of rows(instance.failure_occurrences)) if (failure.status === "unresolved") lines.push(sectionRule("未解决失败", width), field("步骤", failure.step_id), field("原因", failure.failure_reason), field("出现", failure.occurrence_id), ...actionLines(text(failure.targeted_action), width));
    for (const unknown of Array.isArray(instance.unknowns) ? instance.unknowns : []) lines.push(field("未知", unknown));
    lines.push(field("实例", instance.instance_id), field("操作", instance.operation_key));
  }
  lines.push({ text: "" }, listItem("返回 · Esc", { type: "back" }));
  return wrapDetailLines(lines, width);
}

/** 保持生命周期命令在可滚动窗格中完整。Shell 续行使
 *  视觉换行可用作一个命令，而非将隐藏后缀变成猜测。 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      word += char;
      escaped = true;
    } else if ((char === "'" || char === '"') && (quote === null || quote === char)) {
      word += char;
      quote = quote === char ? null : char;
    } else if (/\s/.test(char) && quote === null) {
      if (word) words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  return words;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** 仅拆分后台服务 shellQuote 辅助发出的词。相邻引用块之间直接
 *  的续行是一个 shell 参数；选项到选项的续行
 *  保留分隔空格。 */
function splitQuotedWord(word: string, maxWidth: number): string[] | null {
  if (!word.startsWith("'") || !word.endsWith("'")) return null;
  const value = word.slice(1, -1).replaceAll(`'"'"'`, "'");
  if (quoteShell(value) !== word) return null;
  const chunks: string[] = [];
  let chunk = "";
  for (const char of value) {
    // 分块阈值按显示宽度计算：引号内若含 CJK 双宽字符，.length 会低估列宽导致块过宽
    if (chunk && strWidth(quoteShell(chunk + char)) > maxWidth) {
      chunks.push(quoteShell(chunk));
      chunk = char;
    } else {
      chunk += char;
    }
  }
  chunks.push(quoteShell(chunk));
  return chunks;
}

function actionLines(action: string, width: number): ContentLine[] {
  const firstIndent = "      动作 ";
  const nextIndent = "        ";
  const room = Math.max(width, 24);
  const parts = shellWords(action);
  const lines: ContentLine[] = [];
  let current = `${firstIndent}${parts.shift() ?? ""}`;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    const more = index < parts.length - 1;
    // 列宽按显示宽度计算（中文双宽字符占 2 列），不能用 string.length
    if (current && strWidth(`${current} ${part}${more ? " \\" : ""}`) <= room) {
      current += ` ${part}`;
      continue;
    }
    if (current) lines.push({ text: `${current} \\` });
    const chunks = splitQuotedWord(part, room - 2);
    if (chunks && strWidth(`${nextIndent}${part}${more ? " \\" : ""}`) > room) {
      for (let chunkIndex = 0; chunkIndex < chunks.length - 1; chunkIndex++) {
        lines.push({ text: `${chunks[chunkIndex]!}\\` });
      }
      const last = chunks[chunks.length - 1]!;
      if (more) {
        lines.push({ text: `${last} \\` });
        current = "";
      } else {
        current = last;
      }
    } else {
      current = `${nextIndent}${part}`;
    }
  }
  if (current) lines.push({ text: current });
  return lines;
}
