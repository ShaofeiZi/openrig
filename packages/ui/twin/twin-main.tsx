// OPR.0.4.1.11.1（FR-1）——数字孪生入口。原样挂载真实的 @openrig/ui App；
// 与生产 main.tsx 的唯一差异是：(a) EventSource SSE 桩，(b) 预置种子的 react-query
// 缓存，(c) staleTime:Infinity/retry:false，使种子数据绝不重新拉取。不 fork 组件树——
// twin 就是真实组件，因此构造上与实时 UI 1:1，从不需要手动重新同步。

// 必须最先：在任何 @openrig/ui 模块导入前安装无后台服务的接缝——
// 空操作 EventSource（SSE）+ fixture 支撑的 fetch（用于 staleTime:0 重新拉取的 hook）。
import "./eventsource-stub.js";
import "./fetch-stub.js";

// 字体 + 全局样式，与生产 main.tsx 相同。
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "../src/globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter, createMemoryHistory } from "@tanstack/react-router";
import { queryClient } from "../src/lib/query-client.js";
import { routeTree } from "../src/routes.js";
import { seedTwinCache } from "./seed.js";
import { ThemeProvider } from "../src/components/ThemeProvider.js";
import { THEME_STORAGE_KEY } from "../src/lib/theme.js";

// 本 intent.html 落点界面，在构建时从 TWIN_ROUTE 环境注入
// （vite `define`）；逐 slice 创作时把它设为所提议的界面。默认 "/"。
declare const __TWIN_ROUTE__: string;
const TWIN_ROUTE = __TWIN_ROUTE__;

// twin 中的 0.4.3.29 主题——真实的 ThemeProvider 挂载在下方（与生产 main.tsx 相同）。
// `TWIN_THEME=dark|light|system npm run twin:build` 在挂载前预置持久化选择，使截图
// 默认采用某调色板；空 = provider 的正常解析（操作者经真实 ThemeSelector 切换）。
declare const __TWIN_THEME__: string;
if (__TWIN_THEME__) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, __TWIN_THEME__);
  } catch {
    /* localStorage 不可用（某些 file:// 上下文）——provider 回退 */
  }
}

// 种子数据是权威的：绝不过期、绝不重新拉取、绝不重试（无后台服务）。
queryClient.setDefaultOptions({
  queries: {
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  },
});
seedTwinCache(queryClient);

// twin 自己的路由，基于真实 routeTree，用内存历史固定到目标路由——
// 静态可双击文件（file://）没有供浏览器历史匹配的服务器路径，否则应用会渲染 Not Found。
// 组件与生产相同；仅历史与入口接线不同（FR-1）。
const twinRouter = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: [TWIN_ROUTE] }),
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <RouterProvider router={twinRouter} />
      </ThemeProvider>
    </StrictMode>,
  );
}
