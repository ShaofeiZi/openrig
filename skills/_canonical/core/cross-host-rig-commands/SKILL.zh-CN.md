---
name: cross-host-rig-commands
description: 用于寻址已注册的远程 zrig 主机、选择其传输方式，或解释跨主机结果。
metadata:
  cli_surfaces_referenced:
    - capture
    - daemon start
    - host list
    - host add
    - host doctor
    - ps
    - send
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - rig-lifecycle
      - topology-mutation-and-seat-management
      - seat-scaling-and-specialization
      - sidecar-operator
      - rig-bundles-and-shareable-artifacts
      - specification-system
      - extension-and-user-workspace
---

# 跨主机工作组命令

使用已注册的主机地址和条目所声明的传输方式。SSH 条目通过单跳 shell 运行远程 CLI；HTTP 条目使用远程后台服务。两条路径的前置条件和命令覆盖范围不同。执行重要操作前，应检查准确命令的帮助信息和目标安装。

## 选择并检查目的地

`zrig host list` 显示已注册主机。`zrig host add --help` 说明注册表写入；`zrig host doctor --help` 说明可达性检查。应检查已配置的 zrig 主目录，不要假定默认使用 `~/.openrig/hosts.yaml`。注册表变更会影响后续路由，因此必须在请求范围内进行。

```yaml
hosts:
  - id: test-vm
    transport: ssh
    target: test-vm.local
    user: example-user
  - id: remote-dev
    transport: http
    url: http://remote-dev.example:7433
    bearer_env: REMOTE_RIG_TOKEN
```

注册表要求提供 hosts 数组、唯一且非空的 ID，以及受支持的 transport。SSH 需要非空 target；user 和 notes 可选。HTTP 需要 URL，并且 bearer_env 与 bearer_file 最多只能提供一个。两者都省略时，表示目标无需 token，这是有效配置。如果配置的 bearer 不可用，应视为权限失败，不能匿名回退。主机 ID 也需要通过保留名称验证；应使用实际验证器给出的错误，不要另造会冲突的别名。

## 指定预期操作

```bash
zrig send dev-worker@example-rig "check the assigned result" --host remote-dev --verify
zrig capture dev-worker@example-rig --host remote-dev
zrig ps --host remote-dev --nodes --json
zrig whoami --host remote-dev
```

这些协作命令根据注册表条目选择 SSH 或 HTTP。一种传输失败时，它们不会静默尝试另一种。带主机限定的目标可能很方便，但针对重要跨主机工作，应使用具体命令确认其解析方式及所有持久主机选择。显式传入 `--host` 更可靠。

队列目的地使用显式 `--host` 或受支持的主机限定目的地；队列写入不会遵循持久的主机选择。CLI 会在路由 envelope 中将主机与规范席位分开。不同 queue 子命令的 flag 不同：应检查各自帮助，不要复制 send 的 flag。只有本地成功消息，并不能证明远端已持久化或已领取。

## 在失败所在层读取错误

| 信号 | 应检查内容 |
|---|---|
| registry-load-failed / unknown-host | 注册表路径、条目和准确目的地 |
| ssh-unreachable | SSH 连接、目标与传输诊断 |
| permission-gate | 已配置的 SSH 或 HTTP 凭据及目标策略 |
| remote-daemon-unreachable | 目标监听器及实际运行的后台服务身份 |
| remote-command-not-found | 远程 CLI 安装与可执行文件查找 |
| remote-command-failed | 远程操作自身的状态与错误 |

准确的结果分类取决于具体路径。HTTP 失败会暴露远程状态/错误；SSH 会区分 shell 传输错误与远程命令错误。不要仅因诊断提出建议就启动或替换远程后台服务；必须先确认目标状态，并确认自己拥有执行该生命周期操作的权限。超时写入可能已经到达目的地；重试前应核对其持久效果。

## 验证与归属

传输成功不等于已验证投递或智能体已消费。SSH 会向远程转发 `--verify`，并返回远程 CLI 结果。HTTP 会保留远程传输判定，并明确报告本地 pane 效果检查没有跨主机运行。应检查该结果以及任务要求的目的地效果；绝不要用“SSH 以零退出”或“HTTP 返回成功”替代实际验证。

跨主机输出会注明主机/目标；JSON envelope 携带 cross_host 元数据。准确的 envelope 会因命令与传输方式而异。向后传递证据时，应保留底层远程结果。

目标的主机后缀用于选择目的地；发送者的来源则标识回复应送往何处。使用渲染后的回复地址，并验证其主机映射。当前 send 会从执行席位上下文推导发送者，而不是相信调用者的 `--from` 声明。跨主机转发时会加入来源主机身份；不要假设本地发送也带有相同后缀。未知身份仍然是未知。

此指南描述已实现的命令路径，不代表你的安装上已经证明了实时远程旅程。Fork、交接及其他生命周期组合需要各自受支持的命令和限定权限；读取远程状态不会赋予执行这些操作的权限。

## 另请参阅

- openrig-user——准确命令参考。
- seat-continuity-and-handover——稳定席位与占用者结果。
