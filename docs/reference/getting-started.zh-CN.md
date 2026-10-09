# 入门：在你的仓库里做一个有用的改动

从一个仓库和一个你能操练的、有界的改动开始。随包的 `first-project` starter 提供两个原生 Codex 席位：一个结果 owner 和一个独立检查者。它用你已装的 Codex 可执行文件和登录；终端 provider 支持不改它用的 harness 或账户。

你需要 macOS 或 Linux 上的 Node.js 22 或 24 加 tmux。Apple silicon 的 Mac 用 Node.js 22（见[兼容性历史](../releases/v0.5.15.md#known-compatibility-limitation)）。原生 Windows 还不支持，WSL2 没测过。Node 20 不再支持；Node 26 和其他版本未测。

**在启动团队之前先选权限。** 未改动的 starter 用 `-s workspace-write` 启 Codex；它把审批策略留给你的原生 Codex 配置。那个沙箱里网络访问默认关闭，包括访问本地 OpenRig daemon。它的 `profile: default` 选的是 OpenRig 资源，不是一个 Codex 权限 profile。因此普通权限提示是预期内的。你可以保留这些提示、记住选定命令，或选更宽访问。[让你的智能体配置那个选择](#have-your-agent-configure-permissions)；OpenRig 不为所有人选宽松操作。

> 下面一切报告的是**当前为真的东西**，绝不保证下游工作会成功。"daemon up" 不意味着每个智能体健康；"kernel ready" 不意味着每个 kernel 智能体健康；一个工作区根 *live* 不意味着它是你项目的*正确*那个。

## 准备并启动

在普通终端里敲 `zrig` 打开启动和工作 TUI。它显示 daemon 地址；**d** 展开所选实例路径和诊断。如果 daemon 停了，按 Enter
启动那个 daemon，然后选你要的工作组和席位。先选 kernel；选它的 operator 不启动每个 kernel 席位。同一视图在普通 TUI 工作时按 **S** 可用。
**?** 即使在连接检查等待中也打开 Help。**w** 跳过启动；
**Esc** 返回，或从启动第一页离开。这些选择不启动 daemon 或席位。**L** 在连接前后打开本地阅读：
选已配置 Specs、项目意图、projects 或 missions and slices，然后选一个目录或文件。**r** 重读所选源；**Esc** 返回。
本地阅读用这台机器已配置的工作区路径和文件允许清单，即使所选 daemon 地址是远程的。它显示磁盘来源、缺失或被拒源、二进制文件和 1 MiB 文本截断边界。
这些磁盘快照读后可能变化，不提供活队列、执行或拓扑状态。活视图在确认连接和刻意进入后加载；一次卡住的活读不阻止 Help 或本地阅读。
当终端传输不可用时，**t** 启动空终端服务，好检视恢复选择。它不启动席位。

对一个先前被占的席位，Enter 尝试它先前的对话。
如果历史不可用，读原因。**f** 对那个具名席位开一个单独的全新开始决定；**Esc** 不启动就拒绝。一个确认的新对话收到已配置上下文并保留旧历史，但不恢复那段历史。认证或运行时失败需要修那个前提。**o** 在这里打开既有原生终端；detach 返回（tmux 默认 Ctrl-b，再 d）。在那里决定原生信任/认证提示。如果一个全新开始在上下文投递前暂停，**c** 完成对同一占用者的投递。**r** 重读实际状态；**d** 展开细节。

在应用机器改动前安装 OpenRig 并检视 `zrig setup --dry-run`。在你的启动 shell 里检查 `tmux -V`、`codex --version` 和 `codex login status`；需要时装缺失前提并完成 `codex login`。这个 starter 需要 tmux 和 Codex，不需要 Claude 登录或 Herdr 插件。kernel 单独选它可用的原生运行时变体。

`zrig setup` 目前安装/检查两个 harness 和 cmux。当你想要那个完整环境时用它。它的整体失败可能包含这个 starter 的一个可选组件：读单项结果，校验上面三个前提，而不是把一个缺失的 Claude 登录当成 Codex 坏了。一个缺失的 Codex 登录仍是真正的启动阻断。

```sh
cd <你的仓库>
zrig specs preview first-project
zrig up first-project --cwd . --plan
zrig up first-project --cwd .
zrig status
zrig ps --nodes --rig first-project
```

预览 starter 的席位和资源；plan 检查所选工作目录的解析和预检。启动在需要时启动 daemon；kernel 在后台 boot。读项目席位的就绪度，不只 daemon 健康。如果一个席位有认证、信任或权限提示，在派工作给它之前解决那个具名提示。模型 pin 是配置；原生 harness 必须在有后果的工作前报出预期模型。

当一个席位暂停，在启动视图里用 **o** 打开它既有终端。读提议命令、工作目录和目标实例。对一个预期的本地 `zrig` 调用，如果那是你要的范围，选原生提示的一次性批准；一个保存的命令前缀允许也影响未来匹配调用。拒绝一个意外操作，告诉同一个智能体该做什么。批准控制一个动作能否跑；沙箱控制它的文件系统和网络访问。关批准不给网络访问。

回答后，盯命令结果和智能体继续。从你的普通终端读对应队列行并转移状态。如果一个操作超时，在要求再试前读它的结果：它可能已经生效。一个投递的消息或消失的提示本身不是进展。如果启动仍在等上下文投递，对同一占用者用 **c**，然后 **r** 刷新。别为清一个提示去启动另一个席位。

`first-project` 是刻意小的起点，不是通用团队。对不同已装运行时或团队形状，在选它前检视 `zrig specs ls --kind rig` 和 `zrig specs preview <name>`。一个七席位展示是可选的，消耗更多并发容量。

## 给 owner 一个结果

比如在一个导入 CSV 文件的项目里：

```sh
zrig send dev-owner@first-project '改进缺必需列时的 CSV 导入错误：点名那一列，既有数据保持不变。加一个回归检查，请 dev-check 对确切候选做独立检查，并记录结果和我怎么试。改动保持本地；不要发布。'
```

把示例换成你仓库里的真问题。含用户该观察什么、一个边界、以及怎么查成功。owner 创建并认领一个持久任务、实现它、路由选定的独立检查。你不必在终端间转达评审。`zrig send` 是初始对话；队列和仓库产物保留工作。一个未绑定 shell 不需要冒充队列 owner。

从一个实际的 `first-project` 席位，用 `zrig queue list --limit 1000` 跟进工作：它默认范围是调用者当前工作组。`queue list` 没有 `--rig` 选项。从一个观察者 shell 或另一个工作组，用 `zrig queue list --destination dev-owner@first-project --limit 1000`，验证那些活地址后对 `dev-check@first-project` 跑同一命令。这些显示每个目的地的义务，不是整个工作组视图。一个未绑定 shell 不得冒充席位来改范围；只在确实要那个更宽视图时用 `--all-rigs`。然后读 `zrig queue show <id> --full` 和 `zrig queue transitions <id>`。一个投递的消息不是一个评审结果。读产物、操练它的行为、检查被评审的候选。

## 共享仪表盘并回到它

```sh
zrig tui --shared
```

一个新 kernel 在它既有 `operator-human` 终端里跑普通 TUI。这个命令把另一个客户端附到那个终端。**Ctrl-b，再 d** detach 而不退 TUI；用同一命令返回，视图留在原处。另一个授权智能体能捕获或操作同一个 pane。它该在改你视图前告诉你。终端不是人类收件箱，不证明谁在看。

裸 `zrig tui` 仍是独立本地视图。如果一个旧 kernel 或你退出的 TUI 显示一个 shell，在那个 shell 里跑一次 `zrig tui`。`--shared` 不启动或替换终端，所以一个缺失绑定带恢复指引上报，而不是造第二个 kernel。

Herdr 用户走同一启动和任务路径。要把受管团队放进 Herdr，用 `zrig terminal open first-project --provider herdr`；共享仪表盘用 `zrig terminal open kernel --provider herdr`。等价的 cmux provider 也可用。读打开/缺失/降级结果：一个部分终端视图不是健康团队。重复 terminal-open 调用可能造另一个 provider 工作区；想保留它时回到已打开的那个。这是终端集成，不是原生插件注册。

## 继续真实项目工作

带着下一个结果回到同一个 owner，引用早先结果。席位地址和持久队列在你关闭查看终端后存活。把意图、验收和证据放在仓库既有项目、mission 和 slice 产物里；starter 在发明一条路径前读这些。

如果项目没有工作树，从 `zrig workspace doctor` 和 `zrig scope mission create --help` 开始，然后 `zrig scope slice create --help`。创建工作前设实际预期结果。`zrig scope` 保留在构建什么。当反复协调 warrant 一个工作流时，用 `zrig workflow specs` 发现，检视它的 owner 和输入，用 `zrig workflow instantiate --help` 实例化选定名。只为做第一个本地改动不需要工作流。

对一个持续团队，[OpenRig Software Factory](../../packages/daemon/specs/agents/shared/skills/core/openrig-software-factory/SKILL.md)
提供手动/团队工作、不带 Workflow 的队列支持编排、以及一个可选显式 Workflow 路径，唤醒默认、token 成本和权限选择都可见。把它的短请求给你既有智能体。安装后，用 `zrig context show skills/core/openrig-software-factory --json` 发现兼容的随包配方；保留一个缺失/版本不匹配结果，而不是静默用更新指令。它的成长节保持三个选择清晰：留在对子、用 `zrig grow` 给在跑工作组加一两个席位（不写 YAML）、或可选地写一个自定义工作组。它覆盖新席位上下文/工作所有权、并发成本和保存扩展后 spec。本指南仍是短的首次使用路径。

## 不完整设置与重启

| 观察 | 下一步 |
| --- | --- |
| 工具缺失或登录失败 | 用具体设置/认证提示；在启动 shell 里重查那个可执行文件。别把工作派给未就绪席位。 |
| daemon 健康，kernel 仍在启动 | 读 `zrig status` 和 `zrig ps --nodes --rig kernel`；kernel 就绪是分开的。 |
| 共享终端缺失 | 检视既有 kernel 绑定和恢复状态；解决时用独立 `zrig tui`。 |
| 查看终端被关 | 用 `zrig tui --shared` 重附；别重启团队。 |
| daemon 重启但 tmux 存活 | 重读 `zrig status` 和既有队列；一次 daemon 重启不是新项目。 |
| 主机重启丢了 tmux 会话 | 打开 `zrig`，需要时启动 daemon，选既有工作组和席位。恢复是默认；新对话需单独决定。 |
| 启动报无可用快照 | 检视既有工作组和保留的项目文件，然后走下面的同席位恢复。 |
| 工作在等一个提示或决定 | 读行、转移和具名提示；保留义务直到缺失决定到来。 |

如果一个快照不可用，启动视图检查所选席位保留的启动源和权威占用者关系。它报一个缺失或歧义源，而不是选一个任意历史行。修具名源、重试，或让席位停着。继续工作前检查保留队列、项目备注和观察结果。

`zrig setup` 打印这条路径的短形式；`zrig status` 指回本页。

## Kernel 框架（`zrig setup` 做什么、不做什么）

显式 CLI daemon 启动保留它自动 kernel 行为。TUI 用 kernel 自动 boot 禁用启动 daemon，好让用户选席位：

- `zrig setup` 安装/校验运行时；它不启动 daemon 或 kernel。
- 启动 daemon（`zrig daemon start`，或通过 `zrig up` 隐式）才在后台 boot kernel 工作组。
- 从裸 `zrig` 启动不自动准备任何智能体。TUI 在连接后提供 kernel 设置和单个席位选择。
- **kernel 就绪是一个独立于 daemon 健康的信号。** daemon 的 HTTP 健康早绑；daemon up 时 kernel 可能仍在 boot、或一个 kernel 智能体可能不健康。`zrig status` 单独浮现 kernel 就绪（通过 `/api/kernel/status`）；`zrig daemon start --wait-for-kernel` 轮询它。

## scope <-> workflow 桥

两个相关原语，新操作员常混：

- **`zrig scope`** 管理**持久的、磁盘上的产物**——missions 和 slices（你工作区里的 markdown/YAML 文件）。这些是*存在什么工作*的持久记录。
- **`zrig workflow`** 管理一个**运行时实例**——当你 `zrig workflow instantiate <name>`，daemon 造一个工作流实例加一个**入口 qitem**，把第一步路由给一个 owner。这是*谁做下一步*的活协调。

Scope 文件保留工作是什么；工作流实例和它们的队列包保留谁下一步行动。创建或编辑一个 mission 不启动工作。你可以用 `zrig workflow instantiate <name>` 实例化一个命名工作流，或用 `zrig workflow compile` 显式检视一个撰写好的生命周期、用 `zrig workflow instantiate-lifecycle` 造它的运行时。单编译不启动工作。[OpenRig Software Factory](../../packages/daemon/specs/agents/shared/skills/core/openrig-software-factory/SKILL.md)
展示一个小的评审过示例，以及怎么在一次真等中保留监护。

## 让你的智能体配置权限

你选范围；智能体检视目标 harness 并应用它。比如：

> 为这个项目里的 OpenRig 命令配置持久权限。解释整个 `zrig` 命令族允许什么，合适时提供更窄动词。
> 保留既有 deny/ask 规则和无关设置，备份被碰文件，应用我的选择，然后校验重复普通读取无需额外批准。

允许所有 `zrig` 命令包括生命周期、拓扑和配置操作，不只是读。保留提示或选更宽宽松操作也是合法选择。一个既有显式选择授权常规设置；智能体不必再请你批准每次文件编辑。

用维护的**应用权限策略**流程：

```sh
zrig context get skills/applying-a-permission-policy/SKILL.md
```

在源码检出里，读[它的源](../../packages/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md)。在 npm 安装里，同一文件在
`@openrig/cli/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md`
下，相对匹配的 `npm root -g` 或本地 `npm root`。用提供你 `zrig` 可执行文件的那个版本。它覆盖 Codex/Claude 命令规则、实际配置根、保留限制和校验目标对话。一个缺失指南或不支持的原生版本是一个上报缺口，不是静默绕过的许可。

下面更宽的启动模式配方是可选的。命令族规则不需要改 starter 的沙箱或其他人默认。

## 选投宽松操作

宽松操作让智能体以你账户的文件系统和网络访问行动，权限停顿更少。它们能损坏文件或发数据而不再要确认。只在你刻意信任的工作和环境里用；它不提供缺失凭据，也不覆盖组织策略。

在一个**用户拥有的 spec 首次启动前**做改动。要自定义 starter，跑 `zrig specs show first-project --kind rig` 找它的 `Path`，结尾是 `specs/rigs/launch/first-project/rig.yaml`。把整个 `specs` 目录拷到你仓库里的 `./openrig-specs`，保持布局：只拷 `rig.yaml` 会弄坏它相对的智能体和文化引用。别碰安装副本。下面示例用 `./openrig-specs/rigs/launch/first-project/rig.yaml`。如果你已有一个在跑的 `first-project`，改它前走下面既有会话建议；这不是一个活权限开关。

### Codex：一起选沙箱和审批

对支持命名 `.config.toml` profile 的 Codex 版本，创建 `~/.codex/first-project-permissive.config.toml`（如果你为 daemon 启动环境设了 `CODEX_HOME`，则放其下）：

```toml
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

在拷来的工作组里，给每个要用它的 **Codex 成员**加这个字段；保留成员既有 `profile: default`：

```yaml
codex_config_profile: first-project-permissive
```

让 `permission_policy` 缺省或设为 `none`，没有成员级 YOLO 覆盖。OpenRig 然后传 `-p first-project-permissive` 而非默认 `-s workspace-write`，所以原生 profile 同时供两个设置。更高优先级原生项目配置或受管要求仍可改/拒绝结果。派工作前检视原生 `/status`。

```sh
zrig policy current --spec ./openrig-specs/rigs/launch/first-project/rig.yaml
zrig up ./openrig-specs/rigs/launch/first-project/rig.yaml --cwd . --plan
zrig up ./openrig-specs/rigs/launch/first-project/rig.yaml --cwd .
```

OpenRig 的 `permission_policy: builtin:yolo` 设置在 fresh、resume 和 fork 启动上选 `-s danger-full-access -a never`，替换命名 profile 参数。上面 profile 配方在你想把那些选择维护在原生配置里时仍有用。旧的纯环境 `OPENRIG_YOLO=1` 路径在无解析策略时仍是纯沙箱。一个独立 `codex --yolo` 命令不是 OpenRig 设置。

要回到受限的下次启动，把选定 profile 改成：

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
network_access = false
```

### 逐席位权限模式

权限模式是原生执行选择；工作姿态是项目指引。对一个既有受管席位，显式选未来启动权限：

```sh
zrig seat set-permissions owner@first-project --mode full_bypass --reason "操作员选了更宽访问"
zrig seat status owner@first-project --json
```

这在那个席位上记录行动者、理由和旧/新选择。它不重启它、不改原生历史、不改兄弟席位、不编辑权限规则/hooks。后来的生命周期动作仍是单独决定。显式席位选择覆盖继承的成员/工作组策略；`--mode inherit` 清它而不改那个继承策略。`floor` 选既有正常启动路径（含配置了的 Codex 命名 profile）；它不改写原生 profile 或强加其审批设置。

Codex 和 Claude 接受 `floor` 和 `full_bypass`。其他 Claude 原生模式，包括 `auto`，需要受管可执行文件 help 广告的支持。OpenRig 在席位绝对工作目录的受管启动 PATH 上解析第一个可执行文件，然后用那个确切路径做发现和启动。它不用交互 shell 别名或 shell 改过的 PATH。相对 PATH 条目和相对 `CLAUDE_CONFIG_DIR` 从席位目录解析。

对这些显式原生模式，fresh、resume、fork 和旧 restore 用同一受管环境：PATH、HOME、`CLAUDE_CONFIG_DIR`（默认 HOME/.claude）和配置的经典渲染器设置。其他 shell 定制被排除。既有受管身份和允许的 provider-auth 通道按变量名保留；凭据不拷进启动命令或能力证据。Help 在无那个凭据通道下跑。既有登录文件留在受管 home 下。选模式前刻意配 daemon 的受管启动环境；这不是对任意交互 shell 的探测。

每次选择和每次后来启动都重查支持，无缓存。一个变化的节点/占用者、绑定、cwd、可执行文件或能力环境在下次检查拒绝：help 后、选择/审计变更前、以及粘贴和 Enter 紧前。有效粘贴后的失败是部分输入，不是成功启动，也不是早先输入被回滚的主张。既有显式选择在拒绝时保留；不选回退。普通和继承启动路径不变。状态响应区分期望设置、代次绑定的启动参数和一个未验证的原生效果。授权启动后、声称其实际权限行为前，检视原生会话。

工作组级动词是 `zrig policy permissions list`、`show`、`current` 和 `apply`。既有 `zrig policy list/show/current/apply` 保留为兼容别名，JSON 和退出行为相同。Pi 资源信任和逐席位输入守卫是分开控制。

### Claude Code：不同的启动标志

随包 `first-project` 用 Codex。对一个用户拥有的 **Claude Code** 工作组，OpenRig 通常传 `--permission-mode acceptEdits`：编辑可继续，其他动作遵循原生规则和提示。它不加一个全局 `Bash(rig:*)` 允许。要为那个工作组显式选绕过启动标志：

```sh
zrig policy apply yolo --spec ./my-claude-rig/rig.yaml
zrig policy current --spec ./my-claude-rig/rig.yaml
```

这记录 `permission_policy: builtin:yolo`；下次受管启动传 `--dangerously-skip-permissions`。成员级策略优先。要把未来启动回到 OpenRig 的 `acceptEdits` 模式，用 `zrig policy apply none --spec ./my-claude-rig/rig.yaml` 并移除任何成员级绕过覆盖。原生规则和受管限制仍要紧；这个标志不是对沙箱或账户访问的承诺。见[Claude 权限](https://code.claude.com/docs/en/permissions)。

**已在跑：** 改一个文件或跑 `zrig policy apply` 不撤销一个活智能体的权限，也不在恢复时改写一个存储工作组的策略。暂停工作，对那个对话用原生权限控制（当前 Codex 和 Claude CLI 暴露 `/permissions`）；重查生效模式。后续启动保持启动 spec/profile 一致。如果原生版本不能就地应用改动，保留工作，检查其保留策略后用支持的同席位 stop/resume 路径；别删工作组或启动一个副本来重置权限。一次恢复可重新应用存储的启动模式，所以继续工作前再验原生模式。

## 自定义设置与优先级

- **OpenRig：** 成员 `permission_policy` 覆盖工作组 `permission_policy`。正常受管启动在两者都未设时显式绑默认模式；在客户端 shell export `OPENRIG_YOLO=1` 不是可靠的逐团队配方。一个自定义策略文件相对声明它的工作组 spec，无绝对路径或 `..`。`surface: flag` 选一个启动模式。配置面策略（`locked`、`standard`、`open` 或自定义）描述意图：记录一个不翻译并强制其规则。分别应用并检视实际原生设置。见[RigSpec 策略引用](rig-spec.md#attaching-a-permission-policy)。
- **Codex：** 个人设置在 `~/.codex/config.toml` 或 `CODEX_HOME`；受信项目设置在 `.codex/config.toml`。当前优先级是 CLI 覆盖、受信项目设置、选定 profile、用户设置、云默认（如提供）、Unix 上 `/etc/codex/config.toml`、然后内置默认，受受管要求约束。OpenRig 显式沙箱标志赢过一个文件的 `sandbox_mode`；要自定义沙箱用 `codex_config_profile`。要带网络访问、保留审批做工作区编辑，用一个命名 profile，`sandbox_mode = "workspace-write"`、`approval_policy = "on-request"`、`[sandbox_workspace_write]` `network_access = true`。那授予一般网络访问，不只到本地 daemon。见 [Codex 配置](https://learn.chatgpt.com/docs/config-file/config-basic) 和[沙箱/审批控制](https://learn.chatgpt.com/docs/agent-approvals-security)。
- **Claude Code：** 用 `~/.claude/settings.json`、共享项目 `.claude/settings.json`、或个人项目 `.claude/settings.local.json`。受管设置先于启动标志，然后项目本地、项目共享和用户设置。权限规则列表合并；一个高层 allow 不是击败 deny 的办法。OpenRig 的 `acceptEdits` 启动标志覆盖一个文件的 `permissions.defaultMode`；选定运行时资源也可合并进项目本地设置。见 [Claude 设置与优先级](https://code.claude.com/docs/en/settings) 和 [OpenRig 的运行时配置披露](agent-startup-guide.md#runtime-config-disclosure)。

这些配方不建立每个提供商/版本/配置组合。检查已装版本和生效设置。更新的权限 profile 或自动评审功能是提供商选择，不是隐式 OpenRig 能力。选规则或更宽模式不改随包默认。
