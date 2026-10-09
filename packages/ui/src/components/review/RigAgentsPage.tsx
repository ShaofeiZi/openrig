// OPR.0.4.4.22——AGENTS 高度：工作组范围的独立协调面板
// （受祝福脊柱的第四个高度 HOST — MISSION — SLICE — AGENTS；
// 也是 slice 页 AGENTS 区域与面板/主机智能体计数 chips 的 ZOOM 目标）。
//
// 纯投影渲染：从组合后的工作组读取根投影出 NEEDS YOU + AGENTS（健康行）+ SETTLED。
// 智能体不为它创作任何东西；也不轮询它们；▲ 只是给人看的信息。平实语言优先（BR-10）；
// 原始 id 位于钻取层。
//
// 路由纪律（arch 计划评审裁定，drift-killer 4）：本路由为“寻址”而存在，而非导航 chrome——
// 只经 ZOOM 到达（面板/主机 chips、slice 区域锚定缩放、面包屑上翻）；它绝不是顶层导航项。
// 锚定/过滤状态 = 查询参数（?slice=<name>、?group=agent|slice），使每个状态都可深链接寻址。

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useRigAgents } from "../../hooks/useReview.js";
import { NeedsYouAccordion } from "./NeedsYouAccordion.js";
import { AgentsBandView } from "./AgentsBandView.js";
// OPR.0.4.6.MH5（C4）——FLEET 条带，创始人锁定 placement 选项 B（= BOTH）。
// v1 挂载枚举（锁定的“每个主机界面渲染处”读作允许单一挂载；pm 一致性腿确认）：
// 本 /agents 工作组高度根是唯一的 v1 挂载点。对单主机操作者，条带什么都不渲染，
// 因此本页在 fleet 之前保持字节一致（leg-7 零回归锚点）。
import { FleetBand } from "./FleetBand.js";
import type { EvidenceContext } from "./EvidenceOpener.js";
import { sessionMemberLabel } from "../../lib/session-name.js";

const SURFACE_ACTOR = "human@host";

/** 工作组高度没有单一 slice 目录；证据引用在此渲染为诚实的不可打开指针，
 *  在 slice 钻取处才完整打开。 */
const RIG_EVIDENCE_CTX: EvidenceContext = { root: null, relPath: null, slicePath: null };

function readSearchParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

function ageLabel(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return mins < 60 ? `${mins}分` : mins < 1440 ? `${Math.floor(mins / 60)}时` : `${Math.floor(mins / 1440)}天`;
}

export function RigAgentsPage() {
  const { data, isLoading, error } = useRigAgents();
  const anchoredSlice = readSearchParam("slice");
  const initialGroup = readSearchParam("group") === "slice" ? "slice" : "agent";
  const [grouping, setGrouping] = useState<"agent" | "slice">(initialGroup);
  const setAddressableGrouping = (next: "agent" | "slice") => {
    setGrouping(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("group", next);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  // FR-5 锚定缩放：slice 页的 AGENTS 区域打开本页时过滤为该 slice 的智能体，
  // 完整工作组上下文一步之遥。过滤是展示层的；归属仍按工作范围。
  const band = useMemo(() => {
    if (!data) return null;
    if (!anchoredSlice) return data.agents;
    const rows = data.agents.rows.filter((r) => r.slices.includes(anchoredSlice));
    return {
      ...data.agents,
      rows,
      provenance:
        rows.length === 0
          ? `没有智能体在 ${anchoredSlice} 上持有或最近持有工作——${data.agents.provenance}`
          : `锚定到 ${anchoredSlice}——${data.agents.provenance}`,
    };
  }, [data, anchoredSlice]);

  if (isLoading) {
    return <p className="p-4 font-mono text-[11px] text-on-surface-variant">正在汇聚工作组协作视图…</p>;
  }
  if (error || !data || !band) {
    return (
      <p data-testid="rig-agents-error" className="p-4 font-mono text-[11px] text-red-700">
        工作组智能体面板不可用：{error instanceof Error ? error.message : "汇聚器不可达"}
      </p>
    );
  }

  return (
    <div data-testid="rig-agents-page" className="mx-auto max-w-4xl space-y-5 p-4">
      {/* MH-5：fleet 高度的环境条，位于工作组高度上方。 */}
      <FleetBand />
      {/* 沿脊柱向上的面包屑——两个方向都是一个不断开的手势。 */}
      <nav className="flex items-center gap-2 font-mono text-[10px] uppercase text-on-surface-variant">
        <Link to="/project" className="hover:underline">
          项目
        </Link>
        <span>/</span>
        <span data-testid="rig-agents-crumb">智能体（工作组）</span>
        {anchoredSlice ? (
          <>
            <span>·</span>
            <span data-testid="rig-agents-anchor">锚定：{anchoredSlice}</span>
            <a href="/agents" className="hover:underline" data-testid="rig-agents-unanchor">
              [完整工作组]
            </a>
          </>
        ) : null}
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[14px] font-semibold">智能体——协作视图</h2>
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase">
          <span className="text-on-surface-variant">分组方式</span>
          {(["agent", "slice"] as const).map((g) => (
            <button
              key={g}
              type="button"
              data-testid={`rig-agents-group-${g}`}
              onClick={() => setAddressableGrouping(g)}
              className={`border px-2 py-0.5 ${grouping === g ? "border-outline bg-surface-variant" : "border-outline-variant hover:bg-surface-variant/50"}`}
            >
              {g === "agent" ? "按智能体" : "按切片"}
            </button>
          ))}
        </div>
      </header>

      {/* 条带 1：NEEDS YOU——工作组范围的待关注条带。APPROVE 是 slice 终态动作，
          在此隐藏（请缩放到 slice）。 */}
      <NeedsYouAccordion
        band={data.needsYou}
        slice="rig"
        missionId={null}
        actorSession={SURFACE_ACTOR}
        ctx={RIG_EVIDENCE_CTX}
        showApprove={false}
      />

      {/* 条带 2：AGENTS——现场条带（工作组范围共享的 P2 FR-4 解剖；
          分组是这个唯一主界面里的页面级排列）。 */}
      <AgentsBandView band={band} itemRef="rig" grouping={grouping} />

      {/* 条带 3：SETTLED——记录条带（今日已关闭的移交）。 */}
      <section data-testid="settled-band" className="space-y-1">
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">已了结</h3>
        {data.settled.length === 0 ? (
          <p data-testid="settled-empty" className="font-mono text-[11px] text-on-surface-variant">
            {data.settledProvenance}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
              {data.settled.map((row) => (
                <li key={`${row.qitemId}-${row.closedAtIso}`} className="flex items-center gap-2 px-2 py-1.5">
                  <span className="font-mono text-[10px] text-on-surface-variant">{sessionMemberLabel(row.fromSession)}</span>
                  <span className="text-on-surface-variant">→</span>
                  <span className="font-mono text-[10px] text-on-surface-variant">{sessionMemberLabel(row.toSession)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px]" data-testid={`settled-summary-${row.qitemId}`}>
                    {row.summary ?? row.qitemId}
                  </span>
                  <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(row.closedAtIso)}</span>
                </li>
              ))}
            </ul>
            <p className="font-mono text-[10px] text-on-surface-variant">{data.settledProvenance}</p>
          </>
        )}
      </section>

      <p className="font-mono text-[10px] text-on-surface-variant">汇聚于 {data.composedAt}</p>
    </div>
  );
}
