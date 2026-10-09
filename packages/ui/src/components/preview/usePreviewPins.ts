// 预览终端 v0（PL-018）——用 useSyncExternalStore 包装 previewPinStore 的 React hook。
// 读取固定项的组件应使用本 hook，以便在固定/取消固定事件时重新渲染。

import { useSyncExternalStore, useEffect } from "react";
import { previewPinStore, type PreviewPin } from "./preview-pin-store.js";
import { useSettings } from "../../hooks/useSettings.js";

export function usePreviewPins(): {
  pins: PreviewPin[];
  maxPins: number;
  pin: (pin: PreviewPin) => boolean;
  unpin: (rigId: string, logicalId: string) => void;
  isPinned: (rigId: string, logicalId: string) => boolean;
} {
  const { data: settings } = useSettings();
  const settingMaxPins = settings?.settings?.["ui.preview.max_pins"]?.value as number | undefined;

  // 设置中的 max-pins 变化时同步到 store。
  useEffect(() => {
    if (typeof settingMaxPins === "number") {
      previewPinStore.setMaxPins(settingMaxPins);
    }
  }, [settingMaxPins]);

  const pins = useSyncExternalStore(
    (cb) => previewPinStore.subscribe(cb),
    () => previewPinStore.list(),
    () => previewPinStore.list(),
  );

  return {
    pins,
    maxPins: previewPinStore.getMaxPins(),
    pin: (p) => previewPinStore.pin(p),
    unpin: (rigId, logicalId) => previewPinStore.unpin(rigId, logicalId),
    isPinned: (rigId, logicalId) => previewPinStore.isPinned(rigId, logicalId),
  };
}
