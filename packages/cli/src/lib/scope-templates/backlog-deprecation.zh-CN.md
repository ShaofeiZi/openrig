---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: placeholder
stage: wip
verified: {{created_date}} against scaffold (zrig scope create)
created: {{created_date}}
intent: {{intent_yaml}}
depends_on: {{depends_on}}
---

# 切片 {{slice_number}} — {{title}}

## 意图

{{intent}}

## 小型需求

1. [用可观察的结果描述弃用路径。对于小型弃用工作，这一项本身就可以构成完整计划。]

## 证据约定

- [ ] [迁移已落地 / 移除工作已干净完成，并已留存记录。使用 `zrig proof add … --evidences` 关联证据；媒体通过 `--media` 附加。]

## 目标

[要弃用的内容]

## 当前状态

[当前如何工作，以及哪些内容依赖它]

## 迁移

[迁离被弃用内容的路径]

## 移除

[何时以及如何删除被弃用的内容]

---

> **如何推进此切片（SOP）：**约定的单一事实来源（SSOT）为 `docs/reference/sdlc-conventions.md`（安装后位于 `$OPENRIG_HOME/reference/sdlc-conventions.md`）。请先阅读其中的 COMPONENT MENU：你的任务目标会决定构建路径（简单默认流程、波次模型或指定的严格覆盖流程）以及规划严谨度（P0–P4 档位）；除非任务目标或调度明确指定，否则不要默认采用重型流程。默认路径的完整流程见 `mission-slice-sop` skill。所有路径的最低要求是：在 `PROGRESS.md` 中跟踪进展；通过 `zrig proof add` 写入证据，切勿手工放置；承诺的结果没有证据之前，切片**不能算完成**；最后使用 `zrig scope audit` 验证。
