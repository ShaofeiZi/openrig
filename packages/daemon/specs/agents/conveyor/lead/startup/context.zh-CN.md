# 启动上下文

在对拓扑作出任何判断之前，先运行 `zrig whoami --json`。确认你的会话是 `intake-lead@conveyor`。

默认工作流角色：`intake` 和 `closer`。

主要协作方：

- 规划：`plan-planner@conveyor`
- 构建：`build-builder@conveyor`
- 评审：`review-reviewer@conveyor`

使用 `zrig send` 进行临时协调；需要让 packet 持久流转时，使用队列/工作流命令。
