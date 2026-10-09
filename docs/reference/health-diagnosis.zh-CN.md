# 智能体操作的系统健康诊断

当一个已配置检测器需要解释时，System Health 可以给负责智能体一个持久调查包。该包保留发现、策略版本、证据和当前权威文档。它邀请智能体在那个选择之外调查，包括它自己的贡献。它不下病理诊断，也不执行纠正动作。

## 启用一个有界诊断循环

纯流程诊断还需要在发现的解析范围上有一个显式委派操作姿态。对解析后未设范围，人类主导是可见产品默认；失败或歧义范围读保持未知。两种情况下发现都可检视。关于刻意转换、阶段/来源信息和共享健康契约，见[范围操作姿态](scoped-operating-posture.md)。

```sh
zrig health policy --json > effective-policy.json
jq '.policy' effective-policy.json > health-policy.json
# 编辑 health-policy.json：diagnosis.enabled=true 且 diagnosis.owner=<seat@rig>。
zrig health policy --file health-policy.json
zrig health diagnose                    # 预览；不写、不唤醒
zrig health diagnose --apply            # 现在评估并应用准入动作
zrig health diagnosis list
zrig health diagnosis show <qitem-id>
```

`diagnosis list` 和 `diagnosis show` 默认在文本和 JSON 里都是摘要。详细文本摘要显示队列状态、owner、阻塞、处置、不确定性、发现身份和权威引用。摘要 JSON 还保留仪式基础和当前收据身份。它保持对象/数组形状，加 `readView`：`complete`、`omittedFields`（路径、JSON 字节数和数组计数）、`fullJsonBytes` 和确切 `fullCommand`。包拷贝、权威内容、证据数组和诊断收据台账被显式省略。当前工作流收据信封保留，`evidenceIdentity` 带识别出的 cut/candidate、verdict 和证据引用字符串；它们不透明证据被省略。这些身份标签不校验一张收据。摘要不是完整证据。字节数描述紧凑 JSON 序列化（不含尾换行），不是模型 token 数。

对需要旧完整 JSON 的调查或既有消费者：

```sh
zrig health diagnosis show <qitem-id> --full --json > diagnosis.json
zrig health diagnosis list --full --json > diagnoses.json
```

`--full` 不带 `--json` 把完整记录打印成格式化 JSON。这些展开可能很大。裸 `--json` 不再含所有证据字段；把这些字段的消费者迁到 `--full --json`。HTTP API 响应和变更结果 JSON 不变。智能体按诊断行动前仍需完整上下文；生成的调查包点名那条命令。

daemon 每分钟检查一次启用的策略。`health policy` 报告那次检查是否已调度及其上次结果，包括错误。普通 `health` list/explain 命令保持观察性。诊断默认禁用；仪式放大是唯一默认诊断触发。一个持续插曲保持一个 qitem，默认最多再呈现一次，并跨插曲共享一个 owner 冷却（默认一小时）。一个处置停止再呈现。禁用策略停止自动准入和呈现。所有权变化不静默改路由既有发生项。受管席位外，用 `zrig health --actor <name> ...` 点名写者。受管席位移送身份优先于那个声明名。只有发生项的指派 owner 可记录其处置或请求人类通知。其他智能体可建议 owner；策略 owner 变化不授予既有发生项的监护权。写在队列转移上保留发送者身份来源。

策略控制检测器启用、仪式/评审/唤醒阈值、来源观察窗口和新鲜度、诊断 owner、冷却、再呈现边界和人类上报条件。编辑纯 JSON 并用命令应用；未知键和无效值拒绝而不改策略。已应用提案及其前驱保留在配置 OpenRig home 的 `health/policy-history/`。生效版本还含既有 `health.context_pressure.warning_percent` 和 `critical_percent` 设置，仍可用 `zrig config` 配置。默认 95 和 99。CLI/TUI 发现解释显示所用策略版本。

## 被动仪式诊断

普通队列活动可以准入一个诊断，而不需要一个健康检查点。来源发现在观察窗口里触及的声明移交族，用它们显式 `project:` / `mission:` / `slice:` 标签和工作流成员关系，收集确切转移 ID、正常 project/mission/slice 权威、进度和证明引用、以及工作流关闭证据。它绝不解释 Markdown，也不把证明文件数、批准、C1 配对、提交、测试或终端行当成接受的产品结果。

在配置流量阈值（默认 20 次转移），一个新的、完整的族变成 `ceremony.stage=needs-diagnosis`、`status=indeterminate`、`severity=info`。CLI/TUI 叫这**需要诊断**，不是一个已确认警告。启用的诊断策略准入一个有界包，即使产品分母未知。普通不可用/陈旧检测器记录仍不合格。诊断和人类通知流量从分子排除，不能递归生成另一个调查。

智能体读实际证据，包括所供引用之外的，解析语义结果粒度和后果边界。用既有处置命令，带一个可选 `progress` 结果：

```json
{
  "basis": "<diagnosis show 里当前 finding.ceremony.basis>",
  "conclusion": "established",
  "outcomes": [{"id": "<不同的有意义结果>", "observedAt": "<测量区间内时间>", "evidenceRefs": ["<正常证明路径>"]}],
  "boundedAuthority": false,
  "boundary": "<所选 SDLC 边界，以及为什么这个结果普查覆盖该区间>",
  "evidenceRefs": ["<检视过的权威/证据路径>"],
  "missingFacts": []
}
```

把这个对象放在 `progress` 里，挨着既有 verdict/steering/uncertainty 字段。`established` 为确切区间断言一个完整普查；空结果列表断言零结果，不是发现失败。`false-positive` 清除嫌疑而不发明一个分母（当无缺失事实剩余时）。一个仍点名缺失事实的 false-positive 评估保持 indeterminate，不关插曲区间。`indeterminate` 不供结果，在 `missingFacts` 里点名缺失事实。必需引用必须在工作区内解析；初始包之外的额外证据允许。收据保留实际行动者、时间戳、身份来源、来源基础和证据哈希。一个变化的 basis 拒绝陈旧提交。后来的证据变化让确认变成 indeterminate，而不是保留一个错误比率。结果含义仍是归属的智能体判断。

只有一个 established、当前的评估才允许一个比率。投影器从列出的不同结果和确切转移算它；一个合格比率、无 bounded-authority 反信号，变成 `confirmed` / `active` / `warning`。成比例或 bounded-authority 结果清除插曲。一个显式清除的评估标记那个区间结束；同族足够后来流量开始一个新插曲。重复读从不推进这些边界。一个发生项和既有 owner 冷却对每个插曲适用；一个处置停止重复请求。

这个有界来源覆盖显式链接的 project 或 mission 工作：每族最多 2,000 个触及 qitem、200 个根、1,000 个成员 / 10,000 次转移、200 个工作流收据、200 个声明 slice、每个选定 slice 100 个证明文件。溢出可见拒绝。上下文文件限 64 KiB。一个在保留窗口前开始的谱系保持 indeterminate，点名缺失区间。项目规划不需要后继 mission：一个显式项目身份解析它的当前上下文，mission 和 phase 缺失除非有证据。未链接或歧义工作保持范围 unknown，不能推断委派中断。缺席不是健康。包含缺失上下文引用，好让智能体点名或修它自己的知识缺口，而不制造源真相。

## 可选结果边界检查点

活队列转移本身不证明产品结果或一个有界操作的权威。在一个有意义结果边界，持有那些事实的智能体可以为一个 qitem 谱系和时间窗提交一次普查。设 `includeHandoffs: true` 跟随它声明的移交后代；这是在席位间传过的工作的正常路径。单根通常漏评审/返回流量。优先用既有 proof/progress/outcome 产物当证据。别给每次编辑或消息加检查点。这是对显式所供证据的回退；正常活动用上面的被动诊断。一个既有检查点拥有它的谱系，好让被动来源不造重复插曲。

```json
{
  "schema": "openrig.health-checkpoint/v0alpha1",
  "lineageQitemId": "<既有产品 qitem>",
  "includeHandoffs": true,
  "scope": {"type": "slice", "projectId": "<project>", "missionId": "<mission>", "sliceId": "<slice>"},
  "startedAt": "<ISO 时间戳>",
  "observedAt": "<ISO 时间戳>",
  "transitionIds": "derive",
  "productOutcomes": [
    {"id": "<outcome-id>", "observedAt": "<ISO 时间戳>", "evidenceRef": "<proof 产物路径>"}
  ],
  "productCensusRef": "<为本谱系/窗口建立完整结果普查的产物>",
  "boundedAuthority": {"applies": false, "evidenceRef": "<有界效果权威评估>"},
  "sdlc": {"expectation": "<所选组件和评审边界>", "evidenceRef": "<那个选择的权威>"},
  "authorityPaths": {
    "project": ["<当前项目 SPEC 和 project.yaml 路径>"],
    "mission": ["<当前 mission SPEC 和 mission.yaml 路径>"],
    "slice": ["<当前 slice SPEC 和 slice.yaml 路径>"]
  }
}
```

```sh
zrig queue transitions <既有产品 qitem>
zrig health checkpoint --file checkpoint.json
zrig health --instance --json
```

`transitionIds: "derive"` 让既有提交命令收一次完整普查，然后在检查点及其审计里保留确切 ID。作者供结果及其含义，不是逐行记账仪式。一个显式 ID 数组也支持，用于封存重放或调用者供普查。后来的读从不静默扩展任一形式。

daemon 校验转移 ID 是那个确切 qitem 和窗口的完整普查，含选定的所有移交后代。它不从相似名字或席位名推断共享谱系。完整转移普查可从队列台账组装；漏一个后代拒绝。计数族成员上的显式 mission/slice 标签必须匹配检查点范围；未标签后代继承声明的移交关系。界是 1,000 个链接 qitem 和 10,000 次转移；一个超大族拒绝，而不静默抽样。独立根是分开普查。它数那些转移和不同的、有证据的产品结果，解释比率两边、字面值 gate-tag 分解和所选 SDLC 期望。这些是监护/状态转移，不是关于每次评审是否有用的消息或判断。一个产品结果是一个不同的、有证据的用户可见结果；为达成同一个承诺结果所需的提交、测试跑、返回和修复，不各自再造一个分母单位。普查必须陈述它的结果粒度和覆盖。正反控制用同一粒度。空结果列表需要和非空列表一样的普查证据。一个不可用产品普查是空分母：解释说没算比率，而不静默替换零或一。`boundedAuthority.applies=null` 意思 unknown，绝不是 false。缺失 SDLC 选择（包括一个没有 `sdlc` 的旧检查点）让一个合格信号 indeterminate。引用对测量窗口生效的权威，不是后来纠正。比率标记一次检视；智能体在诊断放大前把它和那个选择及后果证据比较。产品结果含义、所选 SDLC 和有界效果权威仍是归属的撰写证据；它们不因摄入而被证明。发现标记那个来源，用中等置信。必需证据引用必须解析为配置工作区内非空、可读本地文件（最多 1 MiB）。支持绝对路径和相对该工作区的路径；其他引用种类（含段地址）仍不可用。解析的证据记录带 SHA-256；缺失文件和符号链接逃逸仍是归属主张，但迫使源真相 indeterminate，不能准入一个诊断。每次投影重查可用性；在场不认证产物含义。这个权威评估区别于供给诊断智能体的 project/mission/slice 文档。嵌入权威限于对应工作树节点上的 canonical `SPEC.md` 和 project/mission/slice YAML 文件，每个最多 64 KiB。其他路径和符号链接别名报不可用，不嵌入其内容。每条目保留其权威级别。项目文件必须在配置项目根；mission 文件必须属于发现的 mission；slice 文件还必须有一个兄弟 `SPEC.md` 声明发现的 slice ID（声明时匹配 mission）。一个兄弟 slice 或另一个 mission 不可用，即使它文件名是 canonical。无 mission/slice 范围时，那些权威级别不可用。

## 当前选定上下文与纠正

`diagnosis show` 和 `list` 在 `authorityReadAt` 刷新顶层 `authority`。原始 `packet.authority` 和呈现收据仍是历史快照。当保留包早于本指引时，当前 `guidance` 也仍可用。完整读含内容；摘要保留地址、哈希、可用性、选择来源和不可用来源理由。

读者复用 `project.yaml` 的 `install.context` 和选定 `lifecycle.profiles[profile].workflow.context_refs`，加当前 mission 的 `lifecycle.workflow.context_refs`。项目 owner 可以在那里选规划权威和相关因果纠正，甚至在任何 mission 存在前：

```yaml
install:
  context:
    - PREFLIGHT.md#current-authority
    - evidence/process-correction.md
```

这些是撰写选择，不是推断权威或可执行采纳。路径相对声明 manifest 解析，必须留在解析项目内。本地 `file.md#h2/h3` 地址用既有 Markdown 读者。缺失/歧义段、别名、不支持地址、unknown 范围和缺失选择文件保持不可用。链接不递归跟随，不猜后继 mission。读者接受最多 32 个选定地址，每个源文件最多 64 KiB，选定内容总计 128 KiB；超限显示为不可用引用。一个段的哈希确切覆盖返回的段字节。裸库引用和远程 URL 不由这个本地读者抓。

权威和当前用处是两个问题。一个不完整的全局结果普查不能证明保留一个前提已被证伪的特定限制合理。解释历史处置前读当前纠正，保留无关有效边界（如发布权威），区分自动唤醒/收据记账和有用 owner 行动。正常交互规划本身不是病理。在评估里陈述中断的相关性和成本；别把信号变成一个周期自审，或要求一个普适外部评审。

检查点在 `health/checkpoints/history/` 下审计；重放相同字节不写。后来的普查推进观察时间。高到高观察保留插曲身份；一个清除检查点和后来复发产生一个清除插曲和新 ID。读从不更新检查点状态。陈旧、不可用、矛盾、截断或缺失证据不能准入诊断。无发现不是一个健康断言。当前来源界是每检查点 200 谱系、10,000 转移、1,000 产品结果，每输入 1 MiB。不支持或无效来源可见失败。

## 调查并记录处置

读确切证据和当前权威。追溯模式从哪开始，测你自己的动作是否放大它，区分另一个席位或陈旧指引。第二意见可选。包是起点，不是闭合证据集。

```json
{
  "verdict": "insufficient evidence",
  "causalStart": null,
  "steering": "检视缺失结果证据；在当前权威内应用单独已确立的纠正。",
  "uncertainty": "所引产物尚未建立分母。",
  "evidenceRefs": ["<检视过的证据路径>"]
}
```

```sh
zrig health diagnosis record <qitem-id> --file disposition.json
zrig health diagnosis show <qitem-id>
```

Verdict 是 `false positive`、`early real condition`、`established pathology`、`insufficient evidence` 或 `resolved`。处置保留在诊断 qitem 的转移上，在 CLI 输出和队列可见。记录它不关闭或改变底层产品工作。变化的处置保留早先证词；确切重放是 no-op。检测器清除和一个智能体宣布问题解决分开记录。

一个可选 `correction` 保持因果判断、提议或已采取动作、以及后来行为效果分开。它不要求一个完整 `progress` 普查。比如，一个保留案例评估可记录：

```json
{
  "applicability": "已退役的紧急限制不再适用；发布仍需它单独决定。",
  "causalJudgment": "保留 trace 把限制持续归因于一个已证伪前提。",
  "action": {"state": "taken", "summary": "授权限制在保留案例里退役。", "evidenceRefs": ["evidence/correction-action.md"]},
  "effect": {"state": "unobserved", "summary": "未观察到后来自然机会。", "evidenceRefs": []}
}
```

把这个对象放在既有处置里 `verdict`、`causalStart`、`steering`、`uncertainty` 和 `evidenceRefs` 旁边。动作状态是 `proposed` 或 `taken`；效果状态是 `unobserved` 或 `observed`。每个引用产物必须本地可用；`taken` 和 `observed` 各需要证据。这些检查建立可用性，不建立因果真相。收据保留证据哈希，`assessment` 标识实际队列行动者、时间和转移。`behavioralEffect` 是最新 owner 报的效果，旧处置默认 `unobserved`。它不是独立认证。后来 owner 提交保留早先证词。只从真实后来机会记一个观察效果，带它下个决定、有用工作、复发和中断负担；脚本重放只证明机械。关闭一行、改一个提示或清一个数字信号从不自动供那个证据。无机会意思 unobserved，发布主张留给它的决定 owner。本指引既不重新启用诊断，也不分派纠正工作。

## 人类投递

一个被指派智能体可显式请求人类上报：

```sh
zrig health diagnosis notify <qitem-id>
```

它需要一个已注册 `human.address` 和一个准入 `human.conditions` 条目（`critical`、`established pathology` 或 `confirmed ceremony`）。连接器必须启用并过活就绪检查。当前连接器实现验证 Slack scope 和频道成员；诊断服务本身用一个传输中性就绪端口。既有网关拥有投递策略和发帖。每插曲保留一个人类请求，其实际投递结果来自队列收据。`pending` 绝不呈现为 `posted`。检视返回 qitem 的转移找连接器收据。无周期健康检查做修复。配 `human.conditions=["confirmed ceremony"]`，启用的诊断循环对一个活跃、已确认被动仪式插曲自动请求一次通知。临时、indeterminate、已清除和陈旧插曲从不通知。既有就绪/网关路径拥有效果；一个未就绪连接器留下一个可见、去重的就绪收据。后来检查可重试就绪，但绝不为既有插曲造第二个请求。只读 list/explain/preview 命令从不发送。

## 只读消费者与校准

一个消费者（如后来的 Herder 插件）读 `GET /api/health` 和 `GET /api/health/:findingId`，或相同的 `zrig health --json` 和 `zrig health explain <finding-id> --json` 记录。记录 schema 是 `openrig.health/v0alpha1`；list 元数据是 `openrig.health-list/v0alpha1`。一起保留 ID、状态、策略版本、时间窗、新鲜度、证据和阈值。没有健康分或隐式修复权威。默认 list 排除已清除记录；显式 cleared 查询和确切 ID 读在来源仍能投影时保留它们。清除后复发收一个新插曲 ID。这是按需投影，不是历史存储；一个 detail 404 不证明解决。

List 默认 100、上限 200，`total` 和 `truncated` 显式。仪式发现先于上限，好让上下文压力藏不住主信号。收窄一个截断查询；不认证未见其余。空不健康，不可用不是空，一个 indeterminate 发现不能授权一个诊断发生，除上面描述的显式、新的 `needs-diagnosis` 被动候选。一个既有发生在其来源变 indeterminate 时可收一个状态观察收据；那不再造另一个义务或唤醒。

活来源供上下文压力、被动仪式候选和归属评估，加可选仪式检查点。行为和认知类别刻意没有检测器。评审旋转、冗余唤醒、陈旧指令和范围准入有类型化评估器和重放控制，但活来源不推断它们缺失的候选变化、救援、指令冲突或准入权威事实。未标签工作和未声明关系仍在被动仪式覆盖外；正常标签工作不再需要一个特殊结果普查。低于配置阈值的小谱系仍值得智能体检视；阈值是一个保守准入规则，不是好流程定义。

`packages/daemon/scripts/probe-health-calibration.mjs` 在 daemon/CLI/TUI 构建后接受一个封存重放导出和输出目录。它驱动编译的 checkpoint/list/explain/diagnosis 命令，渲染 TUI，保留确切记录和屏幕，对比读前后数据库和文件系统效果，按声明预算测查询成本。每次写用一次性 home 和数据库。历史预期状态必须独立于检测器公式建立；不完整结果证据是 indeterminate 案例，不是分母一。一份校准报告描述它选的语料和剩余盲点，不是全舰队误报率。
