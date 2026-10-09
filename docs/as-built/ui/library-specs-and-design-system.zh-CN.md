---
kind: as-built
title: UI Library/Specs 表面 + 设计系统指针
status: active
topics: [specification-and-bundles, observability]
domains: [engineering-advisor, product-advisor]
applies-when: |
  需要了解 Library（`/specs`）UI 如何装配 —— spec/skills/plugins 表面、
  喂它的 spec-review + spec-library + live-identity 流 —— 或规范视觉/
  设计系统 spec 在何处。
siblings: [shell-and-routing.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# UI Library/Specs 表面 + 设计系统指针

Library 目的地保持路由 `/specs`，产品标签为"Library"：specs、applications、context packs、agent specs、agent images、plugins、skills。

> 已在 HEAD `7eaf524c` 对照源码核验；包版本 **0.3.1**（slice-00 §1.1）。下方组件/原语名已在 HEAD 对照 `packages/ui/src/components/` 核对 —— 不是轻信 `ui.md` 或 `DESIGN.md` 的列表。

## 1. Library / specs 表面

`packages/ui/src/components/specs/` 下组件（HEAD 重新确认）：

- `SpecsLibraryPage.tsx` —— `/specs` Library 页（统一列表：All / Apps / Rigs / Agents；service 支撑条目渲染为 `APP`）。
- `SpecsTable.tsx`、`SpecsTreeView.tsx` —— 列表 + Explorer 树。
- `SkillsIndexPage.tsx`、`SkillDetailPage.tsx` —— 基于文件夹的 skills。skill 树把每个 skill 当文件夹；点击 skill 打开详情路由，默认大小写不敏感地找 `skill.md`，通过中心工作区共享 `FileViewer` 渲染（不在页内放第二个文件浏览器 —— 文件导航属于 Explorer 树）。
- `PluginsIndexPage.tsx`、`PluginDetailPage.tsx`、`AgentPluginsList.tsx` —— 插件表面。

> 漂移注（slice-00 0.3.0-GT seam a）：插件原语是 **0.3.1** 特性（git 血统证明；`v0.3.0` 缺、`v0.3.1` 有）。不要把 `/specs/plugins`、`/plugins/$pluginId` 路由或这些插件组件回溯归到 0.3.0。`ui.md`（早于 0.3.x）**完全没有插件叙述** —— 这些表面是从源码 + slice-00 0.3.0-GT seam 撰写的，不是迁移来的。

## 2. Spec 评审 / 库 / live-identity 流

这些后台服务支撑流喂 Library UI（`architecture.md` §6 "Spec review and spec library flow"、"Live identity / specs UI flow"，HEAD 重新确认准确）：

- **Raw YAML 预览：** UI/CLI 把 YAML POST 到 `/api/specs/review/rig` 或 `/api/specs/review/agent`；`SpecReviewService` 解析/校验/返回结构化评审模型；UI 通过 `RigSpecDisplay` / `AgentSpecDisplay` 渲染（同一组原语复用于草稿预览、库评审、live 全详情）。
- **文件系统支撑库：** `SpecLibraryService` 扫描 builtin + 用户根（`packages/daemon/specs`、`~/.openrig/specs`、旧版回退 `~/.rigged/specs`）；每个 YAML 经结构化评审分类；service 支撑 rig 标记 `hasServices`；`/api/specs/library` 服务 list/get/review/sync。
- **CLI 镜像：** `rig specs ls/show/preview/add/sync`；`rig specs add` 安装单个 YAML spec 或完整 spec 目录；`rig up` / `rig bootstrap` 在其他源种类前解析库名。
- **Live identity：** Explorer/图选中打开共享右侧抽屉（runtime 优先节点详情：live 身份、peers、有向边、转录助手、紧凑 spec 摘要）；`Open Full Details` 在中心工作区导航到 `/rigs/$rigId/nodes/$logicalId`。

## 3. UI 原语清单（对照源码核对）

> 漂移修正 —— `ui.md` "Design Primitives"（L75–107）漏了 `ProjectPill`。`docs/DESIGN.md` L195 列了它；HEAD 重新确认是真实导出（`packages/ui/src/components/project/ProjectMetaPrimitives.tsx:196` `export function ProjectPill`）。下方核对后清单来自源码，不是任一文档列表。

- **Vellum/base**（`components/ui/`）：`VellumCard`、`VellumSheet`、`RegistrationMarks`、`StatusPip`、`SectionHeader`、`EmptyState`、`Button`、`Tabs`、`Table`、表单控件，外加 `rig-stamp.tsx`（`RigStamp`）—— HEAD 存在；不在 ui.md 列表。
- **Graphics**（`components/graphics/RuntimeMark.tsx`，导出重新确认）：`RuntimeMark`、`RuntimeBadge`、`ToolMark`、`ToolBadge`、`ActorMark`、`OperatorMoodMark`；规范化在 `lib/runtime-brand.ts` + `lib/tool-brand.ts`。
- **Project metadata**（`components/project/ProjectMetaPrimitives.tsx`，导出重新确认）：`ProjectPill`（`:196`）、`EventBadge`（`:224`）、`QueueStateBadge`（`:228`）、`TagPill`（`:274`）、`ActorChip`（`:283`）、`DateChip`（`:303`）、`FlowChips`（`:315`）、`ProofThumbnailGrid`（`:334`）、`ProofPacketHeader`（`:380`）—— 外加 `QueueCountIcon` / `StatusDot`（在源码里，不在 ui.md/DESIGN.md 原语列表）。
- **Viewers**：`FileViewer`（`components/drawer-viewers/FileViewer.tsx`）、`MarkdownViewer`（`components/markdown/MarkdownViewer.tsx`）、`ProofImageViewer`、`SessionPreviewPane`（`components/preview/`）。

## 4. 设计系统指针（NOT 副本 —— Q1）

规范 OpenRig 视觉/设计系统是 **`docs/DESIGN.md`**（在仓库 `docs/` 根，不在 `docs/as-built/` 下）。Q1 已批准：DESIGN.md 留在根、字节一致，本模块**指向它而非复制它**。DESIGN.md 是以下内容的来源：Vellum-paper vs Black-glass 表面语言、颜色 token（`packages/ui/src/globals.css` + `tailwind.config.ts`）、字体（`font-body` Inter / `font-headline` Space Grotesk / `font-mono` JetBrains Mono）、布局（48px rail + Explorer + 中心 + 抽屉 + 预览栈）、核心原语列表、图形系统、以及交互/动效/可访问性/do-and-do-not 规则。

> 核对注：DESIGN.md 的原语列表已在 HEAD 独立对照 `packages/ui/src/components/` 核验 —— DESIGN.md 命名的每个原语（Vellum、Graphics、Project-metadata、Topology、Preview）都在 HEAD 解析到真实导出。DESIGN.md 准确、无 slice-00 数字漂移，故原样引用。不要在此复制其内容；视觉 spec 直接读 `docs/DESIGN.md`。

## 另见

- `docs/DESIGN.md` —— 规范视觉/设计系统 spec（指针；勿复制）。
- `shell-and-routing.md` —— `/specs` 路由族 + shell + 抽屉。
- `../architecture/agent-spec-and-startup.md` —— 评审流背后的 spec 解析/解析契约。
- `../architecture/plugin-agent-image-context-pack.md` —— plugins/agent-image/context-pack Library 表面背后的 0.3.1 内容层。
- 源码根：`packages/ui/src/components/specs/`、`packages/daemon/src/domain/{spec-review-service,spec-library-service}*`。
