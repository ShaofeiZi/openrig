// PL-007 Workspace Primitive v0——WorkspaceKindBadge 组件测试。
//
// 锁定项：
//   - 渲染 5 种类型化类别之一，并带标签和正确 testid
//   - 紧凑模式渲染单字符字形
//   - resolveKindForPath 返回最长前缀匹配
//   - 路径仅位于 knowledgeRoot 下时，resolveKindForPath 返回 "knowledge"
//   - 路径不属于任何范围时，resolveKindForPath 返回 null

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkspaceKindBadge, resolveKindForPath } from "../src/components/WorkspaceKindBadge.js";

describe("WorkspaceKindBadge (PL-007)", () => {
  it("renders the label for each of the 5 kinds", () => {
    for (const k of ["user", "project", "knowledge", "lab", "delivery"] as const) {
      const { unmount } = render(<WorkspaceKindBadge kind={k} />);
      expect(screen.getByTestId(`workspace-kind-badge-${k}`)).toBeTruthy();
      unmount();
    }
  });

  it("compact prop strips to glyph", () => {
    render(<WorkspaceKindBadge kind="knowledge" compact />);
    const el = screen.getByTestId("workspace-kind-badge-knowledge");
    expect(el.textContent).toBe("K");
  });
});

describe("resolveKindForPath (PL-007)", () => {
  const workspace = {
    repos: [
      { name: "main", path: "/r/hub/main", kind: "project" as const },
      { name: "internal", path: "/r/hub/main/sub", kind: "project" as const },
      { name: "lab", path: "/r/hub/lab", kind: "lab" as const },
    ],
    knowledgeRoot: "/r/knowledge",
  };

  it("longest-prefix wins", () => {
    expect(resolveKindForPath("/r/hub/main/sub/file.ts", workspace)).toBe("project");
  });

  it("matches outer when not in nested", () => {
    expect(resolveKindForPath("/r/hub/main/other", workspace)).toBe("project");
  });

  it("kind=knowledge when under knowledgeRoot only", () => {
    expect(resolveKindForPath("/r/knowledge/canon", workspace)).toBe("knowledge");
  });

  it("returns null when outside everything", () => {
    expect(resolveKindForPath("/elsewhere", workspace)).toBeNull();
  });

  it("returns null when workspace is null", () => {
    expect(resolveKindForPath("/r/hub/main", null)).toBeNull();
  });

  it("returns null when path is empty/null", () => {
    expect(resolveKindForPath(null, workspace)).toBeNull();
    expect(resolveKindForPath(undefined, workspace)).toBeNull();
  });
});
