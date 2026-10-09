import { useState, useEffect, useRef } from "react";

/**
 * 数值的滚动计数动画。
 * - 首次挂载：从 0 动画到目标值
 * - 后续更新：直接跳到新目标（不重新动画）
 * - 尊重 prefers-reduced-motion：完全跳过动画
 */
export function useCountUp(target: number, duration = 400): number {
  const [value, setValue] = useState(0);
  const hasAnimatedRef = useRef(false);

  useEffect(() => {
    // 首次动画结束后，后续更新直接跳到目标值
    if (hasAnimatedRef.current) {
      setValue(target);
      return;
    }

    // 检查“减少动态效果”的系统偏好
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      hasAnimatedRef.current = true;
      setValue(target);
      return;
    }

    hasAnimatedRef.current = true;

    if (target === 0) {
      setValue(0);
      return;
    }

    const start = performance.now();
    let rafId: number;

    const step = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      setValue(Math.floor(progress * target));
      if (progress < 1) {
        rafId = requestAnimationFrame(step);
      }
    };

    rafId = requestAnimationFrame(step);

    return () => cancelAnimationFrame(rafId);
  }, [target, duration]);

  return value;
}
