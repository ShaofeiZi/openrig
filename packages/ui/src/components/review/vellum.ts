// CORRECTIVE §7.4 — 评审族（review family）统一使用这唯一一套羊皮纸卡片配方。
// 接近背景色并带部分透明度 + 背景模糊：页面的点阵网格在卡片后方呈现为淡淡的
// 弥散效果，绝不锐利——滚动时能感觉到这是一层浮在纸面之上的羊皮纸面板。
// 完全由设计 token 驱动，因此两套主题都无需逐主题修改（--background 随 .dark 翻转）。
export const VELLUM_CARD =
  "border border-outline-variant bg-[hsl(var(--background)/0.82)] backdrop-blur-[2px]";
