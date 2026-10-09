// R1（release-0.4.7）——C4a：ProofTab empty-state 文案按 useScopeMarkdown 状态映射。
//
// `!populated` empty-state 现按 `proofMd.state` 分支：infra 读失败
// 与错根 scope 各得诚实文案；真正缺失保持
// 今日 "NO PROOF YET" 字节不变（字节对等腿）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SliceProofTab } from "../src/components/project/ProofTab.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const SLICE = "/ws/missions/m/slices/s";
const SID = "OPR.TEST.1";

function renderProof(slicePath: string | null = SLICE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SliceProofTab sliceId={SID} title="test slice" slicePath={slicePath} />
    </QueryClientProvider>,
  );
}

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

describe("R1 C4a — ProofTab empty-state honest copy", () => {
  it("read_error → PROOF.MD READ FAILED (infra, not empty proof)", async () => {
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: "/ws" }] });
      if (url.includes("/api/files/read")) return json({ error: "boom" }, 500);
      if (url.includes("/api/files/list")) return json({ root: "work", path: "", entries: [] });
      return json([]);
    });
    renderProof();
    const el = await screen.findByTestId(`proof-read-error-${SID}`);
    expect(el.textContent).toContain("PROOF.MD 读取失败");
    expect(el.textContent).toContain("这是读取失败，不是空校验");
    // 它不得显示真正缺失文案
    expect(screen.queryByTestId(`proof-empty-state-${SID}`)).toBeNull();
  });

  it("unresolved (scope outside allowlist roots) → PROOF.MD OUTSIDE FILE ROOTS", async () => {
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/files/roots")) return json({ roots: [{ name: "other", path: "/elsewhere" }] });
      return json([]);
    });
    renderProof();
    const el = await screen.findByTestId(`proof-unresolved-${SID}`);
    expect(el.textContent).toContain("PROOF.MD 不在文件根内");
    expect(el.textContent).toContain("OPENRIG_FILES_ALLOWLIST");
    expect(screen.queryByTestId(`proof-empty-state-${SID}`)).toBeNull();
  });

  it("absent (404) → NO PROOF YET, BYTE-IDENTICAL to 8250d702", async () => {
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: "/ws" }] });
      if (url.includes("/api/files/read")) return json({ error: "not found" }, 404);
      if (url.includes("/api/files/list")) return json({ root: "work", path: "", entries: [] });
      return json([]);
    });
    renderProof();
    const el = await screen.findByTestId(`proof-empty-state-${SID}`);
    // 锁定的 8250d702 字面量——label + 完整描述，不变
    expect(el.textContent).toContain("尚无校验");
    expect(el.textContent).toContain(
      "本切片有一个已脚手架化的 proof/ 位置，但尚无收尾流程填充。工作凭证捕获（截图/视频）与 PROOF.md 判定会在收尾智能体处理切片收尾时放入此处——无需策展人。",
    );
    // the "待校验" micro-label survives ONLY on the absent branch
    expect(screen.getByTestId(`proof-slice-empty-${SID}`).textContent).toContain("待校验");
  });
});
