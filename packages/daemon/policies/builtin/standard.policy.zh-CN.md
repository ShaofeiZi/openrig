---
source: builtin
name: standard
surface: config
policy_schema_version: 1
description: 推荐的默认策略——适用于约 80% 软件工厂场景的交互式开发姿态。包括 push 在内的常规开发操作直接执行；对外发布、正式发布和重写历史的操作则询问人类。
default_posture: allow
allow: [push_to_remote]
ask: [create_pr, publish_package, merge_or_release, force_push]
deny: []
destructive_class: [delete_everything, drop_persistent_store, reset_or_discard_vcs]
---

# Standard ⭐（内置策略——推荐默认值）

适用于日常**交互式开发**的软件工厂姿态。常规工作无需提示即可运行；会造成显著后果的对外操作和重写历史操作交由人类决定。

- **default_posture: allow**——常规开发操作（工具链、任意 shell、安装依赖、限定范围的文件删除、网络和拓扑操作）无需提示即可运行。
- **allow: [push_to_remote]**——允许常规 `git push`（策略明确固定此项，因为其设计拒绝默认拦截 push）。
- **ask: [create_pr, publish_package, merge_or_release, force_push]**——对外发布、正式发布和重写历史的操作需要**询问**人类。**ASK 不等于 deny**：zrig 不会内置拦截；ASK 表示交由人类决定，是该策略对超出可用性下限操作的明确默认处理方式。Claude 的前缀规则无法可靠区分 `git push --force`，因此 `force_push` 只能尽力执行 ASK；如实标记为 ASK，比声称它是无法执行的 deny 更准确。
- **destructive_class → ask**——`delete_everything`、`drop_persistent_store` 和 `reset_or_discard_vcs` 默认为 ASK，绝不会被静默阻止（在能力范围内优先保证安全）。

**交互式开发姿态：**`ask` 会按设计冻结自主席位——自主 fleet 应使用 Open 或 YOLO，而不是 Standard。

**可用性下限（FLOOR，始终启用，属于 flag 界面）：**Claude 使用 `acceptEdits`，Codex 使用 `workspace-write`，两者共同构成编辑/沙箱下限；Pi 的 `--no-approve` 是资源**信任**姿态，不是权限下限（Pi 没有权限界面）。**转换工作由 skill 负责**，即把与 harness 无关的意图转换成各 harness 的格式，并附上必要限制说明。
