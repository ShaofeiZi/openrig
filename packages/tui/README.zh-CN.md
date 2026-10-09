# @openrig/tui——任务控制 TUI

这是一个类似“面向工作组的 k9s”的浏览器 / 主从详情界面：左侧 Explorer（Topology · Specs · Scopes · Needs-You），右侧内容窗格，顶部命令栏，底部环境工作组流。它只提供 OBSERVE / NAVIGATE / DRIVE-STRUCTURE；ACT / PRODUCE / REVIEW-ARTIFACT 界面属于 Studio，不在这里。运行时依赖为零；它读取后台服务的**现有**投影（两个渲染器共享一个投影——`src/daemon-client.ts` 就是完整 HTTP 界面）。

## 运行——一个 herdr tile，直连后台服务

TUI 作为 herdr wall 中的**一个** pane/tile 运行（任何 tmux pane 的工作方式都相同——tile **就是** tmux pane；没有额外多路复用器，也没有集成层）：

    # 在 herdr tile / tmux pane 内直连后台服务（OPENRIG_URL 或默认值）：
    node packages/tui/dist/main.js --instance tui-1

    # 选项：
    #   --instance <id>   实例 ID（socket 地址；支持多实例）
    #   --url <daemon>    后台服务基础 URL（默认 $OPENRIG_URL 或 http://127.0.0.1:7433）
    #   --socket <path>   控制 socket（默认 $OPENRIG_TUI_SOCKET 或 $OPENRIG_HOME/run/tui-<id>.sock）
    #   --demo            使用带标签的 demo fixture 代替实时读取（绝不与实时数据混用）

智能体可以组合一个视图，并使用指向该命令的 `zrig terminal` 原语为操作者打开它。

## 驱动方式（人类或智能体——相同语法、相同状态）

命令栏、键盘、鼠标和控制 socket 都通过同一条路径修改**同一个**视图状态。安全核心语法：`:topology` `:specs` `:scopes` `:needs` · `/<filter>` · `host|rig|pod|agent|spec <name>` · `tab table|overview` · `spec-of <agent>` · `running <spec>`。按键：方向键 + Enter 用于浏览 Explorer，`f` 切换底部区域，`q` 退出。

在 Scopes 中选择一个任务目标，或使用 `mission <name>`。其工作流行会打开当前工作、负责人、已记录的等待原因、唤醒机制、下一行动和绑定来源。`workflow <instance-id>` 与 `packet <qitem-id>` 用于定位所选任务目标中的相应页面。发布仪式、发布后整理和作者指定的后继项彼此独立。回执是带归属的记录，不是自动验收结论；绑定的源哈希描述编译关系，并不声称当前源文件字节完全相同。

Specs 会区分作者声明与观察到的消费者。打开消费者可检查其服务运行时与席位绑定；缺少源材料时会明确显示。即使库修订未变化，刷新时仍会重新读取选定来源。`back` 或 Escape 返回上一个选择、标签页或滚动位置。Escape 会先取消编辑或清除当前筛选器。在较长的规格页面中，Up/Down 默认用于滚动；Right 进入链接，随后使用 Up/Down 和 Enter 跟随链接。`zrig tui commands --json` 会列出共享命令注册表。

对于智能体，使用 `tmux send-keys` 发送任意命令是始终可用的最低能力；控制 socket 则是可寻址屏幕 API——每行一条命令，每行一条 JSON 响应，另有 `state` 用于只读状态查询：

    printf 'agent dev.impl\n' | nc -U ~/.openrig/run/tui-tui-1.sock

Socket 规则（架构长期约束）：每条 socket 命令都必须经过唯一的解析/修改路径，且动词只能属于 OBSERVE/NAVIGATE/DRIVE-STRUCTURE。Unix socket 路径必须短于约 104 字节（sun_path）——请使用默认运行时目录。

## 测试

    npm test          # vitest：语法、状态、等价性（鼠标/键盘/命令）、hydration
                      # fixture、socket 契约、§4.A 路由审计、--demo 门禁
