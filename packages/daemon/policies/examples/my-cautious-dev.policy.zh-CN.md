---
source: custom
name: my-cautious-dev
surface: config
policy_schema_version: 1
description: 一个个人策略示例——日常开发可以自由运行，但任何会离开本机的操作（push、publish、network）都要先征求你的同意。
default_posture: allow
allow: []
ask: [push_to_remote, create_pr, publish_package, merge_or_release, force_push, network_egress]
deny: []
destructive_class: [delete_everything, drop_persistent_store, reset_or_discard_vcs]
---

# my-cautious-dev（自定义策略示例）

这是一个可以复制和调整的起点，展示个人策略的基本结构。你可以将策略保存在自己的项目中，并通过路径关联；它**不是**内置策略之一。

- **default_posture: allow** — 日常开发操作（编辑、构建、运行工具链和限定范围的文件变更）无需提示即可执行。
- **ask** — 任何会离开本机的操作都要先征求你的同意，包括推送到远程、创建 pull request、发布软件包、合并或发布版本、强制推送以及网络访问。“Ask”表示“先问我”，并不表示“禁止”。
- **destructive_class → ask** — 影响范围广的破坏性操作（清空工作区、删除数据存储、丢弃版本控制状态）必须先询问，再执行。

## 使用方式

在你自己的项目中保存类似策略，然后使用**相对路径**让工作组指向它；该路径从引用它的工作组规格所在目录开始解析：

```yaml
# rig.yaml
permission_policy: policies/my-cautious-dev.policy.md
```

复制文件、重命名，再按需编辑列表——它属于你，可以自由调整。内置策略（locked / standard / open / yolo）保持只读，并以 `builtin:<name>` 的形式引用；像本例这样的自定义策略位于你的项目中，通过路径引用。
