// 羊皮纸实验室 —— /lab/vellum-lab 的设计实验界面。
//
// 重构后（2026-05-14）：只是对 ../dashboard/vellum 下共享羊皮纸基元的薄组合。
// 实验室与生产环境的 /dashboard 界面渲染同一批组件——视觉系统的唯一真源。
//
// 可选的覆盖 props（backLayerOverride / vellumSheetOverride）保留下来，让
// /lab/vellum-bg/* 背景实验路由无需 fork 整个实验室页面即可继续工作。

import type { ReactNode } from "react";
import {
  MidLayerContent,
  TopLayerContent,
  DestinationsLayer,
} from "../dashboard/vellum/index.js";

interface VellumLabProps {
  /** 可选的背景内容覆盖——仅在提供时渲染。
   *  默认实验室页是简化版（无背景层）。/lab/vellum-bg/* 实验路由传入覆盖，
   *  以测试备选的背景层组合（拓扑线 / 线条画 / 等）。 */
  backLayerOverride?: ReactNode;
  /** 可选的背景羊皮纸层覆盖——仅在提供时渲染。
   *  默认实验室页没有背景层；实验路由用它测试与各自背景层覆盖配对的扩散程度。 */
  vellumSheetOverride?: ReactNode;
}

export function VellumLab({
  backLayerOverride,
  vellumSheetOverride,
}: VellumLabProps = {}) {
  return (
    <div
      data-testid="vellum-lab"
      className="relative min-h-screen overflow-hidden"
    >
      {/* 可选背景层——仅在显式提供时渲染 */}
      {backLayerOverride}
      {vellumSheetOverride}

      {/* 中层内容（旁注 + 散落标记） */}
      <MidLayerContent />

      {/* 顶部框架（眉标、主视觉、页脚、EYES EVERYWHERE、标记） */}
      <TopLayerContent />

      {/* 目的地（可点击的启动卡片） */}
      <DestinationsLayer />
    </div>
  );
}
