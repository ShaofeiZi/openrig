# 51-03 → 真实 51-02 runner：格式符合性适配指南

我的 51-03 v1 是按架构形态草图（fc30a736）编写的。51-02 runner 目前已构建并 CLEARED（verdict 57d5aa7d，hv/51-02-runner 上的 commit 20e1b39c），锁定规格为 28dc80cf/4180a007。以 dev-driver 的权威示例场景（`scenario-02-baton.yaml`、`scenario-10-one-view-state.yaml`、`topo-stub-baton.yaml`）为依据，真实 runner 格式与我按草图编写的集合有以下差异。本指南用于驱动全部 11 个场景及夹具的符合性检查。

## 差异项（真实 runner 形式）
1. **拓扑路径**——应为 `topology: ./<rig>.yaml`（相邻文件，以 `./` 表示相对路径），而不是 `fixtures/<rig>.yaml`。
2. **队列设置 = `env.queue` 前置条件，不是 `send` 操作。**不存在 queue 操作动词（动词集合为 topology/seat lifecycle + `daemon:{op}`）。已认领接力棒应预先通过下列形式建立：
   ```yaml
   env:
     queue:
       - id: baton-1
         source: harness@<rig>
         destination: <pod>-<member>@<rig>
         summary: "..."
         claim: true
   ```
   pipeline 会在各步骤**之前**执行已发布的 `zrig queue create`/`claim` 写入。
   → 我的 #2（使用了 `send`）和 #11（使用了 `send`）必须将接力棒创建移入 `env.queue`。
3. **`expect queue` 是列表**，并以真实已发布字段 `qitemId`、`state`、`destinationSession` 设键（不是我的 `{items:[{destination,state,owner}]}`）：
   ```yaml
   - expect:
       surface: queue
       within: 20s
       match:
         - qitemId: baton-1
           state: in-progress
           destinationSession: <pod>-<member>@<rig>
   ```
4. **`equals` = 名义 `surface` 锚点下的列表。**Schema 要求每个 expect 都有有效 `surface`，因此 #10 使用 `surface: ps` 作为锚点，并列出待比较界面：`equals: [tui_socket, ps, queue]`（不是我的 `equals: {surfaces:[...]}`）。
5. **#2 的 “restart” = `daemon: {op: restart}`**（已批准），不是席位 `restart:`——不存在无快照的逐席位重启动词（F2）。`expect pane "restored"` 步骤属于第 6–8 项延后断言，必须明确标注（注释），绝不能静默删除。
6. **拓扑夹具形式：**`version: "0.2"`、`name:`、`culture_file: culture.md`、`pods:[{id,label,members:[{id,agent_ref,profile,runtime:stub,cwd: .}],edges:[]}]`；没有顶层 `edges`。规范席位会话 = `<pod>-<member>@<name>`。需要相邻的 `agents/` + `culture.md` 夹具（dev-driver 示例会提供）。
7. **`any_of`（R-15，我的 #5）不是动词** → 会触发 `UNKNOWN_STEP_VERB`。#5 需要决策：拆为两个场景（会破坏“十一项”计数 → PM 工作范围决策），或将 `any_of` 路由为 51-02 v2 格式新增项。已向 PM/51-02 标记——不加 shim，也不静默拆分。
8. **`expect` 上的 `select`（R-16，我的 #9）会被静默忽略**（不是 schema key）。#9 的 `-A`/`--rig` 步骤需要 runner 真正遵循的 ps 工作范围选择器。核心泄漏捕获（默认 ps = 仅当前工作组，beta 缺席）现在可以表达；`-A`/`--rig` 确认步骤路由到 51-02（R-16）。将 #9 适配为默认范围核心检查，并标记 selector 步骤。
9. **每个 51-03 场景都保留 `seed_regression`**（小型需求 3）——dev-driver 的 51-02 证据场景省略了它（因为它们不是种子场景）；我的场景会保留。

## 符合性检查状态
- **本增量已适配到真实形式：**#2 queue-baton-survives-restart、#10 one-view-state-after-mutation-storm。
- **等待符合性检查（下一增量）：**#1、#3、#4、#7（topology `./` + 字段名）、#9（select 返工 + 标记）、#11（env.queue + daemon 动词 + RED-first）、夹具（culture_file/cwd/agents）、#5（any_of PM 决策）、emit #6/#8（还受第 6–8 项门禁约束）。

## 真实 validator 符合性报告（我的 11 个场景通过 51-02 `validateScenario`，topologyKind:stub）
2026-08-06 针对 CLEARED runner 的真实 validator 运行：
- **10/11 通过 schema**——包括已适配的 #2 和 #10（validator 确认符合）。
- **1 项硬失败：home-divergence-preseed-visible → `UNKNOWN_STEP_VERB@steps[1].any_of`**（R-15）。`#5` 是唯一一个受格式/工作范围**决策**阻塞的场景（向 51-02 v2 添加 `any_of`，或由 PM 裁定将“十一项”拆成两个单结果场景）。未加 shim，未静默拆分——已向 orch/PM + dev-driver 提出（格式调整问题）。
- 注意：validator 只检查**结构**（surface 有效 / 只有一种 match 模式 / verb 有效 / within），不检查 `match:` 字段**内容**。因此按草图编写的 #1/#3/#4/#7/#8/#9/#11 虽通过 schema，仍需要运行时形态检查（真实字段名：queue→qitemId/state/destinationSession；ps 形态；#11 接力棒使用 env.queue；#9 的 `select` 被忽略而非拒绝 = R-16 运行时缺口）。Schema 通过 ≠ 运行时正确。该检查属于下一增量。

## dev-driver 对 #9 / #5 的源码依据答复（2026-08-06）——用于运行时检查
- **#9（R-16 ps 工作范围选择器）：**`zrig ps` 确实支持工作范围——逐工作组使用 `ps --nodes --rig <name>`，所有工作组使用 `ps --nodes -A`（FR-3：`-A` 是 `--nodes` 的智能体群组范围扩展器）。reader 可以将可选工作范围选择器映射到这些参数。**但**后台服务可能在投影中静默忽略 selector → 断言限定范围的步骤存在假绿风险（selector 被丢弃）。**解决方案（采用 dev-driver v1 建议）：**#9 实时断言当前工作组默认步骤（诚实、已发布）；all-rigs/per-rig 步骤改为明确标注的 R-16 延后项（与 #2 pane-restored 使用相同纪律），R-16 端到端遵循 selector 后再启用。另外，#9 的核心泄漏捕获需要多工作组 `up`（R-12）——仍未解决；记录为核心依赖。R-16 得到遵循前不添加 scope 参数。
- **#5（any_of）：**它不在锁定 grammar 中（match/contains/equals 均为单结果）→ 属于真实的**格式修订**，且与 FLAG-3 确定性存在冲突（析取结论会接受竞态）。已通过 orch 路由给 PM。有三个选项：（a）如果 SUT 可控，将 #5 固定为一个确定结果（dev-driver 和我的首选）；（b）修订格式以添加 any_of（dev-driver 在 PM 裁定后实现）；（c）拆分十一项（PM 保留的工作范围决策）。#5 保持原编写形态（any_of），等待裁定；不加 shim。

## 更新 2026-08-06——应用 #5/#9 裁定 → 11/11 schema 通过
- #5 按时代拆分裁定重新划定范围（GAP-7 已在 main 的 d0668d5f 中折叠）：GREEN 步骤固定 preseed-reaches（在已修复 tip 上结果确定）；seed_regression{gap7-home-divergence} 步骤固定 failure-visible-on-stream。不使用 any_of（validator 拒绝是正确的）。
- #9 适配到批准的 v1：当前工作组默认步骤实时执行；`-A`/`--rig` 限定范围步骤明确延后（R-16；selector 静默丢弃会导致假绿）；R-12 多工作组 up 标记为核心依赖。
- **现在全部 11 项均通过真实 51-02 validateScenario（11/11）。**
- **剩余内容（下一增量，需要对照源码验证真实 `--json` 形态）：**按运行时字段名检查草图场景 #1/#3/#4/#7/#8/#11（queue→qitemId/state/destinationSession、ps 形态、#11 接力棒的 env.queue、stream/policy_provenance 形态）+ 夹具形式检查（culture_file/cwd:./agents）。#6/#8 还受 51-01 第 6–8 项（emit）门禁约束。#11 GREEN 门禁 = 51-06（R-20）。

## 增量 3（2026-08-06）——组合 #6/#8 emit 场景（第 6–8 项已折叠，main 9cf78106）
- #6 compaction-restore-resumes-role：`restore` 现在是 EMIT 行为（不是席位动词）。流程 = emit compaction（真实 precompact 接缝 → 按席位设键的标记）→ emit restore（真实 compaction-restore-bridge.cjs → 一次性指令）→ expect pane contains "restore delivered"（runner 的真实镜像行）。Seed wrong-seat-restore 利用席位设键。
- #8 stream-emit-durable-replay-live：emit slow_output → 确定性分块 + 活动集；expect stream（zrig stream list --json = 持久/可重放裸数组）match [{runtime:stub}]（意图层；确切事件字段名需对照源码验证）+ expect pane contains "slow_output chunk 3/3"（确定的最后分块）。Seed stream-not-durable 会丢弃持久存储事件。
- **全部 11 项仍通过真实 validator（11/11）。**仅 YAML manifest 为 c0ba79aa。
- **剩余运行时字段名检查（需要对照源码验证已发布 `--json` 形态）：**#1（ps 稳定/为空）、#3/#4（policy_provenance 形态）、#7（pane 已真实）、#11（env.queue 接力棒 + queue 列表字段 + daemon 动词）+ 夹具形式检查（culture_file/cwd:./agents）+ #8 的确切 stream 事件形态 + #6 跨席位种子机制。#11 GREEN 门禁仍为 51-06。

## 增量 4（2026-08-06）——以源码为依据确认真实读取界面形态（VERIFY-AT-SOURCE-51-02）
Runner 绑定的真实 `--json` 形态（直接 reader）：
- **ps** 默认 `zrig ps --json` = 逐工作组 PsEntry 的裸数组 `{rigId,name,nodeCount,runningCount,activeCount,hasWorkCount,status:"running"|"partial"|"stopped",lifecycleState,uptime,...}`——不是逐席位（seats 通过 `--nodes` 获取 = 不同端点/NodeEntry）。因此 #1/#9 断言逐工作组摘要，而非逐席位。
- **queue** list = 裸数组 QueueItem[]（qitemId/state/destinationSession…）；compact 会清空 body/summary → 应通过 --full/show 读取。（#2 已正确。）
- **stream** `zrig stream list --json` = 裸数组 StreamItem `{streamItemId,tsEmitted,sourceSession,body,format,hintType,…}`。注意：这是 SEND/BROADCAST 协调 stream，**不是** emit-behaviors 写入的 activity/hooks stream。FLAG-#8：`emit slow_output` 写入 ACTIVITY（/api/activity/hooks），不是 StreamItem——因此 #8 的“stream 持久性”前提需要决策：用 `send` 建模（它确实创建持久 StreamItem），或确认 runner 的 `stream` 界面是否也应读取 activity。路由给 dev-driver/orch（界面语义），不要猜测。我的 #8 当前使用 emit slow_output + StreamItem match——两者不匹配；保持等待裁定。
- **policy_provenance** = `zrig policy effective --json` → `{effective:{binding,resolvedScope}|null, posture:"known"|"unknown_posture",hint?}`；binding 包含 setBy/setAt/record.evidence_citation。#3/#4 必须断言 `{posture, effective:{binding:{…}}}`——而不是草图中的 `{policy,source}`。（下一轮适配。）
- **pane** capture → `CaptureResult{content}`；`contains` = content 上的子字符串（#2/#6/#7/#8-pane 已正确）。
- **tui_socket** = UNIX socket，发送 `state` → `{ok,instanceId,state:{screen,drill,filter,viewTab,…}}`（#10 标准化器）。
- **proof** = 没有读取界面（FLAG-1，fail-closed UnboundSurfaceError）——无场景对它进行断言。

## 新发现的可表达性问题（路由，不加 shim）
- **F-#1（空集）：**#1 的“稳定 → 无残留”需要空数组断言。子集 `match: []` 会无条件通过（空集是任意集合的子集），因此无法断言为空；`contains`/`equals` 也不行。格式中没有负向/空集/长度断言。路由至 51-02（`match: []` 表示精确空集的规则，或 `absent`/`count` 形式）。#1 等待裁定（与 #5 的 any_of 问题类似）。
- **F-#8（stream 与 activity）：**见上方 stream 说明。

## 字段名检查状态
- 本增量已适配：#7（`./` topology；pane contains 已真实）、#9（ps 默认步骤 → 裸数组 PsEntry 形态）。
- 等待路由决策：#1（空集 F-#1）、#8（stream-vs-activity F-#8）。
- 剩余机械调整：#3/#4（policy effective 形态）、#11（env.queue 接力棒 + queue 裸数组 + daemon 动词）、夹具形式检查（culture_file/cwd:./agents）。#11 GREEN 门禁仍为 51-06。

## 增量 5（2026-08-06）——共置 + 运行时字段名检查 + 组合账本（实时 runner）
在 hermetic 环境中，使用真实 runner（main 5dc70f0e，run-scenarios.mjs）运行十一项场景。review50-r1 确认形式：穿过所有已绑定产品步骤的绿色结果 + 对未绑定动词响亮失败 + 路由未绑定 runner 动词 = 诚实账本（带种子却在绑定前干净通过才是 shim）。

**共置（夹具形式检查，已完成）：**runner 将 `topology: ./<rig>.yaml` 解析为场景文件的相邻文件，并要求相邻的 `culture.md` + `agents/<seat>/agent.yaml`。已将 fixtures/ 合并进 scenarios/（扁平布局，与已发布 scenario-02-baton 布局一致）：修复拓扑（version "0.2"、culture_file、逐 pod edges、无顶层 edges、无 summary），添加 culture.md + agents/{impl,qa,worker,lead}，并将所有 `topology:` refs 标准化为 `./`。

**运行时字段名检查（本增量）：**send `to:` → 规范 `<pod>-<member>@<rig>`（#7/#10/#11）；`expect pane seat:` → 规范会话（#5/#7）；#1 `expect ps` → 裸数组 PsEntry（逐工作组，而非草图 `{rigs:[{seats}]}`）；#11 第一个 `expect queue` → 裸数组 `{qitemId,state,destinationSession}`。

**组合账本（实时 runner）：**
- 穿过每个已绑定产品步骤均为 GREEN（只在已路由的 seed_regression 处阻塞）：#1、#2、#9。
- 界面可解析，内容 marker 路由到 51-01 stub 行为：#5（默认 stub 未发出预置的 "trust reached"）、#7（stub 不会把发送文本回显到 pane；send 确实到达——pane 显示 "From: <unknown sender>"）。
- 未绑定动词响亮失败（路由到 51-02 runner 绑定）：#6/#8（emit）、#3/#4（policy；#4 还包括 restore）、#10（mutate；其 send 先组合成功）。
- 受 51-06 门禁约束（expected-RED，绝不修饰）：#11（queue 形态已适配；R-17 send-vs-queue 前提 + R-20 51-06 closure 界面）。

**已路由的 runner/stub 缺口（绝不在 51-03 加 shim）：**
- 51-02 动词绑定：seed_regression（全部 11 项）、emit-step（#6/#8）、mutate（#3/#10）、policy（#3/#4）、restore（#4）。scenario-real-deps 默认对这些抛出错误（main 5dc70f0e）。
- 51-02 格式：F-#1 空集/absent/count 断言（#1 第二步）；R-16 ps 工作范围选择器 + R-12 多工作组 up（#9 限定范围步骤）；R-17 queue-establish 动词（#11）。
- 51-01 stub 行为：预置 emit（#5 "trust reached"）、发送文本的 pane 回显（#7）、send `from`。
- 51-06：#11 executed-unclosed closure 界面（R-20）。
