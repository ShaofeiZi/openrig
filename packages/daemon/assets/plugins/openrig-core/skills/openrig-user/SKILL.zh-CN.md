---
name: openrig-user
description: >-
  当你已经知道具体的 `zrig` 命令、子命令或标志，需要查询其准确语法、JSON 结构、默认值或错误含义时使用。
  不适用于自然语言式的能力探索、开放式的“如何操作”问题，也不适用于判断应该采取哪一种 OpenRig 操作。
---

# OpenRig 用户指南

这是已发布 `zrig` CLI 的按实际实现编写的指南。
如果本文与较早的规划文档存在冲突，请以当前代码和 `zrig ... --help` 为准。

如需更改 OpenRig 的行为、原则或发布策略，请使用 OpenRig 构建者指南。


## 协作信任边界

应在你实际控制的信任边界允许范围内尽可能开放地协作。如果一组机器都归你所有、彼此已经信任——它们能访问彼此的 daemon URL，且 daemon 本身不要求身份验证——那么直接使用 `zrig send`、`zrig capture` 和 `zrig queue` 就应该能够工作。不要凭空添加环境并不要求的 bearer 占位符、允许列表、信任握手或访客访问限制。

不要在无法说明受保护资产、真实攻击者、被阻断的攻击路径以及具体后果的情况下新增或维护限制。能力缺失并不等于保护——应直接修复路由、注册、运行时姿态或产品缺陷。任意设置边界会导致约束诱发的绕行：在目标压力下，agent 会构建影子传输通道、替代凭证和更弱的证明，而不是使用直接获准的路径。只保留明确声明的外部或不可逆边界——公开推送 / PR / 发布，以及销毁规范数据。

## 协作原语——何时使用哪一种

下面三种协作界面应配合使用，以持续推进工作。第一次阅读时就要将其内化——它们会影响你在 rig 中采取的每一步行动。

### `zrig send <seat> "<text>"`——pod 内直接消息 / 提醒

需要快速提问或向队友提供不带移交语义的上下文时使用。**不得用于持久工作。**不得承载必须跨轮次保存的状态。消息会进入目标窗格，但不会产生持久队列记录。CLI 会输出 `Sent to ...`（使用 `--verify` 时还会输出 `Verified: yes/no`）；读取回执后继续工作。

示例：

```bash
zrig send dev-reviewer@example-project "The import report is ready; the durable handoff names its evidence." --verify
```

### `zrig queue create --destination <Y> --tags <...> --body-file <path>`——持久工作项

任何不能随聊天丢失的实质性工作都应使用它——切片移交、守卫结论、QA 结果、完整 tip 审查、多项批次。它能跨 agent 重启保存，记录在 daemon SQLite schema 中，并显示在 Project / queue 视图以及目标席位的收件箱里。使用 mission / slice / gate / checkpoint 标签，使未来的你（以及任何同伴）能够找到它。

正文规范：实质性正文应通过 **`--body-file <path>`**（或以 `-` 表示 stdin）传入——这是专门设计、可避免内容损坏的界面（能消除多行正文因反引号遭 shell 处理而损坏的问题）。不要通过 `--body` 内联包含大量反引号或多行的正文：`zrig queue create` 的正文解析会因未转义反引号而损坏，并拒绝类似标志的 token。

示例：

```bash
zrig queue create \
  --destination dev-reviewer@example-project \
  --tags "mission:data-import,slice:import-report" \
  --body-file /tmp/import-report-handoff.md
```

### `zrig queue handoff <qitem-id> --to <next> ...`——接力式移交

当你已完成自己在某个 qitem 上的回合，工作需要转给下一位负责人时使用。**这就是向前推进。**任务会传给目标席位；记录链（前一个 qitem id）会保留下来，确保判定轨迹完整；标签会把所选工作上下文继续传递下去。Gate 标签描述为这项工作实际选择的检查，并不要求固定的角色顺序。

示例：

```bash
zrig queue handoff <qitem-id> \
  --to dev-reviewer@example-project \
  --tags "mission:data-import,slice:import-report" \
  --body-file /tmp/import-report-handoff.md
```

### §1b 原则——回合以传球结束

**回合应以传球结束，绝不能在仍持有切片时闲置，等待所选流程并不包含的确认。**遵循当前的 `mission-slice-sop`：默认执行与工作规模相称的负责人检查；如选择独立审查，则在编写者划定的工作边界执行。角色名称不会自动增加每次提交的守卫、QA 或编排关卡。完成获准的工作，运行所选检查，并通过持久托管方式返回结果。

只有以下情况可以暂停：

- 遇到真实阻塞——针对造成阻塞的同伴提交 blocked-state qitem，或明确上报给 orch。
- 遇到需要负责人输入且会改变计划的范围或架构问题——将所需的具体决策上报给 orch。

实施已经获准的工作不属于以上任何一种情况。不要凭空设置流程并不要求的“下一条提示”或“操作员确认”门槛，应继续推进。

### 反模式

- 使用 `zrig send` 承载持久工作 → 改用 `zrig queue create`。send 无法跨重启保留，也不会显示在 queue/project 视图中。
- 持有切片空等流程并不要求的“下一条提示”或“操作员确认” → 通过 `zrig queue handoff` 传球，然后继续下一个切片或等待传入的结论。参见上面的 §1b 原则。
- 将多行 / 含大量反引号的正文内联到 `zrig queue create --body` → 使用 `--body-file /tmp/<descriptive-name>.txt`（或以 `-` 表示 stdin），这是避免内容损坏的界面。正文解析器不能接受内联的原始反引号或类似标志的 token。

## 受运行时约束的协作原语

OpenRig v0.3.1 已作为 `@openrig/cli@0.3.1` 和 GitHub Release `v0.3.1` 公开发布。它包含捆绑的 PL-004 协作原语系统：阶段 A `zrig stream` / `zrig queue`，阶段 B `zrig project` / `zrig view`，阶段 C `zrig watchdog`，以及阶段 D `zrig workflow` / `workflow-keepalive`。

这些是 v0.3.x 中已发布的产品界面，但在运行时需要兼容的 v0.3.x daemon 和匹配的 SQLite schema——安装的软件包版本并不自动等同于为你提供服务的 daemon 版本。如果某个协作命令表现异常，请先通过 `zrig whoami --json` 和 daemon 状态确认正在运行的 daemon，再判断是否为产品缺陷。

默认做法：

- 当活动 daemon 为 v0.2.0 或更高版本时，将 daemon 的 `zrig queue`、`zrig stream`、`zrig project`、`zrig view`、`zrig watchdog` 和 `zrig workflow` 视为产品协作界面。
- 使用 daemon 支持的 `zrig queue` 进行持久路由。`update / show / list` 是对 `create / handoff` 的检查和状态变更补充；无关存储中的记录不能证明该 daemon 拥有这项工作。
- 如果 daemon 支持的协作命令失败，应直接调试命令 / 运行时 / schema 边界；不要想当然地退回配置层原语。
- 除非操作员或工作流已明确授权相应关卡，否则不要执行 daemon 停止/启动、生产数据库复制/变更、release、publish 或其他具有后果边界的操作。

## 首位用户的工作区设置

在某台主机上启动进入 rig 时，如果工作区未设置、存在缺口或指向过时布局，应先处理该问题，再开展实质性项目工作。已发布的界面小而有界——使用规范命令，不要自行拼凑。

### 启动时检测工作区状态

daemon 可访问时可由 agent 执行。

```bash
zrig workspace validate --json
zrig workspace validate <path> --kind <user|project|knowledge|lab|delivery> --json
```

`zrig workspace validate` 会遍历工作区根目录，并根据 v0 契约输出结构化的 frontmatter 缺口报告。存在缺口时退出码非零（操作员可将其串入卫生修复循环）。默认根目录为当前目录；传入位置参数路径可验证其他位置。`--kind` 将契约限定为特定工作区类型；省略则执行与类型无关的结构检查。

如果 `zrig workspace validate` 报告非零 `gapCount`，或者工作区根目录未设置 / 不可写，则需要实例化工作区——参见下一节。

### 实例化规范工作区脚手架

可由 agent 执行。该操作仅添加内容，并保留现有文件。

```bash
zrig config init-workspace
zrig config init-workspace --root <path>
zrig config init-workspace --dry-run --json
```

`zrig config init-workspace` 会在配置的 `workspace.root`（默认 `~/.openrig/workspace`）下搭建规范工作区布局：

- `missions/`——发布任务及切片
- `exhaust/`——项目本地的协作排放物
- `SPEC.md`——项目意图
- `project.yaml`——项目目录选择与任务根目录
- `workspace.yaml`——项目注册信息
- `.gitignore`——本地 OpenRig 状态和排放物排除项

`--root <path>` 为本次调用指定非默认根目录；`--dry-run` 报告将创建的内容而不写入。`--force` 是已弃用的兼容选项，仍会保留现有文件。

### 重定向工作区根目录

持久设置须由操作员授权。通过环境变量进行单次设置时可由 agent 执行。

对单个命令：

```bash
OPENRIG_WORKSPACE_ROOT=<path> zrig <command> ...
```

对于持久的主机级重定向，由操作员修改配置文件或运行设置命令：

```bash
zrig config set workspace.root <path>
```

ConfigStore 优先级为：`OPENRIG_WORKSPACE_ROOT` 环境变量 > 配置文件中的 `workspace.root` > 内置默认值 `~/.openrig/workspace`。同样的优先级也控制 `OPENRIG_WORKSPACE_SPECS_ROOT` → `workspace.specs_root`（默认 `<workspace_root>/specs`）。

单次重定向应优先使用环境变量形式（对操作员透明）；只有操作员负责的变更才使用 `zrig config set`。

### 从零构建工作区

可由 agent 执行。使用与上述规范脚手架相同的界面；`workspace.root` 级联规则会处理主机上不存在的路径。

```bash
zrig config init-workspace --root /path/to/new/workspace
```

该命令以增量方式创建缺少的规范条目，并保留所有现有条目；仅在六个条目均已齐全时无操作。随后运行 `zrig workspace validate /path/to/new/workspace --json`，确认契约成立。

### 在现有工作区中创建工作流

工作流可由操作员或 agent 编写；验证与实例化可由 agent 执行。

工作流规范文件位于：

```
<workspace_root>/specs/workflows/<name>.yaml
```

`<workspace_root>` 按上述 ConfigStore 优先级解析。v0.3.x 中没有 `zrig workflow create` 动词——规范 YAML 需要直接编写。可以依据文档中的 schema 手工创建模板，也可以从 `<openrig install>/dist/builtins/workflow-specs/` 复制内置起始模板并调整。写入后执行：

```bash
zrig workflow validate <workspace_root>/specs/workflows/<name>.yaml --json

zrig workflow instantiate <workspace_root>/specs/workflows/<name>.yaml \
  --root-objective "<one-line objective for the run>" \
  --created-by <your-session>@<your-rig> \
  --json
```

`instantiate` **必须**同时提供 `--root-objective <text>` 和 `--created-by <session>`——缺少任一项都会在联系 daemon 之前触发 Commander 必需选项错误。`--entry-owner <session>` 可选择性覆盖入口步骤负责人；默认路由遵循工作流规范。

`validate` 返回结构化的成功/错误报告；`instantiate` 创建工作流实例和入口步骤 qitem。使用以下命令检查现有界面状态：

```bash
zrig workflow specs --json              # 列出已注册规范（内置 + 操作员编写）
zrig workflow list --json               # 列出活动工作流实例
zrig workflow show <instanceId> --json  # 检查单个实例
zrig workflow project <instanceId>      # 推进实例——投射下一步数据包
zrig workflow continue <instanceId>     # 实例的只读检查器（不会推进）
```

*（界面说明——当前 `zrig workflow` 命令组注册了 **13** 个子命令：`validate`、`instantiate`、`project`、`list`、`specs`、`show`、`trace`、`continue`、`run`、`watch`、`route`、`resume`、`status`。仍然没有 `create` 动词——规范 YAML 直接在磁盘上编写。`project` 是推进动词（投射下一步数据包）；`continue` 是只读检查器，不会推进——不要混淆二者。这 13 个动词以及 project 与 continue 的语义已经对照当前产品 main `d37a08ad` 验证（`packages/cli/src/commands/workflow.ts` 中注册了 13 个 `.command(...)` 条目；此前本文所称“6 个动词的界面 / continue 会推进”已经过时）。请使用 `zrig workflow --help` 验证各子命令的标志。）*

## 权限策略——设置（onboarding）时选择一种

OpenRig 只为 harness 权限设置一个**最低可用基线**，除此之外不加干涉——同时提供由你主动选择的**推荐策略**。它绝不会替你固化权限策略。安装 / onboarding 时必须在顶层作出以下选择：

- **POLICY MODE**——选择并应用一个内置策略：
  - **Locked**——默认拒绝的白名单；用于不受信任的 rig / 工作。
  - **Standard** ⭐（推荐）——允许包括 push 在内的日常开发操作；创建 PR、发布、合并/release、强制推送和破坏性操作需要询问。
  - **Open**——默认允许；仅明确属于破坏性的操作需要询问。

  内置定义以只读策略规范文件（Locked / Standard / Open）的形式提供；应用所选策略由 **`applying-a-permission-policy`** 技能负责——它会以交互方式将选定规范转换为当前 harness 配置（Claude `settings.json` / Codex `config.toml`），并在写入前展示差异。
- **YOLO MODE**——不想再处理权限、只想让它工作：OpenRig 使用 harness 的完全绕过启动标志启动每个席位。不应用任何配置策略（绕过会覆盖策略）。这是确定性的 OpenRig 设置，不是技能。
- **不作选择 = 最低基线**——最低可用基线（Claude `acceptEdits` / Codex 仅限工作区 / Pi `--no-approve`），只有一套一致的最低权限，不附加其他内容。

最低基线和 YOLO 是 OpenRig 确定性设置的**启动标志**；Locked / Standard / Open 策略则是由技能应用的**配置文件**策略（由 agent 驱动，因为 harness 配置格式会变化）。rig 会在其规范中**携带**所选策略，并按该策略启动——参见“生命周期 → 启动 rig”。要（重新）应用或更改策略，请打开 **`applying-a-permission-policy`**。

## v0.3.x 起始模板、工作区和插件界面

OpenRig v0.3.0 新增 `zrig agent-image`、`zrig context-pack`、`zrig workspace` 和 `zrig config init-workspace`。*（0.5.0：`zrig context-pack` 别名已停用——store + compose 库统一使用 `zrig context` 这一名词；参见“上下文包与节奏化交付（0.5.0）”。）*此外，新用户起始指南改为推荐 `product-team` 处理人工指引的工作，推荐 `conveyor` 处理工作流导向的工作。除非任务明确要求旧 demo 规范，否则应将 `demo` 视为遗留/测试内容。

OpenRig v0.3.1 为 Plugin Primitive v0、Claude 自动压缩策略、迁移 `040_workflow_specs_diagnostic`、Library Explorer 收尾、Settings Destination Explorer、Dashboard/For You 羊皮纸风格刷新、storytelling adapter，以及 action outcome + inline error UX 新增了公开的软件包/源码界面。

`zrig plugin` 在 v0 中是只读的：

```bash
zrig plugin list
zrig plugin show <id>
zrig plugin used-by <id>
zrig plugin validate <path>
```

v0.3.1 中没有 `zrig plugin install` 动词。插件安装仍需由操作员明确复制/创建符号链接到 `$OPENRIG_HOME/plugins/<plugin-id>/`。

v0.3.1 软件包通过 `policies.claude_compaction.*` ConfigStore key 引入可选启用的 Claude 自动压缩策略。仅凭软件包版本无法说明正在运行的 daemon 配置；依赖某项策略或其默认值之前，请检查所选实例。

兼容性检查：
- `zrig down` 接受 rig 名称或 id。如果名称不明确、匹配多个活动 rig，命令会拒绝执行并列出匹配的 id；请改用目标 id。
- 对于 queue/view JSON 或 limit 差异，应比较已安装命令的帮助、运行中 daemon 的版本和实际响应。wrapper 不匹配本身不等于 daemon 健康故障，历史 workaround 也不能保证当前行为。
- 启动超时后，应先检查状态和日志再重试；超时本身无法证明底层操作是否已完成。

## 恢复与韧性（v0.3.4+）

v0.3.4 的主题是恢复 + 韧性。以下界面组合为一条从启动到 rig 正常运行的完整路径，能够承受崩溃、手工恢复的会话、profile 加载漂移和不完整的工作区状态，同时不会用不实状态掩盖问题。

### `zrig start`——恢复入口

`zrig start` 是顶层恢复序列器。它不会凭空发明恢复能力；而是将现有原语（daemon 启动 + kernel 验证 + 按 rig 恢复）组合为一次调用。

```bash
zrig start                    # 交互式：daemon + kernel + 选择并恢复
zrig start --last             # 无交互：恢复上次运行的所有 rig
zrig start --all              # 无交互：恢复所有具有可用恢复快照的 rig
zrig start --rigs <name> [<name>...]   # 无交互：仅恢复指定 rig
zrig start --json             # 面向 agent 的 JSON 输出
```

定位：`zrig start` 是**恢复**入口，不是新手入门主命令。新用户启动主命令仍为 `zrig up <starter>`（通常是 `zrig up product-team`）。主机重启、daemon 重启或任何“恢复我的 rig”场景应使用 `zrig start`。

### `zrig reconcile-session`——不启动进程地接管手工恢复的会话

当操作员已从外部恢复某个 agent 会话（例如连接 shell、手工重启 runtime），希望 OpenRig 协调其生命周期状态但不重新启动或发送输入时，请使用：

```bash
zrig reconcile-session <session>
zrig reconcile-session <session> --rig <rigId> --node <logicalId>
zrig reconcile-session <session> --no-launch
zrig reconcile-session <session> --json
```

这是不启动、不输入的接管操作。规范会话名无法唯一解析时，可用 `--rig`/`--node` 消除歧义。`--no-launch` 用于明确表达意图（该命令只有这一种模式）。

### 五项恢复状态词汇

已发布的恢复词汇有意如实反映状态。它们会出现在 `zrig up` / `zrig restore` / `zrig ps` 中。请使用准确术语，不要一律简化为“成功/失败”：

- `resumed`——席位已从原始会话/快照恢复并处于活动状态。
- `fresh-primed`——席位通过 `--fresh` 主动选择了全新启动。
- `awaiting-decision`——诚实的零会话状态。不存在可恢复会话，同时也未提供 `--fresh` 选择；席位正在等待操作员决定。此前将它伪装成 `failed` 是错误的——没有任何东西损坏，系统只是在请求输入。
- `attention_required`——席位处于需要操作员关注的状态；不是传输失败。问题解决后，可通过 `zrig seat clear-attention` 清除。
- `failed`——发送传输或启动确实失败。

这替代了此前被折叠的模型（v0.3.3 的四项词汇中包含 `rebuilt`，现已停用）。

### `zrig seat clear-attention`——以审计方式协调卡住的关注状态

席位卡在 `attention_required` 时，**不要**手工编辑 SQLite 来伪造状态清除。请使用经过证据门控、有操作员证明且可审计的协调操作：

```bash
zrig seat clear-attention <session>
zrig seat clear-attention <session> --reason "operator attested: the operator re-authed, confirmed live"
zrig seat clear-attention <session> --json
```

`--reason <text>` 是操作员证明覆盖路径；不提供时，命令会运行证据关卡。无论采用哪种方式，该操作都会留有审计记录。

### 周期快照——崩溃保险基线

daemon 提供周期快照调度器。它独立于 teardown 事件运行，提供了以往仅靠事件/teardown 快照无法在硬崩溃中实现的崩溃保险基线。

配置 key（SettingsStore）：
- `snapshots.periodic.enabled`——默认 `true`
- `snapshots.periodic.interval_seconds`——默认 `300`
- `snapshots.periodic.retention_keep`——默认 `10`

最新者优先语义：当某个 rig 同时存在 `auto-periodic` 和 `auto-pre-down` 快照时，选择两者中最新的快照恢复。较新的 `auto-periodic` 会优先于过时的 `auto-pre-down`（这是崩溃修复）；在正常关闭流程中，真正更新的 `auto-pre-down` 仍会胜出。手工快照单独处理。排序规则参见 `packages/daemon/src/domain/snapshot-repository.ts`。

最近快照基线会显示在 `zrig ps` / 状态输出中，让操作员一眼看出崩溃保险基线的新旧程度。

### Codex profile-v2 预检

带 profile 的启动/恢复界面会运行 profile 加载预检。检测到 profile 加载问题时，会如实返回可操作的失败信息（具名错误 + 修复指针），而不是悄悄进行不完整启动，导致之后看起来像一个没有解释的 `attention_required` 席位。

### cmux 启动就绪性

cmux 支持的启动不再产生无提示的不完整工作区状态。当工作区缺少部分内容时，启动流程会如实显示不完整状态，UI 还会提供一键打开缺失项的操作入口。

（另请参见下方 `## Token 高效默认值（v0.4.0+）`，了解 0.4.0 引入的读取命令默认紧凑界面。）

## Token 高效默认值（v0.4.0+）

v0.4.0 将五个最常调用的读取命令从默认倾泻全部内容改为默认紧凑输出，同时 `zrig queue list` 采用 docker / kubectl 的读取命令语法。**所有默认值都保留完整广度和能力——只需一个明确标志即可查看全部内容。**

### `zrig ps`——感知范围：裸 `zrig ps` = 所有 rig；`--nodes` = 仅当前 rig

```bash
zrig ps                      # 主机上的所有活动 rig，每个一行紧凑信息——先运行它以了解全局
zrig ps --rig <name>         # 一个指定 rig 的摘要
zrig ps --nodes --rig <name> # 指定 rig 的逐节点（席位）详情——常规深入查看方式
zrig ps --nodes              # 逐节点详情——仅当前 rig（有意收窄；不是整台主机）
zrig ps --json               # 紧凑 JSON（默认是所有未归档 rig 的裸数组）
zrig ps --nodes -A           # 跨 rig 节点清单（曾是 v0.3.4 默认值）
zrig ps --nodes --full       # 完整记录（v0.3.4 的逐节点默认结构；为下游消费者保留 resumeToken 的值）
zrig ps --nodes --session <sess>  # 收窄到一个规范会话
zrig ps --active             # 主动启用活动状态过滤（不会改变全状态默认值——ps 展示拓扑/就绪性，停止/可恢复/需关注状态正是可操作信号）
```

**v0.4.0 的广度 + 投影变更**：
- **rig 级 `zrig ps` 会列出所有活动 rig**（每个一行——成本低廉的“了解全局”视图）。**`--nodes`（逐席位）视图默认只显示当前 rig**（从 `OPENRIG_SESSION_NAME` 的 `@<rig>` 后缀推导）；`--rig <name>` 选择另一个 rig，`-A` 将 `--nodes` 扩展到整台主机（成本较高——优先配合 `--fields`/`--limit`）。
- **逐节点 TL;DR 投影（紧凑）成为默认值**；`--full` 返回原始、字节等价的透传结果。daemon 端的 `recoveryGuidance` 已移至按引用组织的指导映射（不再在每个节点重复）——即使 `--full` 也能受益。
- **全状态仍是默认值**（不同于默认只显示活动项的 `zrig queue list`）——对于 `ps`，非运行状态往往正是可操作信号。
- **恢复 token 安全**：`--full` JSON 会输出 `resumeTokenPresent`（布尔值）——实际的 `resumeToken` 值也会保留在 `--full` 中，供确有需要的下游消费者使用，但紧凑默认输出绝不会携带该值（orch 随手查看时不会意外泄露 token 材料）。

**⚠ 范围意识——最容易踩坑的一点：**`zrig ps --nodes`（以及 `--nodes --json`）按设计只显示当前 rig 的席位——窄默认值用于保护上下文窗口。**窄输出不代表整个世界。**绝不能根据一次 `--nodes` 读取就断言“我的 rig 是主机上的唯一 rig”；应先运行裸 `zrig ps`（成本低，会列出所有 rig），再对需要的对象运行 `zrig ps --nodes --rig <name>`。（`-A` 可扩展到整台主机的节点视图；需要这种广度时再使用。）

### `zrig whoami`——默认紧凑 + `--full`（`--verbose` 别名）

```bash
zrig whoami                  # 紧凑：身份 + 同伴名称 + 边 + transcript 路径
zrig whoami --json           # 紧凑 JSON
zrig whoami --full           # 完整 payload（v0.3.4 默认结构）
zrig whoami --verbose        # --full 的别名
```

这是每个 agent 在启动以及每次压缩恢复后运行的第一条命令。紧凑默认值保留身份恢复必需信息（`identity`、`peers` 名称 + sessionName、`edges` 的方向性 `kind` + `to.sessionName`、`transcriptPath`）。`--full` 还会加入 `contextUsage`、`commands`、`peersNote`、`runtimeContext`。紧凑默认输出采用**允许列表投影**——未来新增的 payload 字段默认只进入 `--full`，无法悄悄让每次启动路径再次膨胀。

### `zrig queue list`——活动前沿 + docker/kubectl 语法

```bash
zrig queue list                       # 活动、紧凑、当前 rig（docker ps 默认风格）
zrig queue list -a                    # 在当前广度内加入 closed/done 历史（docker -a）
zrig queue list -A                    # 跨 rig 广度（kubectl -A）
zrig queue list --full                # 加入正文 + 记录链 + 转换历史
zrig queue list -o json               # 紧凑 JSON（token 安全、机器可解析）
zrig queue list --full -o json        # 完整 JSON
zrig queue list --mine                # 仅调用方自己的条目
zrig queue list --destination <s>     # 目标为 <s> 的条目
zrig queue list --source <s>          # 来源为 <s> 的条目
zrig queue show <qitemId>             # 有界的单项正文预览
zrig queue show <qitemId> --full      # 完整正文和记录链字段
```

四个彼此正交且可组合的维度（范围 × 历史 × 字段广度 × 编码）。**停止把裸 `zrig queue list` 当成跨 rig 的全量输出。**现在默认是活动 + 紧凑 + 当前 rig。包含完整正文的跨 rig 历史需要明确使用 `-A -a --full`；只请求当前问题需要的广度和字段。

### `zrig restore-check`——摘要 + 默认仅显示未就绪项 + `--full`

```bash
zrig restore-check               # 摘要计数 + 仅未就绪席位（附原因）
zrig restore-check --full        # 整个 fleet 的完整逐席位就绪信息（v0.3.4 默认值）
zrig restore-check --rig <name>  # 收窄范围
zrig restore-check --as <session>  # 收窄到一个席位
```

摘要会保留未就绪席位及其原因；需要时可用 `--full` 添加已就绪席位的详情。先收窄查询范围，再扩展 payload。

### `zrig context`——上下文窗口用量查看器（0.4.x；已在 0.5.0 移除）

```bash
zrig context                # 紧凑摘要（仅限 0.4.x）
zrig context --full         # 完整当前 payload
zrig context --rig <name>   # 收窄到一个 rig
zrig context --threshold 80 # 过滤出达到或超过 80% 的席位
```

它的杠杆效应低于其他命令；在 0.4.0 升级后仍保持读取命令默认紧凑。**⚠ 0.5.0：这个用量查看器已被彻底移除，`zrig context` 名称被重新分配给上下文库（store + compose）——参见下方“上下文包与节奏化交付（0.5.0）”。在 0.5.0 主机上，裸 `zrig context` 指的是库，不是这个查看器。**

### 保持日常读取有界

扩大结果前，先选择范围、活动/历史广度和字段。状态问题通常只需要标识符、负责人、状态和原因；仅在相关时才打开完整正文或制品。完整证据应保存在磁盘上，不要反复加载不变的输出。紧凑默认值降低读取成本；它们不会移除完整详情路径，也不能证明范围之外不存在其他内容。

### `zrig scope mission|slice progress`——确定性的进度更新

```bash
zrig scope mission progress <mission> --add "<line>"   # 追加进度行；--set 替换；--section <heading>（默认 Rail）；--status active|done|blocked
zrig scope slice progress <slice-path> --add "<line>"  # 相同标志：--add / --set、--section <heading>、--status active|done|blocked
```

用确定性命令替代手工编辑 Markdown `PROGRESS.md`。它会写入 OpenRig PROGRESS UI 页面读取的规范结构。依据 `conventions/scope-and-versioning/README.md`，`zrig scope mission create` + `zrig scope slice create` 现在会自动搭建 `PROGRESS.md`。

### `zrig scope mission|slice stage / verified / repair`——确定性的成熟度词汇

```bash
zrig scope slice stage <slice> <new-stage>             # wip / provisional / established / canonical / superseded / retired
zrig scope slice stage <slice> superseded --successor <id>  # superseded 必须提供 --successor（否则拒绝）
zrig scope mission stage <mission> <new-stage>         # mission 层级使用相同枚举和规则

zrig scope slice verified <slice> --against "<source>" # 写入 `verified: <today> against <source>`；必须提供 --against
zrig scope mission verified <mission> --against "<source>"

zrig scope slice repair <slice>                        # 幂等修复：补齐 PROGRESS.md、规范 id/stage/verified、修复 ghost
zrig scope mission repair <mission>                    # mission 层级的幂等修复

zrig scope slice show <slice>                          # 根据（stage × verified）推导读取时的 effective-reliability
                                                      # ——verified 过时的 canonical 会被报告为实际上 provisional
```

它与 `progress` 命令及脚手架组合，使 `zrig scope` 成为 `conventions/scope-and-versioning` 的 §1（点号 ID）和 §2（成熟度词汇）的**确定性执行器**。agent 通过命令更新 `stage` / `verified` / `id`，而不是手工编辑 Markdown 导致漂移。`verified` **必须提供 `--against`** 是防止陈旧状态的关键：裸时间戳会被拒绝，因为它恰恰会让陈旧 tracker 看似新鲜地撒谎。**停止手工编辑 scope frontmatter 中的 `stage` / `verified` / `id` 字段；请使用新动词。**具有 `id:null` ghost 或缺少 `PROGRESS.md` 的现有 mission / slice 可通过 `repair` 幂等修复。

### `zrig skill audit`——技能级联来源审计

```bash
zrig skill audit                  # 供人阅读的发现报告
zrig skill audit --json           # 结构化发现
zrig skill audit --severity warn  # 仅 stale + mirror-drift
zrig skill audit --rig <name>     # 收窄到某个 rig 内嵌的技能副本
```

技能级联的只读审计。它会在规范技能工作区 → 产品镜像 → hub cwd → 已安装插件链中检测 `missing` / `stale` / `self-referential` / `invalid-date` / `mirror-drift`。发现会回送生命周期，触发定形传播运行。**防止假绿：**无法获得审计证据时，CLI 会输出 `unable-to-audit` 并以退出码 `2` 结束，而不是报告 `clean`。

### `zrig seat clear-attention`——扩展至派生投影陈旧状态

v0.3.4 的 `clear-attention` 仅对 `session.startupStatus` 设限。v0.4.0 将该动词扩展到 **restoreOutcome 派生**的关注状态（席位为 `startupStatus=ready` + `sessionStatus=running`，但带有 `restoreOutcome=failed` / `continuityOutcome=failed`）。仍使用相同的证据门控审计行；`--reason <text>` 操作员证明覆盖会如实携带 runtime / cwd 不确定性披露。

### 原生 Codex 会话 ID 捕获

Codex 席位现在可以从 Codex `SessionStart` hook 记录真实原生会话 ID，而不必依赖抓取式身份。依赖该 ID 前，应在当前 hook payload、provider 历史和托管记录之间相互印证。引入原生捕获的 release 并不能证明每个现有席位都在使用它；应明确保留任何缺失或冲突的身份依据。

### Codex 恢复会保留审批姿态

恢复 Codex 席位时会保留启动该席位时的审批/沙箱姿态和 profile 标志。产品生成的恢复命令会携带姿态标志，而不会悄悄退回隐式拒绝或无关 profile。

除非操作员明确授予有界窗口，否则不要通过以更宽权限重新启动的方式“修复”已恢复的 Codex 席位。应先验证席位的活动姿态，并在组合恢复命令时保留它。

### `zrig seat set-resume-token --token-stdin`

```bash
printf '%s' "$RESUME_TOKEN" | zrig seat set-resume-token <session> --token-stdin
```

使用此命令设置或恢复席位 resume token。它取代直接编辑 SQLite，会拒绝未授权写入和错误/null token 导致的假就绪状态，记录经脱敏的审计/来源信息，并避免 token 材料进入命令参数、stdout、日志和常规状态行。传递 token 材料时使用 stdin，不要使用内联标志。

## 核心循环

OpenRig 中的大多数工作都归结为以下循环：
- 恢复身份：`zrig whoami`（默认紧凑；仅在需要重 payload 时添加 `--full`）
- 检查清单：`zrig ps --nodes`（默认紧凑；仅在需要全量输出时添加 `--full`）
- 读取上下文：`zrig transcript ...`、`zrig ask ...`、`zrig chatroom history ...`
- 行动：`zrig send`、`zrig capture`、`zrig broadcast`、生命周期命令

## Agent 管理的应用

由 agent 管理的应用是一个可部署的 OpenRig 单元，由以下部分组成：
- 软件或服务
- 专门负责该软件的一个 specialist agent

将 specialist 视为该应用领域的代理人。
当前规范示例为：
- rig：`secrets-manager`
- pod：`vault`
- member：`specialist`
- 逻辑 ID：`vault.specialist`
- session：`vault-specialist@secrets-manager`

典型操作员循环：

```bash
zrig up secrets-manager --cwd /path/to/project
zrig ps --nodes --json
zrig send vault-specialist@secrets-manager "Check Vault health and report back." --verify
zrig env status secrets-manager
zrig env logs secrets-manager
```

只要目标 session 能够唯一解析，就可以跨 rig 通信。
示例：

```bash
zrig send vault-specialist@secrets-manager "Read secret/data/dogfood and report the value." --verify
```

应使用 specialist，而不是教每个同伴掌握相同的应用专用工具链。对于 Vault，应让 `vault.specialist` 执行 secrets 领域工作，而不是由无关 agent 即兴使用 curl 或 Vault CLI。

## 身份与恢复

启动、压缩或产生困惑后从这里开始：

```bash
zrig whoami --json
```

它当前提供：
- 身份：rig、逻辑 ID、pod/member、session 名称、runtime
- 同伴和有方向的边
- transcript 信息
- 可用时提供 `contextUsage`

标志：
```bash
zrig whoami --session <name>
zrig whoami --node-id <id>
```

如果 daemon 无法访问但仍能推断身份，`--json` 可能会返回部分结果，而不是崩溃。

`WhoamiResult`（v0.3.3+）包含必需的 `peersNote` 字段，其中有三个指针，可供 agent 从冷启动开始浏览 rig 的其余部分。供人阅读的 CLI 输出会原样保留字面量 `Peers:` 行前缀（为了 parser/test 兼容），并在其下方就地显示说明；JSON 形式直接暴露 `peersNote`，供程序化消费者使用。

## 清单与监控

```bash
zrig ps                      # 主机上的所有活动 rig，每个一行紧凑信息（先运行以了解全局）
zrig ps --nodes              # 紧凑节点清单（当前 rig）
zrig ps -A                   # 所有 rig 的广度（0.4.0 之前的默认值）
zrig ps --nodes --full       # 完整逐节点记录（全量输出——主动选择）
zrig ps --nodes --json       # 紧凑 JSON 节点清单（加 --full 获取完整记录）
```

**v0.4.0 已将这些命令改为默认紧凑——参见上面的 `zrig ps` 紧凑默认值章节；停止将裸 `zrig ps --nodes --json` 当成整个 fleet 的全量输出（范围和详情是两个独立选择）。**紧凑的 `zrig ps --nodes` 节点清单（仅在需要完整记录时添加 `--full`，跨 rig 广度使用 `-A`）为每个节点提供：
- session 名称
- runtime
- session/startup 状态
- restore outcome（紧凑输出：`resumeTokenPresent` 布尔值；token 值在 `--full` 中）
- attach/resume 命令
- 最新错误

其他健康状态界面：

```bash
zrig status
zrig daemon status
zrig config
zrig preflight
zrig doctor
zrig env status <rig>
zrig env logs <rig>
zrig env down <rig>
```

### 有界的 agent 自助侦察

读取原始协作历史前，先使用类型化健康投影。默认查询当前席位；只有证据指向范围之外时才有意扩展：

```bash
zrig health --json
zrig health --rig <rig-id> --json
zrig health --instance --json
zrig health explain <finding-id> --json
```

沿着返回的稳定 finding ID 和 `suggestedInspection` 继续调查。摘要不足时使用 `explain`：它返回同一条规范记录，以及有界窗口、新鲜度、字面 detector 规则、证据引用和下一项检查。供人阅读的输出会投影相同字段，不会计算第二套分数。

空结果只表示没有记录匹配有界查询，**不代表健康断言**。陈旧、不可用、矛盾和不确定证据都会明确保留。自助侦察时绝不要读取原始 SQLite，也绝不要自动把 finding 转变为确认、通知、队列行或修复操作：`zrig health` 严格只读。

## Transcript 与通信

### 访问 transcript

```bash
zrig transcript <session> --tail 100
zrig transcript <session> --grep "pattern"
zrig transcript <session> --json
```

### 向单个 session 发送消息

```bash
zrig send <session> "message"
zrig send <session> "message" --verify
zrig send <session> "message" --wait-for-idle <seconds>
zrig send <session> "message" --raw
zrig send <session> "message" --dangerously-interact --reason "<why>"
zrig send <session> "message" --host <id>
zrig send <session> "message" --json
```

**send guard（v0.4.0）——默认是安全的。**默认的 `zrig send` 受守卫保护：它不会向目标窗格中的交互提示 / 权限阻塞提交内容。标志：
- `--verify`——交付证据。
- `--force`——对于发送**决策**而言，它是**保持向后兼容的无操作项**：永远不会绕过交互提示/权限守卫，也永远不会改变消息是否发送（处于任务中/繁忙的窗格默认就会发送并附提示）。*（它并不“绕过活动风险检查”——旧有说明已停用。）*不过它并非完全不起作用——解析它只是为了在它与 `--wait-for-idle` 组合时**拒绝执行**：`zrig send … --force --wait-for-idle <n>` 会输出 `--wait-for-idle cannot be combined with --force`，以状态码 1 退出，并且不发送任何内容。因此，不要把“无操作”理解为“`--force --wait-for-idle` 无害”；该组合会报错。*（已对照当前产品 main `d37a08ad` 验证：守卫绕过的无操作项在 `send.ts` 中声明，并由运行时捕获确认——单独使用 `--force` 会通过普通路径交付；`--wait-for-idle` 的拒绝逻辑在 `send.ts`、`routes/transport.ts` 和 `session-transport.ts` 中执行，也经运行时捕获确认——退出码 1，未发送任何内容。）*
- `--wait-for-idle <seconds>`——等待目标明确进入空闲状态后再发送。**不能与 `--force` 组合**（该组合会被拒绝：退出码 1，不发送任何内容）。
- `--raw`——发送原样文本/按键，不添加 From/To 消息信封（仍受交互提示守卫保护）。
- `--dangerously-interact --reason "<why>"`——覆盖提示/权限守卫的**唯一**方式：有意操作交互提示/权限阻塞（隐含 `--raw`，必须提供 `--reason`，并记录审计日志）。
- `--host <id>`——向 `~/.openrig/hosts.yaml` 中声明的远程主机发送（ssh 主机会启动 shell；http 主机则由 CLI 直接连接远程 daemon）。
- `--from <session>`——已弃用且会被忽略；它不会选择发送者。发送者身份来自当前席位和传输来源；跨主机信封使用持久的本地来源，不使用所提供的标志或中继身份。
- `--context <ref>` **（0.5.0）**——按 ref 附加组合好的上下文包/片段（参见“上下文包与节奏化交付”）。小片段 → `send --context`；真正的包 → `zrig walk`。名词 `zrig context` 负责组合 ref；动词负责交付。

> **持久工作应进入 QUEUE，而不是 `send`。**`zrig send` 是发往窗格的*临时*消息——可能会被错过，其交付状态只是窗格渲染，而不是接收回执。如果你在**分配工作，或者消息重要到一旦丢失就会造成实际问题**，请使用下方的 `zrig queue`：它是持久的、有负责人的、可跟踪的，并且能跨压缩和重启保留。快速对话提醒使用 `send`；绝不能丢失的内容则使用 **queue**。不要默认用 `send` 分配工作——这是最常见的错误。

从 v0.3.3 起，以 `--` 或 `-` 开头的内容可以安全发送：`zrig send <session> "content starting with -- or - is now safe"` 会按字面量交付。daemon 的 `send_text` 路径会携带明确的 `--` 选项结束哨兵，因此 tmux 不再把以短横线开头的内容解析为自己的标志。CLI 界面本身不变。对于以持久工作形式移交的多行或大型正文，请使用 `zrig queue create --body-file <path>`（以 `-` 表示 stdin）——这是 queue 侧界面，不是 `zrig send`。

`--verify` 交付结果（v0.3.3+）：
- `delivered`——文本和 Enter 均成功，且 capture 再次确认正文已落地。
- `rendered-unconfirmed`——文本和 Enter 均成功，但 capture 无法再次确认正文（TUI 重绘竞态或滚动）。消息已经落地，只是发送后的复查无法证明。应视为已落地但无法确认，**不是失败**。
- `failed`——发送传输本身失败。

为保持 parser/test 兼容，会原样保留旧版 `Verified: yes/no` 行。新增的 `Delivery: <outcome>` 行承载上述具名结果。

操作员观察 `--verify` 时的细微差别：
- `Sent to ...` + `Verified: yes`（`Delivery: delivered`）= 有力的正向交付证据。
- `Sent to ...` + `Verified: no` + `Delivery: rendered-unconfirmed` = 消息已落地；capture 无法再次证明。不要盲目重试——再次发送前检查回复 / `zrig capture` / transcript。
- `Sent to ...` + `Verified: no` + `Delivery: failed` = 发送传输失败。
- 没有 `Sent to ...` 行或出现硬错误 = 发送失败。

收到 `Verified: no` 时，不要立即盲目重试。先检查以下任一项：
- 目标的直接回复
- `zrig capture <session>`
- transcript 证据
- 如果消息要求持久移交，则检查 queue/outbox 状态

### 捕获终端输出

```bash
zrig capture <session>
zrig capture <session> --lines 50
zrig capture --rig <name>
zrig capture --pod <name> --rig <name>
zrig capture --rig <name> --json
```

### 广播

```bash
zrig broadcast --rig <name> "message"
zrig broadcast --pod <name> "message"
zrig broadcast "message"
zrig broadcast --rig <name> "message" --json
```

**谨慎使用 `zrig broadcast`——优先使用 `zrig send` 扇出。**如果不提供 `--rig` 或 `--pod`，broadcast 会以**所有 rig 中的每个运行中 session**（加上附加的 external_cli 节点）为目标——这是引发广播风暴最快的方式。只在小型 rig 或真正的全员紧急事件中使用 `zrig broadcast`。对于通常的“同时向几个席位发送消息”场景，请使用 `zrig send`，它可以限定扇出范围，并保留消息信封、交付/交互提示守卫以及逐接收方结果：

```bash
zrig send --to dev-impl@my-rig,dev-qa@my-rig "message to specific seats"   # 指定席位（逗号列表或重复 --to）
zrig send --pod dev "message to one pod"                                    # 限定范围的扇出
zrig send --rig my-rig "message to one rig"                                 # 限定范围的扇出
```

### Chatroom

```bash
zrig chatroom send <rig> <message> [--sender <name>]
zrig chatroom history <rig> [--topic <name>] [--after <id>] [--since <ts>] [--sender <name>] [--limit <n>] [--json]
zrig chatroom wait <rig> [--after <id>] [--topic <name>] [--sender <name>] [--timeout <seconds>] [--json]
zrig chatroom clear <rig>
zrig chatroom topic <rig> <topic-name> [--body <text>] [--sender <name>]
zrig chatroom watch <rig> [--tmux]
```

**关键命令：**
- `send`——发布消息
- `history`——通过可组合过滤器（sender、since、after、topic）检索
- `wait`——阻塞等待新的匹配消息（轮询 history，如实超时）
- `clear`——删除该 rig 的全部消息（破坏性操作，仅限此 rig）

## 看到问题就说出来

OpenRig 有一条**观察流**——它是 fleet 中零摩擦的组织记忆，可从中提炼真正的产品改进。只要注意到**任何值得外化的内容**，就记录下来并继续工作：

- **bug**、粗糙之处或需要修复的东西
- **功能想法**或改进建议
- **效果很好的做法**——值得推广的技巧、工具或模式
- **观察**、正面或负面反馈，或者真正很酷、高效、有趣的事情

```bash
zrig stream emit --source <your-session> --body "what you noticed"
```

这就是完整动作。**不要**决定它应该去哪里或交给谁——摄取路由器会进行分类（destination/type/urgency/tags 都是可选提示——`--hint-type review|handoff|idea`、`--hint-urgency routine|urgent|critical`、`--hint-tags`——从不强制）。运行一条命令，然后继续；价值在于习惯，而不是润色。**也不要滥用：**只流式记录真正的信号，不要记录流水账——一条好观察胜过十条噪声。它只是随手外化的想法，不是一项杂务。
- `topic`——设置 topic 标记
- `watch`——基于 SSE 或 tmux 的实时流

**圆桌协议：**
1. 检查旧房间：`zrig chatroom history my-rig --limit 5`
2. 如有需要则保存：`zrig chatroom history my-rig --json > /tmp/old-room.json`
3. 如有需要则清空：`zrig chatroom clear my-rig`
4. 设置 topic：`zrig chatroom topic my-rig "ROUND START"`
5. 发布：`zrig chatroom send my-rig "position..." --sender <session>`
6. 监控：`zrig chatroom wait my-rig --timeout 120`
7. 结束：`zrig chatroom topic my-rig "ROUND CLOSED"`

完整协议参见 `docs/planning/roadmaps/chatroom-roundtable-protocol.md`。

### `zrig ask`

```bash
zrig ask <rig> "question"
zrig ask <rig> "question" --json
```

当前已发布的行为：
- 向 daemon 查询证据
- 返回 rig 摘要
- 返回 transcript 摘录
- 可能返回 chat 摘录
- 返回证据不足状态和可选指导

这是证据/上下文命令，不是隐藏的第二次 LLM 调用。

### `zrig auth`——agent 身份验证 profile 管理（v0.4.1，产品原生）

通过 CLI 以产品原生方式切换 agent 身份验证 profile。runtime 是一个**标志**（`--runtime <codex>`），而不是命令名词——绝不能使用 `zrig codex-auth`。

```bash
zrig auth status --runtime codex          # 是否存在 / 模式 / 是否可解析 / 登录状态（绝不输出 token 内容）
zrig auth list --runtime codex            # 保存的 profile
zrig auth save <profile> --runtime codex  # 对身份验证文件做快照（受模式守卫），绝不回显内容
zrig auth switch <profile> --runtime codex
zrig auth validate <profile> --runtime codex
zrig auth seats … --runtime codex         # 席位 -> profile 注册表（仅元数据；不能证明实时账户）
```

**严格的 secret 边界：**任何 token 值都绝不会被输出、记录日志、加入队列、写入流或提交；status/validate 只报告是否存在/模式/登录状态；席位标签是元数据，不是实时账户证明。MVP 使用 `--runtime codex`；其他 runtime 使用同一界面配合不同的 `--runtime`，绝不建立平行命令。

## 上下文包与节奏化交付（0.5.0）

**上下文只组合一次，再清晰地交给席位。**它由一个库原语和一组交付标志组成。要保持语法连贯，请内化这一规则：**名词负责存储和组合；动词负责交付。**`zrig context` 永远不发送任何内容；只有 `zrig send` / `zrig broadcast` / `zrig walk` / `zrig queue` 才会交付。

> 版本说明：这里描述的是 0.5.0 引入的库界面。依赖它之前，请检查已安装命令和提供服务的 daemon。在 0.4.x 中，裸 `zrig context` 是上下文窗口用量查看器（见上文）；在 0.5.0 中该查看器已移除，`zrig context` 名称属于此处的库。

### `zrig context`——store + compose 库（绝不交付）

管理并将上下文（任意文本/Markdown）组合为可复用的**包**。每个片段和包都有一个稳定的**路径式 ref**——可像寻址文件一样寻址上下文（`packs/compaction-restore`、`as-built/queue-internals`）。

```bash
zrig context list                     # 库中有哪些内容
zrig context show <ref>               # 读取片段或包
zrig context add <source-dir>         # 将现有包目录安装到 store
zrig context preview <ref>            # 组装并显示包，不交付
zrig context sync                     # 重新遍历发现根目录，刷新库索引
zrig context rm <ref>
zrig context compose --out packs/<ref> --from <fileA> <fileB> ...   # 有序片段 -> 持久包
```

- 使用合理的默认 store 位置；无需配置即可工作，之后可以指向其他位置（现在是另一个文件夹，未来可以是机器或 URL）。
- `compose`（v1）如实地按顺序连接具名文件，形成带 ref 的持久包——“这里有一个文件，请读取这个文件。”
- **名词上没有任何交付动词。**要把包交给席位，应将其 ref 传给下方的交付动词。

### `zrig walk`——序列的节奏化交付

```bash
zrig walk <seat> --through <ref | file ...> --pace 10s
```

带领席位逐步*走过*一个包：每个片段都会发送到窗格，并按 `--pace` 间隔，让 agent 在两次发送之间处理内容（模拟人工粘贴 → 等待 → 再粘贴的节奏）。它是独立的顶层动词，方向为推送——引导者带路，不等待回复；间隔本身负责节奏。onboarding、重新预热或 fleet 更新等任何需要依序吸收而非一次全部接收的场景，都应使用 `walk`。

### 交付语法——发送 ref、逐步传递包，或附加到 qitem

| 场景 | 动词 |
|---|---|
| 立即发送一个内容 | `zrig send <seat> --context <ref>` |
| 向所有人发送一个内容 | `zrig broadcast --rig <rig> --context <ref>` |
| 依序吸收一组内容 | `zrig walk <seat> --through <ref> --pace 10s` |
| 随持久移交携带上下文 | `zrig queue create … --body-context <ref>` |

- **经验法则：**小片段 → `send --context`；真正的包 → `walk`。过大的 `send --context` 会警告“this is walk-sized”，而不会直接轰入窗格。
- **`--body-context` 快照规则：**由 ref 创建的 qitem 会把**解析后的内容**存入正文，**同时保存 ref 以提供来源信息**——移交内容会保留实际发送的数据，之后修改库也绝不会悄悄改写过去的移交历史。
- **编排者习惯——分配工作时*附带*其上下文：**
  ```bash
  zrig context compose --out packs/qitem-brief --from as-built/queue.md conventions/c1-proof.md
  zrig queue create --destination dev-driver@build --body-context packs/qitem-brief --summary "…"
  ```
  被分配者不必通过 grep 寻找 as-built；策划好的上下文会随持久移交一起传递，可跨压缩保留，并可供审计。

**技能层与上下文层：**技能是 HOT 层（环境中始终可见、容量有限的 frontmatter）；上下文包是 COLD 层（无限容量、按指示获取——“自行逐步阅读 `packs/tui-onboarding`”）。不要把技能当上下文包使用，以免压垮技能层——这个原语就是为此而设。

## 生命周期

### 启动 rig

```bash
zrig up <source>
zrig up <source> --plan
zrig up <source> --yes
zrig up <source> --cwd /path/to/project
zrig up <source> --existing
zrig up <source> --fresh <seat...>
zrig up <source> --json
```

`<source>` 可以是：
- rig 规范路径
- `.rigbundle` 路径
- 裸名称

裸名称具有特殊含义：
- 如果匹配库规范，`zrig up` 会从规范库启动
- 如果不匹配库规范，`zrig up` 会将该名称视为现有 rig 的恢复/开机目标
- 如果两者都匹配，`zrig up` 会明确报告歧义并失败

默认恢复原会话（v0.3.4+）：
- 对现有 rig，`zrig up <name>` 默认从每个席位的原始会话/快照恢复（操作 A）。成功恢复的席位报告为 `resumed`。
- `--fresh <seat...>` 是逐席位主动选择的全新预热（操作 B）。指定席位报告为 `fresh-primed`。
- `--existing` 强制裸名称采用现有 rig 恢复语义，绕过库规范解析。当 rig 名称与库规范名称冲突时很有用。
- 示例：`zrig up --existing my-rig --fresh dev-impl`——恢复 `my-rig` 中除 `dev-impl` 外的全部内容，并全新预热 `dev-impl`。
- 没有可恢复会话的席位会进入 `awaiting-decision`（诚实的零会话状态，不是 `failed`）；参见下方“恢复与韧性”中的五项恢复状态词汇。

`--plan`（v0.3.4+）：
- `zrig up <source> --plan` 会生成只读的恢复计划预览。它显示逐席位的恢复/全新预热意图和所有 awaiting-decision 席位，而不变更状态。诚实处理异步超时：卡住的计划会报告超时，而不是静默挂起。

当前行为说明：
- `--target <root>` 仅用于 `.rigbundle` / 软件包安装，不会改变 agent cwd。
- `zrig up --cwd` 已发布。`zrig up --cwd <path>` 为本次启动的所有 member 发送逐次运行的 cwd 覆盖值。
- `local:` `agent_ref` 值相对于 rig 规范目录解析，而不是相对于 shell cwd。
- 如果把内置规范复制到其他位置，应将其 `agents/` 树放在 YAML 旁边，或将这些 ref 改为 `path:/absolute/path`。
- 当目录中包含 `rig.yaml` 或 `agent.yaml` 时，`zrig specs add <directory>` 会安装完整的规范树。
- **权限策略：**rig 会携带权限策略并按该策略启动（绝不在运行时更改）。未设置时默认采用最低基线（Claude `acceptEdits` / Codex 仅限工作区 / Pi `--no-approve`）；也可以选择内置策略（Locked / Standard / Open），或刻意不设策略。编写规范或启动 rig 时要决定其策略——通过 `applying-a-permission-policy` 应用它（另请参见 onboarding 菜单“权限策略——设置时选择一种”）。

遗留/规范专用界面也仍然提供：

```bash
zrig bootstrap <spec> [--plan] [--yes] [--json]
zrig requirements <spec> [--json]
```

### 关闭 rig

```bash
zrig down <rig>            # <rig> = rig 名称或 id（活动 rig）
zrig down <rig> --snapshot
zrig down <rig> --delete
zrig down <rig> --force
zrig down <rig> --json
```

如果 `--snapshot` 成功，供人阅读的输出会包含恢复提示。

### 归档已停止的 rig（可恢复）——v0.3.3+

```bash
zrig archive <rig> [--json]
zrig unarchive <rig> [--json]
```

`zrig archive` 会将已停止的 rig 标记为已归档（设置 `archivedAt`），而不会丢弃它。该 rig 会保留下来，可稍后通过 `zrig unarchive` 恢复；后者清除 `archivedAt`，将 rig 放回活动集合。

归档与删除的区别：
- `zrig down --delete`——永久移除；不可恢复。
- `zrig archive`——可恢复；rig 会在默认活动视图中隐藏，但其记录 + 快照会保留。

在 `zrig ps` 中的可见性：
- `zrig ps`——仅活动 rig（默认）。
- `zrig ps --include-archived`——包含已归档 rig，并以 `*` 标记。

SSE 事件 `rig.archived` / `rig.unarchived` 会驱动 Project / dashboard 更新；依赖 rig 列表的消费者应订阅事件，而不是轮询。

### 环境服务

```bash
zrig env status <rig>
zrig env logs <rig> [service]
zrig env down <rig>
```

对服务支持的 rig 和 agent 管理的应用使用这些命令。对于 `secrets-manager`，它们是完成以下工作的最快 CLI 界面：
- 确认 Vault 是否健康
- 读取 Vault 容器日志
- 在不先关闭 specialist session 的情况下停止 Vault 环境

### 在不终止已认领活动 session 的情况下解除管理

```bash
zrig release <rigId>
zrig release <rigId> --delete
zrig release <rigId> --json
```

对于采用/认领 session 的 rig，如果希望 OpenRig 停止管理该 rig、但保留 tmux session 运行，请使用 `zrig release`。这是针对“session 仍然存在，但管理已损坏或陈旧”情况的安全恢复/重置界面。如果 rig 包含由 OpenRig 启动的节点，`zrig release` 会明确拒绝，而不会假装混合 rig 可以安全解除关联。

### 快照与恢复

```bash
zrig snapshot <rigId>
zrig snapshot list <rigId>
zrig restore <snapshotId> --rig <rigId>
```

`zrig restore` 必须提供 `--rig <rigId>`。

Claude Code 自治说明：
- 无人值守的启动时 `zrig whoami` 可能要求本地权限允许列表包含 `Bash(rig:*)`

### 导入/导出与 bundle

```bash
zrig export <rigId> -o rig.yaml
zrig import <path> [--instantiate] [--materialize-only] [--preflight] [--target-rig <rigId>] [--rig-root <root>]
zrig bundle create <spec> -o out.rigbundle
zrig bundle inspect <bundle>
zrig bundle install <bundle> [--plan] [--yes] [--target <root>] [--json]
```

### 遗留 package 界面

该界面仍然提供，但已明确标记为遗留：

```bash
zrig package validate <path>
zrig package plan <path> [--target <dir>] [--runtime <runtime>] [--role <name>]
zrig package install <path> [--target <dir>] [--runtime <runtime>] [--role <name>] [--allow-merge]
zrig package list
zrig package rollback <installId>
```

## 发现与拓扑变更

### 发现未管理的 tmux session

```bash
zrig discover
zrig discover --json
zrig discover --draft
```

### 绑定已发现的 session

```bash
zrig bind <discoveredId> --rig <rigId> --node <logicalId>
zrig bind <discoveredId> --rig <rigId> --pod <namespace> --member <name>
```

当前没有已发布的顶层 `zrig claim` 命令。当前的接管界面是 `discover`、`bind`、`adopt` 和 `unclaim`。

### 自行附加当前 shell 或 agent

```bash
zrig attach --self --rig <rigId> --node <logicalId>
zrig attach --self --rig <rigId> --node <logicalId> --print-env
zrig attach --self --rig <rigId> --pod <namespace> --member <name> --runtime <runtime>
```

如果当前 agent 应直接附加自身，而不是经过 `discover` + `bind`，请使用 `zrig attach --self`。

当前已验证的行为：
- 在 `tmux` 内：作为普通的 tmux 支持节点附加，保留传入的 `zrig send` / `zrig capture`
- 在 `tmux` 外：作为 `external_cli` 附加
- `--print-env` 输出当前 shell 所需的 `OPENRIG_NODE_ID` 和 `OPENRIG_SESSION_NAME` export

推荐流程：

```bash
zrig attach --self --rig <rigId> --node <logicalId> --print-env > /tmp/openrig-self-attach.env
. /tmp/openrig-self-attach.env
zrig whoami --json
```

说明：
- 对 tmux 支持的自行附加，应使用 `zrig whoami --json` 验证
- 对 raw/external 自行附加，当前更可靠的验证界面是 `zrig ps --nodes --json`
- 如果当前 shell 不在 tmux 中，希望记录稳定的供人阅读的 session 标签，请传入 `--display-name <name>`

### 采用拓扑并绑定活动 session

```bash
zrig adopt <path> --bind <logicalId=tmuxSessionOrDiscoveryId>
zrig adopt <path> --bind <logicalId=...> --bind <logicalId=...> --json
zrig adopt <path> --bindings-file <bindings.yaml>
zrig adopt <path> --bind <logicalId=...> --target-rig <rigId> --rig-root <root>
```

当 session 已经存在，希望 OpenRig 开始管理它们时，请使用 `zrig adopt`。

bindings 文件是从编写的逻辑 ID 到活动 session 的持久映射。结构如下：

```yaml
bindings:
  dev1.impl2: dev1.impl2@rigged-buildout
  dev1.qa: dev1.qa@rigged-buildout
```

规范 + bindings 是采用型 rig 已验证的恢复组合。规范告诉 OpenRig 预期拓扑，bindings 则告诉 OpenRig 每个逻辑节点对应哪一个已发现的活动 session。

### 已验证的采用型 rig 恢复流程

以下流程已经在外部 tmux session 仍然存活的情况下得到验证：

```bash
zrig release <rigId> --delete
zrig discover --json
zrig adopt <spec.yaml> --bindings-file <bindings.yaml>
```

它会：
- 移除 OpenRig 管理关系，但不终止 session
- 将同一批 session 重新发现为未管理状态
- 将它们重新附加到规范 + bindings 定义的拓扑

重要限制：
- 仅适用于 `sessions still alive`
- 对采用型 rig，仅有规范还不够；还需要 bindings
- 这并不意味着 OpenRig 已经能从零重新创建死亡的外部 session

### 将未管理 pod 加入现有 rig

当一个 rig 已处于管理之下，但新 pod 是在 OpenRig 外部创建、现在希望补充加入时，下面是经过验证的流程：

```bash
zrig adopt <pod-fragment.yaml> --bindings-file <pod.bindings.yaml> --target-rig <rigId>
```

适用条件：
- 目标 rig 已存在
- 新 session 处于活动状态，并可在 `zrig discover --json` 中看到
- 需要的是增量拓扑增长，而不是完整重建

需要准备：
- 仅包含新 pod 的 pod 片段规范
- 将新逻辑 ID 映射到活动 session 名称的 bindings 文件

验证循环：

```bash
zrig discover --json
zrig adopt <fragment.yaml> --bindings-file <bindings.yaml> --target-rig <rigId>
zrig ps --nodes --rig <rigId>   # 目标 rig 的节点（单独使用 --nodes 只显示当前 rig）
zrig export <rigId> -o rig.yaml
```

成功表现为：
- 新 session 不再出现在 `zrig discover` 中
- 新逻辑 ID 出现在 `zrig ps --nodes --rig <rigId>` 中
- `zrig export` 包含新 pod

### 允许混合来源的 rig

一个 rig 可以同时包含：
- 从已运行 session 绑定而来的采用型节点
- 稍后通过 `zrig expand` / `zrig launch` 创建的 OpenRig 启动型节点

当前安全规则：
- `zrig release` 用于仅包含已认领/采用节点的 rig
- 如果 rig 包含启动型节点，`zrig release` 会以 `contains_launched_nodes` 失败

### manager 辅助恢复

经过验证的操作员模式为：
- 在被管理 rig 之外保留一个 OpenRig manager session
- 通过 rig 名称寻址目标，而不是使用缓存的 rig ID
- 先用裸 `zrig ps` 查找目标 rig（它会列出所有 rig），再通过 `zrig ps --nodes --rig <target>` 解析其 owner（裸 `--nodes` 读取只显示当前 rig，不是目标 rig）
- 使用 `zrig send` 将规范路径、bindings 路径和验证步骤发送给 manager

这样，普通 agent 可以向 manager 请求 OpenRig 帮助，而不需要每个 agent 都成为 OpenRig 专家。

### 添加/移除运行中的拓扑组件

```bash
zrig expand <rig-id> <pod-fragment-path> [--rig-root <path>] [--json]
zrig launch <rigId> <nodeRef> [--json]
zrig launch <rigId> --seats <a,b,c> [--hold-reason <text>] [--json]
zrig remove <rigId> <nodeRef> [--json]
zrig shrink <rigId> <podRef> [--json]
zrig unclaim <sessionRef> [--json]
```

节点粒度的托管式局部恢复（v0.3.4+）：
- `zrig launch <rigId> <nodeRef>` 通过编排，按逻辑 id 或节点 id 重新启动单个席位。
- `zrig launch <rigId> --seats <a,b,c>` 重新启动以逗号分隔的席位子集。
- `--hold-reason <text>` 记录在局部启动期间暂停非目标席位的原因。
- 这是一条**受支持**的托管路径。此前 `pod_aware_launch_unsupported` 的死路已经停用；现在 pod 感知的窄范围启动通过此界面执行，而不是临时重建。

### 向现有 pod 添加 member——v0.3.3+

```bash
zrig add <rig> <member-fragment-path> [--json]
zrig add-member <rig> <member-fragment-path> [--json]
```

`zrig add`（别名 `zrig add-member`）是 `add_member` converge 操作的顶层动词。它根据 YAML/JSON member 片段文件向现有 pod 添加单个 member。片段必须声明目标 pod；daemon 会按声明的身份解析 pod，验证 member，运行 preflight，然后就地启动 member。

HTTP 结果：
- `201`——member 已添加；响应中包含逐节点启动状态。
- `400`——`validation_failed` 或 `preflight_failed`（片段或其启动姿态在任何状态变更前被拒绝）。
- `409`——`member_conflict`（pod 中已存在具有该身份的 member）。

希望在 pod 内增量扩展，而不重新运行完整的 `zrig expand` pod 片段路径或重建 rig 时，请使用 `zrig add`。

## 规范与验证

### 验证规范

```bash
zrig spec validate <path> [--json]
zrig spec preflight <path> [--rig-root <root>] [--json]
zrig agent validate <path> [--json]
```

### 规范库

```bash
zrig specs ls [--kind <kind>] [--json]
zrig specs show <name-or-id> [--json]
zrig specs preview <name-or-id> [--json]
zrig specs add <yaml-or-directory> [--json]
zrig specs sync [--json]
zrig specs remove <name-or-id> [--json]
zrig specs rename <name-or-id> <new-name> [--json]
```

## MCP

```bash
zrig mcp serve [--port <port>]
```

当前已发布的 MCP 工具：
- `rig_up`
- `rig_down`
- `rig_ps`
- `rig_status`
- `rig_snapshot_create`
- `rig_snapshot_list`
- `rig_restore`
- `rig_discover`
- `rig_bind`
- `rig_bundle_inspect`
- `rig_agent_validate`
- `rig_rig_validate`
- `rig_rig_nodes`
- `rig_send`
- `rig_capture`
- `rig_chatroom_send`
- `rig_chatroom_watch`

## 故障排查与异常状态

CLI 表现异常时，先使用最小而真实的检查：

```bash
zrig whoami --json
zrig daemon status
zrig ps --nodes --json
```

具体操作员规则：
- `Sent to ...` + `Verified: no` 表示交付不明确，并非自动判定失败。重试前检查回复、`zrig capture`、transcript 证据或 queue/outbox 状态。
- daemon 支持的路径降级时，如果仍能推断身份，`zrig whoami --json` 可能只返回部分结果。
- unified-exec-process 警告是主机/工具层信号，不能自动证明 OpenRig 拓扑不健康。

遇到 unified-exec 警告时，应先检查陈旧的一次性 helper，再接触活动席位：

```bash
ps -axo pid,ppid,command | rg 'tmux send-keys|rig queue create|tmux attach|codex|claude'
```

可安全清理的目标：
- 孤立的一次性 wrapper，例如 `tmux send-keys ...`

不要批量终止：
- `tmux attach ...`
- `codex ...`
- `claude ...`

如需更深入地排查主机/runtime，请使用席位中可用的配套 `openrig-operator` 技能。

## JSON 与错误处理姿态

已发布 CLI 所遵循的设计假设：
- 很多操作员命令支持 `--json`
- 错误消息应说明发生了什么、为什么重要以及下一步怎么做
- daemon 停止或不健康时，daemon 支持的命令会明确失败
- 不应把恢复失败悄悄重新解释为成功

## 压缩后恢复检查清单

1. `zrig whoami --json`
2. `zrig transcript <your-session> --tail 100`
3. `zrig ps`——列出主机上的所有 rig（先了解全局）；然后使用 `zrig ps --nodes --rig <your-rig>` 查看自己的席位。⚠ 单独使用 `zrig ps --nodes --json` 只显示当前 rig——不要误以为它代表整台主机（刚完成压缩的 agent 没有其他上下文来识破这一错误）。
4. `zrig chatroom history <rig> --limit 50`

## 不存在的命令

除非已发布的 help 开始列出，否则不要假定以下命令存在：
- `zrig claim`
- `zrig blame`
- `zrig replay`
