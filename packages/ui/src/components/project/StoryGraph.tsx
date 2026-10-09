// OPR.0.4.1.19——故事页签：以可滚动、向上增长的 Git 图界面展示队列传承；
// 最新项在顶部，起点在底部。
//
// 核心目标：呈现真实队列系统。图根据队列项传承关系（story-graph-model）重建，Git 词汇仅用于
// 辅助说明。状态徽标显示真实 qitem 状态；队列不存在 "merged" 状态，该模型图标签只是示意。
// 视觉汇入只是渲染提示，绝不表示双父节点数据。三级归属：单行 → 展开为全宽信息带 →
// 现有右侧抽屉（QueueItemTrigger）。

import { useMemo, useState } from "react";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";
import { FileLink } from "../ui/FileLink.js";
import { formatStoryDate, type StoryForest, type StoryNode } from "../../lib/story-graph-model.js";
import { EmptyState } from "../ui/empty-state.js";
import { sessionMemberLabel } from "../../lib/session-name.js";
import "./StoryGraph.css";

const TOPLINE_H = 54;
const LANE_W = 28;
const LANE_X0 = 28;
const NODE_R = 5.5;
const NODE_R_BIG = 6.5;

function shortSeat(session: string | null | undefined): string {
  if (!session) return "未知";
  // OPR.0.4.6.MH1 FR-8：共享解析契约的展示辅助函数。
  return sessionMemberLabel(session);
}

/** 把真实的队列项状态映射到徽章样式 + 标签。不发明状态。 */
function stateBadge(node: StoryNode): { cls: string; label: string } {
  const reason = (node.closureReason ?? "").toLowerCase();
  switch (node.state) {
    case "in-progress":
      return { cls: "sg-progress", label: "进行中" };
    case "blocked":
      return { cls: "sg-blocked", label: "已阻塞" };
    case "handed-off":
      return { cls: "sg-done", label: "已移交" };
    case "failed":
      return { cls: "sg-blocked", label: "失败" };
    case "denied":
      return { cls: "sg-blocked", label: "已拒绝" };
    case "canceled":
      return { cls: "sg-blocked", label: "已取消" };
    case "done":
    default:
      // 终态收尾；有真实收尾原因时显示之。
      if (reason === "no-follow-on") return { cls: "sg-done", label: "完成" };
      if (reason === "handed_off_to") return { cls: "sg-done", label: "已移交" };
      return { cls: "sg-done", label: "完成" };
  }
}

/** 边沟节点颜色随状态变化；人工来源节点使用琥珀色填充。 */
function nodeStroke(node: StoryNode): string {
  if (node.isHumanOrigin) return "var(--sg-amber)";
  if (node.state === "in-progress") return "var(--sg-blue)";
  if (node.state === "blocked") return "var(--sg-amber)";
  return "var(--sg-green)";
}

/** 从智能体叙述正文中提取明显的产物路径。没有路径时如实省略信息带，绝不虚构输出。 */
function extractArtifacts(body: string): string[] {
  const matches = body.match(/[\w./-]+\.(?:ts|tsx|js|jsx|md|png|jpg|gif|mp4|patch|diff|json|yaml|yml|sql|css|html)\b/g);
  if (!matches) return [];
  return Array.from(new Set(matches)).slice(0, 6);
}

function bodyContext(body: string): string {
  const trimmed = (body ?? "").trim();
  if (trimmed.length <= 240) return trimmed;
  return `${trimmed.slice(0, 237)}…`;
}

function toViewerData(node: StoryNode): QueueItemViewerData {
  // 第三级抽屉展示完整队列项详情：所有字段和完整传承链。
  return {
    qitemId: node.qitemId,
    source: node.sourceSession,
    destination: node.destinationSession,
    state: node.state,
    tags: node.tags,
    createdAt: node.tsCreated,
    body: node.body,
    updatedAt: node.tsUpdated,
    priority: node.priority,
    tier: node.tier,
    closureReason: node.closureReason,
    closureTarget: node.closureTarget,
    handedOffFrom: node.handedOffFrom,
    handedOffTo: node.handedOffTo,
    blockedOn: node.blockedOn,
    claimedAt: node.claimedAt,
    expiresAt: node.expiresAt,
    closureRequiredAt: node.closureRequiredAt,
    lastNudgeAttempt: node.lastNudgeAttempt,
    lastNudgeResult: node.lastNudgeResult,
    lastHeartbeat: node.lastHeartbeat,
    resolution: node.resolution,
    targetRepo: node.targetRepo,
    chain: node.chain,
    // 第三级是完整事实来源视图：渲染并标注每个字段，空值显示为“—”而非隐藏。
    // 其他 QueueItemViewer 调用位置仍保持紧凑。
    fullDetail: true,
  };
}

/** 正文产物为绝对路径时才“可查看”：通过 FileLink 路由，点击后在抽屉中打开。FileViewer 会推断
 * 类型，因此图片可行内渲染。非绝对引用（相对仓库/工作区）无法可靠地依据后台服务白名单解析，
 * 所以保持不可操作并明确标注，而不是假装可以打开。 */
function isViewableArtifact(path: string): boolean {
  return path.startsWith("/");
}

export function StoryGraph({ forest }: { forest: StoryForest }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 行布局从上到下为最新项到起点。每行拥有 54px 顶行，展开时另有详情面板。高度驱动边沟 SVG，
  // 使连续线路在展开/折叠时重新流动。
  const layout = useMemo(() => {
    const rows: { node: StoryNode; topY: number; centerY: number; height: number; isExpanded: boolean }[] = [];
    let y = 0;
    for (const node of forest.nodes) {
      const isExpanded = expanded.has(node.qitemId);
      const detailH = isExpanded ? estimateDetailHeight(node) : 0;
      const height = TOPLINE_H + detailH;
      rows.push({ node, topY: y, centerY: y + TOPLINE_H / 2, height, isExpanded });
      y += height;
    }
    return { rows, totalH: y };
  }, [forest.nodes, expanded]);

  const centerById = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of layout.rows) m.set(r.node.qitemId, r.centerY);
    return m;
  }, [layout.rows]);

  const laneX = (lane: number) => LANE_X0 + lane * LANE_W;
  const gutterWidth = Math.max(88, LANE_X0 + Math.max(0, forest.laneCount - 1) * LANE_W + LANE_X0);

  if (forest.nodes.length === 0) {
    return (
      <EmptyState
        label="暂无故事"
        description="此范围内尚未索引到队列项。故事图会在工作流经拓扑时，从队列项谱系重建。"
        variant="card"
        testId="story-graph-empty"
      />
    );
  }

  return (
    <div className="sg-wrap" data-testid="story-graph" style={{ ["--sg-gutter" as string]: `${gutterWidth}px` }}>
      <div className="sg-legend">
        故事 &middot; 队列谱系以 git 图呈现 &middot; 每节点一条干净线 &middot; 点击展开 &middot;{" "}
        <b>人工发起泳道</b>
      </div>
      <div className="sg-tbl">
        <div className="sg-thead">
          <div>图</div>
          <div>摘要</div>
          <div>负责人</div>
          <div>状态</div>
          <div>日期</div>
          <div>队列项</div>
        </div>
        <div className="sg-tbody">
          <div className="sg-gutcol" aria-hidden="true">
            <svg
              width={gutterWidth}
              height={layout.totalH}
              viewBox={`0 0 ${gutterWidth} ${layout.totalH}`}
              preserveAspectRatio="none"
            >
              {/* Parent edges: child (upper) -> parent (lower). Same lane = straight;
                  different lane = a smooth curve (the fan-out / branch). */}
              {layout.rows.map(({ node, centerY }) => {
                if (!node.parentId) return null;
                const py = centerById.get(node.parentId);
                if (py === undefined) return null;
                const cx = laneX(node.lane);
                const px = laneX(forest.nodes.find((n) => n.qitemId === node.parentId)?.lane ?? node.lane);
                const stroke = nodeStroke(node);
                const d =
                  cx === px
                    ? `M${cx},${centerY} L${px},${py}`
                    : `M${cx},${centerY} C${cx},${(centerY + py) / 2} ${px},${(centerY + py) / 2} ${px},${py}`;
                return <path key={`e-${node.qitemId}`} d={d} stroke={stroke} strokeWidth={3} fill="none" />;
              })}
              {/* Nodes */}
              {layout.rows.map(({ node, centerY }) => {
                const cx = laneX(node.lane);
                const stroke = nodeStroke(node);
                const big = node.isRoot || node.isHumanOrigin;
                const fill = node.isHumanOrigin ? "var(--sg-amber)" : node.isRoot ? stroke : "var(--sg-paper)";
                return (
                  <circle
                    key={`n-${node.qitemId}`}
                    cx={cx}
                    cy={centerY}
                    r={big ? NODE_R_BIG : NODE_R}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={3}
                  />
                );
              })}
            </svg>
          </div>
          <div className="sg-rows">
            {layout.rows.map(({ node, isExpanded }) => {
              const badge = stateBadge(node);
              const ownerLabel = node.isHumanOrigin
                ? `${shortSeat(node.sourceSession)} → ${shortSeat(node.destinationSession)}`
                : shortSeat(node.owner);
              return (
                <div key={node.qitemId} className={`sg-trow${node.isHumanOrigin ? " sg-human" : ""}`}>
                  <button
                    type="button"
                    className="sg-topline"
                    onClick={() => toggle(node.qitemId)}
                    aria-expanded={isExpanded}
                    data-testid={`story-row-${node.qitemId}`}
                  >
                    <span className="sg-cell">
                      <span className="sg-summary">{node.summary}</span>
                      <span className="sg-chev">{isExpanded ? "▲" : "▾"}</span>
                    </span>
                    <span className="sg-cell sg-owner">{ownerLabel}</span>
                    <span className={`sg-cell sg-state ${badge.cls}`}>
                      <span className="sg-sd" />
                      {badge.label}
                    </span>
                    <span className="sg-cell sg-date">{formatStoryDate(node.tsCreated)}</span>
                    <span className="sg-cell sg-qid">{node.qitemId}</span>
                  </button>
                  {isExpanded ? <StoryDetail node={node} forest={forest} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 估算展开面板高度，供边沟 SVG 布局线路。估算值有意留出余量；真实 DOM 高度可能略有差异，
 * 但每个节点的 centerY 都位于其 54px 顶行，因此线路几何仍保持连续。 */
function estimateDetailHeight(node: StoryNode): number {
  const hasArtifacts = extractArtifacts(node.body).length > 0;
  // 上下文（约 36）+ 传承信息带（约 34）+ 可选产物（约 34）+ 元数据（约 40）+ 内边距。
  return 36 + 34 + (hasArtifacts ? 34 : 0) + 40 + 22;
}

function StoryDetail({ node, forest }: { node: StoryNode; forest: StoryForest }) {
  const artifacts = extractArtifacts(node.body);
  const byId = useMemo(() => new Map(forest.nodes.map((n) => [n.qitemId, n])), [forest.nodes]);
  // 传承链：已解析祖先（根 → 父）→ 自身 → 后继（handedOffTo / 子项）。
  const ancestors = node.chain.filter((id) => byId.has(id));
  const children = forest.nodes.filter((n) => n.parentId === node.qitemId).map((n) => n.qitemId);

  return (
    <div className="sg-detail" data-testid={`story-detail-${node.qitemId}`}>
      <div className="sg-dctx">{bodyContext(node.body)}</div>
      <div className="sg-band">
        <div className="sg-bl">谱系</div>
        <div className="sg-bc">
          <span className="sg-chain">
            {ancestors.map((id) => (
              <LineageRef key={id} node={byId.get(id)!} />
            ))}
            {ancestors.length > 0 ? <span className="sg-carrow">→</span> : null}
            <span className="sg-cnode sg-self">◆ 本节点</span>
            {children.map((id) => (
              <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span className="sg-carrow">→</span>
                <LineageRef node={byId.get(id)!} />
              </span>
            ))}
          </span>
        </div>
      </div>
      {artifacts.length > 0 ? (
        <div className="sg-band">
          <div className="sg-bl">产物</div>
          <div className="sg-bc">
            {artifacts.map((a) =>
              isViewableArtifact(a) ? (
                <FileLink
                  key={a}
                  absolutePath={a}
                  path={a}
                  className="sg-chip sg-chip-link"
                  testId={`story-artifact-${a}`}
                >
                  {a}
                </FileLink>
              ) : (
                <span
                  key={a}
                  className="sg-chip sg-chip-inert"
                  title="引用（不可直接查看）"
                >
                  {a}
                </span>
              ),
            )}
          </div>
        </div>
      ) : null}
      <div className="sg-metarow">
        {node.tags.length > 0 ? (
          <span className="sg-tags">
            {node.tags.slice(0, 8).map((t) => (
              <span key={t} className="sg-tagpill">
                {t}
              </span>
            ))}
          </span>
        ) : null}
        <span className="sg-fieldline">
          {shortSeat(node.sourceSession)} → {shortSeat(node.destinationSession)}
          {node.closureReason ? ` · ${node.closureReason}` : ""}
          {` · 开启于 ${formatStoryDate(node.tsCreated)}`}
        </span>
        <QueueItemTrigger
          data={toViewerData(node)}
          testId={`story-open-${node.qitemId}`}
          className="sg-openlink"
        >
          打开完整队列项 →
        </QueueItemTrigger>
      </div>
    </div>
  );
}

function LineageRef({ node }: { node: StoryNode }) {
  return (
    <QueueItemTrigger
      data={toViewerData(node)}
      testId={`story-lineage-${node.qitemId}`}
      className="sg-cnode"
    >
      {node.qitemId} {shortSeat(node.destinationSession)}
    </QueueItemTrigger>
  );
}
