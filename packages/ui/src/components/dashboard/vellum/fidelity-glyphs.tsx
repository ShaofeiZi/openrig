// OPR.0.4.1.14 —— 刷新后 Dashboard 路由的保真启动图标。
//
// 几何与创始人锁定的 twin 逐字节一致
// （digital-twin/opr-0.4.1.14/dashboard-fidelity.intent.html）。这些是创始人批准的
// 图标轮次集：既有代码里的仪表盘图标（拓扑六节点 / 项目河流 / for-you 靶心 / Library 地球），
// 加上图标轮次重切的两个——在完美正方形里重新居中的放大镜（搜索）和船舵（设置，仅墨色，
// 区别于 for-you 的琥珀色靶心）。新绘制的创意图标刻意不在此使用；按排期 (a)，
// 最终图标会在图标再确认时换入。
//
// 线宽 + 线帽 + 悬停琥珀色由作用域 CSS 驱动（dashboard-fidelity.css 里的
// .df-glyph svg / .df-cap i svg），因此这些组件与上下文无关：同一组件在卡片里以 84px、
// 在说明文字里以 9px 渲染，从容器取到正确的粗细。一切继承 `currentColor`，所以卡片的
// 悬停规则（color → 琥珀）会给整个图标着色；for-you 中心点带 `df-amf`，静止时保持琥珀。

// ── 01 拓扑——六节点树（既有 TreeGraphic 几何） ───────────────
export function TopologyGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="22" y="6" width="16" height="8" />
      <rect x="6" y="28" width="14" height="8" />
      <rect x="40" y="28" width="14" height="8" />
      <rect x="6" y="48" width="14" height="6" />
      <rect x="22" y="48" width="14" height="6" />
      <rect x="40" y="48" width="14" height="6" />
      <line x1="30" y1="14" x2="13" y2="28" />
      <line x1="30" y1="14" x2="47" y2="28" />
      <line x1="13" y1="36" x2="13" y2="48" />
      <line x1="47" y1="36" x2="47" y2="48" />
      <line x1="13" y1="44" x2="29" y2="48" />
      <line x1="47" y1="44" x2="29" y2="48" />
    </svg>
  );
}

// ── 02 项目——地层“河流”（既有几何；按图标轮次说明去掉 [01] 标记，以免与卡片自身序号冲突） ──
export function ProjectGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M2 26 Q 18 18 30 22 T 58 18" />
      <path d="M2 36 Q 18 28 30 32 T 58 28" strokeDasharray="2 2" />
      <path d="M2 46 Q 18 40 30 42 T 58 38" strokeDasharray="2 2" />
      <circle cx="30" cy="22" r="2" fill="currentColor" />
      <line x1="30" y1="22" x2="30" y2="10" />
    </svg>
  );
}

// ── 03 为你——雷达靶心（既有 PulseGraphic 几何；单一琥珀中心点经 df-amf 静止时保持琥珀） ──
export function ForYouGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="30" cy="30" r="12" />
      <circle cx="30" cy="30" r="20" strokeDasharray="2 3" />
      <circle cx="30" cy="30" r="27" strokeDasharray="2 4" />
      <line x1="30" y1="0" x2="30" y2="60" strokeDasharray="2 3" />
      <line x1="0" y1="30" x2="60" y2="30" strokeDasharray="2 3" />
      <circle className="df-amf" cx="30" cy="30" r="4" />
    </svg>
  );
}

// ── 04 Library——陀螺仪地球（既有 SphereGraphic 几何） ────────────
export function LibraryGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="30" cy="30" r="26" />
      <ellipse cx="30" cy="30" rx="26" ry="9" />
      <ellipse cx="30" cy="30" rx="9" ry="26" />
      <line x1="0" y1="30" x2="60" y2="30" strokeDasharray="2 3" />
      <line x1="30" y1="0" x2="30" y2="60" strokeDasharray="2 3" />
      <circle cx="30" cy="30" r="3" fill="currentColor" />
    </svg>
  );
}

// ── 05 搜索与审计——放大镜在完美正方形中重新居中，四角带对焦括号（图标轮次修复偏心/强制正方形） ──
export function SearchGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M10 18 V10 H18" />
      <path d="M42 10 H50 V18" />
      <path d="M10 42 V50 H18" />
      <path d="M42 50 H50 V42" />
      <circle cx="27" cy="27" r="11" />
      <line x1="22" y1="27" x2="32" y2="27" />
      <line x1="27" y1="22" x2="27" y2="32" />
      <line x1="35" y1="35" x2="44" y2="44" />
    </svg>
  );
}

// ── 06 设置——船舵 / 导航轮：外圈 + 轮毂 + 8 根带柄辐条。仅墨色，在形状与颜色上都区别于
//    for-you 的琥珀靶心（图标轮次修复“过于相似且都是橙色”） ──
export function SettingsGlyph() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="30" cy="30" r="18" />
      <circle cx="30" cy="30" r="6" />
      <circle cx="30" cy="30" r="2" fill="currentColor" />
      <line x1="36" y1="30" x2="53" y2="30" />
      <line x1="24" y1="30" x2="7" y2="30" />
      <line x1="30" y1="36" x2="30" y2="53" />
      <line x1="30" y1="24" x2="30" y2="7" />
      <line x1="34.2" y1="34.2" x2="46.3" y2="46.3" />
      <line x1="25.8" y1="25.8" x2="13.7" y2="13.7" />
      <line x1="34.2" y1="25.8" x2="46.3" y2="13.7" />
      <line x1="25.8" y1="34.2" x2="13.7" y2="46.3" />
    </svg>
  );
}

// ── 现场环境地球——72 单位陀螺仪读数图标 ────────────────
export function FieldGlobeGlyph() {
  return (
    <svg viewBox="0 0 72 72" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="36" cy="36" r="26" />
      <ellipse cx="36" cy="36" rx="9" ry="26" />
      <ellipse cx="36" cy="36" rx="19" ry="26" />
      <line x1="10" y1="36" x2="62" y2="36" />
      <line x1="14" y1="22" x2="58" y2="22" />
      <line x1="14" y1="50" x2="58" y2="50" />
      <line x1="36" y1="2" x2="36" y2="70" strokeDasharray="2 3" />
      <line x1="2" y1="36" x2="70" y2="36" strokeDasharray="2 3" />
    </svg>
  );
}

// ── 说明文字小图标（9px）——按 twin 每张卡片配一个 ─────────────
export type CaptionGlyphKind = "cross" | "square" | "circle";

export function CaptionGlyph({ kind }: { kind: CaptionGlyphKind }) {
  if (kind === "cross") {
    return (
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M2 2l8 8M10 2l-8 8" />
      </svg>
    );
  }
  if (kind === "square") {
    return (
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
        <rect className="df-cap-fill" x="3" y="3" width="6" height="6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
    </svg>
  );
}
