// 第 0 层——背部内容（粗黑、满出血）。
//
// 使用 100% 不透明的粗黑字体和非对称满出血布局。之所以看起来像“深层模糊背景”，只是因为
// 背部 vellum 纸张覆盖在其上；绝不能用透明度伪造淡出。
//
// 主机名出现在两处：操作人员区块和底部序列码行。生产环境读取实时主机，实验室默认值保持
// 127.0.0.1。

interface BackLayerContentProps {
  hostname?: string;
}

export function BackLayerContent({ hostname = "127.0.0.1" }: BackLayerContentProps = {}) {
  return (
    <div
      data-testid="back-layer"
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none"
    >
      {/* OPERATOR — full bleed left edge */}
      <div className="absolute top-[14%] -left-12 font-mono text-[9rem] leading-[0.85] tracking-[-0.02em] font-black text-on-surface whitespace-pre">
        {`操作者\n04°·直播\n${hostname}`}
      </div>

      {/* RIG·OS(s*) —— 全出血右边，与 OPERATOR 平衡 */}
      <div className="absolute top-[42%] -right-10 font-headline font-black text-[14rem] leading-[0.82] tracking-[-0.06em] text-on-surface whitespace-nowrap">
        zrig·OS<sup className="text-[6rem] tracking-[-0.04em] align-super">(s*)</sup>
      </div>

      {/* 07/?? massive numeral — top-right anchor */}
      <div className="absolute top-[4%] right-[8%] font-headline font-black text-[12rem] leading-none tracking-[-0.06em] text-on-surface">
        07/??
      </div>

      {/* ■ 04° massive mark — mid */}
      <div className="absolute top-[58%] left-[36%] font-headline font-black text-[7rem] leading-none tracking-[-0.04em] text-on-surface">
        ■ 04°
      </div>

      {/* VII Roman numeral — left of center */}
      <div className="absolute top-[6%] left-[42%] font-headline font-black italic text-[9rem] leading-none tracking-[-0.06em] text-on-surface">
        VII
      </div>

      {/* PHOBOS® — full bleed bottom-right */}
      <div className="absolute -bottom-6 -right-2 font-headline font-black text-[9rem] leading-none tracking-[-0.06em] text-on-surface uppercase">
        Phobos®
      </div>

      {/* OS·Ø stacked massive letterforms — back of back, mid-canvas */}
      <div className="absolute top-[28%] left-[8%] font-headline font-black text-[24rem] leading-[0.8] tracking-[-0.06em] text-on-surface uppercase whitespace-pre">
        {`OS·\nØ`}
      </div>

      {/* Ⅸ Roman numeral atmospheric mid-bottom */}
      <div className="absolute bottom-[10%] left-[48%] font-headline font-black italic text-[14rem] leading-none tracking-[-0.06em] text-on-surface">
        Ⅸ
      </div>

      {/* Curved "Field·Realm·Map" near bottom (full-bleed left) */}
      <svg className="absolute -bottom-10 -left-10 w-[520px] h-[200px] text-on-surface" viewBox="0 0 520 200" fill="none">
        <defs>
          <path id="vellum-curve-path-back" d="M 20 140 Q 260 30 500 140" />
        </defs>
        <text fontSize="58" fontFamily="'Space Grotesk', sans-serif" fontWeight="900" fill="currentColor" letterSpacing="2">
          <textPath href="#vellum-curve-path-back">现场·领域·地图</textPath>
        </text>
      </svg>

      {/* Bottom-mid bold serial code line — full bleed bottom */}
      <div className="absolute bottom-2 left-[28%] font-mono text-[3rem] leading-none tracking-[-0.02em] font-black text-on-surface whitespace-nowrap">
        ▪ {hostname} / 发布 0.3.1
      </div>
    </div>
  );
}
