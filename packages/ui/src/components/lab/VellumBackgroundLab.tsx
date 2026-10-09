// Vellum 背景层迭代实验室——按创始人 2026-05-14 派发的 iter 5。
//
// 基于创始人参考照片的两个新选项：
//   - 地形等高线（有机流动曲线铺满画布）
//   - 散布的等距几何图形（线稿图标铺满画布）
//
// 两者都用 iter 4 的 diffuse vellum 设置（bg-surface-lowest/50 +
// backdrop-blur-[26px]）——重淡出，使线稿读作安静的底场，
// 绝不与卡片争夺注意力。
//
//   /lab/vellum-bg/a-large    —— 地形线：约 50 条波浪水平
//                                等高线横跨画布
//                                （地形图 / 木纹质感）
//   /lab/vellum-bg/b-small    —— 等距：约 30 个小等距/线稿
//                                几何图标散布画布
//   /lab/vellum-bg/c-allover  —— 保留——目前同 a-large

import { VellumLab } from "./VellumLab.js";

export function VellumBgLarge() {
  return (
    <VellumLab
      backLayerOverride={<TopoLinesBackground />}
      vellumSheetOverride={<DiffuseVellumSheet />}
    />
  );
}
export function VellumBgSmall() {
  return (
    <VellumLab
      backLayerOverride={<IsometricShapesBackground />}
      vellumSheetOverride={<MoreDiffuseVellumSheet />}
    />
  );
}
export function VellumBgAllover() {
  // Iter 25——按创始人派发切回地形线，但现在带无缝水平滚动动画。
  // 图案宽 2× 视口，波浪周期 = 视口宽，故 translate3d(-50%, 0, 0)
  // 循环而无可见接缝。
  return (
    <VellumLab
      backLayerOverride={<ScrollingTopoLinesBackground />}
      vellumSheetOverride={<HeavyDiffuseVellumSheet />}
    />
  );
}

function HeavyDiffuseVellumSheet() {
  // Iter 28：去掉交错 inset（原为 top-14/bottom-12/left-16/right-14），
  // 扩展到整个视口（inset-0）。地形线图形在页面边缘露出时不好看；
  // 作为 vellum 之下处处连续的动画底场效果最佳。
  return (
    <div
      data-testid="vellum-sheet-heavy-diffuse"
      aria-hidden="true"
      className="absolute inset-0 z-[5] bg-surface-lowest/25 backdrop-blur-[8px] pointer-events-none"
    />
  );
}

/* ====================================================================
   滚动地形线——周期波，无缝水平循环
   ==================================================================== */
function ScrollingTopoLinesBackground() {
  // 图案宽 2× 视口。每个波函数在周期（PATTERN_W = 1280）上用整数个周期，
  // 使 x=0 处的波等于 x=1280 处的波；第二个 1280 宽的半幅镜像前半；
  // 把 translateX 从 0 动画到 -50% 循环而无可见接缝。
  const PATTERN_W = 1280;
  const VIEW_W = PATTERN_W * 2; // 共 2560
  const VIEW_H = 1100;
  const lineSpacing = 40;
  const lineCount = Math.ceil(VIEW_H / lineSpacing) + 2;

  // 把像素 x 转成周期波的角度，每个图案 N 个周期
  const cycle = (x: number, n: number, phase = 0) =>
    (x / PATTERN_W) * Math.PI * 2 * n + phase;

  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const baseY = i * lineSpacing - 40;
    let path = `M 0 ${baseY.toFixed(2)}`;
    for (let x = 0; x <= VIEW_W; x += 32) {
      // 3 个叠加正弦波；全用整数周期数，使 x=0 处的总 dy 等于 x=PATTERN_W 处（无缝循环）。
      const w1 = Math.sin(cycle(x, 2, i * 0.3)) * 36;
      const w2 = Math.sin(cycle(x, 5, i * 0.5)) * 9;
      const w3 = Math.sin(cycle(x, 3, i * 0.18)) * 14;
      const dy = w1 + w2 + w3;
      path += ` L ${x} ${(baseY + dy).toFixed(2)}`;
    }
    lines.push(path);
  }

  return (
    <div
      data-testid="back-layer-scrolling-topo"
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none"
    >
      {/* SVG 宽 2× 视口；CSS 在 60s 内平移 -50%，无缝循环 */}
      <svg
        className="absolute top-0 left-0 h-full vellum-scroll-x"
        style={{ width: "200%" }}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid slice"
      >
        {lines.map((d, idx) => (
          <path
            key={idx}
            d={d}
            stroke="#1c1917"
            strokeWidth="1.0"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    </div>
  );
}

/* ====================================================================
   极简大图形——3 个巨大形状，非常弥散
   近乎空白的背景层。每个对象 600-900px，即使重度模糊轮廓仍可辨认。
   卡片的环境阴影负责定义卡边；背景层只增加纵深。
   ==================================================================== */
function MinimalLargeBackground() {
  return (
    <div
      data-testid="back-layer-minimal-large"
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none text-on-surface"
    >
      {/* 同心靶心，左上出血（约 800px）——漂移 A */}
      <svg
        className="absolute -top-40 -left-40 w-[820px] h-[820px] vellum-drift-a"
        viewBox="0 0 200 200"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <circle cx="100" cy="100" r="94" />
        <circle cx="100" cy="100" r="74" />
        <circle cx="100" cy="100" r="54" />
        <circle cx="100" cy="100" r="34" />
        <circle cx="100" cy="100" r="14" fill="currentColor" />
        <line x1="0" y1="100" x2="200" y2="100" />
        <line x1="100" y1="0" x2="100" y2="200" />
      </svg>

      {/* 六芒星，右下出血（约 700px）——漂移 B */}
      <svg
        className="absolute -bottom-32 -right-28 w-[720px] h-[720px] vellum-drift-b"
        viewBox="0 0 200 200"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <polygon points="100,12 178,148 22,148" />
        <polygon points="100,188 178,52 22,52" />
        <circle cx="100" cy="100" r="60" />
      </svg>

      {/* 曼陀罗放射——居中，微出血（约 600px）——漂移 C */}
      <svg
        className="absolute top-[28%] left-[28%] w-[620px] h-[620px] vellum-drift-c"
        viewBox="0 0 200 200"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <circle cx="100" cy="100" r="92" />
        <circle cx="100" cy="100" r="62" />
        <circle cx="100" cy="100" r="32" />
        {Array.from({ length: 24 }).map((_, i) => {
          const angle = (i / 24) * Math.PI * 2;
          const x2 = 100 + Math.cos(angle) * 92;
          const y2 = 100 + Math.sin(angle) * 92;
          return <line key={i} x1="100" y1="100" x2={x2.toFixed(2)} y2={y2.toFixed(2)} />;
        })}
      </svg>
    </div>
  );
}

function DiffuseVellumSheet() {
  // 中等（bg-surface-lowest/35 + blur-[14px]）——地形线变体用。
  return (
    <div
      data-testid="vellum-sheet-diffuse"
      aria-hidden="true"
      className="absolute top-[14px] bottom-[12px] left-[16px] right-[14px] z-[5] bg-surface-lowest/35 backdrop-blur-[14px] pointer-events-none"
    />
  );
}
function MoreDiffuseVellumSheet() {
  // Iter 7：按创始人请求，等距变体更弥散。介于中等（35/14）与弥散（50/26）之间——
  // bg-surface-lowest/45 + blur-[22px]。较重形状仍可读；卡片更漂浮。
  return (
    <div
      data-testid="vellum-sheet-more-diffuse"
      aria-hidden="true"
      className="absolute top-[14px] bottom-[12px] left-[16px] right-[14px] z-[5] bg-surface-lowest/45 backdrop-blur-[22px] pointer-events-none"
    />
  );
}

/* ====================================================================
   地形线——铺满画布的波浪等高线
   ==================================================================== */
function TopoLinesBackground() {
  // Iter 6：更少更粗的线，使其透过 vellum 清晰可读。线数从约 70 降到约 28；
  // 线宽 1.2 → 2.4。
  const viewBoxW = 1280;
  const viewBoxH = 1100;
  const lineSpacing = 40; // 线距 px（原 16）
  const lineCount = Math.ceil(viewBoxH / lineSpacing) + 2;

  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const baseY = i * lineSpacing - 40;
    let path = `M -50 ${baseY.toFixed(2)}`;
    for (let x = 0; x <= viewBoxW + 100; x += 40) {
      const t = x / viewBoxW;
      const w1 = Math.sin(t * Math.PI * 2.2 + i * 0.28) * 36;
      const w2 = Math.sin(t * Math.PI * 5.8 + i * 0.47) * 9;
      const w3 = Math.sin(t * Math.PI * 3.6 + i * 0.13 + Math.sin(i * 0.5) * 2) * 16;
      const dy = w1 + w2 + w3;
      path += ` L ${x.toFixed(0)} ${(baseY + dy).toFixed(2)}`;
    }
    lines.push(path);
  }

  return (
    <div
      data-testid="back-layer-topo"
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none"
    >
      <svg
        className="w-full h-full"
        viewBox={`0 0 ${viewBoxW} ${viewBoxH}`}
        preserveAspectRatio="xMidYMid slice"
      >
        {lines.map((d, i) => (
          <path
            key={i}
            d={d}
            stroke="#1c1917"
            strokeWidth="1.2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    </div>
  );
}

/* ====================================================================
   等距形状——散布的线稿几何图标
   ==================================================================== */
function IsometricShapesBackground() {
  // Iter 6：数量 42 → 15；尺寸放大 70-110px → 180-260px，使形状透过
  // vellum 清晰可读。跨 4 行散布，留足呼吸空间。
  const placements: IsoPlacement[] = [
    // 顶行（4 个形状）
    { type: "cube", size: 220, pos: "top-[2%] -left-6" },
    { type: "spool", size: 200, pos: "top-[4%] left-[24%]" },
    { type: "x-prism", size: 220, pos: "top-[2%] left-[50%]" },
    { type: "cube-frame", size: 240, pos: "top-[1%] -right-8" },
    // 中上一行（4 个形状）
    { type: "arc-stripes", size: 200, pos: "top-[28%] left-[4%]" },
    { type: "donut-dots", size: 220, pos: "top-[26%] left-[28%]" },
    { type: "hex-prism", size: 220, pos: "top-[26%] left-[54%]" },
    { type: "cylinder-stripes", size: 200, pos: "top-[28%] right-[4%]" },
    // 中下一行（4 个形状）
    { type: "wedge", size: 230, pos: "top-[52%] -left-4" },
    { type: "stairs-iso", size: 240, pos: "top-[50%] left-[24%]" },
    { type: "barrel", size: 220, pos: "top-[52%] left-[50%]" },
    { type: "pacman", size: 240, pos: "top-[50%] -right-6" },
    // 底行（3 个形状）
    { type: "cube-stack", size: 260, pos: "bottom-[-4%] left-[5%]" },
    { type: "L-prism", size: 260, pos: "bottom-[-2%] left-[36%]" },
    { type: "cube-ports", size: 260, pos: "bottom-[-4%] right-[4%]" },
  ];

  return (
    <div
      data-testid="back-layer-isometric"
      aria-hidden="true"
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none select-none"
    >
      {placements.map((p, i) => (
        <IsoShape key={i} {...p} />
      ))}
    </div>
  );
}

type IsoShapeType =
  | "cube" | "cylinder-v" | "triangle-prism" | "rod" | "cube-frame"
  | "stairs" | "spool" | "arc-c" | "diamond-row" | "plus"
  | "cylinder-h" | "wave" | "x-prism" | "tri-stack" | "L-prism"
  | "arc-stripes" | "hex-prism" | "dot-circle" | "wedge" | "down-arrows"
  | "donut-dots" | "bowtie" | "dot-grid" | "arc-half" | "cylinder-stripes"
  | "dot-cloud" | "pacman" | "down-triangles" | "cube-inset" | "hex-small"
  | "cylinder-disc" | "triangle-solid" | "stairs-iso" | "coin"
  | "cube-ports" | "arc-bridge" | "zigzag-v" | "x-flat" | "cube-stack"
  | "back-arrows" | "barrel" | "wave-s";

interface IsoPlacement {
  type: IsoShapeType;
  size: number;
  pos: string;
}

function IsoShape({ type, size, pos }: IsoPlacement) {
  return (
    <div className={`absolute ${pos}`} style={{ width: size, height: size }}>
      <IsoSvg type={type} />
    </div>
  );
}

function IsoSvg({ type }: { type: IsoShapeType }) {
  // Iter 7：按创始人请求把线宽减半 3.2 → 1.6——更细的
  // 线稿读作技术制图，而非重图形。
  const sp = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
  switch (type) {
    case "cube":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="30,8 52,20 52,44 30,56 8,44 8,20" />
          <line x1="30" y1="8" x2="30" y2="32" />
          <line x1="30" y1="32" x2="8" y2="20" />
          <line x1="30" y1="32" x2="52" y2="20" />
        </svg>
      );
    case "cylinder-v":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <ellipse cx="30" cy="14" rx="14" ry="5" />
          <line x1="16" y1="14" x2="16" y2="46" />
          <line x1="44" y1="14" x2="44" y2="46" />
          <path d="M 16 46 A 14 5 0 0 0 44 46" />
        </svg>
      );
    case "triangle-prism":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="14,46 30,12 46,46" />
          <polygon points="46,46 30,12 38,8 54,42" />
          <line x1="14" y1="46" x2="54" y2="42" />
        </svg>
      );
    case "rod":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <line x1="12" y1="48" x2="48" y2="12" strokeWidth="1.5" />
          <circle cx="12" cy="48" r="4" />
          <circle cx="48" cy="12" r="4" />
        </svg>
      );
    case "cube-frame":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="30,8 52,20 52,44 30,56 8,44 8,20" />
          <line x1="30" y1="8" x2="30" y2="32" />
          <line x1="30" y1="32" x2="8" y2="20" />
          <line x1="30" y1="32" x2="52" y2="20" />
          <rect x="22" y="28" width="16" height="16" />
        </svg>
      );
    case "stairs":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polyline points="8,52 18,52 18,42 28,42 28,32 38,32 38,22 48,22 48,12 56,12" />
        </svg>
      );
    case "spool":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <ellipse cx="36" cy="30" rx="14" ry="6" />
          <path d="M 22 30 L 8 30" strokeWidth="1.5" />
          <line x1="36" y1="14" x2="36" y2="22" />
        </svg>
      );
    case "arc-c":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <path d="M 44 12 A 20 20 0 1 0 44 48" strokeWidth="1.5" />
        </svg>
      );
    case "diamond-row":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="8,30 14,24 20,30 14,36" />
          <polygon points="20,30 26,24 32,30 26,36" />
          <polygon points="32,30 38,24 44,30 38,36" />
          <polygon points="44,30 50,24 56,30 50,36" />
        </svg>
      );
    case "plus":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="24,8 36,8 36,24 52,24 52,36 36,36 36,52 24,52 24,36 8,36 8,24 24,24" />
        </svg>
      );
    case "cylinder-h":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <ellipse cx="14" cy="30" rx="5" ry="14" />
          <line x1="14" y1="16" x2="46" y2="16" />
          <line x1="14" y1="44" x2="46" y2="44" />
          <path d="M 46 16 A 5 14 0 0 1 46 44" />
        </svg>
      );
    case "wave":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <path d="M 8 16 Q 18 8 28 16 T 48 16" strokeWidth="1.2" />
          <path d="M 8 30 Q 18 22 28 30 T 48 30" strokeWidth="1.2" />
          <path d="M 8 44 Q 18 36 28 44 T 48 44" strokeWidth="1.2" />
        </svg>
      );
    case "x-prism":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="14,8 24,8 30,18 36,8 46,8 36,22 46,36 36,36 30,26 24,36 14,36 24,22" />
          <line x1="14" y1="36" x2="20" y2="40" />
          <line x1="46" y1="36" x2="52" y2="40" />
        </svg>
      );
    case "tri-stack":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp} fill="currentColor">
          <polygon points="12,40 18,28 24,40" />
          <polygon points="24,40 30,28 36,40" />
          <polygon points="36,40 42,28 48,40" />
        </svg>
      );
    case "L-prism":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="8,28 28,18 48,28 28,38" />
          <polygon points="28,38 48,28 48,44 28,54" />
          <polygon points="8,28 8,44 28,54 28,38" />
        </svg>
      );
    case "arc-stripes":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <path d="M 12 50 A 22 22 0 0 1 48 14" strokeWidth="1" />
          <path d="M 16 50 A 18 18 0 0 1 48 18" strokeWidth="1" />
          <path d="M 20 50 A 14 14 0 0 1 48 22" strokeWidth="1" />
          <path d="M 24 50 A 10 10 0 0 1 48 26" strokeWidth="1" />
        </svg>
      );
    case "hex-prism":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="30,8 48,18 48,38 30,48 12,38 12,18" />
          <line x1="30" y1="8" x2="30" y2="48" />
          <line x1="12" y1="18" x2="30" y2="28" />
          <line x1="48" y1="18" x2="30" y2="28" />
        </svg>
      );
    case "dot-circle":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" fill="currentColor">
          {Array.from({ length: 16 }).map((_, i) => {
            const angle = (i / 16) * Math.PI * 2;
            const x = 30 + Math.cos(angle) * 22;
            const y = 30 + Math.sin(angle) * 22;
            return <circle key={i} cx={x} cy={y} r="1.8" />;
          })}
        </svg>
      );
    case "wedge":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <path d="M 30 30 L 30 8 A 22 22 0 0 1 52 30 Z" fill="currentColor" />
          <path d="M 30 30 L 8 30 A 22 22 0 0 1 30 8" />
          <line x1="30" y1="30" x2="14" y2="44" />
          <line x1="30" y1="30" x2="22" y2="50" />
          <line x1="30" y1="30" x2="34" y2="52" />
        </svg>
      );
    case "down-arrows":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp} fill="currentColor">
          <polygon points="20,8 40,8 30,22" />
          <polygon points="20,22 40,22 30,36" />
          <polygon points="20,36 40,36 30,50" />
        </svg>
      );
    case "donut-dots":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <circle cx="30" cy="30" r="22" />
          <circle cx="30" cy="30" r="10" />
          <g fill="currentColor">
            {Array.from({ length: 24 }).map((_, i) => {
              const angle = (i / 24) * Math.PI * 2 + 0.08;
              const r = 16;
              return <circle key={i} cx={30 + Math.cos(angle) * r} cy={30 + Math.sin(angle) * r} r="0.9" />;
            })}
          </g>
        </svg>
      );
    case "bowtie":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp} fill="currentColor">
          <polygon points="8,18 22,30 8,42" />
          <polygon points="52,18 38,30 52,42" />
          <circle cx="30" cy="30" r="3" />
        </svg>
      );
    case "dot-grid":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" fill="currentColor">
          {Array.from({ length: 6 }).map((_, r) =>
            Array.from({ length: 6 }).map((_, c) => (
              <circle key={`${r}-${c}`} cx={10 + c * 8} cy={10 + r * 8} r="1.4" />
            ))
          )}
        </svg>
      );
    case "arc-half":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <path d="M 8 38 A 22 22 0 0 1 52 38" strokeWidth="1.5" />
        </svg>
      );
    case "cylinder-stripes":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <ellipse cx="30" cy="14" rx="14" ry="5" />
          <line x1="16" y1="14" x2="16" y2="46" />
          <line x1="44" y1="14" x2="44" y2="46" />
          <path d="M 16 46 A 14 5 0 0 0 44 46" />
          <line x1="22" y1="18" x2="22" y2="44" strokeDasharray="2 2" />
          <line x1="30" y1="19" x2="30" y2="45" strokeDasharray="2 2" />
          <line x1="38" y1="18" x2="38" y2="44" strokeDasharray="2 2" />
        </svg>
      );
    case "dot-cloud":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" fill="currentColor">
          {[[22, 18], [30, 14], [38, 18], [16, 24], [24, 24], [32, 22], [40, 24], [46, 28], [18, 32], [26, 32], [34, 32], [42, 32], [22, 38], [30, 38], [38, 38], [28, 44], [36, 44]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="1.5" />
          ))}
        </svg>
      );
    case "pacman":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <path d="M 30 30 L 52 18 A 22 22 0 1 1 52 42 Z" fill="currentColor" />
          <line x1="20" y1="20" x2="14" y2="14" />
          <line x1="20" y1="40" x2="14" y2="46" />
          <line x1="12" y1="30" x2="6" y2="30" />
        </svg>
      );
    case "down-triangles":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp} fill="currentColor">
          <polygon points="22,12 38,12 30,24" />
          <polygon points="22,28 38,28 30,40" />
        </svg>
      );
    case "cube-inset":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="30,4 50,16 50,36 30,48 10,36 10,16" />
          <line x1="30" y1="4" x2="30" y2="48" />
          <line x1="10" y1="16" x2="30" y2="28" />
          <line x1="50" y1="16" x2="30" y2="28" />
          <rect x="22" y="46" width="16" height="10" />
        </svg>
      );
    case "hex-small":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="30,18 42,24 42,38 30,44 18,38 18,24" />
        </svg>
      );
    case "cylinder-disc":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <ellipse cx="34" cy="30" rx="14" ry="5" />
          <path d="M 20 30 A 14 5 0 0 1 48 30" />
          <line x1="20" y1="30" x2="20" y2="36" strokeWidth="1.5" />
          <ellipse cx="20" cy="36" rx="3" ry="1.4" />
          <path d="M 20 30 L 14 32" />
        </svg>
      );
    case "triangle-solid":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" fill="currentColor">
          <polygon points="30,16 46,44 14,44" />
        </svg>
      );
    case "stairs-iso":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="8,40 16,36 24,40 16,44" />
          <polygon points="16,36 24,32 32,36 24,40" />
          <polygon points="24,32 32,28 40,32 32,36" />
          <polygon points="32,28 40,24 48,28 40,32" />
          <polygon points="40,24 48,20 56,24 48,28" />
        </svg>
      );
    case "coin":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <ellipse cx="30" cy="26" rx="14" ry="6" />
          <path d="M 16 26 L 16 34 A 14 6 0 0 0 44 34 L 44 26" />
          <line x1="22" y1="26" x2="22" y2="34" />
          <line x1="30" y1="32" x2="30" y2="38" />
          <line x1="38" y1="26" x2="38" y2="34" />
        </svg>
      );
    case "cube-ports":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="30,6 52,18 52,42 30,54 8,42 8,18" />
          <line x1="30" y1="6" x2="30" y2="30" />
          <line x1="30" y1="30" x2="8" y2="18" />
          <line x1="30" y1="30" x2="52" y2="18" />
          <circle cx="20" cy="20" r="2.5" fill="currentColor" />
          <circle cx="40" cy="20" r="2.5" fill="currentColor" />
          <circle cx="30" cy="42" r="2.5" fill="currentColor" />
        </svg>
      );
    case "arc-bridge":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <path d="M 8 44 Q 30 8 52 44" strokeWidth="1.5" />
          <circle cx="30" cy="44" r="3" fill="currentColor" />
        </svg>
      );
    case "zigzag-v":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polyline points="24,8 36,16 24,24 36,32 24,40 36,48" strokeWidth="1.5" />
          <polyline points="20,12 32,20 20,28 32,36 20,44 32,52" strokeWidth="1.5" />
        </svg>
      );
    case "x-flat":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp} fill="currentColor">
          <polygon points="14,14 22,14 30,22 38,14 46,14 36,28 46,46 38,46 30,34 22,46 14,46 24,28" />
        </svg>
      );
    case "cube-stack":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <polygon points="14,30 22,26 30,30 22,34" />
          <polygon points="22,34 30,30 30,38 22,42" />
          <polygon points="14,30 14,38 22,42 22,34" />
          <polygon points="30,22 38,18 46,22 38,26" />
          <polygon points="38,26 46,22 46,30 38,34" />
          <polygon points="30,22 30,30 38,34 38,26" />
        </svg>
      );
    case "back-arrows":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp} fill="currentColor">
          <polygon points="42,16 42,44 24,30" />
          <polygon points="28,16 28,44 10,30" />
        </svg>
      );
    case "barrel":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <ellipse cx="44" cy="30" rx="6" ry="14" />
          <line x1="44" y1="16" x2="14" y2="20" />
          <line x1="44" y1="44" x2="14" y2="40" />
          <ellipse cx="14" cy="30" rx="4" ry="10" />
          <line x1="20" y1="20" x2="20" y2="40" strokeDasharray="2 2" />
          <line x1="28" y1="19" x2="28" y2="41" strokeDasharray="2 2" />
          <line x1="36" y1="18" x2="36" y2="42" strokeDasharray="2 2" />
        </svg>
      );
    case "wave-s":
      return (
        <svg className="w-full h-full text-on-surface" viewBox="0 0 60 60" {...sp}>
          <path d="M 22 8 Q 32 18 22 28 T 22 48" strokeWidth="1.5" />
          <path d="M 38 8 Q 28 18 38 28 T 38 48" strokeWidth="1.5" />
        </svg>
      );
  }
}
