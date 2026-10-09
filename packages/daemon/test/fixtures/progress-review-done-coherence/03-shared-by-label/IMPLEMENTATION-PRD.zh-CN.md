---
id: OPR.0.4.7.3
slice: 03-shared-by-label
mission: release-0.4.7
status: planned
stage: wip
created: 2026-07-10
---

# 切片 03——Shared by 标签（实现 PRD）

## 意图

对于其他人分享给我的相册，在相册卡片上显示紧凑的 `Shared by [name]` 标签。该标签保持只读，且仅在当前用户不是相册所有者时显示。我希望在点击相册前就能知道自己将打开谁的相册。

## 最小需求

1. 对于分享给我的相册卡片（我**不是**所有者），在相册标题上方渲染一行紧凑的 `Shared by [name]`。
2. 名称解析：有可用展示名称 → `Shared by [display name]`；否则使用字面值 `Shared by Album owner`。**绝不**显示电子邮件地址或账户/用户 ID。
3. 我自己的相册卡片**不显示** Shared-by 行，并保持当前布局。
4. 标签是只读文本，在 `all` 与 `shared` 两种相册库视图中表现一致。
5. 很长的所有者名称会截断为单行并显示省略号；标签绝不换行，也不会挤开标题/元数据。

## 证明契约

与 `README.md#proof-contract` 一致。每项通过 `zrig proof add … --evidences <n> --media <files>` 与对应证明关联；`plannedRef` 指明交付产物需要对照 `mockups/shared-by-label.html` 的哪个章节。

- [ ] **1. 分享卡片标签**——非所有者相册卡片在标题上方显示 `Shared by [display name]`。（plannedRef: §shared-card）
- [ ] **2. 隐私后备值**——所有者没有可用展示名称时，卡片显示字面值 `Shared by Album owner`。（plannedRef: §fallback-card）
- [ ] **3. 不泄漏标识符**——任何状态下，标签都不渲染电子邮件地址或原始账户/用户 ID；通过针对解析规则的聚焦测试验证。（plannedRef: §fallback-card）
- [ ] **4. 所有者卡片不变**——当前用户自己的相册卡片不渲染 Shared-by 行，布局相对当前版本不发生偏移。（plannedRef: §owner-card）
- [ ] **5. 只读**——标签是非交互文本；整张卡片仍是唯一链接目标（不嵌套链接/按钮）。
- [ ] **6. 长名称截断**——很长的所有者名称在保持 `Shared by` 前缀的同时截断为一行并显示省略号，不换行、不挤开标题/元数据。（plannedRef: §long-name-card）

## 界面（由 R2 追踪确认，置信度 98%）

只需对已经阅读过的两个文件作出最小、有边界的变更：

### 1. 读取模型——`actions/albums.ts` → `getAlbumsForUser()`

- 为 `AlbumSummary` 增加 `sharedByName: string | null`。
- 只针对 **shared** 集合，根据每个相册的 `createdByUserId` 批量推导所有者名称（使用以共享相册创建者 ID 为 key 的单次批量查找——绝不要为每张卡片执行 N+1；遵循已有的 `Promise.all` + `Map` 批处理模式，该模式已用于资产/成员数量与封面）。
- 在**服务端**把每个名称解析为最终字符串：可用展示名称 → 该名称；否则使用字面值 `"Album owner"`。此字段绝不能返回电子邮件地址或 ID。
- 映射：`owned` 相册 → `sharedByName: null`；`shared` 相册 → 解析后的字符串。

  > 名称来源是可以通过 `createdByUserId` 获取的所有者用户记录。“可用展示名称”指非空且去除首尾空白后仍有内容的人类名称；电子邮件地址或不透明 ID 均视为*不可用* → `"Album owner"`。构建时确认准确的用户字段；如果尚不存在人类名称字段，所有共享卡片都正确回退到 `Album owner`，切片仍然可以如实交付。

### 2. UI——`app/(authenticated)/app/page.tsx` → `AlbumTile`

- 为 `AlbumTile` 的 album prop 类型增加 `sharedByName: string | null`。
- 当 `sharedByName` 非 null 时，在 `<h3>` 标题**上方**渲染 eyebrow：

  ```tsx
  {album.sharedByName && (
    <p className="text-xs font-medium text-muted-foreground truncate">
      Shared by {album.sharedByName}
    </p>
  )}
  ```

  - `truncate` = 单行 + 省略号（与已有的紧凑元数据排版一致；字重更轻且色调减弱，使其被理解为来源而不是统计）。
  - 它位于现有卡片 `<Link>` 内；卡片保持唯一点击目标——**不要**添加嵌套链接/按钮。
  - 悬停时继续保持弱化颜色（不要继承标题的蓝色悬停效果）。标题的 `group-hover:text-[rgb(0,122,255)]` 仅作用于 `<h3>`；不要让 eyebrow 落入其范围。
- 所有者卡片：`sharedByName` 为 null → 不渲染任何内容，也不预留间隙。

> **截断陷阱（已在原型图中验证）：**要让 eyebrow 的 `truncate` 真正裁切，tile 必须能够缩小到内容宽度以下。tile 是 grid item，而 grid item 默认使用 `min-width:auto`，因此带有 `whitespace-nowrap` 的 eyebrow 会拉伸整列而不是显示省略号。请在 `AlbumTile` 的 `<Link>` 上添加 **`min-w-0`**（该元素是 grid item）。缺少此项时，证明第 6 条失败，长名称会撑破列宽。此问题是在渲染 `mockups/shared-by-label.html` 时发现的。

## 设计契约（隐私不变量）

UI **不执行**后备逻辑，也永远不会接收电子邮件地址/ID。所有解析均发生在读取模型（§1）中，使证明第 3 条在结构上成立。参见 `README.md#design-contract-privacy-invariant`。

## 测试（聚焦）

- 解析规则单元测试：存在展示名称 → 名称；空白名称 → `"Album owner"`；只有电子邮件地址 / ID 标识符 → `"Album owner"`；返回字符串绝不包含 `@`。
- 读取模型结构：`owned` 条目的 `sharedByName: null`；`shared` 条目拥有非空解析字符串。

## 非目标

相册详情页头部、分享/邀请流程、所有者 profile 链接、头像/图标。参见 `README.md#scope`。
