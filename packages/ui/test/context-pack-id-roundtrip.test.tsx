import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
} from "@tanstack/react-router";

afterEach(() => cleanup());

// Slice-03 Atom 5——上下文包条目 id 为 `context-pack:<ref>`，且 ref 可以包含 `/`。
// 此测试证明共享路由 `/specs/library/$entryId` 能让该 id 往返：用它构建链接 → URL →
// 读回参数 → 得到逐字节相同的 id，从而确保 LibraryReview 的 startsWith 分派与
// p.id===entryId 查找可继续支持新 id 形式。
describe("context-pack id route round-trip (Atom 5)", () => {
  const ID = "context-pack:packs/compaction-restore";

  function router() {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const home = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => {
        const navigate = useNavigate();
        return (
          <button data-testid="go" onClick={() => void navigate({ to: "/specs/library/$entryId", params: { entryId: ID } })}>
            go
          </button>
        );
      },
    });
    const review = createRoute({
      getParentRoute: () => rootRoute,
      path: "/specs/library/$entryId",
      component: () => {
        const { entryId } = useParams({ from: "/specs/library/$entryId" });
        return <div data-testid="entryid">{entryId}</div>;
      },
    });
    return createRouter({
      routeTree: rootRoute.addChildren([home, review]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }

  it("navigate(build) → useParams(read) preserves a slash-containing context-pack:<ref> id", async () => {
    render(<RouterProvider router={router()} />);
    await waitFor(() => expect(screen.getByTestId("go")).toBeDefined());
    fireEvent.click(screen.getByTestId("go"));
    await waitFor(() => expect(screen.getByTestId("entryid")).toBeDefined());
    expect(screen.getByTestId("entryid").textContent).toBe(ID);
  });

  it("a direct deep-link to the encoded URL decodes back to the id", async () => {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const review = createRoute({
      getParentRoute: () => rootRoute,
      path: "/specs/library/$entryId",
      component: () => {
        const { entryId } = useParams({ from: "/specs/library/$entryId" });
        return <div data-testid="entryid">{entryId}</div>;
      },
    });
    const r = createRouter({
      routeTree: rootRoute.addChildren([review]),
      history: createMemoryHistory({ initialEntries: [`/specs/library/${encodeURIComponent(ID)}`] }),
    });
    render(<RouterProvider router={r} />);
    await waitFor(() => expect(screen.getByTestId("entryid")).toBeDefined());
    expect(screen.getByTestId("entryid").textContent).toBe(ID);
  });
});
