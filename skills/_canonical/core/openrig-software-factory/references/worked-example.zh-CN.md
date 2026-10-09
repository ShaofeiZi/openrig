# 完整示例：经过评审的 CSV 验证

使用本示例，将经过评审的工作方式应用到处理 CSV 的仓库。先选择简单团队或队列循环；完整 Workflow 文件是可选项。应用示例前，先检查目标安装版本的命令帮助。

这是一个可供调整的具体 CSV 验证示例，并不要求任意仓库都变成 CSV 项目，也不要求每个结果都拆成两个切片。本示例使用两个确实存在依赖关系的切片。选择一个真实且已授权的仓库，记录其起始 commit 和现有 CSV 行为。如果仓库没有相关 CSV 代码，请选择两项适合该仓库、彼此依赖的变更，并在执行前重写示例目标；普通用户任务仍应保持适合自身的规模。

仅在本示例中，仓库根目录与工作根目录是同一个绝对目录，称为 `PROJECT_ROOT`。选定的项目 ID 是 `csv-tool`，任务目标是 `csv-validation`，工作组使用随附的 `first-project`。这些是人工编写的示例身份，不是在线发现结果。先解析现有 catalog/config/intent。绝不能为了安装模板而覆盖真实的 `project.yaml`、`workspace.yaml`、`SPEC.md`、`AGENTS.md` 或现有任务目标。应谨慎合并兼容字段，或选择未使用的工作目录并保留现有 catalog 条目。如果使用独立工作根目录，应在代码仓库中启动席位，并在 intent/context 中记录两个根目录。对本编译器路径，`project.yaml` 应保持位于任务目标目录上方两级；此处没有建立任意自定义 mission-root 布局。

## 手工工作与队列循环

处理一项小变更时，从仓库指令、一个可观察结果、一位具名 owner 和选定 checker 开始。让 owner 推动该结果通过实现和独立判断。无需先创建下方 manifest 或 Workflow 实例。把有用的验收条件、决策和证据保存在项目现有文件中。

当工作需要跨越一个 turn 持续存在时，实际 owner 先验证自身身份，再使用队列。在本示例中，owner/checker 地址在与真实 `first-project` 团队核对之前都只是合成值。任务文件包含真实结果、边界、验收条件和证据指针；发送之前先创建该文件：

```sh
zrig whoami --json
zrig queue create --destination dev-owner@first-project \
  --body-file ./TASK.md --summary '实现已约定的 CSV 检查' --json
zrig queue claim <returned-qitem-id> --json
```

实现并检查累积候选版本后，当前 owner 执行：

```sh
zrig queue handoff <owned-qitem-id> --to dev-check@first-project \
  --body-file ./REVIEW-REQUEST.md --json
```

请求应绑定准确候选版本、验收条件、命令和证据。使用 `zrig queue show <id> --full --json` 回读继任者；checker 领取该条目，独立判断，再将该 lineage 交回 owner。修复应继续归属于同一结果和 checker。owner 报告已检查结果，并使用已安装版本的 `zrig queue update --help`，明确交接剩余工作或以真实结果关闭。仅有终态队列状态不等于验收通过。消息可以澄清范围；只执行 `zrig send` 不会转移队列所有权。

如果存在真实的本地依赖，保留已领取记录并附加 continuation：

```sh
zrig queue block <owned-qitem-id> --on <live-blocker-qitem-id> \
  --continuation '读取结果，然后继续已约定的 CLI 变更' --json
```

对于真实的外部等待，应写明实际 blocker。如果约定的时间/费用预算允许使用提醒，可以向该 block 命令添加 `--wake-after 2h`；示例时长只是一种选择，不是强制节奏。提醒只要求重新查看，绝不会提供答案。回读 state、owner、blocker 和 wake。真实答案到达后，应保留该答案，并通过受支持的 claim/update 路径恢复同一项义务；不要创建重复任务。如果没有未解决的问题，不要为了演示等待而虚构问题。

完成后，同一 owner 可以领取下一项已授权结果。持续更新有用的项目上下文和进度。无论长期路线图还是空队列，都不能授权智能体自行发明工作。

## 什么会唤醒工作，代价是什么

检查已安装配置和 `zrig watchdog list`，确认实际 job；升级后安装中残留的旧 job，不能证明全新安装的默认值。

| 机制 | 触发条件与边界 |
| --- | --- |
| Queue create/handoff | 通常会在持久化后提醒目标位置；`--no-nudge` 可禁用提醒。读取 delivery/pickup 回执；写入被接受不代表工作完成。 |
| 本地依赖解决 | 阻塞于在线本地 qitem 的记录，可以在 blocker 解决后恢复为 pending 并唤醒 owner。如果工作继续交给另一个 owner，blocker 可以跟随该继任者，而不是错误宣告完成。外部文本 blocker 不会自行解决。 |
| 显式 blocked `--wake-after` | 在暂停时注册提醒，从注册时刻开始计时。仅在正文写入截止时间，不会隐式创建计时器。真实 blocker 仍存在时，重复提醒也可能唤醒模型。 |
| Parked-owner anti-park 检查 | 由后台服务注册的逐工作组 supervisor 检查是否存在持有开放工作、符合条件且空闲的 owner；每次 park episode 只保留一次 wake。它不是空闲工作生成器。 |
| Stuck sweep / wake-or-escalate | 后台服务的常驻检查会暴露卡住的义务并路由恢复；handoff wake 失败时采用有界重试/升级。未经确认的交付遵循自身确认路径，不会盲目重发。它们不会覆盖交互式提示或 provider 限制。 |
| Idle-gate | 需主动启用：`policies.idle_gate_qitem.auto_register` 默认为 `off`，`policies.idle_gate_qitem.opt_in_sessions` 默认为空列表。已有 job 可能继续存在。不要假设每个全新席位都有该周期提醒。 |
| Workflow keepalive | 只有显式实例化运行时才会为其入口 packet 启用 keepalive；仅编写 YAML 或编译不会启用。自动 keepalive 受截止时间控制，并不承诺每次检查都会产生一次模型 turn。 |

Wake 调度、refocus 和 health 各自职责不同：wake 寻求重新获得关注，refocus 提供指针/上下文，health 报告观察结果。它们都不能证明有用工作已经发生，也不能证明新编写的上下文已经被阅读。后台检查只是普通后台服务计算，本身不是模型 turn。**已经交付的 wake 和恢复后的工作可能消耗 token。**选择提醒或更多自动化之前，应约定工作、时间和费用限制；优先采用依赖事件和有意义的停止条件，而不是短间隔、重复的空提示。Wake 不会改变权限、提供缺失的产品决定或授权更多工作。

## 工作发生时的权限

首次任务开始前，让智能体配置你的选择：保留提示、记住所选命令，或明确选择更宽的访问范围。使用 `zrig context get skills/applying-a-permission-policy/SKILL.md`，或[兼容的源代码/软件包路径](../SKILL.md#find-the-compatible-permission-guide)。智能体负责设置并验证实际对话；用户无需手工编辑配置，也无需为每个步骤重复已经给出的授权。整个 `zrig` 规则会覆盖其全部动词，包括生命周期和配置操作；也可使用更窄的规则。保留 deny/ask 规则和无关设置。原生/provider 限制仍然有效，权限也不会扩大产品工作范围。在让工作进入无人值守状态之前，先约定如何获取真实用户决策。

## 扩展正在运行的团队

当 `first-project` 的 owner 和 checker 已经足够时，应继续使用它们。有实质性的独立工作时，再向这个运行中的工作组增加一到两个席位。下方示例添加两个 builder；不要求更大的 starter、新 Workflow 或替换会话。如果实际工作组名称不同，应使用真实名称。

### 无需 YAML 即可增加一到两个席位

从协调席位检查现有工作组、其工作和随附的通用智能体：

```sh
zrig ps --json
zrig ps --nodes --rig first-project --json
zrig queue list --destination dev-owner@first-project --json
zrig specs show orchestrator --kind agent --json
zrig grow --help
```

将 `RIG_ID` 设置为运行中 `first-project` 的 `rigId`，将 `PROJECT_ROOT` 设置为代码仓库的绝对路径。验证其现有 `dev` pod，并选择未使用的成员名称。用户授权新增容量和费用后，运行：

```sh
zrig grow "$RIG_ID" a b --pod dev --runtime codex --cwd "$PROJECT_ROOT" --json
zrig ps --nodes --rig first-project --json
```

只增加一个 builder 时省略 `b`。预期的新 logical ID 是 `dev.a` 和 `dev.b`，地址是 `dev-a@first-project` 和 `dev-b@first-project`；应使用命令实际返回的身份。该命令会添加并启动具名席位。

如果希望把这些席位放在一个**新** pod 中，则选择以下替代方案一次，并使用未占用的 pod ID；对于同一所需容量，不要同时运行两个示例：

```sh
zrig grow "$RIG_ID" a b --new-pod build --runtime codex --cwd "$PROJECT_ROOT" --json
```

该方案会生成 `build.a`/`build.b` 及对应的 `build-...` 地址。`--pod` 与 `--new-pod` 互斥。只有一个现有 pod 时可以推断 `--pod`；如果目标位置很重要，应显式选择。runtime 默认为 `claude-code`，cwd 默认为调用方当前目录，因此这些示例有意选择 Codex 和代码仓库。

`grow` 会解析随附的内置 `orchestrator` 智能体及其 `default` profile。它不会复制 owner 的自定义 agent、model、context、原生 permission profile 或 conversation。检查返回的 `source` 和原生配置，并明确分配 builder 职责。需要自定义成员字段或 agent spec 时，使用下方可选 Architect 路径和 `zrig expand --help`。

检查每个 node 的 status/error 和原生 pane。确认现有席位和工作仍然存在；node 已创建不代表已经就绪。部分成功的结果可能留下持久化 node。发生 timeout 后，先核对 topology 再重试。修复报告的原因后，只有在已创建席位启动失败时才使用 `zrig launch "$RIG_ID" dev.a`；该命令不会创建缺失席位。

新席位不会继承 owner 的 conversation 或 task。把约定的工作划分记录在项目现有 working agreement 中，并为每项任务准备文件，写明准确的 project/mission/slice 源地址、结果、file/worktree 边界、检查项、下一位 owner 和停止条件。然后交付上下文指令，例如对第一位 builder：

```sh
zrig send dev-a@first-project "读取 $PROJECT_ROOT/SPEC.md 和 $PROJECT_ROOT/.openrig/factory/TASK-A.md 中已寻址的事实源。在自己的席位运行 zrig whoami --json 和 zrig queue list --owned --json；报告自己的身份、工作范围及任何原生就绪/权限 blocker。等待有边界的队列任务。"
zrig capture dev-a@first-project
```

读取真实回复和 pane；调度前，按选定策略处理启动、登录和权限提示。只有确实增加 B 时才对 B 重复。操作方不得冒充任一席位。交付上下文并不等于领取工作。准备就绪后，协调者创建各自独立、已约定的任务；如果已有 owner 持有该任务，则应 handoff，不能重复创建：

```sh
zrig queue create --destination dev-a@first-project \
  --body-file "$PROJECT_ROOT/.openrig/factory/TASK-A.md" \
  --summary '实现已约定的独立变更 A' --json
```

适用时使用真实 project/mission/slice 标签。使用 `zrig queue show <id> --full --json` 回读返回的 ID；A 以自身身份领取。结果、评审和 blocker 继续使用前述队列循环。已绑定 Workflow 的工作保留其 packet/projection 契约：新增席位不会修改运行中 graph，也不会自动绑定角色。职责和所有权来自 working agreement 和已分配工作，而不是席位名称或默认 agent label。

### 只有工作确实需要时才专业化

| 本示例中的席位 | 有意约定的职责 |
| --- | --- |
| `dev-owner@first-project` | 起初负责实现与协调；随后可以成为专职 orchestrator，选择结果、拆分任务、负责集成并持续持有下一项工作的 custody。 |
| `dev-a@first-project`、`dev-b@first-project` | 实现不同的已授权任务，并返回准确候选版本/证据。两者都不得静默编辑对方文件，也不得在没有集成所有权时自行合并两个候选版本。 |
| `dev-check@first-project` | 按项目评审策略保留独立判断。实现者自己的检查不能算作独立评审。 |

这只是一种扩展方式，不是强制四席位布局。一个额外 builder 可能已经足够；不同负载也可能更适合专业角色或额外独立评审能力。应为这些职责使用合适的已发现 agent spec。遵循用户的评审策略，不要为每个微小编辑都增加 reviewer。只有输入和编辑能够相互独立时，才能并发启动任务；使用明确互斥的文件或独立 worktree，并指定一位 integration owner。共享文件、串行依赖和评审瓶颈都可能抵消速度收益。更多活动席位和已交付 wake 可能消耗更多 token。应约定模型选择、活动并发数、时间/费用限制和停止条件；新增席位既不会改变权限，也不会扩大授权结果。现有 wake 策略仍适用于空闲席位，因此 idle 标签不保证零 token 消耗。

### 保存扩展后的形态，但不要替换在线工作组

Expansion 会把新拓扑持久化到运行中实例的数据库，不会重写 starter 或原始人工编写的 `rig.yaml`。应将单独的在线导出保存到未使用、由用户拥有的路径：

```sh
zrig export "$RIG_ID" -o "$PROJECT_ROOT/.openrig/factory/first-project-expanded.yaml"
```

检查导出内容，将其与用户拥有、人工编写的 RigSpec 核对，同时保留原始 culture/startup/context 文件、agent import、权限及其他设置。

导出会重建存储的拓扑，但并不是每个原始编写字段的无损副本，也不是原生 conversation 的备份。如果导出的 agent 引用为相对路径，应从其原始根目录解析，再针对新文件位置进行修正；文件位置变化不会移动这些资源。使用 `zrig spec validate <path> --json` 验证核对后的完整 RigSpec，再使用 `zrig doctor --spec <path>` 将席位成员关系与在线工作组比较。该比较不能证明所有 startup/context 字段或原生恢复能力。

保留核对后的 spec 和现有连续性证据。依据旧人工 spec 创建的 bundle 可能遗漏新增席位；在扩展之前创建的快照不能证明新增席位可恢复。任何以后获授权的 snapshot/restore 都应使用兼容的生命周期指南。不要仅为了保存定义而停止、重建或替换运行中的工作组。

如果需要不同的团队结构，请使用主 recipe 中可选的 [zrig Architect](../../openrig-architect/SKILL.md) 路径。需要自定义 agent spec、model/profile 字段或人工编写 edge 时使用它。YAML 编写是可选的；常规扩展使用上述命令即可。

### 有意移除容量

不再需要某个席位时，先保留其工作并确定下一位 owner。`zrig remove "$RIG_ID" dev.a` 会移除该席位；`zrig shrink "$RIG_ID" build` 会移除整个可选 build pod。两者都会结束受影响的会话。有活动工作时，移除操作会拒绝执行，除非显式选择一个在线 `--fallback <live-seat>` 接收工作。检查准确目标、handoff 和返回结果；不要使用 fallback 丢弃义务，也不要仅因席位看起来 idle 就移除它。

## 进阶：显式 Workflow 契约

当显式运行时前置条件/退出方式有用时，使用以下完整示例。上方的手工工作与纯队列工作不要求使用此 graph。在不同模式间切换时，继续使用相同的仓库目的、owner/checker 和证据习惯；不要为同一项实现同时运行纯队列任务和第二个 Workflow 任务。

人工编写的布局如下（用户代码和测试仍保留在现有位置）：

```text
PROJECT_ROOT/
  workspace.yaml
  project.yaml
  SPEC.md
  missions/csv-validation/
    mission.yaml
    SPEC.md
    PROGRESS.md
    NOTES.md
    slices/01-inspect/
      slice.yaml
      SPEC.md
      PROGRESS.md
      PROOF.md
    slices/02-cli/
      slice.yaml
      SPEC.md
      PROGRESS.md
      PROOF.md
```

`workspace.yaml`——完整 YAML 示例：

```yaml
schema: openrig.workspace/v0alpha1
projects:
  - id: csv-tool
    root: .
```

`project.yaml`——完整 YAML 示例：

```yaml
schema: openrig.project/v0alpha1
kind: project
metadata:
  id: csv-tool
install:
  intent: SPEC.md
  context:
    - SPEC.md#working-agreement
  skills: []
missions:
  root: missions
lifecycle:
  profile: small-change-v1
```

`missions/csv-validation/mission.yaml`——完整 YAML 示例：

```yaml
schema: openrig.mission/v0alpha1
kind: mission
metadata:
  name: csv-validation
composition:
  mission_markdown:
    spec: SPEC.md
  slices:
    - ref: slices/01-inspect/slice.yaml
      order: 10
      active: true
    - ref: slices/02-cli/slice.yaml
      order: 20
      active: true
lifecycle:
  profile: small-change-v1
  workflow:
    objective: 添加经过评审的 CSV 验证，且不修改输入数据
    target:
      rig: first-project
    entry:
      role: owner
    roles:
      owner:
        preferred_targets: [dev-owner@first-project]
      checker:
        preferred_targets: [dev-check@first-project]
    context_refs:
      - SPEC.md#intent
      - SPEC.md#acceptance
      - PROGRESS.md
      - NOTES.md#blank-required-cells
      - slices/01-inspect/SPEC.md
      - slices/02-cli/SPEC.md
    exception_routing:
      default: orchestrator
      orchestrator_role: owner
    steps:
      - id: inspect
        actor_role: owner
        objective: 实现并检查切片 01-inspect 的纯 CSV 检查契约
        depends_on: []
        allowed_exits: [handoff, waiting, failed]
      - id: cli
        actor_role: owner
        objective: 在 CLI 中使用检查结果；完成切片 02-cli 前解决真实的空白单元格决策
        depends_on: [inspect]
        allowed_exits: [handoff, waiting, failed]
      - id: check
        actor_role: checker
        objective: 在准确候选版本上独立检查两个切片并记录证据；不得把实现方自检声称为评审
        depends_on: [cli]
        allowed_exits: [handoff, waiting, failed]
      - id: finish
        actor_role: owner
        objective: 核对准确的已检查候选版本，报告试用方式，并保留下一项已授权结果或明确报告没有后续结果
        depends_on: [check]
        allowed_exits: [done, waiting, failed]
```

`missions/csv-validation/slices/01-inspect/slice.yaml`——完整 YAML 示例：

```yaml
schema: openrig.slice/v0alpha1
kind: slice
metadata:
  id: inspect
composition:
  mission: ../../mission.yaml
  slice_markdown:
    spec: SPEC.md
    progress: PROGRESS.md
    proof: PROOF.md
```

`missions/csv-validation/slices/02-cli/slice.yaml`——完整 YAML 示例：

```yaml
schema: openrig.slice/v0alpha1
kind: slice
metadata:
  id: cli
composition:
  mission: ../../mission.yaml
  slice_markdown:
    spec: SPEC.md
    progress: PROGRESS.md
    proof: PROOF.md
```

以上是两个切片产物和四个协调步骤，而不是四个产品切片。`composition.slices` 中的顺序描述成员关系；运行时前置条件由 `steps[].depends_on` 提供。任务目标 graph 需要显式选择。编译器把这条受支持路径称为 `legacy-mission`；由于尚无项目自有的可复用 graph，它会发出 advisory，应保留该结果而不是掩盖它。不要同时添加切片 `execution` 契约：人工编写的任务目标 graph 优先于它们。显式 preferred target 可避免错误假设 starter 的 display label 已被声明为 topology role。使用两个地址前，必须对照已启动席位进行验证。

四个 `SPEC.md` 文件都必须以前文给出的完整 frontmatter 块开头，紧接表格中指定的正文。第一行必须是 `---`，出现在任何标题之前。refocus reader 需要开头存在字面量 `intent:` 字段；仅有 `## Intent` 标题无法满足要求。缺失字段必须在 trace 中保持可见。

`SPEC.md`——完整 frontmatter 示例：

```yaml
---
intent: 帮助用户在导入更改数据之前发现无效 CSV 输入。
---
```

`missions/csv-validation/SPEC.md`——完整 frontmatter 示例：

```yaml
---
id: OPR.99.0.1
mission: csv-validation
stage: wip
intent: 用户可以检查 CSV 并获得有用的验证结果，且不修改输入文件或导入数据。
depends_on: []
---
```

`missions/csv-validation/slices/01-inspect/SPEC.md`——完整 frontmatter 示例：

```yaml
---
id: OPR.99.0.1.1
slice: 01-inspect
mission: csv-validation
status: placeholder
stage: wip
intent: CSV 用户可以识别缺失的必填 header 并定位空白必填单元格，且不修改输入，也不选择待定的 CLI 策略。
depends_on: []
---
```

`missions/csv-validation/slices/02-cli/SPEC.md`——完整 frontmatter 示例：

```yaml
---
id: OPR.99.0.1.2
slice: 02-cli
mission: csv-validation
status: placeholder
stage: wip
intent: 用户可以通过现有 CLI 验证 CSV，获得有用的错误信息并采用已约定的空白单元格行为，同时保留输入数据。
depends_on: ["OPR.99.0.1.1"]
---
```

这些身份字段遵循随附的任务目标/切片模板和 scope reader，不是第二套 schema。示例 dot-ID 面向全新的空白示例；原生默认前缀是 `OPR`，`99.0.1` 是非发布任务目标的 escape band，不是本 CSV 产品的版本。在已经有内容的工作树中，应保留现有 ID，或使用 scope scaffold 给出的下一个可用身份，并同步更新相邻依赖。`mission: csv-validation` 和 `slice: 01-inspect` / `02-cli` 与目录身份一致；`status: placeholder` 和 `stage: wip` 声明初始规划状态。不要虚构 `verified` 或执行日期。项目 frontmatter 需要包含结果 `intent`；project catalog 身份仍是 `workspace.yaml` 中的 `csv-tool`，并与 `project.yaml` 的 `metadata.id` 对应。

Frontmatter 的 `depends_on` 使用同级工作 node 的 dot-ID，供发现/advisory 排序使用；它不会触发运行时调度，且纯路径 trace 不会沿这些 edge 查找。这与 manifest 成员关系/顺序、以及现有 workflow 步骤依赖 `cli -> inspect` 不同。任务目标 manifest 的 `metadata.name: csv-validation` 与切片 manifest metadata `inspect` / `cli` 保留原有生命周期含义。项目专用队列视图还要求实际 `project:csv-tool` 归属以及 mission/slice identity；frontmatter 不能凭空创建这种关联，也不能暗示运行时 packet 会自动获得标签。归属说明见随附的 `project-workspace.md` 参考中 “UI mapping” 和 “Queue mapping” 两节，以及 scope 模板。

四份 SPEC 文件的完整初始 Markdown 正文见下表，应放在对应 frontmatter 之后。每个标题均为字面固定内容，每个正文单元格则是该标题下的全部初始文本。工作开始前，应在这些正文中记录当前仓库真实路径和检查命令；公共示例中不包含任何私有安装权限。其他 Markdown 文件保留列出的初始内容；这些初始文件不声称存在任何状态 badge 或 proof registry。

| 相对于 `PROJECT_ROOT` 的文件 | 初始标题与正文 |
| --- | --- |
| `SPEC.md` | `# CSV tool`；`## Purpose`：“帮助用户在导入更改数据之前发现无效 CSV 输入。”`## Working agreement`：“保留现有仓库规则、数据和无关编辑。first-project owner 负责协调实现与连续性；dev-check 独立检查准确的累积候选版本。未解决的产品行为由用户决定。已经约定的本地实现、回归检查和评审无需重复批准；发布、破坏性数据变更和新的外部效果仍在本任务之外。行动前读取当前队列和任务目标；记录证据和未解决事实，不要虚构完成状态。” |
| `missions/csv-validation/SPEC.md` | `# CSV validation`；`## Intent`：“用户可以检查 CSV 并获得有用的验证结果，且不修改输入文件或导入数据。先实现纯检查结果，再通过现有 CLI 暴露。”`## Acceptance`：“缺少必填 header 时列出每个缺失列。有效输入通过。CLI 使用检查结果及选定的空白单元格规则，返回仓库规定的成功/失败状态，并保持输入字节不变。测试覆盖两个切片。一位独立 checker 记录准确候选版本、命令、结果和限制。owner 说明如何试用，并保留下一项工作的 custody。不执行发布。” |
| `missions/csv-validation/NOTES.md` | `# Decisions`；`## Blank required cells`：“PENDING——用户必须决定：已存在的必填列中如果包含空白单元格，应拒绝还是接受。切片 01 可以报告这些单元格，但不能选择 CLI 策略；切片 02 不得猜测 CLI 规则。在此记录用户的决定、时间戳和来源。” |
| `missions/csv-validation/PROGRESS.md` | `# Progress`；`## Current position`：“已规划；尚无实现、运行时实例或评审结果。观察到结果后，记录 operation key、instance/frontier ID、当前 owner、候选版本和下一步动作。” |
| `missions/csv-validation/slices/01-inspect/SPEC.md` | `# Inspect CSV`；`## Intent`：“使用仓库现有 CSV 处理方式新增或调整纯检查函数。返回缺失的必填 header，以及空白必填单元格的行/列位置；不要修改输入，也不要选择仍待决定的 CLI 空白单元格策略。”`## Acceptance`：“缺少 header、有效输入、带引号字段和空白单元格场景都会生成规定结果。输入字节与现有导入行为保持不变。为累积候选版本 checker 记录实际命令和候选版本。” |
| `missions/csv-validation/slices/02-cli/SPEC.md` | `# CLI validation`；`## Intent`：“通过现有 CLI 暴露切片 01 的检查结果。复用其结果，不要实现第二个 parser。选择 CLI 结果前，与用户解决 `../../NOTES.md#blank-required-cells`。”`## Acceptance`：“CLI 列出缺失列，应用已记录的空白单元格规则，使用规定退出状态并保持输入字节不变。针对性有效/无效场景和现有相关回归检查，在交给 dev-check 的候选版本上通过。” |
| 两个切片的 `PROGRESS.md` | `# Progress`；`## Current position`：“已规划；尚未声称任何实现或证明。随着工作推进，记录准确候选版本、已完成检查、开放依赖和当前队列 packet。” |
| 两个切片的 `PROOF.md` | `# Proof`；`## Evidence`：“尚无证据。对每项已执行检查，记录候选版本、命令、结果、证据路径和限制。独立 checker 单独标注自己的判断，不与作者检查混在一起。” |

CLI 实现界面和检查命令是从仓库推导出的事实，不是新的通用代码模板。

## Bootstrap、上下文与重新聚焦

1. **当前智能体：**检查所选安装、仓库指令和现有 project catalog。按需使用 `zrig --help`、`zrig config get workspace.root`、`zrig config get workspace.catalog_path`、`zrig config get workspace.slices_root` 和 `zrig workspace doctor`。如果工作树尚不存在，预览增量命令 `zrig config init-workspace --root <chosen-root> --dry-run`。该脚手架不会绑定根目录，也不会提供上面的 metadata/lifecycle graph。设置预期实例时，应使用普通 config help，只将目标实例绑定到所选 workspace/catalog/slices root；保留其他 catalog 条目。不得静默把共享后台服务指向另一个项目。Scope creation helper 可以写入骨架，但编译前必须检查并补全实际 manifest。
2. **当前智能体，在用户已有授权范围内：**执行公共指南中的前置步骤和权限选择一次，预览 `first-project`，用真实代码 cwd 规划，然后有意启动。推导两个在线地址和原生就绪状态。复用现有合适席位，不要仅为清除提示而启动重复席位。后台服务/kernel 就绪与每个原生席位就绪是不同事实。
3. **Owner 和 checker：**读取仓库指令与相关意图，自行推导身份和队列。例如 owner 可以运行 `zrig context work-install --project csv-tool --mission csv-validation --slice 01-inspect --deliver --runtime codex --cwd <actual-code-root> --json`；依赖工作使用 `02-cli`，并向 checker 提供两个准确切片地址。`--deliver` 将组合后的字节返回给调用者，它不是传输确认。不要仅为了让示例工作而使用 `--apply-skills`。`install.skills: []` 不增加任何私有或虚构的 skill 要求；照常发现适用公共 skill。
4. **Bootstrap 上下文交付：**向两个席位发送简短指令，点明准确工作根目录和需要获取的带地址文件；分配实现之前，先取得它们对 scope/role 的回应。已注册 context pack 可以通过 `zrig send --context <discovered-ref>` 发送；任意文件系统地址不会自动成为 context-pack ref。接收方无法自行获取时，应交付实际组合后的字节。指令交付与队列所有权应保持分离。
5. **最小持久拓扑上下文：**推导 `topology.root`，然后保留现有 chain 文件。在新的专用示例实例中，把 purpose/root 指针放进 `LEARNED.md`，把双席位关系放进 `rigs/first-project/LEARNED.md`，并在 `rigs/first-project/seats/dev-owner/LEARNED.md` 和 `.../dev-check/LEARNED.md` 中写入简短职责。Owner 文本：“负责用户限定的结果、实现、准确检查交接、结果及下一项工作 custody；推导当前 packet。”Checker 文本：“根据 project/mission/slice 验收条件，独立判断所提供候选版本，记录证据与限制，并返回判断，不自行领取更广泛工作。”Rig 文本指向用户的 `SPEC.md#working-agreement` 和活动任务目标；实例文本指向已配置工作根目录。不要把状态 roster 复制进这些文件。不需要可选 pod 文件和八区域目录树。
6. **Refocus 交付：**使用在所选实例参考目录下发现的公共 `refocus-channel.md` 和 `chain-file-convention.md`。普通 hook 会推导根目录，并在支持的 prompt/compaction 边界发出指针；这不表示已经读取了编辑后的文件。要求每个席位在 bootstrap 阶段运行发现的公共 refocusing 过程并读取相关具名事实源一次，同时记录任何 trace 缺口。现有运行中席位不会继承 shell 环境编辑。任何显式 `OPENRIG_REFOCUS_WORK_NODE` 或内容 override 都应放在有意配置的启动上下文中，不能声称在发送方设置它就改变了另一个席位。

## 有意创建运行时并如实延续

选择 Workflow 路径后，由**实际 owner 席位**在完成上下文与地址检查后运行以下命令。只有其自身 `zrig whoami --json` 已确认 `dev-owner@first-project`，才能使用下方示例地址；未绑定的 bootstrap shell 不得冒充该席位。`PROJECT_ROOT` 是保存所选绝对工作根目录的普通任务变量。选择一个唯一 operation key 并记录一次；发生 timeout 后继续复用。对所选 graph 使用以下命令：

```sh
zrig workflow compile "$PROJECT_ROOT/missions/csv-validation/mission.yaml" \
  --operation-key csv-tool-csv-validation-run-1 --json

zrig workflow instantiate-lifecycle "$PROJECT_ROOT/missions/csv-validation/mission.yaml" \
  --operation-key csv-tool-csv-validation-run-1 \
  --root-objective '在不修改输入数据的前提下完成经过评审的 CSV 验证' \
  --created-by dev-owner@first-project --rig first-project --json

zrig workflow operation csv-tool-csv-validation-run-1 --json
zrig workflow continue <returned-instance-id> --json
```

检查 compilation identity、所有 source path/digest、四个步骤、前置条件、已解析或显式未解析的路由、advisory 和 `eligible`。仅存在文件并不够。如果 compilation 不 eligible，应在用户授权范围内修正点名的编写问题；不要通过猜测另一个 graph 来实例化。创建实例和入口队列条目的是 lifecycle 命令，而不是之前的 scope 编辑或 compile。回读返回的 packet 和 owner，按正常流程 claim；保留任何初始持久 bootstrap task 与该运行时之间的关联，不要留下两个互相竞争的实现义务。

每个步骤完成时，由**当前 packet owner**投影自己的结果。以下是 owner 完成切片 01 的示例；packet ID 来自在线回读：

```sh
zrig workflow project --instance <instance-id> --current-packet <inspect-packet> \
  --exit handoff --actor-session dev-owner@first-project \
  --result-note '已实现检查契约，并记录准确候选版本和检查结果' \
  --evidence-ref <absolute-slice-01-proof-path> --json
```

工作前先读取生成的 `cli` packet。通用 `zrig queue handoff` 不能替代推进 workflow-bound packet。`workflow continue` 只执行检查，不会运行步骤。推进时，owner 必须携带 source/candidate/evidence 和准确的第二切片上下文；不得把第一次实现交接描述为独立验收。

如果确实存在**尚未解决的空白单元格产品选择**，应向用户提出具体问题并记录请求。`cli` packet 的 owner 可以使用显式 blocker 暂停它：

```sh
zrig workflow project --instance <instance-id> --current-packet <cli-packet> \
  --exit waiting --actor-session dev-owner@first-project \
  --blocked-on external:user/blank-required-cells \
  --result-note '选择 CLI 行为前，需要把用户决定记录到任务目标 NOTES 中' \
  --evidence-ref <absolute-mission-notes-path> --json
```

回读 waiting 状态、blocker、owner 和保留的 frontier packet。timer 或 reminder 不是用户答案。真实决定到达后，将其保存在 NOTES 中，读取同一 frontier，完成同一步骤并使用其允许的 `handoff` exit；不要再次实例化，也不要声称 `workflow resume` 是等待动词，该命令用于失败实例恢复。如果仓库已经确定选择，就使用该决定继续；不要虚构一次等待。

Checker 接收累积候选版本、两份 proof 文件、准确的已接受决定和可复现检查。它如实执行 `handoff` 后推进到 `finish`；owner 报告准确的已检查 cut，以及用户如何试用。检查失败时应如实记录，通过选定的异常路径路由给 owner，并使用现有失败/修复 continuation 解决。有边界修复期间保持同一 checker 和结果，且实现/检查交换始终归属该 owner 与 checker。Workflow 进入终态本身，不能证明用户结果已通过。

在 `finish` 步骤，owner 记录完成并使用 `done`。之后，人类可以向同一地址发送下一项有边界的结果，并引用之前结果。owner 创建/领取其持久任务，并确认真实边界；不是每个小变更都需要再创建一个任务目标或完整 workflow。如果没有其他授权工作，应明确记录没有下一项工作。

## 安全停止

停止前，读取每个席位的当前队列，并保留候选版本、证据、下一位 owner 和准确 resume 步骤。不得静默遗弃进行中的命令或已领取义务。使用 `zrig context get skills/core/rig-lifecycle/SKILL.md` 获取兼容的生命周期指南，并检查 `zrig down --help`。用户授权停止团队后，对准确的工作组执行 `zrig down <verified-rig>`，再回读报告状态。保留仓库、上下文和证据；停止不等于删除。以后执行 `zrig up <verified-rig>` 时，必须先进行真实原生就绪检查，再继续工作。Resume 失败应记录为失败，不得静默替换原会话。

## 可选扩展，但继续使用相同的两个席位

当相同协调义务反复出现时，把可复用 workflow 移到 `project.yaml` 的 `lifecycle.profiles.small-change-v1` 下，包含 `required_steps: [check, finish]` 和 `workflow` mapping；保留 `lifecycle.profile: small-change-v1`。从可复用 base 中移除任务目标特定路径/目标，通过每个任务目标的 context/arrangement 提供。任务目标可以原样继承，也可以显式使用 `mode: extend` 添加名称唯一的步骤，或使用 `mode: override` 提供仍保留必要义务的完整 arrangement。`required_steps` 指真实稳定 step ID，不是正文标题。本可选设计并不是本示例中第二个已验证 manifest。

切片继续作为 work/spec/progress/proof 的归属位置。如果项目改为选择逐切片 execution，原生编译器支持 `execution.actor_role`、`preferred_targets`、`depends_on` 和 `allowed_exits`；但不能暗示它们会在已经选定的 mission/profile graph 下独立增加步骤。编译选定的唯一 graph，检查结果，然后实例化或明确修订现有实例。保留的运行输入不会静默跟随磁盘编辑变化。只有用户工作确实需要时，才增加更多角色、SDLC 建议、类型化 gate 或发布义务。第一个示例不包含强制 wave、release graph、私有生命周期 helper 或七席位工厂。
