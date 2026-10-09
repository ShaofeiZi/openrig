---
name: oversight-team
description: 当你是监督 pod 的席位（以持续监控模式运行、负责保持其他工作组健康的工作组）、配置或运行漂移检测器，或决定应介入还是升级时使用。涵盖“拉取而非轮询”的姿态、v0 检测器（premature-park、process-drift、off-task、token-burn）、介入阶梯（orchestrator-ping -> refocus -> human escalation），以及廉价模型 + 深度模型的经济性。不要用于编排自己的工作组（应使用 orchestration-team），也不负责介入原语的具体机制（应使用 watchdog）。
metadata:
  openrig:
    stage: draft
    sibling_skills:
      - watchdog
      - refocus
      - orchestration-team
      - human-in-the-loop
      - messaging-the-human
      - retiring-and-inheriting-a-seat
---

# 监督团队

你位于**监督 pod**——这是一个持续存在的工作组（由智能体管理的基础设施，类似 skills-architect 模式：智能体 + 脚本 + 一份全职负责某项功能的 SOP），职责是保持**其他**工作组健康。你需要尽早发现工作组可能滑入的无效模式——过早暂停、流程漂移、偏离任务和 token 浪费——并用能够奏效的最轻方式纠正。**监控模式：标志触发前保持空闲；绝不要高频轮询。**

## 何时使用

- 你作为监督 pod 的席位，以**监控模式**运行。
- 配置或运行覆盖整个舰队的 v0 漂移检测器。
- 决定应**介入**（orchestrator-ping / refocus）还是**升级**（人类）。

## 何时不使用

- 你正在编排**自己的**工作组——应使用 `orchestration-team`。监督角色横跨多个工作组进行观察，不负责运行它们。
- 你需要介入的**原语机制**（wake / refocus / alignment-checkpoint 栈、`zrig watchdog` 策略、消息结构）——应使用 `watchdog`。
- 只有一个卡住的席位需要恢复——应由其所属编排者或 `watchdog` 处理。

## 姿态——拉取，绝不轮询（关键约束，且适用于自身）

监控模式意味着**在标志触发前保持空闲，触发后再唤醒和检查**，而不是持续观察。连续执行 `zrig capture` / vigilant-observation 循环，正是曾耗尽整个模型账户的反模式：过度观察的观察者成本高昂，却没有产出。**监督席位必须亲自践行它所执行的纪律**——下方 token-burn 检测器存在的原因，正是席位曾陷入 vigilant 循环；高频轮询的监控者会变成自己所捕捉的故障。廉价模型负责读取大范围信息；昂贵的观察者只根据**聚合摘要**行动，绝不接触原始信息洪流。

## v0 检测器（脚本化 + 廉价模型总结）

这些检查成本低、基于证据；每一项都在任何人行动前，从持久证据确认模式：

- **Premature park**——存在进行中的 qitem，但负责人空闲且没有交接。拉取转录记录，确认轮次确实在*没有传球*的情况下结束，而不只是暂时安静。
- **Process-drift**——“什么都不交付”的模式：不产生已交付变更的提交、大量测试迭代、极大/冗长的 qitem、无休止讨论。可以通过 git 历史和队列大小检测。（这是流程压倒产品；应纠正到真正交付。）
- **Off-task drift**——廉价模型对大范围活动（JSONL 转录、stream、git log）生成摘要，只回答一个问题：*“此工作组是否仍在任务上？”* 如果 pod 偏离过久，则介入。
- **Token burn / hypermonitoring**——席位消耗异常：定位 top-N 消费者，捕获并检查 vigilant-loop 模式。**遥测界面注意事项：**v0 检测器使用**时点**消费轮询；**随时间变化的按智能体 token 遥测**属于后续升级——不要假设它存在；在为检测器接线前，应根据当前版本验证可用遥测。

## 介入——从干扰最小的方式开始

1. **Orchestrator-ping**——提醒 pod 自己的编排者重新校准。对方负责运行自己的工作组；你只提示，不接管。
2. **Refocus 原语**——`watchdog` 的 **Refocus** 级别：一种响应式北极星提醒，只在发生**真实**漂移时触发；它重新聚焦角色、已批准工作流与停止条件，且不会中断有效工作或变成新的审批门禁。消息结构与节奏规范见 `watchdog`。
3. **升级给人类**——根据当前模式，通过现有人类路径 / 通知升级。只在智能体级提醒无法修复时使用。

## 禁止事项（纪律）

- **不要高频轮询 / vigilant-loop**——否则你自己就会成为所追踪的 token 浪费。
- **不要夺取另一工作组的任务**——提醒其编排者；监督负责纠正模式，不负责接管。
- **不要对正在积极完成任务的负责人触发 refocus**——那只是官僚表演（也是 `watchdog` 的失败模式）。
- **不要看一眼就介入**——行动前从证据（转录 / git / queue）确认模式。误报会消耗舰队的信任和 token。
- **不要对处于已声明 SWAP WINDOW 中的席位触发 liveness / premature-park 标志。** 正在交接的席位在检测器看来像是空闲/暂停。执行方会在交换开始时预先声明（席位 + 预期窗口）；应把它视为**抑制窗口**，直到交接回执到达（回执只在交换*结束*时到达，因此只等待回执仍会在长时间交换中误报）。参见 `retiring-and-inheriting-a-seat`。

## 廉价模型 + 深度模型的经济性

廉价模型负责常规读取（转录、日志、stream）并聚合智能摘要；昂贵的观察者根据摘要作出决定。这正是按智能体分配模型的重要原因——可以更频繁地执行读取，而不会耗尽账户。设计 pod 时，应让深度模型永远不接触原始信息洪流。

## 另请参阅

- `watchdog`——此 SOP 驱动的介入原语（wake / refocus / alignment-checkpoint）；refocus 位于其中。
- `refocus`——`watchdog` 落实的漂移规范。
- `orchestration-team`——运行自己的工作组（与本 Skill 互补；监督跨工作组观察）。
- `human-in-the-loop` / `messaging-the-human`——升级路径和联系人类的方式。
- `retiring-and-inheriting-a-seat`——上下文阈值检测器可以触发计划中的席位交接（同级监督信号）。
