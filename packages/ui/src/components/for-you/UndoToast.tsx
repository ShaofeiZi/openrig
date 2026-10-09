// Slice 18 —— For-You 卡片级"关闭"流程的撤销 toast。
//
// 单动作瞬时界面：在固定窗口内展示一个标签 + 撤销按钮。点击撤销会触发
// onUndo 并挂起待到期的回调。若窗口超时未点击，则触发一次 onExpire，
// 由 toast 调用方负责卸载。

import { useEffect, useRef } from "react";

export interface UndoToastProps {
  label: string;
  onUndo: () => void;
  onExpire: () => void;
  durationMs: number;
}

export function UndoToast({ label, onUndo, onExpire, durationMs }: UndoToastProps) {
  const consumedRef = useRef(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (consumedRef.current) return;
      consumedRef.current = true;
      onExpire();
    }, durationMs);
    return () => window.clearTimeout(handle);
  }, [durationMs, onExpire]);

  const handleUndo = () => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    onUndo();
  };

  return (
    <div
      data-testid="undo-toast"
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 border border-stone-700 bg-stone-900/95 px-4 py-2 font-mono text-[11px] uppercase tracking-wide text-stone-50 backdrop-blur-sm shadow-lg"
    >
      <span>{label}</span>
      <button
        type="button"
        data-testid="undo-toast-button"
        onClick={handleUndo}
        className="border border-stone-500 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-stone-50 hover:bg-stone-800 focus:outline-none focus:ring-1 focus:ring-stone-300"
      >
        撤销
      </button>
    </div>
  );
}
