// Vellum 目的地卡片 + 布局分发。
//
// 卡片用 vellum 表面（半透明色调 + 背景模糊）包裹一个 Link，并渲染 5 种布局之一。
// SchematicLayout 是 iter-17 创始人所选（中央图形四周四象限标注）；其余布局
// （数字 / 标题 / 统计 / 坐标）一并交付做对比，便于 /lab/vellum-lab 做 A/B。
//
// 生产 dashboard 用 layout="numeral"——这是 iter-15 干净的参考视觉：左侧大号堆叠数字
// （0¹ / 0² 等），右上图形，右侧满幅裁切的正文，底部条带放标签 + 图标 + 路由。

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CornerBracket } from "./CornerBracket.js";

export type VellumCardLayout = "numeral" | "headline" | "stat" | "coordinate" | "schematic";
export type VellumCardTint = "white" | "cream" | "stone" | "rose" | "slate" | "sepia" | "mint";
export type VellumCardShadow = "soft" | "hard" | "paper" | "long" | "inset" | "halo" | "ambient" | "none";

export interface VellumDestinationCardProps {
  to: string;
  num: string;
  /** numeral 布局用的两字符堆叠数字（如 "01"）。 */
  big?: string;
  label: string;
  icon: ReactNode;
  body: string;
  graphic: ReactNode;
  positionClass: string;
  /** 标签上的第三强调色 + 一条裁切的警告条（如 FOR YOU）。 */
  accent?: boolean;
  /** 大数字 + 正文上的墨色/水洗文字阴影（如 PROJECT）。 */
  washed?: boolean;
  layout?: VellumCardLayout;
  /** schematic 布局用的 4 项标注数组。 */
  callouts?: [string, string, string, string];
  /** 卡片表面的柔和纸色。默认 "white"。 */
  tint?: VellumCardTint;
  /** 投影样式。默认 "none"。 */
  shadow?: VellumCardShadow;
}

export function VellumDestinationCard(props: VellumDestinationCardProps) {
  const {
    to, num, big, label, icon, body, graphic, positionClass,
    accent, washed,
    layout = "numeral",
    callouts,
    tint = "white",
    shadow = "none",
  } = props;

  const numClass = washed ? "inky-display" : "";
  const textClass = washed ? "inky-text" : "";

  // 纸色色调。全部约 /35–/40 透明度，使背景模糊仍做 vellum 的活，
  // 但表面带上柔和的暖/冷色调。
  const tintBg: Record<VellumCardTint, string> = {
    white: "bg-surface-lowest/30",
    cream: "bg-amber-50/45",
    stone: "bg-surface-low/45",
    rose:  "bg-rose-50/45",
    slate: "bg-slate-50/50",
    sepia: "bg-yellow-50/45",
    mint:  "bg-emerald-50/40",
  };

  const shadowStyle: Record<VellumCardShadow, React.CSSProperties> = {
    none: {},
    soft: { boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)" },
    hard: { boxShadow: "3px 3px 0px #2e342e" },
    paper: { boxShadow: "0 2px 6px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.07)" },
    long: { boxShadow: "6px 6px 18px rgba(0, 0, 0, 0.1)" },
    inset: { boxShadow: "inset 0 1px 2px rgba(255,255,255,0.7), 0 2px 4px rgba(0,0,0,0.04)" },
    halo: { boxShadow: "0 0 24px rgba(0, 0, 0, 0.12)" },
    ambient: {
      boxShadow: [
        "0 2px 4px rgba(0, 0, 0, 0.14)",   // 紧主阴影
        "0 8px 20px rgba(0, 0, 0, 0.16)",  // 中层扩散
        "0 0 40px rgba(0, 0, 0, 0.12)",    // 环境光晕（四周）
      ].join(", "),
    },
  };

  // 若未显式给 `big`，堆叠数字默认用 `num`。
  const stackedNum = big ?? num;

  return (
    <Link
      to={to}
      data-testid={`dashboard-card-${num}`}
      className={`absolute ${positionClass} w-[28%] h-[220px] pointer-events-auto group block`}
    >
      <article
        data-testid={`destination-${num}`}
        style={shadowStyle[shadow]}
        className={`relative h-full ${tintBg[tint]} backdrop-blur-[10px] overflow-hidden transition-transform duration-300 ease-tactical group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0`}
      >
        {/* 四角的 90° 角括号 */}
        <CornerBracket position="tl" />
        <CornerBracket position="tr" />
        <CornerBracket position="bl" />
        <CornerBracket position="br" />

        {/* “■ NN°” 标注标记 */}
        <span className="absolute top-2 right-6 font-mono text-[9px] uppercase tracking-[0.18em] text-on-surface select-none">
          ■ {num}°
        </span>

        {layout === "headline" && (
          <HeadlineLayout label={label} icon={icon} body={body} graphic={graphic} to={to} accent={accent} textClass={textClass} />
        )}
        {layout === "stat" && (
          <StatLayout label={label} num={num} icon={icon} body={body} graphic={graphic} to={to} accent={accent} textClass={textClass} />
        )}
        {layout === "coordinate" && (
          <CoordinateLayout label={label} num={num} icon={icon} body={body} graphic={graphic} to={to} accent={accent} textClass={textClass} />
        )}
        {layout === "schematic" && (
          <SchematicLayout label={label} num={num} icon={icon} body={body} graphic={graphic} to={to} accent={accent} textClass={textClass} callouts={callouts} washed={washed} />
        )}
        {(layout === "numeral" || !layout) && (
          <NumeralLayout big={stackedNum} numClass={numClass} graphic={graphic} body={body} label={label} icon={icon} to={to} accent={accent} textClass={textClass} />
        )}

        {/* 警告条——仅 accent 时（FOR YOU）。 */}
        {accent && (
          <div className="absolute bottom-[88px] right-[-14px] w-[156px] border border-tertiary text-tertiary font-mono text-[7.5px] uppercase tracking-[0.18em] px-1.5 py-[2px] flex items-center gap-1 bg-background/30">
            <span className="inline-block w-[3px] h-[3px] bg-tertiary rounded-full" />
            警告 · 操作员在线
          </div>
        )}
      </article>
    </Link>
  );
}

/* NUMERAL 布局——iter-15 创始人所选（也是生产默认）。
   左侧大号堆叠数字主视觉，右上图形，右侧满幅裁切的正文，
   底部放目的地标签 + 图标 + 路由。 */
interface NumeralLayoutProps {
  big: string;
  numClass: string;
  graphic: ReactNode;
  body: string;
  label: string;
  icon: ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function NumeralLayout({ big, numClass, graphic, body, label, icon, to, accent, textClass }: NumeralLayoutProps) {
  return (
    <>
      <div className={`absolute top-7 left-3 font-headline font-black text-[110px] leading-[0.82] tracking-[-0.06em] text-on-surface select-none ${numClass}`}>
        {big[0]}
        <sup className="text-[55px] tracking-tight align-super">{big[1]}</sup>
      </div>
      <div className="absolute top-7 right-7 w-[58px] h-[58px]">{graphic}</div>
      <p className={`absolute bottom-12 right-1 w-[140px] font-mono text-[8.5px] leading-[1.35] uppercase text-on-surface ${textClass}`}>
        {body}
      </p>
      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-on-surface"}>{icon}</span>
        <h2 className={`font-headline font-black text-[17px] leading-none uppercase tracking-tight ${textClass} ${accent ? "text-tertiary" : "text-on-surface"}`}>
          {label}
        </h2>
        <span className={`ml-auto font-mono text-[9px] tracking-tight text-on-surface-variant ${textClass}`}>
          [{to}] →
        </span>
      </div>
    </>
  );
}

/* HEADLINE 布局——spike：目的地名即主视觉。 */
interface HeadlineLayoutProps {
  label: string;
  icon: ReactNode;
  body: string;
  graphic: ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function HeadlineLayout({ label, icon, body, graphic, to, accent, textClass }: HeadlineLayoutProps) {
  return (
    <>
      <h2 className={`absolute top-6 left-3 right-3 font-headline font-black text-[40px] leading-[0.95] uppercase tracking-tight text-on-surface ${textClass} ${accent ? "text-tertiary" : ""}`}>
        {label}
      </h2>
      <div className="absolute top-[88px] left-3 right-3 h-px bg-inverse-surface/30" />
      <div className="absolute top-[100px] left-3 w-[60px] h-[60px]">{graphic}</div>
      <p className={`absolute top-[100px] left-[80px] right-1 font-mono text-[8.5px] leading-[1.35] uppercase text-on-surface ${textClass}`}>
        {body}
      </p>
      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-on-surface"}>{icon}</span>
        <span className={`font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface ${textClass}`}>
          目的地 · 01°
        </span>
        <span className={`ml-auto font-mono text-[9px] tracking-tight text-on-surface-variant ${textClass}`}>
          [{to}] →
        </span>
      </div>
    </>
  );
}

/* STAT 布局——真实数据主视觉。演示用占位。 */
interface StatLayoutProps {
  label: string;
  num: string;
  icon: ReactNode;
  body: string;
  graphic: ReactNode;
  to: string;
  accent?: boolean;
  textClass: string;
}
function StatLayout({ label, num, icon, body, graphic, to, accent, textClass }: StatLayoutProps) {
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface select-none">
        ▪ {label} · {num}°
      </div>
      <div className="absolute top-9 right-9 w-[36px] h-[36px]">{graphic}</div>
      <div className="absolute top-[44px] left-3 flex items-baseline gap-3">
        <span className={`font-headline font-black text-[64px] leading-[0.82] tracking-[-0.04em] text-on-surface tabular-nums ${textClass}`}>
          38
        </span>
        <div className="flex flex-col leading-tight">
          <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface">活动</span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface">产物</span>
        </div>
      </div>
      <div className="absolute top-[120px] left-3 right-3 grid grid-cols-3 gap-0">
        <StatCell big="12" small="规格" />
        <StatCell big="08" small="插件" />
        <StatCell big="18" small="技能" />
      </div>
      <p className={`absolute bottom-12 left-3 right-1 font-mono text-[8px] leading-[1.3] uppercase text-on-surface ${textClass}`}>
        {body}
      </p>
      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-on-surface"}>{icon}</span>
        <h2 className={`font-headline font-black text-[15px] leading-none uppercase tracking-tight ${accent ? "text-tertiary" : "text-on-surface"}`}>
          {label}
        </h2>
        <span className="ml-auto font-mono text-[9px] tracking-tight text-on-surface-variant">
          [{to}] →
        </span>
      </div>
    </>
  );
}
function StatCell({ big, small }: { big: string; small: string }) {
  return (
    <div className="border-l border-on-surface/30 first:border-l-0 pl-2">
      <div className="font-mono text-[14px] font-bold tabular-nums text-on-surface leading-none">{big}</div>
      <div className="font-mono text-[8px] uppercase tracking-wide text-on-surface-variant mt-0.5">{small}</div>
    </div>
  );
}

/* COORDINATE 布局——带标尺刻度的精密仪器框。 */
function CoordinateLayout({ label, num, icon, body, graphic, to, accent, textClass }: StatLayoutProps) {
  const ticks = Array.from({ length: 12 });
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface select-none">
        ▪ {label} · {num}°
      </div>
      <div className="absolute top-7 left-6 right-6 flex justify-between">
        {ticks.map((_, i) => (
          <span key={i} className={`w-px h-[6px] ${i % 3 === 0 ? "bg-inverse-surface" : "bg-inverse-surface/40"}`} />
        ))}
      </div>
      <div className="absolute bottom-12 left-6 right-6 flex justify-between">
        {ticks.map((_, i) => (
          <span key={i} className={`w-px h-[6px] ${i % 3 === 0 ? "bg-inverse-surface" : "bg-inverse-surface/40"}`} />
        ))}
      </div>
      <div className="absolute top-12 bottom-16 left-3 flex flex-col justify-between">
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} className={`h-px w-[6px] ${i % 2 === 0 ? "bg-inverse-surface" : "bg-inverse-surface/40"}`} />
        ))}
      </div>
      <div className="absolute top-12 bottom-16 right-3 flex flex-col justify-between">
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} className={`h-px w-[6px] ${i % 2 === 0 ? "bg-inverse-surface" : "bg-inverse-surface/40"}`} />
        ))}
      </div>
      <div className="absolute top-[40px] left-1/2 -translate-x-1/2 w-[72px] h-[72px]">
        {graphic}
      </div>
      <div className="absolute top-[76px] left-6 right-6 h-px bg-inverse-surface/30" />
      <div className="absolute top-[40px] bottom-[80px] left-1/2 w-px bg-inverse-surface/30" />
      <span className="absolute top-[120px] left-1/2 ml-1 font-mono text-[8px] text-on-surface">
        ⟨x: 24, y: 18⟩
      </span>
      <p className={`absolute bottom-[60px] left-6 right-6 font-mono text-[8px] leading-[1.3] uppercase text-on-surface text-center ${textClass}`}>
        {body}
      </p>
      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-on-surface"}>{icon}</span>
        <h2 className="font-headline font-black text-[15px] leading-none uppercase tracking-tight text-on-surface">
          {label}
        </h2>
        <span className="ml-auto font-mono text-[9px] tracking-tight text-on-surface-variant">
          [{to}] →
        </span>
      </div>
    </>
  );
}

/* SCHEMATIC 布局——图形居中占主导；4 个象限标注编号 .01–.04，
   标注子目的地或侧面。 */
interface SchematicLayoutProps extends StatLayoutProps {
  callouts?: [string, string, string, string];
  washed?: boolean;
}
function SchematicLayout({ label, num, icon, body, graphic, to, accent, textClass, callouts, washed }: SchematicLayoutProps) {
  const items = callouts ?? ["A", "B", "C", "D"];
  return (
    <>
      <div className="absolute top-3 left-3 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface select-none">
        ▪ {label} · {num}°
      </div>
      <div className="absolute top-7 left-1/2 -translate-x-1/2 w-[110px] h-[110px]">
        {graphic}
      </div>
      <Callout num=".01" label={items[0]} positionClass="top-[42px] left-3" align="left" />
      <Callout num=".02" label={items[1]} positionClass="top-[42px] right-3" align="right" />
      <Callout num=".03" label={items[2]} positionClass="top-[98px] left-3" align="left" />
      <Callout num=".04" label={items[3]} positionClass="top-[98px] right-3" align="right" />
      <p className={`absolute bottom-12 left-3 right-3 font-mono text-[8px] leading-[1.3] uppercase text-on-surface text-center ${textClass}`}>
        {body}
      </p>
      <div className="absolute bottom-3 left-3 right-3 flex items-baseline gap-2">
        <span className={accent ? "text-tertiary" : "text-on-surface"}>{icon}</span>
        <h2 className={`font-headline font-black text-[15px] leading-none uppercase tracking-tight ${washed ? "inky-text" : ""} ${accent ? "text-tertiary" : "text-on-surface"}`}>
          {label}
        </h2>
        <span className="ml-auto font-mono text-[9px] tracking-tight text-on-surface-variant">
          [{to}] →
        </span>
      </div>
    </>
  );
}
function Callout({ num, label, positionClass, align }: { num: string; label: string; positionClass: string; align: "left" | "right" }) {
  return (
    <div className={`absolute ${positionClass} font-mono text-[8px] text-on-surface ${align === "right" ? "text-right" : "text-left"}`}>
      <span className="block">{num}</span>
      <span className="block tabular-nums text-on-surface">{label}</span>
    </div>
  );
}
