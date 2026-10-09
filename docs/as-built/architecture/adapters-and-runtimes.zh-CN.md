---
kind: as-built
title: 适配器与运行时 —— Claude/Codex/终端、tmux/cmux、Resume 诚实
status: active
topics: [agent-runtime, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要 runtime-adapter 契约——OpenRig 如何在 tmux 内启动与恢复 Claude Code、
  Codex 或终端 harness、五个适配器方法各自做什么，或后台服务如何诚实评估
  一个 harness 究竟是真恢复还是悄悄全新启动（resume 诚实层）。
siblings: [daemon-core.md, agent-spec-and-startup.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 适配器与运行时

OpenRig 如何驱动各智能体 harness。后台服务从不直接与 Claude Code、Codex 或 shell 对话——它对话的是一个 `RuntimeAdapter`。三个适配器实现同一个五方法契约；一个独立的 resume 诚实层如实（而非乐观地）回答“这个 harness 到底是真恢复了，还是悄悄全新启动了？”这个问题。

> 已对照 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。本模块所有源码**在 `v0.3.0` 即已存在**（对全部 7 个文件执行 `git cat-file -e v0.3.0:<path>` 均存在）——适配器层是核心重启时代的机制，**不是** 0.3.x 新特性；不要反向归时（§10.8 版本归属证伪技术）。

> Drift-fix（范围）——`architecture.md` §5“Runtime adapters”**不含 slice-00 数字漂移**（提议结构 §4.2：“adapter 契约为当前”）。下面的修正是*精度*精化：源码比散文更具体之处，而非陈旧计数修正。每条均内联注释并在 HEAD 重新确认。

## 1. 五方法 RuntimeAdapter 契约

`RuntimeAdapter` 位于 `packages/daemon/src/domain/runtime-adapter.ts:127`（`interface RuntimeAdapter`）。每个适配器声明一个 `readonly runtime` 字符串，并恰好实现五个方法（`runtime-adapter.ts:128–153`）：

| 方法 | 签名（`runtime-adapter.ts`） | 职责 |
|---|---|---|
| `listInstalled` | `(binding)` `:131` | 列出某节点当前已安装/已投影的资源。 |
| `project` | `(plan, binding)` `:134` | 把 `ProjectionPlan` 中的资源投影到运行时的目标位置。 |
| `deliverStartup` | `(files, binding)` `:137` | 把解析好的启动文件交付给运行时。 |
| `launchHarness` | `(binding, opts)` `:147` | 在绑定的 tmux 会话内启动 harness；返回 resume 令牌。 |
| `checkReady` | `(binding)` `:153` | 探测 harness 是否响应并就绪。 |

启动*动作*执行（`slash_command` / `send_text`）明确**不**属于本契约——契约文档注释（`runtime-adapter.ts:121–125`）写明动作归 `StartupOrchestrator`，在 `checkReady()` *之后*执行。orchestrator 的交付拆分见 `agent-spec-and-startup.md`。

### `launchHarness` 的 opts 与 fork 接缝

`launchHarness` 的 opts 为 `{ name: string; resumeToken?: string; forkSource?: ForkSource }`（`runtime-adapter.ts:147–150`）。

> Drift-fix（精度）——`architecture.md` §4 称 `launchHarness(binding, opts: { name, resumeToken? })`。源码多出第三个、互斥的 `forkSource` 字段。依契约文档注释（`runtime-adapter.ts:142–146`），`resumeToken` 与 `forkSource` 互斥——若同时提供，适配器**必须**以明确错误拒绝，不得猜测；`forkSource` 触发 fork，捕获的令牌是 fork 后的**新**令牌，绝不是父令牌。`ForkSource` 见 `runtime-adapter.ts:116`（`kind: "native_id" | "artifact_path" | "name" | "last"`；v1 MVP 仅接受 `native_id`——其余形状在 schema 校验时拒绝，文档注释 `:106–119`）。

### `HarnessLaunchResult` 是带诚实失败臂的判别联合

> Drift-fix（精度）——`architecture.md` §4 称 `HarnessLaunchResult` 是 `{ ok, resumeToken?, resumeType?, error? }`（单一可选字段形状）。源码是**判别联合**（`runtime-adapter.ts:81–86`）：
> `| { ok: true; resumeToken?; resumeType? }`
> `| { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence? }`。
> 失败臂携带类型化的 `recovery` 提示（`HarnessLaunchRecovery = "retry_fresh" | "attention_required"`，`:79`）与可选 `evidence`（最后 N 行 pane 内容，对 `attention_required` 结果流入 `RestoreNodeResult.attentionEvidence`，`:83–86`）。这是诚实失败形状，而非抹平后的可选 `error`。

## 2. 三个适配器

三者都位于 `packages/daemon/src/adapters/` 并实现 `RuntimeAdapter`（架构规则 1：`adapters/` 内零 Hono）。

### ClaudeCodeAdapter（`claude-code-adapter.ts:41`）

- `readonly runtime = "claude-code"`（`:42`）。
- **投影**到 `.claude/` 目标：`guidance_merge` → `<cwd>/CLAUDE.md`（`:127`）；`skill_install` → `<cwd>/.claude/skills/<name>/`（`:71,133`）；subagents → `.claude/agents`，plugins → `.claude/plugins/<id>`，运行时资源 → `.claude/extensions/<id>`，settings 片段合并入 `.claude/settings.local.json`（`:388–400`）。
- **启动**（`:213–215`）：fresh = `claude <permissionMode> --session-id <generatedId> --name <name>`；resume = `claude <permissionMode> --resume <token> --name <name>`；fork = `claude <permissionMode> --resume <parentId> --fork-session --name <seat>`（`:188`）。
  > Drift-fix（精度）——`architecture.md` §5 只说“经 `claude --name <name>` 启动、经 `claude --resume <token>` 恢复”。源码显示 fresh 启动带显式 `--session-id`（立即可得确定性 resume 令牌），且存在 fork 分支。已在 `claude-code-adapter.ts:188,213–215` @HEAD 重新确认。
- **就绪检查**（`checkReady`，`:239`）：验证 tmux 会话存活，捕获 40 行 pane 内容 + pane 命令，委托给 `assessNativeResumeProbe`（§3）；仅当探针 `status === "resumed"` 才就绪。resume 启动校验循环 `verifyResumeLaunch` 最多重试 **16 次**（`:273`），在 `no_conversation_found` 时响亮失败并带 `recovery: "retry_fresh"`（`:284–289`）——无静默 fresh 回退。

### CodexRuntimeAdapter（`codex-runtime-adapter.ts:37`）

- `readonly runtime = "codex"`（`:38`）。
- **投影**到 `.agents/` 目标：`guidance_merge` → `<cwd>/AGENTS.md`（`:139,330`）；`skill_install` → `<cwd>/.agents/skills/<name>/`（`:89,145`）；skills 解析于 `.agents/skills/<id>`（`:377`）。
- **启动/恢复**（`:205,225–226`）：先 fresh 启动再捕获新 thread id；resume = `codex<profileArg> resume<queueStateDirArg> <token>`；fork = `codex<profileArg> fork<queueStateDirArg> <parentId>`（`:205`）。成功返回 `{ ok: true, resumeToken: threadId, resumeType: "codex_id" }`（`:222,245,250`）。
  > Drift-fix（精度）——`architecture.md` §5 称“经 `codex` 启动、经 `codex resume <threadId>` 恢复”。源码确认 `codex resume <token>` 形状（`:226`），并补充 fork 分支与 `resumeType: "codex_id"` 标记。已 @HEAD 重新确认。
- 同时给出 `resumeToken` + `forkSource` 时以明确错误拒绝（`:180–181`）——遵守互斥契约。

### TerminalAdapter（`terminal-adapter.ts:19`）

- `readonly runtime = "terminal"`（`:20`）。
- **所有操作都是 no-op**——“shell 即 harness”（`terminal-adapter.ts:15`）：`project`/`deliverStartup`/`launchHarness` 均为 no-op（`:34`），`checkReady` 在 tmux 会话一存在即立即返回就绪（`:47`）。用于基础设施节点——服务器、日志 tail、构建 watcher。（终端节点不能 fork；runtime-adapter 文档注释注明不支持 fork 的适配器以 runtime-mismatch 错误拒绝，`runtime-adapter.ts:113–115`。）

这三者由 `createDaemon` 第 4 步构造（`startup.ts`；见 `daemon-core.md` §4“启动序列”）。

## 3. Resume 诚实

后台服务不会只因启动命令跑过就假定 harness 已恢复。三个领域文件（`packages/daemon/src/domain/`，均 @v0.3.0 存在）使 resume 评估诚实：

### `native-resume-probe.ts`

`assessNativeResumeProbe(input)`（`native-resume-probe.ts:43`）读取 pane 命令 + pane 内容，返回四种诚实状态之一（`NativeResumeProbeStatus`，`:6`）：

- `resumed` —— 运行时专属指标确认会话已恢复。
- `failed` —— 终端失败（例如 Claude 打印 “No conversation found” → 码 `no_conversation_found`，`:51–57`）。
- `inconclusive` —— 尚不确定（例如 Claude 信任门，码 `trust_gate`，`:65–70`）。
- `attention_required` —— 存活且可恢复，但**需操作者介入**（例如 Claude 恢复选择提示，码 `claude_resume_selection_prompt`，`:58–64`）。这是“操作者必须选择会话”的代理；它*区别于* `inconclusive` 与 `failed`（文档注释 `:3–5`）。

`buildNativeResumeCommand`（`:27`）按运行时构建恢复命令：claude → `claude --resume <token> [--name <name>]`（`:35`）；codex → `codex resume <token>`（`:38`）；其他运行时 → `null`（`:40`）。

这就是架构规则 15 在代码中的体现：失败的 resume 响亮失败；不存在自动 fresh 回退（适配器的 `verifyResumeLaunch` 返回 `ok:false` 并带 `retry_fresh` 恢复提示，从不静默重启）。

### `resume-metadata-refresher.ts`

`ResumeMetadataRefresher`（`resume-metadata-refresher.ts:37`）。启动后 resume 令牌捕获：`refresh(sessions)`（`:62`）跳过已有 `resumeToken` 的会话（`:65`），对已有令牌的 `claude-code` 会话运行 `probeClaudeResume`，返回 `"resumable" | "not_resumable" | "inconclusive"`（`:31,74–75`）——这是在一次性探测 tmux 会话中真实运行恢复命令（`:106–111`），不是对元数据的猜测。

### `codex-thread-id.ts`

Codex thread-id 提取（`codex-thread-id.ts`）。从 `~/.codex/` 下的 Codex *logs* SQLite 数据库读取 thread id：`readCodexThreadIdFromCandidateHomes(...)`（`:22`）→ `readCodexThreadIdFromLogs(...)`（`:49`）→ `resolveCodexLogDbPaths(homeDir)`（`:79`），后者 glob `<homeDir>/.codex/logs_<N>.sqlite`（`:84–89`，正则 `^logs_(\d+)\.sqlite$`）并回退到 `logs_1.sqlite`（`:97`）。使用 `better-sqlite3`（`:5`）。按 harness PID 解析 home 目录（`defaultResolveHomeDirByPid`，`:9`）。

> 精度说明——`architecture.md` §5“Resume honesty”称 codex thread id 来自“Codex SQLite 数据库”。源码更具体：按版本分文件的 Codex *logs* 库 `~/.codex/logs_N.sqlite`。此处精确陈述；已在 `codex-thread-id.ts:79–97` @HEAD 重新确认。

## 4. 相关架构规则（HEAD 处源码核验）

摘自 `architecture.md` §7（已对照内联引用的源码重新确认）：

- **规则 5** —— 在 pod 感知模型中，运行时由成员权威决定。
- **规则 13** —— 就绪检查是带指数退避与可配置超时的重试循环，使用适配器专属探针（Claude TUI 指标、Codex 就绪消息、终端立即就绪）。重新确认：`checkReady` 委托给 `assessNativeResumeProbe`；重试循环在 `claude-code-adapter.ts:273`（16 次）。
- **规则 14** —— 恢复状态锁定：`resumed` / `rebuilt` / `fresh`；`rebuilt` = 由产物组装的新进程。（探针层把 `inconclusive` / `attention_required` 作为诚实的*临时*状态补充，而非结果——见 §3。）
- **规则 15** —— 恢复诚实：失败 resume 响亮失败；无自动 fresh 回退；fresh 启动只能是显式的后续动作。由 §2/§3 在代码中强制（`verifyResumeLaunch` 返回 `ok:false`，从不重启）。

## 另见

- `daemon-core.md` —— `createDaemon` 在何处构造这三个适配器。
- `agent-spec-and-startup.md` —— 调用这些适配器、并在 `checkReady()` 后拥有启动动作执行的 `StartupOrchestrator`。
- `lifecycle-snapshot-restore.md` —— 持久化的 resume 令牌如何流入快照/恢复（resume vs rebuild vs fresh）。
- 源码根：`packages/daemon/src/domain/runtime-adapter.ts`、`packages/daemon/src/adapters/{claude-code-adapter,codex-runtime-adapter,terminal-adapter}.ts`、`packages/daemon/src/domain/{native-resume-probe,resume-metadata-refresher,codex-thread-id}.ts`。
