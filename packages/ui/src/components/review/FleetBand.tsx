// OPR.0.4.6.MH5——舰队提示带（创始人锁定为两处都放置时的方案 B；/fleet FleetPage 为方案 A）。
// 这是安装在逐主机任务控制台上方的环境式例外管理提醒：汇总、带主机标签的最严重一行，以及
//“打开舰队”入口。该入口落到对应路由，形成锁定的工作时扫视 → 放大分诊循环。它与路由使用
// 同一个 useFleet 读取（一个聚合、两个界面，即锁定的共享契约），因此两处永远不会不一致。
//
// 明确的无舰队行为（rev1-r1 说明 #3，这是代码级决定，而非证明支路的推论）：没有注册远程主机时
//（单主机操作人员，舰队只有本机），提示带不渲染任何内容；下方逐主机任务控制台与 MH5 之前的
// 渲染保持字节一致，即支路 7 的零回归固定点。注册表存在但不可读时仍会渲染，以提供如实的环境
// 信号；存在至少一个远程成员的舰队也会渲染。加载/错误状态不渲染任何内容：环境提示带绝不阻塞
// 或惊扰其所在页面。
//
// 仅供查看（守卫绑定说明 #1）：此提示带只渲染文本和一个导航动作，不导入操作，也不提供变更入口。

import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import { useFleet } from "../../hooks/useFleet.js";
import { useHosts } from "../../hooks/useHosts.js";

function BandHostChip({ hostId }: { hostId: string }) {
  return (
    <span
      className={cn(
        "shrink-0 border px-1 font-mono text-[9px] uppercase tracking-wide",
        hostId === "local" ? "border-outline-variant text-on-surface-variant" : "border-on-surface text-on-surface",
      )}
    >
      {hostId}
    </span>
  );
}

export function FleetBand() {
  // 这是获取守卫，而不仅是渲染守卫（FS-1 放大器纪律）：存在已注册主机时启用舰队读取；
  // 信号来自应用自身的 ["hosts"] 缓存。该观察者与始终挂载的 HostIndicator 轮询器去重，
  // 因此不会增加请求量。
  //
  // guard B1（2a9e1dbf 回修）：hosts 读取失败绝不能隐藏注册表事实。注册表不可读时 /api/hosts
  // 返回 500；若只在成功时放行，就会静默吞掉 registryError 行本应呈现的状态。hosts 查询报错时
  // 启用舰队读取：后台服务侧组合器是唯一事实来源，会返回舰队或如实的 registryError。只有明确
  // 已知为空的注册表（hosts 读取成功且零行，即单主机操作人员）才继续阻止获取。
  const { data: hostsData, isError: hostsUnavailable } = useHosts();
  const fleetExists = (hostsData?.hosts?.length ?? 0) > 0;
  const { data } = useFleet({ enabled: fleetExists || hostsUnavailable });
  // 单主机操作人员：不发起舰队读取，也不渲染内容；下方页面与 MH5 之前保持字节一致。
  if (!data) return null;
  if (data.hosts.length <= 1 && !data.registryError) return null;

  // 最严重一行：存在异常时取第一个 ▲，否则取第一个 ●。行按组合器的全序返回，最严重项在前。
  const worst = data.needsYou.items.find((i) => i.source === "derived") ?? data.needsYou.items[0];

  return (
    <div data-testid="fleet-band" className={cn("flex flex-wrap items-center gap-2 px-2 py-1.5", VELLUM_CARD)}>
      <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface">机群</span>
      <span data-testid="fleet-band-rollup" className="flex items-center gap-2 font-mono text-[10px]">
        <span className="text-emerald-700">● {data.rollup.needsYouCount}</span>
        <span className="text-amber-700">▲ {data.rollup.exceptionCount}</span>
        <span className="text-on-surface-variant">
          {data.rollup.hostCount} 台主机
          {data.rollup.unreachableCount > 0 ? ` · ${data.rollup.unreachableCount} 台不可达` : ""}
        </span>
      </span>
      {data.registryError ? (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-error">
          主机注册表不可读——仅展示本机概览
        </span>
      ) : worst ? (
        <span data-testid="fleet-band-worst" className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-[10px] text-on-surface-variant">
          最严重：<BandHostChip hostId={worst.hostId} />
          <span className="min-w-0 truncate">{worst.summary}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-on-surface-variant">安静</span>
      )}
      <a href="/fleet" data-testid="fleet-band-open" className="font-mono text-[10px] uppercase text-on-surface hover:underline">
        打开机群 →
      </a>
    </div>
  );
}
