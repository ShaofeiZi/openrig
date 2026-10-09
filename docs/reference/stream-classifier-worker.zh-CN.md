# 占用者自有的流分类与影子捕获（实验性）

> **0.6.0 中的实验特性，可选且默认关闭。** Jev 分类路径和影子捕获可能不完整或不工作，不做任何准确性或生产可靠性声明。OpenRig 的投递、watchdog 和路由决策不使用它们的输出。如果它们行为与本文不符，请[开 issue](https://github.com/mvschwarz/openrig/issues/new/choose) 或发 pull request（[CONTRIBUTING.md](../../CONTRIBUTING.md)）。

本源码为一个真实的分类器占用者提供一个有界接收器。它不启动智能体、不注册 watchdog 任务、也不默认启用捕获。分类法、问题和决定属于占用者；daemon 提供源事实，并强制它既有的租约、执行和幂等围栏。一个显式可选的 Jev 模式通过同一个 worker 提供建议性决定。实验性标签没有被证明的准确性或校准过的置信度，不替代投递、watchdog 或路由决策。

## 可选的前台 Jev 实验

不配置时，实验关闭。在一个已存在的私有目录里选一个显式本地 JSON 路径；文件只含启用状态和边界：

```sh
zrig project experimental status --config ./experiment.json --json
zrig project experimental enable --config ./experiment.json --max-requests 3 --timeout-ms 10000 --json
zrig project experimental disable --config ./experiment.json --json
```

enable 不启动处理、捕获、daemon 或智能体。status 和 disable 不发任何服务商请求。一次启用的运行要求调用进程环境里有 `OPENROUTER_API_KEY`；本入口绝不搜凭据文件或把凭据拷进配置。缺凭据在尝试或服务商工作之前就失败。常规密钥配置仍由操作员负责。

选定路由是 `https://openrouter.ai/api/alpha/decisions`，钉在 `typesafe/jev-1.13`，无服务商回退或 HTTP 重定向。请求声明每百万 prompt token 最高 $0.05 的服务商价格，completion 和请求价格为零。这些是准入上限，不是报价、花费估算或凭据访问声明。每次前台运行允许 1–20 个请求（默认 3），每个 1–30 秒时限（默认 10），请求 24 KiB、响应 256 KiB 限制。失败请求消耗其计数。后台不重试。

要从实际选定的占用者处理流条目：

```sh
zrig project wake --project PROJECT --taxonomy ./taxonomy.yaml \
  --classifier-version experimental-jev-1.13 --evidence-epoch OWNER_EPOCH \
  --limit 3 --experiment ./experiment.json --json
```

用下文描述的分类法格式。每条判据必须有非空字符串描述；`__unknown__` 保留。问题留在 daemon 之外。请求把选定条目的正文、提供的分类法问题/判据、规范范围 ID 和当前花名册目的地发给 OpenRouter。为那次外部处理选合适输入。它不把凭据传进证据，也不把它存在分类里。输出绑定当前源、分类法、候选版本、租约、占用者代际和尝试执行。不推断任何动作或置信标签。重复判断仍人工做。

`--limit` 和配置的请求上限中较小者约束这次 wake。未知回答保持 null；一个完全未知的回答弃权。无效模型、服务商、回答键、选项、概率或响应字节会拒绝整个回答。概率和保留严格的 0.001 容差；不做舍入修补或部分抢救。不可用/无效的服务商工作让该次运行停止，不写分类。查看返回的尝试状态：终态弃权不重开，失败/未知的 daemon 写入必须通过既有台账对账。绝不只为重试实验而改 evidence epoch。

disable 在每次调用前和应用结果前都检查。单独的 disable 命令不能取消已转发的远端请求；它迟到的结果被丢弃，等待受既有时限约束。Ctrl-C 或 SIGTERM 请求立即取消前台运行。一个不配合的请求保持报 pending，不会在该次运行里造成迟到写入或第二次调用。本地取消不证明远端取消或退款。该命令不注册 wake、不返回自动续跑，需要一次显式的后续调用才做更多工作。

对既有影子档案里选定的观察：

```sh
zrig project experimental capture --config ./experiment.json \
  --input ./selected-shadow.jsonl --output ./new-advisory-results.jsonl --json
```

这最多读 8 MiB，只考虑前配置上限数量的记录。它绝不捕获终端。输入保持不变；输出只以 0600 模式创建。保留既有输出，只在刻意选一次新运行时换文件名。它把捕获到的屏后文本发给同一服务商，并在答案旁保留原始 attempt/node/occupant/pane 绑定和捕获哈希。缺失捕获或绑定即不可用，不发服务商调用。状态回答是实验性提示；投递保持 `INDETERMINATE`，因为屏幕文本不能证明已提交/已消费/已生效，档案也不保留原始发送文本。没有任何结果反馈进活的传输或清单。失败运行保留已写输出；查看 `unavailable`、`remaining`、调用数和停止原因，而不是把一个文件当成功证明。

## 一次有界 wake

从选定占用者，用配置好的项目 ID 读候选：

```sh
zrig project candidates --project PROJECT --taxonomy /private/taxonomy.yaml \
  --classifier-version VERSION --evidence-epoch OWNER_EPOCH --limit 20 --json
```

结果含合格流 ID、带确切源路径/哈希的撰写范围 ID、该占用者工作组当前运行花名册、观察时间和一个候选版本。分类法 YAML 提供 `version` 和 `fields.{kind,urgency,maturity,area}`，每个带 `question` 和 `values` 映射。这些问题返回给占用者；草稿值不是被验证的真相。在校准选定该契约之前，置信度没有可选值。目的地选项是当前花名册会话加显式 `pool`。null/省略目的地保持未知；它不被转成 `pool`。候选哈希同时绑定可选值、源哈希和分类法哈希。在这次 pool 修正之前准备的 packet 需要重新准备；它不重开历史尝试，也不改 evidence epoch。

用 `zrig stream show ITEM --json` 读每个合格条目。重复候选是最近 100 条未归档条目、带确切 body-hash 证据引用；其预览截到 2000 字符，截断时标记。选重复之前读完整候选。检索未命中即未知。目录名、issue ID 和裸成员身份绝不提供范围 ID。源错误显式报出，部分源快照导致弃权。

写一个占用者自有的决定文件（最多 100 个唯一条目 ID，最多 1 MiB）：

```json
{
  "candidateSetVersion": "sha256:<candidates 返回的 version>",
  "decisions": [{
    "streamItemId": "<合格 ID>",
    "bodyHash": "sha256:<确切 UTF-8 条目正文的 SHA256>",
    "decision": { "kind": "classify", "labels": {
      "classificationType": "<选定分类法值>",
      "scopeRef": "<选定的规范 mission 或 slice ID>",
      "needsHuman": null
    }}
  }]
}
```

一次显式弃权是 `{"kind":"abstain","reason":"为什么未知"}`。其他标签键是 `classificationUrgency`、`classificationMaturity`、`classificationDestination`、`area` 和 `classificationConfidence`。省略或 null 标签保持未知。一个重复需要 `duplicateOfStreamItemId` 和来自 candidates 的匹配 `duplicateEvidenceRef`，外加占用者判断它确实是重复。仅存在一个既有条目不等于那个判断。

```sh
zrig project wake --project PROJECT --taxonomy /private/taxonomy.yaml \
  --classifier-version VERSION --evidence-epoch OWNER_EPOCH --limit 20 \
  --decisions /private/decisions.json --json
```

这个命令通过既有 HTTP 服务实际调用一次 `StreamClassificationWorker.wake()`。它通过 `DaemonClient` 派生发送者身份，要求一个当前运行的占用者，并把捕获到的代际穿过每次租约/尝试/分类请求。它绝不伪造一个 daemon 持有者。既有直接 HTTP 调用方保留其文档化的发送者来源行为。

该命令在拿租约之前刷新源候选。缺失或过时的决定 packet 返回 unavailable，不启动尝试；花名册、范围、分类法或近期流变了就刷新准备。一次 wake 中，一个没有确切 body 绑定决定、缺源、或选定候选不可用的条目弃权。这是刻意严格的；持续的源变动可能需要重复准备，不是吞吐声明。

每次 wake 最多处理 `--limit` 个条目（1–100；默认 20），从最老的合格活开始，而不是靠一个有损通知游标。持久终态尝试保持排除。一个新候选版本**不**授权再过一遍：只有 owner 选定的 evidence epoch 改那个尝试身份。把 candidates 输出和决定、结果一起保留在旁，好让其版本可复现。CLI 不维护第二本本地台账。

结果带逐条目结局、`moreEligible`、`nextWakeAt`，以及一个 watchdog `wakeRequest` 描述符，含真实 session/代际和一条接收指令。`registered:false` 是字面意思。一条周期提醒消息请占用者准备并运行本入口；那条消息的投递不是执行。注册/安置仍是后续显式动作。尊重 `nextWakeAt`：租约维护用 TTL/3 次机会；租约丢失或服务不可用退避 60 秒。daemon 的重试/耗尽台账仍是权威。普通客户端把每个请求限在 5 秒；一个超时写入在读台账之前结局未知，绝不报为已写。

人工决定路径里没有服务商。可复用的异步 worker 有一个待处理分类器槽；超时请求取消但不能强制。一个不配合的分类器挡住该实例的后续调用，迟到结果写不进。那个内存待处理槽不是跨进程取消。

## 独立的有界影子 drain

生产传输和清单探针接受同一个可选观察者。它们只记录已做的捕获，节点、占用者、pane 和捕获目标在 await 之前绑定。普通廉价清单路径仍不捕获。保留但不写是一个独立事件，绝不是投递证据。

激活需要在一次后续授权的 daemon 启动时显式提供 `OPENRIG_SHADOW_CAPTURE` JSON。缺失或无效配置保持捕获关闭。本文件不提供活目的地或激活指令。必填字段和工程上限：

| 字段 | 含义 | 上限 |
|---|---|---|
| `destination` | 规范的、当前用户自有的 0700 目录里一个新的绝对 JSONL 文件 | 显式路径 |
| `maxRecords` | 预留 sink 记录总数 | 100,000 |
| `maxBytes` | 预留 sink 字节总数，含换行 | 1 GiB |
| `capacity` | 排队观察数 | 1,000 |
| `maxQueuedBytes` | 队列中等待的序列化字节 | 8 MiB |
| `maxObservationBytes` | 每条观察的序列化字节 | 1 MiB |

所有数字字段要求是正安全整数。这些是工程容量上限，不是批准的语料大小或分类阈值。一次在飞 drain 最多可再持 64 条观察，受队列字节额度约束；队列加 drain 因此最多保留该额度的两倍。独立观察者默认是 256 条、4 MiB 排队、每条观察 256 KiB；显式生产配置逐个提供。

`zrig project shadow-status` 只检视配置/计数器。`zrig project shadow-drain` 请既有 HTTP 服务排出最多 64 行；它要求一个 actor，绝不启用捕获。不加后台 drain 定时器。`zrig project shadow-stop` 立即停止新入队，完成任何活动 drain 和有限保留队列，然后关闭 sink。重复 stop 幂等；它不能启用捕获或删除既有档案。既有配额和 sink 失败损失仍计数。慢盘可能让 stop 挂起；客户端超时后查看 status，别假定 flush 完成。再次启用捕获需要一次单独授权的、带新目的地的 daemon 启动；启用本地服务商实验不启用捕获。文件以 0600 独占创建。既有文件被拒绝，绝不覆盖、追加、轮转或删除。重启需要一个新选目的地。私有文件创建目前需要 POSIX 属主支持。

热路径只做有界同步入队；它绝不 await 磁盘或 drain 完成。慢 sink 留一个 drain 待处理；并发 drain 不开第二个写者。溢出丢新观察。容量耗尽停 sink。错误停写、计损失并保留任何部分文件；失败批次不重放。`reservedRecords/Bytes` 含尝试写，`completedRecords/Bytes` 数成功追加。`drained` 意思是从观察者移除，不一定已持久。队列计数降、字节绑定降、记录错误、缺失/不可用捕获和 sink 失败各自独立。

活采集、私有目的地/保留选择、语料标签、托管校准、原生安置、包/安装证明和独立的可见/已提交/已消费/已生效证据，都在本源码入口之外。
