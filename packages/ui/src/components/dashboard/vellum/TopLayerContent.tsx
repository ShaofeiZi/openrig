// 第 4 层——顶部内容（堆栈最上方的清晰印刷层）。
//
// 只包含细线条、高清晰元素：
//   - 顶部分类眉题：操作人员 + zrig 版本 + 现场站点主机名
//   - 主视觉区块：欢迎回来 + 统计行（工作组/智能体/活跃）
//   - 右下角“处处留意”印刷标记
//   - 左边距旋转的“作者已隐去”旁注
//   - 底部页脚旁注：终点界面 · 仪表盘 · 01°
//   - 分散悬浮的顶层标记
//
// 四项真实数据输入（hostname / totalRigs / totalAgents / activeAgents）均通过属性传入。
// 实验室默认值保留硬编码 127.0.0.1 和占位数量（01 / 04 / 04 活跃）。

import { FloatingTopMarks } from "./marks.js";

interface TopLayerContentProps {
  hostname?: string;
  totalRigs?: number;
  totalAgents?: number;
  activeAgents?: number;
}

export function TopLayerContent({
  hostname = "127.0.0.1",
  totalRigs = 1,
  totalAgents = 4,
  activeAgents = 4,
}: TopLayerContentProps = {}) {
  return (
    <div
      data-testid="top-layer"
      className="absolute inset-0 z-20 pointer-events-none select-none"
    >
      {/* Classification eyebrow — top of page. */}
      <div
        data-testid="dashboard-classification"
        className="absolute top-0 inset-x-0 border-b border-on-surface/40 bg-background/40 backdrop-blur-[6px]"
      >
        <div className="mx-auto max-w-[1180px] px-6 py-2 flex items-center justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.32em] text-on-surface">
          <span className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 bg-success rounded-none" />
            操作者
          </span>
          <span className="hidden sm:inline">▪ zrig · 0.3.1</span>
          <span className="hidden md:inline">▪ 现场站点 {hostname}</span>
          <span className="hidden md:inline">▪ 会话 04°</span>
          <span className="text-on-surface-variant">04°</span>
        </div>
      </div>

      {/* Hero block — WELCOME BACK + stats. Operator + Field Station
          identification already lives in the classification eyebrow
          above so we don't repeat it here. */}
      <div className="absolute top-[44px] left-[5%] right-[5%] z-20 pointer-events-none">
        <h1
          data-testid="dashboard-greeting"
          className="font-headline text-[44px] font-black tracking-tight uppercase text-on-surface leading-[0.95] inky-display"
        >
          欢迎回来<sup className="text-[22px] tracking-tight align-super">(s*)</sup>
        </h1>
        <div
          data-testid="dashboard-stats"
          className="font-mono text-xs text-on-surface mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1"
        >
          <span data-testid="stat-rigs" className="inline-flex items-baseline gap-1.5">
            <span className="text-on-surface font-bold tabular-nums text-sm">
              {String(totalRigs).padStart(2, "0")}
            </span>
            <span className="uppercase tracking-[0.12em] text-[10px]">工作组</span>
          </span>
          <span aria-hidden="true" className="text-on-surface-variant">·</span>
          <span data-testid="stat-agents" className="inline-flex items-baseline gap-1.5">
            <span className="text-on-surface font-bold tabular-nums text-sm">
              {String(totalAgents).padStart(2, "0")}
            </span>
            <span className="uppercase tracking-[0.12em] text-[10px]">智能体</span>
            <span className="ml-1 text-on-surface-variant">(</span>
            <span className="text-success font-bold tabular-nums">
              {String(activeAgents).padStart(2, "0")}
            </span>
            <span className="uppercase tracking-[0.12em] text-[10px] text-success">活跃</span>
            <span className="text-on-surface-variant">)</span>
          </span>
        </div>
      </div>

      {/* EYES EVERYWHERE — bottom-right printed mark. NO circle/pill
          border per founder iter-15 — just bold serif text with
          smudged inky look + slight angle. */}
      <div className="absolute bottom-8 right-10 rotate-[-4deg] origin-bottom-right">
        <span className="font-headline font-black text-[13px] tracking-[0.02em] text-on-surface uppercase inky-text">
          监视无处不在
        </span>
      </div>

      {/* Scattered floating top-layer marks. */}
      <FloatingTopMarks />

      {/* AUTHOR REDACTED rotated marginalia — left margin. */}
      <div className="absolute left-2 top-[42%] font-mono text-[9px] uppercase tracking-[0.2em] text-on-surface-variant rotate-[-90deg] origin-top-left whitespace-nowrap">
        ▪ 作者已脱敏 · 条目 04°
      </div>

      {/* Footer marginalia — bottom of page. */}
      <div
        data-testid="dashboard-footer-marginalia"
        className="absolute bottom-0 inset-x-0 border-t border-on-surface/40 bg-background/40 backdrop-blur-[6px]"
      >
        <div className="mx-auto max-w-[1180px] px-6 py-2 flex items-center justify-between gap-4 font-mono text-[10px] uppercase tracking-[0.24em] text-on-surface">
          <span>▪▪▪ 末端界面 · 仪表盘 · 01°</span>
          <span className="hidden sm:inline">操作者级 · 配置存储支持</span>
          <span>zrig · 0.3.1</span>
        </div>
      </div>
    </div>
  );
}
