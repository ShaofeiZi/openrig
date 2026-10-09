// OPR.0.4.1.24——工作区父层级项目组合（真实数据实现）。
//
// 创始人意图：“工作区父层级是空的；为它提供所有任务及其引导信息的简洁组合。任务默认折叠，
// 按最近修改排序，使我能直接跳到想看的任务。”
//
// 将创始人批准的孪生模型图（digital-twin/opr-0.4.1.24/）接入真实数据，并复用现有项目任务机制：
//   - 任务由 useSlices 派生；通过 projectSliceFromListEntry 按 missionId 对 SliceListEntry 分组，
//     状态来自 VM-005 协调后的归属位置。
//   - 通过 sortProjectMissions 按最近修改排序（latestProjectMissionActivity 降序），默认折叠。
//   - 逐任务引导速览使用已交付的 MISSION_BRIEF.md 路径
//    （useMission → useScopeMarkdown，即 slice-17 面板 2 机制），展示各任务的
//     `## Building` 和 `## Needs you` 章节。不新增逐任务 STEERING.md 来源，该决定已在运行上确定。
//     任务没有 MISSION_BRIEF.md 时，优雅降级为低调速览。
//
// 延迟加载（吸取 slice-17/21 过度获取的教训）：折叠的首次页面只读取切片索引，即一条已加载的
// useSlices 查询。只有展开任务行时才获取其 MISSION_BRIEF（展开时挂载 MissionGlance），
// 绝不会在首次进入时读取 N 份简报。

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useSlices } from "../../hooks/useSlices.js";
import { useMission } from "../../hooks/useMission.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { useHostSelection, useLocalFilesAllowed } from "../../hooks/useHosts.js";
import {
  projectSliceFromListEntry,
  reconcileMissionStatus,
  sortProjectMissions,
  latestProjectMissionActivity,
  type ProjectMissionGroup,
} from "../../lib/project-mission-state.js";
import { MissionStatusBadge } from "../MissionStatusBadge.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { cn } from "../../lib/utils.js";

function formatActivity(ts: number): string {
  if (!ts || ts <= 0) return "近期无活动";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 从 MISSION_BRIEF.md（slice-16 规范）提取具名 `## <header>` 章节正文；章节缺失时返回 null。 */
function briefSection(markdown: string, header: string): string | null {
  const lines = markdown.split("\n");
  let collecting = false;
  const body: string[] = [];
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      if (collecting) break; // next section ends the one we want
      collecting = h2[1]!.trim().toLowerCase() === header.toLowerCase();
      continue;
    }
    if (collecting) body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

/** 仅展开时出现的逐任务引导速览：显示任务 MISSION_BRIEF.md 中的 Building 与 Needs-you。
 * 只在行展开时挂载，因此结构上就是延迟加载。 */
function MissionGlance({ missionId }: { missionId: string }) {
  const mission = useMission(missionId);
  // OPR.0.4.6.MH2 guard-B1：useMission 会根据选中主机重定向，因此选择远程主机时
  // missionPath 是远程路径，绝不能依据本地白名单根目录解析；不发出 /api/files/* 请求，
  // 并显示如实文案。
  const { known: selectionKnown, isLocal } = useHostSelection();
  const filesAllowed = useLocalFilesAllowed();
  const missionPath =
    filesAllowed && mission.data && "missionPath" in mission.data ? mission.data.missionPath : null;
  const brief = useScopeMarkdown(missionPath, "MISSION_BRIEF.md");

  if (selectionKnown && !isLocal) {
    // 仅在明确已知为远程时进入。未知状态渲染加载分支；无论哪种情况获取都受门控，
    // 避免本地冷启动时闪现误导性的门控文案。
    return (
      <div data-testid={`portfolio-glance-remote-gated-${missionId}`} className="font-mono text-[11px] text-on-surface-variant">
        不显示本地文件 —— 驾驶概览从所选主机的文件系统读取 MISSION_BRIEF.md，远程只读视图不会浏览它。
      </div>
    );
  }

  if (!selectionKnown || mission.isLoading || brief.isLoading) {
    return <div data-testid={`portfolio-glance-loading-${missionId}`} className="font-mono text-[11px] text-on-surface-variant">正在加载驾驶概览…</div>;
  }

  if (brief.unavailable || !brief.content) {
    return (
      <div data-testid={`portfolio-glance-empty-${missionId}`} className="font-mono text-[11px] text-on-surface-variant">
        此任务根下尚无 MISSION_BRIEF.md —— 一旦完成简报，驾驶概览就会投影到这里。
      </div>
    );
  }

  const building = briefSection(brief.content, "Building");
  const needsYou = briefSection(brief.content, "Needs you");
  if (!building && !needsYou) {
    return (
      <div data-testid={`portfolio-glance-thin-${missionId}`} className="font-mono text-[11px] text-on-surface-variant">
        MISSION_BRIEF.md 尚无“构建中 / 需要你处理”段落。
      </div>
    );
  }

  return (
    <div data-testid={`portfolio-glance-${missionId}`} className="space-y-2">
      {building ? (
        <div>
          <div className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">构建中</div>
          <MarkdownViewer content={building} hideFrontmatter hideRawToggle />
        </div>
      ) : null}
      {needsYou ? (
        <div>
          <div className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">需要你处理</div>
          <MarkdownViewer content={needsYou} hideFrontmatter hideRawToggle />
        </div>
      ) : null}
    </div>
  );
}

function MissionRow({ mission, expanded, onToggle }: { mission: ProjectMissionGroup; expanded: boolean; onToggle: () => void }) {
  const recency = latestProjectMissionActivity(mission);
  const sliceCount = mission.slices.length;
  // OPR.0.4.1.24 rev1-r2 前向修复：创始人批准的汇总是已证明/活跃/切片，表示工作证明而非
  // 完成状态。hasProofPacket 是每个 ProjectSliceRow 已携带的已证明信号。
  const provenCount = mission.slices.filter((s) => s.hasProofPacket).length;
  const activeCount = mission.slices.filter((s) => s.status === "active").length;

  return (
    <article data-testid={`portfolio-mission-${mission.id}`} className="border border-outline-variant bg-surface-lowest/35 backdrop-blur-sm">
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          data-testid={`portfolio-toggle-${mission.id}`}
          className="flex flex-1 items-start gap-3 px-4 py-3 text-left hover:bg-surface-lowest/50"
        >
          <span aria-hidden className={cn("mt-0.5 font-mono text-[12px] text-on-surface-variant transition-transform", expanded && "rotate-90 text-on-surface-variant")}>
            ▸
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] uppercase tracking-[0.06em] text-on-surface">{mission.label}</span>
              <MissionStatusBadge status={mission.status} label={mission.statusLabel} />
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.06em] text-on-surface-variant">
              {provenCount} 个已校验 · {activeCount} 个活跃 · {sliceCount} 个切片 · {formatActivity(recency)}
            </div>
          </div>
        </button>
        <Link
          to="/project/mission/$missionId"
          params={{ missionId: mission.id }}
          data-testid={`portfolio-open-${mission.id}`}
          className="flex shrink-0 items-center border-l border-outline-variant px-3 font-mono text-[10px] uppercase tracking-[0.08em] text-on-surface-variant hover:bg-surface-lowest/50 hover:text-on-surface"
        >
          打开 →
        </Link>
      </div>
      {expanded ? (
        <div className="border-t border-outline-variant bg-surface-lowest/20 px-4 py-3">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">驾驶概览 · MISSION_BRIEF.md</div>
          <MissionGlance missionId={mission.id} />
        </div>
      ) : null}
    </article>
  );
}

export function WorkspacePortfolioPanel() {
  const { data, isLoading } = useSlices("all");

  const missions = useMemo<ProjectMissionGroup[]>(() => {
    if (!data || "unavailable" in data) return [];
    const buckets = new Map<string, ProjectMissionGroup["slices"]>();
    for (const slice of data.slices) {
      const row = projectSliceFromListEntry(slice);
      const key = row.missionId ?? row.railItem ?? "unsorted";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    }
    // VM-005：通过后台服务的任务伴随数据实现作者内容优先。
    const authored = data.missions ?? {};
    return Array.from(buckets.entries())
      .map(([key, slices]) => {
        const rec = reconcileMissionStatus(authored[key]?.authoredStatus ?? null, slices, undefined, authored[key]?.readiness);
        return {
          id: key,
          label: key === "unsorted" ? "未排序" : key,
          status: rec.state,
          statusLabel: rec.label,
          statusSource: rec.source,
          slices,
        };
      })
      .sort(sortProjectMissions); // most-recently-modified first
  }, [data]);

  // 默认折叠，符合创始人的首次页面要求；空集合表示全部折叠。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  if (isLoading) {
    return <EmptyState label="正在加载工作区" description="正在读取任务索引。" variant="card" testId="portfolio-loading" />;
  }
  if (data && "unavailable" in data) {
    return (
      <EmptyState
        label="工作区索引不可用"
        description={data.hint ?? "当前配置的工作区无法提供切片索引。"}
        variant="card"
        testId="portfolio-unavailable"
      />
    );
  }
  if (missions.length === 0) {
    return (
      <EmptyState
        label="暂无任务"
        description="此工作区中尚未索引任何任务。任务会在你创建时出现在这里；每行可展开其驾驶概览。"
        variant="card"
        testId="portfolio-empty"
      />
    );
  }

  return (
    <div data-testid="workspace-portfolio" className="space-y-3">
      <div className="flex items-baseline justify-between">
        <SectionHeader>组合 · 全部任务</SectionHeader>
        <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-on-surface-variant">
          {missions.length} 个任务 · 按最近修改排序
        </span>
      </div>
      <div className="space-y-2">
        {missions.map((mission) => (
          <MissionRow
            key={mission.id}
            mission={mission}
            expanded={expanded.has(mission.id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(mission.id)) next.delete(mission.id);
                else next.add(mission.id);
                return next;
              })
            }
          />
        ))}
      </div>
    </div>
  );
}
