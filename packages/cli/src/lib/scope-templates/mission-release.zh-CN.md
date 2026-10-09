---
id: {{id}}
mission: {{mission}}
release: {{release_version}}
stage: wip
verified: {{created_date}} against scaffold (rig scope create)
created: {{created_date}}
intent: {{intent_yaml}}
depends_on: {{depends_on}}
---

# 发布版本 {{release_version}} — {{title}}

## 意图

{{intent}}

## 范围

[说明 v{{release_version}} 会交付什么，以及哪些内容留待后续版本]

## 切片

[说明执行顺序与依赖关系；状态由 PROGRESS.md 跟踪]

## 验收

[发布版本层面的完成定义]

---

> 请以此 `SPEC.md` 为工作依据；将持久验收状态保存在 `PROGRESS.md` 中，将不属于契约的上下文保存在 `NOTES.md` 中。操作流程请加载 `mission-slice-sop` Skill。约定的唯一事实来源：`docs/reference/sdlc-conventions.md`（安装后路径：`$OPENRIG_HOME/reference/sdlc-conventions.md`）。
