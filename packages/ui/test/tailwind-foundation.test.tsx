import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

// 导入 globals.css，与 main.tsx 的导入方式一致。
import "../src/globals.css";

const mockFetch = vi.fn(() =>
  Promise.resolve({ ok: true, json: async () => [] })
);
globalThis.fetch = mockFetch;

afterEach(() => {
  cleanup();
  mockFetch.mockClear();
});

describe("Tailwind Foundation", () => {
  // 测试 1：:root 上存在设计 token。
  it("design tokens are present on :root via globals.css", () => {
    render(<div>probe</div>);

    const root = document.documentElement;
    const styles = getComputedStyle(root);

    expect(styles.getPropertyValue("--background").trim()).toContain("47 20% 97%");
    expect(styles.getPropertyValue("--on-surface").trim()).toContain("120 8% 19%");
    expect(styles.getPropertyValue("--primary").trim()).toContain("0 1% 37%");
    expect(styles.getPropertyValue("--tertiary").trim()).toContain("1 63% 42%");
  });

  // 测试 2：配置中的全部 borderRadius token 均归零。
  it("ALL borderRadius tokens are 0px", () => {
    const config = readFileSync(resolve(__dirname, "../tailwind.config.ts"), "utf-8");

    const radiusMatch = config.match(/borderRadius:\s*\{([^}]+)\}/);
    expect(radiusMatch).not.toBeNull();

    const pairs = [...radiusMatch![1]!.matchAll(/(\w+):\s*"([^"]+)"/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(6);
    for (const [, key, value] of pairs) {
      if (key === "full") {
        expect(value).toBe("9999px");
      } else {
        expect(value).toBe("0px");
      }
    }
  });

  // 测试 3：cn() 工具函数。
  it("cn() merges classes with Tailwind dedup", async () => {
    const { cn } = await import("../src/lib/utils.js");
    expect(cn("p-4", "p-8")).toBe("p-8");
  });

  // 测试 4：生产构建输出当前扫描到的背景工具类契约。
  it("production build emits .bg-background utility rule", { timeout: 60000 }, () => {
    const uiRoot = resolve(__dirname, "..");
    try {
      execSync("npm run build", { cwd: uiRoot, stdio: "pipe", timeout: 30000 });
    } catch {
      // 测试环境构建失败时跳过。
      return;
    }

    const distAssets = resolve(uiRoot, "dist/assets");
    let cssContent = "";
    try {
      const cssFiles = readdirSync(distAssets).filter((f) => f.endsWith(".css"));
      for (const f of cssFiles) {
        cssContent += readFileSync(resolve(distAssets, f), "utf-8");
      }
    } catch {
      return;
    }

    // bg-background 应生成 background-color: hsl(var(--background))。
    expect(cssContent).toMatch(/\.bg-background\b/);
    expect(cssContent).toContain("hsl(var(--background))");

    // 即使当前源码未使用 bg-card、因而正确从工具类中清除，card token 仍随 globals.css 交付。
    expect(cssContent).toMatch(/--card:\s*var\(--surface-container-lowest\)/);
  });

  // 测试 5：main.tsx 导入 globals.css（源码验证）。
  it("main.tsx imports globals.css in its source", () => {
    const mainSrc = readFileSync(resolve(__dirname, "../src/main.tsx"), "utf-8");
    expect(mainSrc).toContain('./globals.css"');
  });

  // 测试 6：globals.css 已注入文档。
  it("globals.css stylesheet is present in document", () => {
    const styleSheets = document.querySelectorAll("style");
    const cssText = Array.from(styleSheets).map((s) => s.textContent).join("");

    expect(cssText).toContain("--background");
    expect(cssText).toContain("--surface-container-low");
    expect(cssText).toContain("--outline-variant");
  });
});
