// UI HARNESS 拆卸卫生——React harness 中 R5 家族"工作不得活过其
// 上下文"模式。
//
// 缺陷（桌面捕获，main c230909cf）：完整 ui 运行报
// "Errors 1"而测试计数全绿——ReferenceError: window is not
// defined，位于 react-dom performWorkOnRootViaSchedulerTask，抛出于
// 测试环境拆卸之后。Vitest 自身警告：未处理的
// 拆卸后错误可致假阳性测试，并翻转门控 A/B 锚点的退出码。
//
// 结构性成因（源码核实）：vitest.config.ts 未设
// `globals`，故默认 FALSE——React Testing Library 仅在框架 afterEach
// 作为全局可用时才注册其自动 `afterEach(cleanup)`。globals:false 下该自动清理永不运行，故
// 每个不自调 cleanup 的测试文件（写时 153 中 117）让其 React 树在测试后仍挂载。
// 挂载的树仍可有已调度工作（React 经自身任务队列调度）；若
// 该任务在环境销毁后落地，它解引用一个
// 已不存在的 `window`。组件无辜——例如
// TerminalPreviewPopover 已在 effect 清理中取消 rAF——但
// 该清理仅在卸载时运行，而卸载从不发生。
//
// 修复：在 test/setup.ts 全局注册 cleanup，使每个测试卸载
// 其树（取消待处理工作）而非压制错误。
//
// 本文件确定性锚定前置条件：有修复时，渲染的测试
// 不给下一测试留任何残留。无修复时泄漏可见——
// 正是让工作活过环境的同一泄漏。
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

describe("ui harness: every test unmounts its tree (global auto-cleanup registered)", () => {
  it("renders a probe tree and does NOT unmount it explicitly", () => {
    render(<div data-testid="teardown-hygiene-probe">probe</div>);
    expect(document.querySelectorAll("[data-testid='teardown-hygiene-probe']").length).toBe(1);
  });

  it("the NEXT test starts with a clean DOM — the previous tree was unmounted by the harness", () => {
    // 无全局 afterEach(cleanup) 时 RED：前一测试的 probe 仍挂载于此，
    // 且（关键）完整运行中每个其他 suite 的树也在此——
    // 正是已调度工作活过环境的那批。
    expect(document.querySelectorAll("[data-testid='teardown-hygiene-probe']").length).toBe(0);
    expect(document.body.innerHTML).toBe("");
  });
});
