// 第 2 层——中层内容。
//
// 用纯黑绘制较小的可识别元素。夹在两张纸之间，因此略带朦胧（只有后层纸把它们模糊）。
//
// hostname 出现在两处（Field Report + Data Streams 文案块），使生产环境显示实时主机，
// 而 lab 默认保持 127.0.0.1。

import { ScatteredMarks } from "./marks.js";

interface MidLayerContentProps {
  hostname?: string;
}

export function MidLayerContent({ hostname = "127.0.0.1" }: MidLayerContentProps = {}) {
  return (
    <div
      data-testid="mid-layer"
      aria-hidden="true"
      className="absolute inset-0 z-[10] overflow-hidden pointer-events-none select-none"
    >
      {/* “06° 现场报告”文案块——中左边距 */}
      <div className="absolute top-[64%] left-[3%] font-mono text-[11px] text-on-surface leading-tight max-w-[180px]">
        <div className="font-bold uppercase">▪ 06° 现场报告</div>
        <div className="text-on-surface mt-1">
          操作员会话已在现场站 {hostname} 采集——发布 0.3.1；后台服务轨迹正常。
        </div>
      </div>

      {/* “数据流”小字块 */}
      <div className="absolute bottom-[8%] left-[6%] font-mono text-[11px] text-on-surface leading-tight max-w-[180px]">
        <div className="font-bold uppercase">数据流 ⚠⚠</div>
        <div className="text-on-surface mt-1 text-[10px]">
          x 轴(1) y 轴(2) z 轴(3)——在 {hostname} 同步
        </div>
      </div>

      {/* 散落的中等尺度标记 */}
      <ScatteredMarks tier="mid" />
    </div>
  );
}
