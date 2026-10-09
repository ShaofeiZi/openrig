# skills/queue-handoff

在当前轮次结束前持久交接进行中的工作

进行中的工作应通过交接 queue baton 结束，而不是停在 prompt 处进入空闲状态。
