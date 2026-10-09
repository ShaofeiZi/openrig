// V0.3.1 slice 21 onboarding-conveyor。
//
// getting-started mission 两个 slice 的 Narrative tab 内容。scaffold 将其作为 SPEC.md /
// timeline.md / PROGRESS.md 写入各 slice folder，使新 operator 刚安装就能通过点击学习：打开各 tab，
// 既能了解 conveyor run 是什么，也能了解每个 Project tab 的作用。
//
// 历史说明：早期 scaffold 曾携带此 onboarding narrative。当前 canonical workspace scaffold 已
// 精简为六个 entry，不再引用这些常量；保留内容用于兼容旧 workspace 与迁移路径。
//
// 内容源自 substrate openrig-work tree 中 slice 21 onboarding-conveyor IMPLEMENTATION-PRD
//（Appendix A）。

export const FIRST_CONVEYOR_RUN_README = `# 首次传送带运行

欢迎使用 zrig。这是 getting-started mission 中的第一个 slice，用于介绍什么是**传送带运行**，以及 zrig 如何让工作在多 agent topology 中流转。

## 什么是传送带运行

**传送带**是 zrig 的核心工作流转原语。一次传送带运行，就是工作在 topology 中完整流转一次：

1. **声明 Slice**——operator（你）或 agent 声明带 intent 与 acceptance criteria 的 slice
2. **路由工作**——orchestrator 领取 slice，并将它路由给合适的 agent
3. **Agent 协作**——工作通过持久 handoff（queue item）在 agent 之间流转
4. **积累 Evidence**——每一步都会留下记录：commit、文件、proof packet、截图
5. **关闭 Slice**——满足 acceptance criteria 后，orchestrator 将结果路由回来

你现在看到的就是一次模拟传送带运行。其他 tab（故事 / 进度 / 产物 / 测试 / 队列 / 拓扑）分别展示同一次运行的不同侧面。

## 逐个查看 tab

- **概览**（你正在这里）——了解 slice 的目标，以及其余 tab 的用法
- **故事**——按时间顺序讲述发生了什么
- **进度**——acceptance checklist；哪些已完成，哪些待处理
- **产物**——生成的文件、commit、proof packet，即持久 evidence trail
- **测试**——通过/失败摘要、截图和验证证明
- **队列**——展示工作如何在 agent 之间流转的 operational qitem
- **拓扑**——工作组 graph；哪些 agent 参与了此 slice，哪些 edge 被触发

## 依次点击

请按顺序查看。每个 tab 都会说明自己的用途。
`;

export const FIRST_CONVEYOR_RUN_TIMELINE = `# 故事——首次传送带运行

## 2026-04-15 09:00——声明 Slice

Operator 请求：“构建一个检查 todo list 的 CLI 工具。”Slice 在 \`getting-started/slices/first-conveyor-run/\` 中声明。验收条件：遇到格式错误的 entry 时，\`tdl lint <file>\` 以非零状态退出。

## 09:02——Orchestrator 路由

\`orch-lead@getting-started\` 领取 slice，通过 \`zrig queue handoff\` 路由给 \`driver@getting-started\`。Driver 收到 nudge，打开 IMPL-PRD，并阅读 acceptance。

## 09:05——Driver 领取

Driver 领取 qitem，阅读 slice scope，检查现有 tdl repo（这是演示示例，可以把 repo 当作真实存在）。计划：解析 YAML、验证 entry，并根据 finding 设置 exit code。

## 09:30——首次 commit

\`feat(lint): parse + validate todo entries\`——driver 提交 4 个文件。stream event 已发出，可在“产物”tab 查看。

## 10:15——Driver 交给 reviewer

本地已满足 acceptance。Driver handoff 给 \`reviewer@getting-started\`。Reviewer 打开 diff 并阅读测试。

## 10:25——Reviewer 提出疑虑

“边界情况：带组合字符的 UTF-8 entry 怎么处理？”以 \`concerning\` 结果交回 driver。

## 10:40——Driver 处理问题

Driver 修复 UTF-8 处理，重新运行测试并全部通过，再次交回。

## 11:00——Reviewer 接受

作出 \`accept\` decision；使用 \`closure-reason: handed_off_to orch-lead\` 关闭 qitem。传送带继续运行。

## 11:05——Slice 交付

Orchestrator 完成 merge，生成 proof packet，并将 slice 标记为 SHIPPED。

---

**你刚刚读到的内容**：一次从声明到交付的传送带运行。实际历时约 2 小时；3 个 agent 参与；1 次带疑虑与修复的 handoff；5 个 stream event；1 个 proof packet。

“故事”tab 会为每个真实 slice 展示此类叙事。由 driver 编写的 \`timeline.md\` 位于各 slice folder 中；你可以阅读，operator 则会随工作推进更新它。
`;

export const FIRST_CONVEYOR_RUN_PROGRESS = `---
title: 首次传送带运行进度
status: active
mission: getting-started
rail-item: getting-started
slice: first-conveyor-run
---

# 进度——首次传送带运行

## 验收标准

- [x] 解析 YAML todo entry
- [x] 验证每个 entry 的 shape（id、title、status、due-date）
- [x] 遇到 malformed entry 时以非零状态退出
- [x] 处理带组合字符的 UTF-8 entry
- [x] 测试通过（12/12）
- [x] Reviewer 接受
- [x] Slice 已合并

## 状态：SHIPPED

这是一次模拟传送带运行——没有生成真实代码。但对于真实工作，“进度”tab 的运行方式相同：满足 acceptance criteria 时勾选对应项；operator 可以快速判断 slice 是否按计划推进。

## “进度”tab 如何工作

该 tab 渲染 slice 的 \`PROGRESS.md\` Markdown 文件。Driver 随工作推进更新它，operator 在巡检时查看，founder 在 slice 关闭时复核。

请为你启动的真实 slice 编写一份。它只是 Markdown；实时更新会显示在这里。
`;

export const INSPECT_PROJECT_EVIDENCE_README = `# 检查项目证据

上一个 slice（首次传送带运行）展示了一次 conveyor run 的实际过程。本 slice 说明如何在运行结束后检查 evidence。

## 为什么要检查 evidence？

在 zrig 中，agent 自主工作。operator（你）无需盯着每次按键，而是：

1. 声明具有明确 acceptance 的 slice
2. 将它们路由给 agent
3. 在 slice 关闭时检查 evidence

“产物”+“测试”+“队列”+“拓扑”tab 是你的检查界面。它们会展示发生了什么，并提供足够细节来：

- 验证 acceptance 是否确实满足
- 发现通过测试也可能遗漏的细微问题
- 随时间逐步建立对 agent 的信任

## 逐个查看 tab

- **概览**——你正在这里；了解应检查什么
- **故事**——阅读发生了什么的高层叙事
- **进度**——快速查看 acceptance 状态
- **产物**——持久 evidence：文件、commit、proof packet。**这是信息量最大的 tab。**
- **测试**——通过/失败、截图和验证证明
- **队列**——谁把什么交给了谁（decision audit trail）
- **拓扑**——哪些 agent 参与过；哪些 edge 被触发

## 关键检查技能

检查已完成的 slice 时：

1. **阅读故事**了解背景——operator 想做什么？
2. **检查进度**——acceptance 真的通过了吗？还有 TODO 吗？
3. **打开产物 → 文件**——抽查 2–3 个文件；代码是否与“故事”的描述一致？
4. **打开测试 → Proof packet**——截图真的证明了所声称的结果吗？
5. **阅读队列**——是否有 concerning decision？是否 handoff 到 escalation？
6. **浏览拓扑**——是否有意外 agent 参与？

信任来自反复成功的检查，而不是单个 proof packet。
`;

export const INSPECT_PROJECT_EVIDENCE_TIMELINE = `# 故事——检查项目证据

本 slice 映射上一个 slice（首次传送带运行）：同一批 agent 交付了同一项工作，但这里采用检查者而非执行者的视角。

## 11:10——Operator 打开项目

Slice 交付后，operator（现实中的你）打开 \`/project/slice/first-conveyor-run\`。首先查看“进度”tab；所有项目都已勾选。

## 11:12——阅读故事

Operator 阅读“故事”叙事，注意到 reviewer 对 UTF-8 的疑虑以及 driver 的修复。这能建立信心：问题出现了，被发现了，也被处理了。

## 11:15——打开产物

Operator 点击“产物”，看到 4 个 commit、5 个文件、1 个 proof packet 和 2 张截图；打开 commit \`feat(lint): parse + validate todo entries\` 并阅读 diff。

## 11:18——查看测试

Operator 打开“测试”tab，12/12 通过；打开 proof packet——截图显示 CLI 输出 \`Error: malformed entry at line 3\`，并通过目视确认 acceptance 已满足。

## 11:22——浏览队列

Operator 浏览“队列”，按时间顺序看到 4 个 qitem，以及 \`concerning\` decision 与后续 \`accept\`，信心进一步增强。

## 11:25——标记完成

Operator 将 slice acceptance 标记为完成并结束检查。

---

**你刚刚读到的内容**：一次约 15 分钟的清晰检查。Operator 通过 evidence trail 建立信任。这就是 zrig 的规模化使用方式：声明 → 路由 → 检查。
`;

export const INSPECT_PROJECT_EVIDENCE_PROGRESS = `---
title: 检查项目证据进度
status: active
mission: getting-started
rail-item: getting-started
slice: inspect-project-evidence
---

# 进度——检查项目证据

## 检查清单

- [x] 阅读故事（背景：正在做什么）
- [x] 检查进度（acceptance 状态）
- [x] 抽查产物文件
- [x] 目视验证测试 proof packet
- [x] 浏览队列中的 concerning decision
- [x] 浏览拓扑中是否有意外 agent

## 状态：COMPLETE

这是一次模拟检查——inspection workflow 的完整示例。

## 如何应用

对于你项目中任何已交付的真实 slice：打开 slice 页面，按此顺序浏览各 tab，并在心中逐项确认。随着时间推移，你会逐渐形成判断：哪些结果经得起快速检查，哪些需要深入调查。
`;

/** Slice id → narrative content map。Scaffold caller 用它覆盖两个 getting-started slice 的
 *  boilerplate sliceReadme / sliceProgress；其他 slice 保留 boilerplate。 */
export const GETTING_STARTED_NARRATIVE: Record<
  string,
  { readme: string; timeline: string; progress: string }
> = {
  "first-conveyor-run": {
    readme: FIRST_CONVEYOR_RUN_README,
    timeline: FIRST_CONVEYOR_RUN_TIMELINE,
    progress: FIRST_CONVEYOR_RUN_PROGRESS,
  },
  "inspect-project-evidence": {
    readme: INSPECT_PROJECT_EVIDENCE_README,
    timeline: INSPECT_PROJECT_EVIDENCE_TIMELINE,
    progress: INSPECT_PROJECT_EVIDENCE_PROGRESS,
  },
};
