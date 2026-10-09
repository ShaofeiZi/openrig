---
name: session-compaction-and-restore
description: 在分析压缩/上下文丢失/重启/席位刷新后哪些内容能够保留、设计高保真恢复 packet，或区分原生运行时 resume、fork 与由产物支持的心智模型重建时使用。涵盖妨碍诚实恢复的 4 种失败模式：压缩后的席位丢失正在传递的工作；恢复 packet 保留细节却丢失产品意图；把运行时 resume 误认为 handover 或 fork；重建后的席位从过时指令开始。
metadata:
  cli_surfaces_referenced:
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - agent-startup-and-context-ingestion
      - agent-starters
      - composable-priming-packs
      - session-source-fork
      - seat-continuity-and-handover
      - retiring-and-inheriting-a-seat
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# 会话压缩与恢复

跨越**上下文压缩、上下文丢失、重启或席位刷新**，保存仍有用的工作状态。涵盖 Claude 压缩恢复、Codex resume/fork 机制、基于 transcript 的心智模型重建，以及持久交接 packet。

**长寿命席位只有在能够承受上下文压力时才有价值。**如果压缩会把资深席位变成从冷启动开始的智能体，用户就会避开持久拓扑，重新使用一次性智能体。

## 适用场景

- 席位即将进行上下文压缩，或刚刚完成压缩
- 为活动工作流设计高保真恢复 packet
- 区分原生运行时 resume、fork 和由产物支持的心智模型重建
- 判断哪些内容应保留，哪些内容可以重建
- 审计恢复过程是否保留产品意图，而不只是细节

## 不适用场景

- 会话刚刚开始，没有需要保留的工作状态
- 目标是从预置来源*创建*新席位——这种情况使用 `session-source-fork` 或 `agent-starters`
- packet 只是供人类评审的一次性快照——恢复 packet 用于重新进入进行中的工作

## 5 项区别（不得混为一谈）

根据跨运行时恢复/重新进入 packet 标准：

| 模式 | 含义 | 结果字面值 |
|---|---|---|
| **Native resume** | 使用原生运行时 token 继续同一个托管席位 | `resumed` |
| **Fork** | 从此前的原生运行时对话创建新的托管席位；fork 后使用新 token | `forked` |
| **Rebuild** | 全新启动，并按信任优先级注入操作方声明的产物 | `rebuilt` |
| **Artifact-backed mental-model rebuild** | 恢复后的席位根据 packet 建立理解，而不依赖原生运行时连续性 | 属于 `rebuilt` |
| **Fresh launch** | 不带任何先前连续性的新智能体 | `fresh` |

这些区别会直接影响行为。**不得把 `fork` 混同于由产物支持的重新进入，也不得把 `rebuild` 混同于 fork。**

## 三种机制——各自由谁负责（已对照 main d37a08ad 验证，2026-07-21）

以上结果基于三种**彼此独立**的机制，必须保持区分：

1. **Claude 内置 `/compact`**——这是 Claude Code **harness 功能**，**不是 zrig 代码**。zrig 只会在准备 turn 完成后，向 pane 发送字面量 `/compact`；zrig 仓库中没有压缩算法。该机制由 provider 负责。
2. **zrig 托管恢复**——由 enforcer 和 hook bridge 组成：precompact hook **写入**恢复 packet；bridge **读取器**通过 harness hook channel（`hookSpecificOutput.additionalContext`）准确注入**一条**恢复指令，并按席位隔离。这一半由 zrig 负责。
3. **Codex 会话连续性**——resume/rollout token（`codex resume <token>`），与 Claude 的机制是不同路径。绝不能与 Claude 恢复混为一谈。

**安全边界（与 `native-session-file-lab-boundary` 相连）：**zrig 没有任何受支持路径会编辑 provider 拥有的原生**会话、认证或 transcript**文件来注入上下文。上下文只能通过受支持渠道进入：hook 的 `additionalContext`、经 `zrig send` 发送的普通用户消息，或 Codex resume token。需要准确理解的一点是：zrig 的确会写入 `~/.codex/config.toml`，但仅用于安装 zrig 活动 **hook** 和 `[features]`，绝不会修改会话或认证状态。因此，规则是“绝不编辑原生会话/认证/transcript 文件”，而不是“绝不接触任何 provider 拥有的文件”。

## 当前 CLI 界面（操作方 / kernel 席位；已对照 main d37a08ad 验证）

托管压缩/恢复由五个已发布动词驱动。按意图选择，并始终坚持持久底层优先：packet/产物才是真实依据，CLI 只是触发器。

- **`zrig compact <session>`**——对**一个** Claude 席位执行引导式托管压缩（准备 → `/compact` → 恢复 → 审计）。非 Claude 席位会被拒绝。约需 180 秒。
- **`zrig compact-plan`**——**只读**分流；*不会执行压缩*。flag 包括 `--rig`、`--refresh`、`--threshold-tokens`、`--threshold-percent`。（Codex 席位会标记为 `codex_not_managed_by_claude_compact_in_place`。）
- **`zrig restore-check`**——跨运行中工作组执行恢复就绪探测；只读；退出码为 0/1/2。flag 包括 `--full`、`--ready`、`--rig`、`--no-queue`、`--no-hooks`。
- **`zrig restore-packet {write,read,validate}`**——跨运行时恢复 packet（v0）：写入、读取或验证本 skill 契约定义的持久 packet。
- **`zrig restore <snapshotId> --rig <rigId>`**——⚠ **工作组快照**恢复（基础设施），属于**不同机制**，不是会话上下文恢复。不要混淆。

## 失败模式（4 种）

1. **压缩后的席位忘记活动工作流状态，并丢失正在传递的工作。**没有连续性保护的压缩是一种静默失败。
2. **恢复 packet 保留了细节，却丢失用户的产品意图。**恢复必须保留*这项工作为何重要*，而不仅是*刚才在做什么*。
3. **运行时 resume 被误认为席位 handover 或 fork。**三者的连续性结果和来源信息不同，不得混淆。
4. **重建后的席位从与当前工作流模式冲突的过时指令开始。**恢复内容必须包含当前状态，而不只是历史状态。

## 证明标准

证明应包含对有活动工作的席位进行一次有意的压缩/重启，然后执行**可度量的恢复**：无需人类重新说明，即可恢复身份、当前工作流、下一位 owner、相关文件和约束。

## 规范 packet 契约（16 个字段，v0）

跨运行时恢复/重新进入 packet 标准 v0 定义：

- 来源/目标身份
- 运行时
- 工作区根目录、默认仓库、角色指针
- 有边界的最新 transcript
- 已触及路径 inventory
- 持久工作指针
- 当前工作与下一位 owner
- 注意事项与权限边界
- 省略类别与脱敏策略
- 来源信任排序
- 生成时间与生成器版本

此外还包含 6 项恢复后席位验收清单。

恢复后的席位接收 packet 证据时，来源信任排序如下：**`zrig whoami` > 目标 rigspec > 有边界的最新 transcript > 完整 transcript > touched-files > `restore-summary.json`。**

## 恢复时使用的记忆界面

恢复可能会读取 transcript、持久消息、启动上下文、checkpoint 和恢复 packet。应盘点当前席位实际存在的界面，以及每个界面的来源、新鲜度和用途。不要因为某个界面有名称，就推断它一定存在或授予写权限。

活动项目/工作组策略和任务授权决定哪些内容可以写入。将 provider 拥有的对话记录视为证据，并通过受支持工具读取。需要了解内容放置和持久上下文时，用 `zrig context get` 加载 `skills/openrig-operating-model/SKILL.md`；针对所选启动路径，使用 `skills/core/agent-startup-and-context-ingestion/SKILL.md`。packet 或 marker 只能证明证据被保留/交付，不能证明 provider 恢复成功；应按上述证明标准实际度量 resume 后的席位。

## 另请参阅

- `claude-compaction-restore` skill——Claude Code 恢复 SOP（PreCompact hook + JSONL 恢复脚本，用于上下文压缩后恢复）
- `mental-model-ha` skill——HA pair 的上下文压缩恢复（不同场景；姊妹原语）
- `session-source-fork` skill——基于原生运行时连续性恢复的 `fork` 模式
- `seat-continuity-and-handover` skill——本原语所实例化的席位占用者创建原语（resume/fork/rebuild/fresh）
- `openrig-operating-model` skill——持久上下文的放置方式与权威归属
