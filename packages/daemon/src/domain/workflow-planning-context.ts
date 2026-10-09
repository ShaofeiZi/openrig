import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** Agent planning 是当前 guidance，而非第二套 executable graph 或 status store。 */
export function workflowPlanningContext(contextRefs: string[] | undefined, instanceId: string): string[] {
  const mission = contextRefs?.find(ref => ref.endsWith("/mission.yaml"));
  if (!mission) return [];
  const lines = [
    "工作流计划：计划可以变更。请使用 zrig workflow revise " + instanceId + " 检查 authored step 与 running step；仅编辑文件不会采纳 revision。",
    "工作流计划：wave 指导 agent 准入与 review；只有 authored executable dependency 会调度 step。请保留已完成判断和未结 child custody。",
  ];
  try {
    const document = parse(readFileSync(mission, "utf8"));
    const arrangement = document?.arrangement;
    const line = (label: string, value: unknown) => {
      if (typeof value === "string" && value.trim()) lines.push("工作流计划：" + label + "：" + value.trim().replace(/\s+/g, " "));
    };
    line("快照 guidance 来源（决策前请检查当前 source）", mission);
    line("规划 posture", arrangement?.planning_posture?.rule);
    line("集成 ref", arrangement?.source?.integration_ref);
    line("集成/合并决策", arrangement?.source?.rule);
    for (const wave of Array.isArray(arrangement?.waves) ? arrangement.waves : []) {
      const id = typeof wave?.id === "string" ? wave.id : "未命名 wave";
      line(id + " 准入", wave?.admission);
      line(id + " review", wave?.review);
      line(id + " exit", wave?.exit);
    }
    line("共享集成出口", arrangement?.integration_exit?.rule);
  } catch (error) {
    lines.push("工作流计划：当前 authored guidance 不可用：" + (error instanceof Error ? error.message : String(error)));
  }
  return lines;
}
