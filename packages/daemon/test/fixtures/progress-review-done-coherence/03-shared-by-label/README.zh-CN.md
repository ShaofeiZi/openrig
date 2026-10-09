---
id: OPR.0.4.7.3
slice: 03-shared-by-label
mission: release-0.4.7
status: planned
stage: wip
verified: 2026-07-11 — 最小需求 + 证明契约 + mockup 由 dev1.design 编写
created: 2026-07-10
approved-spec-by: dev1-design@product-team
approved-spec-at: 2026-07-11T00:46:10.856Z
approved-by: dev1-qa@product-team
approved-at: 2026-07-11T01:49:25.159Z
---

# 切片 03 — “Shared by”标签

## 意图

对于由他人共享给我的相册，在相册卡片上显示紧凑的 `Shared by [name]` 标签。该标签保持只读，并且只在当前用户不是相册 owner 时显示。我希望在点击相册之前，就知道自己将要打开谁的相册。

## 最小需求

1. 对于共享给我的相册卡片（我**不是** owner），在相册标题上方渲染紧凑的 `Shared by [name]` 文本行。
2. 名称解析规则：存在可用 display name 时显示 `Shared by [display name]`；否则显示字面量 `Shared by Album owner`。**绝不能**显示电子邮件地址或 account/user id。
3. 属于我自己的相册卡片**不显示** Shared-by 文本行，并保持现有布局（不预留空隙、不发生位移）。
4. 标签是只读文本，并且在 `all` 和 `shared` 两个 library 视图中以完全相同的方式显示。相册卡片仍然是唯一点击目标。
5. owner 名称过长时，应截断为带省略号的单行文本；标签不得换行，也不得挤压标题或元数据行。

## 证明契约

每一项都通过 `zrig proof add … --evidences <n> --media <files>` 与其证明关联。`plannedRef` 指定交付产物对照的 mockup 章节（`mockups/shared-by-label.html`）。

- [ ] **1. 共享卡片标签**——非 owner 的相册卡片在标题上方显示 `Shared by [display name]`。*（plannedRef: §shared-card）*
- [ ] **2. 隐私回退**——owner 没有可用 display name 时，卡片显示字面量 `Shared by Album owner`。*（plannedRef: §fallback-card）*
- [ ] **3. 不泄漏标识符**——任何状态下，标签都不渲染电子邮件地址或原始 account/user id；通过针对名称解析规则的聚焦测试验证。*（plannedRef: §fallback-card）*
- [ ] **4. Owner 卡片不变**——当前用户自己的相册卡片不显示 Shared-by 文本行，且与当前布局相比不发生位移。*（plannedRef: §owner-card）*
- [ ] **5. 只读**——标签是非交互文本；整张卡片仍是唯一链接目标，不得嵌套 link/button。
- [ ] **6. 长名称截断**——较长的 owner 名称截断为带省略号的单行，同时保留 `Shared by` 前缀，并且不换行、不挤压标题/元数据。*（plannedRef: §long-name-card）*

## 工作范围

**创始人批准的行为（逐字引用创始人返回的 `qitem-20260711000531-c99c01b7`）：**

- 非 owner 卡片：`Shared by [display name]`。
- 缺少或无法使用名称：字面量 `Shared by Album owner`。
- 绝不显示电子邮件地址。
- Owner 卡片：省略该行。
- 只读。

**范围内**

- library 网格（`/app`）中的相册 tile 显示只读 `Shared by` 标签，覆盖 `all` 和 `shared` 过滤器。
- 在 `actions/albums.ts` 的共享相册读取路径（`getAlbumsForUser`）中增加批量创建者名称推导。
- 每个共享相册包含一个由**服务端解析**的 `sharedByName`（见下方设计契约）。

**范围外**

- 相册详情页 header（本切片仅处理 library 网格）。
- 任何新的共享/邀请功能、owner profile 页面或可点击的 owner 链接。
- avatar、icon 或 image——标签只使用文字，与现有元数据样式一致。
- 对 owner 卡片进行任何修改；仅确认它们省略该行。

## 设计契约（隐私不变量）

读取模型在**服务端**解析标签，只向 UI 发送最终字符串：

- `getAlbumsForUser()` 为每个**共享**相册返回 `sharedByName: string`，其值已经缩减为 owner 的可用 display name 或字面量 `"Album owner"`。
- Owner 相册返回 `null` 或不包含 `sharedByName`，卡片不渲染该行。
- UI **不执行**回退逻辑，并且**永远不会**收到 owner 的电子邮件或 id。这样可以把隐私规则集中在一个位置，并使第 3 项“不泄漏标识符”在结构上成立，而不仅是视觉上看不到。
- “可用 display name”指非空且 trim 后仍有内容的人类名称。如果唯一可用标识符是电子邮件地址或不透明 id，则将名称视为缺失，回退为 `"Album owner"`。

## 放置决策（供实现/QA 使用——不得重新争论）

标签是位于标题上方、封面图与 `<h3>` 标题之间的**来源眉题**：使用 `text-xs` 和 muted 样式（`text-muted-foreground`），保持单行，卡片 hover 时不改变颜色。

已考虑但否决的方案：

- *放到元数据行开头*（`Shared by Jane | 12 photos | …`）——这会把来源信息压平为统计信息，并在名称过长时迫使计数换行。
- *放到元数据行结尾*——这会把“相册属于谁”这一答案藏在最后，违背点击前快速识别的目标。

## 风险

- 标签必须说明相册为何出现在我的 library 中，同时不能泄漏私密账户信息——由上述服务端解析契约缓解。
- 名称过长或缺失时不能破坏 tile 布局——由证明项 4 和 6 覆盖。

---

> **处理本切片的方式（SOP）：**约定的唯一事实源（SSOT）是 `docs/reference/sdlc-conventions.md`；完整流程见 `mission-slice-sop` skill。作者意图 → 最小需求 + 证明契约（UI 切片还包括 mockup）→ 计划锁（`zrig scope slice approve --scope spec`）→ 构建已锁定集合 → QA 视觉对比 → `zrig proof add … --evidences --media` 将证据 drop 到 `proof/`（绝不能跳过 drop 手工放置证据）→ 证明锁（`--scope delivery`）。在 PROGRESS.md 中跟踪；每个证明契约项具备证据之前，切片**不算完成**。使用 `zrig scope audit` 验证。
