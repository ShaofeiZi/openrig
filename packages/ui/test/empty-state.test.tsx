// V1 Shell 重设计——Phase 1——EmptyState 原语。

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "../src/components/ui/empty-state";

describe("EmptyState (Phase 1 primitive)", () => {
  it("renders label", () => {
    render(<EmptyState label="NO ITEMS" />);
    expect(screen.getByText("NO ITEMS")).toBeTruthy();
  });

  it("renders description when provided", () => {
    render(<EmptyState label="X" description="More detail here" />);
    expect(screen.getByText("More detail here")).toBeTruthy();
  });

  it("string icon rendered as text", () => {
    render(<EmptyState label="X" icon="📭" testId="es" />);
    expect(screen.getByTestId("es").textContent).toContain("📭");
  });

  it("ReactNode icon rendered as element", () => {
    render(
      <EmptyState
        label="X"
        icon={<span data-testid="ic">[icon]</span>}
      />,
    );
    expect(screen.getByTestId("ic")).toBeTruthy();
  });

  it("action with onClick renders button and fires", () => {
    const onClick = vi.fn();
    render(
      <EmptyState label="X" action={{ label: "DO IT", onClick }} testId="es-b" />,
    );
    const btn = screen.getByTestId("es-b-action");
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("action with href renders <a>", () => {
    render(
      <EmptyState label="X" action={{ label: "GO", href: "/foo" }} testId="es-l" />,
    );
    const link = screen.getByTestId("es-l-action") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/foo");
  });

  it("variant=card wraps in a VellumCard ghost+flat composition", () => {
    const { container } = render(
      <EmptyState label="X" variant="card" testId="es-c" />,
    );
    const body = container.querySelector("[data-testid='es-c']") as HTMLElement;
    // VellumCard 包装把 body 渲染在内层 flex 容器内，
    // 故 VellumCard root = body.parentElement.parentElement。
    const wrapper = body.parentElement?.parentElement as HTMLElement;
    expect(wrapper.className).toContain("bg-transparent");
    expect(wrapper.className).toContain("border-outline-variant");
    // 平 elevation = 无硬阴影。
    expect(wrapper.className).not.toContain("hard-shadow");
  });

  it("variant=minimal does NOT wrap in VellumCard", () => {
    const { container } = render(<EmptyState label="X" testId="es-m" />);
    const root = container.querySelector("[data-testid='es-m']") as HTMLElement;
    // testid 外无 vellum-card 包装。
    const parent = root.parentElement as HTMLElement;
    expect(parent.className ?? "").not.toContain("bg-transparent");
    expect(parent.className ?? "").not.toContain("border-stone-900");
  });
});
