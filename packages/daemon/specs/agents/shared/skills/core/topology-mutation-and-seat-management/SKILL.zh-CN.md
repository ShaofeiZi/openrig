---
name: topology-mutation-and-seat-management
description: 用于在工作组存活期间修改它——`rig expand` / `rig shrink` / `rig launch` / `rig remove` / `rig discover` / `rig bind` / `rig adopt` / `rig attach`。涵盖四种失败模式（新建席位缺少队列/启动信息/角色；边和权限未更新；adopt/bind 在 tmux 层成功但 zrig 身份层失败；shrink/remove 留下过时拓扑引用），以及“必须在工作组活跃期间验证修改，而不能只在干净 fixture 中验证”的规则。
metadata:
  cli_surfaces_referenced:
    - adopt
    - attach
    - bind
    - discover
    - expand
    - launch
    - ps
    - release
    - remove
    - shrink
    - unclaim
    - up
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - rig-lifecycle
      - seat-scaling-and-specialization
      - cross-host-rig-commands
      - sidecar-operator
      - rig-bundles-and-shareable-artifacts
      - specification-system
      - extension-and-user-workspace
---

# 拓扑修改与席位管理

在工作组**存活期间**改变它的能力：扩展、缩减、启动、删除、发现、绑定、接纳和连接席位或会话。席位管理还包括让这些修改保持一致所需的**稳定标识符、边、角色与启动上下文**。

**zrig 应当触手可及。** 用户应该能够增加容量、退役容量、接纳现有会话或连接终端，**而无需重建整个拓扑。** 如果修改很少经过测试，用户就会避免使用它，产品也会退化回静态启动脚本。

## 何时使用

- 为运行中的工作组增加容量（`zrig expand <rig> <pod-fragment-path>`）。
- 移除容量（`zrig shrink` / `zrig remove`）。
- 在运行中的工作组内启动/重新启动节点（`zrig launch`）。
- 将发现的会话绑定到现有逻辑节点（`zrig bind`）。
- 接纳拓扑并绑定实时会话（`zrig adopt`）。
- 将 shell 或智能体连接到工作组节点（`zrig attach --self`）。

## 何时不使用

- 从头创建全新工作组时——使用 `zrig up`（属于生命周期，不是修改）。
- 目标是专门扩容（增加专业化容量）时——使用 `seat-scaling-and-specialization` Skill。
- 目标是在稳定席位上替换占用者时——使用 `seat-continuity-and-handover` Skill。

## 四种失败模式

1. **新建席位缺少工作所需的队列、启动上下文或角色文件。** 拓扑修改创建了席位，但席位要真正可用，不能只有 tmux 会话。
2. **增加或删除席位时没有更新边和权限。** 拓扑引用过时；之后的工作流会路由到不存在的席位。
3. **Adopt/bind 在 tmux/会话层成功，却没有在 zrig 身份层成功。** 会话已经连接，但 `zrig whoami` 无法识别；下游消费者只能看到部分状态。
4. **Shrink/remove 留下过时拓扑引用，后续工作流仍向其中路由。** 清理是操作的一部分，不能事后补做。

## 证明标准

证明必须覆盖**工作组活跃期间的修改**，不能只覆盖干净测试 fixture。实用矩阵如下：

| 操作 | 验证内容 |
|---|---|
| 增加席位 | 新席位拥有队列、启动上下文和角色；`zrig whoami` 能够解析 |
| 删除席位 | 已清理过时引用；边/权限已更新 |
| 接纳现有会话 | tmux 会话已在 zrig 身份层绑定；`zrig whoami` 报告正确 |
| 连接观察终端 | 已记录外部 CLI 连接 |
| 每次移动后验证拓扑投影 | `zrig ps --nodes` 反映当前事实，而不是修改前缓存 |

干净 fixture 证明是必要条件，但不充分。实时工作组证明可以发现 fixture 模式遗漏的失败。

## 拓扑变更期间的稳定角色

容量变更必须保留有用角色、路由与持久工作。应区分增加/删除席位与替换占用者；后者使用 `seat-continuity-and-handover`。

## 当前已交付界面

根据 `cli-reference.md` v0.2.0：

- `zrig expand <rig-id> <pod-fragment-path>`（可选 `session_source`）
- `zrig shrink <rigId> <podRef>`
- `zrig launch <rigId> <nodeRef>`
- `zrig remove <rigId> <nodeRef>`
- `zrig discover [--draft]`
- `zrig bind <discoveredId> --rig <rigId> (--node <id> | --pod <ns> --member <name>)`
- `zrig adopt <path> --bind <logicalId=tmuxSessionOrDiscoveryId>`
- `zrig attach --self --rig <rigId> --node <logicalId>`
- `zrig unclaim <sessionRef>` / `zrig release <rigId>`

## 选择证明环境与权限

为相关操作选择隔离的活跃工作组，或得到明确授权的实时目标。记录其运行构建版本、修改前后拓扑、连续性和未完成工作。通过 schema 检查或隔离 fixture 不能证明现有实时工作组已被正确修改。运行时超时在核对持久效果与进程效果前属于结果不确定；不要盲目重试。

上方矩阵只是验证指导，不代表允许修改其他工作组。明确操作负责人和范围，保留恢复所需状态，并在结果中保留缺失或失败的检查。加载此 Skill 并不隐含本地实验或未完成证明义务。

## 另请参阅

- `openrig-user` Skill——`zrig expand / shrink / launch / remove / bind / adopt / attach` 的 CLI 界面。
- `seat-scaling-and-specialization` Skill——何时增加专业化容量而不是通用容量。
- `seat-continuity-and-handover` Skill——在稳定席位上替换占用者（形态不同于拓扑修改）。
- `cross-host-rig-commands` Skill——跨主机拓扑修改（延后）。
