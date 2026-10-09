---
name: queue-handoff
description: 用于结束轮次、完成切片、被另一智能体的工作阻塞或升级给人类——通过队列项持久交接工作，使系统能够跨越上下文压缩、遗漏消息与中断继续运转。涵盖“烫手山芋”轮次终止规则（活跃工作以传球结束，而不是进入空闲）、默认 nudge 语义，以及何时应为有意冷暂停或人工门禁使用 `--no-nudge`。
metadata:
  cli_surfaces_referenced:
    - queue
    - queue create
    - queue handoff
    - queue handoff-and-complete
  openrig:
    stage: factory-approved
    sibling_skills:
      - workflow-runtime
      - watchdog
      - refocus
      - looping-workflows
      - intake-routing
      - human-in-the-loop
      - dispatching-parallel-agents
      - subagent-driven-development
      - structured-ack-dispatch
      - control-plane-capabilities
      - status-not-chat-orchestrator
      - control-plane-queue
      - control-plane-watchdog
      - control-plane-workflows
      - control-plane-delivery-loop
      - control-plane-rollout-manager
---

# 队列交接

通过队列项持久交接工作。它会把任务继续传递下去，使系统能够跨越上下文压缩、遗漏消息与中断持续推进，而不会让工作停留在聊天或无人负责的进行中状态。

## 何时使用

- **结束实质性工作的轮次。** 活跃工作应通过把任务传给具名负责人或人类来结束；绝不能进入空闲，让工作组看似休眠。
- **完成拥有明确下一步的切片。** 默认 nudge：接收者会同时获得唤醒提示和持久队列项。
- **被另一智能体的工作阻塞。** 使用 `closure_reason: blocked_on` 和阻塞 qitem ID 暂停该 qitem。
- **升级给人类。** 把升级创建为持久待关注条目，而不只是聊天消息。

## 何时不使用

- 工作确实完成且没有后续负责人。使用 `closure_reason: no-follow-on`（终态完成），或按需使用 `canceled` / `denied`。
- 交接粒度太小，会把工作变成官僚流程。应将工作组合成连贯切片，而不是拆分每个步骤。
- 交接范围太宽，会丢失负责人、证明或关闭标准。应调整 qitem，使接收者明确下一行动和关闭证据。

## “烫手山芋”轮次终止规则

活跃工作应把任务交给具名的下一负责人或人类后才结束。qitem 状态机强制执行此规则：

`pending → in-progress → done` 要求 `closure_reason` 为以下之一：

- `handed_off_to`——工作在另一席位继续（target = 新负责人）。
- `blocked_on`——暂停并等待另一 qitem（target = 阻塞 qitem ID）。
- `denied`——接收者拒绝工作。
- `canceled`——发送者或接收者撤回。
- `no-follow-on`——终态完成，无其他事项。
- `escalation`——升级到更高层级（target = 升级目标）。

其中三种（`handed_off_to`、`blocked_on`、`escalation`）还要求 `closure_target`。后台服务在领域层强制此规则；所有界面（CLI、MCP、未来 UI）都继承同一保证。

**只起草未发送就是暂停（draft ≠ throw）。** 规则关注的是*实际*传递，而不是传递意图。轮次结束时，如果你只在自己的提示符中**输入却没有发送**一条自我指令——例如起草了一句继续执行的指示，或没有发出的下一原子事项——就**没有**完成交接；这实际是**暂停**，席位会持续空闲，直到有人发现。起草交接看起来像完成了交接，但事实并非如此。**轮次的最后行动必须是 EDIT 或 SEND**——已提交变更、`zrig send`、`zrig queue` 交接——**绝不能是在缓冲区留下未发送的提示文本。** 如果最终输出是发给自己的指令，你不是结束了轮次，而是让它停滞。

**派发者的另一半职责——被取代时关闭自己的发件箱。** 干净结束轮次只是规则的一半；另一半发生在*你*改变世界时。**如果阶段转换或 fold 回执使你已派发的工作失效，应由你自己关闭这些派发项，并引用取代它们的事件。** 因取代而关闭属于**派发者**，绝不属于接收者。养成习惯：每次收到 fold 回执或发生阶段转换后，执行一次**发件箱审计**——“这刚刚使我的哪些未关闭派发项失效？”——并附引用关闭它们。

*为什么这必须由你负责：*过时派发债务对派发者**不可见**，因为它进入了别人的队列——成本被外部化，因此不会形成迫使你清理的反馈循环。接收者继承了并非自己制造的债务，在能够安心等待前必须花费周期核实；充满过时 pending 的队列会让最需要低成本的“等待前检查”变得昂贵，也会降低空闲检测器的信号质量（真正的负责人看起来与过时派发相同）。应在源头关闭：你自己的转换使它失效时立即处理。

**交接后应主动拉取，不要守着有库存的队列空闲。** 传出接力棒会结束*顺序*线程；如果自己的队列仍有工作，它不会结束*你的*轮次。循环模式是：完成 → (1) 交出接力棒，让顺序工作继续 → (2) **检查自己的队列并拉取下一项**，而不是进入空闲 → (3) 只有自己的队列**已清空**时，才真正进入空闲并等待接力棒。坐在有库存队列上空闲的智能体，是最大的利用率漏洞（参见 `orchestration-team` → “队列深度是编排者的产品”）。这是席位级 pull-not-push，无需新机制——交接后的最后行动是一次**拉取**。

## 默认 nudge 语义（语法陷阱）

| 命令 | 默认 nudge？ | 何时使用 |
|---|---|---|
| `zrig queue create` | 是 | 从头创建新 qitem |
| `zrig queue handoff` | 是 | 事务式关闭为已交接并新建条目 |
| `zrig queue handoff-and-complete` | 是 | 原子关闭并新建；默认 nudge 会唤醒新负责人 |

**陷阱：**在实时循环交接中意外加入 `--no-nudge`。已交付的 0.3.1 CLI 会在每个队列写入界面（`zrig queue create`、`zrig queue handoff` 和 `zrig queue handoff-and-complete`）默认执行 nudge。唯一的抑制 flag 是 `--no-nudge`——它适用于有意冷暂停、人工门禁信号或刻意由轮询驱动的工作流，但**不适用于**需要保持流动的实时循环交接。

**规则：**在实时循环中省略 `--no-nudge`，信任默认行为。`--no-nudge` 是选择退出，不是选择加入。如果准备使用 `--notify`，请停下——已交付的 0.3.1 CLI 不存在该 flag；你可能正在遵循颠倒了默认 nudge 极性的旧说明。

## 队列正文卫生（token 与解析安全）

qitem 正文是由后台服务存储，并在每次 `zrig queue show <id>` / `--json` 读取时重放的持久**数据**。保持精简且便于解析——臃肿或格式错误的正文会让每位未来读者付出代价，不只是接收者。

- **正文中不要放大型命令输出。** 不要把 `zrig ps` / `--nodes` 输出、大型 JSON、完整证明输出、diff 或转录片段粘贴进 qitem 正文。应**链接产物路径**（例如 `missions/<m>/<slice>/proof.md`），或使用文字总结后指向详细文件。粘贴的大型输出会让 `zrig queue show <id> --full --json` 变得庞大。紧凑默认值只限制预览；存储的正文仍会让需要读取全文的人承担成本。证据应留在持久产物中。
- **实质性正文使用 `--body-file`，不要内联 `--body`。** 超过简短单行的内容应写入文件，并传入 `--body-file <path>`（或使用 `-` 表示 stdin）。带 shell 元字符的内联 `--body` 很脆弱。
- **正文中不要直接使用反引号。** 内联正文中的反引号会触发 shell 命令替换，从而破坏 payload（甚至执行命令）。需要代码/命令片段时使用 `--body-file`，或去掉反引号并以纯文本写命令。

经验法则：如果想包含的内容超过几行，或带有 shell 元字符（反引号、`$`、引号、含管道的新行），它应放在被**链接**的文件中，而不是粘贴进正文。

当前 `zrig queue show` 默认返回有边界的正文预览；`--full` 返回完整正文与链字段。预览截断不会截断存储的工作。检查 `bodyTruncated` 与 `bodyBytes`，需要时再请求完整内容；大型支持证据应留在链接产物中。

## 六种失败模式（原义要求）

1. 智能体没有交接就结束轮次，使工作组看似空闲。
2. 智能体在实时循环中使用 `--no-nudge` 创建队列项，本想抑制关注，却破坏了立即流转。`--no-nudge` 用于有意冷暂停 / 人工门禁，不用于常规实时循环交接。相反的陷阱是添加已交付 0.3.1 CLI 中不存在的 `--notify` flag，这来自过时说明；默认行为已经会 nudge。
3. 队列项太小，把工作变成官僚流程。
4. 队列项太宽，丢失负责人、证明或关闭标准。
5. 人类升级只发生在聊天中，没有成为持久待关注条目。
6. 智能体把大型命令输出（ps/nodes、大型 JSON、证明 blob）粘贴进 qitem 正文，使存储的数据膨胀，每次全文读取都很大。应链接证明路径或用文字总结；实质性正文通过 `--body-file` 提交；不要内联原始反引号。

## 持久交接字段结构

每个 qitem 携带：

- `handed_off_to`——目的地会话（限定形式 `pod-member@rig`）。
- `handed_off_from`——前序 qitem ID（源会话位于 `source_session`）。
- `state`——以下之一：`pending | in-progress | done | blocked | failed | denied | canceled | handed-off`。
- `closure_reason` + `closure_target`——根据“烫手山芋”规则在终态关闭时设置。

**（0.5.0）`--body-context <ref>`——让上下文随交接传递。** `zrig queue create … --body-context <ref>` 会把组合后的上下文包附加到 qitem。快照规则是：qitem 在正文中保存**解析后的内容**，并同时保存用于追踪来源的 ref——交接携带的是实际发送内容；后来编辑库内容，绝不会静默改写过去的交接历史。（`zrig context` 名词负责组合 ref；queue 负责交付——context 名词本身没有 send。）参见 `openrig-user` 的“上下文包与分步投递”。

这些字段可以在后台服务支持的 `zrig queue` 界面审计。Watchdog 策略与工作流运行时根据这些字段投影新负责人。

如果后台服务支持的协作命令失败，应直接调试 command/runtime/schema 边界——不要退回过时的升级前假设。

## 另请参阅

- `looping-workflows` Skill——自主工作组循环的操作纪律；queue-handoff 是其当前交接底层。
- `intake-routing` Skill——原始信号如何进入系统，并成为通过队列流动的已路由工作。
