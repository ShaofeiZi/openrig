// 中层和顶层使用的散落悬浮文字标记。
//
// FloatingTopMarks：微小的顶层悬浮注释，稀疏、纤细、清晰，营造“随机文字碎片”的故障艺术感。
//
// ScatteredMarks：稍大的中层散落标记，位于第 2 层，即背部 vellum 纸张与目标卡片之间。

export function FloatingTopMarks() {
  // 第 32 次迭代移除了 top-[28%] left-[28%] [?]，因为它会遮挡拓扑卡片的树图。
  // 剩余标记继续维持散落的故障艺术感。
  const marks: Array<{ pos: string; text: string; size?: string }> = [
    { pos: "top-[18%] left-[36%]", text: "▪ 03°", size: "text-[10px]" },
    { pos: "top-[24%] right-[34%]", text: "**", size: "text-base" },
    { pos: "top-[44%] left-[44%]", text: "+", size: "text-sm" },
    { pos: "top-[52%] right-[36%]", text: "(A)", size: "text-[10px]" },
    { pos: "bottom-[34%] left-[20%]", text: "[?]", size: "text-sm" },
    { pos: "bottom-[42%] right-[24%]", text: "▪ 06°", size: "text-[10px]" },
    { pos: "bottom-[18%] left-[58%]", text: "+", size: "text-sm" },
  ];
  return (
    <>
      {marks.map((m, i) => (
        <span
          key={i}
          className={`absolute ${m.pos} ${m.size ?? "text-xs"} font-mono text-on-surface leading-none`}
        >
          {m.text}
        </span>
      ))}
    </>
  );
}

interface ScatteredMarksProps {
  tier?: "mid" | "back";
}

export function ScatteredMarks({ tier = "mid" }: ScatteredMarksProps) {
  const sizeBase = tier === "mid" ? "text-base" : "text-2xl";
  const marks: Array<{ pos: string; text: string }> = [
    { pos: "top-[22%] left-[58%]", text: "■ 03°" },
    { pos: "top-[60%] left-[18%]", text: "+" },
    { pos: "bottom-[26%] right-[40%]", text: "■ 06°" },
    { pos: "top-[68%] right-[22%]", text: "▣" },
    { pos: "top-[72%] left-[8%]", text: "**" },
    { pos: "top-[86%] right-[5%]", text: "(A)" },
  ];
  return (
    <>
      {marks.map((m, i) => (
        <span
          key={i}
          className={`absolute ${m.pos} ${sizeBase} font-mono text-on-surface leading-none`}
        >
          {m.text}
        </span>
      ))}
    </>
  );
}
