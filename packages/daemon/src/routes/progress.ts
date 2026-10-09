// UI 增强包 v0 —— 进度浏览视图路由。
//
// 端点：
//   GET /api/progress/tree
//
// 返回跨操作员白名单扫描根（通过 OPENRIG_PROGRESS_SCAN_ROOTS 配置）索引出的
// PROGRESS.md 层级。空根 → 503 并附设置提示，形状与 slices 路由一致，使 UI
// 能渲染清晰的配置提示而非通用错误。

import { Hono } from "hono";
import type { ProgressIndexer } from "../domain/progress/progress-indexer.js";

export interface ProgressRoutesDeps {
  indexer: ProgressIndexer;
}

export function progressRoutes(): Hono {
  const app = new Hono();

  function getDeps(c: { get: (key: string) => unknown }): ProgressRoutesDeps | null {
    const indexer = c.get("progressIndexer" as never) as ProgressIndexer | undefined;
    if (!indexer) return null;
    return { indexer };
  }

  app.get("/tree", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "progress_indexer_unavailable" }, 503);
    if (!deps.indexer.isReady()) {
      return c.json({
        error: "progress_scan_roots_not_configured",
        hint: "设置 OPENRIG_PROGRESS_SCAN_ROOTS=name1:/abs/path,name2:/abs/path，然后重启后台服务。",
      }, 503);
    }
    return c.json(deps.indexer.scan());
  });

  return app;
}
