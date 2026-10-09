# zrig UI 数字孪生工具（OPR.0.4.1.11.1）

此工具使用虚拟数据构建**真实的** `@openrig/ui` App，并输出为**一个**可双击打开、自包含的 `intent.html`。因此，智能体可以为功能创建分支版本，只修改切片所提议的那一项内容，并产出一个从构造上就与实时 UI **1:1** 对应的可点击 mockup（它使用的就是真实组件，永远不需要人工重新同步）。

## 每个切片的编写循环（约 2 步 + 捕获）

1. **只修改切片提出的那一项内容**——编辑 `twin/fixtures.ts` 中的值（数据/状态提案），或编辑 `src/` 中待提议的组件/变体。该编辑产生的 diff 就是变更的持久核心。
2. 在 `packages/ui` 中运行 **`npm run twin:build`** → 输出单文件 `twin-out/intent.html`。通过 `TWIN_ROUTE` 指定界面，例如 `TWIN_ROUTE=/topology/rig/rig_delivery npm run twin:build`。
3. **（捕获）**将它截屏为 `intent.png`：`"<chrome>" --headless=new --window-size=1440,900 --virtual-time-budget=9000 --screenshot=intent.png "file://$PWD/twin-out/intent.html"`

每个切片的持久记录 = `change.diff` + `intent.png`（体积较大的 `intent.html` 可按需重新生成；`twin-out/` 已加入 gitignore）。

## 接缝（无需后台服务，**不是** MSW）

twin 会在导入任何 `@openrig/ui` 模块（`twin-main.tsx`）前安装三个轻量接缝，以渲染真实 App：

- **cache-seed**（`seed.ts`）— 使用类型化夹具按精确 queryKeys 为 react-query 缓存填充数据，并设置 `staleTime:Infinity`/`retry:false`，实现即时首屏。
- **fetch stub**（`fetch-stub.ts`）— 覆盖 `globalThis.fetch`，使用**相同的**类型化夹具响应 `/api/*`。这是必需的，因为若干 hooks 写死了 `staleTime:0 + refetchInterval`（`useNodePreview`/`useSessionPreview`、`useSettings`、`useSpecLibrary`、`useContextFleet`、`useFiles`），即使缓存已填充也会后台重新获取。它**不是** MSW，也没有 service worker。默认返回无害的 404 `unavailable`，确保没有请求 reject。
- **EventSource stub**（`eventsource-stub.ts`）— 对实时 SSE 不做任何操作，**但**会在 `/api/events` 上发出一组固定的种子活动事件，使 SSE 驱动的 For-You feed 与拓扑活动卡片实现 1:1 渲染。

## 漂移防护（FR-4 / D-2）

`twin:build` 会先运行 `tsc -p tsconfig.twin.json`。夹具以**真实导出**的 hook 接口（`RigSummary`、`NodeDetailData`、`SliceListResponse` 等）为类型依据，因此真实接口变化会使 twin 构建**失败**，从而在编译时发现漂移。（已证明：需要 `number` 时传入 `string` 会触发 `TS2322`。）

## 已填充界面（1:1 验证）

| 界面 | 路由 | 数据来源 |
|---|---|---|
| 仪表盘 | `/` | rigs/summary、ps、spec-library |
| 拓扑图 | `/topology/rig/<rigId>` | rig/<id>/graph（xyflow nodes/edges） |
| 实时节点详情 | `/rigs/<rigId>/nodes/<logicalId>` | NodeDetailData + session-preview（terminal） |
| For-You feed | `/for-you` | 种子 SSE 活动事件 + slices（storytelling） |
| 工作区 | `/project` | /api/slices + workspace.root 设置 |
| 资源库 | `/specs` | spec-library |

## 添加新界面

1. 在 `twin/fixtures.ts` 中添加类型化夹具（类型以真实 hook 接口为准）。
2. 在 `seed.ts` 中填充其 queryKey，和/或在 `fetch-stub.ts` 中增加 `/api/*` 路由（用于强制重新获取的 hooks）。对于 SSE 驱动界面，将事件添加到 `feedEvents`。
3. 运行 `TWIN_ROUTE=<route> npm run twin:build` 并截图。

## 已知后续工作

图中的 rigNode 徽章显示 STALE/UNKNOWN——每节点的 LIVE 活动来自 SSE 拓扑活动基线与时钟新鲜度，而不是静态图夹具。填充实时节点活动事件是另一项小任务；图结构本身已实现 1:1 渲染。

## 陷阱 — 组件范围 CSS 中的字体栈（测试无法发现）

`@fontsource-variable/*` 包注册的 family name 是 **`<Family> Variable`**（`Space Grotesk Variable`、`JetBrains Mono Variable`），**不是**普通名称——`main.tsx` 导入的就是该名称，`tailwind.config.ts` 的 `fontFamily` 也指向它。如果组件范围 CSS 文件（例如某个界面的 `*.css`）在 `font-family` 开头使用普通的 `"JetBrains Mono"` / `"Space Grotesk"`，就会**静默**回退到系统字体：不会产生构建错误，jsdom 单元测试无法发现，只会在与 twin/mockup 对比时呈现视觉漂移（标题与等宽字体粗细错误）。组件范围字体栈应先写注册的 Variable family，与 Tailwind token 保持一致，例如 `"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace` 和 `"Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif`。对照 mockup 捕获画面时，在宣布保真度 PASS 前，应目视检查标题与等宽字体。（发现于 OPR.0.4.1.14。）
