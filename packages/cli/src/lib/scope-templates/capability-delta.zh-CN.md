---
capability_delta: capability-delta-v{{release_version}}
release: {{release_version}}
taxonomy: world
binding_target:
  sha: "<准确的发布切点提交>"
  dirty: "<true|false>"
audience: "<必须了解此增量的受众>"
review_status: "<draft|已审查及审查者>"
expiry:
  event: "规范头部包含 capability-delta-v{{release_version}}，且后继增量已存在"
  canon_path: "<能力规范路径>"
  successor_path: "<后继增量路径>"
---

# 能力增量 — <上一版本> → {{release_version}}

请将此增量绑定到 `binding_target` 中准确的已发布切点；绝不能绑定到尚未切版的分支，也不能省略工作树是否脏的观察结果。

## 现在可以做什么（按情境索引）

1. **<以可观察的新事实描述能力>。**
   **在以下情况使用：** <应触发使用此能力的情境>。

## 已落地，但尚不可直接操作

| 已落地界面 | 缺少的实时入口 | 当前应采取的诚实行动 |
|---|---|---|
| <界面> | <尚无法实际操作的内容> | <应改为采取的行动> |

## 应停止做什么

1. **<已淘汰的变通办法或认知>。**
   - **此前正确：** <使其在上一版本中合理的事实>。
   - **现在错误：** <新版本事实以及替代行动>。

## 选择探针

- **P-A — <否定情形或从有到无的情形>：** <提示及预期的首个回答>。
- **P-B — <肯定情形>：** <提示及预期的首个回答>。

**仅凭增量判定：** 在席位运行或读取任何内容之前，对它最先陈述的回答评分。只有当基线回答漏掉已变化的事实，而经过增量训练的回答正确命中时，探针才算合格；已经掌握的行为不能作为增量证据。

## 规范补丁

- **已经存在——不要重复：** <已经讲明该事实的规范内容>。
- **补丁：** <缺失的最小规范变更及其准确目标路径>。
- **过期标记：** 吸收完成后，在指定规范文件的头部加入 `capability-delta-v{{release_version}}`，并在 `expiry.successor_path` 创建后继增量。此后，咨询式审计会报告该增量已不可再引用。

---

> 流程与约定见 `docs/reference/sdlc-conventions.md`（安装后路径：`$OPENRIG_HOME/reference/sdlc-conventions.md`）。此产物只保存特定版本的事实；不要把版本边界 SOP 复制到这里。
