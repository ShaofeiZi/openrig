---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: intent
stage: wip
created: {{created_date}}
---

<!-- 弹性中段（三个采集点原则）：SDLC 只固定三个采集点——意图 → 与工作量成比例的结构化需求 → 证明。
     三者之间的过程保持弹性。对于较小的切片，下方的最小需求可以就是完整 PRD；只有工作确实需要时才增加深度。
     脚手架不得凭空制造流程负担。
     约定的唯一事实源（SSOT）：docs/reference/sdlc-conventions.md（安装后位于 $OPENRIG_HOME/reference/sdlc-conventions.md） -->

# 切片 {{slice_number}} — {{title}}

## 意图

[逐字记录原始意图，并与切片 README 保持同步。]

## 最小需求

1. [简洁、可一眼读懂的需求层级——审批从这里开始。]

## 证明契约

- [ ] [一项承诺的交付物，以可观察结果表述——相关证据已采集。本列表是 DELIVERED 章节逐项关联证明的事实源；使用 `zrig proof add … --evidences --media` 关联每一项（不得绕过 drop 手工放置证据）；UI 交付物需注明计划使用的 mockup（`plannedRef`）。]

## 备注（弹性）

[记录设计、边界、风险与执行顺序；内容深度以本切片实际所需为准。]
