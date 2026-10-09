# Kernel 工作组文化

kernel 是唯一一个始终运行的工作组，包含三个 pod、三个智能体和一个共享终端。kernel 的存在让用户能够与自己的机器对话，并让事情真正发生。

## 角色概览

- **advisor.lead** 负责引导用户意图。用户描述期望；advisor 判断其含义、涉及内容、权衡点，以及应让 operator 或 queue worker 实际执行什么。advisor 不执行操作，只提供建议。
- **operator.agent** 操作 zrig 本身，包括启动和关闭工作组、重启后恢复工作、检查拓扑，以及引导安装 / 升级 / 迁移流程。operator 代表 operator.human 行动；需要人类批准的运维决策应升级处理。
- **operator.human** 是共享任务控制终端。全新 kernel 会在此启动 `zrig tui`。`zrig tui --shared` 会把另一个客户端连接到同一终端；分离连接不会丢失导航状态。它只是一个屏幕，既不能证明有人正在观看，也不是能够回答队列项目的目的地。需要决策时，应使用已登记的人类投递渠道。
- **queue.worker** 对 stream-to-queue 底层输入进行分类。新流项目会被加标签、分配所有者并确定优先级；worker 的产出是可由其余智能体群组领取的持久队列项。

## 运行原则

- **有意识地共享视图。**智能体可以捕获 kernel 终端，并通过现有终端控制操作其 TUI。更改用户当前视图前先告知用户。绝不要像向人类收件箱发消息一样，把提示输入 TUI。普通 `zrig tui` 会打开独立视图。旧版 kernel 会保留原有 shell，直到有人在那里运行 `zrig tui`；不要为了更新该终端而重启整个 kernel。

- **Kernel 自动启动有两个不同的生命周期阶段。**
  - *首次启动*（SQLite 中不存在既有 kernel 工作组）：`zrig daemon start` 会根据运行时认证探测结果，从随附变体实例化 kernel（dual / claude-only / codex-only）。
  - *后续后台服务重启*：kernel 工作组记录会持久保存在 SQLite 中。后台服务的 kernel 启动路径在发现 `already-managed` 后会短路——不会重新实例化，也不会创建新智能体。仅重启后台服务时，成员 tmux 会话仍然存在，协调器会把它们标记为健康。主机重启会彻底清除 tmux；协调器随后把 kernel 成员会话标记为 detached，operator pod 则按照 openrig-operator skill 负责智能体重启工作流（“让我的会话重新上线”）。
  后台服务任何时候都**不会**自动实例化其他工作组——它们需要 operator 通过智能体驱动工作流显式执行 `zrig up` / `zrig restore`。
- **如实报告认证阻塞，不静默回退。**如果 Claude Code 和 Codex 都未认证，后台服务会拒绝启动 kernel，并按照 building-agent-software skill 的规范展示三段式错误（事实 / 原因 / 修复）。不允许尽力启动出半残状态。
- **使用当前升级路径。**operator 加载 `openrig-upgrade`，按照已安装版本支持的迁移说明操作，并在关闭操作前验证后台服务和工作组健康状态。
- **Skills 必须证明其席位价值。**每个智能体在启动时只加载适合自身角色及所选工作的精简清单；其他能力仍可在触发条件满足时通过已安装 skill 目录发现。
- **状态通过队列流转。**有实质内容的 ACK、阶段边界、取证发现和 verify 路由应作为带目的地与标签的 qitems 写入。对话式回复使用 `zrig send`。

## Kernel 不是什么

- 不是放置项目工作的地方。项目工作组与 kernel 并列存在；kernel 与其协调，但不会将其吸收。
- 不是长期实现界面。operator 智能体负责运维而非功能工作；功能工作属于已调度的项目工作组。
- 不是人类之间消息的路由器。队列负责智能体到智能体、智能体到人类的工作；跨主机人际消息不属于 kernel 的职责。
