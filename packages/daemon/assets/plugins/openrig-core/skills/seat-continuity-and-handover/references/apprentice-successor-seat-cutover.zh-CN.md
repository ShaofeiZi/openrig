# 学徒继任席位切换 SOP

状态：2026-08-28 已由操作方实证；2026-08-30 结合物理席位修正完成策展

在学徒继任者已经完成安装、观察与验收 gate，且获授权的决策者明确要求 cutover 后，使用本运行手册。它涵盖从临时继任者席位切换到稳定 desk 席位的机械过程，同时保留现任者，使其能够作为记忆被再次唤醒。

本 SOP 不决定继任者是否准备就绪。该判断属于 desk、owner 或其他具名权威。操作方负责机械执行和证明。

## 必要输入

进行任何变更之前，在一根持久的操作方接力棒中记录以下内容：

- 权威 cutover 指令和决策者；
- 目标工作组和主机；
- 稳定目标的 logical ID、node ID 和规范 session name；
- 继任者的 logical ID、node ID、规范 session name 和准确 provider resume token；
- 现任者的准确 provider resume token；
- 所需 runtime、model、cwd、`OPENRIG_HOME`、`OPENRIG_URL` 和托管运行时 `PATH`；
- 旧占用者的处置方式，包括是否保持可唤醒；
- 继任者必须接受的 duty-custody 产物或 ledger 条目；
- 必须跨越 swap 保留的队列记录或 staged 消息；
- 回执目标位置。

不得根据 label 推断 provider token。应从在线会话记录推导，并与活动 provider history 文件互相印证。

## 不变量

1. 稳定席位身份保持稳定。继任 lineage 属于 provenance，不应进入带后缀的在线席位名称。
2. 必须迁移准确、已接受的 provider history。禁止 compact、summary、fork 或意外恢复过时历史。
3. 从现任者确认进入 idle 起，到新占用者通过 cutover 后自检为止，desk 权限必须保持冻结。
4. 如果裁定的处置方式是 advisory reserve，现任者必须能通过其准确 provider token 被唤醒。保留规范物理 pane，不要求在其中继续保留现任者进程。
5. Staged prompt 即使在 pane 中可见，也不代表已经持久化。停止该 pane 前，应与 outbox 或其他持久事实源核对。
6. 席位 binding、provider history、进程环境、queue identity 和 Herder client attachment 是彼此独立的界面，必须逐一验证。
7. 超时操作属于 indeterminate。重试之前，应先回读实际效果。

## 阶段 1：隔离与预检

1. 领取持久操作方接力棒。
2. 要求现任者和继任者完成当前原子动作并返回 idle prompt；必须取得明确确认。
3. 冻结 desk 操作、fold、裁决、路由和面向 owner 的写入。
4. 阅读完整接力棒和具名 duty-custody 产物。
5. 推导在线状态：

```bash
zrig whoami --json
zrig seat status <target-seat> --json
zrig ps --nodes --rig <rig> --json
```

6. 在主机数据库中读取最新的目标和继任者会话记录，确认准确的继任者 resume token 与现任者 token。
7. 确认两份 provider history 文件都存在，且继任者文件仍在被主动写入。
8. 检查继任者 pane 和持久 outbox 中 staged 但尚未发送的输入。停止席位之前，为每项此类输入记录处置方式。
9. 记录当前连接到现任者会话的所有 Herder/tmux client。
10. 创建一个有边界的工作组快照，并记录其 ID。

如果 identity、token、model、authority、custody 或 staged-input 证据不一致，立即停止。

## 阶段 2：让临时继任者静默

使用受支持的生命周期界面。正确的 detach 动词取决于当前 session origin：

- `claimed` 或 `adopted`：按 CLI 规定使用 `zrig unclaim`；
- `launched`：使用 `zrig seat stop <successor-seat>`；`zrig unclaim` 会正确拒绝。

只有确实存在剩余托管记录需要清理时，才执行 `zrig seat clean`。成功停止后返回 `nothing_to_clean` 可以接受。

不要使用 `zrig down`，不要终止 provider，不要清除 provider history，也不要启动通用的全新占用者。

## 阶段 3：落实准确候选者

使用准确、已接受的 provider token，启动一个隔离且可发现的候选者。从第一个字节起，就向它提供目标席位的规范环境：

```text
OPENRIG_SESSION_NAME=<target-session>
OPENRIG_NODE_ID=<target-node-id>
OPENRIG_RUNTIME=<runtime>
OPENRIG_HOME=<home>
OPENRIG_URL=<url>
PATH=<managed-runtime-bin>:<required-system-paths>
```

使用准确的 model、token 和规范名称启动 provider。`PATH` 必须直接放进 provider 进程环境。只设置 tmux session 环境并不足够，因为中间的 login shell 可能替换它。

注册或发现候选者，并记录其 discovery ID。commit 之前，直接验证其进程 argv 和环境：

- 准确的 resume token；
- 准确的 model；
- 规范 `--name`；
- 规范目标 node 和 session environment；
- `node` 与 `zrig` 可从托管运行时路径解析。

## 阶段 4：提交 Binding

针对 discovery record 执行受支持的 handover：

```bash
zrig seat handover <target-seat> \
  --source discovered:<discovery-id> \
  --reason <durable-reason> \
  --operator <operator-seat> \
  --json
```

回读结果，并要求满足：

- `handover_result=complete`；
- 目标 node 不变；
- continuity outcome 准确说明实际模式，通常是 `resumed`；
- provenance 指向前一位占用者；
- 存在新的目标 session record。

在本次 commit 持久化之前，不要重命名 pane。

## 阶段 5：保留物理席位、完成核对并保存记忆

当人类或智能体已经连接 client 时，规范 tmux session、window 和 pane 都属于稳定席位的一部分。不要迫使这些 client 去追随被重命名的 session。

1. 在原始规范 pane 中，只停止现任 provider 进程。保持 tmux session、window 和 pane 不变。
2. 将现任者准确的 provider token 保存在 lineage ledger 中，作为 cold-advisor 句柄。无需为其保留一个永久重命名的 tmux pane。
3. 只有当已接受 token 持久化后，才能停止 staged 继任者进程；然后在原始规范 pane 中，使用规范 name、model、cwd、environment 和托管 `PATH` 恢复该准确 token。
4. 通过受支持的 seat 界面核对规范目标会话，并使用经过审计的 token-input 界面持久化准确 resume token。
5. 验证规范席位恰好有一个托管占用者，旧 token 仍可唤醒，空 staging session 已移除。

重命名现任者和 staging session 只是修复已经改变物理 session 的运行时所用的兜底方案，绝不是默认 cutover。被恢复的 reserve 可能在自己的 argv 或环境中保留启动时规范名称；该残留并不使它成为已绑定席位。Reserve 的回复必须在正文中明确标示，并以拓扑 binding 作为权限依据。

## 阶段 6：cutover 后自检

继续冻结权限。要求新占用者自行推导，而不是假定：

1. `zrig whoami --json`：稳定 logical ID、node ID、规范 session、runtime、edge；
2. `zrig queue whoami`：规范目标位置和开放记录清点；
3. 最新在线 history 文件中的活动 provider UUID；
4. 在线 provider record 中的实际 model，而不只是 spec pin；
5. 已读取并接受 duty-custody 产物；
6. 已核对 cutover 窗口内的所有队列记录；
7. 从智能体自己的 tool shell 执行 `command -v node` 和 `command -v zrig`；
8. 一个范围狭窄的 hook/tool 动作，用于证明不存在启动环境失败。

任何界面失败时，保留准确 provider UUID，并只修复不一致的界面；需要时重新启动同一份 history。再次执行完整自检后，才能解除权限冻结。

## 阶段 7：解除冻结并转移 Custody

自检无误后：

1. 明确解除 desk 权限冻结；
2. 将每条 staged 或 cutover 窗口指令准确转移一次；
3. 要求新占用者通过回读验证效果；
4. 通知 routing lead 和 incumbent reserve 已完成；
5. 让 incumbent reserve 保持 idle、未压缩且无权限。

## 阶段 8：验证 Herder 视图

Client 跟随物理 tmux session 和 pane，而不是 logical binding。默认物理席位 cutover 应让所有记录的 client 继续连接到同一个规范 pane。回读 attachment。如果修复兜底路径已经重命名 session，则逐一明确重新定位受影响的 client：

```bash
zrig seat switch-client <target-seat> --client <tty> --json
```

回读所有 client attachment。否则，即使 cutover 本身正确，在网格或 focus tab 中仍可能显示错误。

## 完成证明

回执必须包含：

- 操作方接力棒和权限来源；
- snapshot ID；
- 稳定和临时 node ID；
- 旧、新 provider UUID；
- discovery、handover 和最终 session ID；
- 最终进程 argv 和关键环境；
- `zrig seat status` 结果；
- 目标与继任者 inventory 状态；
- queue-row 核对；
- staged-input 处置方式和效果证明；
- reserve pane/name/token 和隔离措施；
- Herder client attachment；
- 新占用者的自检和首批经验证 desk 动作；
- 偏差、失败尝试和剩余产品缺口；
- 回执路径和 SHA-256。

只有回执已经存在，且新占用者至少完成一次通过实际效果验证的权限承载动作后，才能关闭接力棒。

## 2026-08-28 运行中证实的陷阱

- Dry-run 可能接受一个托管继任者，而在线 handover 会以 `successor_already_managed` 拒绝。应先让临时席位静默。
- 通用 launch/restore 选择可能选中更旧的席位 history。必须启动准确、已接受的 resume token。
- Handover 可能绑定候选者，却不停止现任者。必须明确应用裁定的处置方式。
- Reconciliation 可能创建正确 session identity，却不携带 resume token。必须持久化并回读该 token。
- 看似规范的进程仍可能具有损坏的工具 `PATH`。应从 provider 自己的 tool shell 内部验证。
- 重命名 session 会使 Herder client 继续跟随已退休 pane。默认应保留物理规范 pane；只有修复已经重命名的运行时，才显式 retarget。
- Pane 输入可能可见，却不存在于 JSONL 中。停止 pane 之前，应核对持久 outbox。
- 由于启动时环境在 unbind 后仍保留，reserve 消息可能显示稳定席位名称。Reserve 必须自行表明身份，并始终处于明确隔离状态。
- 成功输出不是效果证明。必须回读队列关闭、binding、client 移动和已转移指令。

## 产品化候选项

这套手工流程揭示了值得产品化的一等能力：

- 直接从已托管继任者席位执行 handover；
- 按准确 resume token 启动候选者；
- 为旧占用者提供一等 `advise`/memory 处置方式；
- 原子化 binding 与 token 持久化；
- commit 前执行托管环境验证；
- staged-input custody 报告；
- 验证或修复 logical seat 的所有 Herder client attachment；
- 将 reserve attribution 与规范席位 attribution 区分开；
- 使用一份回执，分别报告连续性结果和席位绑定结果。
