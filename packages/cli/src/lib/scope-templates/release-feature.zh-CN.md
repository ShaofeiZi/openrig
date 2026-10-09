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

1. [用简洁、一眼可读的需求层级，按编号列出可观察的结果。]

## 证据约定

- [ ] [写出一项承诺交付物，并将其表述为可观察的结果，同时留存记录。每项都要使用 `zrig proof add … --evidences` 关联证据；媒体通过 `--media` 附加；UI 交付物还需注明计划采用的 mockup。]

## 范围

[说明 v0 包含与不包含的内容]

## 风险

[已知的未知项]

---

> **如何推进此切片（SOP）：**约定的单一事实来源（SSOT）为 `docs/reference/sdlc-conventions.md`（安装后位于 `$OPENRIG_HOME/reference/sdlc-conventions.md`）。请先阅读其中的 COMPONENT MENU：你的任务目标会决定构建路径（简单默认流程、波次模型或指定的严格覆盖流程）以及规划严谨度（P0–P4 档位）；除非任务目标或调度明确指定，否则不要默认采用重型流程。默认路径的完整流程见 `mission-slice-sop` skill。所有路径的最低要求是：在 `PROGRESS.md` 中跟踪进展；通过 `zrig proof add` 写入证据，切勿手工放置；承诺的结果没有证据之前，切片**不能算完成**；最后使用 `zrig scope audit` 验证。
