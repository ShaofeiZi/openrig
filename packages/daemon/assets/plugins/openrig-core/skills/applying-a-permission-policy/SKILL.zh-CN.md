---
name: applying-a-permission-policy
description: >-
  当用户要求智能体配置 zrig 命令权限、减少重复的原生审批提示，或应用选定的工作组/席位权限策略时使用。
metadata:
  openrig:
    stage: established
    docs_checked: "2026-09-25"
    verification_status: "验证已安装的 harness 版本和实际生效的设置；规则解析器的结果不等同于原生权限测试。"
---

# 应用权限策略

在运行智能体的 harness 中配置用户所选择的权限。zrig 运行姿态、原生命令规则、沙箱访问权限和启动参数是彼此独立的控制项。命令规则授予执行能力，并不授权智能体自行发明任务、发布工作或修改其他主机。

## 选择预期的作用范围

优先采用用户已明确作出的选择；如果没有，则说明以下选项并询问用户需要哪一种。对于已经授权的常规步骤，不要重复询问。

| 选择 | 智能体配置的内容 |
| --- | --- |
| 保留提示 | 保留当前原生设置，在请求出现时逐次处理。 |
| 记住所选命令 | 为所选命令族或更窄的动词添加原生 allow 规则，其他规则与沙箱设置保持不变。 |
| 更宽松的运行方式 | 说明文件系统和网络暴露范围，只配置用户明确选择的原生模式及兼容的启动设置。 |

**允许整个 `zrig` 命令族会覆盖它的所有动词**，包括生命周期、拓扑/配置变更，以及能够启动其他进程的命令。这不是只读授权。请求范围较窄时，应提供 `zrig ps` 或 `zrig queue list` 等更精确的前缀。不得把用户的选择扩大为任意 shell 执行权限、整个解释器或通用 shell 包装器。兼容旧入口时，可以另外配置 `rig` 或 `openrig`，但不得用兼容需求扩大原本授权范围。

## 代用户应用选择

1. 确认目标席位、可执行文件/版本、启动设置和配置根目录，例如适用的 `HOME`、`CODEX_HOME` 或 `CLAUDE_CONFIG_DIR`。操作方、后台服务和席位使用的值可能不同。写入前解析目标用户/项目实际使用的文件；不要为了让路径一致而修改另一个 home。
2. 读取相关的现有权限规则和托管限制。确认预期范围是单个项目还是该用户的所有会话。不同版本格式不同时，查阅已安装程序的原生帮助和下方官方参考。
3. 准备具体 diff。保留 deny/ask 规则、审批/沙箱姿态、hook、认证、MCP、模型设置和无关值。新增 allow 不得抹掉更严格的规则或托管要求；发现真实冲突时应报告，不能静默绕过。
4. 备份将要修改的文件，只合并已授权的新增项并避免重复。编辑应由智能体执行；手工编辑是一种可选方式，不是必须交给用户完成的工作。无需再次进行对话式授权，即可应用已经选择的范围；原生强制机制仍然有效。
5. 回读 diff 并验证格式。确认当前版本如何加载变更。如果需要新会话，应保存工作，并在用户授权范围内使用受支持的恢复路径；仅写入文件不能证明现有对话已经加载新配置。
6. 在目标对话中连续两次验证一个普通的匹配操作，并确认无关命令没有获得任何匹配规则。使用无害的读取操作，不要用破坏性探针。报告实际生效的设置和仍会出现的提示。仅有解析器匹配结果，不能证明原生行为。

回滚时，只移除本次设置新增的内容，保留此后产生的无关编辑。内置策略规范保持只读；自定义内容应放在用户空间。

## Codex 命令规则

Codex 命令规则可以允许匹配的命令在沙箱外执行，而无需再次提示。其他沙箱和网络设置保持不变。先检查 `codex --version` 和 `codex execpolicy check --help`。参见[官方规则参考](https://learn.chatgpt.com/docs/agent-configuration/rules)。

写入前，根据用户要求的范围选择目标位置：

- **仅此项目：**确认已安装版本支持项目规则，并推导当前会话实际使用的项目/工作树配置根目录与信任状态。当前文档将受信任项目配置层中的 `<repo>/.codex/rules/` 描述为规则目录。只有确认该能力受支持、已启用且目标项目受信任后，才能使用这一层。如果其中任何一点不受支持或未经验证，应报告限制，并保持用户层规则不变；不得静默将项目标记为受信任，也不得用用户全局许可替代。
- **明确要求用户全局生效：**使用目标用户实际 `CODEX_HOME` 下的 `rules/`（通常是 `~/.codex/rules`）。这可能影响使用该 home 的其他项目。TUI 的“记住并允许”动作也会写入用户层规则；不要用它实现仅限项目的请求。

将所选规则合并到目标层的 `.rules` 文件。前缀本身没有项目限制；即使规则位于项目层，也不会限制已允许的 `zrig` 命令能够影响哪些目标：

```python
prefix_rule(pattern = ["zrig"], decision = "allow")
```

需要更窄的访问范围时，使用 `["zrig", "ps"]` 或 `["zrig", "queue", "list"]`，并相应调整示例。对于绝对路径调用，应推导目标席位真实的 `zrig` 可执行文件，并把该准确路径添加为独立前缀；裸命令规则不会匹配绝对路径。绝不能复制另一台机器上的路径。若仍需兼容旧 `rig` 入口，应把它作为单独前缀明确配置和验证。

```sh
codex execpolicy check --pretty --rules /absolute/path/to/openrig.rules -- zrig ps --json
codex execpolicy check --pretty --rules /absolute/path/to/openrig.rules -- printf permission-check
```

检查匹配详情，不要只看退出状态；其他生效文件使用重复的 `--rules` 参数传入。如果存在匹配的 `prompt` 或 `forbidden`，它会覆盖 allow。按要求重新加载后，在目标对话中验证规则是否加载。对于仅限项目的范围，应确认该层在目标项目中处于活动状态，并且不在无关项目的活动层中。显式传入 `--rules` 文件的评估器只能证明匹配结果，不能证明作用范围或自动加载。现有用户全局规则可能已允许同一命令；应保留并披露这些规则、说明匹配来源，不得声称已实现项目隔离，也不得在没有单独授权的情况下删除它们。

独立评估器检查传入的 argv；原生 shell 解析可能先拆分普通命令或命令链。原始 `zsh -lc` 不匹配，并不能证明原生 `zrig && zrig` 也会失败。验证两个表面时，不得将规则扩大到 `bash`、`sh`、`node` 或通用包装器。

## Claude Code 命令规则

检查 `claude --version` 和[官方权限语法](https://code.claude.com/docs/en/permissions)。把所选条目合并到现有 `permissions.allow`；以下片段不是完整替换用的 settings 文件：

```json
{
  "permissions": {
    "allow": ["Bash(zrig *)"]
  }
}
```

当前语法使用 ` *` 表示命令族；`Bash(zrig:*)` 也受支持。更窄的示例包括 `Bash(zrig ps *)` 和 `Bash(zrig queue list *)`。保留 `deny`/`ask` 条目和 `defaultMode`；不要为了消除不匹配而添加 `Bash(*)` 或切换到 bypass。检查原生 `/permissions`，并验证实际命令拼写。需要兼容 `rig` 或 `openrig` 时，应分别添加精确规则。

使用[设置参考](https://code.claude.com/docs/en/settings)选择作用范围：个人项目设置使用 `.claude/settings.local.json`，有意共享的项目设置使用 `.claude/settings.json`，目标 `CLAUDE_CONFIG_DIR` 下的 `settings.json`（通常为 `~/.claude`）用于该目标的用户配置。确认实际项目根目录，尤其是 worktree 场景。不要把个人设置提交到版本库。托管限制及沙箱/网络控制仍然有效；Bash allow 并不是通用网络策略。

## 现有策略与更宽松模式

对于具名策略，应读取其实际 `permission_policy` 规范和 `source` 标记。使用受支持的原生控制来转换预期动作；不要把所有 Codex 策略压缩成同一种姿态，也不要声称 shell 模式能够完美表达强制推送等语义动作。保留更严格的规则。如果无法准确转换，应说明仍需用户选择的内容，而不是自行选择更宽的权限。

如果用户明确选择更宽松的运行方式，请检查 `zrig policy current --spec <user-owned-rig.yaml>`，以及兼容 getting-started 指南中的 **Opt-in permissive operation** 一节。zrig 的 Codex `builtin:yolo` 会提供 `-s danger-full-access`；它本身不会选择 `approval_policy`，并会替换具名的 `codex_config_profile` 参数。Claude 对应的启动参数是 `--dangerously-skip-permissions`。资源中的 `profile: default` 和 zrig 运行姿态都不是原生权限策略。不要修改随附默认值，也不要假定修改启动规范会影响现有席位。

无头席位可能停在原生提示处。应安排答复路径或选择适合的命令规则；无人值守运行不代表默认同意绕过权限。对于 Pi，此前支持的 `--approve`/`--no-approve` 界面涉及项目资源信任，而不是 shell 权限；应验证已安装版本的实际能力，不要把这些参数当作命令 allowlist。
