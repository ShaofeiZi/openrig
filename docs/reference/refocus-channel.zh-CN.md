# Refocus 通道

**定向内容如何到达一个*正在运行*的席位。** 编辑一个文件不等于投递：一个运行中的席位在会话启动时读过它的配置，它上下文里没有任何东西会自己重新读盘。refocus 通道补上这个缺口——它是让随包 chain 文件（见 `chain-file-convention.md`）成为活的教义、而不是启动时装饰的机制。

## 机制

`openrig-core` 自带 `hooks/scripts/refocus.cjs`，在两个运行框架上都注册：

| 事件 | Claude Code | Codex | 为什么 |
|---|---|---|---|
| UserPromptSubmit | ✓ | ✓ | 在一个模型可见的边界投递到期或按需的上下文 |
| Stop | ✓ | —— | 抓住跨过增长阈值的长 Claude 回合 |
| PostCompact | ✓ | ✓ | 保留确切的压缩到期状态；在下一条提示上投递 |

Claude 额外的触发信号是**转录增长**——不是回合数（一个回合可能在五十次工具调用里烧掉 20 万 token），也不是墙钟时间（故障是持续工作，不是流逝时间）。默认阈值约为 2.6MB JSONL 增长（≈30 万 token）；用 `OPENRIG_REFOCUS_BYTES` 调节。Codex 从不用那个阈值：它确切的 `PostCompact` 生命周期 hook 就是触发器，避免在 Codex 自己的压缩节拍附近重复双触发。设 `OPENRIG_REFOCUS_NOW=1` 可按需触发一次 refocus；设 `OPENRIG_REFOCUS_ENABLED=0` 关闭该功能。全新的 `SessionStart` 永远是 no-op：默认 onboarding pack 负责全新定向。两个运行时都为下一条提示保留 `PostCompact` 到期状态。除此之外 hook 是静默 no-op，遇到无关 hook 错误也静默降级。一个已配置 REF 解析失败，则在投递载荷里**响亮地**降级（同时仍完成 hook）——refocus 绝不能打断席位的回合。

因为 hook 跑在席位自己的回合边界上，投递到一个*运行中*席位不需要重启、不需要操作员动作、也不产生消息流量：席位处理的下一条提示就带着内容。延迟上界是"席位的下一个回合"，而那本来也是新定向最早能被付诸行动的时刻。

## 内容可配置 —— 且在源码里绝不项目特定

解析顺序：

1. `OPENRIG_REFOCUS_CONTENT_REF` —— 一个类路径的上下文库引用，经 `zrig context get` 解析，好让 refocus 拿到和按需拉取一样的装配字节。REF 和 FILE 都设了时，这一条赢。
2. `OPENRIG_REFOCUS_CONTENT_FILE` —— 一个操作员撰写的文件（通过 spec env 按席位或按工作组）。
3. `$OPENRIG_HOME/refocus/REFOCUS.md` —— 实例的常设内容。
4. `skills/refocusing/references/refocus.md` 里的通用默认：三个项目中立的定向问题、阶梯本身，以及指向单独发布的 onboarding 资产的指引。

hook 在投递载荷里点名解析到的 REF。如果 REF 解析失败，载荷以 `REFOCUS CONTENT REF FAILED` 开头，附上确切的 ref 和解析器的原因，然后继续给通用定向。一个坏 ref 因此保持可见，却不挡住席位的会话边界。REF 未设时，既有的 FILE 和通用路径不变。

任务目标、项目或 box 特定的 refocus 文本，属于需要它的那个实例上的一个上下文库条目或其中一个 FILE。**它绝不能被提交进产品源码**——随包默认不携带任何不通用的路径、席位名、任务目标或做法。

每次投递的 refocus 都把内容与公开 `refocusing` skill 的纯路径 trace 配对。配置 `OPENRIG_REFOCUS_TREES=topology|work|both` 和 `OPENRIG_REFOCUS_DEPTH=light|full`；可选的 `OPENRIG_REFOCUS_TOPOLOGY_NODE` 和 `OPENRIG_REFOCUS_WORK_NODE` 选定无法派生的起点。脚本通过实时配置解析 `topology.root` 和 `workspace.root`，把断链报告为缺口，而不是顺着指针跟下去。

这条自动 hook 路径是对 `zrig send --context` 这种一次性手动注入的补充；两种模式互不替代。

## 与 chain 文件的关系

chain 文件是定向内容持久的、按地址存放的家；refocus 通道是它的投递时刻表。今天加进某个工作组 `CRAFT.md` 的一个做法，通过运行中席位的下一次 refocus 指针到达它们，并通过随包默认值到达未来的安装（发现 → 策展 → 发布，见约定文档）。

## refocus 不是什么

refocus 纠正漂移；它不是 wake（wake 恢复活性，绝不能重新框定工作），也不是 checkpoint（一次刻意的阶段边界停顿）。该用轻量干预时却发了重干预，是最常见的自找停滞——hook 会自动发轻量的，这正是它的意义。
