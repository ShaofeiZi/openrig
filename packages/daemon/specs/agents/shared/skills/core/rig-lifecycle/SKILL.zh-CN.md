---
name: rig-lifecycle
description: 用于分析工作组生命周期操作族（create / start / stop / resume / restore / snapshot / release / unclaim / destroy）、在恢复后读取或判断是否可相信 `zrig ps` / 生命周期投影，或者为生命周期场景设计验证。涵盖 4 种失败模式（自动恢复产生不完整工作组；投影显示的健康程度高于实际；将提供方认证问题误当成实现工作；恢复在一种运行时成功却在另一种失败），以及恢复真实性规则（恢复失败必须明确标记为 FAILED，不能自动回退为全新启动）。
metadata:
  cli_surfaces_referenced:
    - destroy
    - down
    - ps
    - release
    - restore
    - restore-check
    - resume
    - snapshot
    - unclaim
    - up
  openrig:
    stage: factory-approved
    sibling_skills:
      - topology-mutation-and-seat-management
      - seat-scaling-and-specialization
      - cross-host-rig-commands
      - sidecar-operator
      - rig-bundles-and-shareable-artifacts
      - specification-system
      - extension-and-user-workspace
---

# 工作组生命周期

这一操作族负责**创建、启动、停止、继续、恢复、创建快照、释放、取消认领和销毁**由 zrig 管理的拓扑。它也涵盖重启后的用户诉求：**“把我的工作恢复回来，同时不要让一次本应干净的恢复变成清理工程。”**

生命周期一旦脆弱，所有更高层原语都会继承这种脆弱性。队列、工作流、席位连续性、跨主机操作和 RSI 都以工作组与席位能够恢复到已知状态为前提。

## 适用场景

- 操作 `zrig up / down / restore / resume / snapshot / release / unclaim / destroy`
- 在重启或恢复后读取 `zrig ps`，并判断哪些信息可信
- 为生命周期场景设计验证（干净启动 / 热恢复 / 主机重启 / 提供方认证丢失 / 部分启动 / 操作员恢复）
- 分析恢复结果语义（`resumed` / `rebuilt` / `fresh` / `failed` / `attention_required`）
- 审计生命周期验证究竟只是进程内基础证据，还是还需要真实重启证据

## 不适用场景

- 操作只有单条命令且结果确定——CLI 用法请使用 `openrig-user` skill
- 工作内容是 zrig 自身的操作员级配置——使用 `openrig-operator`
- 工作内容是编写工作组 spec——使用 `openrig-architect`

## 失败模式（4 种）

1. **自动恢复创建了一个只恢复了一部分的工作组，而真正恢复前还必须先清理它。** 部分恢复看起来像恢复成功，其实并非如此；结果真正的工作负担变成了“恢复前先清理”。
2. **`zrig ps` 或生命周期投影报告的状态比运行时实际状态更健康。** 投影只是摘要，运行时才是真相。不要默默相信投影。
3. **重启后无法使用提供方认证，系统却将它当作实现工作，** 而不是需要人或环境决策的问题。认证问题属于环境问题，应交给人处理。
4. **恢复在某个运行时或提供方上成功，却在从未测试过的另一场景中失败。** 不同运行时之间的等价性假设会悄悄失效；矩阵验证能发现这类问题。

## 恢复真实性规则（关键约束）

**恢复失败必须明确显示为 FAILED。** 不得自动回退到全新启动。全新启动只能作为**显式的后续操作**。这一规则由后台服务架构强制执行（见 `architecture.md` §7 规则 15）。

锁定的恢复结果词汇如下：

| 结果 | 含义 |
|---|---|
| `resumed` | 原生运行时继续了同一个对话 |
| `rebuilt` | 根据产物组装了新进程（`session_source: mode: rebuild`） |
| `fresh` | 不带任何先前连续性的全新进程 |
| `failed` | 已尝试恢复但失败；不会自动回退 |
| `attention_required` | 可恢复的阻塞项（例如提供方拒绝认证）；需要操作员处理 |
| `n-a` | 不适用（例如 terminal 节点） |

Codex 拒绝认证时返回 `attention_required`（可恢复）；Claude 的 `looksLikeClaudeLoginPrompt` 返回 `failed/login_required`（终止状态）。不同运行时如何对齐仍是待跟进问题。

## 验证标准

生命周期验证应包含**真实重启或 VM 重启证据**，而不应只有后台服务单元级证据。最低限度的有效矩阵包括：

| 场景 | 验证内容 |
|---|---|
| 干净启动 | 从 spec 启动到已知状态 |
| 热恢复 | `zrig down` → `zrig up <name>` 后席位继续运行 |
| 主机重启 / tmux socket 缺失 | 从 tmux 连接丢失状态恢复 |
| 提供方认证丢失 | 如实处理 Codex/Claude 拒绝认证 |
| 部分启动 / 部分失败 | 一些席位已启动、另一些失败，并如实报告 |
| 操作员主动恢复 | 操作员从快照发起恢复 |

第 1 层是进程内基础验证（后台服务单元级证据）；第 2 层是真实重启或一次性 Tart VM。只有第 1 层并不能证明生命周期，只能证明其基础。

## 默认策略是原语的一部分

**把默认策略视为原语的一部分，而不是事后补充。** 如果生命周期默认值比实际已经证明的可靠性更乐观，就会造成隐性伤害：

- `auto-restore` 默认值掩盖失败模式
- 隐式全新回退隐藏恢复失败
- 宽松验证无法区分真实成功与“看似可用”

## 全主机恢复产品阶梯 v2

该阶梯将恢复事实分成**四级**：

- `fully_restored` 是**第 3 级执行汇总**
- “fully back” **仅保留给第 4 级**

命名纪律很重要。“Fully restored”和“fully back”代表不同断言，不要混为一谈。

## 另请参阅

- `openrig-user` skill——`zrig up / down / restore / etc.` 的 CLI 用法
- `openrig-operator` skill——zrig 自身的操作员级规范
- `seat-continuity-and-handover` skill——恢复时用于创建占用者的子原语（`resume` / `rebuild` / `fresh` / `failed`）
- `session-source-fork` skill——基于 fork 恢复的 `forked` 连续性结果
- `permission-and-capability-preflight` skill——提供方认证阻塞项的升级路径
- `openrig/docs/as-built/architecture/lifecycle-snapshot-restore.md`（产品参考文档）——后台服务对恢复真实性规则的强制执行
