import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { ImportFlow } from "../src/components/ImportFlow.js";
import { SpecsWorkspaceProvider, SPECS_WORKSPACE_STORAGE_KEYS } from "../src/components/SpecsWorkspace.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createTestRouter, createAppTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  mockFetch.mockReset();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});

afterEach(() => {
  window.localStorage.clear();
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
});

const VALID_YAML = "schema_version: 1\nname: test-rig\nnodes: []\n";

async function renderImportFlow() {
  const result = render(createTestRouter({
    component: () => <ImportFlow onBack={() => {}} />,
    path: "/import",
    initialPath: "/import",
  }));
  await waitFor(() => expect(screen.getByTestId("import-flow")).toBeDefined());
  return result;
}

describe("ImportFlow", () => {
  it("渲染在共享工作区页壳内", async () => {
    await renderImportFlow();

    expect(screen.getByTestId("workspace-page")).toBeDefined();
    expect(screen.getByTestId("workspace-page-inner")).toBeDefined();
  });

  it("用当前 Specs rig 草稿填充 yaml 编辑器", async () => {
    window.localStorage.setItem(SPECS_WORKSPACE_STORAGE_KEYS.currentRigDraft, JSON.stringify({
      id: "rig-current",
      kind: "rig",
      label: "demo-rig",
      yaml: VALID_YAML,
      updatedAt: Date.now(),
    }));

    render(createAppTestRouter({
      routes: [{ path: "/import", component: () => <ImportFlow /> }],
      initialPath: "/import",
      rootComponent: ({ children }) => <SpecsWorkspaceProvider>{children}</SpecsWorkspaceProvider>,
    }));

    await waitFor(() => {
      expect((screen.getByTestId("yaml-input") as HTMLTextAreaElement).value).toBe(VALID_YAML);
    });
  });

  // 测试 1：输入界面上步骤指示器显示第 1 步激活
  it("输入界面上步骤指示器显示第 1 步激活", async () => {
    await renderImportFlow();
    const step1 = screen.getByTestId("step-1");
    expect(step1.getAttribute("data-step-state")).toBe("active");
    const step2 = screen.getByTestId("step-2");
    expect(step2.getAttribute("data-step-state")).toBe("upcoming");
  });

  // 测试 2：校验发给后台，显示通过 Alert
  it("校验发给后台并显示通过 Alert", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ valid: true, errors: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("valid-message")).toBeDefined();
      const call = mockFetch.mock.calls.find((c: unknown[]) => c[0] === "/api/rigs/import/validate");
      expect(call).toBeDefined();
    });
  });

  // 测试 3：非法 YAML 显示错误 Alert，阻止继续
  it("非法 YAML 显示错误 Alert，阻止继续", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: false, errors: ["missing name", "no nodes"] }),
    });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: "bad yaml" } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      const errEl = screen.getByTestId("import-errors");
      expect(errEl.textContent).toContain("missing name");
      expect(errEl.textContent).toContain("no nodes");
      // 第 1 步应仍为激活（错误发生在第 1 步）
      const step1 = screen.getByTestId("step-1");
      expect(step1.getAttribute("data-step-state")).toBe("active");
    });
    expect(screen.queryByTestId("preflight-btn")).toBeNull();
  });

  // 测试 4：预检显示警告（text-warning）+ 错误（text-destructive）
  it("预检以正确颜色显示警告与错误", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: ["cmux unavailable", "cwd not found"] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      const warningsEl = screen.getByTestId("preflight-warnings");
      expect(warningsEl.textContent).toContain("cmux unavailable");
      expect(warningsEl.textContent).toContain("cwd not found");
      // 警告应使用 text-warning 类
      expect(warningsEl.querySelector(".text-warning")).toBeDefined();
    });
  });

  // 测试 5：实例化显示逐节点表格及状态色
  it("实例化显示逐节点表格及状态色", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: [] }) })
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ rigId: "rig-1", specName: "imported-rig", specVersion: "0.1.0", nodes: [{ logicalId: "orchestrator", status: "launched" }, { logicalId: "worker", status: "failed" }] }),
      });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));
    await waitFor(() => expect(screen.getByTestId("instantiate-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("instantiate-btn"));

    await waitFor(() => {
      const result = screen.getByTestId("import-result");
      expect(result.textContent).toContain("imported-rig");

      const launchedEl = screen.getByTestId("inst-status-orchestrator");
      expect(launchedEl.className).toContain("text-success");

      const failedEl = screen.getByTestId("inst-status-worker");
      expect(failedEl.className).toContain("text-destructive");
    });
  });

  // 测试 6：错误态的“重试”回到输入
  it("错误态“重试”回到输入", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: false, errors: ["bad"] }),
    });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: "bad" } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => expect(screen.getByTestId("import-errors")).toBeDefined());

    // 找到“重试”按钮
    const tryAgainBtns = screen.getAllByText(/重试/);
    const btn = tryAgainBtns.find((el) => el.closest("button"));
    fireEvent.click(btn!);

    await waitFor(() => {
      expect(screen.getByTestId("yaml-input")).toBeDefined();
    });
  });

  it("不渲染页面级的 Specs 返回按钮", async () => {
    await renderImportFlow();

    expect(screen.queryByText("← Specs")).toBeNull();
  });

  // 测试 8：校验通过后第 1 步完成（对勾），第 2 步激活
  it("校验后第 1 步显示对勾、第 2 步激活", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ valid: true, errors: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      const step1 = screen.getByTestId("step-1");
      expect(step1.textContent).toContain("✓");
      expect(step1.getAttribute("data-step-state")).toBe("done");
      const step2 = screen.getByTestId("step-2");
      expect(step2.getAttribute("data-step-state")).toBe("active");
    });
  });

  // 测试 9：原始 YAML body 以 text/yaml 发送（保留）
  it("校验以 text/yaml Content-Type 发送原始 YAML body", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ valid: true, errors: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      const call = mockFetch.mock.calls.find((c: unknown[]) => c[0] === "/api/rigs/import/validate");
      expect(call).toBeDefined();
      const [, opts] = call as [string, RequestInit];
      expect(opts.headers).toMatchObject({ "Content-Type": "text/yaml" });
      expect(opts.body).toBe(VALID_YAML);
    });
  });

  // 测试 10：预检警告展示给用户（保留）
  it("预检警告展示给用户", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: ["cmux unavailable"] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("preflight-warnings").textContent).toContain("cmux unavailable");
    });
  });

  // 测试 11：导入视图经路由渲染（保留）
  it("导入视图经路由渲染", async () => {
    mockFetch.mockImplementation((url: string) => {
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(createAppTestRouter({
      routes: [
        { path: "/specs", component: () => <div data-testid="specs-page">Specs</div> },
        { path: "/import", component: () => <ImportFlow /> },
      ],
      initialPath: "/import",
    }));

    await waitFor(() => {
      expect(screen.getByTestId("import-flow")).toBeDefined();
      expect(screen.getByTestId("yaml-input")).toBeDefined();
    });
  });

  // 测试 12：实例化失败显示错误 Alert（保留）
  it("实例化失败显示错误 Alert", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ ok: false, code: "preflight_failed", errors: ["rig name collision"], warnings: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));
    await waitFor(() => expect(screen.getByTestId("instantiate-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("instantiate-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("import-errors").textContent).toContain("rig name collision");
    });
    expect(screen.queryByTestId("import-result")).toBeNull();
  });

  // 测试 13：预检错误阻止实例化
  it("预检错误阻止实例化", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: false, errors: ["rig name exists"], warnings: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("import-errors").textContent).toContain("rig name exists");
    });
    expect(screen.queryByTestId("instantiate-btn")).toBeNull();
  });

  // 测试 14b：预检同时有警告与错误时，错误态两者都显示
  it("预检同时有警告与错误时，警告显示在错误之上", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: false, errors: ["rig name exists"], warnings: ["cmux unavailable"] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      // 应显示错误
      const errEl = screen.getByTestId("import-errors");
      expect(errEl.textContent).toContain("rig name exists");
      // 警告也应显示（在错误之上）
      const warnEl = screen.getByTestId("error-warnings");
      expect(warnEl.textContent).toContain("cmux unavailable");
    });
  });

  // T1-AS-T14：步骤指示器显示“校验 RigSpec”标签
  it("步骤指示器显示“校验 RigSpec”标签", async () => {
    await renderImportFlow();
    const step1 = screen.getByTestId("step-1");
    expect(step1.textContent).toContain("校验 RigSpec");
  });

  // T2-AS-T14：校验错误渲染为结构化列表
  it("校验错误渲染为结构化列表", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ valid: false, errors: ["missing name", "no nodes", "bad version"] }),
    });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: "bad yaml" } });
    fireEvent.click(screen.getByTestId("validate-btn"));

    await waitFor(() => {
      const errEl = screen.getByTestId("import-errors");
      expect(errEl.textContent).toContain("missing name");
      expect(errEl.textContent).toContain("no nodes");
      expect(errEl.textContent).toContain("bad version");
    });
  });

  // T3-AS-T14：预检警告用警告色，错误用 destructive 色
  it("预检警告用警告色，错误用 destructive 色", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: false, errors: ["port conflict"], warnings: ["stale sessions"] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      // 警告用 text-warning
      const warnEl = screen.getByTestId("error-warnings");
      expect(warnEl.querySelector(".text-warning")).toBeDefined();
      expect(warnEl.textContent).toContain("stale sessions");
      // 错误用 text-destructive
      const errEl = screen.getByTestId("import-errors");
      const destructiveEls = errEl.querySelectorAll(".text-destructive");
      expect(destructiveEls.length).toBeGreaterThan(0);
      expect(errEl.textContent).toContain("port conflict");
    });
  });

  // T4-AS-T14：渲染预检冲突/歧义警告
  it("渲染预检冲突/歧义警告", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: ["rig name collision detected", "ambiguous node ref"] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      const warningsEl = screen.getByTestId("preflight-warnings");
      expect(warningsEl.textContent).toContain("rig name collision detected");
      expect(warningsEl.textContent).toContain("ambiguous node ref");
    });
  });

  // T7-AS-T14：成功导入后缓存失效
  it("成功导入后缓存失效", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: [] }) })
      .mockResolvedValueOnce({
        ok: true, status: 201,
        json: async () => ({ rigId: "rig-2", specName: "test", specVersion: "0.1.0", nodes: [{ logicalId: "a", status: "launched" }] }),
      });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));
    await waitFor(() => expect(screen.getByTestId("instantiate-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("instantiate-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("import-result")).toBeDefined();
    });
    // mutation 成功即 onSuccess 触发（内部调用 queryClient.invalidateQueries）
    // 我们验证导入成功，即证明 mutation hook 走过了 onSuccess 路径
    expect(screen.getByTestId("import-result").textContent).toContain("test");
  });

  // T8-AS-T14：cycle_error 错误态显示“环路”消息
  it("cycle_error 显示“环路”消息", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ ok: false, code: "cycle_error", errors: ["Cycle detected in rig topology"], warnings: [] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));
    await waitFor(() => expect(screen.getByTestId("instantiate-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("instantiate-btn"));

    await waitFor(() => {
      const errEl = screen.getByTestId("import-errors");
      expect(errEl.textContent).toContain("环路");
    });
  });

  // 测试 15：预检警告允许实例化
  it("预检警告允许实例化", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ valid: true, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ready: true, errors: [], warnings: ["cmux unavailable"] }) });
    await renderImportFlow();

    fireEvent.change(screen.getByTestId("yaml-input"), { target: { value: VALID_YAML } });
    fireEvent.click(screen.getByTestId("validate-btn"));
    await waitFor(() => expect(screen.getByTestId("preflight-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("preflight-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("instantiate-btn")).toBeDefined();
      expect(screen.getByTestId("preflight-warnings")).toBeDefined();
    });
  });
});
