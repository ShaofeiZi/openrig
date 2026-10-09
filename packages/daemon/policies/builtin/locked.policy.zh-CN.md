---
source: builtin
name: locked
surface: config
policy_schema_version: 1
description: 面向不受信任或敏感工作的白名单姿态——默认隐式拒绝全部操作，只显式允许最小集合。限制严格，但比 harness 的原始默认设置实用得多。
default_posture: deny
allow: [run_toolchain, rig_up, rig_down]
ask: []
deny: []
destructive_class: [delete_everything, drop_persistent_store, reset_or_discard_vcs, delete_files, force_push]
---

# Locked（内置策略）

这是限制最严格的内置策略。除非明确允许，否则所有操作都会被拒绝。适用于不受信任的工作组、敏感仓库，或必须尽量缩小影响范围的工作。

- **default_posture: deny**——任何未列入 `allow` 的语义动作都会被拒绝。
- **allow**——只允许开发工具链（`run_toolchain`：npm/node/tsc/test/lint）和工作组生命周期操作（`rig_up`/`rig_down`）。不允许 push、PR、发布、任意 shell、工具链所需范围之外的网络出口，也不允许读取 secret。
- **destructive_class**——为保持完整性而列出；在这里实际没有影响，因为默认拒绝已经阻止了这些操作。

**可用性下限（FLOOR）是独立且始终启用的**（属于 flag 界面，不是 config 开关）：Claude 使用 `acceptEdits`，Codex 使用 `workspace-write`，两者共同构成编辑/沙箱下限；Pi 的 `--no-approve` 是资源**信任**姿态，不是权限下限（Pi 没有权限界面）。因此，采用 Locked 的席位仍然可以编辑文件，只是如果没有显式授权，就不能超出最小 allow 集。

**转换工作由 skill 负责。**本规范表达与 harness 无关的语义意图；`applying-a-permission-policy` skill 会将其转换为各 harness 的形式（Claude 前缀规则 / Codex 姿态 / Pi bit），并附上与版本对应的注意事项。依据 schema `a8dba0d9`。
