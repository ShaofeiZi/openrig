// @vitest-environment jsdom

// OPR.0.4.4.20 rev1 fixback（d6135921）——两条 UI 侧腿：
//  (1) approveSlice 发已发布的 Packet-1 路由契约
//      （scopeTier/scopePath/actorSession/approvalScope——routes/scope-approve.ts），
//      而非早先真实路由拒绝的猜测字段名。
//  (2) EvidenceOpener 在构建任何 URL/scope 之前，以具名
//      可见错误拒绝绝对路径 + `..` 遍历引用（slice 边界遏制）。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";
import { approveSlice } from "../src/components/review/review-actions.js";
import { EvidenceOpener, evidenceRefContained } from "../src/components/review/EvidenceOpener.js";

// slice-04 REV6——一个捕获 double，使 opener 锁能读到组合出的
// data.readPath。opener 未改；这只是呈现其输出。
vi.mock("../src/components/drawer-triggers/FileReferenceTrigger.js", () => ({
  FileReferenceTrigger: ({ data, testId, children }: { data: { readPath?: string; kind?: string }; testId?: string; children?: React.ReactNode }) => (
    <span data-testid={testId} data-readpath={data?.readPath ?? ""} data-kind={data?.kind ?? ""}>{children}</span>
  ),
}));

vi.mock("../src/components/project/ArtifactsNavigator.js", () => ({
  ArtifactsNavigator: () => null,
}));

vi.mock("../src/components/project/Lightbox.js", () => ({
  Lightbox: () => null,
}));

vi.mock("../src/hooks/useFiles.js", () => ({
  fileAssetUrl: (root: string, path: string) => `/api/files/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("approveSlice — Packet-1 payload shape", () => {
  it("posts scopeTier/scopePath/actorSession/approvalScope to /api/scope/approve", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    });

    const outcome = await approveSlice("20-living-notes-composer-surfaces", "human@host");
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/scope/approve");
    // 精确的已发布契约成员——且无旧猜测名。
    expect(calls[0]!.body).toEqual({
      scopeTier: "slice",
      scopePath: "20-living-notes-composer-surfaces",
      actorSession: "human@host",
      approvalScope: "delivery",
    });

    await approveSlice("s", "a@h", "spec");
    expect(calls[1]!.body["approvalScope"]).toBe("spec");
  });
});

describe("EvidenceOpener — slice-boundary containment", () => {
  const ctx = { root: "ws", relPath: "missions/m/slices/s", slicePath: "/tmp/fixture-slice" };

  it("pins the containment predicate: absolute + `..` segments refused, dotted filenames allowed", () => {
    expect(evidenceRefContained("proof/shot.png")).toBe(true);
    expect(evidenceRefContained("proof/ok..png")).toBe(true); // filename dots, not traversal
    expect(evidenceRefContained("../other-slice/shot.png")).toBe(false);
    expect(evidenceRefContained("sub/../../shot.png")).toBe(false);
    expect(evidenceRefContained("..")).toBe(false);
    expect(evidenceRefContained("/abs/anywhere.png")).toBe(false);
  });

  it("renders the named outside-scope error for a traversal ref — no img, no link, no folder scope", () => {
    render(<EvidenceOpener evidenceRef="../other-slice/shot.png" ctx={ctx} testId="ev" />);
    expect(screen.getByTestId("ev-outside-scope").textContent).toContain("证据引用超出切片范围");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });

  it("refuses traversal folder refs before any ArtifactsNavigator scope is built", () => {
    render(<EvidenceOpener evidenceRef="../sibling-evidence/" ctx={ctx} testId="ev2" />);
    expect(screen.getByTestId("ev2-outside-scope")).toBeTruthy();
    expect(document.querySelector("button")).toBeNull(); // no folder-open affordance
  });

  // slice-04 REV6（qitem-20260722114922）——修复前 GREEN 特征锁定：
  // opener 把当前 slice-dir relPath 与一个 SLICE 相对 ref
  // 恰好拼接一次。这些证明 opener 正确/未改；缺陷在于
  // composer 发出 mission 相对的 confirm-faithful ref（在
  // review-composer.test.ts 锁为 RED），而非任何 opener 行为。
  it("R2 pin (GREEN): a slice-relative PROOF.md resolves the canonical slice path exactly once (never duplicated)", () => {
    render(<EvidenceOpener evidenceRef="PROOF.md" ctx={ctx} testId="cf" />);
    const readPath = screen.getByTestId("cf-md").getAttribute("data-readpath");
    expect(readPath).toBe("missions/m/slices/s/PROOF.md");
    expect(readPath).not.toBe("missions/m/slices/s/missions/m/slices/s/PROOF.md");
  });

  it("R3 pin (GREEN): an ordinary slice-relative proof/qa.md is preserved/openable, unchanged", () => {
    render(<EvidenceOpener evidenceRef="proof/qa.md" ctx={ctx} testId="pq" />);
    expect(screen.getByTestId("pq-md").getAttribute("data-readpath")).toBe("missions/m/slices/s/proof/qa.md");
  });
});
