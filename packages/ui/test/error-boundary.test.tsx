// OPR.0.4.1.13：可复用 ErrorBoundary 将子组件渲染异常限制在其子树内
//（使用默认或传入的回退内容），避免整页白屏；这是表格视图崩溃修复背后的“稳定渲染”保障。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ErrorBoundary } from "../src/components/ui/ErrorBoundary.js";

function Boom(): never {
  throw new Error("kaboom");
}

afterEach(() => cleanup());

describe("OPR.0.4.1.13 ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok-child">fine</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("ok-child")).toBeTruthy();
  });

  it("contains a child render-throw + shows the default fallback (no white-screen)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <ErrorBoundary label="Table view">
          <Boom />
        </ErrorBoundary>,
      ),
    ).not.toThrow();
    const fallback = screen.getByTestId("error-boundary-fallback");
    expect(fallback.textContent).toContain("Table view");
    expect(fallback.getAttribute("role")).toBe("alert");
    spy.mockRestore();
  });

  it("renders a provided fallback when given one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">custom</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("custom-fallback")).toBeTruthy();
    spy.mockRestore();
  });
});
