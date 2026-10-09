// OPR.0.4.0.39——统一静态/实时终端镜像的自适应缩放包装器。
//
// 创始人规格（spec-dev2-authored-2026-06-22）：静态终端与实时终端采用完全相同的固定几何尺寸，
// 即实时 xterm 的 90x27。与其在窄列中平移或裁剪固定的 90 列内容，不如按自然宽度渲染，再通过
// CSS transform 缩放整个内容块以适配可用空间。同一个包装器以完全相同的方式缩放静态面板和
// 实时 xterm，因此点击时从玻璃态切换到不透明态，尺寸与位置都保持不变，形成镜像。
//
// 两种适配模式，缩放比例由 ResizeObserver 测量而非猜测：
//   - "width"（默认，用于网格/图/表格单元格）：适配可用宽度，绝不放大超过原生几何尺寸
//     （上限为 1），原点在左上。内容块宽度固定，因此是真正的宽度适配；终端完整宽度始终可见，
//     绝不截断，遵循创始人的“宁可小也不要裁切”。外层高度取缩放后的自然高度，使周围布局正常流动。
//   - "contain"（节点详情面板，为终端提供较大专属区域）：同时适配容器宽高，使终端在 90x27
//     宽高比允许的范围内尽量填满面板；允许在上限内放大以利用空间，保持居中且绝不裁切。
//     非主轴边距均衡成信箱式留白，而不是在左上角留下无用空隙。

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// "contain" 模式的放大上限：为填满大面板可以适度使用 CSS transform 放大，但超过约 2 倍后
// xterm 文字开始变模糊，因此设置上限。
const MAX_CONTAIN_SCALE = 2;

interface ScaleToFitTerminalProps {
  children: ReactNode;
  /** 外层适配容器的可选 testid。 */
  testId?: string;
  className?: string;
  /**
   * "width"（默认）：适配可用宽度、绝不放大、左上对齐，供网格/图/表格单元格使用。
   * "contain"：同时适配容器两个轴、允许有限放大并居中，供节点详情面板的大型专属区域使用。
   */
  fit?: "width" | "contain";
}

export function ScaleToFitTerminal({ children, testId, className, fit = "width" }: ScaleToFitTerminalProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [boxHeight, setBoxHeight] = useState<number | undefined>(undefined);
  const contain = fit === "contain";

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      const availableWidth = outer.clientWidth;
      // 无论已应用何种缩放变换，scrollWidth/Height 都报告固定 90x27 内容块变换前的自然尺寸。
      const naturalWidth = inner.scrollWidth;
      const naturalHeight = inner.scrollHeight;
      if (naturalWidth <= 0 || naturalHeight <= 0 || availableWidth <= 0) return;
      if (contain) {
        // 同时适配容器两个轴，允许有限放大并保持宽高比。
        const availableHeight = outer.clientHeight;
        if (availableHeight <= 0) return;
        const next = Math.min(
          MAX_CONTAIN_SCALE,
          availableWidth / naturalWidth,
          availableHeight / naturalHeight,
        );
        setScale(next);
        // 外层已填满面板（h-full），内层通过 flex 居中。
        setBoxHeight(undefined);
      } else {
        // 适配宽度但绝不放大；预留缩放后的高度，使布局正常流动。
        const next = Math.min(1, availableWidth / naturalWidth);
        setScale(next);
        setBoxHeight(naturalHeight * next);
      }
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [contain]);

  if (contain) {
    return (
      <div
        ref={outerRef}
        data-testid={testId}
        className={
          className
            ? `flex h-full w-full items-center justify-center overflow-hidden ${className}`
            : "flex h-full w-full items-center justify-center overflow-hidden"
        }
      >
        <div
          ref={innerRef}
          style={{ width: "max-content", transform: `scale(${scale})`, transformOrigin: "center center" }}
        >
          {children}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={outerRef}
      data-testid={testId}
      className={className ? `w-full overflow-hidden ${className}` : "w-full overflow-hidden"}
      style={{ height: boxHeight }}
    >
      <div
        ref={innerRef}
        style={{ width: "max-content", transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        {children}
      </div>
    </div>
  );
}
