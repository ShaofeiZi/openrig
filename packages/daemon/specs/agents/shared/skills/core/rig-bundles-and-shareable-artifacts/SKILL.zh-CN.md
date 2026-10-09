---
name: rig-bundles-and-shareable-artifacts
description: 当编写或安装工作组 bundle（可打包、共享并实例化带有明确主张的 zrig 拓扑 + 工作流的制品）、分析 bundle 与 extension 边界，或审计 bundle 的可移植性时使用。涵盖导致 bundle 只能在 operator 机器上工作的 4 种失败模式，以及安装前先检查的纪律。
metadata:
  cli_surfaces_referenced:
    - bundle create
    - bundle inspect
    - bundle install
  openrig:
    stage: factory-approved
    sibling_skills:
      - rig-lifecycle
      - topology-mutation-and-seat-management
      - seat-scaling-and-specialization
      - cross-host-rig-commands
      - sidecar-operator
      - specification-system
      - extension-and-user-workspace
---

# 工作组 Bundles 与可共享制品

**工作组 bundle** 是可打包、可共享的制品，用来实例化具有明确主张的 zrig 拓扑和工作流。它可以包含：

- 工作组规格
- 智能体规格
- 工作流规格
- 启动文件
- skills 或 skill 引用
- 运行模式声明
- 证据预期
- 支持性片段

**可共享制品**的范围比 bundle 更广：规格、bundles、skills、工作流和 extensions 都可以共享。bundle 是“加载此拓扑及工作方式”的打包形式。

## 适用场景

- 根据已验证的实验室模式编写 bundle
- 安装 bundle（`zrig bundle install <path>`）
- 安装前检查 bundle（`zrig bundle inspect <path>`）
- 分析 bundle 与 extension 边界（bundle 声明拓扑 + 工作流；extension 添加行为）
- 审计 bundle 的可移植性——它能在干净 zrig 环境中工作，还是只能在作者机器上工作？

## 不适用场景

- 工作是不会复用的一次性拓扑。仅使用规格即可。
- 目标是添加运行时行为（命令、视图、仪表盘）。应使用 `extension-and-user-workspace`，而非 bundles。
- 你希望把工作流作为后台服务功能交付。bundle 是晋升为后台服务功能**之前**的路径。

## Bundle 与 extension 边界（承重结构）

| 概念 | 声明内容 | 示例 |
|---|---|---|
| **Bundle** | 工作组形态 + 工作流（“加载此拓扑及工作方式”） | Velocity Team bundle |
| **Extension** | 添加到用户工作区/运行时的行为 | 自定义命令、视图或仪表盘 |

不要混淆两者。bundle 是*有明确主张的内容*；extension 是*新增行为*。两者都可以成为可共享制品，但结构不同。

## 失败模式（4 种）

1. **bundle 只能在 operator 机器上工作**，因为路径、providers 或凭据是隐式的。bundle 必须能在干净 zrig 环境中自我描述。
2. **bundle 包含过多本地状态，变成备份归档，而不是可复用制品。**bundle 表达的是*预期形态*，不是某个特定安装的当前状态。
3. **bundle 声明了拓扑，却遗漏证据预期或工作流模式。**只有拓扑无法告诉用户“按说明正常工作”究竟意味着什么。
4. **用户无法在安装前检查 bundle 会创建什么。**`zrig bundle inspect` 必须在无副作用的情况下显示将创建的内容。

## 证据标准

证据应当：

1. 将 bundle 安装到**干净 zrig 环境**
2. 实例化它
3. 验证预期席位和工作流模式
4. 运行小型冒烟证明，确认拓扑按说明工作

## 从 Bundle 到产品

Bundles 是将已验证的实验室模式变成可复用产品体验的方式：

```
本地 dogfood 模式
  → bundle（包含 manifest、参数化、证据预期）
  → 由另一个用户安装到干净 zrig 环境
  → 无需成为后台服务功能即可交付有明确主张的工作流
  → 足够可靠后，将部分能力晋升到核心后台服务
```

zrig 也因此能够交付具有明确主张的工作流，**而不必把每个工作流都做成后台服务功能。**

## 另请参阅

- `extension-and-user-workspace` skill——添加到运行时的用户所有行为；bundle 与 extension 边界的同级原语
- `specification-system` skill——bundle 打包的工作组规格 / 智能体规格 / 工作流规格
- `agent-starters` skill——bundle 可包含或引用 Agent Starters
- `composable-priming-packs` skill——bundle 可打包 priming packs
- `openrig-user` skill——`zrig bundle create / inspect / install` CLI 界面
