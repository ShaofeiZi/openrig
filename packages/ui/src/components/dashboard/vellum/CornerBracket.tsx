// L 形 90° 角括号。用在目标卡片的 4 个角，登记卡片的包围盒（印刷/CAD 对位标记）。
// “L”的两腿在 10×10 viewBox 下约 10px；括号朝内，使 L 的拐角贴住卡片外角。

interface CornerBracketProps {
  position: "tl" | "tr" | "bl" | "br";
}

export function CornerBracket({ position }: CornerBracketProps) {
  const positionClass = {
    tl: "top-1.5 left-1.5",
    tr: "top-1.5 right-1.5",
    bl: "bottom-1.5 left-1.5",
    br: "bottom-1.5 right-1.5",
  }[position];
  const path = {
    tl: "M 10 0 L 0 0 L 0 10",
    tr: "M 0 0 L 10 0 L 10 10",
    bl: "M 0 0 L 0 10 L 10 10",
    br: "M 10 0 L 10 10 L 0 10",
  }[position];
  return (
    <svg
      className={`absolute ${positionClass} w-2.5 h-2.5 text-on-surface pointer-events-none select-none`}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <path d={path} />
    </svg>
  );
}
