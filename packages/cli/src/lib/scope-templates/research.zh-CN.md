---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: placeholder
stage: wip
verified: {{created_date}}，已对照脚手架验证（zrig scope create）
created: {{created_date}}
intent: {{intent_yaml}}
depends_on: {{depends_on}}
---

# 切片 {{slice_number}} — {{title}}

## 意图

{{intent}}

## 最小需求

1. [说明什么样的答案才足够。对于研究类工作，这里也可以就是完整计划。]

## 证明契约

- [ ] [能够回答问题的研究发现产物——相关证据已采集。使用 `zrig proof add … --evidences` 与证明关联；媒体文件通过 `--media` 附加。]

## 问题

[我们希望了解的事项]

## 来源

[最可能找到答案的位置]

## 研究发现

[随工作推进持续记录]

---

> **处理本切片的方式（SOP）：**约定的唯一事实源（SSOT）是 `docs/reference/sdlc-conventions.md`（安装后位于 `$OPENRIG_HOME/reference/sdlc-conventions.md`）。请先阅读其中的 COMPONENT MENU：任务目标会指定构建路径（简单默认流程、wave 模型或已分配的严格覆盖层）以及规划严格度（P0–P4 档位）；除非任务目标或调度明确要求，否则不要自行采用重量级流程。默认路径的完整流程见 `mission-slice-sop` skill。所有路径都必须满足的最低要求是：在 PROGRESS.md 中跟踪进度；通过 `zrig proof add` 写入证据（不得手工放置）；承诺的结果全部具备证据之前，切片**不算完成**；最后使用 `zrig scope audit` 验证。
