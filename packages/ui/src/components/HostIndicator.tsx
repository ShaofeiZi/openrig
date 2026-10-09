// OPR.0.4.6.MH2 FR-3 —— 当前主机指示器（AppShell 顶栏预留的 V2 右侧槽位控件）。
//
// 始终忠于数据源：本组件与所有重定向读取 hook 都派生自同一份选中值
//（useHosts().selected → useSelectedHostId），因此指示器与屏幕上的数据同步移动——
// 从结构上杜绝 k9s 那种"主机 A 标签盖在主机 B 数据上"的陈旧表头问题。
// 各状态对应锁定的 twin 帧：
//   本机           → 安静的 `<本机名> · 本机`（fr1 —— 本机外观与今日一致）
//   远端已就绪     → 强调色 `⊕ 正在查看 <主机>` 标签（fr2-fr3）
//   远端加载中     → 脉冲动画 `⊕ 正在连接 <主机>…`（fr6-loading；
//                    参照 VS Code Remote 状态机先例）
//   远端不可达（注册表探测）→ 红色 `<主机> · 不可达`（fr6-unreachable）

import { useIsFetching } from "@tanstack/react-query";
import { useHosts } from "../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";

export function HostIndicator() {
  const { data } = useHosts();
  const selected = data?.selected ?? LOCAL_HOST_ID;
  // 只有重定向后的读取查询才在 queryKey 中携带选中的 hostId，
  // 因此这里精确统计正在进行的远端读取数。
  const remoteFetches = useIsFetching({
    predicate: (query) => selected !== LOCAL_HOST_ID && query.queryKey.includes(selected),
  });

  if (selected === LOCAL_HOST_ID) {
    const ownName = data?.ownName && data.ownName.trim() !== "" ? data.ownName : "localhost";
    return (
      <span
        data-testid="host-indicator"
        data-host={LOCAL_HOST_ID}
        data-state="local"
        className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant"
      >
        {ownName} · 本机
      </span>
    );
  }

  const row = data?.hosts.find((h) => h.id === selected);
  if (row?.status === "unreachable") {
    return (
      <span
        data-testid="host-indicator"
        data-host={selected}
        data-state="unreachable"
        className="inline-flex items-center gap-1 border border-error px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-error"
      >
        ⊕ {selected} · 不可达
      </span>
    );
  }
  if (remoteFetches > 0) {
    return (
      <span
        data-testid="host-indicator"
        data-host={selected}
        data-state="connecting"
        className="inline-flex animate-pulse items-center gap-1 border border-outline px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface"
      >
        ⊕ 正在连接 {selected}…
      </span>
    );
  }
  return (
    <span
      data-testid="host-indicator"
      data-host={selected}
      data-state="viewing"
      className="inline-flex items-center gap-1 bg-inverse-surface px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-background"
    >
      ⊕ 正在查看 {selected}
    </span>
  );
}
