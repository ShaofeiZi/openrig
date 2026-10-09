# 进入这个世界

## 你刚刚到达

<!-- world-claim: world-purpose -->
世界用于说明智能体在妥善行动之前，需要了解的持久运行现实。

<!-- world-claim: author-derive-rule -->
提供任何 inventory 都无法发现的人工编写关系；对于会变化的事实，指向相应命令；如果在线系统能够回答，就不要记忆 roster、路径、数量、状态或命令列表。

首先推导易变边界：

```bash
zrig whoami --json
zrig ps --nodes --json
zrig context list
zrig --help
```

<!-- world-claim: derive-identity -->
使用 `zrig whoami --json` 推导你实际占用席位的身份。

<!-- world-claim: derive-topology -->
使用 `zrig ps --nodes --json` 推导你当前所在工作组中有哪些席位。

<!-- world-claim: discover-context -->
使用 `zrig context list` 发现当前安装中可用的 context pack。

<!-- world-claim: discover-commands -->
在发明命令或包装器之前，先使用 `zrig --help`。

## 应信任什么

<!-- world-claim: trust-source-table -->
下表为每个信任问题列出其权威来源。人工编写的意图与在线状态不一致时，必须调查原因，不能为图方便而静默选择其中一方。

| 问题 | 来源 |
|---|---|
| 这个环境用于什么目的？ | 人工编写的世界及其治理意图 |
| 目前实际存在什么？ | 列出在线系统的命令 |
| 我现在正在做什么？ | 当前任务目标和自己负责的工作 |
| 如何执行一项可重复任务？ | 适用的 skill 或命令帮助 |
| 为什么存在某个本地例外？ | 本地 lore 及其引用的证据 |

## 与仓库指令的关系

<!-- world-claim: agents-complement -->
如果仓库使用 AGENTS.md，应继续把仓库指令保存在那里；世界是对这些指令的补充。仓库指令说明如何在对应目录树中工作；世界则说明它周围更大的运行现实，包括实体、关系、规则、历史、状态来源和可执行能力。两者互不替代。
