---
id: {{id}}
slice: {{slice_number}}-{{slug}}
mission: {{mission}}
status: placeholder
stage: wip
verified: {{created_date}} against scaffold (rig scope create)
created: {{created_date}}
intent: {{intent_yaml}}
depends_on: {{depends_on}}
---

# 切片 {{slice_number}} — {{title}}

## 意图

{{intent}}

## 最小需求

1. [填写一眼即可理解的精简需求层级——使用编号列出可观察结果。对于较小的切片，这一项本身就可以构成完整计划。]

## 证明契约

- [ ] [填写一项承诺交付物，并将其写成可观察结果——完成后采集证据。每一项都通过 `zrig proof add … --evidences` 与对应证据关联（媒体使用 `--media` 附加）；UI 交付物需注明计划使用的原型图。]

## 源材料

- [填写路径或引用]

## 意图视觉稿

非视觉切片：将本节标记为 N/A。

- 意图图片：![意图视觉稿]({{intent_visual_image_path}})
- 持久差异：[change.diff]({{intent_visual_diff_path}})
- 重新生成预览：在 `packages/ui` 中运行 `{{intent_visual_build_command}}`，重新构建 `twin-out/intent.html`（已被 gitignore 忽略）。

## 状态

- TODO：[下一步]

## 依赖

- [跨切片依赖 / 跨版本依赖]

---

> **此切片的工作方式（SOP）：** 约定的唯一事实来源为 `docs/reference/sdlc-conventions.md`（安装后路径：`$OPENRIG_HOME/reference/sdlc-conventions.md`）。请先阅读其中的 COMPONENT MENU：你的任务目标会决定构建路径（简单默认流程、wave 模型或指定的严格覆盖层）和规划严谨度（P0–P4 档位）；除非任务目标或派发明确指定，否则不要自行采用重型流程。默认路径的完整流程由 `mission-slice-sop` Skill 提供。所有路径的最低要求是：在 PROGRESS.md 中跟踪状态；通过 `zrig proof add` 提交证据（绝不要手工放置）；在承诺结果获得证据之前，切片**不算完成**；最后使用 `zrig scope audit` 验证。
