---
source: builtin
name: yolo
surface: flag
launch_posture: full_bypass
policy_schema_version: 1
description: 宽松的启动选择。Claude 跳过权限提示；Codex 选择 danger-full-access 与 never 审批策略；Pi 启用资源信任。
---

# YOLO（内置策略——flag 界面）

此内置策略会为 Claude 选择 `--dangerously-skip-permissions`，为 Codex 选择 `-s danger-full-access -a never`，或为 Pi 选择 `--approve`（资源信任）。在这条路径中，Codex 不接收具名 profile 参数。这些都是启动参数；原生托管限制仍然有效。只应在你明确信任的工作和环境中使用。

**应用过程是确定性的，不由 Skill 翻译。** YOLO 是一项 `surface: flag` 策略：它会解析为稳定的启动 flag，并由运行时的 flag 界面选择直接应用。`applying-a-permission-policy` Skill **不会**翻译此策略；它只会指向对应设置。flag 界面已经足够稳定，适合由确定性代码处理，因此无需承担 Skill 间接层的开销。

**策略选择与原生执行相互独立。** 成员策略会覆盖工作组策略。解析后的 config 界面选择会指定 zrig 的正常启动模式，并优先于环境中的 YOLO。原生配置与托管限制仍然有效；记录一项策略并不等于转换配置规则。

Skill 和启动指导说明的是预期行为；它们不能取代文件系统或网络边界。有关 Codex 明确的 sandbox 与审批组合，以及如何恢复受限设置，请参阅 `docs/reference/getting-started.md#opt-in-permissive-operation` 中的入门权限指南。

**命名：** YOLO 直白地表示完全绕过限制的姿态；选择器会统一展示四种具名姿态（Locked / Standard / Open / YOLO）。
