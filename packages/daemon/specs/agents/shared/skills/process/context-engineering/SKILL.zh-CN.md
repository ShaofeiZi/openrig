---
name: context-engineering
description: >-
  用于设计、审查或调试智能体的上下文窗口如何被填充、裁剪或共享，包括决定哪些内容在启动时加载、哪些按需加载，控制安装包或常驻文件的大小，修复会偏航、重复自己或在任务中途忘记约束的智能体，规划压缩或摘要，决定使用单智能体还是子智能体，设计智能体之间的交接，或选择工具集。不用于改写提示语气、选择要固定的模型，或调试业务逻辑；这些是相邻但不属于本 skill 服务范围的场景。本文是 2024–2025 年的历史快照；对当下前沿模型不具规范性，见“状态”一节。
metadata:
  openrig:
    stage: provisional
---

# 传统上下文工程：2024–2025 年快照

## 状态：临时历史研究快照

本 skill 是对 2024–2025 年公开发表的上下文工程实践的临时历史研究快照。它**不是**规范性文档。未经重新验证，不要把它机械套用于当前前沿模型。若与之冲突，应以 OpenRig 当前 skills、用户的明确裁定，以及直接测得的 OpenRig 实践为准。以下方面在重新验证前尤其值得怀疑：压缩/摘要指导、最小预加载与宽泛预加载的取舍、即时检索的前提假设、固定上下文上限，以及单智能体与多智能体的建议。

本文精选提炼了面向编码智能体的公开优质上下文工程经验，来源于 Anthropic、OpenAI 以及领先实践者（Manus、Cognition、Chroma、LangChain、Drew Breunig 等）的一手资料。应在描述中点名的那些场景下加载；本文刻意不作为任何基础 walk 的默认组成部分。

---

## 1. 心智模型：什么是上下文工程

**定义。** 上下文工程是“在 LLM 推理期间，策划并维护最佳 token（信息）集合的一整套策略” 。它涵盖所有进入上下文窗口的内容：系统指令、工具定义、检索数据、消息历史和工具输出，而不只是提示词文本本身（Anthropic，*Effective context engineering for AI agents*）。Andrej Karpathy 的一个表述经 LangChain 普及开来：这是“用恰到好处的信息填充上下文窗口，以服务下一步”的精细艺术与科学。LLM 是 CPU，上下文窗口是它的 RAM，而你的工作是在每一步决定什么应当被加载进这块 RAM（LangChain，*Context Engineering for Agents*）。

**为什么它取代了提示工程。** 聊天机器人只是在单轮里回答一个问题，能用的就只有那一轮里塞得下的内容。智能体则是在循环中运行，在几十步乃至几百步里持续积累工具结果、文件内容和历史记录。改进不再主要来自于改写指令措辞，而是来自于*重布线*：智能体检索什么、以什么顺序检索，以及当窗口被填满时，哪些内容会被驱逐出去（Anthropic，同上）。Philipp Schmid 对这一现实后果的概括是：“智能体失败不只是模型失败；它们也是上下文失败。”很多时候，一个能力足够强的模型之所以做出愚蠢决策，只是因为它收到的上下文让这种愚蠢行为变得更可能（Schmid，*The New Skill in AI is Context Engineering*）。

**物理约束：注意力是一种预算，不是一个桶。** 有三种机制会让上下文成为稀缺资源，而不是免费存储：

1. **二次注意力。** 在 Transformer 中，每个 token 都会关注其他每个 token，也就是存在 n² 个成对关系。序列越长，模型越难捕捉这些关系；而模型训练分布通常又以短序列为主，所以专门处理跨全上下文依赖的参数更少。结果不是“到了某个点突然断崖式失效”，而是“呈现性能梯度”（Anthropic，*Effective context engineering*）。
2. **上下文腐化。** Chroma 对 18 个前沿模型的研究表明，随着输入长度增长，可靠性会下降，哪怕任务本身极其简单，只是做检索或文本复制；而且这种下降远在窗口真正塞满之前就已经开始。影响因素不只有长度：干扰项是否存在、needle 与问题的相似度、以及 haystack 的结构，都会改变性能崩溃的速度（Chroma，*Context Rot*）。
3. **位置效应。** 模型会呈现 U 形注意曲线：在长上下文中，位于开头或结尾的信息比位于中间的信息更容易被有效利用（Liu et al.，*Lost in the Middle*）。

**一句话纪律。** Anthropic 的说法是：**“找到最小的一组高信号 token，以最大化某个期望结果发生的概率。”** 本文中的所有技巧，本质上都在服务于这一句话。

**你在工程化的组件。** Schmid 的盘点很适合作为检查清单，用来列出实际占据窗口的内容：（1）系统指令，（2）用户眼前这次请求，（3）当前会话的状态/历史，（4）长期记忆，（5）检索得到的外部信息，（6）工具定义，（7）输出格式规范（Schmid，同上）。每一项都是一个独立旋钮。智能体行为异常时，按这个列表逐项追问：“是哪一项缺失了、过期了、臃肿了，或者彼此矛盾了？”

---

## 2. 核心原则（以及每个原则背后的原因）

**P1 — 最小不等于短；要为信号密度做策展。** 目标是最小的、但*足够*的 token 集合，而不是最短的提示。系统提示应该完整勾勒预期行为；真正的原罪不是长度，而是低信号的填充废话（Anthropic，*Effective context engineering*）。

**P2 — 为下一步工程化，而不是为整个任务一次性准备。** 上下文是按每个推理步骤来策划的（Karpathy 经由 LangChain 转述）。问题永远不是“智能体也许将来可能需要什么”，而是“这一步要成功，需要什么”。这也是为什么在长任务里，把所有内容预先加载进去，通常不如按需即时检索。

**P3 — 退化先于耗尽发生。** 你的上下文预算应远低于厂商宣传的窗口大小。Chroma 展示了在窗口中段就会出现的严重退化；Breunig 汇总了运营层面的证据：某个 Gemini 智能体在超过约 100K tokens 后，规划质量崩溃，开始重复过去动作；Databricks 则发现 Llama 3.1 405B 在约 32K 处正确率开始下降（Breunig，*How Long Contexts Fail*）。*[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]* 这些具体天花板依赖模型、也依赖时间；真正持久的教训是：每个模型都有这样的阈值，而且通常低于规格表。

**P4 — 稳定性就是金钱和延迟：为 append-only 设计。** Manus 把 KV-cache 命中率称为“生产级 AI 智能体最重要的单一指标”：缓存输入 token 可能比未缓存便宜 10 倍（其示例数字是 $0.30 vs $3.00/MTok）。*[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]* 只要有一个 token 变了，它后面的缓存就会全部失效。因此要追求稳定的提示前缀（永远不要在顶部嵌入时间戳）、append-only 的上下文（会话中不重写历史），以及确定性的序列化（Manus，*Context Engineering for AI Agents*）。Anthropic 的缓存文档也确认了这一机制：必须精确前缀匹配，缓存读取价格是基础价格的 0.1x，而且存在严格的 tools → system → messages 层级；任一层级发生变化，都会让其下方的全部缓存失效（Anthropic，prompt caching docs）。

**P5 — 注意力有形状；放置和刷新都应顺着它。** 由于存在 U 形曲线（Liu et al.）和近因效应，持久性指令应放在最前面，而*当前目标*应在靠近末尾的位置被重新浮现。Manus 把这操作化为**recitation**：智能体会重写一个 `todo.md`，并在每一步把它追加在上下文后部，相当于“把目标背诵进上下文末尾”，以防在大约 50 次工具调用的任务中出现目标漂移（Manus，同上）。

**P6 — 失败属于上下文，不是垃圾。** 失败的动作和堆栈追踪要留在上下文里；这样模型才会更新自己的隐含判断，并停止重复同样的错误（Manus，同上）。12-Factor Agents 的版本是：“Compact Errors into Context Window”。也就是要以高效方式表示失败，让它们对下一步产生指导，而不是要么消失不见，要么把窗口彻底淹没（HumanLayer，*12-Factor Agents*，Factor 9）。

**P7 — 共享决策，而不只是共享事实。** Cognition 有两条原则：“共享上下文，并共享完整的 agent trace，而不只是单条消息”；以及“动作携带隐含决策，而相互冲突的决策会导向糟糕结果”。两个 worker 即使拿到相同的任务摘要，如果看不到彼此的 trace，也会做出不兼容的隐含选择。他们举的例子是：多个子智能体为同一个游戏分别开发出视觉风格彼此冲突的部分（Cognition，*Don't Build Multi-Agents*）。任何只传结论、不传结论背后决策的交接或摘要，都会在最容易把系统搞坏的地方发生有损压缩。

**P8 — 校准指令的高度。** 系统提示通常会朝两个方向失效：一端是写成硬编码的脆弱 if-else 逻辑，既易碎又难维护；另一端是模糊的高层指导，且“错误地假设了共享上下文已经存在”。目标是“足够具体，能有效引导行为；同时又足够灵活，能提供强启发式”。先用一个能力强的模型，从精简提示开始，然后依据实际观察到的失败模式加指令，而不是靠猜（Anthropic，*Effective context engineering*）。

**P9 — 掌控窗口；把智能体视为其上下文的函数。** 要有意识地控制模型接收到什么，而不是默认接受框架给你的东西（“Own your context window”，Factor 3）；并把智能体设计为“一个无状态 reducer” ，也就是输出纯粹由你组装出来的上下文所决定。这样一来，上下文 bug 就能被复现，也能被测试（HumanLayer，*12-Factor Agents*，Factors 3 and 12）。

---

## 3. 技术目录

LangChain 的分类法把几乎所有内容都归入四种动作：**write**（持久化到窗口外）、**select**（把正确的东西拉进来）、**compress**（压缩当前已有内容）、**isolate**（跨上下文拆分）(LangChain，*Context Engineering for Agents*)。下面是各项具名技术：

### 3.1 渐进式披露

**是什么：** 以分层方式组织知识，让智能体只加载当前任务需要的那一层。Anthropic 的 Agent Skills 是经典设计：第 1 层是名称和 description 元数据（永远留在 system prompt 里，只够让模型知道*什么时候*该用这个 skill），第 2 层是 `SKILL.md` 正文（在相关时加载），第 3 层及以上是打包的文件与脚本，智能体“只在需要时”才继续往下探索。这样一来，上下文就变得“实际上无上限”，因为内容在被需要之前根本不会进入窗口（Anthropic，*Equipping agents for the real world with Agent Skills*）。

**为什么有效：** 它把 token 成本转换成了指针成本。Anthropic 使用的类比是“给新员工的入职指南” 这种知识是按分区组织、按需逐步吸收的。

**何时使用：** 任何反复出现的领域知识、工作流或参考资料。Claude Code 文档给出的经验法则是：始终加载的文件（`CLAUDE.md`）只应包含那些几乎适用于每个会话的内容；凡是带情境性的东西，都应放进按需加载的 skill（Claude Code best practices）。

### 3.2 即时检索（与预先计算的上下文相比）

**是什么：** 智能体只维护轻量级标识符，例如文件路径、查询词、URL，然后在运行时用工具加载数据，而不是一上来把所有内容都塞给它。这很像人的认知方式：我们不会背下整个语料库，而是保留组织系统，并在需要时检索。元数据本身也是信号，比如目录层级、命名约定和时间戳（Anthropic，*Effective context engineering*）。

**权衡：** 运行时探索比预计算检索（embedding/RAG）更慢。生产环境中的答案通常是**混合式**：预先给一些上下文来换取速度，同时保留工具让智能体自主探索，这正是 Claude Code 的 `CLAUDE.md` 加 `grep` 模式（Anthropic，同上）。经典 RAG，也就是“有选择地加入相关信息，帮助 LLM 生成更好的回答”，在语料库很大、且缺乏可利用结构索引时，依然是正确方案（Breunig，*How to Fix Your Context*）。

**何时使用：** 对编码智能体而言，如果环境可导航（文件系统、git、API），优先选择即时检索；如果面对的是大型非结构化语料，优先用索引检索；若延迟敏感，就做混合式。

### 3.3 压缩和汇总

**是什么：** 当窗口接近上限时，对轨迹做摘要，用摘要重新初始化，然后继续执行。Claude Code 会在接近窗口上限时自动压缩（LangChain 提到大约是在 95%）；模型会提炼出决策、代码模式和未闭环的线程，同时丢掉冗余的工具输出（Anthropic，*Effective context engineering*；LangChain，同上）。

**如何调优：** “先最大化 recall，确保你的 compaction prompt 能从 trace 中抓住所有相关信息；再迭代提升 precision，删除多余内容”（Anthropic，同上）。好的摘要提示会强制时间顺序、结构化分区（environment、尝试过的步骤、当前状态），并对不确定事实显式打上 `UNVERIFIED` 标记，因为“如果一个错误事实进入摘要，它就可能污染未来行为”（OpenAI Cookbook，*Session memory*）。

**裁剪 vs. 摘要**（OpenAI Cookbook，同上）：保留最后 N 轮对话的裁剪策略是确定性的、零延迟、易于推理，但会粗暴地突然丢失旧约束。LLM 摘要则能较紧凑地保留长期决策，但会引入延迟尖峰、漂移风险和更高的可观测性负担。裁剪适合大量工具调用、彼此独立的任务；摘要适合长期跨度工作，在这类工作里，累积决策本身很重要。

**Cognition 的提醒：** 他们推荐用一个专用 compressor model 来提炼“关键细节、事件和决策”以支撑长任务，但也明确指出，这件事“很难做对”。所谓做对，指的是既抓住决策，也抓住决策背后的理由，而不只是罗列事实（Cognition，同上）。

### 3.4 上下文编辑 / 工具结果清理

**是什么：** 这是最轻触式的压缩方法：自动丢弃历史深处那些已经过时的工具调用和结果，同时保留对话主线。Anthropic 把它作为“context editing”推出；测得的效果是：单用 context editing，就让他们的内部 agentic-search 评测提升了 29%；与 memory tool 结合则提升 39%。在一个 100 轮的 web-search 评测里，它让智能体能够完成原本会因上下文耗尽而中途死亡的工作流，同时把 token 消耗削减了 84%（Anthropic/Claude，*Context management*）。

**这里有一个张力：** 它与 P4（为了缓存而 append-only）以及 P6（保留失败）存在冲突。协调方式是：清掉那些*体积庞大、已经陈旧、并且已被消费过*的工具输出，例如 40 轮前某次 30K-token 的文件读取；但要保留*决策和失败*。Manus 的版本强调信息应当是*可恢复的*：删掉网页正文，但保留 URL；删掉文档正文，但保留文件路径（Manus，同上）。

### 3.5 结构化笔记（智能体记忆）

**是什么：** 智能体会把笔记写到窗口之外的持久化存储里，比如 `NOTES.md`、`todo.md` 或一个 memory 目录，并在相关时再把它们拉回。这样就能以极低的上下文开销实现持久记忆。Anthropic 的例子是：Claude 在玩 Pokémon 时，能够“在数千个游戏步骤中保持精确计数”，构建地图，并在跨越数小时的会话里记住策略（Anthropic，*Effective context engineering*）。Anthropic 的 memory tool 则把这件事产品化成了一个基于文件的 CRUD 系统，存放在客户端 memory 目录中，并能跨对话持久存在（Anthropic/Claude，*Context management*）。

**一般形式：文件系统就是终极上下文。** Manus 把文件系统视为一种记忆：它“容量无限、天然持久，并且智能体本身就能直接操作”（Manus，同上）。Breunig 给这一类方法起的名字是 **context offloading**；哪怕只是一个简单的 scratchpad（`think` 工具），在专用 agent benchmark 上也带来了最高 54% 的提升（Breunig，*How to Fix Your Context*）。

**实践中的记忆层次**（综合 LangChain、Anthropic 与 OpenAI）：（1）上下文内工作记忆，也就是当前窗口；（2）会话级 scratchpad / todo 文件；（3）跨会话持久记忆，也就是通过相关性检索回来的文件或存储；（4）始终加载的精选核心（`CLAUDE.md` 类文件），且必须保持极度精简。信息应该随着其“经证明确实持久”的程度，沿着这条栈*向下*流动；而每下一层，换来的持久性都要以检索可靠性为代价。

### 3.6 子智能体和上下文隔离

**是什么：** 这是 Breunig 所说的“context quarantine”：把工作隔离到专用线程中，每个线程都拥有自己的上下文窗口（Breunig，*How to Fix Your Context*）。Anthropic 的 research system 是代表性案例：一个 orchestrator 会并行生成多个 subagent，每个 subagent 都在一个干净窗口中探索某一方面，然后各自返回一个*压缩过的*摘要给协调者，通常是 1,000–2,000 tokens。“Subagents facilitate compression by operating in parallel with their own context windows”（Anthropic，*Multi-agent research system*）。在他们的内部 research 评测中，多智能体系统比单智能体 Claude Opus 4 高出 90.2%，代价则是大约 15 倍于普通聊天的 token 消耗（Anthropic，同上）。

**何时它会赢：** 读多写少、可并行、偏广度优先的工作，例如研究、代码库调查、评审。这类任务里，worker 的输出本来就是供 orchestrator 汇总整合的“报告”。Claude Code 的建议正是如此：“用 subagents 去 investigate”，这样探索过程会消耗一次性上下文，而不是污染你的主上下文；同时还建议用一个 fresh-context subagent 做对抗式审查，因为“fresh context improves code review since Claude won't be biased toward code it just wrote”（Claude Code best practices）。

**何时它会输：** 写多、且连贯性至关重要的工作。Cognition 的论点（P7）是：并行 worker 会做出彼此冲突的隐含决策，而当前模型还不具备把这些冲突充分协商掉的能力；因此，“running multiple agents in collaboration only results in fragile systems” 对于软件构建尤其如此。他们给出的处方是：用一个拥有完整 traces 的单智能体，再配一个 compressor（Cognition，同上）。OpenAI 的 builder guidance 也指向同一个方向：先尽量榨干单智能体的能力，只在单智能体复杂度已被证明无法支撑时，才动用多智能体编排（OpenAI，*A practical guide to building agents*）。二者如何调和，见 §6。

### 3.7 结构化交接与委托契约

**是什么：** 当上下文必须跨越智能体边界时，这种传递应当是一个工程制品，而不是靠感觉。Anthropic 反复踩坑后总结出的规范是：每个委派任务都必须包含**objective、output format、对工具和来源的 guidance，以及清晰的 task boundaries**。缺少这些时，“agents duplicate work, leave gaps, or fail to find necessary information”（Anthropic，*Multi-agent research system*）。

**工作量伸缩也应进入契约：** 要明确写出规则，例如“简单事实查找只需要 1 个 agent、3–10 次工具调用；直接比较类问题可能需要 2–4 个 subagent，每个 10–15 次调用”。否则 orchestrator 就会严重过度配置，Anthropic 的早期版本甚至会为一个简单问题生成 50 个 subagent（Anthropic，同上）。

**返回结果本身也是契约。** worker 的回传本身就是一次压缩步骤（依 §3.6，通常是 1–2K tokens），因此会继承 §3.3 中的所有摘要风险。只汇报结论、不汇报形成这些结论的决策过程，就违反了 P7。单人版对应的是 “spec-then-fresh-session” 模式：先访谈并写出一个自包含的 `SPEC.md`（包含文件、接口、明确的 out-of-scope、以及端到端验证步骤），然后在一个干净的新会话里执行它（Claude Code best practices）。

### 3.8 工具装载和工具设计

**选择：** “Every model performs worse when provided with more than one tool” 是 Breunig 从 Berkeley function-calling 数据中提炼出的醒目标题；一份量化后的 Llama 3.1 8B，在提供 46 个工具时失败，但在提供 19 个工具时成功（Breunig，*How Long Contexts Fail*）。动态工具选择，也就是对工具描述做 RAG，可让 Llama 3.1 8B 的表现提升 44%（Breunig，*How to Fix Your Context*）；LangChain 引用的是同一类技术，称工具选择准确率可提升约 3 倍（LangChain，同上）。Anthropic 的设计规则则是：工具间的重叠必须尽可能小。“如果一个人类工程师都无法明确判断在某个场景该用哪个工具，那就不能指望智能体做得更好”（Anthropic，*Effective context engineering*）。

**响应设计：** 工具输出本质上就是一次上下文注入，因此要把它当成工程对象来设计。要提供分页、过滤和截断，并配上合理默认值（Claude Code 会把工具响应限制在 25,000 tokens *[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]*）；应优先用有语义的名字，而不是 UUID；可提供 `response_format: concise|detailed` 这样的开关；把一串细粒度调用整合为一个更高层工具（例如用 `schedule_event`，而不是 `list_users` + `list_events` + `create_event`）；还要用错误消息把智能体引向更高效的策略，比如“many small targeted searches”（Anthropic，*Writing effective tools for agents*）。CLI 工具通常是所有集成界面里上下文效率最高的一种（Claude Code best practices）。

**遮蔽优于删除：** 在会话中动态移除工具，会让 KV cache 失效，并让模型对过去引用过的东西产生困惑；更好的做法是对 token logits 做 masking，以限制可选项，同时保持工具定义稳定不变（Manus，同上）。

### 3.9 上下文预算和缓存纪律

**是什么：** 把窗口视为一种需要预算管理的资源，并制定明确的支出计划：system + tools 占多少，为任务本身预留多少，到什么填充比例时触发压缩。Claude Code 文档说得很直接：“The context window is the most important resource to manage”，而其 UX（`/context` 检查器、状态栏用量跟踪、`/clear`、定向 `/compact`）本质上都是预算管理工具（Claude Code best practices）。Chroma 给出的实用推论则是：若追求高准确率，应把工作预算设在远低于标称窗口大小的位置（Chroma，同上）。

**缓存纪律（也就是 P4 背后的机制）：** 以“静态优先”的顺序组织提示（tools → system → messages）；把缓存断点放在最后一个*稳定*区块之后，而不是放在每次请求都会变的内容后面；并通过 cache-read / cache-write token 计数验证缓存命中，而不是想当然。只要在折叠线以上出现一个时间戳，你就会在每次请求中永久支付 cache-write 的价格（Anthropic，prompt caching docs；Manus，同上）。

**few-shot rut：** 如果上下文里反复出现统一、重复的 action-observation 模式，模型会学到的是节奏，而不是实质，导致“漂移、过度泛化，有时甚至产生幻觉”。解决方式是在序列化格式和措辞上引入结构化变化（Manus，同上）。

---

## 4. 故障模式

Breunig 的四分法（*How Long Contexts Fail*）已经成了该领域的共同词汇；下面这些故障模式应该按名字熟悉：

1. **上下文中毒**：也就是“一个幻觉或其他错误进入了上下文，并被反复引用”。Gemini 玩 Pokémon 的智能体就曾污染了自己的 goals 区块，随后一路追求不可能完成的目标。最恶劣的情况往往发生在摘要里：一个错误事实进入压缩摘要后，会污染后面的每一轮（OpenAI Cookbook，同上）。*缓解方式：* 持久化前先验证，对不确定事实标记 `UNVERIFIED`，保持摘要可审计，并把高风险探索隔离到 subagent。
2. **上下文分心**：上下文长到一定程度后，“模型会过度关注上下文本身，而忽视它在训练中学到的东西”。典型症状是重复过去动作，而不是综合出新计划（某个 Gemini 案例在约 100K tokens 后出现过这一问题 *[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]*）。*缓解方式：* 预算控制、压缩、recitation。
3. **上下文混乱**：也就是“上下文中的多余内容被模型用来生成低质量响应”。最大驱动因素通常是过大的工具装载。*缓解方式：* 工具 loadout 选择、修剪、渐进式披露。
4. **上下文冲撞**：上下文里累积了彼此冲突的信息和指令。Microsoft/Salesforce 测得，当提示被分片到多轮对话中时，性能平均下降 39%；o3 从 98.1 掉到 64.1。原因在于模型“会在早期轮次做出假设……而一旦 LLM 在对话里走错，它就会迷失并且无法恢复”。*缓解方式：* 执行前先把需求整合清楚（先写 spec），以及在必要时直接清空重来，而不是在污染过的上下文里反复纠错。

再加上生产系统里的操作性故障：

5. **大规模上下文腐化**：在窗口还没满时，就已经悄悄开始退化（Chroma）。
6. **协同故障**：重复劳动、信息缺口、一个简单查询却起了 50 个 subagent、并行 worker 之间做出相互冲突的隐含决策（Anthropic，*Multi-agent*；Cognition）。
7. **大杂烩会话与纠错螺旋**：Claude Code 文档点名的人类环路版本是：不相关任务共用一个窗口；以及反复纠错，把一堆失败方法污染进上下文。“两次修正都失败后，就 `/clear`，然后把你学到的东西吸收进一个更好的初始提示。” 另一个相关问题是始终加载文件写得过于臃肿：“Bloated `CLAUDE.md` files cause Claude to ignore your actual instructions”。对于每一行都应问一句：“删掉它会导致错误吗？”如果不会，就删（Claude Code best practices）。
8. **lost-in-the-middle 式摆放 bug**：关键约束被埋在 120,000 tokens 里的第 60,000 个位置（Liu et al.）。

---

## 5. 最好的团队如何运作

**他们会测量一切与 token 形状相关的东西。** Anthropic 发现，单单 token usage 就能解释他们 research 评测里 80% 的性能方差（Anthropic，*Multi-agent*）；Manus 则把 KV-cache hit rate 作为最顶层的生产指标（Manus）。顶尖团队会先对上下文做埋点，测填充水平、缓存命中率、每任务 token 消耗，再去谈理论。

**他们会围绕观察到的失败迭代，并让模型参与这个闭环。** Anthropic 在工具和 skill 上的方法都是 eval-first：构造代表性任务，观察真实 transcript，让模型批评自己的失败，继续改进，然后用保留集重跑（Anthropic，*Writing effective tools*；*Agent Skills*）。提示从精简开始，只在失败模式真正提出需求时才增长（P8）。而且自动评测并不够：Anthropic 的人工测试者曾发现，他们的智能体“稳定地选择 SEO 优化内容农场，而不是权威来源”，这是一种上下文质量故障，而程序化评测完全没看出来（Anthropic，*Multi-agent*）。

**他们会把始终加载的核心压到极小，并把其他所有内容都藏在按需披露之后。** `CLAUDE.md` 这类签入仓库的文件，只放那些对每个会话都普遍适用的内容；其他带情境性的内容全部进 skills；修剪是日常维护的一部分，“treat `CLAUDE.md` like code”（Claude Code best practices）。

**他们会围绕验证和 fresh context 设计写入路径。** 典型流程是 Explore → plan → implement → verify，用 plan mode 把研究和执行隔开；还要准备一个智能体自己就能运行的检查手段（测试、构建、截图 diff 等），让闭环不依赖人；spec 要在 fresh session 中执行；对抗式审查则放进一个 fresh subagent context 里（Claude Code best practices）。

**他们会围绕缓存和文件系统来工程化系统。** 稳定前缀、append-only 历史、mask 而不是 remove 工具、把文件当成无限且可恢复的记忆、用 recitation 稳住目标、把错误保留在可见位置（Manus）。这些既是质量实践，也是生产经济学实践。

**他们会让架构贴合任务形状。** Anthropic 自己的选择启发式是：长对话流用 compaction；带里程碑的迭代型工作用 note-taking（编码很符合这一类）；可并行探索的研究型任务用 multi-agent（Anthropic，*Effective context engineering*）。

---

## 6. 决策指南

| Situation | Reach for | Source |
|---|---|---|
| 反复出现、但只是有时需要的领域知识 | 具备渐进式披露的 skill | Anthropic Skills |
| 每个会话都需要的规则 | 极小而精心策展的始终加载文件；毫不留情地修剪 | Claude Code docs |
| 大型、可探索的环境（repo、filesystem） | 通过工具做即时检索；若受延迟约束则做 hybrid | Anthropic CE |
| 大型非结构化语料 | 索引检索（RAG） | Breunig |
| 长任务接近窗口上限 | 压缩（先 recall，后 precision）；或清理陈旧工具结果 | Anthropic CE / context mgmt |
| 带里程碑的长任务 | 结构化笔记 + todo recitation | Anthropic CE, Manus |
| 跨会话持久化 | 窗口外的文件型记忆 | Anthropic context mgmt, Manus |
| 广度优先的研究 / 调查 / 评审 | 并行 subagent、压缩回传、显式 delegation contract + effort scaling | Anthropic multi-agent |
| 围绕单一工件进行连贯构建 / 编辑 | 单智能体、完整 trace、必要时用 compressor 控长度，而不是并行 worker | Cognition |
| 可用工具很多 | 选择 loadout；整合；命名空间化；避免重叠 | Breunig, Anthropic tools |
| 成本 / 延迟压力大 | 稳定前缀 + append-only + cache breakpoints；mask，不 remove | Manus, Anthropic caching |
| 智能体在重复自己 / 偏航 | 优先怀疑 distraction：检查填充水平，压缩或清理，并复述目标 | Breunig, Manus |
| 智能体对早先“事实”非常自信但明显错误 | 优先怀疑 poisoning：审计摘要和笔记，从干净 spec 重新开始 | Breunig, OpenAI Cookbook |

---

## 7. 有争议的地带与薄弱点（编者标注）

- **多智能体 vs. 单智能体确实是有争议的。** Anthropic 的 90.2% 胜率结果（读多型 research）与 Cognition 的 “don't build multi-agents”（写多型工程）都属于一手资料，也都可信。它们的调和方式取决于任务形状：*读取*可以并行化，*写入*应串行化，而且每一个跨边界传递都必须是工程化契约。两边都该呈现，不要粗暴压成一条规则。
- **所有数值上限都具有时效性。** 32K/100K 的 distraction 阈值、最小可缓存 token 数、10x 的缓存价格比、25K 的工具响应上限，都是特定模型、特定厂商、特定时段（2025–2026）的快照。应学习其机制，而不是死记数值；数值要重新验证。
- **部分数字是二手综合。** 44% 的工具选择收益、54% 的 think-tool 收益、39% 的分片提示跌幅，以及 Berkeley 的工具数量实验，都是经由 Breunig 汇总第三方论文得到的。方向上可信，但本文未独立复核。
- **OpenAI 公开可见的上下文工程语料，比 Anthropic 薄。** 他们最好的材料主要来自 SDK cookbook（尤其是 trimming vs. summarization 部分，质量确实高）以及通用 agents 指南；多数具名技术文献仍主要来自 Anthropic 和一线实践者。
- **长上下文 vs. 检索，仍未定局。** 窗口不断变长，总会重新激起“那就全塞进去吧”的冲动；而 context rot 始终构成反驳。但这种平衡会随着每一代模型变化而变化。

---

## 来源

1. Anthropic — Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. Anthropic — 我们如何构建多智能体研究系统 — https://www.anthropic.com/engineering/multi-agent-research-system
3. Anthropic — 为现实世界的智能体配备智能体技能 — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
4. Anthropic — 为智能体编写有效的工具 — https://www.anthropic.com/engineering/writing-tools-for-agents
5. Anthropic/Claude — 在 Claude 开发者平台上管理上下文（上下文编辑、记忆工具） — https://claude.com/blog/context-management
6. Anthropic — Claude 代码最佳实践 — https://code.claude.com/docs/en/best-practices
7. Anthropic — 提示缓存文档 — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
8. Chroma — Context Rot：增加输入 token 如何影响 LLM 性能 — https://www.trychroma.com/research/context-rot
9. Drew Breunig — 上下文失败多长时间 — https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html
10. Drew Breunig — 如何修复你的上下文 — https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html
11. Cognition — 不要构建多智能体 — https://cognition.com/blog/dont-build-multi-agents
12. Manus (Yichao "Peak" Ji) — AI 智能体的上下文工程：构建 Manus 的经验教训 — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
13. LangChain — 智能体的上下文工程 — https://www.langchain.com/blog/context-engineering-for-agents
14. Philipp Schmid — AI 中的新技能是上下文工程 — https://www.philschmid.de/context-engineering
15. HumanLayer (Dex Horthy) — 12 因子智能体 — https://github.com/humanlayer/12-factor-agents
16. Liu et al. — Lost in the Middle: How Language Models Use Long Contexts — https://arxiv.org/abs/2307.03172
17. OpenAI — 构建智能体实用指南 — https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
18. OpenAI Cookbook — 上下文工程：使用 Sessions 进行短期记忆管理 — https://developers.openai.com/cookbook/examples/agents_sdk/session_memory
