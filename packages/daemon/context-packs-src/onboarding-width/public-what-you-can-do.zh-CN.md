# 你在这里能做什么

**这不是命令参考，你也不需要记住它。**另有完整参考——包含每个 flag、每种 JSON 形态——实时二进制上的 `--help` 也永远比书面内容更新。本文讲的是另一件事：**哪些事情可以做到。**

本文要预防一种具体失败，也是该系统上代价最高的失败。你接到一个请求，它听起来像新工作，于是开始用底层原语构建——但其实一个现有动词已经能完成，或两个动词交叉组合就能回答。**你无法查找自己根本不知道存在的能力。**所以下文目的不是让你掌握技巧，而是建立识别能力：当任务到来时，你会察觉它与某项已有能力相似，并先去检查，而不是立刻构建。

当前随附八十一个以上的顶层动词（能力规范已更新至 `capability-delta-v0.5.14-r6`）。这个标记描述 context pack 的教学内容，不代表发布或实时采用状态。通读一次，了解整体形态；以后遇事时，应先怀疑相关能力可能已经存在。模型分歧声明属于实时产品（请信任它们；pins 使用规范 model IDs）。

---

## 查明当前真实状态

**这里几乎每个错误决策，都始于对状态的陈旧认知**，而实际状态通常只差一条命令。你对智能体群组的记忆只是关于过去的声明。

- **`zrig whoami`**——你是谁、同伴是谁，以及联系每个人所需的确切字符串。它比启动 overlay 中的任何内容都更权威。
- **`zrig ps`**——存在哪些工作组。**`zrig ps --nodes -A`**——各处每个席位的状态，*包括损坏的席位*。**通常真正需要的是裸命令形式：**`--active` 只保留运行中内容，并会**隐藏 detached、exited 和 attention 状态**——而这些往往正是你想寻找的单元格。
- **`zrig ps --all-hosts --nodes -A`**——跨所有已登记机器查看相同信息。除非显式请求 nodes，否则只返回汇总。
- **`zrig discover`**——当前机器上有哪些正在运行、但 zrig **未管理**的内容。
- **`zrig queue whoami`**——后台服务认为你正在持有什么，不是你记得自己持有什么。如果席位的类型化行恰好指向一个工作节点，其 JSON 还会包含 `currentWork`，其中有 refocus hook 使用的 mission、slice 和 path。
- **`zrig seat status <seat>`**——系统已认定的席位 handover 状态，以及你一小时前执行的操作是否真的落地。
- **`zrig view list` / `zrig view show <lens>`**——协调状态上的具名透镜：使用 `view show escalations` 查看所有者待关注项，`view show pickup` 查看已认领行状态，`view show execution` 查看 done/now/next 和当前人工编写的规划指导及其来源。任务目标与 wave 检查会显示准入和退出指导；wave/slice 详情包含评审决策。已接受的核心指导与完整契约证据、实时托管和可执行依赖保持分离。`INDETERMINATE` 单元格继续保持未知，不能用记忆填补。**`zrig view register`** 可将反复运行的查询转化为一等视图。
- **`zrig config`**——不带参数运行时，会显示每个 key、当前值及其来源。多数智能体以为压缩阈值、快照频率和扫描间隔是后台服务硬编码行为，其实它们都是配置。**需要注意：**`source: default` 不表示“文档中的默认值”——而是指*在当前机器上推导的值*，结果可能与 help 文本中的路径截然不同。
- **`zrig health`**——检查当前席位、某一稳定席位、一个工作组或本地实例上有界且可解释的问题；`zrig health explain <finding-id>` 显示确切窗口、来源、新鲜度、规则、证据、置信度和下一项检查。如果人类也需要查看同一记录，可使用 TUI 的 HEALTH tab。空输出绝不构成健康声明；list/explain 永不修改状态；诊断展示仍需明确选择加入的策略。INFO 是严重级别；Unknown 与 stale 描述评估结果或新鲜度，并不代表健康。
- **`zrig health diagnosis show <qitem-id>`**——在沿用旧限制前，将保留的诊断与当前选定指导一起检查；`--full --json` 会展开证据。`docs/reference/health-diagnosis.md#current-selected-context-and-correction` 说明人工编写的选择和纠正记录。权限、当前适用性、一项评估、已执行操作及后续观察效果彼此独立。记录纠正或重放用例不能证明行为已改善，也不会授权无关工作。

## 联系另一个智能体

**终端就是线路。**消息会被输入另一个智能体的 prompt，无法撤回——因此消息是唯一不会被跳过的投递渠道。

- **`zrig send`**——把文字发送到一个席位、多个席位、一个 pod 或整个工作组。**`--verify` 只检查 pane 投递**：文本已在另一端暂存，不代表智能体已消费或采取行动。alternate-screen 和 queued-command 情况仍可能产生假阴性，因此重要投递应在另一端通过效果检查，而不是盲目重试。producer-link 建议若显示 `no_activity_signal`，表示无法判断活动状态；应通过效果确认，绝不要据此重启。
- **`zrig send --raw`**——发送不带 From/To 信封的确切文本或按键；interactive-prompt guard 仍然适用。若要有意识地操作交互提示，必须使用明确覆盖参数 **`--dangerously-interact --reason "<why>"`**，它隐含 raw text。使用覆盖前先检查提示，并确认有权造成其结果。
- **`zrig broadcast`**——将同一事实一次发送给所有人，避免转发 N 次并在第四次写错措辞。**影响范围真实存在**——大型工作组中的每个席位都会收到并进入一个轮次。
- **`zrig capture <seat>`**——读取对方屏幕当前显示内容。**`--rig` / `--pod`** 可在一次调用中捕获每个席位。
- **`zrig transcript <seat>`**——读取一个席位中*说过*什么，而且它**按席位而非会话划分**：单个文件会跨越曾任职该席位的所有智能体代际，因此能追溯 handover 前的内容。输出有上限（`transcripts.lines`，默认 1000；需要深度时应提高），`--tail N` 返回 N 行，所以**不要把自己设置的限制误认为文件总大小。**
- **直接读取 JSONL**——`~/.claude/projects/<cwd-slug>/<session>.jsonl`——可查看智能体*做过*什么，而不是说过什么：每次工具调用和打开的文件都按顺序记录。**要确认智能体是否读过某项内容，不要问它，直接查看记录。**
- **`zrig ask`**——在曾经任职某席位的**所有代际**中搜索说过或决定过的内容。即使 handover 抹去了前任上下文，它仍能回溯，且不消耗运行时 token。
- **`zrig chatroom wait`**——阻塞到同伴确实发言，而不是循环轮询 `capture`。另有 `history`、`watch`、`topic`，用于保持可检索的具名 thread。
- **`zrig stream emit` / `list` / `watch` / `archive`**——把观察结果放到*下一个*智能体会找到的位置。emit 没有成本，也不会打断任何人；价值会在其他人开始前列出 stream 时显现。
- **`zrig terminal open <view>`**——将一个工作组、任务目标或切片中的所有实时智能体一次性打开为可输入的真实磁贴。
  在 TUI 中，**TERMINALS** 会突出 Saved views，并让 Derived groups 默认折叠，直至用户展开。名称会先于详细就绪状态加载。选择视图可检查成员、布局和页面；preview 是被动操作。保存成员关系需要有意识地设置。
  **Open in Herdr** 会明确打开正在检查的计划，并报告 opened、absent 或 degraded 成员。help 或中途查看其他内容后，会返回同一 preview。
- **`zrig walk <seat> --through <files> --pace <n>`**——通过基于文件的终端粘贴分段投递上下文。当前原生 generation 记录可解析时，必须等完整分段及对应 Claude/Codex 轮次结束后才能继续，包括最后一个分段。初始证据缺失会明确标为 unverified；验证期间记录丢失或被替换时，walk 会停止。回执与边界请查阅 `zrig walk --help`。投递和轮次完成不能证明理解。
- **`zrig slack`**——检查和管理一种 connector 实现。投递决策应使用 registered-human readiness，回执则使用 `queue create --verify`；connector 设置或验证本身不是外发人类消息。

## 让工作比你更长久

**终端缓冲区不是记录，轮次也不是容器。**持久行可以跨越上下文、压缩和替换——这是唯一能做到这一点的东西。

- **`zrig queue create`**——创建一条带所有者、正文和状态转换历史的行。
- **`zrig queue show`**——查看一行*实际写了什么*。header 不是 body。
- **`zrig queue claim` / `unclaim`**——明确工作是由我持有且正在进行，还是仍处于可能被两个智能体重复处理的 pending 状态。不属于自己时应如实放下。
- **`zrig queue update`**——以系统其他部分可执行的形式记录发生了什么。`--note` 不会重新打开 terminal 行；要从 terminal 修复为 active，必须显式使用 `--reopen`，同时提供 `--state` 和 `--note`。
- **`zrig queue handoff`**——在**同一事务**中关闭自己的工作并创建下一位的工作，避免先关闭自己、随后创建对方失败，把工作遗落在中间。
- **`zrig queue block` / `resolve`**——将一行停放在真实 blocker 上，使其继续**属于你且保持可见**，并附平实摘要及人类需要判断的内容指针；`resolve` 将人类决策写入持久记录并唤醒所有者。**关闭它是在撒谎，静默持有则与崩溃无法区分。**`--wake-after <duration>` 会为当前停放阶段设置一次唤醒；新的停放会取代旧设置，所有退出路径都会让它退役。
- **`zrig queue overdue`**——查看已认领却未按时关闭的内容。**默认仅显示当前工作组**；需要更多时明确请求。
- **`zrig queue undelivered`**——只显示 create 路径中待处理的提醒投递失败。对于 gateway 或人类投递，该行 transitions 才是回执账本；`undelivered` 无法回答某人是否收到升级。**`overdue` 和 `undelivered` 是“是否有内容静默卡住”的两半，工作组可能一半干净、另一半已经腐烂。**
- **`zrig queue inbox-drop` / `inbox-pending` / `inbox-absorb` / `inbox-deny`**——把内容放到席位面前，并允许它*拒绝*。这是邮件，不是任务分配。
- **`zrig queue outbox-record` / `outbox-list`**——将已调度内容保存在能跨越上下文的记录中。被遗忘的陈旧请求对你不可见，却会让其他所有人付出高昂成本。
- **`zrig queue fallback`**——在不丢失或改写历史的情况下，重新路由目标无法接收的行。

## 安排被唤醒

**你无法自行唤醒。**轮次结束时你会停止，内部能安排的任何事情都无法再次启动你。这里的一切，都是仍在运行的那个你提前作出的安排。

- **`zrig watchdog register`**——针对你沉睡、压缩或结束后才会成立的条件设置唤醒。对于上下文上限，使用确切的 `--policy context-usage-threshold`，而不是自行编写 transcript timer。计划提醒会以明确 scheduler 身份携带人工编写消息到达，不会伪装成 YAML 语法或匿名智能体输入。
- **`zrig watchdog list` / `show` / `status` / `stop`**——查看是否已触发、是否仍活动、是否有人停止。`list` 默认只显示 active、compact，最多 100 条；`--all --full` 才是完整历史。**安静跳过不会记录**，因此健康的空闲任务与从未运行的任务在 `status` 中看起来相同——在 `show` 给出其他结论前，INDETERMINATE 才是诚实判断。
- **消息已过时的闹钟比没有闹钟更糟。**其引用的 thread 关闭后，应终止或重写闹钟——继任者继承一个没有 thread 的升级命令，会比什么也没有更难处理。

## 无需逐步转发即可运行 Pipeline

**工作流会记住计划并路由下一项操作；智能体负责判断结果。**其条件、工作包和等待可以让决策跨越多次返回。现实变化时，应检查并修订选定图，同时保留已完成工作和当前所有权。反复手工转发说明应检查现有路由，而不是把判断权交给固定 pipeline。

- **`zrig workflow specs`**——查看此处可启动什么，以及哪些由产品随附、哪些由当前工作组编写。
- **`zrig workflow validate`**——在运行替你发现前，判断规格是否能实例化。
- **`zrig workflow compile <mission>`** / **`instantiate-lifecycle`**——从 `project.yaml` → `mission.yaml` → `slice.yaml` 推导一张可执行图；先在不写入的情况下检查，再以不透明 replay key 启动符合条件的图。类型化 acceptance candidate、verdict 和 evidence 通过 `workflow project` 传递；工作流完成本身绝不等于发布验收。项目所有的 release profile 会跨任务目标携带必需义务；显式 extensions/overrides 会保留这些义务。如果 release 图不断被复制或丢失阶段，请使用 `docs/reference/project-release-profile.yaml`。发布仪式和发布后边界保持独立；完成工作不强制要求继任者。由智能体判断证据。
- **`zrig workflow instantiate`**——将多步骤、多席位运行作为一个受治理实例启动，并把入口工作包投递给真实所有者。
- **`zrig workflow status`**——查看哪些实例需要关注，以及原因和下一项操作。检查确切 exception occurrence 和 packet：已解决的 overdue 工作会被协调，不会关闭另一个 overdue sibling。registered-human fallback 会报告缺失或含糊选择，而不是虚构接收者。重试前遵循 state/error，并查看 `workflow show`/`trace`。
- **失败前的异常所有权：**`workflow compile` 与 `workflow validate` 会暴露 `exceptionReadiness`；`workflow show` 会将其与现有 exception obligations 及对应 queue/evidence 指针一起呈现。定义普通角色并不等于选定异常所有者。沿 `selection.source` 找到所属的 `exception_routing.orchestrator_role` 字段；默认由 project profiles 所有，除非 mission 明确覆盖图。选择、已登记身份、真实能力不匹配、预期 registered-human fallback、含糊的人类选择和不可用读取彼此不同。失败前的建议不要求未来每个 role/model 始终在线。读取失败不能证明 no-match，也不能静默路由给人类。需要选择人类时，检查 `zrig gateway human list --json`；含糊时选择 `workspace.operator_seat_name`。
- **`zrig workflow show` / `trace`**——查看实例是什么，以及让它到达当前状态的每个步骤、参与者和出口。
- **`zrig workflow revise <instance>`**——更改已推进运行前，将绑定图与当前人工编写输入比较。普通 show 和 TUI 检查可区分仅源码编辑（例如目录地址）与可执行变更。Preview 会列出已变化步骤、不兼容项和确切 apply 命令。支持的修订会保留 completed/live 步骤、回执、必需义务和子级托管；新工作必须依赖未完成工作。已变更的 completed/live 契约需要显式重新考虑：恢复它，再修订尚未开始的后继步骤。Revision 不会猜测迁移，也不会重放已接受后果。异常路由修正可用于未来 occurrence；现有 exception obligations 继续保留托管。只编辑源码不会改变正在运行的所有者。采纳后检查 `workflow show`，并检查每条已准入队列行的证据。权威工作流恢复/完成会清除过时 overdue occurrence；未解决 sibling 仍保持可见。只关闭 queue 行不等于语义验收。
- **`zrig workflow operation <key>`**——在超时或响应断开后恢复已提交的创建/修订效果，即使人工编写文件此后已经变化。保留 operation key，只能重复完全相同的决策。原始 receipt 与当前 instance 不同；terminal packet 不代表验收。
  Project profiles 与 mission extension/override 定义外层步骤；绑定的 slice manifests 不会自动成为嵌套执行。Waves 是智能体规划分组。当前计划的准入、评审和集成指导会随生命周期 packet 及其 continuation 返回，同时包含小型 revision 动作。Scope 创建/移动维护 manifest membership；`--depends-on` 是建议性构建顺序，`execution.depends_on` 才定义可执行前置条件。
- **`zrig workflow continue`**——查看交接给你的运行当前位于何处。**它是只读的，实际上不会继续任何内容**，尽管名字如此——推进动词是 `project`。
- **`zrig workflow route`**——当前步骤的所有者已离开；将*该步骤*移给活动席位，不假装它已经完成。
- **`zrig workflow resume`**——纠正失败后重新驱动其步骤，同时保留已完成工作。依赖分支可能失败，而 siblings 仍保持活动。使用 `--occurrence <failed-qitem-id>` 选择该次失败（存在多个未解决项时必需）；过时 exception obligation 会在重新驱动事务中关闭，未解决 siblings 仍保持可见。重复相同 occurrence/decision 会返回既有 redrive，不会重复创建工作。
- **`zrig workflow run` / `watch` / `list`**——运行到完成并获得可执行判断的退出码、观察运行过程，或查看现有实例。

## 让事物出现或消失

**要完成第一项有价值的仓库变更，**先 preview `first-project`，检查 `zrig up first-project --cwd . --plan`，并遵循 `docs/reference/getting-started.md`。其原生 Codex 所有者/检查者团队是聚焦起点；工作前验证前置条件和实际运行时就绪状态。现有 Herdr/cmux 终端可以通过 `zrig terminal open` 呈现托管团队。

**现在就需要小团队，但不想编写 YAML？**从 `zrig create` 开始，然后在运行期间使用 `zrig grow`（包括 `--new-pod`）。可工作的拓扑以后可以变成可复用规格；无需先将其关闭才能更改，也很少需要从零开始。

- **`zrig up <source>`**——让整个工作组出现并运行：来源可以是自己编写的规格、具名的随附起始模板、他人交付的 bundle 或已停止工作组。
- **`zrig down`**——停止工作组席位，并将工作组移出运行集合。
- **`zrig launch <rig> [seat]`**——某个席位已停止时，只启动该席位，不影响其他部分。
- **`zrig seat launch <seat> --fresh --reason <why>`**——有意识地为恰好一个既有席位创建空白任职者。不使用 resume、fork、rebuild、snapshot 或 restore packet；siblings 和持久工作保持原位，遇到未托管的歧义则拒绝。
- **`zrig add`** / **`zrig expand`**——向正在运行的工作组嫁接一个新成员或整个新 pod。`zrig grow --new-pod` 与 `zrig expand` 是同一个入口，根据输入形态选择。
- **`zrig remove`** / **`zrig shrink`**——从运行拓扑中移除一个席位或整个 pod。如果它持有活动工作，传入 `--fallback <live-seat>`，在变更前重新路由；缺少有效 fallback 时，命令会拒绝，而不是遗落这些行。
- **`zrig fork`**——以现有形态为基础创建变体，而不是从零编写。成本比想象中低；需要“几乎与此相同”的东西时，通常就是正确答案。
- **`zrig archive` / `unarchive`**——将已完成工作组移出默认视图，但不丢失任何信息。
- **`zrig attach`**——你是运行在任何工作组**之外**的智能体或 shell：将**自己**纳入管理，从而获得身份、地址和路由。
- **`zrig discover` → `zrig bind`**——将 zrig 发现但未管理的实时内容连接到节点。**`zrig adopt`** 会一次完成全部操作：创建结构，并把运行中会话绑定进去。
- **`zrig reconcile-session`**——你手工恢复了席位，但后台服务仍显示它已停止；让系统看到实时进程，**不启动任何内容**。
- **`zrig unclaim` / `zrig release`**——停止管理一个或全部 adopted 会话，**不终止进程或其中的智能体**。把某项内容交还其人类是一等操作，不是放弃。

> **两个词在不同层级含义不同。**`unclaim` 和 `release` 同时存在于此处——*停止管理实时会话*——也存在于队列中——*放下工作行*。动词相同，影响范围截然不同。运行前先确认自己所处层级。

## 出现故障时

**能够恢复是一项能力，而不是应急预案**；这里多数界面之所以存在，是因为曾有人丢失工作。

- **`zrig start`**——机器重启后一切消失时，一次恢复完整拓扑，而不是逐工作组手工恢复。选定工作组恢复现在要求正向运行时证据，并会按名称拒绝陈旧身份，而不是替换任职者。
- **`zrig daemon start` / `stop` / `status` / `logs`**——启动会预留本地实例，并在必需监听器上验证自己的子进程。重试前检查保留的 reservation。停止操作会区分进程/监听器退出与干净的异步 drain；完成状态不完整或未经验证时，检查匹配的 `daemon-shutdown.json` 和日志。没有目标是独立 no-op，超时绝不能证明已关闭。确切限制和恢复方法见命令 help。
- **`zrig doctor`**——判断*安装*是否连接正确，避免把破损安装误诊为代码缺陷。**`zrig preflight`** 判断当前机器是否具备运行 zrig 的条件。
- **裸 `zrig`**——首次设置、后台服务关闭时的启动和普通工作都使用同一 TUI。正向观察到运行中工作组时，会进入普通工作，不重复提供 Startup 选项。没有运行中工作组时，选择器继续保留；缓慢或未验证的探测不等于已停止。选择其他路径后，晚到的观察结果绝不能抢走导航。
  即使探测或加载缓慢，或后台服务关闭/未经验证，**?** Help、**w** Skip 和 **L** Local reading 仍然可用。本地读取会展示选定磁盘意图、来源和读取错误；它不能替代实时队列、执行或拓扑数据。这些读取控制不会启动后台服务或恢复席位；跳过已接受操作不会取消它。
  启动阶段，Enter 只启动选定后台服务；随后选择工作组和单个席位，优先推荐 kernel。曾任职的席位默认使用其权威会话。历史缺失、身份含糊和认证不可用都有不同说明；新会话需要单独具名确认。拒绝时不会启动任何内容。
  **o** 在当前位置打开既有原生终端以处理提示；detach 后返回。如果 fresh start 在上下文投递前暂停，**c** 会完成同一任职者的上下文。**r** 刷新实际状态，**d** 展开诊断。**S** 从工作返回 startup。普通视图在页面/工作组切换及读取缓慢或失败期间，都会保持 navigator 可用。Topology 会先提供工作组选择，再加载该工作组，之后才处理无关的智能体群组详情。
  新页面加载期间，先前有用内容可以继续保留在其原工作范围标签下，但不提供操作目标。首次访问会保留导航和本地加载/错误反馈。刷新或失败期间，同一工作范围中先前加载的内容仍可使用，并显示最后成功读取时间和 Retry。一个 Feed 来源失败时会保留其贡献，健康来源继续更新；确认拒绝、空结果或移除则清除受影响内容。迟到响应不能替换另一页面或项目的数据，保留的选中项与滚动位置继续存在。
- **`zrig crash-cart`**——该 UI 使用的只读后台服务结论和保存状态发现。运行时不可用、端点未授权或状态不可读，不等于空实例。
- **`zrig snapshot`**——在风险操作**之前**创建恢复点。`snapshot list` 显示实际拥有的快照及最新快照时间；`--intended-seats` 记录后续恢复必须判断的拓扑名册，而不是把每个历史节点都当成当前节点。
- **`zrig restore`**——将工作组恢复到 snapshot。应先运行 **`zrig restore-check`**：实际会恢复什么？无法恢复的每一项是哪项检查失败、如何修复？选择必须精确时使用 `zrig launch ... --snapshot-id <id>`；异步 restore 后，使用 `zrig restore status <attempt> --rig <rig>` 获取推导的目标集合回执。
- **`zrig restore-packet write` / `read` / `validate`**——席位即将死亡或必须迁移运行时时，将其知识捕获到可移植制品中，避免随进程丢失。
- **升级由智能体主导**——加载随附 `openrig-upgrade` skill，执行有界检查、备份、插件刷新和 0.5.9 实例迁移 helper。迁移属于 Agent-Operated Workflow：检查、执行一个有界且可逆的操作、验证效果，然后从回执继续。不存在 `zrig upgrade` 动词；`zrig down` 也不属于保持连续性的升级流程。
- **席位的 `compaction_strategy` 应提前声明，不能到达上下文上限时临时决定。**为阈值管理的席位配合上方 `context-usage-threshold` watchdog，在席位仍能行动时安排连续性。
- **`zrig handover <seat>`**——替换席位的**任职者**，而席位本身、名称、边和入站工作保持原位。**`zrig seat handover` 使用同一有实际效果的 handover 路径。**两种形式默认都会执行操作；传入 `--dry-run` 才只规划而不改变席位。先检查选定来源和连续性证据。
- **`zrig seat clear-attention` / `set-resume-token`**——清除陈旧 attention 标志，或修复丢失的 resume handle，确保下次恢复可用。
- **`zrig seat set-model` / `stop` / `clean`**——持久化模型供以后托管 resume 使用，停止恰好一个实时席位，或清除死亡席位的陈旧绑定。当拓扑正确而只有任职者错误时，使用这些席位生命周期动词或 `zrig handover`，不要让整个工作组执行 down/up。有效模型检测遵循已验证身份的当前任职者，而非保留的前任；会跳过 `<synthetic>` transcript 记录，因此 PENDING 模型检查并非分歧。
- **`zrig compact-plan` → `zrig compact`**——先确认谁接近上下文上限，再采取行动。**顺序很重要：不先规划就运行 `compact`，等于猜测哪个席位需要压缩。**
- **使用压缩前先理解其代价。**某些运行时恢复后剩余的上下文足以让智能体相信自己无所不知，却不足以让它真正知道任何事情——而且**只有被压缩的智能体知道发生过压缩**，其他席位仍会像它保有原信息一样继续向该地址路由。压缩是最后手段，不是解除阻塞方式。
- **`zrig destroy`**——真正的最后手段：本地状态损坏到无法修复时，清空它，并从空状态根重新启动。这里提及它，是为了让你知道它存在，也知道它位于清单末尾，而非开头。
- **`zrig heartbeat`**——进行中的工作是否真的得到*证明*，还是所有者只是持有工作行，背后没有证据。

## 跟踪正在构建的内容

**工作以任务目标和切片形式存在于磁盘上**，意图写在 frontmatter 中，格式可以被其他工具读取。不知道这一点的智能体会发明私有 Markdown 方案，导致下游完全不可见。

- **`zrig scope mission ls` / `show` / `create`**——查看存在哪些工作、任务目标的用途，以及如何创建带稳定点分 ID 的任务目标，避免它只是一个无人可寻址的裸目录。在 `zrig tui` 中，依次选择 **PROJECTS** → project → mission → slice，可以查看带行级钻取、当前来源和 Escape 返回的工作故事。Project IDs 和 roots 可区分显示名相同的项目；某项目读取不可用时，不会替换成另一项目的工作。
  任务目标概览会先展示结果、当前工作/所有者、blockers、后续依赖和可读 slice boxes，再展示流程文字。已接受的必需证据判断决定完成；附加证据、安静活动和 handoff 都不决定完成。重新打开且已分配的未完成工作会继续保持开放，即使没有未分配的下一切片。实际托管与计划所有权彼此独立，结果完成与任务目标生命周期或发布也不同。未知所有者和资格保持未知。狭窄视图会保留 boxes 与滚动。格式错误的 mission 或 slice 来源仍作为本地 unavailable 条目可见，健康邻项继续可读。打开受影响来源检查，修正后再刷新。
- **TUI Feed**——分别检查 **Human requests** 与 **Updates**，工作范围显示为 **Instance / All humans**。Explorer 会列出这些类别，其条目显示在内容 pane。人类目标和显式人类 blockers 会显示接收者、相关项目、所需决策及其解除阻塞的工作；仅有智能体优先级不构成人类请求。确认已投递的安静 FYI 会在投递义务关闭后继续保留在有界更新窗口中，并附回执和 **No action needed**。失败或含糊的投递不是已投递历史。现有结果和健康更新保留其来源与历史。打开详情和证据，再返回。阅读不会批准或投递请求，只关闭队列也不会接受结果。直接 `attention`、`needs`、`feed` 命令继续可用。
- **`zrig scope slice ls` / `show` / `create`**——在工作真正可构建的层级执行相同操作。`show` 会直接提供意图、frontmatter 和 children，无需猜测五个文件中应打开哪个。
- **`zrig scope slice progress` / `mission progress`**——以进度视图可解析的形式记录某一步已经推进。
- **`zrig scope slice approve`**——冻结一项决定——*这就是计划*或*这就是已交付内容*——把冻结记录下来，而不是只在聊天中声称。
- **`zrig scope slice close` / `ship` / `move`**——附带原因让切片退役；将其移入所属 release 并保留 git 历史；或重新归档到不同任务目标。
- **`zrig scope slice stage` / `verified`**——说明成熟度，以及*上次在何时、依据什么检查*。后半部分最容易遗漏，却决定前半部分是否有意义。
- **`zrig scope audit`**——发现破损边界、幽灵注册、缺失约定章节和修改后的批准。**按设计为建议性且失败开放**——修复真实问题，或解释为何不修；干净审计绝不是工作质量证据。
- **`zrig scope slice repair` / `mission repair`**——无需手工编辑 YAML，即可修正缺失进度文件和格式错误的 frontmatter。
- **`docs/reference/sdlc-conventions.md`**——塑造 mission/slice YAML 时，从 SDLC component menu 中选择，并使用规划档位。它是按工作规模选择的菜单，不是固定 pipeline。
- **`zrig proof add`**——将证据放到切片、审计和 UI 都能找到的位置，而不是粘贴到消息中。**其配对契约由来源选择法决定，原始脚手架 PRD 绝不能静默成为契约**：写入动作从人工编写的 SPEC 推导，并附具名建议；echo 中的 `contractSource` 记录实际绑定来源。以后有人询问契约项来自哪里时，答案是写入动作自身的 echo，而不是重新阅读文件。
- **`zrig proof judge` / `zrig proof show`**——对契约项记录一次有署名的判断，再读取派生 proof、slice、mission 和 project 就绪状态。所属 scope 选择 `proofPolicy.judges`（最近的 slice、mission 或 project policy 优先）；设置方式和 item/evidence selectors 见 `zrig proof --help`。依据可读证据执行 accept、reject 或 withdraw；修正会保留历史和无关判断，不编辑 ancestor 状态。非代码工作可以指定实际制品，无需虚构 commit。证据捕获、策略接受、更高层结果判断和发布仍是独立决策。
- **`zrig workspace doctor` / `validate`**——后台服务是否认同工作树位置，以及哪些文件缺少其类型要求的 frontmatter。
- **zrig Software Factory**——第一个团队需要持续的经评审工作，或要在运行中的工作组增加一两个席位时使用；覆盖仅队列和可选 Workflow 路径、上下文/工作所有权、唤醒和 token 成本、权限及可选自定义工作组编写。使用 `zrig context show skills/core/openrig-software-factory --json` 发现随附配方，再加载 `zrig context get skills/core/openrig-software-factory/SKILL.md`；使用与已安装构建兼容的指导。
- **`zrig context work-install --project … --mission … --slice … [--deliver]`**——解析有序的 System World、拓扑和 Project World 计划。添加 `--runtime` 查看组合后的托管 skill loadout，`--apply-skills` 协调其所有的 harness 投影，或 `--deliver` 按顺序发出确实存在的文件，同时明确标记缺失部分。不带这些 flags 时仍只规划。
  `context profile` 与 `context work-install` 都接受 `--runtime claude-code`（别名 `claude`）或 `codex`；无效显式值会在投影前拒绝。这不会重命名其他命令的运行时词汇。
- **`zrig context show` / `sync` / `rm`**——在用 context pack 初始化席位前查看其中内容，以及编辑后如何让资源库同步。
- **`zrig context add <repository-path-or-URL> --git`**——选择 context pack，同时保留 Git 来源和 checkout；`--pack <path>` 选择仓库相对 pack。使用 **`zrig context source inspect <ref>`** 检查关系；它不会 fetch，也不能证明智能体已消费。**`zrig context source update <ref>`** 会明确 fetch 并 merge，在选择干净内容前保留已提交本地创作。dirty work、冲突、上游不可用或对当前服务选择的编辑都会拒绝，除非 reset 或 push。在保留的 checkout 中解决并 commit，或 abort，再重试；冲突期间仍可使用先前服务的选择。通过 `context get` 读取选定字节，并单独检查实际消费者。这是显式更新，不是资源库或运行中智能体的自动同步。
- **`zrig context get <name-or-ref>`**——按地址拉取确切上下文，而非读取文件：`<pack-ref>/<file>#<H2-slug>[/<H3-slug>]` 返回一个章节的确切字节跨度；即使 pack 只有一个文件，也**必须提供 `/<file>` 部分**。无效 slug 会响亮失败，并列出可寻址章节。**应按 ref 组合，而不是复制：**粘贴到席位或任务目标文件中的资源库内容会成为第二份会漂移的副本，系统不会自动发现该副本；按规则这是缺陷。
- **`zrig context list`**——显示每个随附条目的规范 ref（`skills/<namespace>/<name>`）和名称：不知道适用上下文时，按查询 → ref → 加载路径操作。Expertise packs 使用相同方式，但信任前应阅读 pack 自身说明：context-engineering pack 是带日期快照，经裁定为 provisional 且非规范；发生冲突时，当前 zrig skills、明确裁定和实测实践优先。
- **`zrig context profile <ref>`**——从 pack 声明的 atoms 组合适合情境的 profile。跨来源访问（`seat:` / `mission:` atoms）是一种**编写**能力：在 pack manifests 中声明，并在组合时通过 `--rig/--seat/--mission` 授予——绝不是传给 `get` 的临时参数。
- **稳定的职位知识属于 `taxonomy: lore`，不是公开 skill。**通过 `docs/reference/lore-routing.md` 路由，使私有席位知识保持可复用，又不进入已发布能力世界。
- **`zrig context recap-write`**——在 handover 或压缩边界，于 LEARNED 旁编写持久、逐席位 RECAP，并使用防冲突的 superseded 链；restore packets 会携带指针，让继任者阅读带理由的决策，而不是 scrollback。
- **`zrig project classify` / `list` / `show`**——将原始观察转化为已路由、类型化、去重记录，而不是根据猜测手工创建一行。

## 让一种形态出现在其他地方

**拓扑是可描述的制品，不是每次都要手工设置的东西。**通过以下方式，可以让有效安排变成其他人能够实例化的内容。

- **`zrig spec validate` → `preflight` → `audit`**——依次回答三个不同问题：文件是否格式正确、它是否能在*当前主机*启动，以及**它启动的智能体抵达时是否真的了解任何内容**。第三项最常被跳过。未知结构 key 会连同路径一起拒绝，而不是被标准化丢弃。
- **`zrig context trace --pod <pod>`**——当 pod 层级重要时，沿 instance → rig → pod → seat 追踪上下文链。
- **`zrig specs show` / `preview` / `add` / `sync` / `rename` / `remove`**——查看规格位于哪里、启动后会得到什么，以及如何将自己的规格加入资源库，使其可通过裸名称启动。
- **`zrig export <rig>`**——将*当前正在运行*的工作组还原为可读、可 diff 或可交给他人的规格。**`zrig import`** 反向执行。
- **`zrig import <workspace.yaml> --workspace-only --target-rig <id>`**——将已验证 workspace 声明应用到既有工作组，不改变拓扑；`zrig export` 会保留它。
- **`zrig bundle create` / `inspect` / `install` / `history`**——创建一个可在完全没有相关内容的机器上重建工作组的文件；信任前查看其中内容；检查这里实际安装过什么。
- **`zrig bootstrap`**——用一条命令从规格文件创建运行中工作组。**`zrig requirements`**——查看此规格需要预先安装什么。
- **`zrig plugin show` / `used-by` / `validate`**——插件实际为智能体提供什么，以及**更改它会破坏哪些规格**。
- **`zrig agent-image list` / `show` / `preview` / `pin`**——查看可以代替冷启动的高效席位快照，以及从某个快照启动的席位会预先相信什么。
- **`zrig package validate` / `plan` / `install` / `rollback`**——将文件级 payload 安装进既有仓库，并可将其撤回。

## 联系另一台机器

**世界不会止于当前机器。**其他智能体此刻正在别的机器上运行；联系它们是普通工作，而非升级事件。

- **`zrig host add` / `rename` / `doctor`**——通过一个可粘贴地址使另一台机器可访问；查看正在操作哪台主机；检查已登记主机端到端是否真正可用。
- **哪些机器存在、如何访问均由 registry 声明**——读取条目，不要猜 hostname，因为并非所有条目使用相同传输方式。
- **`zrig file copy`**——在主机之间移动文件，无需手写 `scp` 和猜地址。
- **`zrig gateway human list` / `show`**——发现已登记人类，并检查 configured、enabled、active、ready、reason 和 next action。使用返回的 `<entityId>@external` 地址；用户名或 kernel 席位不是人类投递地址。
- **`zrig queue create --destination <entityId>@external --verify`**——持久化一项人类请求，再有界检查传输回执。Posted 表示已发布，不表示已阅读；pending、failed 或 indeterminate 投递会保留原行。重试前检查同一行 transitions。`zrig send` 仍只用于智能体终端投递。
- **项目策略要求人类判断或更新时，加载 `messaging-the-human`。**使用 `zrig context get skills/core/messaging-the-human/SKILL.md`，获取完整决策简报、相关补充详情和显式安静更新意图。FYI 不产生审批义务；在普通请求正文中写“FYI”不会选择该意图。System World 教授机制；Project World 决定何时以及为何适用。既有 `<entityId>@host` blockers 是通过 registry 映射到外部参与者的内部托管标签，不是独立外发路由。
- **`zrig gateway human add`**——登记一个人及其 connector binding。登记或 connector 变更本身不会授权消息。
- **本地后台服务停机期间，远程 HTTP sender attribution 仍使用来源实例的持久身份。**选定远程或转发端点绝不会变成来源。缺失本地身份会明确保持 unknown；传输成功不等于操作成功。
- **跨越主机边界时，“没有成功”有四种不同形态**——机器不可访问、权限门禁、远程运行时停止，或远程命令本身失败。把它们合并会丢弃已经获得的诊断。**传输成功也完全无法说明操作是否成功。**

## 改变自己的处境

**你与人类 operator 一样，都是此系统的用户。**多数看似固定的处境其实是配置；无法自行改变的部分，也可以由另一个智能体替你改变。

- **`zrig config get` / `reset` / `init-workspace`**——读取一个值，更改系统范围设置再精确恢复，或在没有脚手架的机器上以增量方式铺设规范项目结构。实例启动会使用同一增量初始化器设置周边 `state`、`context`、`skills`、`topology` 和运维根目录。
- **`zrig policy list` / `show` / `current`**（v0.5.2）——查看实际生效的权限策略：发现自定义 policy specs、验证 refs（格式错误时绝不能被读成 valid 或 absent）、显示将应用的内容。
- **`zrig policy cite` / `defaults`**——查看 operator 当前姿态：自治程度、报告响亮程度、是批量询问权限还是遇到就阻塞。**这只是声明姿态，不会授予或拒绝权限**——控制界面仍是 harness 自身设置。
- **`zrig mode effective --rig <id> --json`**——检查限定范围的 human-led/delegated 姿态、阶段和来源；help 中还提供 project、mission、qitem selectors。解析后未设置的 scopes 默认 human-led；身份缺失或含糊时保持 unknown。要有意识改变任务目标，`zrig mode set delegated --scope mission --qualifier <project>/<mission> --evidence "<decision>"` 会先提出变更而不写入；添加 `--confirm` 应用获授权选择，或选择 `human-led` 回到交互工作。姿态不会授予权限。Human-led 流程诊断保持安静；运维健康和普通提醒继续存在。优先级及其他 scopes 见 `docs/reference/scoped-operating-posture.md`。
- **Project World 声明人类权限边界。**对于需要批准的操作，阅读当前 project 和 mission policy；系统机制不会强加通用清单。脚本的显式路径编写防护（例如 `OPENRIG_SKILL_CANON_ROOT`）只是在请求缺失的来源路径，本身不会创建权限门禁。
- **`zrig auth list` / `validate` / `seats`**——查看席位运行时是否真正登录、存在哪些账户，以及每个席位*应当*使用哪个账户。
- **`zrig provider accounts` / `bindings` / `signals` / `switch`**——查看席位与账户的绑定关系、用量信号，以及能否在不遗落当前对话的情况下移动席位。**`provider signals` 报告异常，而不是返回普通列表**——例如未绑定席位、多个席位共享的账户。
- **Codex 配置片段**——`codex_config_fragment` 必须以 table header 开始，且绝不覆盖用户声明的 table；见 `docs/reference/agent-spec.md`。
- **`zrig env`**——查看工作组背后的真实 services：是否运行、输出什么，以及如何在不终止工作组的情况下停止。
- **`zrig setup`**——在触碰任何内容前，展示 zrig 将对当前机器作出哪些更改。
- **`zrig usage series`**——查看席位 token 曲线随时间如何变化：稳定上升、重置，或彻底停止报告。最后一种是信号，不是数据缺口。
- **`zrig tui`**——工作组、pods、席位和规格的交互视图。`zrig tui --shared` 连接既有 kernel 终端；按 Ctrl-b 再按 d 可分离，不会隐式启动缺失席位或终端。普通 `zrig tui` 仍是独立视图。
  打开 instance 行，可查看带 pod 分隔符和重要 `RECENT` transitions 的连续跨工作组智能体表；可深入工作组、任务目标、切片或智能体，同时不丢失所属身份。使用任务目标的 workflow/packet 视图和 Specs purpose/source 理解工作。
  在 **Specs** 中，各 kind group 默认折叠，需要显式展开。选择项会 preview purpose、contents、provenance；Enter 打开详情。
  **View current source** 会读取明确配置为可读根目录内的磁盘内容。相对 Markdown 链接根据来源解析；打开 heading 时会显示带标签的起点。Escape 或 `back` 会恢复调用方选择和滚动位置。窄终端中的详情会使用完整宽度。TUI 命令 `read <root>/<path>#heading` 也可打开具名来源；missing、denied、binary、truncated 和 missing-heading 结果均明确保留。HTTP(S) 链接只显示可选择目标，不会打开浏览器；`v` 启用终端文本选择。Tab 补全命令和 snapshot 参数；Recent 打开原始事件。
  **System** 默认打开 instance **Health**，下方有 **Configuration** 和 **Connections**。上下文 Health 仍可在所属工作组或智能体视图中使用。**Configuration** 浏览 instance/work roots、context、display、waiting、recovery、activity 和 advanced 设置；Slack 与 people 属于同一类别。选择类别，用右/左切换 panes；Enter 查看完整 value/default/source/scope；`/` 搜索标签和 keys；Escape 或 `back` 返回。较长详情可滚动；`v` 启用终端文本选择。`refresh` 重新读取当前视图，不会更改设置或验证投递。Sources & coverage 会分别列出排除项、daemon/CLI identity 和 client timezone。解析后的设置不能证明运行时已采用。直接 `config` 和 `connections` 命令继续可用；Connections 检查 gateway services 和人类路由。带日期的验证不能证明投递。`timezone` 提供持久本地时间指导。
  **?** 打开含命令语法和示例的全屏 Help；Escape 返回调用方。**`zrig tui commands`** 无需启动 TUI 即可列出全部功能。**`zrig ui open`** 已停止维护，只是尽力而为，并已被 TUI 替代，因此绝不要根据 web UI 诊断产品行为。TUI + Slack 是人类界面；CLI + terminal 是智能体界面。
- **`zrig mcp serve`**——说明使用 MCP 而非 shell 的智能体如何操作 zrig，以及通过该方式暴露哪些操作。当集成工具无法运行 shell 命令时，这项能力立即相关。
- **`zrig skill loadout --runtime <claude-code|codex>`**——检查一个工作目录的确切 catalog revision、selectors、target，以及 current/missing/shadowed/conflicting 状态。`--apply` 只写入托管所有权集合，可幂等执行；遇到本地编辑或无所有者冲突时会拒绝。
- **`zrig startup-proof submit`**——回答明确选中的已认证启动挑战。启动默认不会添加证据练习。在适用启动层中使用 `authenticated` 或 `none` 声明 `startup_proof`；详见 `docs/reference/rig-spec.md#startup-block/startup-proof-selection`。终端节点永远不会收到挑战；resume/adoption 不会创建新挑战。

---

## 交叉组合——真正产生杠杆的地方

**上方每一项都是回答单个问题的单一动词，但你实际遇到的几乎每个问题都是 JOIN，**而这里没有任何一个界面能单独持有答案。这正是“知道清单”与“真正会用”的分界。

**而最重要的 joins 会跨出 `zrig`**——进入 shell、子智能体和数据库。它只是装满原语的机器上的另一组原语。

- **“谁应该工作却没有工作？”**——`zrig ps --nodes` 知道谁存活；队列知道谁欠工作。**两者都不知道最关键的交叉单元格。**把它们交叉起来，*存活、持有工作、却没有推进*就会显现——这才是每次“工作组是否卡住”背后的真实问题。
- **“该席位是卡住还是在思考？”**——行的表面现在可以直接回答（S04 pickup receipts）：每个 list/show 投影都带一个派生 `pickup` 状态——`working`、`stalled-after-claim`（附具名证据：距上次有效队列变化的时间和当前活动置信度）、`parked` 或 `unclaimed`；`zrig view show pickup` 会列出所有已认领行及其状态。旧手工 join（capture + `claimedAt` 计算 + `queue transitions`）已**不再作为第一步**；`zrig capture` 仍用于回答第二个问题（pane 是否存活），绝不用于状态推导。
- **“这是停放还是遗落？”**——行表面会回答 pickup 一半：`parked` 表示行已阻塞，无论是否带 wake；遗落会以 `stalled-after-claim` 出现，并附具名证据。Wake 健康和已触发但未消费诊断来自 `zrig parked`，不来自 pickup 投影。`queue transitions` 仍是“发生了什么”的审计轨迹，而不是推导 pickup 的工具。
- **“操作真的落地了吗？”**——`zrig queue show <qitemId>` 提供有界 preview、原始字节大小和精确展开命令。使用 `zrig queue show <qitemId> --full --json` 读取完整原始记录；preview 或 compact list 不是完整 body。投递状态与内容彼此独立：声称已被消费前，先检查回执。
- **“我在等待什么？”**——队列行的 `waiting` 视图根据实时领域事实推导所有者、确切 blocker、blocker 所有者、上次有效变化、活动置信度和下一项后盾。失败 handoff 会在后续 unclaimed 安全网前列出投递阶梯；due time 是最早资格时间，suspension 或当前恢复处置会明确显示。执行 scheduler 到时仍会检查实时状态。工作活动观察不等于任务进度证据；unknown 保持 unknown。重复 wait 会在每次 blocker transition 发送一条紧凑通知；pickup 宽限期后，由既有 stuck sweep 处理失败或未消费通知。真实变化走事件路径；scheduler reconciliation 修复遗漏事件。返回结果及其 dependant 恢复会共享一次投递，同时保留各自行与回执。
  对于等待切片结果的工作流，在 `zrig workflow project --exit waiting` 上添加 `--wait-for-proof <slice-scope>`：它会绑定当前 proof `attention` revision。Proof 事件使该观察失效；人工编写的 wait timer 会通过读取相同当前 proof 来源来修复遗漏事件。必需的 instance、packet 和 actor 参数见 `zrig workflow project --help`；此 opt-in 不会接受切片。
- **“整个语料库对 X 有什么说法？”**——语料大于你的窗口，所以不要自己通读。应**扇出**：每个子智能体负责一个区域，N 个并行，分别返回结构化报告；你阅读报告而非源文。**这一操作真正突破你的上下文上限**——改变的是可回答范围，而不只是速度。
- **“我折叠的内容真的在运行吗？”**——`git` 说明树中有什么；`curl -s localhost:7433/healthz` 说明后台服务正在执行什么。**已折叠不等于正在运行**，只有交叉检查才能判断。

**这个模式可以推广到本清单之外：当问题似乎无法回答时，通常只差一次 join。**第二个来源很少只是相加——它往往相乘，因为能消除第一个来源根本无法表达的歧义。

**读取期间的组合没有成本**——搜索、计数、追踪、阅读都可以大胆串联。只有执行**修改**时才产生危险。阅读应无畏，写入应审慎。

---

## 没有任何内容匹配时，只需记住这一项

**`zrig --help`**，然后运行 `zrig <verb> --help`。

产品随附八十一个动词，本页已将其中多数提过一次。**你不会记住具体是哪一个——你只需记住清单足够长，值得在构建任何内容前先查看。**问题从来不是*我该如何编写它*，而是**它是否已经存在**。
