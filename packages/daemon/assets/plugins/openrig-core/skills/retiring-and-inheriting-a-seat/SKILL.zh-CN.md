---
name: retiring-and-inheriting-a-seat
description: 当你是接近上下文阈值（约 85%）的当前席位智能体，并计划进行席位交接时使用——主动退休，将席位交给一个通过 packet 预置上下文的新继任者，而不是等上下文压缩降低自身能力。涵盖交接 packet、只追加的 lineage ledger（每个 tenure 一行）、物理席位连续性、不要过度继承的认知框架、可选的 warm-handoff 窗口，以及 wake-v0（咨询已退休的前任）。不适用于计划外的上下文压缩/崩溃恢复（session-compaction-and-restore / claude-compaction-restore），也不讲席位绑定原语的机械细节（seat-continuity-and-handover）。
metadata:
  openrig:
    stage: provisional
    sibling_skills:
      - orienting-to-an-inherited-seat
      - session-compaction-and-restore
      - seat-continuity-and-handover
      - claude-compaction-restore
      - agent-starters
      - queue-handoff
      - openrig-user
---

# 退休并继承席位

这是一种**计划内**席位交接。长寿命席位会持续积累上下文；接近上下文窗口边缘时，不要等待压缩把自己降级成冷启动智能体，而应**主动退休**，将席位交给一个通过 packet 和席位累积 lineage 预置上下文的新继任者。**席位地址保持稳定，占用者则形成一条 lineage。**整个交接过程及其权限必须保持明确。

## 适用场景

- 你是接近上下文阈值（约 85%）的当前席位智能体，即将进行一次**计划内**交接或有意的角色变更，并希望继任者从干净状态开始。
- 你正在把一个新继任者预置进**现有**席位。
- 你正在 seat lineage ledger 中记录一次 tenure，或编写自己的 tombstone。
- 你正在**继承**席位，需要理解“不要过度继承”的认知框架。
- 你希望咨询此前占用该席位的智能体。

## 不适用场景

- 已发生计划外的上下文压缩或崩溃——应使用兜底路径：`session-compaction-and-restore` / `claude-compaction-restore`。
- 你需要席位绑定的**原语级机械细节**，例如 rebuild/fork/fresh、两种结果的诚实模型、来源 schema——使用 `seat-continuity-and-handover`。
- 席位是全新的，没有需要退休的占用者——使用 `zrig launch` / `agent-starters`。

## 为什么计划交接优于一路拖到压缩

上下文压缩是**崩溃类别的兜底机制**，并且应继续如此。**计划内**交接则是有意行为：在能力下降之前，以清醒状态编写 packet；继任者从干净上下文开始；交接过程可审计。当可以预见阈值将至时，应主动使用这一方式；只有未能提前计划交接时，才退回上下文压缩。

## 交接顺序

1. **触发**——达到选定的连续性阈值，或进行有意的角色转换。使用已配置策略和具名的 transition owner；仅有上下文用量估计，不能授权 cutover。
2. **有意编写交接 packet**——组合一个 context pack，其中包含当前工作和下一位 owner、席位的持久指针、约束与权限边界，以及累积的 **lineage wisdom**（“此前的人学到了 X”）。它就是 `session-compaction-and-restore` 16 字段契约中的 restore packet；**复用该契约，不要重新发明。**使用 `zrig context compose` 进行组合（参见 openrig-user → “Context packs and paced delivery”）。
   **把席位的长期职责作为 packet 一级内容逐项列出：**哪些工作会重复、频率如何、在哪个界面发生，以及 cutover 后由谁负责。每项职责既要写入 packet，也要写入持久席位状态，因为在 generation 边界最容易丢失的是重复性职责，而紧急的一次性工作通常能够顺利传递。
3. **为新继任者预置上下文**——使用 `zrig walk` 将 packet 送入席位（分步交付让继任者按顺序吸收），或带 packet 启动。继任者应把内容读作*继承*，而不是*身份*。**packet 的 first-read 行必须指向 `orienting-to-an-inherited-seat`**，让继任者先理解交接是什么。该指针必须放在**持久 packet 产物本身**；绝不能将其作为按席位名称定向的运行时 prompt 注入，因为这种运行时机制正是入门 skill 教导继任者拒绝的 **ghost-prompt** 类别。由产物携带的内容会自然跨越 swap，无需启用额外 gate。
4. **cutover 前评估。**如果选择学徒期或 warm handoff，应在 owner 作出决定前，利用分阶段窗口提问并处理领域工作。在 owner 明确说出 cutover 之前，现任者继续持有权限；等待决策期间，不要仅为了释放名称而让现任者退休。
5. **cutover 时保留物理席位**——遵循 `seat-continuity-and-handover` 链接的可移植 SOP。保留规范 tmux session、window 和 pane；在其中恢复已接受继任者的准确历史，并核对 binding、environment、queue identity 和 attached clients。如果选定的处置方式要求保留现任者，应把其准确 token 作为 cold-advisor 句柄保存。重命名 tmux session 是修复兜底方式，而不是默认顺序。
6. **写入 lineage-ledger 行和 tombstone**（见下文）。记录实际结果，并明确转交每项长期职责。完成继任者的 cutover 后自检，之后才能解除权限冻结。

## 学徒模式——现任者

`apprentice-handover` 策略会提供较早的准备边界，但不会授权自动作出继任决定。创建一个全新、暂存且未绑定的继任者；安装上下文之前证明其固定模型；然后开始一场**对话，而不是闯关**。分配有指导的短任务、回答问题，并在真实领域中判断其工作。评分探针只是可选工具，严格程度应与风险匹配，而不是强制流程。

在具名 owner 明确说出 gate、且运维人员记录效果回执之前，应继续作为持有权限的现任者。在此之前，学徒可以观察、提问和生成证据，但不能作为该席位行动。逐项列出 deposit 并明确转交每一项长期职责，**因为重复性职责**很容易丢失，而可见的一次性工作可能看起来已经完整交接。机械式 cutover 应放在 `seat-continuity-and-handover` 链接的可移植 SOP 中；不要在这里复制或即兴设计。

## Lineage ledger（只追加，每个 tenure 一行）

这是席位的任期记录，在交接时**由退休智能体**写入。每个 tenure 只占一小行：

- **generation**——`v1`、`v2`……（一个席位在数月中会积累 20–40 个 tenure）
- **harness session id**——在**启动时捕获**，而不是退休时；崩溃后不会再有机会补写
- **started / retired** 时间戳
- **handover-packet pointer**——pack ref
- **tombstone**——一行，由退休智能体亲自写明该 tenure 完成的工作

**它为何有效（无需搜索基础设施）：**任意带时间戳的记录——git commit、qitem、NOTES.md 行、stream 条目——都可以通过时间区间与席位 ledger 关联，得到 generation + session token，进而唤醒该 tenure。每次交接写一行，只追加。ledger 是 tenure 记录；工作树中的 note 仍属于实际工作上下文，不是身份状态。

**因崩溃结束的 tenure** 由 crash-cart / restore 路径在事后追加，并标记为 **honest-approximate**。启动时捕获的 session id 使这种恢复成为可能。

## 继承席位，不继承前任身份

**你继承的是席位，而不是变成前任。**应明确告诉继任者：“此前有智能体坐在这里，并学到了 X；你承接席位的任务目标，但不继承它们的身份。”不要把前任的工作说成自己完成，也不要把其过时身份作为当前 binding。继承席位的**任务目标和来之不易的经验**，同时保持自己的**全新身份和会话**。

## 回访保留的前任

退休 tenure 是可以咨询的 cold advisor。查找席位 ledger，取得对应 generation 的 session token，用它恢复会话并只问**一个问题**，然后让其再次休眠：

- Claude：`claude -p --resume <session>`
- Codex：`codex exec`（恢复 rollout）

使用 `zrig ask <rig> "<q>" --wake <seat[@gen]|token>` 发起明确、有边界的咨询（CLI 0.5.1 引入）。用 `zrig ask --help` 查看 `--runtime` 和 `--wake-timeout`。该包装器使用运行时 resume；它存在并不能证明某段保留历史一定可用。对于 Claude 历史，在运行时支持时，可以用 `claude -p --resume <full-uuid>` 兜底。应诊断具体失败，不能直接宣称渠道不可用。

**关于如何联系你，packet 中应写什么**——继任者能够向你提问，正是 handover 与 compaction 的区别：

- **提供逐字准确的 resume 句柄和已知可用性限制。**仅仅退休不会使保留历史失效；恢复仍取决于历史是否存在、运行时访问能力和剩余上下文。应区分这些失败模式。advisor 只提供证词，不会重新获得在线席位的权限。
- **预先拟好问题。**盘点只有你掌握的内容，并把问题完整写出。一项能力必须有触发条件：点明哪些权衡、缺失理由或冲突应触发提问。

**Wake-tenancy——身份的两面（被唤醒的 tenure 可能误以为自己仍是在线席位）。**最难套用 *checked-not-believed* 原则的对象是自己的身份：为回答问题而恢复的退休 tenure 可能像仍持有席位一样回答甚至行动。以下两条规则可以阻止这种情况：

- **唤醒方：在 wake prompt 中说明目标的 tenure 状态。**开头明确写：“你已退休；现在由 gen-N 占用该席位——我只就一个问题咨询你。”理解处境的 tenure 会提供诚实证词；未经定向的 tenure 可能把自己当作在线占用者。
- **被唤醒方：第一次行动前验证自己的 tenure。**如果你正在被 resume/wake——无论是暂停或退休的会话，还是在席位已经签发 READY 后唤醒的任何会话——你的**第一个**检查必须是 `zrig whoami` 加**继任者检查**：在做任何事情之前，先确认自己是否仍是在线占用者，或席位是否已有继任者。回答问题，不要恢复原工作。

## 失败模式

1. **本可计划交接，却一直拖到上下文压缩**——能力下降后的智能体会编写出质量下降的 packet。应在可预见的阈值主动退休。
2. **过度继承**——继任者认为自己*就是*前任，形成过时的自我模型，并错误声称过去的经历。明确说明继承边界，保持全新身份。
3. **退休时才捕获 session id，而不是启动时**——一旦崩溃，就没有 ledger 行，或无法找到对应 tenure。应在启动时捕获。
4. **为在线席位添加后缀**（把 `<seat>-v2` 作为活动地址）——这会让 lineage 泄漏到 identity，形成错误结构。在线地址保持简洁，generation 应写在 ledger 中。
5. **省略 tombstone 或写得含糊**——ledger 将无法回答“谁做了这件事 / 应唤醒谁”。每个 tenure 都要有一行诚实记录。

## 计划交接前后的检查

- **在 owner 发出 cutover 指令前先分阶段准备和评估。**继任者尚未绑定时使用 startup context；依赖 registry 路由交付之前，先检查其真实地址。在选定 SOP 的 cutover 步骤生效前，现任者继续持有权限和物理 pane。候选者被拒绝，并不要求把现任者重命名回一个它本来就应继续持有的席位。
- **保留准确的 resume 句柄。**保留的 advisor 可能没有托管 node 或在线 pane。ledger 能独立于在线席位 registry 标识其历史；仅仅没有出现在 `zrig ps` 中，不能证明历史已经消失。
- **在边界重新检查工作。**packet 冻结后仍可能有队列条目到达。继任者应读取当前归自己所有的队列，核对交接窗口内的工作和 staged 输入，并记录所有剩余义务。
- **跨界面验证身份。**规范 binding、provider history、进程环境、queue identity 和 attached clients 必须一致。通过受支持的 cutover/reconciliation 路径修正 staged identity 残留；只重命名 tmux session，不能证明这些界面已经一致。
- **明确标记不完整证据。**活动 telemetry 不可用时标为不可用；由他人代写的 tombstone 标为 approximate。
- **协调维护窗口。**获得授权的 cutover 前，告知路由/监控 owner 目标和预期窗口。只有显式配置的 suppression 才会改变监控行为；使用实际效果回执、偏差和未解决缺口关闭窗口。

这些是验证提示，并不宣称某次具体运行时交接已经通过。机械操作应使用链接的可移植 SOP，并记录实际运行情况。

## 另请参阅

- `orienting-to-an-inherited-seat`——packet 在启动时指向的**继任者侧**世界模型；它是本驱动方操作方式中承担关键作用的对应部分。
- `session-compaction-and-restore`——本实践复用的 16 字段 packet 契约，以及本实践在*计划内*交接中替代的计划外上下文压缩兜底。
- `seat-continuity-and-handover`——席位绑定原语的机械细节与稳定席位身份架构；lineage ledger 是其抽象来源记录的具体形式。
- `openrig-user` → “Context packs and paced delivery”——使用 `zrig context compose` + `zrig walk` 编写并交付 packet。
- `claude-compaction-restore`——Claude 崩溃类别恢复 SOP。
- `agent-starters`——为继任者组合预置起点。
