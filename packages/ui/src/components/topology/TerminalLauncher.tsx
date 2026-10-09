// OPR.0.4.6.2（FR-5）——TerminalLauncher（规格模型图孪生的真实实现）。
//
// 终端墙/视图的 Web UI 启动器（herdr 为主，cmux 尽力而为）。它将已交付的工作组范围
//“在 CMUX 中启动”按钮泛化为提供方与视图选择器：选择提供方（herdr | cmux），选择视图
//（本工作组、某个 Pod、某任务或切片的智能体、已保存视图），查看 N 个窗格的建议布局，然后打开。
// 它仍位于同一个页签栏尾部槽位，是对已交付界面的扩展，而非另造新界面。
//
// 锁定词汇（PRD 术语表）：视图 / 布局 / 窗格 / 提供方。
//
// 这是 `fr5-launcher-mockup/` 的真实数据实现（孪生锁定）：结构、文案、testid 和四个区域
// 与孪生一致；演示名册替换为实时接缝——工作组席位和 Pod 来自 `useNodeInventory`，派生的
// 任务/切片目标来自 `useSlices`（名册通过评审智能体带预览），已保存视图来自
// `GET /api/terminal/views`，启动通过 `POST /api/terminal/open { provider, view }`
//（C3 规范组合器）完成。任何文案变更都要回到规格模型图处理，绝不由驱动方临时发挥。

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Terminal, ChevronDown, Bookmark, Layers, GitBranch, Server, Eye, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../ui/dialog.js";
import { StatusPip } from "../ui/status-pip.js";
import { cn } from "../../lib/utils.js";
import { withHostParam } from "../../lib/host-param.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { useNodeInventory, type NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { useSlices } from "../../hooks/useSlices.js";
import { useTerminalViews } from "../../hooks/useTerminalViews.js";
import { useReviewAgents } from "../../hooks/useReviewAgents.js";
import { terminalAuthHeaders } from "../mission-control/missionControlAuth.js";

type ProviderId = "herdr" | "cmux";

export interface Seat {
  session: string;
  live: boolean;
  reason?: string;
  activity: "active" | "idle";
}

export type ViewKind = "rig" | "pod" | "mission" | "slice" | "saved";

export interface LauncherView {
  id: string;
  kind: ViewKind;
  label: string;
  sub: string;
  /** null 表示派生名册（任务/切片），通过评审带延迟解析。 */
  seats: Seat[] | null;
  /** 跨越其他工作组或全部只读时，按结构设为只读（tmux attach -r）。 */
  crossRig?: boolean;
}

// ── 唯一共享的打开结果形态（镜像后台服务 OpenViewResult）──
export interface OpenViewResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: { seat: string; host: string | null; reason: string }[];
  degraded: { seat: string; host: string; reason: string }[];
  pages: number;
  error?: string;
  code?: string;
}

/**
 * 纯结果分类器（Guard G2）。后台服务会对 provider-unavailable、layout-unsupported 和
 * honest-partial 结果返回 HTTP 200 及如实响应体，因此 UI 不能把“200”直接视为成功。只有实际
 * 打开窗格（`opened.length > 0`）才算成功，与 CLI 的零窗格即失败规则一致。零窗格或提供方失败
 * 会呈现 `code`/`error`，并按名称列出权威的缺席和降级席位，而不是只显示数量。
 */
export function describeOpenResult(r: OpenViewResult): { ok: boolean; headline: string; disclosure: string } {
  const disclosure = [
    ...r.absent.map((a) => `${a.seat}: ${a.reason}`),
    ...r.degraded.map((d) => `${d.seat} (${d.host}): ${d.reason}`),
  ].join(" · ");
  if (r.opened.length > 0) {
    return { ok: true, headline: `在 ${r.provider} 中打开了 ${r.opened.length} 个`, disclosure };
  }
  const why = r.error ? `${r.code ? `${r.code}: ` : ""}${r.error}` : (r.code ?? "未打开任何磁贴");
  return { ok: false, headline: `${r.provider} 中未打开任何磁贴 —— ${why}`, disclosure };
}

export const PANE_CAP = 9;
export function suggestLayout(n: number) {
  const shown = Math.min(n, PANE_CAP);
  const cols = Math.max(1, Math.ceil(Math.sqrt(shown)));
  const rows = Math.ceil(shown / cols);
  return { shown, cols, rows, paged: Math.max(0, n - shown) };
}

const PROVIDERS: { id: ProviderId; label: string; note: string; badge: string }[] = [
  { id: "herdr", label: "herdr", note: "单一跨平台二进制 · 原子布局应用", badge: "主要" },
  { id: "cmux", label: "cmux", note: "尽力而为 · 增加浏览器窗格 + ssh + 远程 tmux", badge: "尽力而为" },
];

const KIND_ICON: Record<ViewKind, typeof Server> = {
  rig: Server,
  pod: Layers,
  mission: GitBranch,
  slice: GitBranch,
  saved: Bookmark,
};

const KIND_GROUP: { heading: string; kinds: ViewKind[] }[] = [
  { heading: "本工作组", kinds: ["rig"] },
  { heading: "按 Pod", kinds: ["pod"] },
  { heading: "任务 · 切片", kinds: ["mission", "slice"] },
  { heading: "已保存视图", kinds: ["saved"] },
];

const RIG_NAME_UNAVAILABLE = "工作组名不可用";

export function resolveLauncherRigName(input: {
  nodes: NodeInventoryEntry[] | undefined;
  rigId: string;
  rigName?: string | null;
}): string {
  const explicitName = input.rigName?.trim();
  if (explicitName) return explicitName;
  const nodeName = input.nodes
    ?.find((node) => node.rigId === input.rigId && typeof node.rigName === "string" && node.rigName.trim())
    ?.rigName.trim();
  return nodeName || RIG_NAME_UNAVAILABLE;
}

// 从 URL 初始化 open/provider/view——已批准的深链接捕获方式。捕获是如实的深链接
// ?launcher=open&provider=cmux&view=…，具有确定性且无须点击脚本，也正符合可寻址 UI 状态的要求。
function readParams() {
  if (typeof window === "undefined") return { open: false, provider: "herdr" as ProviderId, view: "" };
  const p = new URLSearchParams(window.location.search);
  const provider = p.get("provider") === "cmux" ? "cmux" : "herdr";
  return { open: p.get("launcher") === "open", provider: provider as ProviderId, view: p.get("view") ?? "" };
}

export function nodeToSeat(n: NodeInventoryEntry): Seat {
  const live = !!n.canonicalSessionName;
  const act = n.agentActivity?.state;
  return {
    session: n.canonicalSessionName ?? n.logicalId,
    live,
    reason: live ? undefined : "未启动",
    activity: act === "running" || act === "needs_input" ? "active" : "idle",
  };
}

/**
 * 纯视图资料库构建器：提取出启动器的完整数据模型，使其无须渲染 Radix 对话框即可单元测试。
 * 顺序遵循创始人的“选择要打开的内容”：本工作组 → 某个 Pod → 任务/切片 → 已保存视图。
 * 派生任务/切片视图携带 `seats: null`，其名册在打开时实时解析，并通过评审智能体带预览；
 * 工作组、Pod 和已保存视图则携带自身名册。
 */
export function buildLauncherViews(input: {
  nodes: NodeInventoryEntry[] | undefined;
  rigId: string;
  rigName?: string | null;
  slices: { name: string; missionId: string | null; displayName: string }[];
  savedViews: { id: string; name: string; members: { seat: string; readOnly?: boolean }[] }[];
}): LauncherView[] {
  const { nodes, rigId, rigName, slices, savedViews } = input;
  const out: LauncherView[] = [];
  const agents = (nodes ?? []).filter((n) => n.nodeKind === "agent");
  const resolvedRigName = resolveLauncherRigName({ nodes, rigId, rigName });

  // 本工作组：每个存活智能体，可交互。
  out.push({
    id: `rig:${rigId}`,
    kind: "rig",
    label: resolvedRigName,
    sub: "此工作组中所有活跃智能体",
    seats: agents.map(nodeToSeat),
  });

  // 按 Pod：根据 Pod 命名空间对工作组智能体分组。
  const pods = new Map<string, NodeInventoryEntry[]>();
  for (const n of agents) {
    const ns = n.podNamespace;
    if (!ns) continue;
    const arr = pods.get(ns);
    if (arr) arr.push(n);
    else pods.set(ns, [n]);
  }
  for (const [ns, members] of pods) {
    out.push({
      id: `pod:${rigId}/${ns}`,
      kind: "pod",
      label: `${ns} pod`,
      sub: `${members.length} 个智能体 · 本工作组`,
      seats: members.map(nodeToSeat),
    });
  }

  // 任务与切片：派生目标；打开时实时解析名册。
  const missionIds = [...new Set(slices.map((s) => s.missionId).filter((m): m is string => !!m))];
  for (const mid of missionIds) {
    out.push({ id: `mission:${mid}`, kind: "mission", label: mid, sub: "在此任务上工作的智能体 —— 实时派生", seats: null, crossRig: true });
  }
  for (const s of slices) {
    out.push({ id: `slice:${s.name}`, kind: "slice", label: s.displayName || s.name, sub: `切片 ${s.name} —— 实时派生`, seats: null, crossRig: true });
  }

  // 已保存视图：与提供方无关；所有成员只读时，视图也只读。
  for (const sv of savedViews) {
    out.push({
      id: sv.id,
      kind: "saved",
      label: sv.name,
      sub: `${sv.members.length} 个智能体 · 已保存`,
      seats: sv.members.map((m) => ({ session: m.seat, live: true, activity: "idle" as const })),
      crossRig: sv.members.length > 0 && sv.members.every((m) => m.readOnly === true),
    });
  }
  return out;
}

interface TerminalLauncherProps {
  rigId: string;
  /** 工作组的人类可读名称（未知时回退到 ID）。 */
  rigName?: string | null;
}

export function TerminalLauncher({ rigId, rigName }: TerminalLauncherProps) {
  const boot = readParams();
  const [open, setOpen] = useState(boot.open);
  const [provider, setProvider] = useState<ProviderId>(boot.provider);
  const [selectedId, setSelectedId] = useState<string>(boot.view || `rig:${rigId}`);

  const hostId = useSelectedHostId();
  const { data: nodes } = useNodeInventory(rigId);
  const { data: slicesData } = useSlices("active");
  const { data: viewsData } = useTerminalViews();

  // ── 从实时接缝构建视图资料库（替换孪生中的演示名册）──
  const views = useMemo<LauncherView[]>(
    () =>
      buildLauncherViews({
        nodes,
        rigId,
        rigName,
        // useSlices 返回 SliceListResponse | SlicesUnavailable；此处收窄 unavailable 分支，
        // 与已交付的 Feed.tsx / ProjectTreeView.tsx 判别方式一致。
        slices: slicesData && "slices" in slicesData ? slicesData.slices : [],
        savedViews: viewsData?.saved ?? [],
      }),
    [nodes, rigId, rigName, slicesData, viewsData],
  );

  const selected = views.find((v) => v.id === selectedId) ?? views[0];
  const resolvedRigName = views.find((view) => view.kind === "rig")?.label ?? RIG_NAME_UNAVAILABLE;

  // 派生视图（任务/切片）通过评审带预览其名册。
  const derivedScope = selected && (selected.kind === "mission" || selected.kind === "slice") ? selected.id : null;
  const { data: reviewBand } = useReviewAgents(derivedScope);

  const selectedSeats: Seat[] =
    selected?.seats ??
    (reviewBand?.rows.map((r) => ({
      session: r.sessionName,
      live: true,
      activity: r.stateGlyph === "active" ? ("active" as const) : ("idle" as const),
    })) ??
      []);

  const live = selectedSeats.filter((s) => s.live);
  const absent = selectedSeats.filter((s) => !s.live);
  const layout = suggestLayout(live.length);
  const readOnly = Boolean(selected?.crossRig);
  const providerLabel = PROVIDERS.find((p) => p.id === provider)!.label;

  const openMut = useMutation({
    mutationFn: async (): Promise<OpenViewResult> => {
      const res = await fetch(withHostParam("/api/terminal/open", hostId), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...terminalAuthHeaders() },
        body: JSON.stringify({ provider, view: selected?.id ?? `rig:${rigId}` }),
      });
      const body = (await res.json().catch(() => null)) as OpenViewResult | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body;
    },
  });

  return (
    <div data-testid="terminal-launcher-wrapper" className="hidden lg:inline-flex items-center ml-auto">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            data-testid="terminal-launcher-button"
            className="inline-flex items-center gap-2 border border-stone-700 bg-white px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-900 hover:bg-stone-100 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:bg-transparent dark:text-on-surface dark:border-outline"
          >
            <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
            在终端中打开
            <ChevronDown className="h-3 w-3 opacity-60" aria-hidden="true" />
          </button>
        </DialogTrigger>

        <DialogContent
          hideCloseButton
          data-testid="terminal-launcher-dialog"
          className="w-[calc(100vw-2rem)] max-w-xl max-h-[calc(100vh-2rem)] gap-0 p-0 overflow-y-auto"
        >
          {/* Radix a11y: a Dialog needs an accessible title + description; the
              twin's visible header is a styled div, so these are sr-only —
              screen-reader-visible, pixel-identical to the locked frames. */}
          <DialogTitle className="sr-only">打开终端视图</DialogTitle>
          <DialogDescription className="sr-only">
            选择一个提供方和视图目标，然后将该视图作为终端磁贴打开。
          </DialogDescription>
          {/* Header */}
          <div className="bg-stone-900 text-white px-5 py-3 flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <Terminal className="h-3.5 w-3.5 translate-y-0.5 text-stone-300" aria-hidden="true" />
              <span className="font-mono text-[11px] uppercase tracking-[0.18em]">打开终端视图</span>
            </div>
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-stone-400">
              {resolvedRigName.replace(/^rig_/, "")} · 拓扑
            </span>
          </div>

          <div className="p-5 grid gap-5">
            {/* ── PROVIDER ── */}
            <section data-testid="launcher-provider">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-2">提供方</div>
              <div role="tablist" className="flex gap-6 items-center border-b border-outline-variant">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={provider === p.id}
                    data-testid={`launcher-provider-${p.id}`}
                    onClick={() => setProvider(p.id)}
                    className={cn(
                      "-mb-px py-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2",
                      provider === p.id
                        ? "border-on-surface text-on-surface"
                        : "border-transparent text-on-surface-variant hover:text-on-surface",
                    )}
                  >
                    {p.label}
                    <span
                      className={cn(
                        "px-1 py-0.5 text-[8px] tracking-[0.12em] border",
                        p.id === "herdr" ? "border-success/60 text-success" : "border-outline text-on-surface-variant",
                      )}
                    >
                      {p.badge}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-2 font-mono text-[9px] text-on-surface-variant leading-relaxed">
                {PROVIDERS.find((p) => p.id === provider)!.note}
              </p>
            </section>

            {/* ── VIEW ── */}
            <section data-testid="launcher-view">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-2">视图</div>
              <div className="max-h-[236px] overflow-y-auto border border-outline-variant divide-y divide-outline-variant">
                {views.length === 0 ? (
                  <div className="px-3 py-4 font-mono text-[9px] text-on-surface-variant">正在加载视图…</div>
                ) : null}
                {KIND_GROUP.map((group) => {
                  const groupViews = views.filter((v) => group.kinds.includes(v.kind));
                  if (groupViews.length === 0) return null;
                  return (
                    <div key={group.heading}>
                      <div className="px-3 pt-2 pb-1 font-mono text-[8px] uppercase tracking-[0.2em] text-on-surface-variant/70 bg-surface-low">
                        {group.heading}
                      </div>
                      {groupViews.map((v) => {
                        const Icon = KIND_ICON[v.kind];
                        const vlive = v.seats ? v.seats.filter((s) => s.live).length : null;
                        const vabsent = v.seats ? v.seats.length - (vlive ?? 0) : 0;
                        const isSel = v.id === selected?.id;
                        return (
                          <button
                            key={v.id}
                            type="button"
                            data-testid={`launcher-view-${v.id}`}
                            aria-pressed={isSel}
                            onClick={() => setSelectedId(v.id)}
                            className={cn(
                              "w-full text-left px-3 py-2 flex items-center gap-3 transition-colors",
                              isSel
                                ? "bg-inverse-surface/[0.06] border-l-2 border-l-on-surface"
                                : "border-l-2 border-l-transparent hover:bg-surface-low",
                            )}
                          >
                            <Icon className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" aria-hidden="true" />
                            <span className="flex-1 min-w-0">
                              <span className="flex items-center gap-2">
                                <span className="font-mono text-[11px] text-on-surface truncate">{v.label}</span>
                                {v.crossRig ? (
                                  <span className="inline-flex items-center gap-1 px-1 py-0.5 text-[8px] font-mono uppercase tracking-[0.12em] border border-outline text-on-surface-variant">
                                    <Eye className="h-2.5 w-2.5" aria-hidden="true" /> 只读
                                  </span>
                                ) : null}
                              </span>
                              <span className="block font-mono text-[9px] text-on-surface-variant truncate">{v.sub}</span>
                            </span>
                            <span className="shrink-0 text-right">
                              {vlive === null ? (
                                <span className="block font-mono text-[9px] text-on-surface-variant">派生</span>
                              ) : (
                                <>
                                  <span className="block font-mono text-[10px] text-on-surface">{vlive} 个在线</span>
                                  {vabsent > 0 ? (
                                    <span className="block font-mono text-[8px] text-warning">{vabsent} 个缺席</span>
                                  ) : null}
                                </>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {/* “保存当前视图”入口——属于路线图预留能力，当前如实禁用（v1 使用手写 YAML）。 */}
                <button
                  type="button"
                  disabled
                  data-testid="launcher-save-view"
                  className="w-full text-left px-3 py-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant/60 hover:bg-surface-low disabled:cursor-default"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" /> 将当前排列保存为视图…
                </button>
              </div>
            </section>

            {/* ── LAYOUT ── */}
            <section data-testid="launcher-layout" className="grid grid-cols-[auto_1fr] gap-4 items-center">
              <div className="shrink-0">
                <div
                  aria-hidden="true"
                  className="grid gap-1 p-1.5 border border-outline-variant bg-surface-low"
                  style={{ gridTemplateColumns: `repeat(${layout.cols}, 14px)`, gridTemplateRows: `repeat(${layout.rows}, 12px)` }}
                >
                  {Array.from({ length: layout.shown }).map((_, i) => (
                    <span key={i} className="bg-on-surface/70" />
                  ))}
                </div>
              </div>
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant mb-1">布局</div>
                <div className="font-mono text-[11px] text-on-surface">
                  自动网格 · {layout.cols}×{layout.rows} · {layout.shown} 个窗格
                </div>
                {layout.paged > 0 ? (
                  <div className="font-mono text-[9px] text-warning mt-0.5">另有 {layout.paged} 个已分页 · 请在设置中调大显示上限</div>
                ) : (
                  <div className="font-mono text-[9px] text-on-surface-variant mt-0.5">未超出显示上限（{PANE_CAP}）· 无分页</div>
                )}
              </div>
            </section>

            {/* ── FOOTER ── */}
            <div className="flex items-center justify-between gap-3 pt-1 border-t border-outline-variant">
              <div className="min-w-0">
                <StatusPip
                  status={readOnly ? "info" : "active"}
                  variant="pill"
                  label={readOnly ? "只读 · 跨工作组" : "可交互"}
                  testId="launcher-mode-pip"
                />
                <div className="mt-1.5 font-mono text-[9px] text-on-surface-variant leading-relaxed">
                  打开 <span className="text-on-surface">{layout.shown}</span> 个窗格
                  {absent.length > 0 ? (
                    <>
                      {" · "}
                      <span className="text-warning" data-testid="launcher-honest-partial">
                        {absent.length} 个缺席（{absent.map((s) => `${s.session.split("@")[0]}: ${s.reason}`).join(", ")}）
                      </span>
                    </>
                  ) : (
                    <> · 全部席位活跃</>
                  )}
                </div>
                {openMut.data
                  ? (() => {
                      // Guard G2：200 响应体是权威事实，但不自动代表成功；opened.length === 0
                      // 必须披露失败，绝不能显示“已打开 0 个”。
                      const d = describeOpenResult(openMut.data);
                      return (
                        <div
                          className={cn("mt-1 font-mono text-[9px]", d.ok ? "text-success" : "text-error")}
                          data-testid={d.ok ? "launcher-open-result" : "launcher-open-zero"}
                        >
                          {d.headline}
                          {d.disclosure ? <span className="block text-warning">{d.disclosure}</span> : null}
                        </div>
                      );
                    })()
                  : openMut.isError ? (
                      <div className="mt-1 font-mono text-[9px] text-error" data-testid="launcher-open-error">
                        {(openMut.error as Error).message}
                      </div>
                    ) : null}
              </div>
              <button
                type="button"
                data-testid="launcher-open"
                disabled={openMut.isPending || !selected}
                onClick={() => openMut.mutate()}
                className="shrink-0 inline-flex items-center gap-2 bg-inverse-surface text-background px-4 py-2.5 font-headline font-bold uppercase tracking-widest text-[11px] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-60"
              >
                <Terminal className="h-3.5 w-3.5" aria-hidden="true" />
                {openMut.isPending ? "正在打开…" : `在 ${providerLabel} 中打开 ${layout.shown} 个`}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
