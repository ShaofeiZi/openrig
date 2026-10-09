// V1 第 4 阶段尝试 3 —— 已接入 cmux 启动器的 AuthorAgentTag。
//
// 按 agent-chat-surface.md L13–L21 V1 默认：点击 → 拓扑席位详情页，
// 带 cmux 启动按钮。第 3 阶段桩接了导航；第 4 阶段通过 useCmuxLaunch
// 接入 cmux 启动器本身（POST 到 /api/rigs/$rigId/nodes/$logicalId/open-cmux
// —— 打开或聚焦 cmux 面板语义）。
//
// 点击语义：标签点击 → 启动 cmux（将席位在 cmux 中前置）。
// 标签保持为 Link，以便右键 / Cmd+点击仍打开席位详情页（URL 保留）。

import { Link } from "@tanstack/react-router";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { ActorMark, isHumanActor } from "../graphics/RuntimeMark.js";
import { parseSessionName } from "../../lib/session-name.js";

interface AuthorAgentTagProps {
  authorSession: string;
  rigId?: string;
  className?: string;
  testId?: string;
}

function parseSeat(authorSession: string): { logicalId: string; rigId: string | null } {
  // OPR.0.4.6.MH1 FR-8：共享解析契约；非规范名称整体作为逻辑 ID 渲染（无 rig 链接目标）。
  const parsed = parseSessionName(authorSession);
  if (parsed.kind !== "canonical") return { logicalId: authorSession, rigId: null };
  return { logicalId: parsed.member, rigId: parsed.rig };
}

export function AuthorAgentTag({ authorSession, rigId, className, testId }: AuthorAgentTagProps) {
  const parsed = parseSeat(authorSession);
  const targetRigId = rigId ?? parsed.rigId;
  const cmuxLaunch = useCmuxLaunch();
  const humanActor = isHumanActor(authorSession);

  // 若无法解析出 rigId，则只显示标签，不加链接。
  if (!targetRigId) {
    return (
      <span
        data-testid={testId ?? "author-agent-tag"}
        className={className ?? "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant"}
      >
        {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
        <span>{authorSession}</span>
      </span>
    );
  }

  return (
    <Link
      to="/topology/seat/$rigId/$logicalId"
      params={{ rigId: targetRigId, logicalId: encodeURIComponent(parsed.logicalId) }}
      data-testid={testId ?? "author-agent-tag"}
      onClick={(e) => {
        // Cmd/Ctrl+点击或右键 → 标准 Link 行为（打开席位详情）。
        // 普通点击 → 触发 cmux 启动器，同时让 Link 导航。
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        cmuxLaunch.mutate({ rigId: targetRigId, logicalId: parsed.logicalId });
      }}
      className={
        className ??
        "inline-flex items-center gap-1 font-mono text-[10px] text-on-surface-variant hover:text-on-surface hover:underline"
      }
    >
      {humanActor ? <ActorMark actor={authorSession} size="xs" /> : null}
      <span>{authorSession}</span>
    </Link>
  );
}
