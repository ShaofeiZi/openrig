---
name: human-in-the-loop
description: 用于对切片收口分类（auto-continue / human gate / park）、把真实决定路由给人类，或设计人类队列/仪表板界面。它把人类视为拥有待关注界面、队列和决定记录的持久网络参与者——升级事项会落为持久待关注条目，而不是聊天消息。每次干净收口都不需要审批；除非遇到显式人工门禁，默认 RSI 流水线会继续运行。
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - queue-handoff
      - workflow-runtime
      - watchdog
      - refocus
      - looping-workflows
      - intake-routing
      - attention-queue
      - dispatching-parallel-agents
      - subagent-driven-development
      - control-plane-capabilities
      - status-not-chat-orchestrator
      - control-plane-queue
      - control-plane-watchdog
      - control-plane-workflows
      - control-plane-delivery-loop
      - control-plane-rollout-manager
---

# 人工介入

此原语把人类视为**持久网络参与者**——具有待关注界面、队列、决定记录和路由语义——而不是临时聊天接收者。

**自主不等于没有人类参与；自主是知道何时需要人类判断，并让这次交接清晰准确。**

## 何时使用

- 切片收口需要分类：自动继续、人工门禁或暂停。
- 真实决定需要呈现给人类（用量限制、提供方身份验证、roadmap 权衡、产品意图歧义）。
- 设计人类队列/仪表板界面。
- 人类批准后，将烫手山芋交还编排流程。

## 何时不使用

- 切片干净收口，且 `PROGRESS.md` 已经指定下一个安全切片。**默认 RSI 流水线会继续；不要人为制造人工门禁。**
- 升级事项只是状态更新。人类参与的是*决定*，不是过程解说。
- 下一负责人是另一智能体。使用 queue-handoff，而不是 human-in-the-loop。

## 三类收口分类

在产品化、由后台服务支持的版本中，收口应在触及人类队列**之前**完成下一步分类：

| 类别 | 适用情形 | 行动 |
|---|---|---|
| **auto-continue** | 切片干净收口，工作流计划中已指定下一个切片 | 标记关闭；根据计划创建下一负责人的 qitem |
| **human gate** | 需要真实决定（用量限制、提供方身份验证、产品意图歧义、roadmap 权衡） | 创建人类队列项，包含证明、决定文本、推荐默认项和各行动结果 |
| **park** | 有意停止流水线（例如等待外部条件） | 携带原因与恢复路径停止 |

## 五种失败模式

1. **需要人类决定，但工作组只在聊天中提及。** 决定应成为持久待关注条目，而不是聊天消息。
2. **人类队列项缺少足以决策的普通语言上下文。** 应包含证明、决定文本、推荐默认项和各行动结果。
3. **人类响应更新了文件，却没有唤醒下一负责人。** 批准应把烫手山芋交还；反馈应创建下一条持久 qitem。
4. **仪表板展示太多原始工作组状态，掩盖真正的决定队列。** 决定队列是主要界面；工作组状态是次要信息。
5. **即使 `PROGRESS.md` 已经指定下一个安全切片，干净收口仍被暂停并交给人类。** 不要人为制造人工门禁。

## 证明标准（两条路径）

可信的人工介入系统必须证明两个方向：

- **阻塞门禁路径：** 真实条目路由给人类 → 人类通过 UI 记录决定 → 由此产生的烫手山芋交接唤醒正确的下一负责人。
- **非阻塞收口路径：** 人类可以检查证明，但编排者继续进入下一个具名切片，不人为制造人工门禁。

只会唤醒人类的原语不可信。它还必须知道何时**不应**唤醒。

## 产品形态（已交付——Mission Control，PL-005）

此界面已作为 **Mission Control** 交付（产品 UI，路由 `/mission-control`；行动通过 `POST /api/mission-control/action`）。人类可使用七个动词：

- **approve**（将烫手山芋交还编排流程或选定负责人）
- **deny**（拒绝条目）
- **route**（发送给另一负责人）
- **annotate**（只添加上下文，不执行行动）
- **hold**（携带原因有意暂停）
- **drop**（标记为不可行动）
- **handoff**（交给指定的下一负责人——创建下一条持久 qitem）

**批准会将烫手山芋交还编排流程或选定负责人；反馈会创建下一条持久 qitem，而不只是修改源队列文件**——这一点由已交付动词强制保证（handoff/route 会创建 qitem）。参见 `docs/as-built/architecture/mission-control.md`。

## 长期形态

系统可能需要**多个拥有不同工作范围的人类**，而不是单一的人类待关注 feed。不同人类负责不同决定域；队列项按工作范围路由。

## 另请参阅

- `queue-handoff` Skill——通过队列项持久交接；human-in-the-loop 是其人类侧补充。
- `watchdog` Skill——何时唤醒（包括人类），何时不采取行动。
- `looping-workflows`（约定）——该约定涵盖循环收口；human-in-the-loop 是逃生口。
