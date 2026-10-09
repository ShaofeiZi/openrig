# 路由 — 这些场景需要 51-01 / 51-02 提供的能力（绝不在此处加 shim）

根据 51-03 小型需求 2 及 README 风险 1/2/3/5：任何缺失的 runner 动词、stub 行为或 env-helper 能力都属于 51-01/51-02 的缺口，应**路由**给对应切片的所有者——绝不能在 51-03 内部修补、加 shim 或绕过。下列各项均依照锁定/裁定后的形态编写，因此依赖落地后即可接入。

## → 51-01（stub 运行时）
- **R-01. Emit 能力集合（第 5–8 项）。**两个包含 emit 的场景——#6（`compaction`）和 #8（`slow_output`）——使用 `emit.behavior ∈ {compaction, slow_output, mid_turn_death, restore}`。（#2 queue-baton 使用 `send`+`restart`，**不使用** `emit`——计数已更正；见 `scripts/README.md`。）Step-4（CLEARED，verdict 1eb6d505）只构建了启动 + 就绪能力；A5 第 5 项（ctx%）已在 13e26355 落地（CLEARed，verdict 53397f73）；四种 emit **行为**将在 51-01 第 6–8 项落地。在此之前，#6/#8 可以 PARSE，但其 emit 步骤没有可触发的接缝。刻意不包含 `usage_limit`（仅用于真实运行时）。
- **R-02. 按场景解析的 stub 脚本（scripted-response 契约）。**`scripts/*` 引用 51-01 在 `up` 阶段交付的逐席位脚本投递接缝。默认的启动就绪脚本（51-01 内置）目前已覆盖 lifecycle/queue/send 场景；`scripts/` 下的行为脚本受 R-01 门禁约束。
- **R-03. Stub ctx% 资格（A5 第 5 项）。**此处没有场景断言 stub 席位的 `ps` ctx%（否则会受 A5 ContextMonitor GAP-1/GAP-2 增量门禁约束）。特此标记，确保未来 ctx% 场景只在该能力落地后添加。

## → 51-02（场景格式 + runner + env-helper）
- **R-10. Runner + hermetic env-helper。**在 runner 脚本及 forced-local/scrubbed-env/scratch-HOME/fail-closed helper 存在前，任何内容都不能运行。hermeticity 负向检查（证据项）属于 helper，并通过这些场景执行。
- **R-11. `daemon: {op: sigterm|restart}` 步骤动词（#11）— 已在 51-02 v1 落地。**ARCH-RULING-51-09 已裁定架构（SHARED env-helper 生命周期界面上的后台服务生命周期动词：单一所有者 spawn⇒kill/restart，并在注入时钟下，通过相同的 forced-local/scratch/fail-closed 保证重新 spawn）。根据 dev-planner 对 51-03 的评审：此动词**现已包含**在修订后的 51-02 v1（A2 finals `28dc80cf` / `4180a007`）——不再是需要搭车通过门禁的缺口。#11 已按裁定形态编写，并由 51-02 v1 动词满足。（运行时请对照 A2 finals 确认 `op` 的精确拼写。）
- **R-12. 多工作组 `up`（#9）。**#9 启动两个工作组，用于证明 ps 的工作范围诚实性。锁定格式的 `topology:` 在场景级只允许一个值；#9 使用逐步骤的 `up: {topology: fixtures/…}` 覆盖来命名第二个工作组。在 51-02 构建时**确认** `up` 是否接受逐步骤 topology 覆盖（多工作组），或格式是否需要 `topologies:` 列表。此项作为 51-02 规格问题路由；#9 按覆盖形态编写。
- **R-13. `equals` 跨界面标准化器（#10）。**声明式 {tui_socket, ps, queue} 标准化器由 51-02 交付（架构评审随 51-03 塑形进行）。#10 按声明式 `equals:` 接口编写；标准化器映射本身属于 51-02。
- **R-14. `env.pre_existing_tmux` hermetic 夹具（#5）。**这是最难的环境夹具（scratch 脚手架中预先存在的 tmux server）。如果 env-helper 无法 hermetic 地表达它，#5 就应在 51-02 上**阻塞**，而不是以非 hermetic 方式运行——fail-closed 胜过覆盖率表演。
- **R-15. 析取 expect `any_of`（#5）。**#5 的绑定验收条件是“落在两个诚实结果中的**任意一个**”（预置内容到达席位，**或**失败在 stream 上可见）。锁定的 `expect` 是单一匹配；#5 使用 `any_of: [expect, expect]` 形式（限定时间内任意一项成立即通过）。在 51-02 **确认**格式是采纳 `any_of`，还是将两个结果拆成两个场景。此项作为 51-02 规格问题路由。
- **R-16. `expect` 上的 `ps` 工作范围选择器（#9）。**要断言当前工作组默认值、`-A` 和 `--rig <name>`，runner 必须参数化已发布的 `zrig ps` 读取。#9 在 `ps` expect 上使用 `select: current-rig | all | {rig: <name>}` 修饰符。在 51-02 **确认**选择器形态（它会映射到已发布的 ps flags）。已路由。
- **R-17. Handoff / queue-completion 操作（#11，次要）。**如实复现事件中的 `handoff-and-complete` 关闭可能需要 `send` 之外的队列完成操作。#11 通过 `send`（锁定动词）驱动已执行工作；如果精确的 closure-commit 窗口需要独立 handoff 步骤，则路由到 51-02。次要。

## → 51-06（事务性执行关闭）— #11 GREEN 门禁
- **R-20. #11 GREEN 门禁 = 51-06 事务性关闭协调（POOLED，尚未进入 main）。**kill-daemon-mid-handoff 是 RED-FIRST：其**唯一** green 门禁是 51-06 的事务性 execution-closure + executed-unclosed reconcile；根据 dev-planner 的 51-03 评审并以源码为依据，确认它尚未进入 `13e26355` 的 main。51-06 落地前应记录为 expected-RED，绝不能篡改结果。**更正（取代较早的 acting-orch feed）：**`bfbc2182` 是 90840bcb response-integrity CLI commit，`4cd2c313` 是 slow-op-recorder drain latch——两者都没有修改 queue/closure 代码，与 #11 正交；它们都不满足门禁。后台服务 SIGTERM/restart 只是 `daemon: {op}` 动词（R-11）；跨 SIGTERM 的 queue-claim 持久化属于 SQLite 基线，不是切片门禁。#11 唯一不属于 51-06 的阻塞是 51-02 runner（R-10）和 `daemon:{op}` 动词（R-11，现已在 51-02 v1 落地）。

## 路径最终确定
这些文件作为自包含交付放在 `packages/test-system/` 下。51-02 runner home 内部的**确切**树位置由 51-02 构建最终确定；已发布布局采用**共置**方式——`scenarios/` 包含场景 YAML 及其夹具资源（topologies、agents/、culture），`scripts/` 位于其旁；原先独立的 `fixtures/` 目录已合并进 `scenarios/`。
