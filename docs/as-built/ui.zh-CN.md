---
kind: as-built
title: ui.md —— 已重组为模块化 as-built 树（重定向桩）
status: superseded
topics: [knowledge-and-context]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  你跟随一条旧引用来到 docs/as-built/ui.md。该单体文件已重组
  （slice-08，context-architecture-v1）到 ui/ 模块目录。
  去 README.md（领地地图）或 codemap.md（用例查找），再到指定的 ui/ 模块。
siblings: [README.md, codemap.md, architecture.md]
prerequisite-reads: []
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# ui.md 已重组为模块化 as-built 树

这个单文件 UI 单体被拆成一个由独立可加载、带 frontmatter 标签的主题模块组成的目录（slice-08，`context-architecture-v1`）。已交付操作者 UI 的规范 as-built 描述现位于 `ui/`。本桩是转发指针，使旧引用仍可解析。

**从这里开始：**

- [`./README.md`](./README.md) —— 领地地图与完整模块索引。
- [`./codemap.md`](./codemap.md) —— 导航索引：用例查找表与源码根指针。当你知道*要什么*但不知道*哪个模块*时用它。

## 主要内容去向

UI 内容现为 `ui/` 下的 **4 个模块**：

| 模块 | 内容迁至此 |
|---|---|
| [`ui/shell-and-routing.md`](ui/shell-and-routing.md) | 包形态、`AppShell` shell 模型（rail / Explorer / 中心工作区 / 抽屉 / 预览栈）、路由树、设计原语、共享详情抽屉/查看器系统、事件/活动消费。 |
| [`ui/topology.md`](ui/topology.md) | 拓扑表面 —— host 混合图、table/terminal 视图、activity-ring / hot-potato 视觉语言、终端预览弹出、导航/overlay 契约。 |
| [`ui/project-and-for-you.md`](ui/project-and-for-you.md) | 操作者目的地表面 —— Project 可观测（workspace/mission/slice 范围 tab）、For-You 关注流（5 卡分类器 + 队列动作）、vellum 品牌系统上的 Dashboard 着陆。 |
| [`ui/library-specs-and-design-system.md`](ui/library-specs-and-design-system.md) | Library（`/specs`）UI —— specs/applications/skills 表面、图形层、当前设计约束，以及指向 `../DESIGN.md` 的设计系统指针。 |

品牌/设计规则仍在 `docs/DESIGN.md`（仓库 `docs/` 根，按设计 —— 见 `ui/library-specs-and-design-system.md`）。
