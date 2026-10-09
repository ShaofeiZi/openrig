# Slice-11 Phase-0 spike：智能体可驱动性 harness

这个一次性、验证性质的 harness 用来回答 Phase-0 spike 的三个问题（IMPL-PLAN
2026-08-02）：机制形态、渲染基底、安全核心语法。它零依赖；仅使用原生 node ESM
和 `node:test`；其中的桩数据用于代替 §4.A 中对 daemon 的读取（这个 spike
本身不会调用 daemon）。

交互式运行（最好放在 tmux pane 中）：

    node spike/tui-drivability/harness.mjs --instance tui-a --socket /tmp/tui-a.sock

在命令栏中输入命令（`:topology`、`:specs`、`:needs`、`/filter`、
`rig <name>`、`agent <name>`、`spec-of <agent>`、`running <spec>`）；这里的 `rig` 是 spike 内部资源命令，不是顶层 CLI；使用方向键
加 Enter 在 explorer 中导航；鼠标点击会命中相同目标；按 `q` 退出。可选的控制
socket 接受同一套语法，每行一条命令（另加用于 JSON 状态查询的 `state`）——这就是
“addressable-screen API”候选方案。

测试：`node --test spike/tui-drivability/*.test.mjs`

记录下来的结论位于该 slice 目录下的 `proof/` 中（参见
SPIKE-VERDICT-2026-08-02-dev50-driver.md）；这份代码是证据，不是
Phase-1 实现。
