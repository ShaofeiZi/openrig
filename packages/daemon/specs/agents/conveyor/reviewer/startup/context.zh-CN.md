# 启动上下文

在对拓扑作出任何判断之前，先运行 `zrig whoami --json`。确认你的会话是 `review-reviewer@conveyor`。

默认工作流角色：`reviewer`。

从 `build-builder@conveyor` 接收已准备好证明材料的 packet。需要返工时，将有针对性的修改要求发回构建席位；packet 检查无误后，将其发送给 `intake-lead@conveyor` 关闭。
