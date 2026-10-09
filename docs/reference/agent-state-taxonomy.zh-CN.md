# 智能体状态分类法

这是所有 OpenRig 界面（TUI、`zrig ps`、节点清单，以及未来任何消费方）共同渲染的形式化状态语言。由**一个**仲裁点计算，各界面只负责渲染，没有任何界面维护自己的私有词汇。

**本文件是所发布分类法的权威文本**，并补充工程层面的对账；它绝不分叉出第二套词汇。其带类型的真源是 `packages/daemon/src/domain/activity-taxonomy.ts`。

## 三条正交轴

| 轴 | 取值 | 回答的问题 |
|---|---|---|
| session | `present` · `detached` · `exited` · `absent` | 进程是否存在 |
| activity | `working` · `idle-at-prompt` · `unknown`（外加下文 needs-input 的 count+reason） | 一个在场的智能体在做什么 |
| resumability | `live` · `resumable` · `context-walled` | 一个不在场的智能体能以什么状态回来 |

三条轴绝不融合。可达性是严格的；复活乐观主义是另一个字段（omnigent 的 strict-liveness 切分）。`unknown` 是一个一等公民的诚实取值——仲裁点说它判断不出来。未知胜过一个自信的错误答案。

### needs-input 是 count + reason，绝不是一个状态值

"被输入阻塞"以 `{ count, reason }` 形式承载——待处理提示的数量，加一个短语说明为什么卡住（"permission prompt"、"usage limit"、"classifier hold"——服务商界面和用量限额明确落在轴上：它们是生产环境观察到停滞的第二大原因）。人类界面可以通过唯一的桥接函数 `deriveDisplayActivity` *显示* "needs-input"（四值人类列表）：当 `count > 0` 时渲染 needs-input；但没有任何存储或转移把它当作状态持有。attention/alarm 取值同样留在自己的机制里（`attentionCount`）。herdr 和 omnigent 都收敛到了这个排除，并在两份代码库里都对这个冲突写了警告注释。

## 派生诊断 —— 读取时计算，绝不存储

- **PARKED（停滞）** —— 病原：`(activity = idle-at-prompt 或 needs-input 待处理) × (存在未决义务)`。掉棒了，或一个阻塞没人接。可在工作组和席位级别查询；这个 join 放在 parked 查询界面里，绝不放进仲裁点（仲裁点的非推断契约：它从不读队列状态）。
- **HELD（挂起）** —— 刻意的对应物：队列级挂起，有具名 owner 和一个已武装的唤醒（`zrig view show held`）。主动停下是 HELD；意外停下是 PARKED。一行 HELD **不是** parked。
- **DONE-UNSEEN（完成但未被看见）** —— 已完成、但没人消费其完成信号的工作（herdr 把它派生为 idle ∧ unseen）。在此声明，在读取时由 claims/transitions 计算，位于 activity 仲裁点之外，保持其非推断边界。

## 与既有实现的对账

| 我们的 | herdr（`src/detect/mod.rs:11`） | omnigent（`schemas.py:2767`） |
|---|---|---|
| `working` | `Working` | `running` |
| `idle-at-prompt` | `Idle` | `idle` |
| needs-input 的 count+reason | `Blocked` + `visible_blocker` 覆盖 | `pending_elicitations_count` + `blocked_on` 短语 —— **不是**状态 |
| `unknown` | `Unknown`（"普通 shell 或无法识别的程序"） | — |
| 派生 DONE-UNSEEN | 派生 `Done` = idle ∧ unseen（`src/ui/sidebar.rs:186`） | — |
| session 轴 | server 持有 PTY（在场性是直接的） | `runner_online` × `host_online` × `host_resumable` |
| ——（已否决） | —— | `waiting`（回合停在异步 drain 上——与 Claude 对话框的 `waiting` 冲突；两份代码库都带警告注释） |

## 证据阶梯（档位清单与退役条件）

状态由**一个**仲裁点（`SeatActivityService`）根据带排序、有时限的证据计算。档位自上而下，每档附退役条件：

- **r3 —— Claude `sessions/<pid>.json` 自报**（busy/shell/idle/waiting，自 v2.1.139 起）：常驻，在 working/idle 上高于 hooks。未文档化的内部接口——读不出来就沿阶梯往下掉，绝不报错。
- **r2 —— 生命周期 hooks**（Claude Stop/StopFailure；Codex UserPromptSubmit/Stop/PermissionRequest）：常驻。恰好一次的回合边界；SubagentStop 被过滤（它可能在回合结束后才触发，绝不能唤醒一个 idle 席位）。hook 档的权威性是**有时限的**：hook 档是唯一不给证据自标时间的档，所以跨档持续矛盾会把它降级为"仅身份识别"，并可见地发一个档健康事件。
- **r4 —— 可见的 needs-input 界面**：常驻；仅在 needs-input 信号上压过自报（一个你能看见的对话框胜过一个说 working 的 hook）。
- **r1 —— 窗口活动采样**（今天的仲裁点）：兜底层。当某个运行框架的 hook 档在生产环境经过一段实测的一致窗口赢得信任后，**按运行框架逐个**退役——绝不只靠 fixture 通过（对称准入：fixture 通过把一档放进 TRIAL；生产一致才晋升；晋升前仅身份识别）。

部分覆盖的诚实性：一个只有部分生命周期覆盖的来源，只拿到"仅身份识别"的信任。这架阶梯同时也是迁移路径——新仲裁点插在既有启发式之上，低档每次发布退一级，消费方永远看不到"国旗日"式的切换。

以席位为键：状态挂在持久的席位 nodeId 上，绝不挂在占用者上。一次交接或代际切换是它自己的可见事件——绝不是一次 activity 转移——并触发档位清单重新声明：继任者绝不继承前任的档位权威（hooks 在占用者配置里，而 pane 是席位持久的）。

## 被否决的仲裁点 —— 带日期的收据（2026-08-26），免得有人再花大代价重推

- **把转录静止（transcript-quiescence）当 activity 仲裁点：已否决。** omnigent 的 1 秒版在回合中段停顿上振荡，并幂等地把真正的完成锁在外面；它幸存下来的 5 秒版被标注为"等待 hook 替代的权宜之计"。区分依然成立：转录增长作为 refocus hook 的节拍触发仍然**没问题**——那是不同用途，也是唯一被允许的消费方。
- **把 pane 抓取当主真相：已否决。** herdr——其 TOML 屏幕清单是该领域的最高水平——只要 hooks 覆盖了生命周期，就把屏幕清单置于 hooks 之下，并把 viewer 屏幕标为 `skip_state_update`，因为回滚滚动会说谎。pane 读取只保留在兜底层。
