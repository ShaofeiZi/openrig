// OPR.0.4.6.WF4——guard blocker 1 回归。instance 页 Resume 按钮是
// 范围内唯一 web 变更（route-from-web 延后）。它是 POST
// /api/workflow/:id/resume 的瘦客户端，该 POST 要求结构化 `actorSession`，
// 缺失则返回 400（routes/workflow.ts:266）。本回归在旧空 body POST 上失败。

import { describe, it, expect, vi, afterEach } from "vitest";
import { postResume } from "../src/components/workflow/WorkflowInstancePage.js";

afterEach(() => vi.unstubAllGlobals());

describe("WF-4 guard blocker 1: web Resume sends a structured actorSession", () => {
  it("POSTs a JSON body carrying actorSession (the shipped route 400s without it)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200 } as Response);
    });

    await postResume("01ABC");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/workflow/01ABC/resume");
    expect(calls[0].init.method).toBe("POST");
    // body 必须是带非空 actorSession 的 JSON——路由强制的精确契约
    //（空/缺失 → 400）。
    const body = JSON.parse(String(calls[0].init.body));
    expect(typeof body.actorSession).toBe("string");
    expect(body.actorSession.length).toBeGreaterThan(0);
  });
});
