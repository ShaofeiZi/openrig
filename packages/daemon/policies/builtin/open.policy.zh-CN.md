---
source: builtin
name: open
surface: config
policy_schema_version: 1
description: 高信任度的拒绝列表姿态——除明确列出的破坏性类别需要询问外，其他操作全部允许。其开放程度仅次于 YOLO。
default_posture: allow
allow: []
ask: []
deny: []
destructive_class: [delete_everything, drop_persistent_store, reset_or_discard_vcs]
---

# Open（内置策略）

高信任度姿态：除灾难性破坏类别外，所有操作都无需提示即可运行。适合受信任的自主智能体群组，使其仍能在可能破坏磁盘的行为前保留最后一道防线。开放程度仅次于 YOLO。

- **default_posture: allow** — 允许所有操作，包括 push、PR、publish、merge/release、force_push、任意 shell、network、secrets 和 topology。
- **destructive_class → ask** — `delete_everything`、`drop_persistent_store`、`reset_or_discard_vcs` 必须询问，绝不静默阻止（在尽力保证安全的前提下）。这是唯一的例外。
- 与 Standard 的区别：Standard 会询问发布类别操作（PR/publish/merge/force_push）；Open 允许这些操作，只询问破坏性类别。

**自主运行说明：**如果尝试执行破坏性类别操作，`ask` 会使完全自主的席位暂停——这正是预期的安全后盾。如果自主智能体群组即使面对可能破坏磁盘的操作也绝不能暂停，应使用 YOLO（flag 界面上的完全绕过模式），而不是 Open。

**最低权限（始终启用，位于 flag 界面）：**Claude 使用 `acceptEdits`，Codex 使用 `workspace-write`，二者构成编辑/沙箱下限；Pi 的 `--no-approve` 属于资源信任姿态，而非权限下限（Pi 没有权限界面）。**翻译由 skill 负责。**依据 schema `a8dba0d9`。
