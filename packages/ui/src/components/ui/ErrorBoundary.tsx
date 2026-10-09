// OPR.0.4.1.13：一个小型可复用的 React 错误边界。
//
// 拓扑表格视图（以及其他渲染密集的界面）在遇到畸形数据形态时可能在渲染期抛错。
// 若没有边界，单次渲染抛错会向上传播到根，把整页白屏。本边界把渲染抛错收敛到其子树内，
// 并显示一个安静的内联兜底，使页面其余部分仍可用——“稳定渲染”（OPR.0.4.1.13）。
// 根因数据守卫才是主修复；这里是纵深防御，让任何残留/未来的边界都能优雅降级，而非致命崩溃。

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 子级渲染抛错时显示的内联兜底。 */
  fallback?: ReactNode;
  /** 默认兜底与控制台诊断用的可选标签。 */
  label?: string;
  /** 诊断/遥测用的可选钩子。 */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 让抛错对诊断可见，同时不使页面崩溃。
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ""}]`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div
          data-testid="error-boundary-fallback"
          role="alert"
          className="border border-outline-variant bg-surface-low px-3 py-6 text-center font-mono text-xs text-on-surface-variant"
        >
          {this.props.label ? `${this.props.label} 渲染失败。` : "此视图渲染失败。"}
          {" "}页面其余部分仍可正常使用。
        </div>
      );
    }
    return this.props.children;
  }
}
