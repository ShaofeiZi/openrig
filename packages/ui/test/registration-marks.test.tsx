// V1 Shell 重设计——Phase 1——RegistrationMarks 原语。
//
// API 表面测试 + 伪元素绘制契约的 CSS 源码断言回归测试（纪律仪式 #7）。
//
// CSS 源码断言测试强制 DRIFT-2 修复：每个角
//（.reg-tl、.reg-tr、.reg-bl、.reg-br）必须有自己的 ::before 与
// ::after 规则，携带 content + position + background-color，使每个
// 角对称渲染而无需 .reg-mark 父级。

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RegistrationMarks } from "../src/components/ui/registration-marks";

const GLOBALS_CSS = readFileSync(
  path.resolve(__dirname, "../src/globals.css"),
  "utf8",
);

describe("RegistrationMarks (Phase 1 primitive)", () => {
  it("renders 4 corner spans (tl/tr/bl/br)", () => {
    const { container } = render(<RegistrationMarks />);
    expect(container.querySelector(".reg-tl")).toBeTruthy();
    expect(container.querySelector(".reg-tr")).toBeTruthy();
    expect(container.querySelector(".reg-bl")).toBeTruthy();
    expect(container.querySelector(".reg-br")).toBeTruthy();
  });

  it("attaches testIds when testIdPrefix is provided", () => {
    const { getByTestId } = render(<RegistrationMarks testIdPrefix="card-x" />);
    expect(getByTestId("card-x-reg-tl")).toBeTruthy();
    expect(getByTestId("card-x-reg-tr")).toBeTruthy();
    expect(getByTestId("card-x-reg-bl")).toBeTruthy();
    expect(getByTestId("card-x-reg-br")).toBeTruthy();
  });

  it("omits testIds when testIdPrefix not provided", () => {
    const { container } = render(<RegistrationMarks />);
    const tl = container.querySelector(".reg-tl") as HTMLElement | null;
    expect(tl?.dataset.testid).toBeUndefined();
  });

  it("merges className onto every corner span", () => {
    const { container } = render(<RegistrationMarks className="opacity-50" />);
    const corners = container.querySelectorAll(
      ".reg-tl, .reg-tr, .reg-bl, .reg-br",
    );
    expect(corners.length).toBe(4);
    corners.forEach((c) => {
      expect((c as HTMLElement).className).toContain("opacity-50");
    });
  });

  it("each corner span carries aria-hidden true", () => {
    const { container } = render(<RegistrationMarks />);
    const corners = container.querySelectorAll(
      ".reg-tl, .reg-tr, .reg-bl, .reg-br",
    );
    corners.forEach((c) => {
      expect(c.getAttribute("aria-hidden")).toBe("true");
    });
  });
});

// CSS 源码断言：伪元素绘制测试契约。
//
// jsdom 不绘制伪元素，故我们直接验证 CSS 源码。每个角类必须携带
// 自包含的 ::before 与 ::after 规则，含 content、position、background-color——
// V1 attempt-3 派发的 DRIFT-2 修复。
describe("globals.css registration-mark CSS source (DRIFT-2 regression)", () => {
  const corners = ["reg-tl", "reg-tr", "reg-bl", "reg-br"] as const;

  for (const c of corners) {
    it(`.${c}::before is self-contained (content + position + bg-color)`, () => {
      // 匹配独立选择器——非 .reg-mark > .${c} 父限定那个。
      // OPR.0.4.3.29：硬编码 #546073 转为（light 下像素相同的）
      // --secondary token，使标记在 dark 下随主题；自包含意图不变。
      const re = new RegExp(
        `(^|[^>\\s])\\s*\\.${c}::before\\s*\\{[^}]*content:\\s*'';[^}]*position:\\s*absolute;[^}]*background-color:\\s*hsl\\(var\\(--secondary\\)\\);`,
        "m",
      );
      expect(GLOBALS_CSS).toMatch(re);
    });
    it(`.${c}::after is self-contained (content + position + bg-color)`, () => {
      const re = new RegExp(
        `(^|[^>\\s])\\s*\\.${c}::after\\s*\\{[^}]*content:\\s*'';[^}]*position:\\s*absolute;[^}]*background-color:\\s*hsl\\(var\\(--secondary\\)\\);`,
        "m",
      );
      expect(GLOBALS_CSS).toMatch(re);
    });
  }

  it("paper-grid radial-gradient uses 1px dot radius (DRIFT-3)", () => {
    expect(GLOBALS_CSS).toMatch(
      /radial-gradient\(#d1d1cf\s+1px,\s*transparent\s+1px\)/,
    );
  });
});
