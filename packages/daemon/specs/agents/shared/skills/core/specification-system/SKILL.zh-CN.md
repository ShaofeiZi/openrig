---
name: specification-system
description: 用于编写工作组规格、智能体规格、工作流规格、启动/上下文片段、操作模式声明，或设计用户规格库。涵盖四种失败模式（规格能实例化拓扑，却没有工作流/模式；规格依赖本地路径，在另一主机失败；智能体把规格当作一次性文件修改，而没有保留可复用意图；验证只证明 YAML 结构，不能证明拓扑能够运行），以及验证与运行时实现之间的区别。
metadata:
  cli_surfaces_referenced:
    - agent
    - bundle
    - spec
    - specs
  openrig:
    stage: factory-approved
    sibling_skills:
      - rig-lifecycle
      - topology-mutation-and-seat-management
      - seat-scaling-and-specialization
      - cross-host-rig-commands
      - sidecar-operator
      - rig-bundles-and-shareable-artifacts
      - extension-and-user-workspace
---

# 规格系统

这是用于表达 zrig 意图的声明式原语族：**工作组规格、智能体规格、工作流规格、启动/上下文片段、操作模式声明，以及保存和复用它们的用户规格库。**

规格让人类与智能体无需在聊天中反复解释，就能描述**可重复的拓扑和行为**。规格也是可分享产物：用户应当能够发布一份规格或规格族，使另一用户可以实例化相同的工作组结构、角色结构或工作流模式。

**没有可靠的规格原语，zrig 就只能依赖手工启动提示和口口相传的记忆。** 这会阻碍可重复性、产品演示、工作组 bundle 和自主工作组构建。

## 何时使用

- 编写 RigSpec / AgentSpec / 工作流规格。
- 设计启动/上下文片段。
- 推理规格库生命周期（验证、分享、升级语义）。
- 审计规格可移植性（能否在另一主机运行）。
- 清晰区分 spec、bundle 与 extension。

## 何时不使用

- 工作是一次性的，不会被复用。一次性工作可以手工组装工作组。
- 目标是把拓扑和工作流打包成可分享产物。应使用 `rig-bundles-and-shareable-artifacts`。
- 目标是增加运行时行为。应使用 `extension-and-user-workspace`。

## 四种失败模式

1. **规格可以实例化拓扑，却无法实例化使用它所需的工作流或操作模式。** 拓扑是必要条件，但不充分；还必须声明工作流和操作模式。
2. **共享规格依赖本地路径或隐藏启动片段，换到另一主机就失败。** 为了可移植，规格必须具有自描述能力。
3. **智能体把规格当作一次性文件修改，而没有保留可复用的用户/库意图。** 规格应可复用；把每个实例都当作一次性内容，会摧毁此原语的价值。
4. **验证证明了 YAML 结构，却不能证明声明的拓扑真的能够运行。** 结构验证不够；运行时实现才是真正的证明。

## 证明标准

证明应完成：

1. 编写一份规格。
2. 验证它（结构验证）。
3. 安装它（进入规格库）。
4. 在**干净的 zrig 环境**中实例化它。
5. 同时展示**结构验证与运行时实现**。

只有验证还不够。

## Spec / bundle / extension 边界

| 概念 | 声明内容 | 示例 |
|---|---|---|
| **Spec** | 拓扑 / 角色 / 工作流结构（声明式意图） | `rig.yaml`、`agent.yaml`、`workflow.yaml` |
| **Bundle** | 为可分享实例化而打包的规格及支持片段 | Velocity Team bundle |
| **Extension** | 添加到用户工作区的运行时行为 | RigX 命令、自定义视图 |

不要混淆它们。契约应明确区分 spec、bundle 和 extension。

## 当前已交付界面

zrig 已经拥有：

- RigSpec / AgentSpec 编写（`agent.yaml`、`rig.yaml` 格式；参见 `openrig-architect` Skill）。
- 工作流规格（Markdown/YAML 文件，通过 `workflow_specs` 表由后台服务提供直读缓存；参见 `workflow-runtime` Skill）。
- Bundle/spec 命令界面（`zrig bundle / spec / agent / specs ls/show/preview/add/sync/remove/rename`）。
- 规格库（基于文件系统，位置为 `packages/daemon/specs/` 和 `~/.openrig/specs/`；参见 cli-reference.md）。

尚未交付：

- 将规格库生命周期（验证、分享、升级）作为一等原语。
- 跨主机分享规格。
- Marketplace / 公共注册表。

## 另请参阅

- `openrig-architect` Skill——RigSpec / AgentSpec 编写规范。
- `workflow-runtime` Skill——工作流规格编写与 transactional-scribe 契约。
- `rig-bundles-and-shareable-artifacts` Skill——bundle 是规格的打包形式。
- `extension-and-user-workspace` Skill——extension 添加运行时行为；spec 声明意图。
- `openrig/docs/reference/rig-spec.md`（产品参考文档）——RigSpec 格式规格。
- `openrig/docs/reference/agent-spec.md`（产品参考文档）——AgentSpec 格式规格。
