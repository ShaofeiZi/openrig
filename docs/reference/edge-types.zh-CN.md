# 边类型参考

版本：0.2.0
最近一次对照代码校验：2026-04-11
真源：`packages/daemon/src/domain/rigspec-schema.ts`、`packages/daemon/src/domain/rigspec-instantiator.ts`

---

## 概览

边（edge）定义工作组拓扑中成员之间的关系。它出现在两个地方：

- **pod 内边** —— 同一 pod 内成员之间（用不带限定的成员 ID）
- **跨 pod 边** —— 不同 pod 成员之间（用 `pod.member` 格式）

YAML 语法见 `docs/reference/rig-spec.md`。

## 边的种类

校验器接受五种边：

| 种类 | 接受 | 有运行时行为 | 描述 |
|------|------|--------------|-------------|
| `delegates_to` | 是 | **是 —— 影响启动顺序** | 源把工作委派给目标 |
| `spawned_by` | 是 | **是 —— 影响启动顺序** | 目标由源 spawn 出来 |
| `can_observe` | 是 | 否 | 源可以观察目标的输出 |
| `collaborates_with` | 是 | 否 | 对等协作 |
| `escalates_to` | 是 | 否 | 源把问题上报给目标 |

## 今天（OpenRig 0.1.x）边实际做什么

### 启动排序

只有 `delegates_to` 和 `spawned_by` 影响运行时行为。它们约束节点的启动顺序：

- **`delegates_to`**：源**先于**目标启动。委派者必须在被委派者之前起来。
- **`spawned_by`**：目标（父）**先于**源（子）启动。父必须在它 spawn 的子之前起来。

这个排序在 `PodRigInstantiator`（首次启动）和 `RestoreOrchestrator`（从快照恢复）中都强制。代码对依赖图做拓扑排序——如果有环，实例化失败。

其他所有边（`can_observe`、`collaborates_with`、`escalates_to`）都**不**约束启动顺序。

### 图形可视化

所有边都渲染在 UI 拓扑图里。它们在节点间建立视觉连接，帮操作员理解团队结构。pod 内边出现在 pod 组内；跨 pod 边跨组连接。

### 身份投射

所有边都出现在 `zrig whoami --json` 输出的 `edges.outgoing` 和 `edges.incoming` 下，带种类和对端身份。这让智能体知道它与其他成员的关系——但这信息由智能体自己解读，运行时不强制。

### attach 提示启发式

命令后的交接（`zrig up` 和 `zrig restore` 之后的 "Attach:" 那一行）用边来偏好编排者作为默认 attach 目标。启发式找第一个有 `delegates_to` 出边的节点。

## 今天边不做什么

边目前**不**：

- **路由消息** —— `zrig send` 可以 targeting 任何会话，与边无关
- **强制委派** —— 智能体可以和任何对等方通信，不限于边指向的对象
- **控制权限** —— 没有基于边的访问控制
- **影响传输** —— `zrig capture`、`zrig broadcast` 等基于会话身份工作，不基于边拓扑

这些是愿景中的能力。边词汇刻意比当前运行时行为更丰富，好让拓扑在运行时强制之前就捕捉设计意图。

## 设计意图（为什么是五种）

五种代表了一个工作团队里智能体相互关系的分类：

**`delegates_to`** —— 最常见的边。编排者委派给实现者。首席委派给工人。这是主要工作流方向。当编排者派任务时，它用 `zrig send` 发向它 `delegates_to` 的会话。

**`spawned_by`** —— 用于层级化的启动关系。一个父进程 spawn 出的子智能体。在当前拓扑里较少见。

**`can_observe`** —— 评审/监督关系。评审者观察实现者的工作。评审者可以对实现会话 `zrig capture` 和 `zrig transcript`。这条边传达意图："我在看你的输出。"

**`collaborates_with`** —— 对等关系。两个智能体在层级同一层并肩工作。谁也不委派谁。

**`escalates_to`** —— 委派的反向。当一个工人遇到它做不了的决定时，上报给首席。在当前拓扑里较少见，但代表一种真实的协作模式。

## 选择边种类

### 常见模式

**编排者 → 工人：**
```yaml
edges:
  - kind: delegates_to
    from: orch.lead
    to: dev.impl
```

**评审者 → 实现者：**
```yaml
edges:
  - kind: can_observe
    from: rev.r1
    to: dev.impl
```

**实现对子：**
```yaml
edges:
  - kind: delegates_to
    from: impl
    to: qa
```

### 拿不准的时候

如果你不确定用哪种边：

1. 一个智能体把工作给另一个？ → `delegates_to`
2. 一个观察另一个的输出？ → `can_observe`
3. 它们是平等协作？ → `collaborates_with`
4. 一个向上报告问题？ → `escalates_to`
5. 一个创建了另一个？ → `spawned_by`

都不合适时，`can_observe` 是最安全的默认——它记录了关系，却不暗示工作流方向，也不影响启动排序。

## 校验规则

1. 边种类必须是：`delegates_to`、`spawned_by`、`can_observe`、`collaborates_with`、`escalates_to`
2. pod 内边用不带限定的成员 ID —— `from` 和 `to` 都必须在同一 pod
3. 跨 pod 边用 `pod.member` 格式 —— 两端都必须解析到真实成员
4. 跨 pod 边必须引用不同 pod（同 pod 边应该用 pod 内语法）
5. 自连边在 schema 层不校验，但没有意义
