// OPR.0.4.6.MH5 —— 车队关注高度（放置选项 A，创始者锁定的 /fleet 路由；
// 锁同时发布两者——FleetBand 是选项 B）。
//
// 受祝福的任务控制语法提升了一个高度到主机之上：
// 汇总头 → 需要你处理（车队并集，主机归属，● 智能体 vs ▲ 推导同等等级，
// 异常携带内联证据 + 阈值）→ 主机（现场带——每个工厂，诚实的每主机状态；
// 不可达 = 事项缺失而非零 + 真实重新获取重试）→ 已解决（最小化，主机切片）。
// 相同语法，新高度——绝不新接口（mini-req 3）。
//
// 只读表面（FR-5）：边界渲染在表面上；对远端主机事项的操作走 MH-3/MH-4。
// 钻取（FR-4）= MH-2 选定主机重定向（唯一选择写入路径）落在每主机工作区，
// 带车队 ▸ 眉标；下方导航是 MH-2 逐字。汇总数学渲染后台服务的汇总
//（从去重行计算——可对照此表面的主机带检查）。
//
// 路由纪律：像 /agents 一样缩放寻址（寻址，非导航装饰）。展开状态携带
// ?open=<fleetKey>，使每个状态深度链接可寻址（RigAgentsPage 查询参数惯用）。

import { Link } from "@tanstack/react-router";
import { Globe } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import { useFleet } from "../../hooks/useFleet.js";
import type { FleetHostRollup, FleetNeedsYouItem } from "../../hooks/useFleet.js";
import { useSelectHost } from "../../hooks/useHosts.js";

function readSearchParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`;
}

function HostChip({ hostId }: { hostId: string }) {
  return (
    <span
      data-testid={`fleet-item-host-${hostId}`}
      className={cn(
        "shrink-0 border px-1 font-mono text-[9px] uppercase tracking-wide",
        hostId === "local" ? "border-outline-variant text-on-surface-variant" : "border-on-surface text-on-surface",
      )}
    >
      {hostId}
    </span>
  );
}

/** FR-4：唯一钻取动词——MH-2 选定主机重定向（CLI + 主机选择器使用的相同
 *  一条写入路径），然后是带钻取连续性的每主机工作区
 *（?from=fleet 渲染车队 ▸ 眉标；下方表面是不变的 MH-2）。
 * 选择已选主机是幂等的，因此该动词无需本地/远端特殊情况。 */
function useOpenHost() {
  const selectHost = useSelectHost();
  return (hostId: string) => {
    selectHost.mutate(
      { hostId },
      { onSuccess: () => window.location.assign("/project?from=fleet") },
    );
  };
}

function setAddressableOpen(fleetKey: string | null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (fleetKey === null) url.searchParams.delete("open");
  else url.searchParams.set("open", fleetKey);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function FleetNeedsYouRow({
  item,
  expanded,
  onToggle,
  onOpenHost,
}: {
  item: FleetNeedsYouItem;
  expanded: boolean;
  onToggle: () => void;
  onOpenHost: (hostId: string) => void;
}) {
  return (
    <li data-testid={`fleet-needs-you-${item.fleetKey}`} data-source={item.source} className="px-2 py-1.5">
      <button type="button" onClick={onToggle} className="block w-full text-left">
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={cn("font-mono text-[11px]", item.source === "derived" ? "text-amber-700" : "text-emerald-700")}
            title={item.source === "derived" ? "机器推导的异常" : "智能体发起"}
          >
            {item.source === "derived" ? "▲" : "●"}
          </span>
          <HostChip hostId={item.hostId} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-on-surface">{item.summary}</span>
          {item.derived ? (
            <span className="font-mono text-[9px] uppercase tracking-wide text-amber-700">{item.derived.kind}</span>
          ) : null}
          <span className="font-mono text-[10px] text-on-surface-variant">{item.where}</span>
          <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(item.ageIso)}</span>
        </span>
      </button>
      {item.derived ? (
        <p className="mt-0.5 pl-6 font-mono text-[10px] text-on-surface-variant">
          ▲ {item.derived.evidence} · 阈值：{item.derived.threshold}
        </p>
      ) : null}
      {/* FR-3：单一计数是可检查的——此身份在其主机上可见的高度，
          此处仍为一行。 */}
      <p className="mt-0.5 pl-6 font-mono text-[9px] text-on-surface-variant/80">
        计一次 · 从 {item.seenFrom.join(" · ")} 在 {item.hostId} 上可见
      </p>
      {expanded ? (
        <div
          data-testid={`fleet-item-expanded-${item.fleetKey}`}
          className="mt-1.5 ml-6 border border-outline-variant bg-surface-low/50 px-2 py-1.5"
        >
          {/* Q4 单一计数键，逐字。 */}
          <p className="font-mono text-[10px] text-on-surface">
            身份：<span className="text-on-surface-variant">{item.fleetKey}</span>
          </p>
          {item.derived ? (
            <p className="mt-0.5 font-mono text-[10px] text-on-surface">
              证据：<span className="text-on-surface-variant">{item.derived.evidence}</span>
            </p>
          ) : null}
          {/* FR-5：只读表面——边界在表面上。 */}
          <p className="mt-1 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">
            此处只读——对远端主机事项的操作走跨主机路由 (MH-3/MH-4) ·{" "}
            <button type="button" onClick={() => onOpenHost(item.hostId)} className="underline">
              打开 {item.hostId} →
            </button>
          </p>
        </div>
      ) : null}
    </li>
  );
}

function hostGlyph(h: FleetHostRollup): { char: string; cls: string } {
  return h.status.status === "ok" ? { char: "●", cls: "text-emerald-700" } : { char: "✕", cls: "text-error" };
}

export function FleetPage() {
  const { data, isLoading, error, refetch } = useFleet();
  const openHost = useOpenHost();
  const openKey = readSearchParam("open");

  if (isLoading) {
    return <p className="p-4 font-mono text-[11px] text-on-surface-variant">正在编排车队概览…</p>;
  }
  if (error || !data) {
    return (
      <p data-testid="fleet-error" className="p-4 font-mono text-[11px] text-error">
        车队概览不可用：{error instanceof Error ? error.message : "编排器不可达"}
      </p>
    );
  }

  const okHosts = data.hosts.filter((h) => h.status.status === "ok").length;

  return (
    <div data-testid="fleet-page" className="mx-auto max-w-4xl space-y-5 p-4">
      {/* 面包屑——车队是脊柱顶部；一切向下钻取。 */}
      <nav className="flex items-center gap-2 font-mono text-[10px] uppercase text-on-surface-variant">
        <span data-testid="fleet-crumb" className="text-on-surface">车队</span>
        <span>·</span>
        <span>每个工厂，一览无余</span>
      </nav>

      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold uppercase">车队 — 需要我 / 卡住 / 失败</h2>
        {/* FR-3：后台服务的汇总（从去重行计算）——
            可对照下方主机带的每主机计数检查。 */}
        <div data-testid="fleet-rollup" className="flex items-center gap-2 font-mono text-[10px] uppercase">
          <span className="text-emerald-700">● {data.rollup.needsYouCount} 需要你处理</span>
          <span className="text-amber-700">
            ▲ {data.rollup.exceptionCount} 个异常
            {data.rollup.exceptionsByKind.length > 0
              ? `（${data.rollup.exceptionsByKind.map((e) => `${e.count} ${e.kind}`).join(" · ")}）`
              : ""}
          </span>
          <span className="text-on-surface-variant">{data.rollup.hostCount} 台主机</span>
          {data.rollup.unreachableCount > 0 ? (
            <span className="text-error">{data.rollup.unreachableCount} 台不可达</span>
          ) : null}
        </div>
      </header>

      {/* 存在但不可读的注册表被呈现，绝不静默。 */}
      {data.registryError ? (
        <p data-testid="fleet-registry-error" className="font-mono text-[10px] text-error">
          主机注册表不可读——此概览仅本地，非车队：{data.registryError}
        </p>
      ) : null}

      {/* 带 1：需要你处理——车队并集，主机归属，● 和 ▲ 同等等级
         （已发布语法，高一个高度）。 */}
      <section data-testid="fleet-needs-you" className={cn("space-y-1 p-2", VELLUM_CARD)}>
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">需要你处理</h3>
        {data.needsYou.items.length > 0 ? (
          <ul className="divide-y divide-outline-variant/50">
            {data.needsYou.items.map((item) => (
              <FleetNeedsYouRow
                key={item.fleetKey}
                item={item}
                expanded={openKey === item.fleetKey}
                onToggle={() => setAddressableOpen(openKey === item.fleetKey ? null : item.fleetKey)}
                onOpenHost={openHost}
              />
            ))}
          </ul>
        ) : null}
        <p className="font-mono text-[9px] text-on-surface-variant">{data.needsYou.provenance}</p>
      </section>

      {/* 带 2：主机——车队高度的现场带（每个工厂，诚实状态；
          MH-2 钻取是行的动词）。 */}
      <section data-testid="fleet-hosts" className={cn("space-y-1 p-2", VELLUM_CARD)}>
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">主机</h3>
        <ul className="divide-y divide-outline-variant/50">
          {data.hosts.map((h) => {
            const glyph = hostGlyph(h);
            const ok = h.status.status === "ok";
            return (
              <li key={h.hostId} data-testid={`fleet-host-${h.hostId}`} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <span className={cn("font-mono text-[11px]", glyph.cls)}>{glyph.char}</span>
                <Globe className="h-3 w-3 text-on-surface-variant" />
                <span className="font-mono text-[11px] uppercase text-on-surface">{h.hostId}</span>
                {h.kind === "local" ? (
                  <span className="font-mono text-[8px] uppercase text-on-surface-variant">本地</span>
                ) : null}
                {ok ? (
                  <>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-on-surface-variant">{h.topLine}</span>
                    {(h.needsYouCount ?? 0) > 0 ? (
                      <span className="font-mono text-[10px] text-emerald-700">● {h.needsYouCount}</span>
                    ) : null}
                    {(h.exceptionsByKind ?? []).map((e) => (
                      <span key={e.kind} className="font-mono text-[10px] text-amber-700">
                        ▲ {e.count} {e.kind}
                      </span>
                    ))}
                    <span className="font-mono text-[9px] text-on-surface-variant">
                      {h.rigCount} 个工作组 · {h.seatCount} 个席位
                    </span>
                    <button
                      type="button"
                      data-testid={`fleet-host-${h.hostId}-open`}
                      onClick={() => openHost(h.hostId)}
                      className="font-mono text-[10px] uppercase text-on-surface hover:underline"
                    >
                      打开 →
                    </button>
                  </>
                ) : (
                  <>
                    {/* 诚实的每主机真相：事项在此概览中缺失，
                        非零（k9s 过期标题反模式）。 */}
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-error">
                      {h.status.status}
                      {h.status.error ? ` — ${h.status.error}` : ""} · 事项在此概览中缺失，非零
                    </span>
                    <button
                      type="button"
                      data-testid={`fleet-host-${h.hostId}-retry`}
                      onClick={() => void refetch()}
                      className="border border-error px-1.5 py-0.5 font-mono text-[9px] uppercase text-error hover:bg-surface-low"
                    >
                      重试
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* 带 3：已解决——记录带，最小化（D-5），主机切片。 */}
      <section data-testid="fleet-settled" className="space-y-1">
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">已解决</h3>
        {data.settled.length > 0 ? (
          <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
            {data.settled.map((row) => (
              <li key={`${row.hostId}|${row.qitemId}`} className="flex items-center gap-2 px-2 py-1.5">
                <HostChip hostId={row.hostId} />
                <span className="font-mono text-[10px] text-on-surface-variant">{row.fromSession.split("@")[0]}</span>
                <span className="text-on-surface-variant">→</span>
                <span className="font-mono text-[10px] text-on-surface-variant">{row.toSession.split("@")[0]}</span>
                <span className="min-w-0 flex-1 truncate text-[11px]">{row.summary ?? row.qitemId}</span>
                <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(row.closedAtIso)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="font-mono text-[9px] text-on-surface-variant">{data.settledProvenance}</p>
      </section>

      <p data-testid="fleet-fanout-footer" className="font-mono text-[10px] text-on-surface-variant">
        编排于 {data.composedAt} · 车队分发 {okHosts}/{data.hosts.length} 台主机正常 ·{" "}
        <Link to="/agents" className="hover:underline">
          此主机的智能体 →
        </Link>
      </p>
    </div>
  );
}
