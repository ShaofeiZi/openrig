# OpenRig（中文版 zrig）

> 中文说明：本文件是 OpenRig 官方 README 的简体中文配套版本。zrig 是 OpenRig 的中文版本品牌名，由本仓库源码构建而成；**zrig 尚未发布到 npm**，请勿按下文以外的方式去 npm 下载安装。在本仓库检出并构建后，用仓库根目录的 `./zrig` 脚本调用；旧命令名 `rig`、`openrig` 作为兼容入口仍然可用，行为完全一致。

[![npm version](https://img.shields.io/npm/v/@openrig/cli)](https://www.npmjs.com/package/@openrig/cli) [![npm downloads](https://img.shields.io/npm/dw/@openrig/cli)](https://www.npmjs.com/package/@openrig/cli) [![License: Apache 2.0](https://img.shields.io/github/license/mvschwarz/openrig)](LICENSE) [![GitHub stars](https://img.shields.io/github/stars/mvschwarz/openrig?style=social)](https://github.com/mvschwarz/openrig/stargazers)

> 上方 npm 徽章反映的是上游英文包 `@openrig/cli` 的状态；本中文版 zrig 不从该 npm 包安装。

一个运行框架（harness）包住一个模型；一个工作组（rig）包住你手头的所有运行框架。用 YAML 定义你的智能体团队，一条命令启动它。Claude Code 与 Codex 在同一个工作组里，作为一个系统来管理。

OpenRig 把 AI 编程智能体从一堆散落的终端会话，变成一个持久、有序的团队。你向一个首席智能体说明想要的结果；它可以跨团队协调各专家智能体，把结果和需要你拍板的决策带回来。从一个仓库、一项有用的改动起步，然后让整个团队的工作和上下文一直待在同一个地址。

## 安装与首次运行

需要 Node.js 22 或 24、tmux，运行在 macOS 或 Linux 上。Apple 芯片的 Mac 请使用 Node.js 22（[兼容性历史](docs/releases/v0.5.15.md#known-compatibility-limitation)）。暂不支持原生 Windows，WSL2 未经验证。启动工作组会写入服务商 hooks 和工作区信任设置。运行下面的命令之前，请先阅读[OpenRig 会在你的机器上改动什么](#openrig-会在你的机器上改动什么)，并备份相关文件。

### 从源码构建并运行（zrig 的唯一安装方式）

zrig 是本仓库的中文构建，尚未发布到 npm。请按下列步骤从源码构建：

```bash
git clone https://github.com/mvschwarz/openrig.git
cd openrig
npm install
npm run build          # 构建所有工作区（daemon、cli、tui、ui）
./zrig --help          # 查看 zrig 全部命令
./zrig setup --dry-run # 预览安装计划（不实际写入）
```

> 说明：仓库根目录的 `./zrig` 是一个薄包装脚本，它把参数转发给已构建的 `packages/cli/dist/bin-wrapper.js`，并以中文品牌名 `zrig` 渲染帮助与版本。如果还没跑过 `npm run build`，`./zrig` 会提示你先构建。旧入口 `rig`、`openrig` 同样可用。

如果你想用 Bun 运行上游英文包，可执行 `bun add -g @openrig/cli`；但那安装的是上游英文版，不是本中文版 zrig。OpenRig 运行时仍依赖 Node.js，因此即使使用 Bun 也需要安装 Node.js 22。Bun 可能拦截该包的 postinstall 脚本；那样的话，下文[OpenRig 会在你的机器上改动什么](#openrig-会在你的机器上改动什么)中描述的 Node.js 与 SQLite 检查就不会在安装时执行。

在应用 `./zrig setup` 之前，请先审阅它的计划：它会检查原生运行框架和 cmux。下面这个入门示例需要 tmux 和已登录的 Codex；对于它所演示的仓库任务，另一个运行框架和终端服务商是可选的。

启动之前，请让你的智能体[配置你选定的权限](docs/reference/getting-started.md#have-your-agent-configure-permissions)：保留提示、记住已选命令，或者有意识地选择更宽的访问范围。设置与验证由智能体完成；OpenRig 自带的默认配置保持不变。

在启动用的 shell 里检查前置条件：

```bash
tmux -V
codex --version
codex login status
```

先装好缺失的工具或完成登录，再继续。在你的仓库目录下，先审阅计划，再启动两个 Codex 席位——一个 owner（负责人）和一个 checker（检查者）：

```bash
cd /path/to/your/repository
./zrig up first-project --cwd . --plan
./zrig up first-project --cwd .
./zrig tui --shared
```

内核（daemon）提供独立的运行支持，以及共享的仪表盘。要在不停止仪表盘的情况下脱离，按 Ctrl-b 再按 d；用 `./zrig tui --shared` 回到那个视图。直接用 `./zrig tui` 会打开一个独立视图。关闭查看用的终端，并不意味着你该重新拉起整个团队。

用 `./zrig ps --nodes --rig first-project` 检查项目席位是否就绪；在分派工作之前，先处理好任何认证、信任或权限提示。然后从你的仓库里给 owner 一项边界清晰的任务：

```bash
./zrig send dev-owner@first-project '实现<一项有用的改动>。把任务记入队列并返回它的 ID。保持在本地，验证行为，请 dev-check@first-project 检查这个具体候选改动，并记录结果以及我该如何试用。'
./zrig queue list --destination dev-owner@first-project --limit 1000
```

发消息本身并不会创建队列项；任务由 owner 记录下来。阅读最终产物以及对其具体候选改动的评审，然后回到同一个 owner 做下一项改动。[引导式首次使用路径](docs/reference/getting-started.md)涵盖了就绪检查、一项有用任务、一次经过评审的结果、Herdr/cmux 终端以及恢复操作。

## 看它跑起来

![OpenRig TUI：构建工作组以图的形式展示，再以席位表格展示（含运行时、模型、上下文和状态），最后是单个席位的详情（真实录屏，10 秒）](assets/readme/openrig-agents-working.gif)

## 社区

- **提问：** [Discussions › Q&A](https://github.com/mvschwarz/openrig/discussions/categories/q-a)
- **Bug 与功能请求：** [新建 issue](https://github.com/mvschwarz/openrig/issues/new/choose)
- **参与贡献：** [CONTRIBUTING.md](CONTRIBUTING.md) · [行为准则](CODE_OF_CONDUCT.md) · [安全政策](SECURITY.md) · [获取帮助](.github/SUPPORT.md)
- **视频：** [youtube.com/@openrig](https://www.youtube.com/@openrig)
- **发布：** [GitHub Releases](https://github.com/mvschwarz/openrig/releases) 与 npm 上的 `@openrig/cli`

我们力争在一天内回应 issue 和 pull request；评审时限见 [CONTRIBUTING.md](CONTRIBUTING.md#what-to-expect-from-us)。

## OpenRig 会在你的机器上改动什么

OpenRig 会在设置和运行过程中写入实例状态、服务商集成文件和工作区文件。其中包括**信任设置和可执行 hooks**。下面的汇总对应本源码版本；使用已发布包时请用 `./zrig --version` 核对版本，因为仓库里的指引可能领先于 npm。

| 时机 | 改动内容及原因 |
| --- | --- |
| **npm 安装** | 把 CLI、打包组件和依赖安装到你的 npm prefix 下（用 Bun 时则在 Bun 的全局目录）。OpenRig 的 postinstall 会检查 Node.js 版本以及 SQLite 模块能否加载；Bun 可能拦截该脚本。它不会运行 daemon 或服务商设置。 |
| **`zrig setup`** | 尝试补齐缺失工具，并在 `~/.tmux.conf` 中写入一个 OpenRig 块，用于鼠标支持和回滚滚动。在 macOS 上它可以安装 cmux，并在 `~/.config/cmux/settings.json` 中启用其自动化 socket 控制。`--full` 会额外安装工作站工具。`--dry-run` 只展示设置计划而不应用。 |
| **Daemon 启动** | 在 `OPENRIG_HOME`（通常是 `~/.openrig`）下创建/更新实例状态，包括数据库和受管插件资源。在 `~/.claude/skills` 和 `~/.agents/skills` 中植入 `openrig-skills` 发现 skill（受既有版本归属约束）。当 `runtime.codex.hooks_enabled` 开启（默认）时，会按下文所述写入 Codex hook 配置和信任记录——即使还没启动任何工作组也会写。 |
| **工作组/席位启动与挂载** | 创建 tmux 会话，提供席位身份和 daemon 连接环境，并把选定的指引、skills、插件和运行时资源投射到工作区。受管启动会预先信任该工作区。Claude 上下文采集也可以为已挂载会话配置，并在监控期间刷新。 |
| **显式权限配置** | 内置的 bootstrap **不会**添加 `rig` 命令允许规则。请让你的智能体[按你选定的项目或用户范围应用权限](docs/reference/getting-started.md#have-your-agent-configure-permissions)；既有规则仍然有效。更宽的访问范围是另一项独立选择。 |

服务商文件与实例状态是分开的。这里的 `~` 指 daemon 运行用户的家目录；仅改 `OPENRIG_HOME` 并不能隔离服务商配置。

- **Claude Code：** 受管启动会把工作区信任和 onboarding 完成状态写入 `~/.claude.json`。在工作区内，`.claude/settings.local.json` 会收到上下文采集器的 `statusLine` 命令和选定的活动 hooks；辅助脚本位于 `.openrig/` 下。选定的 settings/MCP 资源也可能改动该 settings 文件和 `.mcp.json`。共享 settings 资源会把 `permissions.defaultMode` 设为 `acceptEdits`，并启用 Exa/Context7 MCP 条目；选定的 MCP 资源会配置那些外部服务。内置 bootstrap 不再向 `~/.claude/settings.json` 写入命令允许清单，也不移除旧的允许项。信任写入器使用 daemon 家目录，因此自定义 `CLAUDE_CONFIG_DIR` 并不能整体迁移这些写入位置。
- **Codex：** 写入 daemon 的 `CODEX_HOME/config.toml`（通常是 `~/.codex/config.toml`）。启动时启用 hooks，加入 OpenRig 活动中继命令，并为这些命令预写信任哈希。席位启动会为该工作区加上 `trust_level = "trusted"`；选定的配置资源可以加入 MCP 设置。已识别的更新提示可以在启动时跳过，并把跳过的版本记入 Codex 缓存；这并不是安装更新。

活动中继会把事件类型/子类型、席位/运行时身份、时间戳和原生会话身份，通过活动令牌发送到已配置 OpenRig daemon 的 `/api/activity/hooks` 端点。该载荷不包含提示词正文和工具参数。Claude 的采集器会把上下文/token 用量、会话/转录路径元数据和可用的限流数据，写入实例的 `state/context-usage` 和 `state/provider-usage`。服务商和选定的 MCP 连接有各自的数据流。daemon 插件初始化还会在 GitHub 上检查 OpenRig 插件发布端点。

受管启动会提供 `HOME`、`CODEX_HOME` 和 `OPENRIG_*` 身份/连接变量。Claude 使用 `--permission-mode acceptEdits`，并默认使用经典渲染器以支持终端回滚滚动。Codex 使用 `-s workspace-write`，除非有具名 profile 接管它的沙箱；默认不强制指定审批策略标志。全新的 Codex 启动还会用 `--add-dir` 额外授予对工作区 `.git` 和 pod 共享队列状态目录的写权限；共享根目录来自 `OPENRIG_SHARED_DOCS_ROOT` 或 `~/.openrig/shared-docs`。

YOLO 默认**关闭**。显式选择的全量绕过策略会选用 Claude 的 `--dangerously-skip-permissions` 或 Codex 的 `-s danger-full-access -a never`。旧的、仅靠环境变量的 `OPENRIG_YOLO=1` 路径仍然只选择 Codex 沙箱；一旦解析出明确策略，就会覆盖该环境设置。

权限模式控制原生执行权限；工作姿态（work posture）是另一回事，属于项目指引。用 `./zrig policy permissions list|show|current|apply` 配置工作组策略（四个 `rig policy` 别名保持兼容）。用 `./zrig seat set-permissions <seat> --mode <mode> --reason <text>` 做一个留痕的未来启动选择：`floor`、`full_bypass`，或用 `inherit` 清除该席位的覆盖。其他 Claude 模式（如 `auto`）需要席位工作目录下那份确切的受管 Claude 可执行文件支持；选择和启动时都会检查。不受支持或已变化的上下文会拒绝且不回退。这不会重启该席位，也不会改变它当前的原生进程、历史、规则或 hooks。`./zrig seat status` 把"期望选择"与"上次启动参数"分开列示；两者都不能证明原生层面真正生效。见[权限指南](docs/reference/getting-started.md#per-seat-permission-mode)。

受管的 hook 区块只针对 OpenRig 自己的条目，保留无关 hooks，但信任条目、选定的资源键以及 Claude 既有的 status-line 命令可能被替换。某些写入器会把读不出来的设置恢复为空对象；这并不等于完整保留或可回滚。首次使用前请备份相关文件。daemon/bootstrap 的写入是自动的，每次都没有交互式预览；`./zrig setup --dry-run` 也不会预览之后每次启动的所有副作用。

## 它做什么

OpenRig 是一个多智能体运行框架（multi-agent harness）——它管理的是你把多个编程智能体一起跑起来时它们所形成的那个系统。不是智能体本身，而是它们组成的团队：哪些会话在跑、它们之间是什么关系、重启后如何恢复，以及如何避免终端会话无限蔓延。

- 用 YAML **定义**拓扑（RigSpec），包含 pod、边和连续性策略
- 用 `./zrig up` **启动**一切——tmux 会话、运行框架、启动文件、就绪检查
- 在 TUI 的拓扑表格和图中**查看**工作组、pod 和席位；检查项目、spec、feed 和实例健康状态
- **发现** tmux 中已有的 Claude Code 和 Codex 会话，并把它们**接纳**进受管工作组
- 用 `./zrig down --snapshot` **快照**拓扑，用 `./zrig up <name>` 按名字**恢复**
- 通过 `./zrig send`、`./zrig broadcast`、`./zrig chatroom` 在智能体之间**通信**
- 保护你亲手输入的席位：`./zrig seat set-typing-guard <seat> --enabled true --reason <text>` 会拦住自动消息、改为唤醒你，而不是把内容打进那个席位（默认关闭；见 `./zrig seat set-typing-guard --help`）
- 通过一个你在自己工作区里创建的应用**连接** Slack；实验性命令 `./zrig slack manifest` 会打印该应用的 manifest（[设置指南](docs/reference/slack-app-setup.md)）
- 用 `./zrig grow`、`./zrig shrink`、`./zrig launch`、`./zrig remove` **演进**运行中的拓扑

每个智能体都跑在一个 tmux 会话里，你可以随时 attach、查看、直接操作。

## 入门工作组

聚焦的首次使用路径用 `first-project`。`product-team` 是一个可选的、更大的产品开发示例：

```bash
./zrig specs preview product-team --kind rig
./zrig up product-team
```

当你想要一个更大的产品小队时用它：两个编排者、实现、QA、设计，以及两个独立评审。

想要更小的入门示例，用 `conveyor`：

```bash
./zrig specs preview conveyor --kind rig
./zrig up conveyor
```

`conveyor` 是一个混合 Claude Code 和 Codex 的四席位入门示例。它展示了一条从 intake、规划、构建到评审的交接链路；`first-project` 仍然是更小的两席位起点。

还附带：`implementation-pair`、`adversarial-review`、`research-team`，以及 `secrets-manager`（由一个专家智能体管理的 HashiCorp Vault）。

浏览整个库：

```bash
./zrig specs ls
```

## 它如何工作

OpenRig 是一个本地 daemon + CLI + 终端 UI + MCP 服务器，构建在 tmux 之上。较老的 React Web UI 处于维护模式，仅尽力支持。

```
CLI / TUI / MCP
      |
Hono HTTP daemon
      |
  领域服务
      |
  SQLite + tmux + 运行时适配器
```

- **CLI：** 供人和智能体使用的命令，用于拉起团队、查看状态、发消息、跟踪自己负责的工作、管理上下文。
- **TUI：** 拓扑浏览器，表格和图两种视图、席位详情，以及 Specs、Projects、Terminals、Feed、System。用键盘、鼠标或命令栏导航。
- **MCP：** 让智能体能够管理自己拓扑的工具（`rig_up`、`rig_ps`、`rig_send`、`rig_chatroom_send` 等）。
- **运行时：** 原生 Claude Code 和 Codex 会话、终端节点，以及一个在终端 pane 内用 RPC runner 运行的 Pi 适配器。

## 终端 UI 与工作区

TUI 展示团队的协调状态；herdr 和 cmux 在旁边展示智能体的真实终端。用 `./zrig tui commands` 列出 TUI 命令栏导航，或[体验交互式 TUI 导览](https://openrig.dev/tour/workspace)。

![OpenRig TUI 拓扑图，七个智能体席位被分成 product、development、QA 三个 pod](assets/ui/screenshots/tui-topology.png)

*截图取自交互式 TUI 演示，使用的是虚构项目数据。*

安装并连接 herdr 后，一次性打开入门示例的所有终端：

```bash
./zrig terminal open first-project --provider herdr
```

用 cmux 则加 `--provider cmux`。在 TUI 中，某个工作组的详情视图有一个 `term ▸ rig <name>` 链接，会用默认终端服务商打开该工作组所有运行中的席位；用 herdr 时每个标签页最多 16 个席位，放在一个以该工作组命名的工作区里。底层会话仍可通过 tmux 访问。设置和返回已有视图的方法见[终端工作区指南](docs/reference/getting-started.md#share-the-dashboard-and-return-to-it)。

## 核心概念

- **RigSpec：** YAML 声明式多智能体运行框架定义。包含 pod、成员、边、连续性策略和文化文件。
- **AgentSpec：** 可复用的智能体蓝图，含 skills、指引、hooks、profile 和启动契约。
- **席位（Seat）：** 工作组中一个稳定的角色和地址，例如 `dev-owner@first-project`。占用它的对话可以更换，但它的身份和沉淀的上下文保持不变。
- **Pod：** 一组相关席位，共享指引和上下文。每个智能体仍有自己独立的上下文窗口。
- **发现（Discovery）：** `./zrig discover` 为已有的 tmux 会话做指纹识别；`./zrig adopt` 把它们纳入管理。
- **快照/恢复：** `./zrig down --snapshot` 捕获完整状态；`./zrig up <name>` 从最新快照恢复。恢复会逐个节点报告结果（已恢复、全新启动或失败）。
- **RigBundle：** 带 vendor 化 AgentSpec 和 SHA-256 完整性校验的可移植归档。可跨机器共享拓扑。
- **文化（Culture）：** CULTURE.md 设定整个团队的协调规范。研究类工作组用探索型文化；实现类工作组用保守的"信任但验证"文化。

## 由智能体管理的软件

一个工作组可以把实际软件和管理它的智能体一起打包。自带示例是 `secrets-manager`：一个由专家智能体操作的 HashiCorp Vault 实例。

```bash
./zrig up secrets-manager
./zrig env status secrets-manager
./zrig send vault-specialist@secrets-manager "检查 Vault 健康状态并汇报。" --verify
```

服务型工作组需要 Docker。

## 升级已有实例

对于已有安装，请遵循[升级流程](skills/_canonical/core/openrig-upgrade/SKILL.md)和 [0.5.14 发布说明](docs/releases/v0.5.14.md)。升级期间保留在线席位；`./zrig down` 不是升级步骤。升级到 0.6.0 还需要 Node.js 22 或 24：见[从 Node 20 迁移](#从-node-20-迁移)和 [0.6.0 发布说明](docs/releases/v0.6.0.md)。

### 从 Node 20 迁移

OpenRig 0.6.0 只支持 Node.js 22 和 24。它的 SQLite 绑定（better-sqlite3 13）要求 Node 22 或更新版本。Node 20 不再支持；安装检查会拒绝并给出解释。

如果你在 Node 20 上跑 OpenRig，请先切换 Node，再在新 Node 下重装 CLI（版本管理器会为每个 Node 保留独立的全局包集合）：

```bash
nvm install 22          # 或 24；fnm 或你的包管理器同理
npm install -g @openrig/cli
./zrig --version
```

你已有的 OpenRig 数据原地不动。daemon 会在新绑定下重新打开同一个数据库，并就地应用任何待处理的迁移。按上面的升级流程，在新 Node 下重启 daemon。

### 跨越 0.5.9 的布局边界

从 0.5.9 之前的实例升级时，下面的迁移仍然适用。

0.5.9 把 `$OPENRIG_HOME/context` 变成可寻址的上下文库，把 Claude 遥测写入 `state/context-usage`（服务商遥测写入 `state/provider-usage`），并在 `context/system/system-world.yaml` 安装默认 System World。已有实例通过自带 `openrig-upgrade` skill 执行一次**智能体操作的迁移**来跨越这个边界。目标运行时采用"规范路径优先、旧路径回退"的读取方式，而新写入使用规范根目录；自定义的上下文库根目录在激活期间保持稳定。这不是让你趁旧采集器还在写的时候去手工改目录名。

```bash
# SKILL_DIR 是已安装的 openrig-upgrade skill 目录。
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --help
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME"
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME" --apply-state --preimage /safe/path/layout-0.5.9-before

# 分别激活确切的目标运行时。每一段有界的旧尾部之后，两个新 state 根目录都要有更新的成对采样：
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME" --verify --preimage /safe/path/layout-0.5.9-before > /safe/path/layout-0.5.9-verify.json

# 只有拿到那份确切收据后，才运行单独调用的、非破坏性的收尾器：
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME" --apply-library --preimage /safe/path/layout-0.5.9-before --verification /safe/path/layout-0.5.9-verify.json

# 若观察到的升级必须回退，只恢复由辅助脚本拥有的准备/收尾副作用：
node "$SKILL_DIR/scripts/migrate-telemetry-state-0.5.9.mjs" --home "$OPENRIG_HOME" --rollback /safe/path/layout-0.5.9-before
```

`--help` 只打印阶段语法，不会清点实例。不带任何阶段标志会故意跑只读计划；未知选项会在计划或变更之前以非零码失败。

每个阶段都输出 JSON。遇到任何问题或不完整的收据就停下，按它给出的 `next` 动作继续；不要从复制来的旧遥测继续跑，也不要盲目重试一次半途的变更。准备阶段会保留旧状态和采集器设置。校验阶段只有在同一席位的 `state/` 下已有更新的成对上下文与服务商采样时，才接受对应的尾部字节；收尾阶段会重新校验被接受的尾部，复制上下文库而不覆盖已有内容，最后才切换配置。该辅助脚本从不删除旧遥测或上下文库。退役流程另有独立的稳定运行时、写入器、读取器和恢复证明。daemon、数据库、席位、插件和发布生命周期动作仍由智能体负责。

## 系统要求

- Node.js 22 或 24（本发布支持的版本）。Node 20 不再支持。Node 26 及其他版本未经验证。Apple 芯片 Mac 请用 Node.js 22：见[兼容性历史](docs/releases/v0.5.15.md#known-compatibility-limitation)。
- tmux
- macOS 或 Linux。暂不支持原生 Windows，WSL2 未经验证

可选：
- herdr 或 cmux，用于把智能体终端聚在一起展示的终端工作区
- Docker，用于服务型工作组和受管应用

## 设置与故障排查

- `./zrig setup` 会尝试做核心机器准备：tmux、cmux、Claude Code、Codex，以及 tmux 默认设置。它会报告尝试了什么、实际成功了什么。如果有失败，它会给本地智能体足够的上下文去把活干完。
- `./zrig setup --full` 在核心之上尝试更宽的操作员工作站设置（jq、gh）。
- `./zrig doctor` 检查当前系统健康状态，帮你在设置后诊断问题。当某些东西停止工作或机器发生变化时使用它。

这两个命令都支持 `--json`，便于智能体驱动的工作流。

在设置或受管启动之前，请回顾[OpenRig 会在你的机器上改动什么](#openrig-会在你的机器上改动什么)，包括服务商信任、hooks 和选定的运行时资源。

已在运行的、被接纳的会话可能需要重启，才会加载新写入的运行时配置。

**给智能体：** 在选择调用方式之前，先问用户要核心设置（`./zrig setup`）还是更完整的工作站路径（`./zrig setup --full`）。用 `--json` 检查结果，并用 `./zrig doctor` 处理剩余的机器相关问题。

## 与 Claude 托管智能体的对比

OpenRig 开源、自托管，并且让 Claude Code 和 Codex 在同一个团队里。你在自己的基础设施上运行它；所选服务商的模型用量费用照常产生。

[完整对比](https://openrig.dev/compare/claude-managed-agents)

## 链接

- **网站：** [openrig.dev](https://openrig.dev)
- **文档：** [openrig.dev/docs](https://openrig.dev/docs)（[面向智能体的文档索引](https://openrig.dev/llms.txt)）
- **博客：** [openrig.dev/blog](https://openrig.dev/blog) · [我为什么做 OpenRig](https://esoteric.run/blog/why-i-built-openrig)
- **开放规范：** [openrig.dev/specs](https://openrig.dev/specs)
- **视频：** [youtube.com/@openrig](https://www.youtube.com/@openrig)
- **X：** [@_feralmachine](https://twitter.com/_feralmachine)
- **关注项目：** [openrig.dev/follow](https://openrig.dev/follow)

## Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=mvschwarz/openrig&type=Date)](https://star-history.com/#mvschwarz/openrig&Date)

## 许可证

Apache 2.0
