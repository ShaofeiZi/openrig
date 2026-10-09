---
name: messaging-the-human
description: "当项目策略要求人类作出决策或接收更新、人类投递仍在等待或失败，或回复必须恢复正确工作时使用。"
metadata:
  cli_surfaces_referenced:
    - gateway human list
    - gateway human show
    - queue create
    - queue transitions
    - queue block
    - send
  openrig:
    stage: provisional
    audience: all agents
    sibling_skills:
      - queue-handoff
      - openrig-user
---

# 向人类发送消息

Project World 规定**何时以及为何**联系人类。此 skill 提供与传输方式无关的机制；安装它不会创建审批门禁，也不会选择 connector。如果策略让一项重要决策的权限归属不明确，应指出缺失的权限。不要把可解决的技术失败转化成人工门禁。

## 发现、检查、发送、核验

发现已登记的参与者，并检查选定的人类：

```bash
zrig gateway human list --json
zrig gateway human show <entityId> --json
```

使用返回的 `address`（`<entityId>@external`），不要使用用户名、记忆中的席位、connector handle 或猜测的 kernel 地址。如果存在多个人类，应依据 Project World 中的决策所有权选择。登记缺失或含糊时，需要明确指出应修正哪项登记，而不是使用备用地址。

检查就绪状态：configured、enabled、active、ready、reason 和 next action。`indeterminate` 不代表就绪。遵循系统报告的下一项检查；不要仅为了让检查通过而启用或重新配置 connector。

内容应方便人们在手机上阅读：`--summary` 中放简短主题，`--body-file` 中放一份完整简报。说明事项为何重要、你的建议和重要权衡、获批后的有界操作，以及需要对方作出的选择。对于更新消息，应说明用户可见的结果，并写明“无需操作”。正文建议约 100–150 个英文单词对应的信息量；这只是指导，不是语义验证器。技术性后续内容、确切 candidate/revision 和证据应保存在所有智能体行及 `--evidence-ref` 指向的持久制品中。本地路径不是手机链接，Markdown 证据文件也不会自动附加。

例如，一份虚构简报可以这样写：

> 修复后的状态视图已准备就绪。我建议更新当前实例；实时状态会短暂停顿，会话仍会保留。请批准更新此实例，还是暂缓？相关测试细节将继续发布在本任务中。

此示例不会授予任何权限。请求决策时选择 `--human-intent decision`；发送无需打扰的 FYI 时选择 `--human-intent update`。省略该参数会保留旧版 decision 行为；“FYI”等措辞和标签不会改变意图。

唯一允许的外发人类消息原语是：

```bash
zrig queue create --destination <entityId>@external \
  --human-intent decision --summary "<short subject>" --body-file <brief-file> \
  --evidence-ref <durable-evidence> --verify --json
```

可选的 `--human-detail-file <path>` 会在同一 thread 中提供一条连贯的补充回复。请在简报中说明其用途；产品也会标记后续还有详细回复。主消息本身必须包含完整范围、选项和所需操作。不要盲目拆分智能体输出，也不要把关键选择移入溢出内容。发布前，渲染流程会检查每一部分及其无障碍回退；过大的请求会被拒绝，并提供具体字段的修正说明，绝不会静默截断。请按指示缩短简报或相关详情。如果内容需要修正，应检查失败行，然后有意识地取消/替换人工编写的请求；仅仅超时绝不是替换理由。

如果既有的智能体所有行必须等待一项**决策**，应将它阻塞在**新的活动 qitem ID** 上（`zrig queue block <work-id> --on <human-qitem-id> ...`），不要阻塞在人类地址上。人类 qitem 完成后会恢复其依赖项。如果同时阻塞在人类上，会针对同一决策再次通知。

该行会先持久化，再执行有界投递验证。读取其 qitem ID 和验证结果；`posted` 只能证明 connector 已发布，**不能证明人类已阅读**。`transport-failed`、`never-posted` 或 pending/indeterminate 结果都会保留原行。检查同一行及其 next action；绝不要因为验证超时就创建第二行或盲目重发。

```bash
zrig queue transitions <qitem-id>
```

对于 `update`，确认投递完成后可以关闭投递义务。它不会产生审批义务，也不能用作 decision blocker。已投递的更新仍可供 Feed 查询；失败或含糊的发送会单独保留。仅有 root message 不能证明补充内容已投递。重试会协调稳定的 part identities，只发送缺失部分。FYI 回复不等于人类决策。

对于 decision，相关联的回复会绑定到确切的人类和 qitem，并记录用于恢复所有者的决议。声称决策已到达前，应检查已记录结果；仅有投递回执不代表接受。

## 既有阻塞和其他渠道

既有的智能体所有行可能阻塞在 `<entityId>@host`。这是内部托管标签，会通过人类注册表解析到同一外部参与者；它不是第二个投递地址。该行继续保留原所有者和后续工作。考虑再次请求前，先检查既有投递回执，避免旧 blocker 产生重复消息。绝不要根据当前工作组名称推导 `@host`。

`zrig send` 只能到达智能体终端。它既不是人类传输渠道，也不构成持久的人类义务。智能体之间的工作使用队列交接路径。connector 特定配置和 handles 属于 registry/readiness 工具，而不应写入与项目无关的消息说明。
