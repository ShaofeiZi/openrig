---
kind: as-built
title: OpenRig CLI 参考——完整 rig 命令界面
status: active
topics: [runtime-control, agent-runtime]
domains: [operating-advisor, engineering-advisor, orchestrator]
applies-when: |
  需要了解准确的 rig CLI 界面时使用——命令组、子命令、flags、JSON 输出、跨 host 与协调原语。
siblings: [README.md, architecture/daemon-core.md]
prerequisite-reads: [README.md]
last-verified-against-source: b13a8e4c7
last-updated: 2026-06-20
---

# OpenRig CLI 参考

已于 2026-06-15 对照已发布 CLI（v0.3.4）验证，使用：

- `packages/cli/src/index.ts`
- `packages/cli/src/commands/*.ts`
- `packages/cli/src/mcp-server.ts`
- `node packages/cli/dist/index.js ... --help` 的 live help

本文档反映当前已发布的 `rig` 界面。当 live help 文本比实现更窄时，说明会明确指出。

## Terminal dashboard 入口

TUI 的 **Connections** 区域（`connections` 或 `:connections`）显示运行中的 daemon 与启动 CLI
identity、带来源的已选 instance settings、已观测 rig 与已编写 Spec、Slack 配置与运行中的 wire
状态，以及带 primary/secondary binding 的已注册 human。`back` 返回打开 Connections 前的工作视图。
该视图提供受支持的 CLI 指引；不会启用 connector、改变设置或发送测试消息。

Connections 读取被动 `GET /api/gateway/connections` projection。它从 settings、config、human
registry 与 gateway status 中选择安全字段；省略 secret value/reference 与 raw error。如有 wire
activation digest，则与当前 config 比较。最近一次 Slack verification 来自现有 channel-operation
audit tail 中至多 64 KiB，并与当前配置匹配，标注其时间/actor。这是历史 scope 与 channel-membership
证据，不是当前 reachability、credential identity、delivery 或 readership 证明。missing、failed、
incomplete 与 changed observation 保持可区分；不支持该 projection 的旧 daemon 显示为 unavailable。
请使用该 instance 上显示的指引；`rig slack verify --json` 会显式联系 Slack。普通导航/刷新不会。

`rig tui` 通过与裸 `rig` 相同的入口打开独立 TUI。`rig tui --shared` 要求交互式输入/输出与
loopback daemon 连接。它解析 kernel 已绑定的 `operator.human` terminal，并附加本地 tmux client，
不会启动 seat 或另一个 TUI。先按 Ctrl-b，再按 d 即可 detach；重新 attach 会保留导航状态。binding
缺失或有歧义时，会给出检查指引并失败，而不是创建另一个 kernel。

新 kernel terminal 会自动启动 `rig tui`。较旧 terminal 或已退出 TUI 的 terminal 会保留 shell：
在其中运行一次 `rig tui`。kernel view 使用 TUI instance `kernel`；独立运行使用普通 instance。
`rig tui commands --json` 暴露供 agent 控制的 command registry。在普通 shell 中，Tab 会根据当前
snapshot 补全命令名/alias、section jump 与参数。有歧义的 prefix 会显示 candidate；继续输入并再次
按 Tab。无匹配时保留文本。Enter 执行；Escape 清空。自由文本 filter 不补全。Bracketed paste 是文本，
绝不会隐式提交命令。

Recent 显示有序、自动换行的 queue change。在 event 上按 Enter 打开原始 record（包括 raw timestamp）；
Escape 返回上一 view/scroll。已记录 change 始终保留其 attributed claim，包括尝试与失败。

TUI 绝对时间使用 `ui.timezone`，默认为 `America/Los_Angeles`，遵循原生夏令时规则。在 TUI 中运行
`timezone` 可查看当前值与设置指引。`rig config set ui.timezone Europe/London` 持久化替代值；
`rig config reset ui.timezone` 恢复默认值。修改后重新打开 TUI。`OPENRIG_UI_TIMEZONE` 覆盖文件设置。
无效设置会显示可见 fallback notice。相对时间与已存 source timestamp 不变。

另见[首次使用流程](../reference/getting-started.md)。

## Daemon 关闭

`rig daemon stop` 最多向本地状态所标识的 live daemon 发送一次 SIGTERM。显式 `OPENRIG_URL` 若与
该目标不一致，会在发信号前拒绝。daemon 有一个统一的 **10 秒**预算，用于异步关闭 service、connection
与 recorder drain；重复 SIGINT/SIGTERM 会加入同一次停止。CLI 最多等待进程退出 **12 秒**，随后即使
`daemon.json` 已删除，也会验证原 PID 与 listener。refused listener、responding listener 与 unavailable
probe 是不同 outcome。

`$OPENRIG_HOME/daemon-shutdown.json` 记录 PID、关闭开始/完成时间、phase、failure 与
`clean|failed|timed-out` outcome。只有 drain 全部成功才把 lifecycle record 标为 clean。drain 失败或
超时时，即使进程已退出也返回非零。对于已记录目标，缺失或陈旧 receipt evidence 均属 unverified，
同样返回非零。失败/unverified stop 保留目标状态供重试；status 只会在匹配的 clean receipt 出现后
清理它。已退出目标使用同一 receipt judgment，不再发信号。没有已记录目标且 listener 拒绝时，CLI
报告独立的 no-target no-op，而非 clean-drain verdict。未绑定、不完整或不可读的本地关闭证据保持
nonzero/unverified，不归因到无关 listener。

因此，没有 receipt 的旧 daemon 可以证明已经停止，但不能证明 graceful drain。请检查 receipt 与
`daemon.log`；不要推断 pending external work 已完成或已回滚，也不要盲目重试。该时间上限覆盖异步等待，
不覆盖同步 event-loop wedge。

## Human 投递

`rig gateway human list --json` 发现已注册的 `<entityId>@external` 地址。
`rig gateway human show <entityId> --json` 包含 primary connector readiness、reason 与下一步检查。
项目 policy 决定何时联系 human；`messaging-the-human` 提供 transport 机制。

使用 `rig queue create --destination <address> --summary "<decision>" --body-file <file>
--evidence-ref <ref> --verify --json` 创建 human 请求。它会在检查 delivery receipt 前持久化一条 row。
`posted` 只证明 connector 接受，绝不证明已读；`transport-failed`、`never-posted`、`still-pending`
与 `indeterminate` 会保留请求并点名下一步检查。不要盲目重复 create。`rig send` 用于 agent seat。

`rig slack manifest [--url|--json]`（0.6.0 实验功能）离线打印 Slack app manifest，供用户创建
自己的私有 Socket Mode app（无需 daemon、token 或网络）。`--url` 输出预填 manifest 的 Slack
create-app 链接；`--json` 增加 scope/event 列表及每项请求理由。`GET /api/gateway/slack/manifest`
以只读方式提供相同对象，供 TUI Connections 页使用。设置步骤见
`docs/reference/slack-app-setup.md`。

`rig slack enable [--reason <reason>]` 只在 disabled → enabled transition 时为已有 backlog seed。
重复 enable 不会重新 seed 或 restart。`rig slack disable --reason <reason>` 要求 shutdown reason。
两者都返回 attributed lifecycle receipt；没有 managed-session header 时，直接请求可指定 `actor`。
header 派生 identity 与声明 identity 保持不同。配置、verification 与 human-binding 编辑也会把 actor、
reason、prior/result state 与 effect 记录到 `$OPENRIG_HOME/state/human-channel-operations.jsonl`。
每项 operation 有同一 ID 的 start 与 completion receipt；缺少 completion 即 indeterminate。Snapshot
保留 state/digest，不保留 credential 或 message body。本地 CLI 配置/verification/binding receipt
明确标为 `claimed:v1`。

`rig host pair <url> [--human <address>]` 选择唯一已注册目标 human；若存在多个则要求显式选择。
registry 缺失或 recipient 有歧义时，在创建 approval 前拒绝。未设置
`workspace.operator_seat_name` 时，不再虚构从用户名派生的 kernel seat：Mission Control 会发现唯一
已注册 human，或显示 identity uncertainty。仍支持显式选择已有 seat。旧 alias 仅在其 entity 已注册时
解析；旧 failed row 会保留，不会因注册而隐式 delivered 或 replay。

## 概览

System Health diagnosis、policy、checkpoint 与 disposition 见
[Agent-operated System Health diagnosis](../reference/health-diagnosis.md)。Diagnosis `show`/
`list --json` 是摘要；使用 `--full --json` 查看此前完整 evidence payload。Workflow human view
保持摘要；workflow `--json` 继续返回完整 API payload。

对于 raw JSON evidence 文件，CLI 读取默认值无法拦截 `cat` 或 Node print。选择所需字段前先检查
大小与 key；在磁盘上保留完整 evidence。例如：

```sh
wc -c < receipt.json
jq 'keys' receipt.json
jq '{gate, judge, cutSha, surfaceCount, overallPackageVerdict}' receipt.json
```

请按文件中实际存在的字段选择。检查所选字段前，把有意需要的完整 CLI 输出重定向到文件；通过 pipe
传递命令时使用 `set -o pipefail`，避免 formatter 掩盖失败 exit。

- Binary：`rig`
- 顶层命令组：`64`
- 输出模式：默认为人类可读；许多命令也支持 `--json`
- daemon 停止或不健康时，daemon-backed 命令会失败；`daemon`、`config`、`preflight` 与 `doctor`
  还承担本地职责
- managed app 通过正常 spec/library 界面启动；规范随附示例是 `rig up secrets-manager`
- 仍随附的旧版界面：`package`

## 顶层命令

| 命令 | 说明 |
| --- | --- |
| `daemon` | 管理 OpenRig daemon |
| `start` | 恢复入口——daemon + kernel + per-rig restore（交互式或 headless） |
| `status` | 显示 rig 状态 |
| `snapshot` | 管理 rig snapshot |
| `restore` | 从 snapshot restore rig |
| `export` | 将 rig spec 导出为 YAML |
| `import` | 从 YAML 导入 rig spec |
| `ui` | UI 命令 |
| `package` | 管理 agent package（旧版） |
| `bootstrap` | 从 spec 文件 bootstrap rig |
| `requirements` | 检查 rig spec 的 requirements |
| `discover` | 扫描未受管 tmux session |
| `attach` | 将当前 shell 或 agent attach 到 rig node |
| `bind` | 将已发现 session 绑定到 rig node |
| `adopt` | 实体化 topology 并绑定已发现 live session |
| `reconcile-session` | 不 launch、不输入地采纳手动 resume 的 session |
| `bundle` | 管理 rig bundle |
| `up` | 从 spec 或 bundle bootstrap rig |
| `down` | teardown rig |
| `archive` | 归档 rig（软操作且可逆：从默认视图隐藏，保留全部数据） |
| `unarchive` | 取消归档 rig（`rig archive` 的逆操作）：返回默认视图 |
| `add` | 向 running rig 中已有 pod 添加 member（`add_member` converge op） |
| `env` | 检查并控制 rig environment service |
| `file` | 通过 ssh/rsync 跨 host 移动文件（v0.4.4；一个显式 verb：`copy`） |
| `ps` | 列出 rig 与状态 |
| `mcp` | 用于 agent 集成的 MCP server |
| `agent` | 管理 agent spec |
| `spec` | 管理 rig spec |
| `transcript` | 读取 agent transcript 输出 |
| `send` | 向 agent terminal 发送消息 |
| `capture` | 捕获 agent session 的 terminal 输出 |
| `broadcast` | 向多个 agent session 发送消息 |
| `ask` | 从 transcript/chat 历史查询 rig evidence |
| `chatroom` | 用于 rig 通信的 chat room |
| `specs` | 浏览、预览和管理 spec library |
| `whoami` | 显示 OpenRig topology 中当前 managed identity |
| `auth` | 按 runtime 管理 agent auth profile（CLI 本地；永不打印 token） |
| `config` | 检查并更改 OpenRig 配置 |
| `preflight` | 检查 OpenRig 的 system readiness |
| `doctor` | 验证 OpenRig install health |
| `destroy` | 销毁 OpenRig 本地状态以恢复 |
| `expand` | 向 running rig 添加 pod |
| `unclaim` | 释放已采纳 session，但不 kill tmux |
| `release` | 从 rig 释放已领取 session |
| `launch` | 在 running rig 中启动或重新启动 node |
| `remove` | 从 running rig 删除 node |
| `shrink` | 从 running rig 删除整个 pod |
| `setup` | 准备 OpenRig 所需机器环境 |
| `stream` | 协调 L1——仅追加 intake stream |
| `queue` | 协调 L3——owned-work queue + inbox/outbox |
| `project` | 协调 L2——agent-backed classifier，带 daemon 强制 lease + idempotency + reclaim |
| `view` | 协调 L5——基于 daemon、覆盖 coordination state 的 view |
| `watchdog` | 协调 Watchdog——daemon 原生 scheduler |
| `workflow` | daemon 原生 Workflow Runtime——声明式 spec + transactional-scribe step projection |
| `restore-packet` | 生成、读取并校验跨 runtime restore packet |
| `restore-check` | 检查 running rig 的 restore readiness |
| `context` | 浏览、预览、组合并管理操作者编写的 context pack（绝不投递） |
| `walk` | 按节奏引导 seat 依次读取 context piece |
| `compact-plan` | 规划 Claude compact-in-place candidate，但不执行 compact |
| `heartbeat` | 从 queue 文件显示 workflow execution proof state |
| `seat` | 检查 OpenRig seat observability state |
| `agent-image` | 浏览、snapshot 并管理 agent image |
| `workspace` | Workspace primitive——typed-kind tooling（frontmatter 校验） |
| `plugin` | 检查 plugin（只读）——list、show、used-by、validate |
| `scope` | Scope tree primitive——mission、slice、sub-slice |
| `policy` | Operator context-mode binding（sleep/desk/mobile/away/focus/debug） |

## Core Daemon 与系统命令

### `rig daemon`

用法：`rig daemon <subcommand>`

子命令：

- `start [--port <port>] [--host <host>] [--db <path>]`
- `stop`
- `status`
- `logs [--follow]`

说明：

- `start` 在启动 daemon 进程前，以追加方式对账规范 instance layout，随后接受 port、host 和 DB
  path 的 runtime override。直接首次启动 daemon 使用相同 initializer。保留已有文件，并在任何写入前
  拒绝类型错误的 managed path。见 `docs/reference/instance-layout.md`。
- 启动时在 instance 初始化前使用本地 `daemon-start.lock` reservation，由 `daemon start`、`start` 与
  `up` 共享。并发支持的 launch 会失败，不会启动另一个 daemon 或运行其 pre-bind DB 初始化。成功要求
  每个必需 listener 上的 `/healthz` 返回已启动 child 的 numeric PID，并要求在原子发布
  `daemon.json` 时 child 仍存活。process identity 缺失/不匹配、listener plan 无效、child 退出及 probe
  未解决都不能发布成功。使用匹配的 CLI/daemon 组合；没有 PID evidence 的旧 endpoint 不足以证明。
  此本地 reservation 不会序列化旧 binary 或 daemon entrypoint 的直接执行。
- 启动在同步 state writer 前后都会检查物理 liveness；仅有已排队 child event 不能证明该边界。若
  publication 验证失败，启动会拒绝，并且只撤回与本次 launch 的 PID、start time、listener 与 DB
  匹配的状态；绝不删除替代 owner。
- 进程检查失败代表不确定性，而非 child 已退出的证据。清理会等待所拥有 child 的退出 evidence；
  error event 不足以证明。
- 启动失败时只向自己的 child 发信号，并有界等待其退出。若无法确认清理，reservation 保留且错误
  点名 PID。被中断的 launcher 也可能留下 `daemon-start.lock`。重试前请检查其中记录的 launcher/child
  PID、`daemon.json` 与 `daemon.log`；只有证明两个进程都不存在后，才归档该 reservation。不存在
  timed takeover：已失效 launcher 可能留下 live、未绑定 child。
- `logs` 读取 daemon log 输出，并可 follow。
- **Deploy identity（v0.4.4，OPR.0.4.4.11 FR-6/7）**：PACKAGED build（通过
  `scripts/build-package.sh` 构建）带 `{semver, commit, dirty, builtAt}` stamp；daemon 的 `/healthz`
  payload 以追加方式携带四个 stamp 字段，`rig --version` 渲染 `<semver> (<commit8>[, dirty])`。
  source/dev 运行没有 build stamp（绝不虚构 SHA）；`/healthz` 仍报告 runtime PID，`--version` 打印
  纯 semver。这是 30 秒陈旧部署诊断：长期运行 host 上无 stamp 或 commit 较旧的 `/healthz`，意味着
  看到的是较旧 deployed build，而非 source tree。Source：`packages/{daemon,cli}/src/build-info.ts`
 （`stampFields`）、`packages/daemon/src/server.ts`（`/healthz`）、`packages/cli/src/version.ts`。

### `rig status`

用法：`rig status`

说明：

- 面向人的摘要命令。
- 打印 daemon state、rig summary 与 cmux availability。
- 不支持 `--json`。

### `rig ui`

用法：`rig ui open`

OpenRig UI 属于实验功能，处于维护模式，不再积极开发；仅提供 best-effort 支持。CLI 是主要受支持
界面。欢迎贡献。

子命令：

- `open`

### `rig config`

用法：

- `rig config [--json] [--with-source]`
- `rig config get <key> [--show-source]`
- `rig config set <key> <value>`
- `rig config reset [<key>]`
- `rig config init-workspace [--root <path>] [--force] [--dry-run] [--json]`

支持的 key：

- `daemon.port`
- `daemon.host`
- `db.path`
- `transcripts.enabled`
- `transcripts.path`
- `workspace.root`（以及 `init-workspace` 使用的其他 workspace-rooted path）
- `context.root`（默认 `$OPENRIG_HOME/context`；环境变量 `OPENRIG_CONTEXT_ROOT`）——唯一可写的
  addressable context library。已移除的 `context.packs_root`、config 字段 `context.packsRoot` 与环境
  变量 `OPENRIG_CONTEXT_PACKS_ROOT` 会被拒绝，并给出替代指引。
- `context.system_world`（默认 `default`；环境变量 `OPENRIG_CONTEXT_SYSTEM_WORLD`）——选择
  `$OPENRIG_HOME/context/system/system-world.yaml`、显式替代 manifest path，或显式 `disabled` 状态。
  `rig context work-install` 报告解析后的 state 与 provenance。
- `skills.root`（默认 `$OPENRIG_HOME/skills`；环境变量 `OPENRIG_SKILLS_ROOT`）——唯一权威、受 Git
  版本管理的 managed skill catalog。override 会替换默认值，而不是增加 overlay root。
- `snapshots.periodic.enabled`（默认 `true`）——daemon 侧 periodic snapshot scheduler 开关（v0.3.4）
- `snapshots.periodic.interval_seconds`（默认 `300`）——periodic snapshot 间隔
- `snapshots.periodic.retention_keep`（默认 `10`）——每个 rig 保留的 periodic snapshot 数
- `feed.subscriptions.{action_required|approvals|shipped|progress|audit_log}`（boolean）——For-You feed
  的五个扁平 lens toggle（映射环境变量 `OPENRIG_FEED_SUBSCRIPTIONS_*`）
- `feed.subscriptions.<hostId>.enabled`（boolean；**v0.4.4，OPR.0.4.4.15**）——一个已注册的动态 key
  类别（不是通用 dynamic-key 机制）：aggregated multi-host For-You feed 的 per-host subscription
  toggle。`hostId` segment 字符集为 `[A-Za-z0-9_-]+`（带点 host id 无法在 dotted key 中表示，
  会作为 unknown 被拒绝）；扁平 toggle tail 与 `enabled` 的两种拼写都是保留 segment，因此 host id
  绝不能遮蔽扁平 key。v1 中没有此动态类别的环境变量映射——仅 file/API。CLI config store 携带
  相同类别（与 daemon store 的 parity 已锁定）。

优先级：

- CLI flag
- environment variable
- config file
- default

说明：

- `--with-source`（顶层）与 `--show-source`（`get`）报告每个 key 的 source/default，提供诚实 provenance。
- `init-workspace` 在 `~/.openrig/workspace/`（或 `--root` override）中以追加方式 scaffold
  `missions/`、`exhaust/`、`SPEC.md`、`project.yaml`、`workspace.yaml` 与 `.gitignore`。`--dry-run`
  只预览不写入。`--force` 是 deprecated compatibility，会保留现有文件。v0.3.0 新增。
- `snapshots.periodic.*`（v0.3.4）：daemon 侧 scheduler 按 `interval_seconds` 为每个 rig 获取
  periodic snapshot，并保留最新 `retention_keep` 个。restore 时，`auto-periodic` 与
  `auto-pre-down` snapshot 采用 newest-wins。

旧环境变量兼容：原 runtime key 仍接受 deprecated `RIGGED_*` alias。新 typed config key 只使用
`OPENRIG_*`。

### `rig auth`

管理 agent auth profile。该命令**完全在 CLI 本地执行**——绝不接触 daemon，因此 token value 不会
进入 daemon queue、stream、database 或 log。runtime 是通过 `--runtime` 指定的正交轴（MVP 为
`codex`，也是默认值），建模参考 `gh auth switch/status` 与 `aws --profile` /
`kubectl config use-context`。它有意不采用 `rig codex-auth`，也不是 `rig codex` vendor-noun family——
harness 是 flag，而非 command noun（见 `conventions/cli-read-command-grammar`）。

用法：

- `rig auth status [--runtime codex]`——auth 文件是否存在、文件 mode、已保存 profile 数量与 login
  state。**无 secret**：login state 只从 runtime CLI exit code 派生，绝不读取其输出。
- `rig auth list [--runtime codex]`——已保存 profile 名称。
- `rig auth save <profile> [--runtime codex]`——将 active auth 文件 snapshot 到具名 profile
  （受 mode 保护的字节 copy；命令绝不读取或 echo 内容）。
- `rig auth switch <profile> [--runtime codex]`——激活已保存 profile（以 `0600` mode copy 到 active
  auth 文件）。
- `rig auth validate <profile> [--runtime codex]`——检查 profile 文件 mode 与 JSON 可解析性。它
  **不是** live-auth 检查；解析失败时报告固定 reason，绝不显示文件内容。
- `rig auth seats list|show <seat>|set …|report [--runtime codex]`——per-operator seat → profile
  **metadata** registry。

Profile 存储：

- `CODEX_HOME`（默认 `$HOME/.codex`，可由环境变量 override）保存 active `auth.json`、
  `auth-profiles/` 目录（profile `0600`、目录 `0700`）与 `auth-seat-registry.tsv`。
- 随附内容为**空**：无示例或 bundled profile/registry。profile name 使用严格 allowlist
  （字母数字开头的 `[A-Za-z0-9._-]`，不超过 64 字符）；拒绝 symlink 或 tree 外 profile path。

Secret 与诚实性不变量：

- **绝不打印、记录、排队、stream 或 commit 任何 token value。** `status`/`validate` 只报告
  presence/mode/parseability/login-state。
- **Seat-registry label 是 metadata，而非 live account 证明。** 标为 profile "X" 的 seat 并不能证明
  running session 实际使用该 account；命令输出会说明这一点。registry 不存储 token/resume secret——
  列为 `seat / rig / runtime / cwd / auth_profile / updated_ts`。

注意：live runtime session 不会原地切换 account——请重新启动受影响 seat 以采用新切换的 profile。

### `rig preflight`

用法：`rig preflight [--json]`

说明：

- 根据本地配置运行 system readiness 检查。
- 失败时打印失败内容、重要原因与修复方法。

### `rig doctor`

用法：`rig doctor [--json]`

说明：

- 验证 packaged/local CLI 使用场景下的 install health。
- 检查 daemon dist、UI dist、Node 版本、`tmux`、可选 `cmux` control health、可写 state path 与
  daemon port availability。
- 在 macOS 上，还会在 tmux mouse mode 似乎被禁用时发出 warning，给出当前 server 的修复命令
 （`tmux set -g mouse on`），并指向 `~/.tmux.conf` 中的持久修复。
- `cmux` 问题是 warning，不是 hard failure。没有 `cmux` 时 OpenRig 仍可工作；只有 `Open CMUX`
  workflow 不可用。
- `--json` 适合 agent 使用，并且只在真实 failure 时以非零退出，warning 不会导致非零。

### `rig destroy`

用法：

- `rig destroy --state [--backup] --yes --confirm destroy-openrig-state`
- `rig destroy --all [--backup] --yes --confirm destroy-openrig-state`

说明：

- 这是用于清理受污染 OpenRig 本地状态的 destructive recovery 界面。
- `--state` 停止 daemon；必要时清除 configured port 上的 active OpenRig listener；轮换或删除
  effective state root；重新创建空 state root。
- `--all` 包含 `--state`，并额外清理可从当前 OpenRig database 发现的 managed tmux session。
- `--backup` 将 state root 移到避免冲突的 timestamp path，例如
  `~/.openrig.backup-YYYYMMDD-HHMMSS`。
- managed tmux 清理有意保持保守：只删除当前 DB state 中存在的 session；无关 tmux session
  保持不变。
- 人类可读输出先打印紧凑 destroy plan，再打印 destroy 结果。

### `rig start`

用法：

- `rig start`（交互式：daemon + kernel + 选择并 restore）
- `rig start --last [--json]`（headless：restore 上次运行的 rig）
- `rig start --all [--json]`（headless：restore 所有具有可用 snapshot 的 rig）
- `rig start --rigs <name> [<name>...] [--json]`（headless：只 restore 具名 rig）

说明：

- v0.3.4（slice 01）引入的 recovery entrypoint。只负责排序：组合 daemon start + kernel 自动启动
  等待 + per-rig restore primitive；不重新实现任何逻辑。
- 它不是 getting-started boot hero——后者仍是 `rig up <starter>`。`rig start` 用于 reboot/crash 后恢复。
- TTY 交互流程列出 last-running candidate 及 readiness 摘要（`[ready to resume]`、
  `[will ask before fresh]`、`[fresh start]`、`[mixed]`），随后提供 restore-all 或空格多选 picker。
- Headless 模式（`--last`、`--all`、`--rigs`）不产生 prompt；若 node 返回 `awaiting-decision`，
  CLI 会如实报告，并打印采取行动的准确命令 `rig up --existing <rig> --fresh <logicalId>`。
- 已在 `03a5f915`（v0.3.4）对照 `packages/cli/src/commands/start.ts` 验证界面。

### `rig mcp`

用法：`rig mcp serve [--port <port>]`

子命令：

- `serve`

随附 MCP tool：

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

## Rig 生命周期与 Spec

### `rig bootstrap`

用法：`rig bootstrap <spec> [--plan] [--yes] [--json]`

参数：

- `spec`：rig spec YAML 文件路径或 library name

说明：

- 裸名称先通过 spec library 解析，未命中时再回退到原始 source value。

### `rig requirements`

用法：`rig requirements <spec> [--json]`

参数：

- `spec`：rig spec YAML 文件路径

说明：

- `rig requirements` 是 spec/app 特定的 dependency 界面。
- 先用 `rig doctor` 检查 host 级 install health，再用 `rig requirements <spec>` 检查 rig 特定
  requirement。

### `rig up`

用法：`rig up <source> [--plan] [--yes] [--cwd <path>] [--target <root>] [--existing] [--fresh <seats...>] [--json]`

参数：

- `source`：`.yaml` 或 `.rigbundle` 路径，或裸名称

实际 source 解析：

- 绝对/相对 YAML path：从该 spec 启动
- `.rigbundle` path：从该 bundle install/bootstrap
- 不含 slash/extension 的裸名称：
  - 先检查 spec library
  - 若 library 无匹配，则将其视为已有 rig 的 restore/power-on target
  - 若 library spec 与已有 rig 同名，则以 ambiguity error 退出

当前行为说明：

- `--cwd <path>` 仅为本次运行覆盖所有 member 的 launch working directory。对于 path 形式的
  `rig up <install-internal-spec>` 调用，CLI 默认将 `cwd` 设为 caller directory（slice-22 Bug 3），
  使 library spec 与 path 形式行为一致。
- `--target <root>` 只用于 bundle/package installation，不覆盖 agent working directory。
- `--existing` 跳过 library-spec name 解析，直接把 `<source>` 视为已有 rig name（用于 library spec
  与 stopped rig 同名时消除歧义）。
- `--plan` 只读预览 restore，不执行。预览遵循诚实异步 timeout，并报告每个 node 的预期 action。
- `--fresh <seats...>` 有意 fresh-prime 具名 seat（logical id），而不是 resume 原 session（操作 B）；
  在 per-node 状态词汇中报告为 `fresh-primed`。可重复：`--fresh seat-a --fresh seat-b` 或
  `--fresh seat-a seat-b`。
- `local:` `agent_ref` 相对于 rig spec 所在目录解析，而非 caller shell cwd。
- 将内置 spec copy 到新目录时，保持其 `agents/` tree 位于旁边，或将 ref 改写为
  `path:/absolute/path`。
- managed app 是一等 `up` target。`rig up secrets-manager` 启动 library 中随附的 Vault 示例。
- **`rig up factory-rsi`（OPR.0.4.6.FAC2）**启动单 rig recursive-self-improvement factory MVP
  starter——七个 seat（`plan`/`build`/`check`/`review`/`dogfood`/`release`/`orch`），运行内置
  `factory-rsi` workflow（内循环 plan→build→check→review→release）；dogfood seat 对随附产品执行带外
  测试，并将 finding 反馈到下一轮 plan。与 workspace 无关：`rig up factory-rsi --cwd <repo>` 将
  loop 指向待改进 repo。
- v0.3.2 paper-cut 修复轮（slice-22）：pre-launch failure 现在返回结构化 HTTP 4xx
  （`cycle_error` / `preflight_failed` / `validation_failed` / `service_boot_failed`），而非裸 500；
  失败 boot 不再在磁盘留下 orphan rig record。
- **v0.4.4（OPR.0.4.4.11）——whole-topology source**：`.rigtopology` manifest（或 body 声明
  topology 形式的 YAML 文件）在一次分阶段 spin-up 中启动多个 rig。v0 manifest entry **只能是 spec
  path**（封闭 key manifest：`.rigbundle` 与裸 library-name entry 会在解析时被拒绝，并按 entry 给出
  what/why/fix，点明 v0 边界）。每个 entry 的 `host: <id>` 是 topology entry 的唯一 placement
  机制——dispatch 前拒绝 `rig up --host <id> <topology>`（两种 placement 机制不得共存）。launcher
  在路由侧取得 per-rig launch lock，并报告封闭 per-entry aggregate `{ok | failed | skipped}`
  （明确列出 skipped——lock conflict 或上游失败绝不会表现为静默成功）。Source：
  `packages/cli/src/commands/up.ts`（`.rigtopology` sniff + `--host` 拒绝）、
  `packages/daemon/src/domain/topology/{topology-manifest,multi-rig-launcher,remote-up-leaf}.ts`、
  `packages/daemon/src/routes/up.ts`。
- v0.3.4：已有 rig 的 `rig up` 默认 resume 原 session。通过 `--fresh <seats...>` 对单个 seat
  opt-in 有意 fresh-prime。per-node 状态词汇共五项：`resumed` / `fresh-primed` /
  `awaiting-decision` / `attention_required` / `failed`。TTY 中，`awaiting-decision` node 会触发交互式
  `[y/N]` ASK；headless 模式会如实报告，并打印准确后续命令
  `rig up --existing <rig> --fresh <logicalId>`。

成功模式：

- fresh boot
- restore 已有 rig
- partial boot（非零 exit）

### `rig down`

用法：`rig down <rig> [--delete] [--force] [--snapshot] [--json]`

`<rig>` 接受 rig **name 或 id**，与 `rig up` 对称。name 会在 teardown 前通过 active
（非 archived）rig summary 解析为 id。

Flags：

- `--delete`：teardown 后删除 rig record
- `--force`：立即 kill session
- `--snapshot`：teardown 前获取 snapshot

说明：

- `--snapshot` 成功时，人类可读输出包含 restore 命令。
- rig name 唯一可复用时，handoff 优先使用 `rig up <rigName>`。
- destructive-op 安全性：若一个 name 匹配多个 rig，`rig down` 会拒绝 teardown 其中任何一个，
  并列出匹配 id——使用 `rig down <id>` 重试。id 总是直接解析（永无歧义）。

### `rig archive`

用法：`rig archive <rigId> [--force] [--json]`

Flags：

- `--force`：即使 rig 正在运行或 degraded 也归档
- `--json`：供 agent 使用的 JSON 输出

说明：

- 软且可逆的 archive：从默认 explorer 与 `rig ps` 隐藏 rig，同时保留 rig record、topology 与
  snapshot。
- 与 `rig down --delete` 不同（delete 具有破坏性；archive 可恢复）。
- archived rig 在默认 `rig ps` 中隐藏；使用 `rig ps --include-archived` 查看。
- archive running/degraded rig 需要 `--force`；否则调用返回带三段式诚实错误的 HTTP `409`，
  并以 `2` 退出。
- 使用 `rig unarchive <rigId>` 反向操作。
- 发出 `rig.archived` SSE event。
- 已在 `53794fbe`（v0.3.3）对照 `packages/cli/src/commands/archive.ts` 验证界面。

### `rig unarchive`

用法：`rig unarchive <rigId> [--json]`

说明：

- `rig archive` 的逆操作：清除 `archived_at` flag，使 rig 返回默认 explorer 与 `rig ps` view。
- 始终无破坏性（archive 期间保留 row 与 snapshot）；无 `--force`，也无 running-rig guard。
- 发出 `rig.unarchived` SSE event。
- 已在 `53794fbe`（v0.3.3）对照 `packages/cli/src/commands/unarchive.ts` 验证界面。

### `rig env`

用法：

- `rig env status <rig> [--json]`
- `rig env logs <rig> [service] [--tail <n>]`
- `rig env down <rig> [--volumes]`

说明：

- 此界面只对 service-backed rig 与 managed app 有意义。
- `status` 解析 rig name 或 ID，返回带诚实 freshness probe 的 env receipt。响应包含 `probeStatus`
  （fresh/stale/no_orchestrator），使操作者可区分当前 truth 与 cached state。
- `logs` 代理 compose-backed service log；`[service]` 可选。
- `down` teardown rig environment。`--volumes` 覆盖已存 down policy，强制通过
  `docker compose down --volumes` 删除 volume。
- 注意：`rig ps` 尚不呈现 env health。runtime env truth 可通过 `rig env status` 与 rig drawer 的
  `Env` 标签查看。

### `rig ps`

用法：

- `rig ps [--json] [--full] [--rig <name>] [-A | --all-rigs] [--session <sess>] [--limit <n>] [--fields <list>] [--summary] [--filter <key=value>] [--host <id>]`
- `rig ps --nodes [--json] [--full] [--rig <name>] [-A | --all-rigs] [--session <sess>] [--limit <n>] [--fields <list>] [--summary] [--filter <key=value>] [--active] [--host <id>]`

说明：

- **v0.4.4——合并 all-rigs 默认值 + disclosure ladder（OPR.0.4.4.21）**：默认显示**每个 active
  rig 一行紧凑记录**——O(rigs)，绝不会在 fleet 中 fan-out node——并包含三个承重展示元素：host
  rollup 行（"N rigs · M seats · K need attention"）、archived/stopped count 行（history 折叠为一行）、
  以及讲解 drill ladder 的 affordance footer。v0.4.0 的 current-rig 默认行为已退役（它会从操作员
  视野隐藏 running rig）；session-rig 默认值现在只适用于 `--nodes`，且只限本地——**隐式 scope
  默认值不会跨 host 边界**（远端 `--nodes` 要求显式 `--rig` 或 `-A`）。`-A`/`--all-rigs` 始终
  只有一个含义：扩大 `--nodes` 的 fleet 范围；裸 `-A` 是结构化教学错误，点名用于 history 的
  `--include-archived`。明确契约：默认 `--json` 是所有非 archived rig（包括 stopped rig）的裸数组
  （保留已有 key，追加 `attentionCount`）；只有 human table 会折叠 stopped rig。fan-out
  （`--all-hosts`/`--hosts`）发出 P4 内共享的 `AggregatedPayload`（带 hostId 的 `items` + 封闭 enum
  的 per-host `hosts[]` status），默认仅为 rollup；完整显式 ladder（`--all-hosts --nodes -A`，完整
  record 再加 `--full`）会按 node fan-out，并输出带 hostId 的 projection row。从旧 firehose 迁移：
  `rig ps --nodes -A --full`。默认 `--json` 输出是 per-node 紧凑 TL;DR projection：`session`、
  `rig`（在 `-A` 下消除歧义）、`activity`（state + reason）、`assigned` / `pending` count，resume
  摘要为 `resumeType` + `resumeTokenPresent`（boolean——不是 token value，依照 slice-34 security
  修正）。`--full` 返回完整 per-node record（raw byte-equivalent passthrough——保留此前形态，包括
  `tmuxAttachCommand`、`resumeCommand`、完整 `contextUsage`、`agentActivity`、`restoreOutcome` 等；
  下游 consumer 需要时，`resumeToken` value 仍属于 `--full`）。all-states 保持默认（依据 orch-lead
  佐证裁定：ps 呈现 topology/readiness，其中 stopped/recoverable/attention 才是 actionable signal——
  不同于默认只显示 active item 的 queue-list）。`--active` / `--running` 是 opt-in active filter
  （已有）。这解决了 root 上约 77,000 token 的状态概览事故，以及 fleet-scale 无界默认输出问题。
- **在 source 处裁剪 daemon node-list payload（slice 26）**：不再把几乎相同的模板化
  `recoveryGuidance` prose 序列化到每个 node；改为位于顶层的 guidance-by-reference map，使当前四个
  consumer 仍可解析。list payload 中的 `contextUsage` 是紧凑摘要（完整 telemetry 仍可通过 per-node
  `rig whoami` / detail query 获取）。即使 `--full` 与 UI consumer 也不再为重复 per-node blob 付费。
- `rig ps` 列出 rig summary。默认人类可读列（v0.4.4）：`RIG`、`NODES`、`RUNNING`、`ACTIVE`、
  `WORK`、`ATTN`、`STATUS`、`LIFECYCLE`、`UPTIME`、`SNAPSHOT`。`LIFECYCLE` 列显示 per-node
  lifecycle state 的 rig 级 fold，code 为 `run`/`rec`/`stp`/`deg`/`att`；`ATTN` 为追加的
  attention count。
- `rig ps --nodes` 展开当前（或 `--rig` 指定）rig 的 node inventory；使用 `--nodes -A` 查看跨 rig
  inventory（v0.4.4 scoping）。默认人类可读列包含 `STATUS`、`STARTUP`、`LIFECYCLE`、`ACTIVITY`、
  `RESTORE`、`ERROR`，无需组合另一个诊断命令即可并排比较 startup-time 与 live runtime state。
- rig 与 node 两层 JSON 输出均包含 `rigName` alias（等于 `name`），用于 forward compatibility；
  agent code 应优先使用 `rigName`。默认 `--json` 是裸数组（向后兼容）；只有设置 `--limit`、
  `--fields`、`--summary` 或 `--filter` 时才使用 envelope
  `{entries, totalRigs|totalNodes, truncated, hint?}`。
- 默认 human output 会为 context-window 安全限制长度：rig 最多 50 个，footer 点名总数与 `--full`
  opt-out；node 最多 100 个且形式相同。`--full` 禁用截断；`--limit <n>` 设置显式上限。
- `--summary` 只发出 aggregate count（rig 使用 `byStatus`、`byLifecycle`；node 使用
  `bySessionStatus`、`byLifecycle`），适合不含 per-entry detail 的快速 fleet 检查。跨 facet 不一致
  （例如 `running` rig 中存在 `attention_required` node）在 summary 模式下不可直接看见；改用
  `--filter lifecycleState=attention_required` 缩小范围。
- `--fields <list>` 将 JSON 输出投影到逗号分隔的顶层字段 allowlist。任何 HTTP 调用前都会拒绝
  unknown key，错误会点名未知 key 与排序后的支持列表，exit code 为 `1`。rig 级可用字段：`rigId`、
  `name`、`rigName`、`nodeCount`、`runningCount`、`activeCount`、`hasWorkCount`、`attentionCount`、
  `status`、`lifecycleState`、`uptime`、`latestSnapshot`。node 级（带 `--nodes`）可用字段：`rigId`、
  `rigName`、`logicalId`、`podId`、`podNamespace`、`canonicalSessionName`、`nodeKind`、`runtime`、
  `sessionStatus`、`startupStatus`、`restoreOutcome`、`oriented`、`lifecycleState`、
  `tmuxAttachCommand`、`resumeCommand`、`latestError`、`terminalActive`、`hasAssignedWork`、
  `pendingWorkCount`、`agentActivity`、`contextUsage`、`heldReason`。`name` 只适用于 rig；node entry
  使用 `rigName`（拒绝错误中会给出提示）。不钻取 nested field（如 `agentActivity.state`）；传入整个
  object name（如 `agentActivity`），再由下游读取 nested value。
- `--filter <key=value>` 接受 `status`、`lifecycleState`、`name-prefix`、`name` 与
  `agentActivity.state`（PL-019；node 级——与 `--nodes` 一起使用）。任何 HTTP 调用前都会拒绝
  unknown key，并在清晰错误中点名支持列表。`agentActivity.state` 允许 `running`、`needs_input`、
  `idle`、`unknown`；无效值快速失败，并给出 what failed / what's allowed / what to do 三段式错误。
- `--active`（PL-019；node 级）是 `--filter agentActivity.state=running` 的语法糖。拒绝将 `--active`
  与 `--filter` 组合——选择一种显式形式。在同一 fixture 上，输出与显式 filter 形式一致。
- `--host <id>` 通过单 hop ssh，将相同命令路由到 `~/.openrig/hosts.yaml` 中声明的远端 host
  （CLI 侧 shell-out；daemon 不变）。所有 shaping flag（`--nodes`、`--full`、`--limit`、`--fields`、
  `--summary`、`--filter`、`--json`）均传给远端 `rig ps`。成功时原样透传远端 rig 输出；失败按封闭
  跨 host execution 契约区分为 `ssh-unreachable` / `permission-gate` /
  `remote-daemon-unreachable` / `remote-command-failed`。
- Exit code：
  - `0` 成功
  - `1` daemon 未运行，或 `--filter` / `--limit` / `--fields` 无效
  - `2` daemon fetch 失败

### `rig snapshot`

用法：

- `rig snapshot <rigId> [--intended-seats <ids>]`
- `rig snapshot list <rigId>`

子命令：

- `list <rigId>`

### `rig restore`

用法：

- `rig restore <snapshotId> --rig <rigId>`
- `rig restore status <attemptId> --rig <rigId> [--json]`

重要：

- 源码要求 `--rig <rigId>`，尽管 help 文本在视觉上未标为 required。

说明：

- human output 打印每个已 restore node 与任何失败 node 的错误。
- 任意已 restore node 失败时，exit 非零。
- 已启动的异步 restore 会打印 attempt id。`status` 从持久 attempt 派生原始与当前 intended-set
  verdict、snapshot selection、historical exclusion 与未解决 intended seat。

### `rig restore-check`

用法：`rig restore-check [--rig <name>] [--as <session>] [--full] [--no-queue] [--no-hooks] [--json]`

说明：

- 检查所有 running rig（或 `--rig` 指定的一个 rig / `--as` 指定的一个 seat）的 restore readiness。
- **v0.4.0——默认 summary + not-ready（slice 29）**：默认输出 summary block（total seats / ready /
  not-ready / error-degraded count），并且只紧凑列出 **not-ready** seat（seat + readiness reason）。
  `--full`（或 `--json --full`）返回当前完整 per-seat fleet readiness。compact 请求下，daemon 会为
  ready seat 跳过 per-seat detail 装配（计算 verdict，省略 detail）。这解决了读取命令界面上实测最大
  token bomb（约 79,000 token → 低数千）。
- summary 默认值会准确标识每个 not-ready seat（无 false-ready omission）——即使省略 ready seat
  detail，actionable signal 也无损。
- `--no-queue` 跳过 queue 文件检查；`--no-hooks` 跳过 hook 检查。
- Exit code：`0` 可 restore（或可 restore 但有 caveat），`1` 不可 restore（发现红色 blocker），
  `2` unknown / probe error。

### `rig restore-packet`

用法：`rig restore-packet <subcommand>`

子命令：

- `write [options]`——从 source session 或 JSONL 文件生成 restore packet。
- `read <packet-dir> [--json]`——渲染 restore packet 内容（human 或 JSON）。
- `validate <packet-dir> [--json]`——根据 v0 schema 校验 restore packet。

说明：

- packet shape 是跨 runtime v0 标准（通过 runtime parser + redaction 同时支持 Claude Code 与 Codex
  transcript）。
- `write` 发出包含规范 schema 文件与 `omitted-records` 记账的 packet 目录。
- `read` 与 `validate` 操作已有 packet 目录，不改变它们。

### `rig export`

用法：`rig export <rigId> [-o|--output <path>]`

默认输出路径：

- `rig.yaml`

### `rig import`

用法：

- `rig import <path> [--instantiate] [--materialize-only] [--preflight] [--target-rig <rigId>] [--rig-root <root>]`

说明：

- 接受 YAML rig spec。
- `--target-rig` 将内容追加实体化到已有 rig。
- `--rig-root` 用于 pod-aware 解析。

### `rig bundle`

用法：`rig bundle <subcommand>`

子命令：

- `create <spec> -o <path> [--name <name>] [--bundle-version <ver>] [--include-packages <refs...>] [--rig-root <root>] [--notes <text>] [--min-daemon-version <ver>] [--min-cli-version <ver>] [--json]`——
  将 rig spec 与其声明内容打包为 `.rigbundle`。v0.3.2 slice-05 提供一等跨 primitive bundling：
  skills + plugins（hybrid）+ workflow_specs + context_packs + agent_images 端到端 vendor，带双侧 path
  containment、symlink escape 防护与 integrity hashing。
- `inspect <path> [--json]`——检查 `.rigbundle` manifest。v0.3.2 将跨 primitive content field
  作为一等字段呈现。
- `install <path> [--plan] [--yes] [--target <root>] [--skip-version-check] [--force] [--json]`——
  安装 `.rigbundle`。将每种声明 content kind 路由到 `$OPENRIG_HOME` 下的规范 library。
  `--skip-version-check` 是操作员对 install-time daemon/CLI compatibility gate 的显式 override
  （不推荐）。`--force` 是操作员对 install-time conflict check 的显式 override（不推荐；conflict
  可能产生 partial install state）。
- `history [--rig <name>] [--since <iso>] [--json]`——从
  `~/.openrig/bundle-audit.jsonl` 列出 bundle install audit record。按 target rig name 与最早
  `installedAt` 过滤。

重要：

- 源码定义要求 `bundle create` 提供 `-o, --output <path>`。
- v0.3.2 提高 install timeout（原 5 秒——对于会启动 tmux session 的 install 太短）。
- 按 release packet 延后到 0.3.3：agent/port/managed-app collision 检测（Item 4.3）、更广泛的
  install-into-existing-rig 路径接受（Item 4.4），以及 `--target-name` CLI flag
  （slice-05 Item-3 子 scope；取决于 CLI 界面决策）。

### `rig package`（旧版）

用法：`rig package <subcommand>`

子命令：

- `validate <path>`
- `plan <path> [--target <dir>] [--runtime <runtime>] [--role <name>]`
- `install <path> [--target <dir>] [--runtime <runtime>] [--role <name>] [--allow-merge]`
- `rollback <installId>`
- `list`

说明：

- 随附 CLI 明确将 package 界面标为 legacy。

### `rig spec`

用法：`rig spec <subcommand>`

子命令：

- `validate <path> [--json]`
- `preflight <path> [--rig-root <root>] [--json]`

### `rig agent`

用法：`rig agent validate <path> [--json]`

子命令：

- `validate <path>`

### `rig specs`

用法：`rig specs <subcommand>`

子命令：

- `ls [--kind <kind>] [--json]`
- `show <name-or-id> [--json]`
- `preview <name-or-id> [--json]`
- `add <path> [--json]`
- `sync [--json]`
- `remove <name-or-id> [--json]`
- `rename <name-or-id> <new-name> [--json]`

说明：

- `specs` 是 rig、agent 与 managed app 的 library 界面。
- `preview` 返回 daemon 提供的结构化 review 数据。
- `add` 接受 YAML spec 文件，或包含 `rig.yaml` / `agent.yaml` 的完整 spec 目录。
- 目录 add 会将整个 tree copy 到 user library，使相邻 agent、guidance、skill 与 doc 继续可用。
- `preview secrets-manager` 是规范 managed-app review 示例。

## Discovery 与 Topology Mutation

### `rig discover`

用法：`rig discover [--json] [--draft]`

说明：

- 扫描未受管 tmux session。
- `--draft` 从 discovery set 生成候选 rig spec。

### `rig attach`

用法：

- `rig attach --self --rig <rigId> --node <logicalId> [--cwd <path>] [--display-name <name>] [--print-env] [--json]`
- `rig attach --self --rig <rigId> --pod <namespace> --member <name> --runtime <runtime> [--cwd <path>] [--display-name <name>] [--print-env] [--json]`

说明：

- 当前要求 `--self`。
- node attach 与 pod-create attach 是互斥模式。
- 在 tmux-backed shell 中，命令记录 tmux attachment metadata；否则记录 `external_cli` attachment。
- `--print-env` 打印 `OPENRIG_NODE_ID` 与 `OPENRIG_SESSION_NAME` 的 shell export。

### `rig bind`

用法：`rig bind <discoveredId> --rig <rigId> (--node <logicalId> | --pod <namespace> --member <name>)`

重要：

- 必须提供 `--rig <rigId>`。
- binding 模式互斥：
  - 已有 node：`--node <logicalId>`
  - 创建新 node：`--pod <namespace> --member <name>`

### `rig adopt`

用法：

- `rig adopt <path> --bind <logicalId=tmuxSessionOrDiscoveryId> [--bind ...] [--target-rig <rigId>] [--rig-root <root>] [--json]`

重要：

- `--bind` 必须提供且可重复。
- 输入文件必须是含 `pods` 的 pod-aware RigSpec。

说明：

- 先实体化 topology，再解析/绑定已发现 session。
- JSON 模式发出已实体化 node 与 binding result。

### `rig reconcile-session`

用法：

- `rig reconcile-session <session> [--rig <rigId>] [--node <logicalId>] [--no-launch] [--json]`

参数：

- `session`：要采纳的 live session 的规范名称（例如 `dev-impl@my-rig`）。

Flags：

- session 解析有歧义时，`--rig` 与 `--node` 是成对消歧参数（必须同时提供）。
- `--no-launch` 是此命令唯一模式；接受该 flag 以便显式表达。

说明：

- 不 launch、不输入地采纳手动 resume 的规范 session（slice 03 / v0.3.4）。操作员已在其规范 tmux
  session 中从外部 resume session（例如 `claude --resume`、`codex resume`），但 daemon 仍显示 seat down。
- 将 live process 绑定到其自身持久 node（同一 node id，不 re-key），并更新 projection，使
  `rig ps` / topology / send / capture / queue routing 再次工作。
- 绝不 launch、relaunch、kill、重放 startup、按 resume menu、compact 或向 pane 输入。
- 无法证明的内容均报告为 projection drift；绝不声称 conversation continuity。
- 已在 `03a5f915`（v0.3.4）对照 `packages/cli/src/commands/reconcile-session.ts` 验证界面。

### `rig expand`

用法：`rig expand <rig-id> <pod-fragment-path> [--json] [--rig-root <path>]`

说明：

- 向 running rig 添加 pod fragment。
- `--rig-root` 控制 agent 解析。
- Member YAML 可携带 `session_source`（见下方“Session source 声明”），从此前 native conversation
  （`mode: fork`）或操作员声明 artifact（`mode: rebuild`）启动新 seat。

### `rig add`

用法：`rig add <rig-id> <pod-namespace> <member-fragment-path> [--json] [--rig-root <path>]`

参数：

- `<rig-id>`：目标 rig id
- `<pod-namespace>`：要添加 member 的已有 pod namespace
- `<member-fragment-path>`：YAML/JSON member-fragment 文件路径（spec snake_case 字段）

说明：

- `add_member` converge op verb：从 YAML/JSON member-fragment 文件向 running rig 的已有 pod
  添加 member。
- Member fragment 同时接受裸形式（顶层 member 字段）与 wrapper 形式
  （`{ member: {...}, edges?: [...] }`）。裸形式中的顶层 `edges:` 字段会提升为 pod-local edge，
  绝不会静默丢弃。
- **OPR.0.4.6.FAC1**：fragment 接受可选 `role: <name>`（字符集 `A-Za-z0-9_.-`；在
  `runtime: terminal` 上拒绝）。声明 role 的 seat 有资格参与此 rig 上 workflow role→seat capability
  解析——scale-out = 在该 role 下添加 member（此 verb 就是增长路径）。每个 seat 的 role 为 opt-in：
  无 role 的 member 只能通过显式 `preferred_targets` 到达；提供的 role 会校验，绝不静默丢弃。
- 存在但非数组的 `edges` 字段会以诚实错误拒绝（不静默丢弃）。
- `--rig-root <path>` 控制 agent 解析。
- HTTP outcome：成功为 `201`（带新 node + 持久 edge + 可选 warning）；`409 member_conflict`；
  `400 validation_failed` / `preflight_failed`；`404 pod_not_found`（列出已有 pod）。
- HTTP 调用失败或新 node 未完整启动（`status !== "launched"`）时，exit code 非零。
- 已在 `53794fbe`（v0.3.3）对照 `packages/cli/src/commands/add.ts` 验证界面。

### Session source 声明（`session_source`）

rig spec 或 `rig expand` payload 中的 Member YAML 可声明 launch-time `session_source`，控制新 managed
seat 如何派生启动 context。v1 支持两种模式：

```yaml
# 从此前 native runtime conversation fork。捕获并持久化新的 post-fork token；
# 绝不把 parent token 持久化到新 seat。
members:
  - id: reviewer-2
    runtime: claude-code        # 或 "codex"；不适用于 terminal
    session_source:
      mode: fork
      ref:
        kind: native_id         # v1 fork 模式只支持 "native_id"
        value: "0b0165d7-cb4d-4650-90de-15c0a1ede9e6"
```

```yaml
# 从操作员声明的 artifact 重建（CULTURE、role doc、handover packet、queue 文件、session log）。
# 全新启动 harness，并按操作员声明的 trust precedence 顺序将 artifact seed 到 running TUI。
# seat 的 continuityOutcome 为 `rebuilt`（绝不是 `fresh`/`resumed`/`forked`），
# 且不持久化 `resumeToken`。
members:
  - id: writer-2
    runtime: claude-code        # 或 "codex"；不适用于 terminal
    session_source:
      mode: rebuild
      ref:
        kind: artifact_set      # v1 rebuild 模式只支持 "artifact_set"
        value:                  # 有序列表，最高信任优先
          - <substrate-shared-docs>/rigs/<rig>/CULTURE.md
          - <substrate-shared-docs>/specs/agents/<role>.md
          - /path/to/handover-packet.md
          - /path/to/state/<pod>/<member>.queue.md
          - /path/to/state/<pod>/shared.session.log
          - /path/to/state/<pod>/<member>.session.log
```

说明：

- `terminal` runtime 拒绝 `session_source`（无 native fork primitive，也无 agent context 可重建）。
- `mode: fork` 要求 `ref.kind: native_id` 和非空 `ref.value` 字符串。其他 ref kind
  （`artifact_path`、`name`、`last`）是后续 slice 的保留形态，在 v1 fork 模式中拒绝。
- `mode: rebuild` 要求 `ref.kind: artifact_set` 和非空 path 数组 `ref.value`。缺失 path 记录为 gap，
  launch 使用已解析内容继续；若没有任何声明 path 可解析，则 launch 以清晰错误失败。
- 给定 member 上两种模式互斥；混用属于 schema error。

### `rig unclaim`

用法：`rig unclaim <sessionRef> [--json]`

说明：

- 释放已采纳 session，但不 kill 其 tmux session。

### `rig release`

用法：`rig release <rigId> [--delete] [--json]`

说明：

- 从 rig 释放所有已 claim/adopt session，但不 kill 其 tmux session。
- `--delete` 在干净 release 后删除 rig record。
- 由 OpenRig 启动的 node 仍需使用 `rig down`。

### `rig launch`

用法：`rig launch <rigId> [nodeRef] [--seats <ids>] [--hold-reason <reason>] [--snapshot-id <id>] [--plan] [--json]`

说明：

- 启动或重新启动 running rig 中的 node。
- 单目标形式中，可选 `nodeRef` 可以是 logical ID 或 node ID。
- `--seats <ids>`（v0.3.4，slice 11）接受逗号分隔 logical ID，用于 node 粒度的 managed partial
  restore——启动具名 seat 子集，其余 seat 保持 hold。它取代此前 `pod_aware_launch_unsupported`
  dead end。
- `--hold-reason <reason>` 记录非目标 seat 被 hold 的原因；通过 observability 呈现，使 hold state
  可审计。
- `--snapshot-id <id>` 选择一个确切可用于 restore 的 snapshot，而不是自动选择。`--plan` 预览
  multi-seat subset 及其非目标 effect，不产生 mutation。
- `rig launch <rigId> <nodeRef> --retry-startup-from <member-file> --rig-root <absolute-source-root>`
  显式重试新增 agent：其首次启动在 resource projection 期间失败，尚未开始 native conversation，
  也尚未保存 startup context。先修正 projection failure，正常退出 failed shell，并在其停止后使用
  `rig seat clean <seat> --reason <reason>`。提供原始裸 YAML/JSON fragment 或 `{member: ...}` wrapper，
  不含 edge 或 member startup/continuity override。agent source hash 与保留的 identity、model、cwd、
  policy 必须一致。重试在同一 node 上使用正常 validation、projection 与必需 startup delivery；
  保留其他 seat 与此前 failure。拒绝 bound、live、indeterminate 或此前 native session。这不是 snapshot
  restore，也不能替代 deliberate fresh launch，且不能与 snapshot、subset 或 plan option 组合。操作员
  负责提供完整原始 fragment：保留 state 无法重建缺失的 member、pod 或 rig instruction。绝不能为了
  让重试通过而剥离不支持的 override。

### `rig remove`

用法：`rig remove <rigId> <nodeRef> [--json]`

说明：

- 从 running rig 删除单个 node。

### `rig shrink`

用法：`rig shrink <rigId> <podRef> [--json]`

说明：

- 从 running rig 删除整个 pod。
- `podRef` 可以是 pod namespace 或 pod ID。

## Identity、通信与 Context

### `rig startup-proof submit`

用法：`rig startup-proof submit --challenge-id <id> --answer <answer> [--json]`

通过 authenticated activity hook 提交选定 startup exercise，使用当前 seat identity 与其 startup
prompt 中提供的 challenge。正确且当前有效的 answer 返回 `oriented: verified`；裸 acknowledgement、
错误 answer 或陈旧 challenge 均失败。仅有 startup readiness 不会验证 orientation。

可通过 `startup_proof` startup action opt-in 额外 exercise，其中 `value: authenticated` 且
`idempotent: true`。省略时不增加 exercise；之后适用的 `value: none` 会选择轻量 startup。完整编写与
restore 规则见 [startup proof selection](../reference/rig-spec.md#startup-proof-selection)。terminal node
不接收 challenge。

### `rig whoami`

用法：`rig whoami [--node-id <id>] [--session <name>] [--host <id>] [--full | --verbose] [--json]`

Identity 解析顺序：

1. `--node-id`
2. `--session`
3. `OPENRIG_NODE_ID` / `RIGGED_NODE_ID`
4. `OPENRIG_SESSION_NAME` / `RIGGED_SESSION_NAME`
5. tmux pane metadata `@rigged_node_id`
6. tmux pane metadata `@rigged_session_name`
7. raw tmux session name

说明：

- **v0.4.0——默认 compact（slice 27）**：`rig whoami` 与 `rig whoami --json` 默认只返回 identity
  recovery 必需信息——`identity`（rig / pod / member / sessionName / runtime / cwd / logicalId / ids）、
  `peers`（只含名称：每个 peer 的 logicalId + sessionName）、`edges`（方向性 `kind` +
  `to.sessionName`）、`transcriptPath`。请求 compact 时，daemon 跳过 `contextUsageStore` 查询与
  `runtimeContext` 构建（也减少 daemon 工作）。每个 agent 启动及每次 compaction restore 首先运行的
  命令，现在约消耗 192 token，而非约 909。
- **`--full`（alias `--verbose`）**返回当前完整 payload，包括 `contextUsage`、`commands`、
  `peersNote`、`runtimeContext`——与 v0.3.4 默认值保持 byte/shape parity（向后兼容读取这些字段的
  consumer）。
- compact 默认是 ALLOWLIST projection（不是 denylist）——未来 payload 字段默认只进入 `--full`，
  不会静默让每次启动路径重新膨胀。
- daemon 不可达但仍可解析 identity source 时，`--json` 返回 partial result，而不是崩溃。
- 人类可读输出（默认 compact）显示 identity + peers + edges + transcript path。`--full` 追加
  context usage block、commands list、peersNote prose 与 runtimeContext。
- `peers[]` 是此 rig 排除自身后的 roster（不按 edge 过滤）；方向关系使用 `edges{}`，包含自身与
  live state 的 node inventory 使用 `rig ps --nodes`。
- Claude Code project 中，无人值守的启动期 `rig whoami` 可能要求本地 permission allowlist 包含
  `Bash(rig:*)`。
- `--host <id>` 通过单 hop ssh 将相同命令路由到 `~/.openrig/hosts.yaml` 中声明的远端 host
  （CLI 侧 shell-out；daemon 不变）。identity 在远端 rig 上解析（每台 host 有自己的 daemon + tmux +
  identity context）；本地 `--node-id`/`--session`/`--full` flag 会转发给远端 `rig whoami`。成功时
  原样透传远端 rig 输出；失败使用与 `rig ps --host` 和 `rig send --host` 相同的
  `ssh-unreachable` / `permission-gate` / `remote-daemon-unreachable` / `remote-command-failed` enum。

### `rig transcript`

用法：`rig transcript <session> [--tail <lines>] [--grep <pattern>] [--host <id>] [--json]`

默认值：

- `--tail 50`

说明：

- 读取 transcript 文件，而非 pane scrollback。
- `--grep` 将 pattern 视为 regex。
- **v0.4.6（OPR.0.4.6.MH4）**——`--host <id>` / `agent@rig@host` session 形式从远端 host
  读取 transcript，CLI 直接调用该 daemon 已发布的 `GET /api/transcripts/:session/tail|grep` 路由
  （只支持 http 注册 host——ssh 声明 host 返回结构化 transport requirement 错误；此 verb 没有 ssh
  路径）。在 `[via host=…]` banner 下原样返回 origin output shape。优先级：显式 `--host` > target
  sugar > 持久 host selection。见“跨 host execution”。

### `rig send`

用法：`rig send <session> [<text>] [--context <ref>] [--verify] [--force] [--raw] [--dangerously-interact --reason <text>] [--wait-for-idle <s>] [--from <session>] [--host <id>] [--json]`

说明：

- 自动使用两步 send 模式：paste 文本、等待、提交 Enter。
- `--verify` 请求 delivery verification。
- 默认路径只在存在目标处于 interactive prompt / permission block 的正向证据时拒绝发送。这解决了
  peer message 盲目提交另一个 agent 的 open prompt 这一 footgun。当无法判定目标 activity（unknown、
  missing 或 stale telemetry）时，send 会附带 advisory 继续——telemetry 是 advisory，不是 agent 能否
  通信的 authority。使用 `--wait-for-idle` 可只在有显式 idle evidence 后发送。
- mid-task/busy target 默认附 advisory 发送（busy 不是 block）。`--force` 是向后兼容 no-op，绝不会
  绕过 interactive-prompt/permission guard。
- `--raw` 发送准确文本/keystroke，不带 From/To messaging envelope；仍受 interactive prompt guard。
- `--context <ref>` 解析一个 path-like context ref，并在本地 single-seat send 中投递其全部内容。缺失
  member 会在投递前中止；内容过大会发出 `rig walk` advisory。不支持与 `--host`、跨 host target sugar
  或 fan-out targeting 组合。
- `--dangerously-interact` 是 prompt/permission guard 的唯一 override——有意驱动 interactive prompt/
  permission block（例如选择 option）。它隐含 `--raw`，要求 `--reason <text>`，并记录到 audit log。
  不能与 `--wait-for-idle` 组合。
- `--reason <text>` 记录驱动 prompt 的原因（使用 `--dangerously-interact` 时必需）。
- `--host <id>` 向 `~/.openrig/hosts.yaml` 中声明的远端 host 发送；见下方“跨 host execution”。
  **v0.4.6（OPR.0.4.6.MH4）**——host entry 的 transport 决定路径：ssh host 保持单 hop ssh
  shell-out 字节级原样（SSH 成功不等于 verify 成功——以远端 rig 的 `Verified: yes/no` 为准，并原样
  呈现）；http host（例如由 pair 注册）由 CLI 直接请求远端 daemon 的
  `POST /api/transport/send`，body 与本地 send 完全一致（按构造保证 wrap parity）——`--verify` 原样
  打印远端路由的 `verified`/`outcome`，绝不在本地合成 verdict。`agent@rig@host` target 形式在 suffix
  匹配已注册 host id 时是 `--host` 语法糖（显式 `--host` > sugar > 持久 selection；`--host` 与
  sugar 冲突时返回结构化错误）。

### `rig capture`

用法：

- `rig capture <session> [--lines <n>] [--host <id>] [--json]`
- `rig capture --rig <name> [--lines <n>] [--host <id>] [--json]`
- `rig capture --pod <name> --rig <name> [--lines <n>] [--host <id>] [--json]`

默认值：

- `--lines 20`

说明：

- `--host <id>` 在 `~/.openrig/hosts.yaml` 声明的远端 host 上 capture；见下方“跨 host execution”。
  **v0.4.6（OPR.0.4.6.MH4）**——ssh host 保持 shell-out 原样；http host 由 CLI 直接请求远端
  daemon 的 `POST /api/transport/capture`，使用本地 body shape（lines/rig/pod/session），并在
  `[via host=…]` banner 下与本地 capture 一样渲染 single/multi result。`agent@rig@host` session 形式
  在 suffix 匹配已注册 host id 时是 `--host` 语法糖（`--rig`/`--pod` value 是名称，绝不做
  sugar parse）。

### `rig walk`

用法：`rig walk <seat> --through <ref | files...> [--pace <duration>] [--json]`

说明：

- `--through` 接受一个 path-like context ref 或有序的已有本地文件列表；混合两种形式会被拒绝。
- 通过正常 transport 每次发送一个 piece，并在 piece 间等待 `--pace`（默认 `10s`；duration override
  必须带显式 `ms` 或 `s` suffix）。`--consume-timeout`、`--consume-poll` 与 `--turn-timeout` 使用
  相同显式单位 grammar；拒绝裸数字。末尾没有额外延迟。
- 本地文件缺失，或 ref member 缺失/不可读时，会在首次 send 前中止，因此一次 walk 要么投递全部
  piece，要么一个都不投递。
- 能解析 generation record 时，每个 piece 都必须作为完整 user message 出现在新追加 record 中，
  且相应 native turn 必须先闭合，才能发送下一 piece。只归一化 CRLF line ending 与首尾 whitespace；
  内部 whitespace、缺失中段、共享 prefix 与 tail 均不符合。
- Claude closure 沿 message UUID ancestry，从 assistant response 跟踪到 `turn_duration`。Codex 使用
  具名 `task_started`/`task_complete` turn 中的 `response_item` user message；queued input 或另一 turn
  的 completion 均不足。这些 receipt 证明 delivery 与 turn completion，不证明 semantic comprehension。
- Codex generation lookup 将绑定 process 的启动后 log thread ID 与保留的 native CLI conversation
  连接。辅助 title thread 不能替代该 identity；零个或多个匹配 conversation 会保持 unverified，
  而不是按 recency 选择。
- Codex record 通过已验证当前 pane/process 与 native thread table 解析，包括 token telemetry 尚不存在
  时。rollout header 必须标识该 thread。identity 缺失或有歧义会报告为 unverified。已验证 walk 期间
  generation/file 被替换或 record 不可读时会中止；绝不会静默继续到替代 occupant。
- `--json` 报告 `consumptionVerified`。若初始 generation-record probe 不可用，仍可执行 legacy
  delivery，但会显式给出 unverified advisory，并返回 `consumptionVerified: false`。

### 跨 host execution（`--host <id>`）

跨 host 命令按 id 路由到已声明的远端 host。SSH transport 命令使用 CLI 侧单 hop SSH shell-out；
HTTP transport 命令请求远端 daemon API。本地 daemon 不参与 SSH routing。远端 host 应在 `$PATH`
上提供自己的 managed `rig`。

HTTP sender attribution 使用来源 instance 持久化的 self-host identity，读取时不创建或改变其
database。显式 DB config 优先；否则保留上次 daemon launch 的 DB selection。本地 daemon 停止时仍然
有效。destination identity 与已配置 display name 绝不用作 origin。

普通本地请求保留裸 seat name。对于显式 `OPENRIG_URL`（或旧版 `RIGGED_URL`），有界 health probe
只在 target 的 self-host identity 与本地一致时保留裸地址。不同、不可用或有歧义的 target——包括
loopback forwarding endpoint——会获得已知 origin suffix。已限定 sender 保持不变。若无法读取本地
origin，delivery 会携带 `origin-unknown:v1` provenance 继续，并在成功响应后输出 diagnostic；queue
forwarding 保留该不确定性，不会将 sender 归因给 relay。

host 由操作员在 `~/.openrig/hosts.yaml` 中声明：

```yaml
hosts:
  - id: vm-claude-test
    transport: ssh
    target: vm-claude-test.local
    user: your-username  # 可选
    notes: "test VM"     # 可选
  - id: factory-http
    transport: http
    url: http://100.64.1.2:7433
    bearer_env: FACTORY_HTTP_TOKEN
```

校验规则：

- `hosts` 必须存在且为非 null 数组。
- 每个 entry：`id` 必需（非空、唯一），`transport` 必需（`ssh` 或 `http`）。
- SSH entry 要求 `target`（非空——DNS name、SSH config alias 或 IP）；`user` 与 `notes` 可选。
- HTTP entry 要求 `url`；bearer pointer（`bearer_env` 或 `bearer_file`）可选——对于匿名/tokenless
  daemon 可同时省略（不发送 `Authorization` header；host+VM 属于同一 founder-owned trust domain，
  mesh 是 auth boundary）。最多设置一个 bearer pointer，绝不能同时设置。pointer 是 config name/path，
  绝不是已解析 token value；已配置但无法解析的 pointer 会在任何请求前成为 permission failure。
- `rig host add/list/doctor` 覆盖标准路径；特殊情况仍通过手动编辑处理。
- 文件缺失或无效时返回清晰错误，并指向规范路径。

CLI 区分四种结构化 failure mode（每种模式都为操作者提供 actionable error；JSON 输出保留
`failedStep` enum）：

- `ssh-unreachable`——SSH 本身失败（connection refused、host key mismatch 等）。验证 SSH access 与
  registry entry。
- `permission-gate`——SSH 遇到 auth/permission gate（Permission denied、Keychain）。错误包含
  keychain-over-SSH field note 提示。
- `remote-daemon-unreachable`——SSH 成功，但远端 `rig` 报告远端 daemon 不可达。使用
  `ssh <target> rig daemon start` 启动。
- `remote-command-failed`——SSH 成功，但远端 `rig` 因其他原因非零退出；呈现远端 stderr。

**transport posture（OPR.0.4.4.13 FR-4——已决定，PM 裁定：记录即可，不要求 parity）。** 此分区是
预期 posture，而非历史偶然：**ssh 承载 interactive pane op，http 承载 daemon REST op，
`ps`/`whoami` 遵循 host 声明的 transport。** 不存在 cross-transport fallback，0.4.4 不发布
`send`/`capture` 的 http parity（parity 会引入无 scope-locked 需求的新 attack surface）。
**v0.4.6 更新（OPR.0.4.6.MH4，PM 裁定纳入，作为 fulfilling-confirmed-intent）：** `send`/
`capture` 增加 http branch——founder 的 `pair` 入口注册 HTTP host，若无该 branch，pair 注册的 demo
host 完全无法接收 send/capture。机制是 CLI 通过已发布的 `runRemoteHttpOp` 直接请求远端 daemon 的
既有 transport route（daemon 侧零变更；ssh host 的 ssh 路径保持字节级不变——扩展覆盖，而非重写；
仍无 cross-transport fallback：host entry 声明的 transport 决定路径）。`transcript` 与 `broadcast`
以相同方式首次获得跨 host 能力（仅 http——二者没有 ssh 路径）。按命令如下：

| 命令 | ssh transport | http transport | Fan-out（`--all-hosts`/`--hosts`） |
| --- | --- | --- | --- |
| `rig send` | ✓（shell-out，字节级原样） | ✓（v0.4.6 MH-4——CLI 直接 `POST /api/transport/send`） | ✗ |
| `rig capture` | ✓（shell-out，字节级原样） | ✓（v0.4.6 MH-4——CLI 直接 `POST /api/transport/capture`） | ✗ |
| `rig transcript --host`（v0.4.6，OPR.0.4.6.MH4） | ✗（结构化 transport 错误） | ✓（CLI 直接 `GET /api/transcripts/:session/tail\|grep`） | ✗ |
| `rig broadcast --host`（v0.4.6，OPR.0.4.6.MH4） | ✗（结构化 transport 错误） | ✓（CLI 直接 `POST /api/transport/broadcast`；远端 fan-out、per-target 透传） | ✗ |
| `rig up` / `rig down` / `rig launch` | ✗ | ✓（仅 http） | ✗ |
| `rig file copy`（v0.4.4） | ✓（仅 ssh，rsync-over-ssh） | ✗ | ✗ |
| `rig ps --host` | ✓（已声明） | ✓（已声明） | 仅 http；非 http host 在 `hosts[]` 中显示为结构化 `unsupported-transport` status |
| `rig whoami --host` | ✓（已声明） | ✓（已声明） | 仅 http；当前会从 fan-out 中静默过滤非 http host（已发布 gap，路由到 0.4.5 triage——与 ps 的结构化 status 不同） |
| `rig host doctor` | ✓ | ✓ | n/a（单 host） |
| `rig queue create/handoff/handoff-and-complete --host`（v0.4.6，OPR.0.4.6.MH3） | ✗ | ✓（仅 http，daemon→daemon forward——ssh 声明 host 返回结构化 `unsupported-transport` 错误） | ✗ |

0.4.4 范围外：cross-transport fallback；`send`/`capture` 的 http parity（已在 0.4.6
OPR.0.4.6.MH4 发布，PM 裁定为 fulfilling-confirmed-intent；见上方 v0.4.6 更新）；connection
pooling；multi-hop SSH；cross-host queue routing（已在 0.4.6 OPR.0.4.6.MH3 发布；见 `rig queue`
§ 跨 host queue routing）；cross-host seat handover。

**http branch 的 failure taxonomy（v0.4.6——OPR.0.4.6.MH4）。** http branch 使用自己的 step name
（绝不用 ssh enum，也不用泛化 "failed"）：registry-load-failed / unknown-host（四个 verb 共用同一
类别）/ `permission-gate`（本地 bearer 解析失败，或远端返回 401/403——包括下方 terminal-bearer
posture）/ `remote-daemon-unreachable`（network/timeout）/ `remote-command-failed`（远端 4xx/5xx，
并在 step 旁呈现远端路由自身 error text）。**Terminal-bearer posture（具名，v0——只适用于
`/api/transport/*`，即 send/capture/broadcast）：**远端 transport route 以自己的 terminal bearer 类别
设 gate，CLI 在配置时提供 host registry bearer；只含 URL 的匿名 host 不发送 `Authorization` header。
默认值（无 terminal bearer）+ tailnet bind 按设计直接通过（mesh 是 auth boundary）；执行不同 terminal
bearer 的远端会显示为结构化 `permission-gate` step——补救方法：令远端 terminal bearer 与已配对
registry bearer 相同，或依赖 tailnet boundary。**`rig transcript --host` 不属于该类别（arch n2）：**
远端 `/api/transcripts/*` 路由采用随附的 ungated transcript-read posture（open route、daemon-local
trust boundary、路由级 credential redaction 作为保护原语）——会让跨 host send 遇到 permission gate 的
错误 terminal bearer 不会阻止跨 host transcript read，后者继续成功。跨 tail/grep/full 一致的
transcript-read auth policy 是该路由注释中的具名未来 slice（`routes/transcripts.ts`，orch decision
approved-option-a），不在当前范围。此 slice 不发布新 auth 机制。

**Destination parse rule——双 family 契约（OPR.0.4.6.MH3，架构裁定）。** `agent@rig@host` 三段
形式是 CLI 边缘的 INPUT SUGAR，而非 grammar：session string 始终保持 `member@rig`（BR-1），host
始终带外传递。按设计，每个 verb family 发布两种 parse rule——单一规范 rule 要么破坏 adopted target，
要么降低 queue 错误诚实性：

| Verb family | 三段式末尾 segment | 原因 |
| --- | --- | --- |
| Queue coordination write（`rig queue create/handoff/handoff-and-complete`） | **始终剥离**到带外 `hostId` envelope（在 human-seat classifier 之后） | Queue destination 按构造只能为 canonical（daemon 的 `validateRig` 拒绝任何非规范 parse），因此无条件剥离不会丢失信息——拼错 host 会以 unknown-HOST 错误显著失败，而不是误导性的 rig-shaped `unknown_destination_rig`。 |
| Session-target interactive/observe verb（`rig send/capture/transcript`） | **仅当 segment 匹配已注册 host id 时剥离** | interactive verb 可合法指向含 `@` 的 raw/adopted tmux session name；strip-iff-registered 保留这些名称，未注册 suffix host hint 则使拼写错误显著失败。 |
| `rig broadcast` | **无 sugar**——位置参数是 MESSAGE TEXT，绝不按 target 解析 | sugar parse message body 会破坏包含 `@` 的文本；跨 host broadcast 只依据 `--host` 或持久 selection 路由（v0.4.6——OPR.0.4.6.MH4）。 |

两个 family 收敛到同一结果：拼错 host 会显著失败并点名 host。`RESERVED_HOST_IDS` 集合
（`kernel`、`host`、`local`——在 `rig host add` 时拒绝）保证已注册 host 永远不会遮蔽 human-seat
`@kernel`/`@host` 分类 family。

### `rig file`（v0.4.4——OPR.0.4.4.18）

用法：`rig file copy <src> <dst> [--dry-run] [--json]`

通过 ssh/rsync 跨 host 移动文件——v0 只发布一个显式 verb `copy`，一次传输一个文件。

Operand grammar（解析，绝不猜测）：

- `<hostId>:<absolute-path>` = 远端（`<hostId>` 必须在 ssh hosts registry 中解析；远端 path 必须
  为绝对路径）。
- 裸 path = 本地。文件名含 colon 的本地文件需要 `./` prefix（`./weird:name.txt`）——grammar 会以
  结构化错误拒绝有歧义形式，而不是猜测。
- 有效形态：local→remote、remote→local、local→local。remote→remote 不是 v0 形态。

语义与 safety wall（source：`packages/cli/src/lib/file-transfer.ts`）：

- 已有 destination 会被**覆盖**（明确的 v0 copy 语义）——使用 `--dry-run` 预览，它会打印准确的计划
  transfer（src、dst、host、files/bytes），且不移动任何内容。
- **对 live agent/credential state 的默认拒绝 wall**：解析到封闭 deny set `~/.openrig`、`~/.ssh`、
  `~/.codex`、`~/.claude`，以及 active `OPENRIG_HOME` 与 active hosts registry 文件的路径会被拒绝，
  并给出具名 what/why error（扩展 deny set 必须经过裁定，绝不静默扩大）。
- 在 raw operand 上拒绝 traversal：任何 `..` path segment 都在 normalization 前拒绝（normalization
  会折叠 `..`，因此 normalize 后检查会成为 dead code）；远端 path 还限制为 shell-inert 字符集
  （`A-Za-z0-9._/-`——用限制替代 escaping，因为 fleet 中两种 rsync 实现在 quoting flag 上不同），
  每次 rsync invocation 都在 operand 前固定 `--`，并使用 argv 形式 spawn，不经过 shell。
- transport 只支持 ssh（见上方 transport-posture table）；远端使用 `rig send`/`capture` 共用的 ssh
  registry entry。

### `rig host`

用法：`rig host <add|list|doctor>`——multi-host registry verb（OPR.0.4.4.13；严格限制为这三项——
没有 edit/remove/tunnel/bootstrap verb；特殊情况继续手动编辑 `hosts.yaml`，factory bootstrap 由
`scripts/bootstrap-product-factory-vps.sh` 提供）。

- `add --id <id> --transport <ssh|http> [--target <t> --user <u> | --url <u> [--bearer-env <n>|--bearer-file <p>]] [--notes <text>] [--json]`——
  按 registry loader 自己的规则校验并写入 entry（add-time error 原样采用 load-time error；拒绝重复
  id；http bearer pointer 可选——tokenless daemon 可同时省略，绝不能同时设置两项）。以规范形式重写
  `hosts.yaml`（不保留手写注释）。
- `list [--json]`——id/transport/target，以及作为 config pointer 的 AUTH（`env:NAME` / `file:PATH` /
  `ssh-key`）；绝不显示已解析 secret value。
- `doctor <id> [--posture product-factory-vps] [--public-addr <ip>] [--json]`——分步、诚实验证：
  transport reachability → 远端 `rig` binary（+version）→ 远端 daemon health → 远端 identity；
  每个失败 step 都是独立 actionable error，unknown host id 显示为 registry error class。`--posture`
  运行唯一内置 baseline（`product-factory-vps`）：每项分别报告 pass/fail/**unknown**，每个非 pass
  项提供 fix——UNKNOWN 绝不是 pass；公开 `:7433`/`:22` probe 需要 `--public-addr`（外部 vantage），
  可从公网访问 daemon port 会显著 FAIL。任意 fail 时 exit `1`。

### `rig broadcast`

用法：`rig broadcast [<text>] [--context <ref>] [--rig <name>] [--pod <name>] [--force] [--host <id>] [--json]`

说明：

- 不带 `--rig` 或 `--pod` 时，向所有 rig 中所有 running session broadcast。
- `--context <ref>` 解析一个 path-like context ref，并 fan-out 其全部内容。缺失 member 会在 fan-out
  前中止；内容过大会发出 `rig walk` advisory。不支持与 `--host` 组合。
- **v0.4.6（OPR.0.4.6.MH4）**——`--host <id>` 在远端 host 上 broadcast，由 CLI 直接请求该
  daemon 已发布的 `POST /api/transport/broadcast`（只支持 http 注册 host；ssh 声明 host 返回结构化
  transport requirement 错误）。远端 daemon 在自身 topology 上解析 `--rig`/`--pod`；per-target result
  原样打印，partial fan-out 与本地一样以非零退出。远端调用有自己的具名 fan-out deadline
  （`BROADCAST_REMOTE_TIMEOUT_MS`，30 秒——完整 per-target loop 会超过默认 5 秒读取时限）。
  `<text>` 位置参数是 message text，绝不按 target 解析，因此 broadcast 使用 `--host` 或持久 host
  selection——不使用 `agent@rig@host` sugar。

### `rig ask`

用法：`rig ask <rig> <question> [--json]`

当前实现：

- 查询 `/api/ask`
- 返回：
  - 原始 question
  - rig summary（`name`、`status`、`nodeCount`、`runningCount`、`uptime`）
  - transcript 中的 evidence excerpt
  - 可选 chat excerpt
  - `insufficient` flag
  - 可选 guidance text

重要：

- live help description 写的是“Search rig transcript history with a natural language question”，
  但已发布行为比纯 transcript grep 更广，又比 topology/lifecycle synthesis layer 更窄。
- 此命令是 daemon-backed evidence query，不会进行第二次 LLM invocation。

### `rig chatroom`

用法：`rig chatroom <subcommand>`

子命令：

- `send <rig> <message> [--sender <name>]`
- `history <rig> [--topic <name>] [--after <id>] [--since <ts>] [--sender <name>] [--limit <n>] [--json]`
- `wait <rig> [--after <id>] [--topic <name>] [--sender <name>] [--timeout <seconds>] [--json]`
- `clear <rig>`
- `topic <rig> <topic-name> [--body <text>] [--sender <name>]`
- `watch <rig> [--tmux]`

说明：

- 所有 chatroom 子命令都以 rig name 作为位置参数。
- `history` filter 可组合：`--sender`、`--since`、`--after`、`--topic` 可以一起使用。
- `wait` 阻塞，直至出现新的匹配 message 或超时（exit 1）。filter 语义与 `history` 相同。
- `clear` 是破坏性且限于 rig 的操作，会删除该 rig 的所有 message。
- `watch --tmux` 启动专用 tmux watcher session。

## 协调原语（PL-004 阶段 A）

两个顶层命令支撑以 SQLite 为规范事实来源的协调层。它们只与 daemon HTTP API 通信；不触碰 POC
`rigx-stream-proto` / `rigx-queue-proto` 文件系统状态。POC 与 daemon 只在操作员层共存。

### `rig stream`

用法：`rig stream <subcommand>`——L1 仅追加 intake stream。

子命令：

- `emit --source <session> --body <text> [--format <fmt>] [--hint-destination <session>] [--hint-type <type>] [--hint-urgency <urgency>] [--hint-tags <csv>] [--interrupt] [--id <streamItemId>] [--json]`
- `list [--source <session>] [--hint-destination <session>] [--tag <tag>] [--since <iso>] [--until <iso>] [--limit <n>] [--after <sortKey>] [--include-archived] [--json]`
- `watch [--json]`
- `show <streamItemId> [--json]`
- `archive <streamItemId> [--json]`

说明：

- `--id` 用于 idempotency；相同 id 返回同一 row，忽略后续调用的 body。
- `--tag` 在 `hint_tags` 中执行精确成员匹配，而非 substring match。`--since` 与 `--until` 是
  inclusive ISO timestamp bound，由 daemon 归一化为 UTC；list 顺序与 cursor 语义保持 chronological。
- `watch` 消费现有 `/api/stream/sse` 契约：daemon 的 initial replay，随后是 live item。human output
  显示 timestamp、source 与 body；`--json` 每行发出一个 `StreamItem` object。它只建立一次 connection，
  不会自动重连。
- `archive` 是软操作——row 保留供 audit；除非传入 `--include-archived`，否则从 `list` 中排除。

### `rig queue`

用法：`rig queue <subcommand>`——L3 owned-work queue + inbox/outbox。

子命令：

- `create --source <session> --destination <session> (--body <text> | --body-file <path> | --body-context <ref>) [--mission <id>] [--slice <id>] [--priority <p>] [--tier <t>] [--tags <csv>] [--target-repo <name>] [--host <id>] [--no-nudge] [--expires-at <iso>] [--id <qitemId>] [--json]`——
  `--body-context <ref>` 解析完整 context pack，将内容 snapshot 到 qitem body，并添加
  `body-context:<ref>` provenance tag；它与 `--body` / `--body-file` 互斥，缺失 member 会在创建
  qitem 前中止。v0.3.2 slice-21 FR-4 增加 `--body-file <path>`（使用 `-` 读取 stdin），消除多行 body
  的 backtick shell corruption 类别，并增加一等 `--mission <id>` / `--slice <id>` flag，转换为
  `mission:<id>` / `slice:<id>` tag（与 `--tags` 组合）。v0.4.6（OPR.0.4.6.MH3）增加 `--host <id>` /
  `agent@rig@host` destination 形式——见下方“跨 host queue routing”。
- `claim <qitemId> --destination <session> [--json]`——pending → in-progress；根据 tier 计算
  closure_required_at
- `unclaim <qitemId> --destination <session> [--reason <text>] [--json]`——in-progress → pending
- `update <qitemId> --actor <session> --state <state> [--closure-reason <r>] [--closure-target <t>] [--note <text>] [--json]`
- `handoff <qitemId> --from <session> --to <session> [--body <text> | --body-file <path>] [--note <text>] [--priority <p>] [--tier <t>] [--tags <csv>] [--host <id>] [--json]`——
  事务性 close-as-handed-off + create-new；v0.4.6（OPR.0.4.6.MH3）增加 `--host <id>` /
  `agent@rig@host` `--to` 形式（§ 跨 host queue routing）
- `handoff-and-complete <qitemId> --from <session> --to <session> [--body <text> | --body-file <path>] [--note <text>] [--priority <p>] [--tier <t>] [--tags <csv>] [--host <id>] [--json]`——
  `handoff` 变体，将 source 关闭为 terminal `done`，而非 `handed-off`；atomic close+create、
  chain_of_record、default-nudge 与跨 host 契约相同
- `fallback <qitemId> --destination <session> [--reason <text>] [--json]`——重新路由到 fallback seat
- `show <qitemId> [--json]`
- `transitions <qitemId> [--json]`——仅追加 transition log
- `list [--destination <session>] [--source <session>] [--owned] [--mine] [--state <csv>] [-a | --all] [-A | --all-rigs] [--full] [-o <json|wide>] [--limit <n>] [--json]`——
  **v0.4.0 grammar（slices 28 + 32，与 docker/kubectl 对齐）**：
  - **`rig queue list`**（无 flag）→ 仅 active state（`pending` / `in-progress` / `claimed` /
    `blocked` / `handed-off`；不含 `done` / `canceled`），current-rig 范围，compact row：`qitemId`、
    `state`、`source→destination`（或 `current-owner`）、`closure_reason` / `closure_target`
    （handed-off / blocked 时）、`mission`、`slice`、`tier` / `priority`、`age` / `updated_at`、
    short title、有限 tag。排除完整 body、chain_of_record、transition history、proof/artifact blob。
  - **`-a` / `--all`** → 在当前范围内包含 closed/done history（docker `-a` 轴：history）。
  - **`-A` / `--all-rigs`** → 跨 rig 范围（kubectl `-A` 轴：breadth）。可与 `-a`、`--owned`、
    `--mine`、`--full` 组合。
  - **`--full`** → 向所选 scope 添加 body + chain-of-record + 完整 tag + transition history
    （field-breadth 轴）。
  - **`-o json|wide`** → encoding，默认 compact。`-o json` 不隐含完整 body（compact JSON 兼顾
    token 安全与机器可解析）；`--full -o json` 返回完整 JSON。
  - **`--owned`** → 分配给 caller 的 obligation（仅 `destination_session`）。
  - **`--mine`** → caller 的 source-or-destination union，包括 caller 创建但不拥有的 row。
  - pipeline 使用必须启用 `set -o pipefail`；否则 shell 只报告下游 formatter 的 status，可能掩盖
    timeout 等非零 `rig` 读取结果。
  - `--destination <s>` / `--source <s>` / `--state <csv>` 保持可用，并与新 flag 组合。
  - 四个轴（scope × history × field-breadth × encoding）正交且可组合。此前聚合 cross-rig + full
    history 的裸无 scope firehose（live host 上约 64,000 token）不再是默认值——通过
    `-A -a --full` opt-in。
  - 使用 `rig queue show <qitemId>` 查看 body preview；`rig queue show <qitemId> --full --json`
    返回原始完整 record。Preview JSON 追加 `readView`，包含 completeness、omitted content、full JSON
    byte size 与准确 expansion command。
- `overdue [--json]`——超过 closure_required_at 的 in-progress qitem
- `inbox-drop <destinationSession> --sender <session> (--body <text> | --body-file <path>) [--tags <csv>] [--urgency <u>] [--audit <pointer>] [--id <inboxId>] [--json]`
- `inbox-absorb <inboxId> --receiver <session> [--json]`——将 pending inbox entry 提升为 queue_item
- `inbox-deny <inboxId> --receiver <session> --reason <text> [--json]`
- `inbox-pending <destinationSession> [--json]`
- `outbox-record --sender <session> --destination <session> (--body <text> | --body-file <path>) [--tags <csv>] [--urgency <u>] [--audit <pointer>] [--id <outboxId>] [--json]`
- `outbox-list <senderSession> [--limit <n>] [--json]`

Hot-potato 严格拒绝（承重 API 契约）：

- `update --state done` 要求 `--closure-reason` 是以下值之一：`handed_off_to`、`blocked_on`、
  `denied`、`canceled`、`no-follow-on`、`escalation`。缺失或无效 reason → exit 1，并返回点名六个
  有效值的结构化错误。
- `closure-reason` 为 `handed_off_to`、`blocked_on` 或 `escalation` 时，还要求
  `--closure-target`。
- 所有 hot-potato enforcement 位于 daemon domain 层；每个 surface（CLI、未来 MCP、未来 UI）继承
  相同保证。

Closure-reason 语义：

- `handed_off_to`——work 在另一 seat 继续（target = 新 owner）。首选 `handoff` 子命令；`update`
  为非 handoff terminal closure 接受该值。
- `blocked_on`——停放，等待另一 qitem（target = blocker qitem_id）。
- `denied`——receiver 拒绝 work。
- `canceled`——sender 或 receiver 撤回。
- `no-follow-on`——terminal completion，无后续需求。
- `escalation`——提升到更高 tier（target = escalation target）。

### 跨 host queue routing（v0.4.6——OPR.0.4.6.MH3）

`rig queue create`、`handoff` 与 `handoff-and-complete` 可将 destination 指向另一台已注册 host：
`--host <id>` 或 host 限定 destination 形式 `member@rig@<host>`（二者解析到同一带外 `hostId`
request envelope；若二者指定不同 host，则返回结构化 ambiguity error）。该机制推广了已发布的
mission-control forward-then-strip 写入：本地 daemon 在 server 侧解析 host registry（bearer 永不传给
caller），在边缘剥离 host，并通过 HTTP 将完整 body 转发到目标 daemon——完整模型见
`docs/as-built/architecture/coordination-primitive.md` § Cross-host queue routing。承重契约点：

- **仅显式指定（不跟随 selection）。** Queue verb 只根据 `--host` / 三段式执行跨 host routing——
  绝不查询持久 `rig host select` selection（持久写入与 hot-potato close 不得静默迁移到昨日 sticky
  selection）。这是与 observe/interactive verb 的有意不对称；后者会跟随 selection。
- **Origin 拥有 record。** qitem 存在于目标 host DB；该 row 就是唯一 record。本地绝不写 ghost row，
  目标 daemon 自己的 nudge 会在自身本地 tmux 上触发（转发完整 body，包括 `nudge` flag）。
- **At-least-once + idempotent，绝非 exactly-once。** forwarding daemon 在首次 forward 前生成 qitem
  id（重试按构造携带同一 id）；cross-host handoff successor id 从 source qitem、destination、host
  确定性派生，并以 `qitem-xh-…` namespace，使重新驱动的 forward 由目标 primary key 吸收。重试安全；
  identity field 不同却复用相同 id 的 create 返回结构化 `qitem_id_reuse` 错误。
- **Never-drop 顺序。** cross-host handoff 先在目标 host 创建 successor，再关闭本地 source。二者间崩溃
  会留下 live duplicate，幂等 redrive 会令其收敛——绝不会让 source 指向不存在的 successor 而关闭。
  redrive 时，已关闭 source 若 `closure_target` 匹配则吸收为成功；若不匹配则返回结构化
  `cross_host_close_conflict`（409）——呈现且绝不覆盖。*具名 residual（at-least-once/no-2PC 固有）：
  指向不同 destination 的 redrive 是新 handoff 决策，可能让较早 successor 留在目标 host 上——通过
  chain + provenance tag 可见，不是 dedup bug。*
- **Closure 字段。** cross-host source close 记录 `closure_reason=handed_off_to` 与
  `closure_target=member@rig@<host>`——`closure_target` 是 opaque audit/display metadata，只检查
  presence，绝不解析以 routing（任何 PR 若将其按 session string 解析，都是 spec violation）。
  session-string carrier（`destination_session`、`source_session`、`blocked_on`、`handed_off_to`）保持
  两段式 `member@rig`（BR-1）。转发后的 successor 携带连续 `chain_of_record`；这些 A 侧 id 在目标
  host 上是 opaque lineage identifier（不在目标 DB 中 dereference）。Provenance：转发项带
  `cross-host` + `from-host:<sender's self-declared name>` tag（诚实 best-effort，不是 authenticated
  identity）。
- **Failure honesty。** unknown host / ssh-declared host / unreachable / auth-failed 分别呈现为独立
  结构化 `remote_queue_write_failed` 错误，并点名 host——两侧均不写入任何内容。transport 只支持 http
  （daemon→daemon 路径负责触发远端 nudge；`rig send --host` 的 ssh shell-out 是不同机制，不受影响）。
- **本地零回归。** 不带 `--host`（或 `local`）= 当前本地路径，字节级一致。Claim / update / inbox
  verb 按原则保持本地：cross-host handoff 后，successor 位于其 worker 所在目标 host。在 sending host
  上对已 forward item 执行操作（cancel/update）是具名 follow-up，不属于 v1。

## 协调 Project / Classifier 与 View（PL-004 阶段 B）

两个顶层命令以 L2（project/classifier）与 L5（view）扩展 coordination layer。

### `rig project`

用法：`rig project <subcommand>`——L2 agent-backed classifier，带 daemon 强制 lease + idempotency +
reclaim。

子命令：

- `lease-acquire [options]`——为 caller 取得 active classifier lease。
- `lease-heartbeat [options]`——为 active classifier lease 发送 heartbeat（延长 TTL）。已超过 TTL 的
  lease 以 `lease_expired` 拒绝；请重新 acquire。
- `lease-show [options]`——显示当前 active classifier lease。
- `reclaim-classifier [options]`——供操作员 reclaim active classifier lease。使用 `--if-dead` 可在
  holder 仍存活时拒绝。
- `classify <streamItemId> [options]`——使用 classification field 投影 stream item。在
  `stream_item_id` 上幂等（first write wins）。要求 `--lease-id`：写入时只有该准确 lease 处于 active、
  未过期且由 `--session` 持有，结果才不会以 `lease_mismatch`、`lease_expired` 或 `lease_held` 拒绝。
  可选 `--area`、`--scope-ref`（与 `--candidate-set-version` 一起）、`--duplicate-of`、
  `--needs-human true|false`（unknown 时省略）、`--classifier-version`、`--taxonomy-version`、
  `--attempt-id`（与 `--execution-id` 一起）。没有 `--attempt-id` 时，结果属于 manual classification，
  不绑定 attempt ledger。每个提供的字段必须是字符串（ID 与 version 非空）；省略 `--needs-human`
  表示 unknown。
- `list [options]`——使用 filter（`--session`、`--destination`、`--area`、`--scope-ref`、
  `--needs-human true|false|unknown`）列出 project classification。
- `show <projectId> [options]`——显示一项 project classification。

说明：

- Lease 语义：任一时刻只有一个 classifier 持有 active lease。只有 lease 未过期时，heartbeat 才
  延长 TTL。重新 acquire 自己过期的 lease 会发出新 lease id，因此绑定到旧 id 的结果会被拒绝；
  另一 session 必须使用 `--evaluate-deadness-first` 或 reclaim verb。
- Attempt ledger（daemon HTTP，由 classifier occupant 使用）：`POST /api/projects/attempts/begin`、
  `/attempts/:id/abstain`、`/attempts/:id/fail`、`GET /api/projects/eligible`。abstention 与 error
  记录在其中，绝不写入 classification row；error 以有界 backoff 重试，最终进入 `exhausted`。每次
  `begin`（包括 timeout 或 error retry）返回新 `executionId`；只有当前 execution 能 abstain、fail 或
  绑定 result（否则 `attempt_superseded`），因为 renewable lease 永远不能证明较早 execution 已停止。
- `classify` 强制 L1→L2 foreign-key existence：引用的 `stream_items` row 必须存在，否则在任何
  state mutation 前拒绝。
- `reclaim-classifier` 是从 hung classifier 恢复的操作员 verb；`--if-dead` 增加 liveness guard，
  避免从仍在 heartbeat 的 classifier 手中抢占 lease。

### `rig view`

用法：`rig view <subcommand>`——L5 daemon-backed view，覆盖 coordination state。

子命令：

- `list [options]`——列出内置与自定义 view。
- `show <viewName> [options]`——运行 view（内置或自定义）。
- `register [options]`——注册或更新自定义 view。

内置 view：

- `recently-active`、`founder`、`pod-load`、`escalations`、`held`、`activity`。

说明：

- 每次影响 view 的 state mutation 都会发出 `view.changed` SSE event。queue update mutation 会 bridge
  到 `queue.updated`，再到六个内置 view 的 `view.changed`（阶段 B R2）。
- 自定义 view 注册写入 `views_custom` table；daemon 在注册时 hot-reload。

## 协调 Watchdog（PL-004 阶段 C）

`rig watchdog` 注册、列出、检查并停止 daemon 原生 scheduler job。scheduler 在 daemon supervision
tree 内运行，并将状态持久化到 SQLite（`watchdog_jobs`/`watchdog_history`）；job 可跨 daemon restart
存活。v1 提供三种 policy：`periodic-reminder`、`artifact-pool-ready`、`edge-artifact-required`。第四个
POC policy `workflow-keepalive` 会以 `policy_deferred_to_phase_d` 拒绝，并在阶段 D 发布。

### `rig watchdog`

- `register --spec <path> --policy <name> --target-session <s> --interval-seconds <n> --registered-by <s>`——
  从 YAML spec 注册 job；`--active-wake-interval-seconds` 与 `--scan-interval-seconds` 是
  pool-ready 特定 opt-in。
- `list`——列出所有 job（active + stopped + terminal）。
- `show <job_id>`——显示一个 job。
- `status <job_id>`——显示 job 与最近 evaluation history（最后 20 项）。
- `stop <job_id> [--reason <text>]`——操作员停止；scheduler 此后跳过该 job。

History 只记录显著 evaluation：`sent`（已执行 delivery）或 `terminal`（policy 声明 job 完成）。
quiet skip reason（`not_due`、`no_actionable_artifacts`、`no_missing_edge_artifacts`、
`active_wake_not_due`）不记录——与 POC 保持 parity，使 agent 不会因 scheduler poll 被唤醒。只有
policy 返回非 quiet reason 时才记录显著 `skipped` row。

阶段 D 将 policy enum 扩展为包含 `workflow-keepalive`（阶段 C 延后的 policy）。它通过 SQLite 直接
读取 `workflow_instances`，要求 `status: active|waiting`，并从 `queue_items` 解析 frontier qitem owner。

## Workflow Runtime（PL-004 阶段 D）

`rig workflow` 操作 daemon 原生 Workflow Runtime：声明式 spec 校验、instance 创建、step projection
（transactional-scribe）、trace 与幂等 continue。Workflow spec 是磁盘上的 markdown/YAML 文件
（workspace surface）；daemon 将其 cache 到 SQLite 以便快速查询。

### `rig workflow`

- `validate <specPath>`——校验 workflow spec 文件；返回结构化 ok/error report（role resolution、
  step uniqueness、allowed-exits consistency、可选 seat liveness）。仅限 spec：不接受 rig context
  （OPR.0.4.6.FAC1 架构裁定——rig coverage check 在 instantiate 时执行）。
- `compile <missionPath> [--operation-key <key>]`——将 `project.yaml` → `mission.yaml` → `slice.yaml`
  读取为可检查 lifecycle graph，不创建 cached spec、workflow instance 或 qitem。
- `instantiate-lifecycle <missionPath> --operation-key <key> --root-objective <text> --created-by <session>`——
  compile 并启动 eligible lifecycle；`--entry-owner` 与 `--rig` 保持普通 workflow 含义。opaque operation
  key 使精确 replay 幂等，冲突复用会拒绝。
- `instantiate <specPath> --root-objective <text> --created-by <session>`——在同一 daemon transaction
  中创建新 instance + entry-step qitem；`--entry-owner <session>` 覆盖默认 entry owner。
  **OPR.0.4.6.FAC1**：`--rig <name>` 将 instance 绑定到 rig（覆盖 spec 的 `target.rig` 默认值；
  持久化为 instance 上的 `boundRig`，由 `show`/`trace` 渲染并进入 `--json`）。在 bound instance 上，
  不含 `preferred_targets` 的 role 通过纯 capability policy 解析到该 rig 上 live capable seat
  （声明 role 的 running agent、只限 managed seat、所需 runtime、最少 pending backlog、确定性
  coordinate tie-break）。unknown rig = 结构化 `bound_rig_unknown`；bound-rig role 没有 seat 在结构上
  声明 = `bound_rig_role_uncovered`（任意 lifecycle state 下存在即可满足；step projection 时检查
  liveness）。无 `--rig` 且 spec 无默认值 = unbound，与 FAC-1 前行为字节级一致。
- `run <specPath> …`——接受相同 `--rig <name>` binding（run 同样执行 instantiate）。
- `project --instance <id> --current-packet <qitem-id> --exit <handoff|waiting|done|failed> --actor-session <session>`——
  在同一 daemon transaction 内关闭 current packet 并投影 next-step packet（transactional-scribe；
  按设计不可能丢失 handoff）。`--result-note <text>`、`--blocked-on <ref>`、
  `--next-owner <session>` 可改变行为。
- `list [--status <s>]`——列出 instance；可按 status（`active`/`waiting`/`completed`/`failed`）过滤。
- `show <instanceId>`——显示一个 instance。
- `revise <instanceId>`——只读检查 authored 与 bound lifecycle input，不写入。结果点名 changed
  source/step、composition、compatibility，以及包含已检查 version、digest 与 operation key 的 apply
  命令。使用 `--apply` 前填写 actor 与 decision。
- `operation <key>`——在 response 丢失或之后 source edit 后，恢复原 lifecycle creation/revision
  receipt 与当前 instance。
- `trace <instanceId>`——显示 instance 及其仅追加 step trail（仅 audit）。
- `continue <instanceId>`——幂等 inspector；v1 返回当前 state。

owner-as-author + workflow-as-transactional-scribe 契约由 daemon 强制。packet owner 决定何时关闭；
workflow runtime 在单个 daemon transaction 中，根据 workflow spec 原子记录 closure 并创建/投影
下一个 qitem。

### Project-owned release profile

`project.lifecycle.profile` 选择 `project.lifecycle.profiles` 中的 key。每个 selected entry 包含
`required_steps`（稳定 obligation ID 的非空列表）与 `workflow`（普通 workflow language）。可复用示例
[`project-release-profile.yaml`](../reference/project-release-profile.yaml) 定义九个 release ceremony
stage，随后是一个 `release-boundary` judgment。最终 judgment 以一个 agent-authored record 覆盖规范
[`release-boundary.md`](../reference/release-boundary.md) checklist 的七个区域；它不会创建七个自动 gate。

在 `project.yaml` 中放置 profile 一次；release mission 只需普通 composition。按项目需要定制示例中的
project ID、role 与 policy。每个 profile step 都声明 `depends_on`（root 也要声明 `[]`）；拒绝
conditional `next_hop.on` jump，避免绕过 required stage。缺少 required ID 时以
`lifecycle_required_step_missing` 拒绝。prerequisite cycle 会使 compilation 以 `dependency_cycle`
变为 ineligible，即使已设置 `loop_guards.max_hops`。该 guard 只约束 routing loop，不能让互相依赖的
step 变为 ready。

优先级明确如下：

- 有已选择的 project graph 且 mission 没有 workflow 时，mission 继承它。
- `mission.lifecycle: {profile: <same-profile>, mode: extend, workflow: ...}` 添加新 step、按 name
  merge role，并追加 context reference。extension 不能替换 step ID；其 workflow 只接受 `steps`、
  `roles` 与 `context_refs`。
- `mode: override` 提供替代 workflow。必须保留所有 required project step ID 及其 prerequisite
  关系；允许增加中间 stage。存在竞争 workflow 时，省略 mode 或使用 unknown mode 会以
  `lifecycle_override_ambiguous` 拒绝。
- 没有 `project.lifecycle.profiles` 时，现有 mission-authored workflow 优先于 slice execution
  declaration。此 legacy path 保持支持，并提示未选择 project graph。向已 copy mission workflow
  添加 project graph 时，必须显式选择 mode 或删除该 copy。项目 lifecycle 字段中的 inert `workflow`
  或 `workflow_ref` 会被拒绝，而非静默忽略。

已编写且 ready 的 successor 可以是依赖 `release-boundary` 的 mission extension step。没有该
extension 时，`release-boundary` 以 `done` 退出并完成当前 lifecycle。runtime 创建 continuation
packet；agent 判断 readiness 并执行任何已授权 activation。它不会从 folder 推断 readiness，也不会
自动激活未来 scope。

Compilation 暴露 `graphSource`（selection mode、project/mission address、required ID）、完整
`workflowSpec`、dependency 与 source digest。这些内容进入 compiled input digest，并在 instantiate
时持久化。在已有 operation key 下改变 source byte 会被拒绝。传给 CLI `compile` 与
`instantiate-lifecycle` 的相对 path 都会在 HTTP 前依据 **caller cwd** 解析，因此 daemon cwd 不会
改变其含义。

`workflow guidance <instance> [--packet <qitem>] [--component <id>] [--full]` 读取当前选定 SDLC
teaching 与原始 SPEC intent。`workflow show` 与 `workflow continue` 暴露相同 guidance。entry、handoff、
route 与 resume packet 携带 compact preview；已有 admitted wait notice 在 send 时刷新它。健康 waiting
不会在每次 tick 都读取或注入 catalog。

Selection 遵循 project → mission → 显式 active slice（或 legacy slice 的准确 executable identity）。
更窄 component list 会替换 ancestor component 与 edge；省略 catalog 则继承。仅有 bound member list
不会选择 active slice。Catalog address 使用共享 H2/H3 resolver：绝对路径或 `$OPENRIG_HOME` path、
相对于声明 manifest 的 path、该 manifest Git tree 中的 `root: repository`，或 installed context
library 声明的文件。缺失/有歧义 component 与 unavailable source 会作为具名 unknown；prose 原样
保留，且没有必需 semantic field ontology。

Compact guidance 预览一个 component，尽可能使用准确 owner match；否则标为 menu preview。position
保持 unknown：array order、clock 或 handoff 都不会推断 method progress。`--full` 展开与 current packet
custody 相关的 component（无匹配时为所有 selected component）；`--component` 显式选择一个。完整
oversized prose block 会被省略并附 expansion notice，避免截断 caveat 冒充完整 teaching。

Guidance 报告 lifecycle binding 对应的 manifest hash 与当前 catalog hash。引用 prose 是当前 authored
advice，不是 cached executable snapshot。YAML selection edit 使用现有 revision 路径；仅 catalog prose
变化会在读取时刷新，不创建 work 或新 revision store。读取 advice、收到 notice 与独立 acceptance
保持为不同事实。

`workflow show`、只读 `workflow revise` 与 TUI execution view 区分 current、source-only、compatible、
incompatible 与 unavailable authored comparison。Catalog 或 membership byte 可在 executable step 不变
时发生变化；文件 edit 不会静默采纳任一类变化。受支持的 `revise --apply` 在同一 instance 上保留
completed/live step、required obligation、queue custody 与此前 receipt，同时采纳 future-step change。
它要求已检查的 version/digest、稳定 operation key、actor 与 reason。已完成/live step 变化、删除
obligation 与不支持的 migration 都以具体说明拒绝；请恢复受保护 contract，并 revise 尚未启动的
successor。response 有歧义后，检查 `workflow operation <key>` 或重试完全相同的 apply 命令，以恢复
其唯一已提交 effect。

Mission-bound continuation 与 wait guidance 携带 authored planning、wave admission/review 与
integration rule 的 snapshot，并提供指针供决策前检查当前 source。wave 指导 agent；executable
dependency 调度 step。bound slice source 不会自动创建 child workflow。execution view 也将当前
arrangement guidance 读入 `planning_guidance`，并保留准确 source field。普通 mission/wave/slice
inspection 会区分 admission、review、accepted-core/full-contract guidance 与 executable edge、
attributed proof、current custody；prose 不会创造这些事实。

`workflow show`/JSON 与 TUI execution view 显示每个具名 obligation 的 state 与 receipt state。
required step 在成功的 `done`/`handoff` exit 上要求 `project --evidence-ref <ref>`；缺失 reference 会在
mutation 前以 `lifecycle_receipt_required` 拒绝。waiting 与 failed exit 保持可用。projection 记录谁在
何时提供 reference。`recorded` 表示存在 attributed workflow receipt，不表示 daemon 已验证其内容。
普通 terminal queue row 永远不会提供该 receipt。agent 会检查实际 evidence，包括经过论证的
not-applicable 或 deferred boundary area。已有 typed `acceptance` contract 保持独立，继续执行自身检查。

### 已编写的 mission boundary（旧版）

没有 project-owned graph 时，若 mission 声明 `lifecycle.workflow`，`compile` 会使用该显式 workflow，
而不是从 active slice 派生 step。仍会校验 slice membership 与 backlink，并纳入 provenance；slice SDLC
selection 不会增加 workflow step 或 gate。`lifecycle.profile` 必须匹配 `project.yaml` 中选择的 profile：

```yaml
# 添加到 mission.yaml；project.yaml 已选择 release-boundary-v0。
lifecycle:
  profile: release-boundary-v0
  workflow:
    context_refs: [SPEC.md, PROGRESS.md, NOTES.md]
    entry: {role: orchestrator}
    roles:
      orchestrator: {preferred_targets: [orch@my-rig]}
    steps:
      - id: mission-boundary
        actor_role: orchestrator
        objective: Inspect current evidence and decide the next authored exit.
        allowed_exits: [waiting, done, failed]
        re_present_after_seconds: 300
        re_present_max_seconds: 3600
```

嵌套 `workflow` 使用普通 workflow language；其 ID 默认为 `lifecycle-<project>-<mission>`，compiled
version 从 source digest 派生。显式允许 `waiting` 的 boundary step 默认使用五分钟 initial reminder
与一小时 cap；示例中的两个字段覆盖默认值。operation identity 缺失会令 compilation ineligible。
以一个 opaque `--operation-key` instantiate 时，会持久化 compiled input digest 与 lifecycle binding；
完全相同的 replay 返回同一 instance/entry packet，该 key 下变化的 input 会被拒绝。单纯 authoring
永远不会启动 instance。

`context_refs` 在 entry、successor、route/resume 与 reminder packet 中携带 address。lifecycle compiler
还包含 project/mission manifest 与 `project.install.context`。相对 project reference 从 project root
解析；profile workflow reference 从 project root 解析，mission workflow reference 从 mission directory
解析。reference 不是 evidence verdict：接收 agent 打开 current context，也可检查其外内容，并自行选择
exit。daemon 既不解释 receipt，也不激活 mission。`rigx project` 仍是独立 manual shadow。

在 mission-boundary compilation 之外，只有 `re_present_after_seconds` 的 unmapped `waiting` exit
保持 one-shot。增加 `re_present_max_seconds` 会 opt-in 已有 queue/watchdog timer，使其以 exponential
backoff 重复：示例依次等待 5、10、20、40、60 分钟。cap 必须是至少与 initial delay 一样大的整数。
不创建新 packet。重复 waiting acknowledgment 保留 schedule；结构化 `closureEvidence` 变化或新
blocker 会重置。`rig workflow project --evidence-ref <ref>` 将 attributed reference 记录为 closure
evidence，不解释内容，也不替代 typed acceptance。省略 evidence 会保留此前 evidence，object key
顺序不影响结果。

准确 qitem blocker 上的 transition 会使 reminder 在下一次 scheduler tick（通常一秒内）到期，并重置
initial delay。Wake delivery receipt 不算 progress。workflow 自身 waiting acknowledgment 位于其
frontier packet 上，而非上游 blocker；重复 wait 不能把自身设为 blocker。Blocker completion 保留
原生 queue unpark/wake 行为。terminal 或已 reroute packet 会退役 timer。restart 会对账 blocker
transition identity 并恢复持久 delay；replay 同一 transition 不会创建另一 wake。live repeating timer
可以有未消费 wake：二者是 park status 中的不同事实。hard human gate 使用已有 `gate` 字段编写；
reminder 不会制造 gate 或满足 gate。

## 操作检查

用于 compaction planning、workflow heartbeat 与 seat handover observability 的只读检查命令。本节
默认均为只读模式。

### `rig compact-plan`

用法：`rig compact-plan [--rig <name>] [--refresh] [--threshold-tokens <n>] [--threshold-percent <0-100>] [--json]`

说明：

- 规划 Claude compact-in-place candidate，但不执行 compact（只读 triage）。
- `--threshold-tokens <n>` 是估算 used-token threshold；context window size 缺失时，
  `--threshold-percent <0-100>` 是 used-percent threshold。
- 输出根据当前 heuristic 标识 compaction candidate seat；是否 compact 由操作员决定。

### `rig heartbeat`

用法：`rig heartbeat [--rig <name>] [--nudge] [--include-done] [--json]`

说明：

- 从 queue 文件显示 workflow execution proof state。
- 默认只读。`--nudge` 向 stalled 或 unproven owner 发送信息型 proof instruction；不会修改 queue
  文件或 reroute work。
- `--include-done` 在输出中包含 done/handed-off queue item（默认排除）。

### `rig seat`

用法：`rig seat <subcommand>`

子命令：

- `status <seat> [options]`——显示只读 seat handover observability status。
- `handover <seat> [options]`——规划安全的 two-phase seat handover。
- `launch <seat> --fresh --reason <text> [--stop] [--operator <address>] [--json]`——为恰好一个
  已有 seat 创建有意 blank occupant。不使用 continuity source；live managed occupant 要求 `--stop`，
  adopted 或 unmanaged ambiguity 会被拒绝。
- `clear-attention <session> [--reason <text>] [--json]`——evidence-gated、operator-attested、已审计地
  对账卡住的 `attention_required` seat。

说明：

- `status` 读取 seat-handover observability table（migration `021`），不改变任何内容。
- `handover` 规划 two-phase sequence；实际执行通过现有 seat-launch surface 并受 operator gate 控制。
- `clear-attention`（v0.3.4）使用已捕获 evidence 清除卡住的 `attention_required` startup status；
  `--reason <text>` 是跳过 evidence gate 的 operator attestation override（已审计）。它取代 SQLite
  手工编辑 workaround。

## Mission Control / Queue Observability（PL-005 阶段 A）

Mission Control 是现有 shell 内的集成产品 UI，**不是**新的 `rig` 命令。PL-005 原本将只读 node
界面命名为 `rig ps --nodes --json`；在 v0.4.4 disclosure ladder 下，fleet-wide projected node source
为 `rig ps --nodes -A --json`。

Mission Control 通过产品 UI 的 `/mission-control` 路由访问。HTTP API 界面（`/api/mission-control/*`）
记录在 `docs/as-built/architecture/mission-control.md`。七个 verb（`approve`、`deny`、`route`、
`annotate`、`hold`、`drop`、`handoff`）通过 `POST /api/mission-control/action` 执行；七个 view
通过 `GET /api/mission-control/views/:view-name` 读取。

在首选规范 CLI source 时，Mission Control 消费 `rig ps --nodes -A --json` 进行 fleet rollup。
跨 CLI version drift 按 PRD § Runtime/Source Drift Acceptance 的四个子条款处理：缺失字段显示为诚实的
"field unavailable on this rig's daemon version" placeholder；每 session 每 rig 只记录一次，避免 spam；
fleet view 显示顶层 "rigs running stale CLI" indicator。

## Agent Image、Context Pack 与 Workspace（v0.3.0）

v0.3.0 发布三个顶层命令，用于操作员编写的 library content（agent image 与 context pack）和
workspace primitive。

### `rig agent-image`

用法：`rig agent-image <subcommand>`——浏览、snapshot 并管理 agent image（PL-016）。

子命令：

- `list [options]`——列出 library 中所有 agent image。
- `show <name-or-id> [options]`——显示 image manifest + statistics。
- `preview <name-or-id> [options]`——显示 manifest + 已计算大小的 supplementary file metadata +
  starter snippet。
- `create <source-session> [options]`——将 productive seat 的 resumable state 捕获到新 agent image。
- `delete <name-or-id> [options]`——删除 agent image（受 evidence-preservation guard 约束）。
- `pin <name-or-id> [options]`——pin image，使 prune 无法删除。
- `unpin <name-or-id> [options]`——unpin image。
- `prune [options]`——删除可 evict image（受 evidence-preservation guard 保护）。
- `sync [options]`——重新遍历 discovery root 并刷新 library index。

说明：

- image 是操作员编写的 library 形式；删除受 evidence-preservation guard 控制，避免意外丢失
  productive seat snapshot。
- `pin` / `unpin` 是显式 retention 的操作员控制；`prune` 遵循它们。

### `rig context`

用法：`rig context <subcommand>`——浏览、预览、组合与管理操作员编写的 context pack。此 noun
绝不执行 delivery；delivery 属于 `send`、`broadcast`、`walk` 与 `queue create`。

子命令：

- `work-install [--project <id>] [--mission <id>] [--slice <id>] [--deliver] [--runtime <claude-code|claude|codex>] [--cwd <agent-working-directory>] [--topology <ids>] [--apply-skills] [--json]`——
  在一个 plan 中解析 project/mission/slice Markdown 与 `project.yaml install.skills`。带 `--runtime`
  时，组合 system、topology 与 project selector，并报告 per-skill provenance/status；`--apply-skills`
  将 owned harness projection 安全对账到 `--cwd`（默认为 caller current working directory），而非
  workspace metadata directory。省略 `--runtime` 时，无论 `OPENRIG_RUNTIME` 如何都跳过 skill
  inspection；应用 skill 要求显式 runtime。
- `profile <name-or-ref> --situation <fresh|handover|post-compaction> [--runtime <claude-code|claude|codex>] [--profile <id>] [--budget <tokens>] [--rig <rig> --seat <seat>] [--mission <mission>] [--slice <slice>] [--json]`——
  组合所选 atom graph 与显式授予的 context。runtime 默认取 `OPENRIG_RUNTIME`，否则为 Claude；
  未知非空环境变量值会 warning 并 fallback Claude。显式 flag 覆盖环境。
- `list [options]`——列出 library 中所有 context pack。
- `show <name-or-ref> [options]`——显示 pack manifest + per-file metadata。
- `preview <name-or-ref> [options]`——显示组装后的 bundle，不进行 delivery。
- `compose --out <ref> --from <files...>`——把有序文件组合为持久 context ref，不进行 delivery。
- `sync [options]`——重新遍历 discovery root 并刷新 library index。
- `add <source> [--git] [--checkout] [--pack <relative-path>] [--name <ref>] [--json]`——安装
  directory/manifest URL，或使用 `--git` clone Git repo。Git discovery 检查 repository-root manifest
  与 `.openrig/context-packs`；多个 pack 要求显式 `--pack`。`--checkout` 选择已有本地 checkout，
  update 可以 merge 其 branch。
- `source inspect <ref> [--json]`——区分 selected revision/digest、current served edit、checkout
  branch/revision/status/conflict 与本地已知 upstream divergence。不 fetch，也不证明 consumption。
- `source update <ref> [--json]`——显式 fetch 并 merge selected checkout branch 的 upstream，随后
  发布其干净、已声明的 pack input。dirty checkout 或 edited served selection 会在 update 前停止。
  conflict/unavailable upstream 会保留旧 served selection 与 Git 两侧。
- `rm <ref> [options]`——按 path-like ref 删除 context pack。

说明：

- Context pack 是操作员编写的 context bundle（manifest + file），用于以连贯 starting context
  prime managed seat。
- `profile` 与 `work-install` 均接受 `claude-code`、其 alias `claude` 以及 `codex`。无效显式值会在
  CLI 参数解析期间、context lookup 或 projection 前失败。JSON metadata 保留 consumer 现有 key：
  `profile.runtime` 为 `claude` 或 `codex`；`skillProjection.runtime` 为 `claude-code` 或 `codex`。
  两种 Claude 拼写在各命令内产生相同 selection 与 metadata；manifest runtime key 不变。
- 例如，`rig context profile world-public --situation fresh --runtime claude-code` 与
  `rig context work-install --runtime claude-code` 使用相同 runtime 拼写。读取 seat context 的 profile
  atom 仍要求同时提供 `--rig` 与 `--seat`。
- `preview` 是检查已组装内容的规范只读方式。
- 此 command family 不执行 delivery；context-window inspection 不属于该 noun。

Git source 示例（使用预期 instance 与已有 Git credential）：

```bash
rig context add <repository-path-or-URL> --git --name team-world
rig context source inspect team-world --json
# 使用普通 Git 在报告的 checkout 中编辑/commit。
rig context source update team-world --json
rig context get team-world
```

Git selection 只将 `manifest.yaml` 及其声明文件 copy 到现有 context library；
`.openrig-git-source.json` 记录保留的 checkout、pack、revision、selection time 与 digest。checkout 与
此前 selection 位于 configured library 旁的 `<context.root>-git-checkouts` 与
`<context.root>-git-history`；删除 selected pack 时仍保留。local-only inspection 与 cached upstream
ref 比较；只有显式 update 才联系远端。Git 使用已有 credential，禁用 terminal prompt，并设 60 秒
command timeout；失败时保留 checkout，供 native Git diagnosis。

更新前先在 checkout 中 commit 本地改进。若有人直接编辑 served copy，请在 checkout 中保留并 commit
这些 edit；重试前显式将 served copy 恢复到其 recorded selection。不执行自动 stash、reset、rebase、
push 或 conflict strategy。merge conflict 会留在 checkout 中，由 owning author resolve/commit 或 abort。
之后再重试 update。selected byte、成功的 `context get` 与 consumer 可证明地使用它们是不同事实。
此命令不会在其他 instance 中自动 adopt context，也不证明 agent 已消费它。

### `rig workspace`

用法：`rig workspace <subcommand>`——Workspace Primitive（PL-007），v0 typed-kind tooling。

子命令：

- `validate [root] [--kind <kind>] [--no-recursive] [--require-frontmatter] [--max-files <n>] [--json]`——
  遍历 workspace root，解析每个 `.md` 文件的 YAML frontmatter，并发出结构化 gap report。仅 advisory——
  绝不修改文件。默认 root：`cwd`。`--kind` 根据特定 workspace kind（`user | project | knowledge |
  lab | delivery`）校验。`--max-files`（默认 `10000`）硬限制遍历；v0.3.2 slice-01 GA 对该 flag
  强制 strict-int regex。
- `doctor [--workspace <path>] [--strict] [--json]`——针对 daemon 已解析 workspace 运行八项
  workspace-readiness 诊断（workspace root、missions folder、file allowlist、daemon alignment、daemon
  reload、可选 slice doc、当前 `NOTES.md` 或可读 legacy note，以及 SDLC convention section）。只读。
  默认 exit code 只在 `fail` 时非零；`--strict` 让 warn 或 fail 均为非零。

说明：

- v0 界面有意保持狭窄（只有 `validate`）；v0.3.2 增加 `doctor`，作为面向操作员的 readiness
  diagnostic。
- 未来版本会在同一 root walker 上增加 typed-kind authoring/refactor tooling。
- 使用 `rig config init-workspace` scaffold 新默认 workspace。

## Plugin 检查（v0.3.1）

v0.3.1 增加一个只读顶层命令，用于检查从 `$OPENRIG_HOME/plugins/`（默认
`~/.openrig/plugins/`）发现的 plugin。v0 没有 `install` verb——安装由操作员根据各 plugin
source tree 中的 `OPENRIG-INSTALL.md` 显式 copy 或 symlink。

### `rig plugin`

用法：`rig plugin <subcommand>`——只读 plugin inspection。

子命令：

- `list [options]`——列出可发现 plugin（跨 vendored + runtime cache 聚合）。
- `show <id> [options]`——显示 plugin manifest + skill + hook + mcp server。
- `used-by <id> [options]`——列出在 `profile.uses.plugins[]` 中引用此 plugin 的 agent。
- `validate <path> [options]`——根据 agentskills.io spec 校验 plugin manifest + skill frontmatter。

说明：

- Plugin discovery 聚合 `$OPENRIG_HOME/plugins/`（由操作员在 runtime vendor）与 daemon bundled
  plugin cache。
- `openrig-core` 随 daemon bundled（11 个 skill）。其他 plugin（`gstack`——45 个 skill；
  `obra-superpowers`——14 个 skill）作为 substrate reference 提供，供 plugin author 按各 plugin
  source tree 中的 `OPENRIG-INSTALL.md` workflow copy-install。
- 一等 `rig plugin install <substrate-path>` verb 延后到 0.3.2。

## Scope Tree Primitive（v0.3.2）

一个于 v0.3.2 首次发布的顶层命令（`scopeCommand`，`packages/cli/src/index.ts:20,187`；定义于
`packages/cli/src/commands/scope.ts`；release-0.3.2 slice 12）。它根据
`conventions/scope-and-versioning` 操作 scope tree（mission、slice、sub-slice）。

### `rig scope`

用法：`rig scope <subcommand>`——scope tree primitive：mission、slice、sub-slice。

顶层 option：

- `--workspace <path>`——覆盖 workspace root（否则使用 typed `workspace.slices_root` 设置；
  `$OPENRIG_WORK_ROOT` 仍作为 legacy override）。

两个子命令组：`slice` 与 `mission`。

`rig scope slice <subcommand>`——slice 级命令：

- `ls [--mission <name>] [--state <state>] [--json]`——列出 mission 中（或所有 mission 中）的 slice。
  `--state` filter：`active | closed | shipped | all`（默认 `active`）。
- `show <slice-path> [--mission <name>] [--json]`——检查单个 slice（frontmatter + README + child）。
  `slice-path` 可以是绝对路径、相对于 substrate 的路径或 `NN-slug`；path 只有 `NN-slug` 时，
  `--mission` 提供 mission hint。
- `create <mission> <slug> [--template <kind>] [--title <text>] [--intent <text>] [--depends-on <dot-id...>] [--json]`——
  创建 mode-neutral slice scaffold：一个带 intent 与三个 convention section 的 `SPEC.md`、
  `PROGRESS.md`、`PROOF.md` 及 `proof/`。`depends_on` 接受同 mission sibling slice dot-ID，属于
  advisory build-order data。每种 template kind 都发出相同 file set；mode richness 通过 template
  seam 组合。
- `progress <slice-path> [--mission <name>] [--status <state>] [--milestone <text>] [--owner <session>] [--note <text>] [--json]`——
  **v0.4.0（slice 33）**新增 verb：确定性 append/set/update progress entry。写入 OpenRig PROGRESS UI
  页读取的规范结构。取代手工编辑 `PROGRESS.md`。
- `stage <slice-path> <new-stage> [--mission <name>] [--successor <id>] [--json]`——
  **v0.4.0（slice 35）**新增 verb：确定性设置 slice 的 `stage` frontmatter
  （wip / provisional / established / canonical / superseded / retired）。`superseded` 要求
  `--successor <id>`（否则拒绝并记录 successor）；`retired` warning 为 "do not use"；无效 stage
  被拒绝，并点名有效集合。
- `verified <slice-path> --against "<source>" [--mission <name>] [--json]`——
  **v0.4.0（slice 35）**新增 verb：将 slice 的 `verified` 行标记为
  `verified: <today> against <source>`。`--against` 必需（拒绝裸 timestamp——按
  `conventions/scope-and-versioning` §2，它是防陈旧关键点）。覆盖此前 verified 行。
- `reconcile <slice-path> [--mission <name>] [--json]`——**v0.4.0（slice 35）**新增 verb：幂等修复。
  补齐缺失 `PROGRESS.md`，使必需 frontmatter（`id` / `stage` / `verified`）符合规范，并修复
  id-registration ghost（`id:null` / doubled-prefix）。可安全重跑。
- `ship <slice-path> <release-mission> [--mission <name>] [--json]`——将 slice ship 到 release mission
  （保留 git history）。
- `close <slice-path> [--note <text>] [--mission <name>] [--json]`——关闭 slice（移动到
  `<mission>/closed/`，更新 status）。`--note` 是可选 closure note。
- `move <slice-path> <dest-mission> [--mission <name>] [--json]`——在 mission 间移动 slice
  （在 destination 中重新编号）。

`rig scope mission <subcommand>`——mission 级命令：

- `ls [--json]`——列出 mission（含 `README.md` 的顶层 folder）。
- `show <mission> [--json]`——检查单个 mission。
- `create <name> [--template <kind>] [--id <dot-id>] [--title <text>] [--intent <text>] [--depends-on <dot-id...>] [--no-notes] [--json]`——
  创建包含带 intent 的 `SPEC.md`、`NOTES.md`、`PROGRESS.md` 与 `slices/` 的 mission。`depends_on`
  接受同 project sibling mission dot-ID，属于 advisory build-order data。`--no-mission-notes` 保持为
  `--no-notes` 的 deprecated alias；旧 notes-template 环境变量仍可读取，并附 advisory。
- `graph <mission> [--json]`——显示 slice dependency node、当前 ready/waiting set，以及 malformed、
  cross-parent 或 absent dependency 的 advisory。stale edge 永远不会阻塞或使 reader 崩溃。
- `progress <mission> [--status <state>] [--milestone <text>] [--owner <session>] [--note <text>] [--json]`——
  **v0.4.0（slice 33）**新增 verb：在 mission `PROGRESS.md` 上确定性 append/set/update progress
  entry。按构造符合 UI。
- `stage <mission> <new-stage> [--successor <id>] [--json]`——**v0.4.0（slice 35）**新增 verb：
  确定性设置 mission 的 `stage` frontmatter。enum 与 superseded 时要求 `--successor` 的规则和
  slice 变体相同。
- `verified <mission> --against "<source>" [--json]`——**v0.4.0（slice 35）**新增 verb：标记
  mission 的 `verified` 行。`--against` 必需。
- `reconcile <mission> [--json]`——**v0.4.0（slice 35）**新增 verb：幂等 mission 级修复
  （补齐 `PROGRESS.md`、规范化 frontmatter、修复 ghost）。

Convention compliance：`rig scope` 加上 slice 33（`PROGRESS.md` + scaffolding）与 slice 35
（`stage` / `verified` / `reconcile`），使 `rig scope` 成为 `conventions/scope-and-versioning` 的
**确定性 enforcer**（§1 dot-ID、§2 maturity vocabulary）。agent 通过命令更新 convention，而不是
手工编辑 markdown。

### SDLC control plane verb（v0.4.4）

这些 verb 所操作的 convention 位于唯一随附文档 `docs/reference/sdlc-conventions.md`
（复制进组装后的 CLI package）；操作流程是 packaged `mission-slice-sop` skill。

- `rig scope slice|mission approve <target> [--scope spec|delivery] [--actor <session>] [--on-behalf-of <human>] [--json]`——
  两个 staged-approval lock，共用一个 daemon 侧 write path。`--scope spec` 对 node 的 `SPEC.md`
  加 plan lock；`--scope delivery`（默认）是 terminal sign-off。Approval 是 freeze/sign-off，绝不是
  proven-green。
- `rig proof add <slice-path> --artifact-type <guard|qa|rev1-r1|rev1-r2|adjudication> --verdict <CLEAR|BLOCKING|CONCERNING|PASS|NOT-CLEAR> --candidate-sha <sha> --money-evidence "<line>" [--file <path>|--body <text>] [--evidences <refs>] [--media <refs>] [--self-check <text>] [--json]`——
  **v0.4.4（slice 19 FR-8；`--media` 来自修正 §3.4）**将带机器可读 C1 header 的 proof artifact
  放入 `<slice>/proof/`，并在写入时校验（使用上述封闭集合）。`--evidences`（item text 或从 1 开始
  的 index）将 drop 关联到 slice 的 `## Proof contract` item——Living Notes DELIVERED section 渲染的
  pairing；`--media`（相对于 proof/ 的 ref，经 containment 检查，绝不为绝对路径）点名该 drop
  支持的 curated media，并投影到 DELIVERED item 的 proof set。Contract/self-check output 属于
  advisory（exit 0），绝不是 gate。
- `rig scope audit <mission> [--json]`——检查 C1 header 与 one-SPEC convention（frontmatter `intent:`
  或可读 legacy Intent section、Mini-requirements、Proof contract 与当前 NOTES）。绝不要求第二份 PRD。
  所有 convention finding 均为 advisory/fail-open。

说明：

- 已在 `51554eee`（v0.4.0 post-slice-35）对照 `packages/cli/src/commands/scope.ts` 验证界面；
  SDLC control-plane verb 在 OPR.0.4.4.23 中对照 `scope.ts` / `proof.ts` / `scope-audit.ts` 验证。

## Skill Cascade Audit（v0.4.0）

v0.4.0 首次发布一个顶层命令（slice 10——skill/knowledge lifecycle curation，受 Hermes 启发）。
定义于 `packages/cli/src/commands/skill.ts`，与 `packages/daemon/src/routes/skills/audit.ts` +
`mirror-drift` detection 的 daemon 侧 audit surface 配合。

### `rig skill`

用法：`rig skill <subcommand>`

子命令：

- `loadout --runtime <claude-code|codex> [--cwd <path>] [--project-root <path>] [--topology <ids>] [--apply] [--json]`——
  检查由 `catalog.yaml` system selector、topology/profile selector 与 `project.yaml install.skills`
  选择的确定性 managed loadout。报告 selector reason、catalog Git revision/content digest、target 与
  current/missing/shadowed/conflicting status。`--apply` 写入准确字节与 ownership manifest，可幂等执行，
  并拒绝覆盖或删除本地已修改/非 owned 内容。
- `audit [--json] [--include-cache] [--severity <level>] [--rig <name>]`——只读审计 skill cascade。
  检测 canonical → product mirror → hub cwd → installed plugin chain 中的 provenance + freshness 问题。

呈现的 audit category：

- **`missing`**——cascade 中某个 skill location 缺少 SKILL.md，但 sibling location 存在；声明
  cascade-relative gap。
- **`stale`**——SKILL.md 存在，但早于 canonical，或 content hash 不匹配。
- **`self-referential`**——SKILL.md provenance pointer 指向自身位置，而非 upstream source。
- **`invalid-date`**——frontmatter `last-verified` / `last-updated` 格式错误或位于未来。
- **`mirror-drift`**——downstream mirror copy 与 canonical 不同，且未记录有意 fork。

说明：

- **只读**：audit 不修改任何 skill 文件。finding 会路由回 lifecycle（curation-steward），以执行
  shaped propagation run。
- **防 false green**：mirror-drift evidence 因任何原因不可用（daemon offline、filesystem 不可访问）
  时，CLI 会发出清晰 `unable-to-audit` outcome，exit code 为 `2`，而非报告 `clean`。这修复了
  v0.3.4 wrap-gate AC-3 几乎发布的失败模式（“通过 `npm run mirror-skills` clean 验证 mirror sync”——
  该 sync 不触及 substrate canonical 或 hub cwd）。
- `--include-cache` 在 audit 中包含 packaged-installer cache copy（默认跳过，因为它们发布后不可变）。
- `--severity <level>` 过滤输出：`info`（默认；全部）、`warn`（只含 stale + mirror-drift）、
  `error`（只含 invalid-date + self-referential）。
- `--rig <name>` 将 audit 限制到单个 rig 的 embedded skill copy。
- `--json` 发出结构化 finding：
  `{cascade: [...locations...], findings: [{category, path, evidence, suggested-action}]}`。
- Exit code：`0` clean，`1` 存在 finding，`2` 无法 audit。

它与现有 `scripts/mirror-skills.mjs` guardrail 组合——audit 检测该脚本也会捕获的内容，另外覆盖脚本
不触及的 canonical / hub cwd 层。

## Operator Context-Mode Binding（v0.3.2）

此顶层命令最初在 v0.3.2 以 `rig policy` 发布（release-0.3.2 slice 09），随后根据 PM 裁定
RULING-rig-mode-rig-policy-naming 在 0.5.2 改名为 `rig mode`（clean rename，无 alias——已确认零
adoption；`rig policy` 将作为 permission-policy verb 重新引入）。定义于 `rigModeCommand`
（`packages/cli/src/commands/rig-mode.ts`）。它与 daemon 的 typed-primitive store
`packages/daemon/src/db/migrations/041_rig_policy.ts` 配合（DB artifact name 保留已发布形式），操作
供 mode-aware agent posture 使用的 operator context-mode binding
（sleep / desk / mobile / away / focus / debug）。

### `rig mode`

用法：`rig mode <subcommand>`

子命令：

- `set <mode> [--scope <scope>] [--qualifier <id>] [--<field> ...] [--evidence <citation>] [--confirm] [--bearer <token>] [--json]`——
  提议 binding。不带 `--confirm` 时，CLI echo 提议的 binding，并以 `exit 2` 退出，防止脚本意外应用；
  `--confirm` 是显式 operator action。`<scope>` 是 `global_host | rig | workstream | qitem` 之一
  （默认为 per-mode recommendation）。`rig | workstream | qitem` scope 要求 `--qualifier <id>`，
  `global_host` 则拒绝它。per-field tuning flag：`--autonomy-scope`、`--heartbeat-cadence`、
  `--inspection-depth`、`--update-detail`、`--escalation-threshold`、`--concurrency-limit`、
  `--permission-prompt-posture`（`normal | batch_for_human | do_not_prompt_unless_blocked` 之一；
  convention 禁止 `auto_accept`）、`--expiry-or-stale-rule`。`--evidence` 携带自由文本 operator
  citation（message id、file pointer、chatroom topic 等）。
- `show [--json]`——列出全部 operator-context-mode binding。
- `effective [--rig <id>] [--workstream <id>] [--qitem <id>] [--json]`——为（rig、workstream、
  qitem）读取 context 解析 effective mode。无匹配 binding 时呈现 `unknown_posture`。
- `cite [--rig <id>] [--workstream <id>] [--qitem <id>]`——为读取 context 中的 effective mode
  发出短 prose citation line（按 convention §Citation Rules）。
- `unset <scope> [qualifier] [--bearer <token>] [--json]`——删除一个 binding（仅 operator）。
- `defaults [--json]`——打印推荐的 per-mode 6×7 field default + default-scope mapping + stale rule。

说明：

- 六种 mode 为 `sleep | desk | mobile | away | focus | debug`。接受裸词调用（`set desk`）；
  `mode:<word>` 是消歧 prefix 形式。
- Restate-and-confirm posture（HG-4）：`set` 在传入 `--confirm` 前只 restate，防止脚本意外应用。
- 对 `global_host` 严格拒绝 `--qualifier`（HG-7 guard finding）：输入
  `--scope global_host --qualifier <id>` 的操作员会收到错误，daemon 不会被联系。CLI 不会静默丢弃
  qualifier。
- operator-edit mutation（`set --confirm`、`unset`）需要 operator bearer token（`--bearer` 或环境
  变量 `OPENRIG_AUTH_BEARER_TOKEN`）。
- 已在 `b13a8e4c7`（0.5.2 rename）对照 `packages/cli/src/commands/rig-mode.ts` 验证界面。

### `rig policy`

用法：`rig policy <subcommand>`——顶层 PERMISSION-POLICY verb，在 context-mode verb 移至
`rig mode` 后于 0.5.2 引入（RULING-rig-mode-rig-policy-naming）。OpenRig 不内置 allow/ask/deny
permission policy——harness 原生 permission 是 control surface。此 verb 负责教学并记录到 RigSpec
（`permission_policy: builtin:<name> | none`）；绝不在 runtime 执行 enforcement。

子命令：

- `list [--json]`——内置 template（`locked | standard | open | yolo`）及保留的有意 `none` 选择，
  每项附带 ref 形式。
- `show <name> [--json]`——显示一个选择：其 ref 形式及记录该值的含义。
- `current --spec <path> [--json]`——rig spec 中记录的 `permission_policy` 值及其分类
  （absent = floor；`none` = deliberate；`builtin:<name>`；自定义相对路径）。
- `apply <name> --spec <path> [--json]`——通过与 `rig setup --policy` 相同的保留注释流程，将选择
  记录到已有 spec（后者仍是 setup-step composition，并非 alias）。新 install 没有 spec；不会写入，
  floor 由缺失状态保持。

## 不存在的命令

以下不是当前顶层 `rig` 命令：

- `rig claim`
- `rig blame`
- `rig replay`

若旧文档或习惯提及它们，请将这些引用视为陈旧内容。
