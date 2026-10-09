import type { LucideIcon } from "lucide-react";
import { CheckCircle2, FilePenLine, Pause, Route, Send, ShieldX, Trash2 } from "lucide-react";
import type { ProjectMetaTone, ProjectToken } from "../project/ProjectMetaPrimitives.js";
import type { MissionControlVerb } from "./hooks/useMissionControlAction.js";

export interface ActionVerbMeta {
  label: string;
  outcomeLabel: string;
  description: string;
  tone: ProjectMetaTone;
  icon: LucideIcon;
}

export const ACTION_VERB_META: Record<MissionControlVerb, ActionVerbMeta> = {
  approve: {
    label: "批准",
    outcomeLabel: "已批准",
    description: "接受这项工作，让它关闭或继续。",
    tone: "success",
    icon: CheckCircle2,
  },
  deny: {
    label: "拒绝",
    outcomeLabel: "已拒绝",
    description: "拒绝此请求，必要时留下理由。",
    tone: "danger",
    icon: ShieldX,
  },
  route: {
    label: "路由",
    outcomeLabel: "已路由",
    description: "把它发送到另一个会话跟进。",
    tone: "info",
    icon: Route,
  },
  annotate: {
    label: "批注",
    outcomeLabel: "已批注",
    description: "在不改变归属的前提下补充上下文。",
    tone: "neutral",
    icon: FilePenLine,
  },
  hold: {
    label: "搁置",
    outcomeLabel: "已搁置",
    description: "暂停此项，直到有更多上下文可用。",
    tone: "warning",
    icon: Pause,
  },
  drop: {
    label: "丢弃",
    outcomeLabel: "已丢弃",
    description: "把此项从活动路径移除。",
    tone: "neutral",
    icon: Trash2,
  },
  handoff: {
    label: "移交",
    outcomeLabel: "已移交",
    description: "把活动归属转移到另一个会话。",
    tone: "info",
    icon: Send,
  },
};

export function actionVerbToken(verb: MissionControlVerb, mode: "action" | "outcome" = "action"): ProjectToken {
  const meta = ACTION_VERB_META[verb];
  return {
    label: mode === "outcome" ? meta.outcomeLabel : meta.label,
    tone: meta.tone,
    icon: meta.icon,
  };
}
