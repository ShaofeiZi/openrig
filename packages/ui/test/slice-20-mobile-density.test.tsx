// Slice 20 移动端回归测试。
//
// 修复三个表面：
//   (a) FilesWorkspace 双窗格在窄视口（小于 sm 断点）中纵向堆叠，使文档面板在手机上
//       占满宽度。
//   (b) AppShell 移动端滑入 Rail 纵向渲染，已由 app-shell.test.tsx 的 slice-20 用例覆盖。
//   (c) Slice 的“产物”文档浏览器使用同一响应式双窗格结构；这是
//       /project/slice/:id 下实际渲染的路径。
//
// (a) 在此通过源码级扫描断言；组件通过钩子获取数据，完整 DOM 渲染需要深度 mock。
// 响应式结构是静态 class 字符串，没有需要区分的运行时分支，因此源码扫描已经足够。
// 锚定正则捕获该模式；fileURLToPath 按既定约定实现 cwd 无关解析，使测试可从仓库根目录和
// packages/ui 工作目录运行。

import { describe, it, expect } from "vitest";

async function readSource(packageRelPath: string): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  const nodePath = await import("node:path");
  const { readFileSync } = await import("node:fs");
  const testFile = fileURLToPath(import.meta.url);
  const packageRoot = nodePath.resolve(nodePath.dirname(testFile), "..");
  return readFileSync(nodePath.join(packageRoot, packageRelPath), "utf-8");
}

describe("slice 20: FilesWorkspace responsive two-pane shape", () => {
  it("/files route mounts FilesWorkspace instead of falling through to Not Found", async () => {
    const source = await readSource("src/routes.tsx");
    expect(source).toMatch(/import \{ FilesWorkspace \} from "\.\/components\/files\/FilesWorkspace\.js";/);
    expect(source).toMatch(/path: "\/files",\n\s+component: FilesWorkspace/);
  });

  it("outer container uses flex-col on mobile + sm:flex-row on desktop", async () => {
    const source = await readSource("src/components/files/FilesWorkspace.tsx");
    // 承载双窗格结构的外层 flex 父元素现在默认纵向堆叠，并在 sm: 宽度改为横向。
    expect(source).toMatch(/flex flex-1 min-h-0 flex-col sm:flex-row/);
  });

  it("file tree pane is full-width on mobile + capped + scrollable; restores w-72 at sm:", async () => {
    const source = await readSource("src/components/files/FilesWorkspace.tsx");
    // 树窗格移动端：w-full + max-h-48 + 可滚动；桌面端恢复 w-72 固定宽度列并移除底边框。
    expect(source).toMatch(/w-full max-h-48 shrink-0 overflow-y-auto/);
    expect(source).toMatch(/sm:w-72/);
    expect(source).toMatch(/sm:max-h-none/);
    // 桌面端在树与内容之间保留右边框，移动端改用底边框；两种形态都记录在 className 中。
    expect(source).toMatch(/border-b border-outline-variant/);
    expect(source).toMatch(/sm:border-b-0 sm:border-r/);
  });
});

describe("slice 20: DocsTab responsive two-pane shape", () => {
  it("slice Artifacts Docs Browser stacks vertically on mobile + restores row at sm:", async () => {
    const source = await readSource("src/components/slices/tabs/DocsTab.tsx");
    expect(source).toMatch(/className="flex h-full flex-col sm:flex-row"/);
  });

  it("docs tree pane is full-width on mobile + capped + scrollable; restores w-56 at sm:", async () => {
    const source = await readSource("src/components/slices/tabs/DocsTab.tsx");
    expect(source).toMatch(/w-full max-h-48 shrink-0 overflow-y-auto/);
    expect(source).toMatch(/sm:w-56/);
    expect(source).toMatch(/sm:max-h-none/);
    expect(source).toMatch(/border-b border-outline-variant/);
    expect(source).toMatch(/sm:border-b-0 sm:border-r/);
  });
});

describe("slice 20: AppShell mobile slide-over hamburger orientation", () => {
  it("Rail invocation inside mobile slide-over uses `vertical` (not vertical={false})", async () => {
    const source = await readSource("src/components/AppShell.tsx");
    // 滑入式 rail 的调用要求向 Rail 传入 vertical=true。旧形态是 `vertical={false}`；
    // 新形态是 `vertical`（或 `vertical={true}`）。既匹配新形态，也确认旧形态不存在。
    expect(source).toMatch(/<Rail pathname=\{pathname\} vertical onMobileClose/);
    expect(source).not.toMatch(/<Rail pathname=\{pathname\} vertical=\{false\} onMobileClose/);
  });

  it("Rail icon tap targets are h-11 w-11 on mobile + lg:h-10 lg:w-10 on desktop", async () => {
    const source = await readSource("src/components/AppShell.tsx");
    // 移动端默认 44px，桌面端通过 lg: 覆盖回 40px。两个 token 必须出现在同一 className 行；
    // 旧版全局放大形态（`h-11 w-11 items-center justify-center` 且无 lg: 覆盖）已移除。
    expect(source).toMatch(/h-11 w-11 items-center justify-center transition-colors lg:h-10 lg:w-10/);
    expect(source).not.toMatch(/h-10 w-10 items-center justify-center transition-colors[^l]/);
  });
});
