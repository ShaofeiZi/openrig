export const meta = {
  name: 'zh-ui-c-src',
  description: '翻译 ui-c 分区 packages/ui/src 下未翻译的源码注释与运行时自然语言',
  phases: [
    { title: 'Lib', detail: 'lib/ 下工具与布局模块' },
    { title: 'Hooks', detail: 'hooks/ 下 React 查询 hook' },
    { title: 'Review', detail: '残留英文复核' },
  ],
}

const ROOT = '/Users/bytedance/openrig'
const OWNER = 'ui-c'

const LIB_FILES = [
  'packages/ui/src/lib/feed-classifier.ts',
  'packages/ui/src/lib/graph-layout.ts',
  'packages/ui/src/lib/hybrid-layout.ts',
  'packages/ui/src/lib/instantiate-status-colors.ts',
  'packages/ui/src/lib/library-skills-routing.ts',
  'packages/ui/src/lib/runtime-brand.ts',
  'packages/ui/src/lib/tool-brand.ts',
]

const HOOK_FILES = [
  'packages/ui/src/hooks/mutations.ts',
  'packages/ui/src/hooks/useActivityFeed.ts',
  'packages/ui/src/hooks/useArchivedRigs.ts',
  'packages/ui/src/hooks/useDismissedCardIds.ts',
  'packages/ui/src/hooks/useDismissedSeqs.ts',
  'packages/ui/src/hooks/useFleet.ts',
  'packages/ui/src/hooks/useGlobalEvents.ts',
  'packages/ui/src/hooks/useLaunchPlan.ts',
  'packages/ui/src/hooks/useLibrarySkills.ts',
  'packages/ui/src/hooks/usePlugins.ts',
  'packages/ui/src/hooks/useRigEvents.ts',
  'packages/ui/src/hooks/useRigGraph.ts',
  'packages/ui/src/hooks/useScopeAudit.ts',
  'packages/ui/src/hooks/useSettings.ts',
  'packages/ui/src/hooks/useShellViewport.ts',
  'packages/ui/src/hooks/useSliceTimelineMarkdown.ts',
  'packages/ui/src/hooks/useSteering.ts',
  'packages/ui/src/hooks/useTerminalViews.ts',
  'packages/ui/src/hooks/useTopologyActivity.ts',
  'packages/ui/src/hooks/useWorkflowSse.ts',
  'packages/ui/src/hooks/useWorkspace.ts',
  'packages/ui/src/hooks/useWorkspaceName.ts',
]

const CSS_FILES = ['packages/ui/src/globals.css']

const RULES = `
你在 /Users/bytedance/openrig 仓库执行 OpenRig 简体中文化任务（人类可见品牌 zrig）。

先读（必读，不要跳过）：
- .codex/translation/style-spec.md（统一术语表与边界）
- .codex/translation/execution-spec.md（执行要求）

本次只做一件事：把目标文件里的**英文自然语言注释**翻译成简体中文。

绝对禁止改动（违反即失败）：
- 标识符、函数/变量/类型/枚举名、import 路径、导出名
- 字符串字面量里的机器值：CSS 类名（text-success 等）、枚举值、状态值、事件名、
  查询键、HTTP 路径、环境变量名、hex 颜色、Tailwind 类
- 正则、ANSI、占位符插值的数量与顺序
- 任何 JSX/TS 代码结构与行为

可以翻译的：
- // 行注释、/* */ 块注释、/** JSDoc */ 中的英文自然语言
- 保留 JSDoc 里的 @param/@returns 标签名，只翻译其说明文字
- 保留引用编号（OPR.0.4.6.MH5、V1 attempt-3 Phase 3、SC-17、FR-2 等）原样，
  它们是追踪标识，不翻译

术语按 style-spec.md：agent→智能体、daemon→后台服务、seat→席位、rig→工作组、
workspace→工作区、scope→工作范围、mission→任务目标、runtime→运行时、host→主机、
queue→队列、snapshot→快照、health→健康状态、attention→待关注、topology→拓扑。

风格：中文自然直接，不要逐词硬译，不要加宣传语。注释密度保持不变，不要新增解释性段落。

工作流程：
a) read 目标文件全文。
b) 只改注释，用 Edit 精准替换。
c) 完成后执行：
   cd /Users/bytedance/openrig
   python3 .codex/translation/scripts/state.py claim ${OWNER} <相对路径> --reopen
   python3 .codex/translation/scripts/state.py done ${OWNER} <相对路径> "注释中文化；机器值/标识符保留"
   若 claim 报 already in_progress，直接 done 即可。

返回值（纯文本，无寒暄）：
- file: <路径>
- changed: 翻译了哪些注释，简述
- residual: 剩余英文自然语言条数 + 保留原因
- ledger: 成功/失败
`

phase('Lib')
const libResults = await pipeline(
  LIB_FILES,
  (f) => agent(`${RULES}\n\n目标文件：${ROOT}/${f}\n请先 claim，完成后 done，然后汇报。`,
    { label: `lib:${f.split('/').pop()}`, phase: 'Lib' }),
)

phase('Hooks')
const hookResults = await pipeline(
  HOOK_FILES,
  (f) => agent(`${RULES}\n\n目标文件：${ROOT}/${f}\n请先 claim，完成后 done，然后汇报。`,
    { label: `hook:${f.split('/').pop()}`, phase: 'Hooks' }),
)

phase('Review')
const all = [...libResults, ...hookResults].filter(Boolean).join('\n---\n')
const review = await agent(
  `你在 /Users/bytedance/openrig 复核 ui-c 分区刚完成的中文化。

请逐个检查下列文件，用 grep/read 找出**仍然存在的英文自然语言注释**
（不含标识符、机器值、追踪编号）：

${LIB_FILES.concat(HOOK_FILES).map((f) => `- ${ROOT}/${f}`).join('\n')}

对每个文件给出：路径 + 残留英文注释行号与内容 + 是否属于「应该翻译但漏了」。
只报告事实，不要修改文件。返回精炼清单。`,
  { label: 'review:ui-c-src', phase: 'Review' },
)

return `${all}\n\n=== 复核 ===\n${review}`
