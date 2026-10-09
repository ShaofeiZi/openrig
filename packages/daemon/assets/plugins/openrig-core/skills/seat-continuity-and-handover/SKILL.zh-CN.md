---
name: seat-continuity-and-handover
description: 在更换席位任职者（rebuild/handover/swap）、分析稳定席位身份与流动任职者身份、选择旧任职者处置方式（retire/advise/shadow），或记录任职者变更来源时使用。包含两个独立结果（continuityOutcome + seatBindingOutcome）以及防止静默失真的 5 种失败模式。
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - retiring-and-inheriting-a-seat
      - agent-startup-and-context-ingestion
      - agent-starters
      - composable-priming-packs
      - session-source-fork
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# 席位连续性与交接

两类原语用于区分“谁坐在席位上”和“席位本身是什么”：

1. **任职者创建原语**——`resume`、`fork`、`rebuild`、`fresh`——生成候选新任职者，回答：“新任职者从哪里来？”
2. **席位绑定操作**——handover 将候选任职者绑定到拓扑中，回答：“稳定席位身份发生了什么？”可执行操作请查看当前 CLI；只有设计词汇不能确立命令。

核心架构决策：**席位身份稳定、任职者身份流动、来源明确。**不要把连续任职者编码进实时席位名称。保留稳定地址，单独记录谱系。

## 适用场景

- 通过 rebuild、fork、fresh 或 seat-handover 更换席位任职者
- 选择旧任职者处置方式：retire / advise / shadow
- 分析席位谱系是稳定还是已漂移
- 读取或写入席位来源记录
- 设计或审计任职者变更前后的拓扑稳定性

## 不适用场景

- 席位是全新创建的（没有要替换的任职者）——直接使用 `zrig launch` / `zrig expand`
- 目标是改变拓扑形态（添加/删除席位），而非替换任职者——使用 topology-mutation 原语

## 双结果诚实模型

每项席位绑定操作都会产生两个**相互独立**的结果：

```yaml
continuityOutcome: rebuilt | resumed | forked | fresh | failed
seatBindingOutcome: handed_over | partial | failed | unchanged
```

两者可以如实地不一致。例如：

- `continuityOutcome: failed` + `seatBindingOutcome: unchanged`——新任职者未创建成功；席位正确保留旧任职者。
- `continuityOutcome: rebuilt` + `seatBindingOutcome: failed`——候选者成功创建；绑定在中途失败；来源记录会记下缺口。

**不要把两者合并成一个结果。**只有分别记录，系统才能描述实际发生的事情。

## 来源记录（持久、可查询）

每次 handover 都会写入：

- seat id
- old occupant id
- new occupant id
- 创建模式（`resume`/`fork`/`rebuild`/`fresh`）
- 使用的源制品
- 旧任职者是否继续作为 advisor/shadow 存活
- 发起变更的 operator 或 loop
- timestamp
- 结果（`handed_over` / `partial` / `failed`）

这是系统回答“当前任职者如何到达此处”的事实来源。缺少它时，控制平面只能显示当前任职者，无法说明转变是否合法。

## 状态模型——相互独立

### 任职者创建状态（逐候选者）

1. **Requested**——rebuild/fork/fresh/resume 的输入
2. **Realized**——运行时/制品路径生成了符合托管席位形态的任职者
3. **Failed**——候选者未创建成功；`continuityOutcome: failed`

### 席位绑定状态（逐席位）

1. **Stable**——当前任职者已关联，没有进行中的绑定
2. **Binding**——handover 正在进行
3. **Bound**——handover 成功；来源记录已写入
4. **Unchanged**——绑定在完成前失败；席位保留旧任职者

即使生成并丢弃了多个候选任职者，席位仍保持 `Stable`。

## 失败模式（5 种）

1. **候选者创建失败**——`rebuild` 无法从制品合成；`fork` 无法解析 `session_source`；`fresh` 无法启动。**操作：**不开始绑定；席位保持不变；来源记录写下失败的候选者创建步骤。
2. **无法干净分离旧任职者**——运行时挂起、tmux 锁定等。**操作：**绑定在中途停止；席位进入带明确“halted”子状态的 `Binding`；提醒 operator。**如果 detach 未干净完成，绝不要通过重新关联旧任职者自动回滚。**
3. **绑定成功但来源写入失败**——磁盘/数据库错误。**操作：**来源写入前不算持久；应视为 `Binding` halted，而不是 `Bound`。
4. **无法满足旧任职者处置方式**——operator 请求 `advise`（保留旧任职者作为顾问），但运行时无法让其继续存活。**操作：**降级为 `retire` 并明确通知；若 operator 传入 strict-disposition flag，则失败。
5. **并发 handover 尝试**——两个操作针对同一席位。**操作：**使用 seat-id 锁序列化；第二次尝试应拒绝并返回明确错误。

## 硬性边界（禁止事项；逐字遵守）

- **不要把 `rebuild` 和 `seat handover` 合并为一个原语。**设计刻意将两者分开，让系统能够描述实际发生的事情。
- **不要引入带继任者后缀的席位名称**（`lead2`/`lead3`）。稳定席位身份是架构目标。实时地址保持稳定。退役任期通过 ledger generation 和确切 history token 区分；保留它不需要重命名实时 pane。
- **来源记录未持久写入时，不要报告 `seatBindingOutcome: handed_over`。**
- **不要通过重新关联旧任职者来自动回滚半完成的 handover**，除非 detach 先干净完成。

## 组合方式和当前命令界面

fork 可以创建候选任职者；handover 将其绑定到既有席位。连续性结果为 `forked`；绑定结果独立记录。

打包随附的 `zrig handover <seat>` 和 `zrig seat handover <seat>` 接受 `fresh`、`discovered:<id>`、`fork:<id>` 和 `rebuild` 来源。使用 `--dry-run` 仅请求规划。不带该参数时，这些界面可能执行实际操作；不要因为较短席位命令的说明偏向规划，就推断它只读。`zrig seat status <seat>` 是只读可观察界面。

来源支持由正在运行的后台服务声明，并取决于真实身份、历史与制品前置条件。应分别阅读返回的 source、continuity、binding 和 provenance 结果。help 列表或 dry-run 不能证明转变成功。只有具名所有者授权后，才可使用所链接的切换 SOP；该 SOP 提供 operator 操作步骤和必需的效果检查。

## 为什么它是 RSI 的承重结构

任何递归席位刷新循环都必须能够在保持拓扑稳定的同时替换任职者。没有这些原语，RSI 循环要么不断累积带后缀的席位名称（谱系泄漏进身份），要么在每个周期破坏拓扑引用的稳定性。来源必须持久且可查询，RSI 循环才能判断席位是否足够新，可以接收新工作，或需要再次 handover。

## 托管绑定与保留历史

已退役 advisor 的历史可以保留，而无需托管节点或实时 pane。分别查询当前绑定和谱系 ledger：前者回答谁持有席位，后者识别保留的历史及确切 resume token。不要仅因 registry 中没有记录就推断无法联系前任，也不要认为保留 token 就证明 resume 成功。需要咨询时，检查实际运行时和历史；参阅 `retiring-and-inheriting-a-seat`。

## 另请参阅

- `references/apprentice-successor-seat-cutover.md`——只在满足所有者措辞的门禁后使用的可移植操作 SOP
- `references/orchestrator-role.md`——编排判断、权限、托管和回执契约
- `references/apprentice-evidence-toolkit.md`——仅在风险确实值得时选用的可选证据机制
- `session-source-fork` skill——`fork` 任职者创建原语（同级 skill）
- `agent-starters` skill——将任职者创建 + 绑定组合成具名、可复用起点
- `cross-host-rig-commands` skill——远程寻址和传输；应验证目标上的生命周期支持
